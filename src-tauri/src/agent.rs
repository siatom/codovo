//! 智能体后端：把开源的 opencode 当 headless 服务跑起来，供终端区的「智能体」tab 用。
//!
//! 为什么不让前端直接连 opencode：它监听在 localhost 的动态端口上，不会给 WebView 回
//! CORS 头，直连必被拦；而且密钥和网络调用留在 Rust 侧，和 `ai.rs` 的既定做法一致。
//!
//! 进程模型：一个窗口一个 opencode 进程，cwd 就是该窗口的工作区根。懒启动（用户第一次
//! 切到智能体 tab 才起），关窗或退出应用时杀掉。同工作区开两个窗口会起两个进程，
//! 各自监听端口、各自一份配置目录，互不干扰。

use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::dev;
use crate::fs_api::FsState;

/// SSE 事件推给前端用的事件名。载荷里带着工作区 root，前端据此路由到对应工作区的界面。
pub const EVENT_NAME: &str = "agent-event";
/// 子进程自己退出（崩溃、被杀）时推的事件，前端据此提示重启。
pub const EXIT_EVENT: &str = "agent-exit";

/// 推给前端的事件载荷。单窗口下同时有多个工作区在跑，不带 root 就分不清是谁的事件。
#[derive(Serialize, Clone)]
struct TaggedEvent {
    root: String,
    event: serde_json::Value,
}

/// 健康检查的等待上限。opencode 冷启动要装插件，慢机器上可能要十几秒。
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
/// 管理类 HTTP 请求的超时。发消息走 prompt（立刻返回，正文靠事件流推回来），不受这个影响。
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// SSE 断线后的重连间隔。
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
/// 子进程退出的轮询间隔。
const EXIT_POLL: Duration = Duration::from_secs(1);
/// 报错时回传的响应体上限，别把整页 HTML 塞给用户。
const MAX_ERROR_CHARS: usize = 500;
/// 注入给 opencode 的密钥环境变量前缀。每个提供商一个变量
/// （`CODEDOCK_AI_KEY_<PROVIDER_ID>`），密钥不写进配置文件，只走环境变量。
const API_KEY_ENV_PREFIX: &str = "CODEDOCK_AI_KEY_";
/// opencode v2 要求服务口令，我们自己定一个并通过这个环境变量注入。
/// 不定的话它会随机生成、打到 stdout，我们还得去解析那行输出。
const PASSWORD_ENV: &str = "OPENCODE_PASSWORD";

/// Basic 认证的用户名。v2 把它写死了，只有密码是可配的。
const AUTH_USER: &str = "opencode";
/// 留多少行子进程输出。启动失败的原因（端口被占、插件装不上、配置读不了）
/// 只会打在 stdout/stderr 上，v1 时代这两路被 Stdio::null() 丢掉了，
/// 界面上只能看到一句"启动超时"，完全没法排查。
pub(crate) const CHILD_LOG_LINES: usize = 40;

/// 子进程输出的环形缓冲。启动失败时靠它把原因带回给用户。
pub(crate) type ChildLog = Arc<Mutex<VecDeque<String>>>;

/// 数据库 Agent 的内置技能正文（frontmatter 由 `render_skill` 补）。
/// 目的：把「先看表、再确认字段、最后只写 SELECT」这套工作流写死给模型。
///
/// 工具名带 MCP server 前缀：opencode 把 `mcp.db` 下的工具注册成 `db_<name>`
/// （见 opencode 文档里 `"my-mcp*"` 匹配 `my-mcp_search` 的例子），所以这里写全名。
const DB_AGENT_SKILL_BODY: &str = "\
# 数据库查询

你连的是一个**只读**的数据库连接，只能查数据，绝不能写数据或改结构。

工作流：

1. 不确定有哪些表时，先用 `db_list_tables` 列出全部表与视图。
2. 用 `db_describe_table` 看目标表的列、类型、主键，确认字段名再写 SQL。
3. 用 `db_run_query` 执行 **SELECT / WITH / SHOW / EXPLAIN** 之类的只读语句，把结果拿回来。
4. 结果集可能被截断（只回前若干行），必要时用 `LIMIT` 与 `ORDER BY` 缩小范围。

硬性约束：

- 只生成只读 SQL。任何 INSERT / UPDATE / DELETE / DDL 都会被拒绝，不要尝试绕过。
- 用当前数据库的方言写（MySQL 用反引号、PostgreSQL / SQLite 用双引号）。
- 查询大表时务必带 `LIMIT`，别把整张表拉出来。
- 拿不准用户想问什么就先澄清，不要凭猜测写复杂 SQL。";

/// 数据库 Agent 专用 primary agent 的提示词。比技能更靠前，先把角色与边界定死。
const DB_AGENT_PROMPT: &str = "\
你是 CodeDock 里面向数据库的查询助手。你能看到的工具只有一组只读数据库工具\
（db_list_tables / db_describe_table / db_run_query）。\n\
把用户的中文问题翻成准确的 SQL，用工具执行后把结果讲清楚：先给结论，再附上执行的 SQL。\
除非用户要求，不要罗列原始行，用一两条代表性数据说明即可。\n\
你**只能查询**：任何写数据、改结构、事务控制的操作都被禁止，被拒绝时如实告诉用户，不要反复重试。";

/// 数据库 Agent 内置技能的名字（同时也是配置目录里那个文件夹名）。
const DB_AGENT_SKILL_NAME: &str = "db-query";

/// 数据库 Agent 专用 primary agent 的名字。
const DB_AGENT_AGENT_NAME: &str = "database";

/// 应用助手（界面操作）内置技能的名字。它同时是配置目录里的文件夹名。
const APP_AGENT_SKILL_NAME: &str = "app-control";

/// 应用助手专用 primary agent 的名字。前端 `lib/app-agent.ts` 的 `APP_AGENT_NAME` 与它对齐。
const APP_AGENT_AGENT_NAME: &str = "app";

/// 应用助手的技能正文（frontmatter 由 `render_skill` 补）。
/// 目的：把 CodeDock 的界面结构和设置字段名写死给模型，用户问「怎么改字号」时它能答对，
/// 而不是去翻代码或瞎猜。
const APP_AGENT_SKILL_BODY: &str = "\
# CodeDock 界面操作

## 界面结构

- 左侧栏：顶部是工作区列表，底部一排按钮依次是 **主题切换 / 意见反馈 / 设置 / 应用助手 / 收起侧边栏**。
- 中间左侧一列：**终端（TUI）** 与 **智能体（GUI）** 两个视图，靠顶栏居中的分段控件切换。
- 右侧栏：最左是模块图标条（文件 / 搜索 / 变更 / 浏览器 / 远程连接 / 数据库 / 预览），
  图标条底部那个按钮收起/展开整条右栏；每个模块的标题栏右上角有全屏按钮。

## 常用设置在哪（回答「怎么改 X」时照这个说）

- 终端程序 / 配色主题 / AI CLI 列表：**设置 → 终端**
- 编辑器自动保存、缩进宽度、缩略图（minimap）：**设置 → 编辑器**
- 主题（深色 / 浅色 / 跟随系统 / 各种配色）、界面 / 终端 / 编辑器字体（字体 / 字号 / 字重）、右栏模块显隐、启动恢复上次工作区、关闭时收进托盘：**设置 → 外观**
- 模型提供商、opencode 命令与端口、规则 / 记忆 / 技能 / Agents：**设置 → 智能体**
- 设置入口在左侧栏底部那一排按钮里（齿轮图标）。

## 设置字段（`update_settings` 的 patch 用这些键）

- `uiFontFamily`：字符串，界面字体的 CSS 字体栈，留空表示默认无衬线栈
- `terminalFontFamily`：字符串，CSS 字体栈，留空表示默认
- `terminalFontSize`：11-20 的数字
- `terminalFontBold`：true / false
- `terminalTheme`：字符串，xterm 配色名；留空表示跟随界面深/浅色
- `terminalShell`：字符串，shell 的 id；留空表示自动
- `terminalWaitHint`：true / false
- `editorFontFamily` / `editorFontSize`（11-20）/ `editorFontBold`
- `editorAutoSave`：\"off\" / \"afterDelay\" / \"onFocusChange\" / \"onWindowChange\"
- `editorAutoSaveDelay`：300-10000 毫秒
- `editorMinimap`：true / false，编辑器右侧代码缩略图
- `editorIndent`：\"auto\"（按文件内容探测）/ \"2\" / \"4\" / \"8\"
- `agentEnabled`：true / false，左侧是否出现「终端 / 智能体」切换
- `agentCommand` / `agentPort` / `agentPrimary`
- `rightFilesVisible` / `rightChangesVisible` / `rightSearchVisible` / `rightBrowserVisible` /
  `rightRemoteVisible` / `rightDatabaseVisible`：true / false
- `closeToTray`：true / false
- `restoreWorkspace`：true / false，启动时是否自动打开上次的工作区
- `theme`：**特殊键**，不写进设置文件而是直接切主题；取 \"dark\" / \"light\" / \"system\"
  或配色名（如 \"dracula\" / \"one-dark\" / \"github-light\"）

## 界面工具

- `switch_panel`：panel 取 files / search / changes / browser / remote / database / preview，
  会展开右栏并切到该模块。
- `set_right_pane`：open=true 展开、false 收起整条右栏。
- `set_fullscreen`：area 取 none / left / right
  （left=终端与智能体那一列铺满窗口，right=整个右边栏铺满窗口）。

## 工作区

- `add_workspace` 需要**绝对路径**，工作区名默认取目录名。
- `remove_workspace` 只从列表移除、**不删磁盘目录**，执行前会弹确认框。";

/// 应用助手专用 primary agent 的提示词。比技能更靠前，先把角色与边界定死。
const APP_AGENT_PROMPT: &str = "\
你是 CodeDock（一个 AI 编程驾驶舱桌面应用）的界面操作助手。你能看到的工具只有一组界面工具\
（app_get_state / app_update_settings / app_add_workspace / app_rename_workspace / \
app_pin_workspace / app_remove_workspace / app_reset_settings / app_switch_panel / \
app_set_right_pane / app_set_fullscreen），它们改的是 CodeDock 自己的设置、工作区列表与界面布局。\n\
规则：\n\
1. 用户问「怎么改 X」「X 在哪」时，直接用中文讲清路径（例如「设置 → 终端 → 字号」），\
不要调用工具；拿不准当前值时才先调 app_get_state。\n\
2. 用户要求「把 X 改成 Y」时才调用工具，一次只做用户明确要求的事，不要顺带改别的设置。\n\
3. 移除工作区、恢复默认设置这类不可逆操作，工具内部会弹确认框，你只需调用并如实汇报结果。\n\
4. 工具返回错误时把原因讲清楚，不要反复重试同一个调用。\n\
5. 你改不了工作区里的代码、也跑不了命令；这类请求请让用户切到「终端」或普通智能体。";

/// 应用助手要关掉的工具：它只操作界面，不该去翻磁盘或跑 shell。
/// 用 per-agent 的 `tools`（opencode 已标记为 deprecated，但 `permission` 尚无等价的
/// 逐工具开关），只影响这一个 agent，不动别人的。
const APP_AGENT_DISABLED_TOOLS: &[&str] = &[
    "bash", "edit", "write", "patch", "read", "grep", "glob", "list", "webfetch", "websearch",
    "task",
];

/// 预览助手内置技能的名字。它同时是配置目录里的文件夹名。
const PREVIEW_AGENT_SKILL_NAME: &str = "preview-control";

/// 预览助手专用 primary agent 的名字。前端 `lib/agent-profiles.ts` 的 `PREVIEW_AGENT_NAME` 与它对齐。
const PREVIEW_AGENT_AGENT_NAME: &str = "preview";

/// 预览助手的技能正文（frontmatter 由 `render_skill` 补）。
/// 目的：把「先探测、再启动、后查状态」的流程与项目类型判断依据写死给模型。
const PREVIEW_AGENT_SKILL_BODY: &str = "\
# 项目预览

你负责按当前工作区的项目类型启动 / 停止预览，方便调试和验证。

## 工作流

1. 先调 `preview_detect` 看探测结果（kind / command / port / reason / warnings）。
2. 用户没指定就用探测到的命令直接 `preview_start`；要改命令 / 端口就传 `command` / `port`。
3. 启动后调 `preview_status` 看是否就绪、地址或 CDP 端口是多少。
4. 要停就 `preview_stop`。

## 项目类型与预览方式（探测依据）

| 标记 | 类型 | 预览方式 |
|---|---|---|
| `src-tauri/tauri.conf.json` 或依赖里有 `@tauri-apps/cli` | Tauri 桌面 | `tauri dev`，Windows 上带 CDP 调试端口 |
| `package.json` 有 `scripts.dev` / `scripts.start` | Web | 起 dev server，用内嵌浏览器看 |
| 都没有 | 未知 | 让用户提供启动命令 |

