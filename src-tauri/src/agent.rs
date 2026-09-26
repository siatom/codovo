//! 智能体后端：把开源的 opencode 当 headless 服务跑起来，供终端区的「智能体」tab 用。
//!
//! 为什么不让前端直接连 opencode：它监听在 localhost 的动态端口上，不会给 WebView 回
//! CORS 头，直连必被拦；而且密钥和网络调用留在 Rust 侧，和 `ai.rs` 的既定做法一致。
//!
//! 进程模型：一个工作区一个 opencode 进程，cwd 就是工作区根。懒启动（用户第一次切到
//! 智能体 tab 才起），换工作区或退出应用时杀掉。

use std::collections::VecDeque;
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

/// SSE 事件推给前端用的事件名。全局只有一个 agent 服务，固定名就够，
/// 不像 PTY 那样每个会话一个 Channel。
pub const EVENT_NAME: &str = "agent-event";
/// 子进程自己退出（崩溃、被杀）时推的事件，前端据此提示重启。
pub const EXIT_EVENT: &str = "agent-exit";

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
/// 注入给 opencode 的密钥环境变量名。密钥不写进配置文件，只走环境变量。
const API_KEY_ENV: &str = "CODEDOCK_AI_API_KEY";
/// opencode v2 要求服务口令，我们自己定一个并通过这个环境变量注入。
/// 不定的话它会随机生成、打到 stdout，我们还得去解析那行输出。
const PASSWORD_ENV: &str = "OPENCODE_PASSWORD";
/// CodeDock 注册给 opencode 的 provider id，配置和发消息时的 model 都要对上。
const PROVIDER_ID: &str = "codedock";

/// Basic 认证的用户名。v2 把它写死了，只有密码是可配的。
const AUTH_USER: &str = "opencode";
/// 留多少行子进程输出。启动失败的原因（端口被占、插件装不上、配置读不了）
/// 只会打在 stdout/stderr 上，v1 时代这两路被 Stdio::null() 丢掉了，
/// 界面上只能看到一句"启动超时"，完全没法排查。
const CHILD_LOG_LINES: usize = 40;

/// 子进程输出的环形缓冲。启动失败时靠它把原因带回给用户。
type ChildLog = Arc<Mutex<VecDeque<String>>>;

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

/// 前端传进来的配置。三个接口字段复用「设置 → AI」里已有的那份；
/// 规则 / 记忆 / 技能 / Agents 是前端把「全局 + 当前项目」两层合并后的生效值。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// opencode 可执行文件；裸命令名会去 PATH 里找
    command: String,
    /// 固定端口；0 表示自动挑一个空闲的
    port: u16,
    base_url: String,
    model: String,
    api_key: String,
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
}

impl AgentConfig {
    /// 同 `ai::AiConfig::apply`：开发调试时让 `src-tauri/.env` 优先。逐字段来，
    /// 只写了一个键的 `.env` 不会把另外两个字段清空。
    fn apply(&mut self, overrides: &dev::AiOverrides) {
        if let Some(base_url) = &overrides.base_url {
            self.base_url = base_url.clone();
        }
        if let Some(model) = &overrides.model {
            self.model = model.clone();
        }
        if let Some(api_key) = &overrides.api_key {
            self.api_key = api_key.clone();
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

/// 发消息的请求体。两代形状不同：
/// v1 把文本塞进 `parts: [{type:"text"}]`，v2 直接放顶层 `text`。
///
/// `model` 必须显式给：不给的话 opencode 会用用户全局配置里的默认模型
/// （本机实测会落到没跑起来的 ollama，然后一路重试到超时）。
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
    let model = model.filter(|m| !m.trim().is_empty());
    let agent = agent.filter(|a| !a.trim().is_empty());
    match protocol {
        Protocol::V1 => {
            let mut body = serde_json::json!({
                "parts": [{ "type": "text", "text": text }],
            });
            if let Some(model) = model {
                body["model"] = serde_json::json!({ "providerID": PROVIDER_ID, "modelID": model });
            }
            if let Some(agent) = agent {
                body["agent"] = serde_json::json!(agent);
            }
            body
        }
        Protocol::V2 => {
            let mut body = serde_json::json!({ "text": text });
            if let Some(model) = model {
                body["model"] = serde_json::json!({ "providerID": PROVIDER_ID, "modelID": model });
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
fn pump_child_log(stream: impl Read + Send + 'static, log: ChildLog) {
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


pub struct AgentState {
    inner: Arc<Mutex<Option<Running>>>,
    generation: Arc<AtomicU64>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(1)),
        }
    }

    /// 应用退出时调用，别留下游离的 opencode 进程。
    pub fn kill(&self) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut running) = guard.take() {
            kill_child(&mut running.child);
            let _ = std::fs::remove_dir_all(&running.config_dir);
        }
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
            format!("在 PATH 里找不到 {trimmed}，请先安装，或在「设置 → AI」里填写完整路径")
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
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("分配端口失败: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("读取端口失败: {e}"))
}

/// 用户指定了固定端口时先探一下，被占了要早点报错，别等健康检查超时。
fn check_port(port: u16) -> Result<u16, String> {
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(port)
        }
        Err(_) => Err(format!(
            "端口 {port} 已被占用，请改成自动分配或换一个端口"
        )),
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
            !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
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
fn write_config(
    dir: &Path,
    base_url: &str,
    model: &str,
    cfg: &AgentConfig,
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
            entry["model"] = serde_json::json!(agent.model.trim());
        }
        agents.insert(name.to_string(), entry);
    }

    // 模型名是用户填的，得当动态 key 用，所以走 Map 而不是 json! 的字面量语法
    let mut models = serde_json::Map::new();
    models.insert(model.to_string(), serde_json::json!({ "name": model }));

    let mut config = serde_json::json!({
        "provider": {
            PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "CodeDock",
                "options": {
                    "baseURL": base_url,
                    // 密钥不落盘：这里只留占位符，spawn 时用环境变量注入
                    "apiKey": format!("{{env:{API_KEY_ENV}}}"),
                },
                "models": models,
            }
        },
        "model": format!("{PROVIDER_ID}/{model}"),
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
    api_key: &str,
    password: &str,
) -> Result<(Child, ChildLog), String> {
    let port_text = port.to_string();
    let args = ["serve", "--port", port_text.as_str(), "--hostname", "127.0.0.1"];
    let path = crate::shell_env::resolved_path(
        &crate::shell_env::default_shell(),
        Some(cwd),
    );

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
    cmd.current_dir(cwd)
        .env("OPENCODE_CONFIG_DIR", config_dir)
        .env(API_KEY_ENV, api_key)
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
        format!("启动 opencode 失败: {e}。请确认已安装，或在「设置 → AI」里填写完整路径")
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
fn kill_child(child: &mut Child) {
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
fn kill_child(child: &mut Child) {
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
fn current_endpoint(state: &AgentState) -> Result<(Protocol, u16, String), String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
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

    serde_json::from_str(&text)
        .map_err(|_| format!("无法解析 opencode 响应: {}", truncate(&text, MAX_ERROR_CHARS)))
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
                        outcomes[index].detail = "200 但不是 JSON（多半是前端页面兜底）".to_string();
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
/// 只按字节找 `\n`，切点一定落在 ASCII 边界上，不会把多字节字符劈开。
fn pop_frame(buffer: &mut String) -> Option<String> {
    let bytes = buffer.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            // 空行才算分隔：`\n\n` 或 `\n\r\n`
            let rest = &bytes[i + 1..];
            let skip = if rest.first() == Some(&b'\n') {
                1
            } else if rest.starts_with(b"\r\n") {
                2
            } else {
                0
            };
            if skip > 0 {
                let mut frame = buffer[..i].to_string();
                // CRLF 时行尾的 \r 是分隔符的一部分，不是内容
                if frame.ends_with('\r') {
                    frame.pop();
                }
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
                let mut buffer = String::new();
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) => {
                            buffer.push_str(&String::from_utf8_lossy(&chunk));
                            while let Some(frame) = pop_frame(&mut buffer) {
                                let Some(data) = frame_data(&frame) else { continue };
                                if let Ok(value) = serde_json::from_str::<serde_json::Value>(data)
                                {
                                    let _ = app.emit(EVENT_NAME, value);
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
            let _ = app.emit(EXIT_EVENT, code);
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

/// 启动智能体服务。幂等：同一个工作区已经在跑就直接返回现有信息。
#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: tauri::State<'_, AgentState>,
    fs_state: tauri::State<'_, FsState>,
    config: AgentConfig,
) -> Result<AgentInfo, String> {
    // 覆盖要赶在下面判空之前：面板留空、只写 .env 时也得能起
    let mut config = config;
    config.apply(&dev::read_overrides());
    let base_url = config.base_url.trim().trim_end_matches('/').to_string();
    let api_key = config.api_key.trim().to_string();
    let model = config.model.trim().to_string();
    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err(if cfg!(debug_assertions) {
            "请先在「设置 → AI」里填写接口地址、模型和密钥，或写进 src-tauri/.env".to_string()
        } else {
            "请先在「设置 → AI」里填写接口地址、模型和密钥".to_string()
        });
    }

    // git / 文件系统都是同步阻塞的，赶在第一个 await 之前跑完，别让 std 的锁跨越 await
    let cwd = fs_state.root()?;

    let (port, generation) = {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;

        // 同一个工作区已经在跑：直接复用，不重启
        if let Some(running) = guard.as_ref() {
            if running.cwd == cwd {
                return Ok(AgentInfo {
                    port: running.port,
                    version: String::new(),
                    protocol: running.protocol.label().to_string(),
                });
            }
        }

        // 工作区变了（或之前跑挂了），先收掉旧的
        state.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut old) = guard.take() {
            kill_child(&mut old.child);
            let _ = std::fs::remove_dir_all(&old.config_dir);
        }

        let port = if config.port == 0 {
            free_port()?
        } else {
            check_port(config.port)?
        };

        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("拿不到配置目录: {e}"))?
            .join("opencode");
        write_config(&config_dir, &base_url, &model, &config)?;

        let password = random_password();
        let (child, log) = spawn_opencode(
            &config.command,
            port,
            &cwd,
            &config_dir,
            &api_key,
            &password,
        )?;
        let generation = state.generation.load(Ordering::SeqCst);

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

        (port, generation)
    };

    // 探测是异步的，放在锁外面
    let (password, log) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(running) => (running.password.clone(), Arc::clone(&running.log)),
            None => return Err("智能体服务没起来".to_string()),
        }
    };

    let (protocol, version) =
        match detect_protocol(port, &password, &log, HEALTH_TIMEOUT).await {
            Ok(found) => found,
            Err(reason) => {
                state.kill();
                return Err(reason);
            }
        };

    // 探测结果落回状态里：后面每个命令都按它选路由
    {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        match guard.as_mut() {
            Some(running) => running.protocol = protocol,
            None => return Err("智能体服务没起来".to_string()),
        }
    }

    spawn_sse(
        app.clone(),
        state.inner.clone(),
        protocol,
        port,
        password,
        generation,
    );
    spawn_exit_watcher(
        app,
        state.inner.clone(),
        state.generation.clone(),
        port,
    );

    Ok(AgentInfo {
        port,
        version,
        protocol: protocol.label().to_string(),
    })
}

#[tauri::command]
pub fn agent_status(state: tauri::State<'_, AgentState>) -> AgentStatus {
    let port = state
        .inner
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|running| running.port));
    AgentStatus {
        running: port.is_some(),
        port,
    }
}

/// 停掉服务。换工作区和退出应用时都要调。
#[tauri::command]
pub fn agent_stop(state: tauri::State<'_, AgentState>) {
    state.kill();
}

/// 建一个会话。v2 把返回包在 `{data: ...}` 里，拆掉再给前端——
/// 前端只认 `{id}` 这一层。
#[tauri::command]
pub async fn agent_create_session(
    state: tauri::State<'_, AgentState>,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    let (protocol, port, password) = current_endpoint(&state)?;
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
    session_id: String,
) -> Result<serde_json::Value, String> {
    let (protocol, port, password) = current_endpoint(&state)?;
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

/// 列出所有会话。opencode 那边是全局存的、跨项目混在一起，调用方自己按 directory 过滤。
///
/// v2 是游标分页（`{data, cursor}`），这里只取第一页、丢掉 cursor——界面上本来就
/// 只列最近一批，为此引入分页状态不划算。
#[tauri::command]
pub async fn agent_list_sessions(
    state: tauri::State<'_, AgentState>,
) -> Result<serde_json::Value, String> {
    let (protocol, port, password) = current_endpoint(&state)?;
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
    session_id: String,
    text: String,
    model: Option<String>,
    agent: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".to_string());
    }

    let (protocol, port, password) = current_endpoint(&state)?;
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
    session_id: String,
) -> Result<(), String> {
    let (protocol, port, password) = current_endpoint(&state)?;
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
    session_id: String,
) -> Result<(), String> {
    let (protocol, port, password) = current_endpoint(&state)?;
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
    session_id: String,
    title: String,
) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("会话标题不能为空".to_string());
    }