## 注意

- 探测出 warnings（例如「这是 CodeDock 自身」）时先如实转告用户，再决定要不要起。
- 预览进程由 CodeDock 托管，日志显示在右栏「预览」模块里。
- 你改不了项目代码；要让代码改动生效，先让用户改完再重启预览。";

/// 预览助手专用 primary agent 的提示词。比技能更靠前，先把角色与边界定死。
const PREVIEW_AGENT_PROMPT: &str = "\
你是 CodeDock 里的「预览助手」，负责按当前工作区的项目类型启动 / 停止预览，帮用户调试和验证。\
你能看到的工具只有一组预览工具（preview_detect / preview_start / preview_stop / preview_status）。\n\
规则：\n\
1. 用户要「预览」「跑起来看看」「起个 dev」时，先 preview_detect，再 preview_start，\
然后用 preview_status 汇报地址或 CDP 调试端口。\n\
2. 探测出 warnings 时先转告用户，别默默起。\n\
3. 用户要停就 preview_stop。\n\
4. 你改不了项目代码、也跑不了任意命令；需要改代码请让用户切到「终端」或普通智能体。";

/// 预览助手要关掉的工具：它只负责起 / 停预览，不该去改文件或跑 shell。
/// 保留 read / grep / glob / list，好让它必要时看一眼项目结构。
const PREVIEW_AGENT_DISABLED_TOOLS: &[&str] = &[
    "bash", "edit", "write", "patch", "webfetch", "websearch", "task",
];

/// 对接的是哪一带 opencode 的接口。
///
/// 两代差异不小，但**相对路径几乎一样**：除了探针、发消息、中断这三处名字真的不同，
/// 其余只差一个 `/api` 前缀，所以收敛成这么几个方法就够了，不用维护一张路由表。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Protocol {
    /// 旧包 `opencode-ai`（1.x）：裸路由、免认证、响应不套壳、事件用 `message.part.*`
    V1,
    /// 新包 `@opencode/cli`（2.x）：`/api` 前缀、Basic 认证、响应套 `{data}`、
    /// 事件用 `session.text.*`
    V2,
}

impl Protocol {
    fn prefix(self) -> &'static str {
        match self {
            Protocol::V1 => "",
            Protocol::V2 => "/api",
        }
    }

    /// 发消息：v1 叫 `prompt_async`（回 204），v2 叫 `prompt`（回 200，正文都走事件流）
    fn prompt_path(self) -> &'static str {
        match self {
            Protocol::V1 => "prompt_async",
            Protocol::V2 => "prompt",
        }
    }

    /// 打断这一轮：v1 叫 `abort`，v2 改叫 `interrupt`
    fn interrupt_path(self) -> &'static str {
        match self {
            Protocol::V1 => "abort",
            Protocol::V2 => "interrupt",
        }
    }

    /// v2 的每个请求（含 SSE）都要 Basic 认证，少了会拿到 401——那看起来很像"服务没起来"
    fn needs_auth(self) -> bool {
        matches!(self, Protocol::V2)
    }

    /// v2 把所有响应套了一层 `{data: ...}`（列表还多个 cursor），v1 是裸的。
    /// 在这儿拆掉，前端那几个解析函数才能两头通吃。
    fn unwrap(self, value: serde_json::Value) -> serde_json::Value {
        match self {
            Protocol::V1 => value,
            Protocol::V2 => unwrap_data(value),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Protocol::V1 => "v1",
            Protocol::V2 => "v2",
        }
    }
}

/// 探测用的候选：(探针路径, 要不要认证, 判成哪一代)。
///
/// 顺序<b>不能按版本号推</b>：过渡期的 `@opencode/cli@0.0.0-dev-*` 版本号是 0.x，
/// 但接口已经是 v2 形态（用 `/api/health`、事件也是 `session.text.*`）——按版本号
/// 判会把它当 v1，然后去打它根本不存在的 `/global/health`，于是永远起不来。
/// 所以只能按接口探。
const PROBES: &[(&str, bool, Protocol)] = &[
    ("/info", true, Protocol::V2),
    // 过渡期 dev 构建的健康路径，既不是 /api/info 也不是 /global/health
    ("/health", true, Protocol::V2),
    ("/global/health", false, Protocol::V1),
];

/// 一条技能：写成 `<config_dir>/skills/<name>/SKILL.md`。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSpec {
    name: String,
    description: String,
    #[serde(default)]
    content: String,
}

/// 一个自定义 agent：写进 opencode.json 的 `agent` map。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    name: String,
    description: String,
    /// `primary` / `subagent` / `all`
    mode: String,
    /// 留空表示不下发，让 opencode 用它配置里的默认模型
    #[serde(default)]
    model: String,
    #[serde(default)]
    prompt: String,
}

/// 一个 LLM 提供商，对应 opencode.json 里的一条 provider。
///
/// 本次只支持 OpenAI 兼容协议，所以没有协议字段——换协议意味着换 AI SDK 包。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// opencode 的 provider key，同时也是模型引用的前缀和密钥环境变量名来源。
    /// 前端保证它非空且不含 `/`（含 `/` 会把 `provider/model` 切错）。
    id: String,
    name: String,
    /// OpenAI 兼容基地址；空的话这条提供商直接作废
    base_url: String,
    /// 这家有没有配密钥。只是个「该去系统钥匙串取一条」的标记，密钥正文不走这里；
    /// 本地模型（Ollama 之类）不需要密钥，为 false。
    #[serde(default)]
    has_key: bool,
    #[serde(default)]
    models: Vec<String>,
}

impl ProviderSpec {
    /// 这条提供商能不能拿去建连：得有 id、地址和至少一个模型
    fn usable(&self) -> bool {
        !self.id.trim().is_empty()
            && !self.id.contains('/')
            && !self.base_url.trim().is_empty()
            && self.models.iter().any(|model| !model.trim().is_empty())
    }

    /// 注入密钥用的环境变量名。id 只含 ASCII 字母数字连字符（前端保证），
    /// 但仍统一做一遍替换：环境变量名不能有 `-`。
    fn api_key_env(&self) -> String {
        let sanitized: String = self
            .id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        format!("{API_KEY_ENV_PREFIX}{sanitized}")
    }
}

/// 前端传进来的配置。提供商列表和默认模型来自「设置 → 智能体 → 模型提供商」；
/// 规则 / 记忆 / 技能 / Agents 是前端把「全局 + 当前工作区」两层合并后的生效值。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// opencode 可执行文件；裸命令名会去 PATH 里找
    command: String,
    /// 固定端口；0 表示自动挑一个空闲的
    port: u16,
    /// 已启用的提供商；空或全不可用则拒绝启动
    #[serde(default)]
    providers: Vec<ProviderSpec>,
    /// 全局默认模型，形如 `provider/model`；空则取第一个提供商的第一个模型
    #[serde(default)]
    default_model: String,
    /// 开发调试用：`src-tauri/.env` 里那个密钥，连它属于哪个提供商一起记。
    /// 前端传不进来（`skip`），只在 debug 构建里由 `apply` 填上；不进配置文件，
    /// 直接进子进程环境变量，和钥匙串里那条走同一条路。
    #[serde(skip)]
    dev_api_key: Option<(String, String)>,
    /// 规则正文，注入每次对话
    #[serde(default)]
    rules: String,
    /// 记忆正文，注入每次对话
    #[serde(default)]
    memory: String,
    #[serde(default)]
    skills: Vec<SkillSpec>,
    #[serde(default)]
    agents: Vec<AgentSpec>,
    /// 对话面板里选中的 primary agent；空则不下发 default_agent
    #[serde(default)]
    primary: String,
    /// 数据库 Agent：额外注入只读数据库 MCP 工具、内置技能与专用 agent，并关掉文件类工具。
    /// 由数据库面板传 true；终端区智能体不传（默认 false）。
    #[serde(default)]
    database: bool,
}

impl AgentConfig {
    /// 真正能拿去建连的提供商：id / 地址 / 模型齐全
    fn usable_providers(&self) -> Vec<&ProviderSpec> {
        self.providers
            .iter()
            .filter(|provider| provider.usable())
            .collect()
    }

    /// 默认模型引用的 `provider/model` 前缀，认不出来就退到第一个可用提供商。
    /// 都不认不出来返回 None（调用方据此报「没配提供商」）。
    fn default_provider_id(&self) -> Option<String> {
        let prefix = self
            .default_model
            .split('/')
            .next()
            .filter(|part| !part.is_empty());
        if let Some(prefix) = prefix {
            if self
                .providers
                .iter()
                .any(|provider| provider.usable() && provider.id == prefix)
            {
                return Some(prefix.to_string());
            }
        }
        self.usable_providers()
            .first()
            .map(|provider| provider.id.clone())
    }

    /// 生效的默认模型引用。设置里没填或指向的提供商已经没了时，取第一个可用
    /// 提供商的第一个模型——和前端 `resolveDefaultModel` 一个意思，两边都算命。
    fn resolved_default_model(&self) -> Option<String> {
        let id = self.default_provider_id()?;
        let provider = self.providers.iter().find(|item| item.id == id)?;
        let wanted = self.default_model.split_once('/').map(|(_, model)| model);
        let model = wanted
            .filter(|model| provider.models.iter().any(|item| item.trim() == *model))
            .or_else(|| {
                provider
                    .models
                    .iter()
                    .map(|item| item.trim())
                    .find(|item| !item.is_empty())
            })?;
        Some(format!("{}/{model}", provider.id))
    }

    /// 要注入子进程的密钥环境变量。
    ///
    /// 密钥从系统钥匙串按 provider id 取——前端从头到尾经手不了明文。没有密钥的
    /// 提供商（本地模型）不去碰钥匙串；钥匙串整条读不了（Linux 缺 Secret Service）
    /// 时报错，而不是静默降级成「没密钥」，免得界面上一路 401 却不知道该看哪儿。
    fn secrets(&self) -> Result<Vec<(String, String)>, String> {
        let mut out = Vec::new();
        for provider in self.usable_providers() {
            // .env 的覆盖优先：它本来就该盖住界面上的配置，也不该被钥匙串里的旧值顶掉
            if let Some((id, key)) = &self.dev_api_key {
                if id == &provider.id {
                    out.push((provider.api_key_env(), key.clone()));
                    continue;
                }
            }
            if !provider.has_key {
                continue;
            }
            // 标记说有、钥匙串里却没有：多半是用户在系统设置里删过。不拦启动，
            // opencode 那边会以鉴权失败的样子暴露出来，比这里猜更准
            if let Some(key) = crate::secrets::get(&provider.id)? {
                if !key.trim().is_empty() {
                    out.push((provider.api_key_env(), key));
                }
            }
        }
        Ok(out)
    }