    let (protocol, port, password) = current_endpoint(&state)?;
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
    fn prompt_body_matches_each_generation() {
        // v1 把文本放进 parts[]，v2 直接放顶层 text
        let v1 = prompt_body(Protocol::V1, "你好", Some("m"), Some("plan"));
        assert_eq!(v1["parts"][0]["type"], "text");
        assert_eq!(v1["parts"][0]["text"], "你好");
        assert!(v1.get("text").is_none());
        assert_eq!(v1["model"]["modelID"], "m");
        assert_eq!(v1["model"]["providerID"], PROVIDER_ID);
        // v1 靠 body 里的 agent 切 primary agent
        assert_eq!(v1["agent"], "plan");

        let v2 = prompt_body(Protocol::V2, "你好", Some("m"), Some("plan"));
        assert_eq!(v2["text"], "你好");
        assert!(v2.get("parts").is_none());
        assert_eq!(v2["model"]["modelID"], "m");
        // v2 的 prompt 体不收 agent，硬塞会被静默忽略，切 agent 走 switch_agent
        assert!(v2.get("agent").is_none());

        // 模型 / agent 留空时两代都不带对应字段（交给 opencode 自己的默认）
        assert!(prompt_body(Protocol::V1, "x", None, None).get("model").is_none());
        assert!(prompt_body(Protocol::V1, "x", None, Some("  "))
            .get("agent")
            .is_none());
        assert!(prompt_body(Protocol::V2, "x", Some("   "), None)
            .get("model")
            .is_none());
    }