    /// 同 `ai::AiConfig::apply`：开发调试时让 `src-tauri/.env` 优先。逐字段来，
    /// 只写了一个键的 `.env` 不会把另外两个字段清空。
    ///
    /// 覆盖打在**默认提供商**上：`base_url` 改它的地址，`api_key` 只记进
    /// `dev_api_key`（不进钥匙串、不落配置文件），`model` 只换模型段、保留提供商前缀。
    fn apply(&mut self, overrides: &dev::AiOverrides) {
        if overrides.base_url.is_none() && overrides.model.is_none() && overrides.api_key.is_none()
        {
            return;
        }

        // 界面上一个提供商都没配、全靠 .env：合成一个，保留「面板留空也能跑」的调试路径
        if self.providers.is_empty() {
            let id = "codedock".to_string();
            self.providers.push(ProviderSpec {
                name: "CodeDock (.env)".to_string(),
                base_url: overrides.base_url.clone().unwrap_or_default(),
                has_key: overrides.api_key.is_some(),
                models: overrides.model.clone().into_iter().collect(),
                id: id.clone(),
            });
            self.default_model = overrides
                .model
                .clone()
                .map(|model| format!("{id}/{model}"))
                .unwrap_or_default();
            self.dev_api_key = overrides.api_key.clone().map(|key| (id, key));
            return;
        }

        let target = self.default_provider_id();
        if let (Some(base_url), Some(id)) = (&overrides.base_url, &target) {
            if let Some(provider) = self.providers.iter_mut().find(|item| item.id == *id) {
                provider.base_url = base_url.clone();
            }
        }
        if let (Some(api_key), Some(id)) = (&overrides.api_key, &target) {
            if let Some(provider) = self.providers.iter_mut().find(|item| item.id == *id) {
                provider.has_key = true;
            }
            self.dev_api_key = Some((id.clone(), api_key.clone()));
        }
        if let Some(model) = &overrides.model {
            self.default_model = match &target {
                Some(id) => format!("{id}/{model}"),
                None => model.clone(),
            };
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    port: u16,
    version: String,
    /// 探测出来的接口代次（"v1" / "v2"），界面拿它显示、排查时也用得上
    protocol: String,
    /// 这个实例的工作目录。opencode 的会话是全局存的，列表里混着各个目录的记录，
    /// 前端得拿它按目录过滤（数据库 Agent 的 cwd 在前端算不出来，只能后端带出去）
    cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    running: bool,
    port: Option<u16>,
}

struct Running {
    child: Child,
    port: u16,
    /// 探测出来的接口代次。起进程时还不知道，探测完补上（探测期间它是 V2，
    /// 那只是占位——探测没通过就会被 kill 掉，不会有人读到）。
    protocol: Protocol,
    /// 启动时的工作区根。和当前工作区对不上就说明该重启了。
    cwd: PathBuf,
    config_dir: PathBuf,
    /// 每次启动 +1。SSE 任务和退出轮询靠它判断自己是不是已经过期。
    generation: u64,
    /// 我们自己定的服务口令，v2 的每个请求（含 SSE）都要拿它做 Basic 认证
    password: String,
    /// 子进程输出的尾巴。启动失败时拼进错误里，不然只能看到一句"启动超时"
    log: ChildLog,
}

/// 给 opencode 生成一个服务口令。
///
/// 不引 rand：仓库没有这个依赖，而这里要的只是"猜不到"，不是密码学强度——
/// 它保护的是一个只监听 127.0.0.1 的端口。RandomState 每次构造都用不同的随机
/// key，所以同一个输入在不同实例上也会给出不同结果。
fn random_password() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut out = String::with_capacity(32);
    for salt in 0u64..2 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(u64::from(std::process::id()));
        hasher.write_u64(salt);
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

/// 按协议拼一个接口地址。两代的相对路径基本一样，只差 `/api` 前缀。
fn endpoint(protocol: Protocol, port: u16, path: &str) -> String {
    format!("http://127.0.0.1:{port}{}{path}", protocol.prefix())
}

/// 把 `provider/model` 引用按**首个** `/` 切成两半。
///
/// provider id 由前端生成、保证不含 `/`，所以首个 `/` 之后的一定是模型名
/// （有些厂商的模型 id 自己带斜杠，比如 `meta-llama/Llama-3-8B`）。
/// 切不出两段时返回 None——调用方据此不下发 model，交给 opencode 用配置里的默认模型。
fn split_model_ref(reference: &str) -> Option<(&str, &str)> {
    let (provider, model) = reference.trim().split_once('/')?;
    let provider = provider.trim();
    let model = model.trim();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider, model))
}

/// 发消息的请求体。两代形状不同：
/// v1 把文本塞进 `parts: [{type:"text"}]`，v2 直接放顶层 `text`。
///
/// `model` 传的是 `provider/model` 引用，必须显式给：不给的话 opencode 会用
/// 用户全局配置里的默认模型（本机实测会落到没跑起来的 ollama，然后一路重试到超时）。
///
/// `agent` 只在 v1 侧放进 body。v2 的 prompt 体（`additionalProperties: false`，
/// 实测 2.0.16）不收 `agent` / `model`——即使塞进去也会被静默忽略，切 agent 得走
/// `/session/:id/agent` 那条独立路由，见 `agent_send`。
fn prompt_body(
    protocol: Protocol,
    text: &str,
    model: Option<&str>,
    agent: Option<&str>,
) -> serde_json::Value {
    let model = model.and_then(split_model_ref);
    let agent = agent.filter(|a| !a.trim().is_empty());
    match protocol {
        Protocol::V1 => {
            let mut body = serde_json::json!({
                "parts": [{ "type": "text", "text": text }],
            });
            if let Some((provider, model)) = model {
                body["model"] = serde_json::json!({ "providerID": provider, "modelID": model });
            }
            if let Some(agent) = agent {
                body["agent"] = serde_json::json!(agent);
            }
            body
        }
        Protocol::V2 => {
            let mut body = serde_json::json!({ "text": text });
            if let Some((provider, model)) = model {
                body["model"] = serde_json::json!({ "providerID": provider, "modelID": model });
            }
            body
        }
    }
}

/// v2 切 primary agent：`POST /session/:id/agent`，回 204、没有 body。
/// v1 没有这条路由，靠 `prompt_body` 的 `agent` 字段表达。
async fn switch_agent(
    client: &reqwest::Client,
    port: u16,
    session_id: &str,
    agent: &str,
    protocol: Protocol,
    password: &str,
) -> Result<(), String> {
    request_json(
        client,
        reqwest::Method::POST,
        endpoint(protocol, port, &format!("/session/{session_id}/agent")),
        Some(serde_json::json!({ "agent": agent })),
        protocol,
        password,
    )
    .await
    .map(|_| ())
}

/// v2 的认证头。用户名固定 `opencode`，密码是我们起进程时注入的那个。
/// 漏掉它每个请求都会拿到 401——包括健康检查，而那看起来像"服务没起来"。
fn basic_auth(password: &str) -> String {
    let raw = format!("{AUTH_USER}:{password}");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(raw)
    )
}

/// 把子进程一路输出的行推进环形缓冲。
pub(crate) fn pump_child_log(stream: impl Read + Send + 'static, log: ChildLog) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let Ok(mut buffer) = log.lock() else { return };
            if buffer.len() == CHILD_LOG_LINES {
                buffer.pop_front();
            }
            buffer.push_back(line);
        }
    });
}

/// 取出子进程输出的尾巴，拼进错误文案。空的时候就返回空串。
fn child_log_tail(log: &ChildLog) -> String {
    let Ok(buffer) = log.lock() else {
        return String::new();
    };
    buffer
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// 把 opencode 的 `{ "data": ... }` 信封拆掉。
///
/// v2 给所有响应都套了这一层（列表还多一个 `cursor`），而前端要的是里面那个
/// 裸数组/对象。在这里拆掉，前端那几个解析函数就能维持原样。
fn unwrap_data(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(mut map) if map.contains_key("data") => {
            map.remove("data").unwrap_or(serde_json::Value::Null)
        }
        other => other,
    }
}

/// 一个工作区的智能体运行槽位。克隆给 SSE 任务和退出轮询线程持有——
/// 它俩要独立于命令调用存活，不能借用 `AgentState`。
#[derive(Clone)]
struct Slot {
    inner: Arc<Mutex<Option<Running>>>,
    generation: Arc<AtomicU64>,
}

/// 进程池，**按工作区 root 分片**：一个工作区一个 opencode 进程，切走的工作区继续跑。
pub struct AgentState {
    slots: Mutex<HashMap<String, Slot>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// 取（必要时创建）某工作区的槽位。锁被毒掉也照常用内部值——
    /// 这里没有跨字段的不变式，一次 panic 不该让整个智能体功能瘫掉。
    fn slot(&self, root: &str) -> Slot {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots
            .entry(root.to_string())
            .or_insert_with(|| Slot {
                inner: Arc::new(Mutex::new(None)),
                generation: Arc::new(AtomicU64::new(1)),
            })
            .clone()
    }

    /// 只查已有槽位，不创建。给「操作已经在跑的服务」那批命令用——
    /// 免得前端传来一个没登记过的目录就凭空多出一个空槽位。
    fn peek(&self, root: &str) -> Option<Slot> {
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(root)
            .cloned()
    }

    /// 收掉某个工作区的 opencode 进程并删掉它的配置目录。
    pub fn kill_workspace(&self, root: &str) {
        let removed = self
            .slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(root);
        if let Some(slot) = removed {
            kill_slot(&slot);
        }
    }

    /// 应用退出时调用，别留下游离的 opencode 进程。
    pub fn kill_all(&self) {
        // 先取出 root 列表再逐个收，别持着锁去调 kill_workspace（它会再取一次锁）
        let roots: Vec<String> = self
            .slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        for root in roots {
            self.kill_workspace(&root);
        }
    }
}

/// 换掉这一代实例：代次 +1 让 SSE / 退出轮询自然收摊，再杀进程、删配置目录。
fn kill_slot(slot: &Slot) {
    slot.generation.fetch_add(1, Ordering::SeqCst);
    let running = slot.inner.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(mut running) = running {
        kill_child(&mut running.child);
        let _ = std::fs::remove_dir_all(&running.config_dir);
    }
}

// ---- 进程解析：跨三端最容易踩空的一块 ----

/// 怎么把 opencode 真正拉起来。
pub(crate) enum Launch {
    /// 直接执行
    Direct(PathBuf),
    /// Windows 上 npm 装出来的是 .cmd 垫片，CreateProcess 不认，得借 cmd 起
    ViaCmd(PathBuf),
}

/// 把配置里的「opencode」解析成一个能 spawn 的目标。
///
/// 收的是**单个可执行文件名或路径**，不是整条命令行：`npx opencode` 那种
/// 得先拆开（cli_sessions 的 `split_command` 就是干这个的）。
pub(crate) fn resolve_launch(configured: &str, path: Option<&OsStr>) -> Result<Launch, String> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return Err("没有配置 opencode 可执行文件".to_string());
    }

    let found = if trimmed.contains('/') || trimmed.contains('\\') {
        let path = PathBuf::from(trimmed);
        if !path.is_file() {
            return Err(format!("找不到 opencode 可执行文件：{trimmed}"));
        }
        path
    } else {
        find_on_path(trimmed, path).ok_or_else(|| {
            format!("在 PATH 里找不到 {trimmed}，请先安装，或在「设置 → 智能体」里填写完整路径")
        })?
    };

    Ok(if needs_cmd_wrapper(&found) {
        Launch::ViaCmd(found)
    } else {
        Launch::Direct(found)
    })
}

/// Windows 上找可执行文件得挨个试后缀：npm 全局装出来的只有 `.cmd` 和无扩展名的
/// shell 脚本，没有 `.exe`，而 `CreateProcess` 只会自动补 `.exe`。
///
/// cli_sessions 列 opencode 会话时也要起同一个 CLI，所以放开到 crate 内——
/// 这套三端差异复制的第二遍必然漂（`hide_console` 已经在 git.rs 有一份了）。
pub(crate) fn find_on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    #[cfg(windows)]
    let names: Vec<String> = if Path::new(name).extension().is_some() {
        vec![name.to_string()]
    } else {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    };
    #[cfg(not(windows))]
    let names: Vec<String> = vec![name.to_string()];

    std::env::split_paths(path?)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
pub(crate) fn needs_cmd_wrapper(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("cmd") | Some("bat")
    )
}

#[cfg(not(windows))]
pub(crate) fn needs_cmd_wrapper(_path: &Path) -> bool {
    false
}

/// 挑一个空闲端口：让系统分配，拿到号之后立刻放掉。中间那一小段窗口理论上会被
/// 别人抢，但本地开发场景不值得为此再加一层握手。
pub(crate) fn free_port() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("分配端口失败: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("读取端口失败: {e}"))
}

/// 用户指定了固定端口时先探一下，被占了要早点报错，别等健康检查超时。
pub(crate) fn check_port(port: u16) -> Result<u16, String> {
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(port)
        }
        Err(_) => Err(format!("端口 {port} 已被占用，请改成自动分配或换一个端口")),
    }
}

// ---- 配置注入 ----

/// 校验技能名 / agent 名。两类名字都会成为 opencode 侧的 key（技能还是目录名），
/// 所以只放行小写字母、数字和单个连字符——既能挡住路径穿越，也和 opencode 对技能名
/// 的要求（`^[a-z0-9]+(-[a-z0-9]+)*$`）一致。前端有同样的校验，这里再挡一道。
fn validate_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    let valid = !trimmed.is_empty()
        && trimmed.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        });
    if !valid {
        return Err(format!(
            "非法名称「{name}」：只能用 a-z、0-9 和单个连字符（如 my-skill）"
        ));
    }
    Ok(trimmed)
}

/// 拼一份 SKILL.md。frontmatter 只放 opencode 认的 `name` / `description`。
///
/// 值用 JSON 字符串渲染（JSON 字符串是合法的 YAML flow scalar），这样描述里带冒号、
/// 引号或换行都不会把 frontmatter 撑坏。
fn render_skill(skill: &SkillSpec) -> String {
    let name = serde_json::to_string(skill.name.trim()).unwrap_or_default();
    let description = serde_json::to_string(skill.description.trim()).unwrap_or_default();
    format!(
        "---\nname: {name}\ndescription: {description}\n---\n\n{}\n",
        skill.content.trim()
    )
}

/// 提供商没配齐时的提示。开发调试版可以只写 `src-tauri/.env`，提示里带上这条，
/// 免得以为没救。
fn provider_hint() -> String {
    let base = "请先在「设置 → 智能体 → 模型提供商」里添加一个提供商（填接口地址和至少一个模型）";
    if cfg!(debug_assertions) {
        format!("{base}，或写进 src-tauri/.env")
    } else {
        base.to_string()
    }
}

/// 生成 CodeDock 专用的 opencode 配置，写在自己的配置目录里。
///
/// 用 `OPENCODE_CONFIG_DIR` 把它指过去，完全不碰用户的 `~/.config/opencode/`；
/// 也不往工作区写 `opencode.json`——那会污染用户仓库、出现在 git 改动列表里。
///
/// 规则 / 记忆 / 技能 / Agents 都在这里物化成 opencode 认的文件与字段：
/// - 规则、记忆 → 各写一份 markdown，用 `instructions` 的绝对路径指过去；
/// - 技能 → `<name>/SKILL.md`，再把技能根目录登记到 `skills.paths`
///   （不赌 `OPENCODE_CONFIG_DIR` 会自动搜 `skills/`——文档只保证搜 agents/plugins 那些）；
/// - Agents → opencode.json 的 `agent` map；
/// - 选中的 primary agent → `default_agent`。
///
/// 配置目录整体是「每次启动重新生成」的产物，所以 `kill()` 里删掉它没关系。
///
/// `db_target` 为 `Some` 表示这次起的是数据库 Agent：除常规配置外，再注入只读的数据库
/// MCP 工具（本 exe 的 `--mcp-db` 子命令）、内置技能与专用 primary agent。
///
/// `app_mailbox` 为 `Some`（所有**工作区**智能体都是）时，额外注入「应用助手」：
/// 界面操作的 MCP 工具（本 exe 的 `--mcp-app`）、内置技能与专用 primary agent。
/// 它**总是**注入而不是按需——opencode 的 agent 与 MCP 都是启动时读配置定下的，
/// 起完再切 primary agent 不会重读，按需注入就得在切换时重启整个服务。
///
/// `preview_mailbox` 为 `Some`（同样只给工作区智能体）时，额外注入「预览助手」：
/// 预览工具（本 exe 的 `--mcp-preview`）、内置技能与专用 primary agent。
fn write_config(
    dir: &Path,
    cfg: &AgentConfig,
    db_target: Option<&Path>,
    app_mailbox: Option<&Path>,
    preview_mailbox: Option<&Path>,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;

    let mut instructions: Vec<String> = Vec::new();
    for (file, text) in [("rules.md", &cfg.rules), ("memory.md", &cfg.memory)] {
        if text.trim().is_empty() {
            continue;
        }
        let path = dir.join(file);
        std::fs::write(&path, text).map_err(|e| format!("写入 {file} 失败: {e}"))?;
        instructions.push(path.to_string_lossy().into_owned());
    }

    let skills_dir = dir.join("skills");
    let mut wrote_skill = false;
    for skill in &cfg.skills {
        let name = validate_name(&skill.name)?;
        let target = skills_dir.join(name);
        std::fs::create_dir_all(&target).map_err(|e| format!("创建技能目录失败: {e}"))?;
        std::fs::write(target.join("SKILL.md"), render_skill(skill))
            .map_err(|e| format!("写入技能失败: {e}"))?;
        wrote_skill = true;
    }

    // 数据库 Agent 内置一份技能：把「先看表、再确认字段、只写 SELECT」的流程写死给模型
    if db_target.is_some() {
        let target = skills_dir.join(DB_AGENT_SKILL_NAME);
        std::fs::create_dir_all(&target).map_err(|e| format!("创建技能目录失败: {e}"))?;
        let skill = SkillSpec {
            name: DB_AGENT_SKILL_NAME.to_string(),
            description: "用只读 SQL 查询当前数据库连接：先列表、再看表结构、最后执行查询"
                .to_string(),
            content: DB_AGENT_SKILL_BODY.to_string(),
        };
        std::fs::write(target.join("SKILL.md"), render_skill(&skill))
            .map_err(|e| format!("写入技能失败: {e}"))?;
        wrote_skill = true;
    }

    // 应用助手也内置一份技能：把 CodeDock 的界面结构与设置字段名写死给模型，
    // 用户问「怎么改字号」时能直接答对
    if app_mailbox.is_some() {
        let target = skills_dir.join(APP_AGENT_SKILL_NAME);
        std::fs::create_dir_all(&target).map_err(|e| format!("创建技能目录失败: {e}"))?;
        let skill = SkillSpec {
            name: APP_AGENT_SKILL_NAME.to_string(),
            description: "CodeDock 界面结构与设置字段速查：界面操作助手回答「怎么改某设置」时用"
                .to_string(),
            content: APP_AGENT_SKILL_BODY.to_string(),
        };
        std::fs::write(target.join("SKILL.md"), render_skill(&skill))
            .map_err(|e| format!("写入技能失败: {e}"))?;
        wrote_skill = true;
    }

    // 预览助手也内置一份技能：把「先探测、再启动」的流程与项目类型判断依据写死给模型
    if preview_mailbox.is_some() {
        let target = skills_dir.join(PREVIEW_AGENT_SKILL_NAME);
        std::fs::create_dir_all(&target).map_err(|e| format!("创建技能目录失败: {e}"))?;
        let skill = SkillSpec {
            name: PREVIEW_AGENT_SKILL_NAME.to_string(),
            description: "按项目类型启动 / 停止预览：先探测、再启动、后查状态".to_string(),
            content: PREVIEW_AGENT_SKILL_BODY.to_string(),
        };
        std::fs::write(target.join("SKILL.md"), render_skill(&skill))
            .map_err(|e| format!("写入技能失败: {e}"))?;
        wrote_skill = true;
    }

    let default_model = cfg
        .resolved_default_model()
        .ok_or_else(|| format!("没有可用的模型提供商。{}", provider_hint()))?;
    let default_provider = cfg.default_provider_id();

    // 模型名和 provider id 都是用户填的，得当动态 key 用，所以走 Map 而不是 json! 的字面量语法
    let mut providers = serde_json::Map::new();
    for provider in cfg.usable_providers() {
        let mut models = serde_json::Map::new();
        for model in provider
            .models
            .iter()
            .map(|model| model.trim())
            .filter(|model| !model.is_empty())
        {
            models.insert(model.to_string(), serde_json::json!({ "name": model }));
        }

        let mut options = serde_json::Map::new();
        options.insert(
            "baseURL".to_string(),
            serde_json::json!(provider.base_url.trim()),
        );
        // 密钥不落盘：只留环境变量占位符，正文由 spawn 时从系统钥匙串取出来注入。
        // 本地模型（Ollama 之类）没有密钥，这时干脆不下发这个字段，塞个空占位符
        // 反而会让 opencode 拿空串去鉴权
        if provider.has_key {
            options.insert(
                "apiKey".to_string(),
                serde_json::json!(format!("{{env:{}}}", provider.api_key_env())),
            );
        }

        providers.insert(
            provider.id.clone(),
            serde_json::json!({
                "npm": "@ai-sdk/openai-compatible",
                "name": provider.name.trim(),
                "options": serde_json::Value::Object(options),
                "models": serde_json::Value::Object(models),
            }),
        );
    }

    let mut agents = serde_json::Map::new();
    for agent in &cfg.agents {
        let name = validate_name(&agent.name)?;
        let mode = agent.mode.trim();
        if !matches!(mode, "primary" | "subagent" | "all") {
            return Err(format!("Agent「{name}」的模式非法：{mode}"));
        }
        let mut entry = serde_json::json!({
            "description": agent.description.trim(),
            "mode": mode,
            "prompt": agent.prompt,
        });
        if !agent.model.trim().is_empty() {
            // opencode 的 agent.model 要 `provider/model` 全名。历史数据里可能只存了
            // 一个裸模型名，补上默认提供商前缀——不补的话 opencode 解不出来，静默回落。
            let model = agent.model.trim();
            entry["model"] = serde_json::json!(match (model.contains('/'), &default_provider) {
                (false, Some(provider)) => format!("{provider}/{model}"),
                _ => model.to_string(),
            });
        }
        agents.insert(name.to_string(), entry);
    }

    if db_target.is_some() {
        // 数据库 Agent 固定用自己的 primary agent：角色与边界要盖在用户的通用配置之上
        agents.insert(
            DB_AGENT_AGENT_NAME.to_string(),
            serde_json::json!({
                "description": "只读数据库查询助手",
                "mode": "primary",
                "prompt": DB_AGENT_PROMPT,
            }),
        );
    }

    if app_mailbox.is_some() {
        // 应用助手：同样是固定角色 + 固定边界。`tools` 逐项关掉文件 / 命令 / 联网类工具，
        // 它只该动 CodeDock 界面（`app_*` 那组 MCP 工具）——这是 per-agent 的开关，
        // 不会波及用户自己的 coding agent。
        let tools = APP_AGENT_DISABLED_TOOLS
            .iter()
            .map(|name| (name.to_string(), serde_json::json!(false)))
            .collect::<serde_json::Map<String, serde_json::Value>>();
        agents.insert(
            APP_AGENT_AGENT_NAME.to_string(),
            serde_json::json!({
                "description": "CodeDock 界面操作助手：问答并修改设置、工作区与界面布局",
                "mode": "primary",
                "prompt": APP_AGENT_PROMPT,
                "tools": serde_json::Value::Object(tools),
            }),
        );
    }

    if preview_mailbox.is_some() {
        // 预览助手：固定角色 + 固定边界。保留 read / grep / glob / list（必要时看项目结构），
        // 关掉文件写 / 命令 / 联网类工具——它只该起停预览。
        let tools = PREVIEW_AGENT_DISABLED_TOOLS
            .iter()
            .map(|name| (name.to_string(), serde_json::json!(false)))
            .collect::<serde_json::Map<String, serde_json::Value>>();
        agents.insert(
            PREVIEW_AGENT_AGENT_NAME.to_string(),
            serde_json::json!({
                "description": "CodeDock 预览助手：按项目类型启动 / 停止预览，方便调试验证",
                "mode": "primary",
                "prompt": PREVIEW_AGENT_PROMPT,
                "tools": serde_json::Value::Object(tools),
            }),
        );
    }

    let mut config = serde_json::json!({
        "provider": serde_json::Value::Object(providers),
        "model": default_model,
        // v1 没有审批 UI，不放行的话 doom_loop / external_directory 这类默认 ask 的
        // 规则会让会话卡在那儿等人点确认。这是有意的取舍，等审批 UI 做出来再收紧。
        "permission": "allow",
    });

    if !instructions.is_empty() {
        config["instructions"] = serde_json::json!(instructions);
    }
    if wrote_skill {
        config["skills"] = serde_json::json!({
            "paths": [skills_dir.to_string_lossy()],
        });
    }
    if !agents.is_empty() {
        config["agent"] = serde_json::Value::Object(agents);
    }
    if !cfg.primary.trim().is_empty() {
        config["default_agent"] = serde_json::json!(cfg.primary.trim());
    }

    if let Some(target) = db_target {
        // 只读数据库工具走本 exe 的 `--mcp-db` 子命令。`timeout` 要放宽：默认 5s 会把
        // 慢查询直接掐断（它是 MCP 请求超时，不只是握手）。
        let exe = std::env::current_exe().map_err(|e| format!("拿不到程序路径: {e}"))?;
        config["mcp"] = serde_json::json!({
            "db": {
                "type": "local",
                "command": [exe.to_string_lossy(), "--mcp-db"],
                "environment": { "CODEDOCK_DB_TARGET": target.to_string_lossy() },
                "timeout": 60000,
            }
        });
        // 数据库 Agent 用不到文件 / 命令工具，关掉免得它去翻磁盘或跑 shell
        config["tools"] = serde_json::json!({
            "bash": false,
            "edit": false,
            "write": false,
            "patch": false,
        });
        // 强制用内置的 database agent，盖掉面板传上来的 primary
        config["default_agent"] = serde_json::json!(DB_AGENT_AGENT_NAME);
    }

    if let Some(mailbox) = app_mailbox {
        // 界面操作工具走本 exe 的 `--mcp-app` 子命令。邮箱目录用环境变量告诉子进程，
        // 它只负责写请求 / 读响应，真正执行在前端（见 src-tauri/src/app_agent.rs）。
        // `timeout` 放到 2 分钟：工具要一直等前端执行完，用户还可能要点确认框，
        // 默认 5s 必然掐断。
        let exe = std::env::current_exe().map_err(|e| format!("拿不到程序路径: {e}"))?;
        let entry = serde_json::json!({
            "type": "local",
            "command": [exe.to_string_lossy(), "--mcp-app"],
            "environment": { "CODEDOCK_APP_MAILBOX": mailbox.to_string_lossy() },
            "timeout": 120000,
        });
        // 与上面 db 那块互斥（工作区智能体不会是数据库 Agent），但真撞上也得两边都留住
        match config.get_mut("mcp") {
            Some(serde_json::Value::Object(map)) => {
                map.insert("app".to_string(), entry);
            }
            _ => config["mcp"] = serde_json::json!({ "app": entry }),
        }
    }

    if let Some(mailbox) = preview_mailbox {
        // 预览工具走本 exe 的 `--mcp-preview` 子命令，邮箱目录用环境变量告诉子进程，
        // 它只负责写请求 / 读响应，真正执行在前端（见 src-tauri/src/preview_agent.rs）。
        // `timeout` 放到 2 分钟：起 dev server 要等，工具得一直等前端把结果写回来。
        let exe = std::env::current_exe().map_err(|e| format!("拿不到程序路径: {e}"))?;
        let entry = serde_json::json!({
            "type": "local",
            "command": [exe.to_string_lossy(), "--mcp-preview"],
            "environment": { "CODEDOCK_PREVIEW_MAILBOX": mailbox.to_string_lossy() },
            "timeout": 120000,
        });
        match config.get_mut("mcp") {
            Some(serde_json::Value::Object(map)) => {
                map.insert("preview".to_string(), entry);
            }
            _ => config["mcp"] = serde_json::json!({ "preview": entry }),
        }
    }

    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("opencode.json"), text).map_err(|e| format!("写入配置失败: {e}"))
}