    /// 单测用的最小 AgentConfig：默认不带任何扩展内容。
    fn bare_config() -> AgentConfig {
        AgentConfig {
            command: "opencode".to_string(),
            port: 0,
            base_url: "https://api.example.com/v1".to_string(),
            model: "some-model".to_string(),
            api_key: "sk-test".to_string(),
            rules: String::new(),
            memory: String::new(),
            skills: Vec::new(),
            agents: Vec::new(),
            primary: String::new(),
        }
    }

    #[test]
    fn config_materializes_rules_memory_skills_and_agents() {
        let dir = std::env::temp_dir().join(format!(
            "codedock-agent-layer-{}",
            std::process::id()
        ));
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

        write_config(&dir, &cfg.base_url, &cfg.model, &cfg).unwrap();

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
        let dir = std::env::temp_dir().join(format!(
            "codedock-agent-bare-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = bare_config();
        write_config(&dir, &cfg.base_url, &cfg.model, &cfg).unwrap();

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
        let mut buffer = String::from("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"b\":2}"));
        assert_eq!(pop_frame(&mut buffer), None);
    }

    #[test]
    fn frame_keeps_partial_data_buffered() {
        // 半截帧不能吐出来，否则 JSON 解析必失败
        let mut buffer = String::from("data: {\"a\"");
        assert_eq!(pop_frame(&mut buffer), None);
        buffer.push_str(":1}\n\n");
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
    }

    #[test]
    fn frame_accepts_crlf_separator() {
        let mut buffer = String::from("data: {\"a\":1}\r\n\r\n");
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
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
        write_config(&dir, "https://api.example.com/v1", "some-model", &cfg).unwrap();

        let text = std::fs::read_to_string(dir.join("opencode.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();

        // 模型名要原样成为 key，不能被 json! 当成字面量 "model"
        assert!(value["provider"]["codedock"]["models"]["some-model"].is_object());
        assert_eq!(value["model"], "codedock/some-model");
        assert_eq!(
            value["provider"]["codedock"]["options"]["baseURL"],
            "https://api.example.com/v1"
        );
        // 密钥只能留占位符，绝不能出现在文件里
        assert_eq!(
            value["provider"]["codedock"]["options"]["apiKey"],
            "{env:CODEDOCK_AI_API_KEY}"
        );

        let _ = std::fs::remove_dir_all(&dir);
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