// ---- 起进程 / 杀进程 ----

/// 起 opencode 服务。返回子进程和它的输出缓冲（启动失败时要靠它说清原因）。
fn spawn_opencode(
    command: &str,
    port: u16,
    cwd: &Path,
    config_dir: &Path,
    secrets: &[(String, String)],
    password: &str,
) -> Result<(Child, ChildLog), String> {
    let port_text = port.to_string();
    let args = [
        "serve",
        "--port",
        port_text.as_str(),
        "--hostname",
        "127.0.0.1",
    ];
    let path = crate::shell_env::resolved_path(&crate::shell_env::default_shell(), Some(cwd));

    let mut cmd = match resolve_launch(command, path.as_deref())? {
        Launch::Direct(path) => {
            let mut c = Command::new(path);
            c.args(args);
            c
        }
        Launch::ViaCmd(path) => wrap_with_cmd(&path, &args),
    };

    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    cmd.current_dir(cwd).env("OPENCODE_CONFIG_DIR", config_dir);
    // 密钥只走环境变量：配置文件里只有 `{env:...}` 占位符
    for (name, value) in secrets {
        cmd.env(name, value);
    }
    cmd
        // 自己定口令，省得去解析它打到 stdout 的那行随机密码
        .env(PASSWORD_ENV, password)
        .stdin(Stdio::null())
        // 两路都接出来喂环形缓冲：opencode 启动失败时（端口被占、插件装不上、
        // 配置读不了）只说在 stdout/stderr 上，丢掉的话界面上只剩"启动超时"
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 自成进程组，退出时能整组一起收
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!("启动 opencode 失败: {e}。请确认已安装，或在「设置 → 智能体」里填写完整路径")
    })?;

    let log = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stdout) = child.stdout.take() {
        pump_child_log(stdout, Arc::clone(&log));
    }
    if let Some(stderr) = child.stderr.take() {
        pump_child_log(stderr, Arc::clone(&log));
    }

    Ok((child, log))
}

/// 借 cmd 起 `.cmd`/`.bat` 垫片。
///
/// `/S` 让 cmd 只剥掉最外层一对引号、其余原样，这样路径带空格也不会被拆散。
/// 参数是拼成字符串交给 cmd 的，所以**只对不含空格和引号的参数安全**——
/// 这条路径上的参数要么是端口这种数字，要么是 `session list --format json`
/// 这种固定词，都不需要转义。
#[cfg(windows)]
pub(crate) fn wrap_with_cmd(path: &Path, args: &[&str]) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("cmd");
    command.raw_arg(format!(
        "/S /C \"\"{}\" {}\"",
        path.display(),
        args.join(" ")
    ));
    command
}

/// 非 Windows 上走不到（`needs_cmd_wrapper` 恒为 false），但得有实现才能编译过
#[cfg(not(windows))]
pub(crate) fn wrap_with_cmd(path: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(path);
    command.args(args);
    command
}

/// Windows 上不隐藏的话，每次起服务都会闪一个控制台黑框
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

#[cfg(windows)]
pub(crate) fn kill_child(child: &mut Child) {
    // opencode 跑 bash 工具时会派生子 shell，child.kill() 只杀得掉直接子进程，
    // 所以走 taskkill /T 连整棵树一起收
    let pid = child.id().to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.wait();
}

#[cfg(not(windows))]
pub(crate) fn kill_child(child: &mut Child) {
    // 启动时 process_group(0) 已让它自成一组，负号表示整组一起发信号
    let pid = child.id();
    let _ = Command::new("kill")
        .args(["-s", "TERM", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

// ---- HTTP 辅助 ----

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("无法创建 HTTP 客户端: {e}"))
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

/// 拿当前实例的端口、口令、接口代次。每个命令都要这三样：
/// 端口拼 URL、口令做认证（只有 v2 用得上）、协议决定走哪条路由。
fn current_endpoint(state: &AgentState, root: &str) -> Result<(Protocol, u16, String), String> {
    // 只查已有槽位：没启动过的工作区不在这里，也就不必凭空建一个
    let slot = state
        .peek(root)
        .ok_or_else(|| "智能体服务还没启动".to_string())?;
    let guard = slot.inner.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|running| (running.protocol, running.port, running.password.clone()))
        .ok_or_else(|| "智能体服务还没启动".to_string())
}

/// 发一个请求并把响应体当 JSON 取回来。
///
/// 不定义严格的响应结构体：opencode 的字段还在演进，换版本少一层就可能反序列化失败，
/// 用 `Value` 逐层取更耐操（和 `ai.rs` 一个路子）。
///
/// 认证头只在协议需要时才加（v1 完全没认证，多送一个头虽然多半无害，但没必要）。
async fn request_json(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    body: Option<serde_json::Value>,
    protocol: Protocol,
    password: &str,
) -> Result<serde_json::Value, String> {
    let mut request = client.request(method, &url);
    if protocol.needs_auth() {
        request = request.header(reqwest::header::AUTHORIZATION, basic_auth(password));
    }
    if let Some(payload) = body {
        request = request.json(&payload);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("请求 opencode 失败: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取 opencode 响应失败: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "opencode 返回 {}: {}",
            status.as_u16(),
            truncate(&text, MAX_ERROR_CHARS)
        ));
    }

    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }

    serde_json::from_str(&text).map_err(|_| {
        format!(
            "无法解析 opencode 响应: {}",
            truncate(&text, MAX_ERROR_CHARS)
        )
    })
}

/// 一个探针打过去的结果，只用于报错时说明"每个探针各自返回了什么"。
struct ProbeOutcome {
    path: &'static str,
    detail: String,
}

/// 探出对面是哪一代接口，顺带把版本号取回来。
///
/// **按接口探，不按版本号推**：过渡期的 `@opencode/cli@0.0.0-dev-*` 版本号是 0.x
/// 但接口已经是 v2 形态，按号判会误当成 v1，然后去打它不存在的 `/global/health`。
/// 探针顺序见 `PROBES`。服务要时间才起得来，所以在 `timeout` 内轮询。
///
/// 失败时把每个探针各自返回了什么、连同子进程输出尾巴一起报出去——
/// 只说一句"启动超时"是没法排查的（这条是上一轮踩过的坑）。
async fn detect_protocol(
    port: u16,
    password: &str,
    log: &ChildLog,
    timeout: Duration,
) -> Result<(Protocol, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("无法创建 HTTP 客户端: {e}"))?;

    let deadline = Instant::now() + timeout;
    let mut outcomes: Vec<ProbeOutcome> = PROBES
        .iter()
        .map(|(path, _, _)| ProbeOutcome {
            path,
            detail: "未响应".to_string(),
        })
        .collect();

    while Instant::now() < deadline {
        for (index, (path, needs_auth, protocol)) in PROBES.iter().enumerate() {
            let url = endpoint(*protocol, port, path);
            let mut request = client.get(&url);
            if *needs_auth {
                request = request.header(reqwest::header::AUTHORIZATION, basic_auth(password));
            }
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        outcomes[index].detail = format!("HTTP {}", status.as_u16());
                        continue;
                    }
                    // 必须拿到 JSON 才算数：命中不了路由时 opencode 会把 SPA 的
                    // index.html 吐出来（200 + text/html），那不能当成探针成功
                    let Ok(value) = response.json::<serde_json::Value>().await else {
                        outcomes[index].detail =
                            "200 但不是 JSON（多半是前端页面兜底）".to_string();
                        continue;
                    };
                    // 还必须有 version：v1 也会应答 /api/health，但只回
                    // `{"healthy":true}`，光看 200 会把它误当 dev 构建
                    let Some(version) = value.get("version").and_then(|v| v.as_str()) else {
                        outcomes[index].detail = "200 JSON 但没有 version 字段".to_string();
                        continue;
                    };
                    return Ok((*protocol, version.to_string()));
                }
                Err(e) => outcomes[index].detail = e.to_string(),
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    let tried = outcomes
        .iter()
        .map(|o| format!("  {} → {}", o.path, o.detail))
        .collect::<Vec<_>>()
        .join("\n");
    let tail = child_log_tail(log);
    let mut message = format!(
        "没认出 opencode 的接口代次（v1 / v2 都试了）：\n{tried}\n\n\
         确认它的版本是否受支持；老版本可能需要升级。"
    );
    if !tail.is_empty() {
        message.push_str(&format!("\n\nopencode 的输出：\n{tail}"));
    }
    Err(message)
}

// ---- SSE ----

/// 从缓冲区头部切出一个完整的 SSE 帧（以空行分隔），没切到就返回 None。
///
/// **缓冲区是原始字节、只在切出完整帧后才解码**：TCP chunk 边界会随机切开一个多字节
/// 字符（中文 / emoji），若先 `from_utf8_lossy` 再拼进字符串，被切开的前后两半会各自
/// 变成 U+FFFD 且不可逆。帧分隔符是 ASCII `\n`，一定落在字符边界上，所以能安全地
/// 「先按字节切帧、再对完整帧解码」——那时帧内字节必然完整。
fn pop_frame(buffer: &mut Vec<u8>) -> Option<String> {
    let mut i = 0;
    while i < buffer.len() {
        if buffer[i] == b'\n' {
            // 空行才算分隔：`\n\n` 或 `\n\r\n`
            let rest = &buffer[i + 1..];
            let skip = if rest.first() == Some(&b'\n') {
                1
            } else if rest.starts_with(b"\r\n") {
                2
            } else {
                0
            };
            if skip > 0 {
                let mut frame = &buffer[..i];
                // CRLF 时行尾的 \r 是分隔符的一部分，不是内容
                if frame.ends_with(b"\r") {
                    frame = &frame[..frame.len() - 1];
                }
                let frame = String::from_utf8_lossy(frame).into_owned();
                buffer.drain(..i + 1 + skip);
                return Some(frame);
            }
        }
        i += 1;
    }
    None
}

/// 从一帧里取出 `data:` 行的内容。
///
/// opencode 的 SSE 只发 `data:` 行、不发 `event:` 行，事件类型在 JSON 的 `type` 字段里，
/// 所以这里只需要认 data。多行 data 按 SSE 规范本该用换行拼接，实测它只发单行。
fn frame_data(frame: &str) -> Option<&str> {
    frame
        .lines()
        .find_map(|line| line.strip_prefix("data:").map(str::trim_start))
}

/// 起一个后台任务持续读 SSE 并转推给前端。断了就退避重连，直到这一代实例被换掉。
///
/// 事件流两代的路径只差 `/api` 前缀，但认证只有 v2 要——v2 漏了认证头会直接 401，
/// 表现成"连上了但一条事件都没有"。
fn spawn_sse(
    app: AppHandle,
    inner: Arc<Mutex<Option<Running>>>,
    root: String,
    protocol: Protocol,
    port: u16,
    password: String,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().build() {
            Ok(c) => c,
            Err(_) => return,
        };
        let url = endpoint(protocol, port, "/event");
        let auth = basic_auth(&password);

        while is_current(&inner, generation) {
            let mut request = client.get(&url);
            if protocol.needs_auth() {
                request = request.header(reqwest::header::AUTHORIZATION, &auth);
            }
            if let Ok(mut response) = request.send().await {
                // 原始字节累积，帧边界处才解码，避免切开多字节字符
                let mut buffer: Vec<u8> = Vec::new();
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) => {
                            buffer.extend_from_slice(&chunk);
                            while let Some(frame) = pop_frame(&mut buffer) {
                                let Some(data) = frame_data(&frame) else {
                                    continue;
                                };
                                if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                                    let _ = app.emit(
                                        EVENT_NAME,
                                        TaggedEvent {
                                            root: root.clone(),
                                            event: value,
                                        },
                                    );
                                }
                            }
                        }
                        // 流结束或出错都退到外层重连
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
            }

            if !is_current(&inner, generation) {
                break;
            }
            tokio::time::sleep(RECONNECT_DELAY).await;
        }
    });
}

/// 起一个线程盯着子进程，自己退出时清掉状态并通知前端。
///
/// 用 try_wait 轮询而不是 child.wait()：child 锁在状态里，没法 move 出去单独 wait。
fn spawn_exit_watcher(
    app: AppHandle,
    inner: Arc<Mutex<Option<Running>>>,
    generation: Arc<AtomicU64>,
    root: String,
    port: u16,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(EXIT_POLL);

        let mut guard = match inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let alive = match guard.as_mut() {
            Some(running) if running.port == port => match running.child.try_wait() {
                Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                Ok(None) => None,
                Err(_) => Some(-1),
            },
            // 已经被换掉或停掉了，收工
            _ => return,
        };

        if let Some(code) = alive {
            guard.take();
            generation.fetch_add(1, Ordering::SeqCst);
            drop(guard);
            let _ = app.emit(
                EXIT_EVENT,
                TaggedEvent {
                    root: root.clone(),
                    event: serde_json::json!(code),
                },
            );
            return;
        }
    });
}

/// 这一代实例是否还是当前实例。
fn is_current(inner: &Arc<Mutex<Option<Running>>>, generation: u64) -> bool {
    match inner.lock() {
        Ok(guard) => guard
            .as_ref()
            .map(|running| running.generation == generation)
            .unwrap_or(false),
        Err(_) => false,
    }
}

// ---- 命令 ----

/// 工作区的配置目录名：root 是完整路径，不能直接当目录名——把非法字符换成 `_`，
/// 再缀一段稳定 hash 保证唯一（截断之后也不会撞）。
fn workspace_dir_name(root: &Path) -> String {
    let mut safe: String = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    // 路径长了只留尾部，免得超文件名长度上限
    if safe.len() > 60 {
        safe = safe.split_off(safe.len() - 60);
    }
    format!("{safe}-{:016x}", stable_hash(root))
}

/// FNV-1a。不用 std 的 `DefaultHasher`：它的输出不保证跨 Rust 版本稳定，
/// 换个版本编译就会把配置目录换掉，之前的 session 全丢。
fn stable_hash(path: &Path) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 启动智能体服务。幂等：同一个工作区已经在跑就直接返回现有信息。
#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: tauri::State<'_, AgentState>,
    fs_state: tauri::State<'_, FsState>,
    root: String,
    config: AgentConfig,
) -> Result<AgentInfo, String> {
    // 覆盖要赶在下面判空之前：面板留空、只写 .env 时也得能起
    let mut config = config;
    config.apply(&dev::read_overrides());
    // 判空一律用可用的提供商：地址或模型缺一个，opencode 那边只会静默回落，界面上
    // 却看不出问题，不如在这里拦下来把话说清楚
    if config.usable_providers().is_empty() {
        return Err(format!("没有可用的模型提供商。{}", provider_hint()));
    }
    if config.resolved_default_model().is_none() {
        return Err(format!("默认模型不可用。{}", provider_hint()));
    }
    let secrets = config.secrets()?;

    // git / 文件系统都是同步阻塞的，赶在第一个 await 之前跑完，别让 std 的锁跨越 await。
    // 数据库 Agent 用一个固定的哨兵 root（前端传的常量），它不属于任何工作区、
    // 走不了 checked_root 的白名单，所以 cwd 固定落在应用配置目录下的一个空目录里
    let cwd = if config.database {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("拿不到配置目录: {e}"))?
            .join("db-agent")
            .join("cwd");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
        dir
    } else {
        fs_state.checked_root(&root)?
    };
    let slot = state.slot(&root);

    let (port, generation, cwd_text) = {
        let mut guard = slot.inner.lock().map_err(|e| e.to_string())?;

        // 同一个工作区已经在跑：直接复用，不重启
        if let Some(running) = guard.as_ref() {
            if running.cwd == cwd {
                return Ok(AgentInfo {
                    port: running.port,
                    version: String::new(),
                    protocol: running.protocol.label().to_string(),
                    cwd: running.cwd.to_string_lossy().to_string(),
                });
            }
        }

        // 工作区变了（或之前跑挂了），先收掉旧的
        slot.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut old) = guard.take() {
            kill_child(&mut old.child);
            let _ = std::fs::remove_dir_all(&old.config_dir);
        }

        let port = if config.port == 0 {
            free_port()?
        } else {
            check_port(config.port)?
        };

        // 配置目录按工作区分开：共用一份会让两个 opencode 进程争用同一批文件，
        // 而且收掉某个工作区时的 remove_dir_all 会把另一个还在用的目录一起删掉
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("拿不到配置目录: {e}"))?
            .join("opencode")
            .join(workspace_dir_name(&cwd));
        // 数据库 Agent 的目标连接文件由主进程维护（前端切连接时更新），这里只把路径写进配置
        let db_target = if config.database {
            Some(crate::db_agent::target_path(&app)?)
        } else {
            None
        };
        // 应用助手的界面操作邮箱同理，只给工作区智能体（数据库 Agent 用不到界面工具）
        let app_mailbox = if config.database {
            None
        } else {
            Some(crate::app_agent::mailbox_dir(&app)?)
        };
        // 预览助手的邮箱同理，也只给工作区智能体
        let preview_mailbox = if config.database {
            None
        } else {
            Some(crate::preview_agent::mailbox_dir(&app)?)
        };
        write_config(
            &config_dir,
            &config,
            db_target.as_deref(),
            app_mailbox.as_deref(),
            preview_mailbox.as_deref(),
        )?;

        let password = random_password();
        let (child, log) = spawn_opencode(
            &config.command,
            port,
            &cwd,
            &config_dir,
            &secrets,
            &password,
        )?;
        let generation = slot.generation.load(Ordering::SeqCst);

        // cwd 马上要被 move 进 Running，先把字符串形态留下来给返回用
        let cwd_text = cwd.to_string_lossy().to_string();
        *guard = Some(Running {
            child,
            port,
            // 占位：探测通过后会就地改成真值。探测没过就 kill 掉，没人读得到这个值
            protocol: Protocol::V2,
            cwd,
            config_dir,
            generation,
            password,
            log,
        });

        (port, generation, cwd_text)
    };

    // 探测是异步的，放在锁外面
    let (password, log) = {
        let guard = slot.inner.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(running) => (running.password.clone(), Arc::clone(&running.log)),
            None => return Err("智能体服务没起来".to_string()),
        }
    };

    let (protocol, version) = match detect_protocol(port, &password, &log, HEALTH_TIMEOUT).await {
        Ok(found) => found,
        Err(reason) => {
            // 只收本工作区这一份：探测失败的责任不该由别的工作区的智能体承担
            state.kill_workspace(&root);
            return Err(reason);
        }
    };

    // 探测结果落回状态里：后面每个命令都按它选路由
    {
        let mut guard = slot.inner.lock().map_err(|e| e.to_string())?;
        match guard.as_mut() {
            Some(running) => running.protocol = protocol,
            None => return Err("智能体服务没起来".to_string()),
        }
    }

    spawn_sse(
        app.clone(),
        slot.inner.clone(),
        root.clone(),
        protocol,
        port,
        password,
        generation,
    );
    spawn_exit_watcher(app, slot.inner.clone(), slot.generation.clone(), root, port);

    Ok(AgentInfo {
        port,
        version,
        protocol: protocol.label().to_string(),
        cwd: cwd_text,
    })
}

#[tauri::command]
pub fn agent_status(state: tauri::State<'_, AgentState>, root: String) -> AgentStatus {
    let port = state.peek(&root).and_then(|slot| {
        slot.inner
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|running| running.port))
    });
    AgentStatus {
        running: port.is_some(),
        port,
    }
}

/// 停掉某个工作区的服务。关闭工作区时调。
#[tauri::command]
pub fn agent_stop(state: tauri::State<'_, AgentState>, root: String) {
    state.kill_workspace(&root);
}

/// 建一个会话。v2 把返回包在 `{data: ...}` 里，拆掉再给前端——
/// 前端只认 `{id}` 这一层。
#[tauri::command]
pub async fn agent_create_session(
    state: tauri::State<'_, AgentState>,
    root: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    let (protocol, port, password) = current_endpoint(&state, &root)?;
    let client = http_client()?;

    let mut body = serde_json::Map::new();
    if let Some(title) = title.filter(|t| !t.trim().is_empty()) {
        body.insert("title".to_string(), serde_json::Value::String(title));
    }

    let created = request_json(
        &client,
        reqwest::Method::POST,
        endpoint(protocol, port, "/session"),
        Some(serde_json::Value::Object(body)),
        protocol,
        &password,
    )
    .await?;
    Ok(protocol.unwrap(created))
}

/// 拉某个会话的历史消息。v2 返回 `{data: [...], cursor}`，拆成裸数组给前端。
#[tauri::command]
pub async fn agent_messages(
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let (protocol, port, password) = current_endpoint(&state, &root)?;
    let client = http_client()?;
    let messages = request_json(
        &client,
        reqwest::Method::GET,
        endpoint(protocol, port, &format!("/session/{session_id}/message")),
        None,
        protocol,
        &password,
    )
    .await?;
    Ok(protocol.unwrap(messages))
}

/// 列出所有会话。opencode 那边是全局存的、跨工作区混在一起，调用方自己按 directory 过滤。
///
/// v2 是游标分页（`{data, cursor}`），这里只取第一页、丢掉 cursor——界面上本来就
/// 只列最近一批，为此引入分页状态不划算。
#[tauri::command]
pub async fn agent_list_sessions(
    state: tauri::State<'_, AgentState>,
    root: String,
) -> Result<serde_json::Value, String> {
    let (protocol, port, password) = current_endpoint(&state, &root)?;
    let client = http_client()?;
    let sessions = request_json(
        &client,
        reqwest::Method::GET,
        endpoint(protocol, port, "/session"),
        None,
        protocol,
        &password,
    )
    .await?;
    Ok(protocol.unwrap(sessions))
}

/// 发一条消息。
///
/// 两代都是"立刻返回、正文靠事件流推回来"，只是路由名与请求体形状不同，
/// 分别由 `Protocol::prompt_path` 和 `prompt_body` 兜住。
#[tauri::command]
pub async fn agent_send(
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
    text: String,
    model: Option<String>,
    agent: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".to_string());
    }

    let (protocol, port, password) = current_endpoint(&state, &root)?;
    let client = http_client()?;
    let agent = agent.filter(|a| !a.trim().is_empty());

    // v2 的 prompt 体不收 agent，得先切会话的 primary agent 再发消息
    if protocol == Protocol::V2 {
        if let Some(agent) = agent.as_deref() {
            switch_agent(&client, port, &session_id, agent, protocol, &password).await?;
        }
    }

    let body = prompt_body(protocol, &text, model.as_deref(), agent.as_deref());

    request_json(
        &client,
        reqwest::Method::POST,
        endpoint(
            protocol,
            port,
            &format!("/session/{session_id}/{}", protocol.prompt_path()),
        ),
        Some(body),
        protocol,
        &password,
    )
    .await
    .map(|_| ())
}

/// 打断当前这一轮。这个名字两代不同（v1 叫 abort、v2 叫 interrupt）。
#[tauri::command]
pub async fn agent_abort(
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
) -> Result<(), String> {
    let (protocol, port, password) = current_endpoint(&state, &root)?;
    let client = http_client()?;
    request_json(
        &client,
        reqwest::Method::POST,
        endpoint(
            protocol,
            port,
            &format!("/session/{session_id}/{}", protocol.interrupt_path()),
        ),
        None,
        protocol,
        &password,
    )
    .await
    .map(|_| ())
}

/// 删掉一个会话（连同它的消息）。opencode 那边不可撤销，调用方要先确认。
#[tauri::command]
pub async fn agent_delete_session(
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
) -> Result<(), String> {
    let (protocol, port, password) = current_endpoint(&state, &root)?;
    let client = http_client()?;
    request_json(
        &client,
        reqwest::Method::DELETE,
        endpoint(protocol, port, &format!("/session/{session_id}")),
        None,
        protocol,
        &password,
    )
    .await
    .map(|_| ())
}

/// 改会话标题。两代都是 `PATCH /session/:id`，只动 title、不动消息。
#[tauri::command]
pub async fn agent_rename_session(
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
    title: String,
) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("会话标题不能为空".to_string());
    }

    let (protocol, port, password) = current_endpoint(&state, &root)?;
    let client = http_client()?;
    request_json(
        &client,
        reqwest::Method::PATCH,
        endpoint(protocol, port, &format!("/session/{session_id}")),
        Some(serde_json::json!({ "title": title })),
        protocol,
        &password,
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_adds_the_prefix_only_for_v2() {
        // v1 是裸的 /session，v2 全在 /api 下；v2 漏了前缀会拿到 SPA 的 HTML
        assert_eq!(
            endpoint(Protocol::V2, 1234, "/session"),
            "http://127.0.0.1:1234/api/session"
        );
        assert_eq!(
            endpoint(Protocol::V1, 1234, "/session"),
            "http://127.0.0.1:1234/session"
        );
    }

    #[test]
    fn only_v2_needs_auth() {
        // v1 二进制里 OPENCODE_PASSWORD 一次都不出现，给它加认证头没意义
        assert!(Protocol::V2.needs_auth());
        assert!(!Protocol::V1.needs_auth());
    }

    #[test]
    fn routes_differ_in_exactly_three_places() {
        // 探针、发消息、中断——其余路由只差 /api 前缀
        assert_eq!(Protocol::V1.prompt_path(), "prompt_async");
        assert_eq!(Protocol::V2.prompt_path(), "prompt");
        assert_eq!(Protocol::V1.interrupt_path(), "abort");
        assert_eq!(Protocol::V2.interrupt_path(), "interrupt");
        // 探针顺序是探测的关键：过渡期 dev 构建只认 /api/health
        assert_eq!(PROBES[0].0, "/info");
        assert_eq!(PROBES[1].0, "/health");
        assert_eq!(PROBES[2].0, "/global/health");
        assert!(!PROBES[2].1, "v1 那条探针不该带认证");
        assert_eq!(PROBES[2].2, Protocol::V1);
    }

    #[test]
    fn unwrap_is_identity_for_v1() {
        // v1 返回裸数组，v2 套 {data}——这一层差异只该在协议方法里
        let bare = serde_json::json!([{ "id": "ses_1" }]);
        assert_eq!(Protocol::V1.unwrap(bare.clone()), bare);

        let wrapped = serde_json::json!({ "data": [{ "id": "ses_1" }], "cursor": "c" });
        assert_eq!(Protocol::V2.unwrap(wrapped), bare);
    }

    #[test]
    fn split_model_ref_cuts_on_the_first_slash() {
        assert_eq!(
            split_model_ref("codedock/some-model"),
            Some(("codedock", "some-model"))
        );
        // 模型 id 自己带斜杠时，后半段整段都是模型名
        assert_eq!(
            split_model_ref("ollama/meta-llama/Llama-3-8B"),
            Some(("ollama", "meta-llama/Llama-3-8B"))
        );
        assert_eq!(split_model_ref("  codedock / m  "), Some(("codedock", "m")));
        // 切不出两段的一律当没有：宁可不下发，也别把引用的两半搞错
        assert_eq!(split_model_ref("some-model"), None);
        assert_eq!(split_model_ref("/m"), None);
        assert_eq!(split_model_ref("codedock/"), None);
        assert_eq!(split_model_ref("   "), None);
    }

    #[test]
    fn prompt_body_matches_each_generation() {
        // v1 把文本放进 parts[]，v2 直接放顶层 text
        let v1 = prompt_body(Protocol::V1, "你好", Some("codedock/m"), Some("plan"));
        assert_eq!(v1["parts"][0]["type"], "text");
        assert_eq!(v1["parts"][0]["text"], "你好");
        assert!(v1.get("text").is_none());
        assert_eq!(v1["model"]["providerID"], "codedock");
        assert_eq!(v1["model"]["modelID"], "m");
        // v1 靠 body 里的 agent 切 primary agent
        assert_eq!(v1["agent"], "plan");

        let v2 = prompt_body(Protocol::V2, "你好", Some("codedock/m"), Some("plan"));
        assert_eq!(v2["text"], "你好");
        assert!(v2.get("parts").is_none());
        assert_eq!(v2["model"]["modelID"], "m");
        // v2 的 prompt 体不收 agent，硬塞会被静默忽略，切 agent 走 switch_agent
        assert!(v2.get("agent").is_none());

        // 模型 / agent 留空时两代都不带对应字段（交给 opencode 自己的默认）
        assert!(prompt_body(Protocol::V1, "x", None, None)
            .get("model")
            .is_none());
        assert!(prompt_body(Protocol::V1, "x", None, Some("  "))
            .get("agent")
            .is_none());
        assert!(prompt_body(Protocol::V2, "x", Some("   "), None)
            .get("model")
            .is_none());
        // 只有裸模型名（切不出 provider）时也不下发，免得解错提供商
        assert!(prompt_body(Protocol::V2, "x", Some("some-model"), None)
            .get("model")
            .is_none());
    }

    fn provider(id: &str, models: &[&str]) -> ProviderSpec {
        ProviderSpec {
            id: id.to_string(),
            name: id.to_string(),
            base_url: format!("https://{id}.example.com/v1"),
            has_key: true,
            models: models.iter().map(|model| model.to_string()).collect(),
        }
    }

    /// 单测用的最小 AgentConfig：一个提供商一个模型，不带任何扩展内容。
    fn bare_config() -> AgentConfig {
        AgentConfig {
            command: "opencode".to_string(),
            port: 0,
            providers: vec![provider("codedock", &["some-model"])],
            default_model: "codedock/some-model".to_string(),
            // 单测别去碰真实钥匙串：要密钥的用例一律走 .env 覆盖这条路，
            // 它不落盘、也不查凭据库
            dev_api_key: None,
            rules: String::new(),
            memory: String::new(),
            skills: Vec::new(),
            agents: Vec::new(),
            primary: String::new(),
            database: false,
        }
    }

    #[test]
    fn config_materializes_rules_memory_skills_and_agents() {
        let dir = std::env::temp_dir().join(format!("codedock-agent-layer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let mut cfg = bare_config();
        cfg.rules = "始终用中文回答".to_string();
        cfg.memory = "用户偏好极简 UI".to_string();
        cfg.skills = vec![SkillSpec {
            name: "git-release".to_string(),
            description: "整理发布说明".to_string(),
            content: "## 做什么\n- 起草 release notes".to_string(),
        }];
        cfg.agents = vec![AgentSpec {
            name: "reviewer".to_string(),
            description: "只读代码审查".to_string(),
            mode: "subagent".to_string(),
            model: String::new(),
            prompt: "You are a reviewer.".to_string(),
        }];
        cfg.primary = "reviewer".to_string();

        write_config(&dir, &cfg, None, None, None).unwrap();

        // 规则 / 记忆落成文件，并在 instructions 里用绝对路径引用
        assert!(dir.join("rules.md").exists());
        assert!(dir.join("memory.md").exists());
        let text = std::fs::read_to_string(dir.join("opencode.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let instructions = value["instructions"].as_array().unwrap();
        assert_eq!(instructions.len(), 2);
        assert!(instructions
            .iter()
            .any(|v| v.as_str().unwrap().ends_with("rules.md")));

        // 技能写成 <name>/SKILL.md，并把技能目录登记进 skills.paths
        let skill_file = dir.join("skills").join("git-release").join("SKILL.md");
        assert!(skill_file.exists());
        let skill_text = std::fs::read_to_string(&skill_file).unwrap();
        assert!(skill_text.contains("name: \"git-release\""));
        assert!(skill_text.contains("description: \"整理发布说明\""));
        assert!(skill_text.contains("起草 release notes"));
        assert!(value["skills"]["paths"][0]
            .as_str()
            .unwrap()
            .ends_with("skills"));

        // agent 进 map；model 留空则不下发；primary 落成 default_agent
        assert_eq!(value["agent"]["reviewer"]["mode"], "subagent");
        assert_eq!(value["agent"]["reviewer"]["prompt"], "You are a reviewer.");
        assert!(value["agent"]["reviewer"].get("model").is_none());
        assert_eq!(value["default_agent"], "reviewer");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bare_config_writes_no_extension_fields() {
        let dir = std::env::temp_dir().join(format!("codedock-agent-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = bare_config();
        write_config(&dir, &cfg, None, None, None).unwrap();

        let text = std::fs::read_to_string(dir.join("opencode.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        // 没内容时不该写出这些字段，免得给 opencode 一堆空壳
        assert!(value.get("instructions").is_none());
        assert!(value.get("skills").is_none());
        assert!(value.get("agent").is_none());
        assert!(value.get("default_agent").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn database_agent_config_injects_readonly_mcp_and_skill() {
        let dir = std::env::temp_dir().join(format!("codedock-agent-db-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let mut cfg = bare_config();
        cfg.database = true;
        let target = dir.join("target.json");
        write_config(&dir, &cfg, Some(&target), None, None).unwrap();

        let text = std::fs::read_to_string(dir.join("opencode.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        // MCP：本地 stdio，命令是本 exe 的 --mcp-db，环境变量指向 target 文件
        assert_eq!(value["mcp"]["db"]["type"], "local");
        assert_eq!(value["mcp"]["db"]["command"][1], "--mcp-db");
        assert_eq!(
            value["mcp"]["db"]["environment"]["CODEDOCK_DB_TARGET"]
                .as_str()
                .unwrap(),
            target.to_string_lossy()
        );
        // 只读专用 agent 顶掉面板传的 primary；文件 / 命令类工具关掉
        assert_eq!(value["default_agent"], "database");
        assert_eq!(value["agent"]["database"]["mode"], "primary");
        assert_eq!(value["tools"]["bash"], false);
        assert_eq!(value["tools"]["edit"], false);
        // 内置技能落盘，并登记进 skills.paths
        assert!(dir.join("skills").join("db-query").join("SKILL.md").exists());
        assert!(value.get("skills").is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_agent_config_injects_the_app_assistant() {
        let dir = std::env::temp_dir().join(format!("codedock-agent-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let cfg = bare_config();
        let mailbox = dir.join("app-agent");
        write_config(&dir, &cfg, None, Some(&mailbox), None).unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("opencode.json")).unwrap())
                .unwrap();
        // MCP：本地 stdio，命令是本 exe 的 --mcp-app，环境变量指向邮箱目录
        assert_eq!(value["mcp"]["app"]["type"], "local");
        assert_eq!(value["mcp"]["app"]["command"][1], "--mcp-app");
        assert_eq!(
            value["mcp"]["app"]["environment"]["CODEDOCK_APP_MAILBOX"]
                .as_str()
                .unwrap(),
            mailbox.to_string_lossy()
        );
        // 超时要放宽：工具会一直等前端执行 + 用户确认，默认 5s 必然掐断
        assert!(value["mcp"]["app"]["timeout"].as_u64().unwrap() >= 60000);
        // 内置 primary agent + 关掉文件 / 命令类工具（只影响它自己）
        assert_eq!(value["agent"]["app"]["mode"], "primary");
        assert_eq!(value["agent"]["app"]["tools"]["bash"], false);
        assert_eq!(value["agent"]["app"]["tools"]["write"], false);
        // 应用助手存在，但 default_agent 仍听面板传上来的 primary（不是强制切换）
        assert!(value["agent"].get("app").is_some());
        // 内置技能落盘，并登记进 skills.paths
        assert!(dir.join("skills").join("app-control").join("SKILL.md").exists());
        assert!(value.get("skills").is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_names_are_rejected() {
        assert!(validate_name("my-skill").is_ok());
        // 路径分隔符、穿越、大写、连续连字符都不放行
        assert!(validate_name("../evil").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
        assert!(validate_name("MySkill").is_err());
        assert!(validate_name("a--b").is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn render_skill_quotes_frontmatter_values() {
        let skill = SkillSpec {
            name: "probe".to_string(),
            description: "说明: 带冒号和 \"引号\"".to_string(),
            content: "正文".to_string(),
        };
        let text = render_skill(&skill);
        // 值被 JSON 字符串包住，冒号 / 引号不会撑坏 YAML
        assert!(text.starts_with("---\nname: \"probe\"\ndescription: \""));
        assert!(text.contains("\\\"引号\\\""));
        assert!(text.trim_end().ends_with("正文"));
    }

    #[test]
    fn basic_auth_uses_the_fixed_username() {
        // 用户名是 opencode 写死的，只有密码可配；base64("opencode:pw")
        assert_eq!(basic_auth("pw"), "Basic b3BlbmNvZGU6cHc=");
    }

    #[test]
    fn unwrap_data_peels_the_v2_envelope() {
        // 列表：多一个 cursor，只要 data
        let listed = serde_json::json!({ "data": [{"id": "ses_1"}], "cursor": "abc" });
        assert_eq!(unwrap_data(listed), serde_json::json!([{"id": "ses_1"}]));

        // 单个对象
        let one = serde_json::json!({ "data": {"id": "ses_2"} });
        assert_eq!(unwrap_data(one), serde_json::json!({"id": "ses_2"}));

        // 没有 data 就原样返回，别把裸数组也拆坏
        let bare = serde_json::json!([1, 2]);
        assert_eq!(unwrap_data(bare), serde_json::json!([1, 2]));
    }

    #[test]
    fn random_password_is_long_and_varies() {
        let a = random_password();
        let b = random_password();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // 同一个进程里连着要两次也必须不同，否则两个实例会共用一个口令
        assert_ne!(a, b);
    }

    #[test]
    fn child_log_tail_keeps_the_last_lines() {
        let log = Arc::new(Mutex::new(VecDeque::new()));
        {
            let mut buffer = log.lock().unwrap();
            for i in 0..(CHILD_LOG_LINES + 5) {
                if buffer.len() == CHILD_LOG_LINES {
                    buffer.pop_front();
                }
                buffer.push_back(format!("line {i}"));
            }
        }
        let tail = child_log_tail(&log);
        // 只留最后 CHILD_LOG_LINES 行，最老的已经被挤掉
        assert!(!tail.contains("line 0\n"));
        assert!(tail.contains(&format!("line {}", CHILD_LOG_LINES + 4)));
        assert_eq!(tail.lines().count(), CHILD_LOG_LINES);
    }

    #[test]
    fn frame_splits_on_blank_line() {
        let mut buffer = b"data: {\"a\":1}\n\ndata: {\"b\":2}\n\n".to_vec();
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"b\":2}"));
        assert_eq!(pop_frame(&mut buffer), None);
    }

    #[test]
    fn frame_keeps_partial_data_buffered() {
        // 半截帧不能吐出来，否则 JSON 解析必失败
        let mut buffer = b"data: {\"a\"".to_vec();
        assert_eq!(pop_frame(&mut buffer), None);
        buffer.extend_from_slice(b":1}\n\n");
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
    }

    #[test]
    fn frame_accepts_crlf_separator() {
        let mut buffer = b"data: {\"a\":1}\r\n\r\n".to_vec();
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
    }

    #[test]
    fn frame_survives_split_multibyte_char() {
        // 一个汉字被 chunk 边界切成两半时，前半截留在缓冲里、后半截到达后仍能正确解码
        let frame = "data: {\"t\":\"中文😀\"}\n\n";
        let bytes = frame.as_bytes();
        // 切点落在「中」的 UTF-8 三字节中间
        let split = frame.find('中').unwrap() + 1;
        assert!(!frame.is_char_boundary(split));

        let mut buffer = bytes[..split].to_vec();
        assert_eq!(pop_frame(&mut buffer), None);
        buffer.extend_from_slice(&bytes[split..]);
        assert_eq!(
            pop_frame(&mut buffer).as_deref(),
            Some("data: {\"t\":\"中文😀\"}")
        );
    }

    #[test]
    fn frame_reads_data_line_only() {
        // opencode 不发 event: 行，但真有的话也得跳过
        assert_eq!(frame_data("data: {\"x\":1}"), Some("{\"x\":1}"));
        assert_eq!(frame_data("event: ping\ndata: 1"), Some("1"));
        assert_eq!(frame_data(": keep-alive"), None);
    }

    #[test]
    fn config_uses_dynamic_model_key() {
        let dir = std::env::temp_dir().join("codedock-agent-test-config");
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = bare_config();
        write_config(&dir, &cfg, None, None, None).unwrap();

        let text = std::fs::read_to_string(dir.join("opencode.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();

        // 模型名要原样成为 key，不能被 json! 当成字面量 "model"
        assert!(value["provider"]["codedock"]["models"]["some-model"].is_object());
        assert_eq!(value["model"], "codedock/some-model");
        assert_eq!(
            value["provider"]["codedock"]["options"]["baseURL"],
            "https://codedock.example.com/v1"
        );
        // 密钥只能留占位符，绝不能出现在文件里；变量名按 provider id 派生
        assert_eq!(
            value["provider"]["codedock"]["options"]["apiKey"],
            "{env:CODEDOCK_AI_KEY_CODEDOCK}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_writes_every_usable_provider() {
        let dir = std::env::temp_dir().join(format!(
            "codedock-agent-multi-provider-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);

        let mut cfg = bare_config();
        cfg.providers = vec![
            provider("deepseek", &["deepseek-chat", "deepseek-reasoner"]),
            // 本地模型没有密钥，不下发 apiKey 字段
            ProviderSpec {
                has_key: false,
                ..provider("ollama", &["qwen3:8b"])
            },
            // 地址为空 → 不可用，整条丢掉
            ProviderSpec {
                base_url: "  ".to_string(),
                ..provider("broken", &["m"])
            },
            // 模型列表为空 → 同样不可用
            ProviderSpec {
                models: Vec::new(),
                ..provider("nomodels", &[])
            },
        ];
        cfg.default_model = "deepseek/deepseek-reasoner".to_string();
        write_config(&dir, &cfg, None, None, None).unwrap();

        let text = std::fs::read_to_string(dir.join("opencode.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();

        assert_eq!(value["model"], "deepseek/deepseek-reasoner");
        assert!(value["provider"]["deepseek"]["models"]["deepseek-reasoner"].is_object());
        assert!(value["provider"]["ollama"]["models"]["qwen3:8b"].is_object());
        assert!(value["provider"].get("broken").is_none());
        assert!(value["provider"].get("nomodels").is_none());
        // 没有密钥的提供商不该出现 apiKey——空占位符会让 opencode 拿空串去鉴权
        assert!(value["provider"]["ollama"]["options"]
            .get("apiKey")
            .is_none());
        assert_eq!(
            value["provider"]["deepseek"]["options"]["apiKey"],
            "{env:CODEDOCK_AI_KEY_DEEPSEEK}"
        );
        // id 里有连字符时环境变量名要能兜住
        let cfg = AgentConfig {
            providers: vec![provider("my-vendor", &["m"])],
            default_model: "my-vendor/m".to_string(),
            ..cfg
        };
        write_config(&dir, &cfg, None, None, None).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("opencode.json")).unwrap())
                .unwrap();
        assert_eq!(
            value["provider"]["my-vendor"]["options"]["apiKey"],
            "{env:CODEDOCK_AI_KEY_MY_VENDOR}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_model_gets_the_default_provider_prefix() {
        let dir = std::env::temp_dir().join(format!(
            "codedock-agent-model-prefix-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);

        let mut cfg = bare_config();
        cfg.agents = vec![
            // 历史值：裸模型名，要补上默认提供商前缀
            AgentSpec {
                name: "legacy".to_string(),
                description: "d".to_string(),
                mode: "subagent".to_string(),
                model: "some-model".to_string(),
                prompt: String::new(),
            },
            // 已经是全名，原样下发
            AgentSpec {
                name: "explicit".to_string(),
                description: "d".to_string(),
                mode: "subagent".to_string(),
                model: "other/their-model".to_string(),
                prompt: String::new(),
            },
        ];
        write_config(&dir, &cfg, None, None, None).unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("opencode.json")).unwrap())
                .unwrap();
        assert_eq!(value["agent"]["legacy"]["model"], "codedock/some-model");
        assert_eq!(value["agent"]["explicit"]["model"], "other/their-model");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_model_falls_back_within_configured_providers() {
        // 指向的提供商还在，模型名过时了 → 退到该提供商的第一个模型
        let cfg = AgentConfig {
            default_model: "deepseek/gone".to_string(),
            ..bare_config()
        };
        assert_eq!(
            cfg.resolved_default_model().as_deref(),
            Some("codedock/some-model")
        );

        // 指向的提供商整个没了 → 退到第一个可用提供商
        let cfg = AgentConfig {
            default_model: "gone/m".to_string(),
            providers: vec![provider("codedock", &["m"]), provider("deepseek", &["d"])],
            ..bare_config()
        };
        assert_eq!(cfg.resolved_default_model().as_deref(), Some("codedock/m"));

        // 一个可用提供商都没有 → None，调用方据此报「没配提供商」
        let cfg = AgentConfig {
            providers: vec![ProviderSpec {
                base_url: String::new(),
                ..provider("broken", &["m"])
            }],
            ..bare_config()
        };
        assert!(cfg.resolved_default_model().is_none());
    }

    #[test]
    fn secrets_skip_providers_without_keys() {
        // 没有密钥的提供商（本地模型）连钥匙串都不该去碰：这里只给 .env 覆盖值，
        // 一旦实现改成无条件查凭据库，这条用例会去动真实的系统钥匙串
        let cfg = AgentConfig {
            providers: vec![
                ProviderSpec {
                    has_key: false,
                    ..provider("deepseek", &["m"])
                },
                ProviderSpec {
                    has_key: false,
                    ..provider("ollama", &["m"])
                },
            ],
            dev_api_key: Some(("deepseek".to_string(), "sk-dev".to_string())),
            ..bare_config()
        };
        assert_eq!(
            cfg.secrets().unwrap(),
            vec![("CODEDOCK_AI_KEY_DEEPSEEK".to_string(), "sk-dev".to_string())]
        );
    }

    #[test]
    fn dev_overrides_synthesize_a_provider_only_when_none_configured() {
        let overrides = dev::AiOverrides {
            base_url: Some("https://dev.example.com/v1".to_string()),
            model: Some("dev-model".to_string()),
            api_key: Some("sk-dev".to_string()),
        };

        // 界面上一个都没配：合成一个，保住「面板留空、只写 .env」的调试路径
        let mut cfg = AgentConfig {
            providers: Vec::new(),
            default_model: String::new(),
            ..bare_config()
        };
        cfg.apply(&overrides);
        assert_eq!(cfg.default_model, "codedock/dev-model");
        assert_eq!(cfg.providers[0].base_url, "https://dev.example.com/v1");
        assert!(cfg.providers[0].has_key);
        assert_eq!(
            cfg.secrets().unwrap(),
            vec![("CODEDOCK_AI_KEY_CODEDOCK".to_string(), "sk-dev".to_string())]
        );

        // 配了提供商：覆盖打在默认那家上，模型只换模型段
        let mut cfg = bare_config();
        cfg.providers.push(provider("deepseek", &["deepseek-chat"]));
        cfg.apply(&overrides);
        assert_eq!(cfg.default_model, "codedock/dev-model");
        assert_eq!(cfg.providers[0].base_url, "https://dev.example.com/v1");
        assert_eq!(cfg.providers[1].base_url, "https://deepseek.example.com/v1");
        // .env 的密钥只落在默认那家，别家不受影响（它们得各查各的钥匙串条目）
        assert_eq!(
            cfg.secrets().unwrap(),
            vec![("CODEDOCK_AI_KEY_CODEDOCK".to_string(), "sk-dev".to_string())]
        );
    }

    #[test]
    fn default_provider_id_prefers_the_reference_prefix() {
        // 默认模型的提供商前缀为准，认不出来才退到第一个可用项
        let cfg = AgentConfig {
            providers: vec![provider("codedock", &["m"]), provider("deepseek", &["d"])],
            default_model: "deepseek/d".to_string(),
            ..bare_config()
        };
        assert_eq!(cfg.default_provider_id().as_deref(), Some("deepseek"));

        let cfg = AgentConfig {
            default_model: "gone/m".to_string(),
            ..cfg
        };
        assert_eq!(cfg.default_provider_id().as_deref(), Some("codedock"));
    }

    #[test]
    fn path_like_command_must_exist() {
        // 带分隔符的当路径处理，不存在就直接报错，不去 PATH 里瞎找
        let missing = if cfg!(windows) {
            "D:\\nope\\opencode.exe"
        } else {
            "/nope/opencode"
        };
        assert!(resolve_launch(missing, None).is_err());
    }

    #[test]
    fn empty_command_is_rejected() {
        assert!(resolve_launch("   ", None).is_err());
    }

    #[test]
    fn command_lookup_uses_explicit_path() {
        let dir = std::env::temp_dir().join(format!("codedock-agent-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(windows)]
        let executable = dir.join("opencode.cmd");
        #[cfg(not(windows))]
        let executable = dir.join("opencode");
        std::fs::write(&executable, b"placeholder").unwrap();
        let path = std::env::join_paths([dir.as_os_str()]).unwrap();

        assert!(resolve_launch("opencode", Some(path.as_os_str())).is_ok());
        assert!(resolve_launch("missing", Some(path.as_os_str())).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
