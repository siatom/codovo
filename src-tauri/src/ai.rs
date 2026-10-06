use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::dev;
use crate::fs_api::FsState;
use crate::git::{self, DiffSource};

/// 单次喂给模型的 diff 上限（按字符算，不是字节）。常见的输入窗口足够放下
/// 这个量级，再大只是把 token 烧在无关的大文件上。
const MAX_DIFF_CHARS: usize = 24_000;

/// 单次喂给模型的整个文件内容的字符上限。和 diff 同量级：文件比 diff 更容易超，
/// 但截掉后面一截总好过把 token 全烧在一个超大文件上。
const MAX_FILE_CHARS: usize = 24_000;

/// 接口冷启动 + 大模型首包可能很慢，给足时间；超时只作废这一次生成。
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// 出错时回传给界面的响应体片段上限，别把整段 HTML 错误页塞进面板。
const MAX_ERROR_CHARS: usize = 500;

/// 系统提示写死在这里：产物只有一条提交信息，让模型自由发挥没有好处。
/// 模板是固定的 Conventional Commits 格式，`<body>` / `<footer>` 没内容时
/// 连同前面的空行一起省略——留空的段落比没有更糟。
const SYSTEM_PROMPT: &str = "\
你是 Git 提交信息助手，根据用户提供的暂存区改动写一条提交信息。
必须严格使用下面的模板，不要增删结构：

<type>(<scope>): <subject>

<body>

<footer>

规则：
1. 只输出提交信息本身，不要任何解释、前言、代码块围栏或引号。
2. <type> 从这些里选一个：feat（新功能）、fix（修 bug）、docs（文档）、style（格式）、refactor（重构）、perf（性能）、test（测试）、build（构建/依赖）、ci（CI）、chore（杂项）、revert（回滚）。
3. <scope> 是受影响的模块或目录名；实在无法归类时连同括号一起省略，写成 `type: subject`。
4. <subject> 一句话概括，不超过 50 个字符，用祈使句，结尾不加句号。
5. <body> 务必精简，只写改了什么、为什么改，不写「本次提交」「我们」这类废话。改动涉及多个点时按改动点归类、每个点单独一行并以 `- ` 开头分条列出，一条一句话、不展开细节；只有一个改动点就写成一句话。不要按文件逐个罗列。每行不超过 72 个字符。改动很小时整段连同它前面的空行一起省略。
6. <footer> 放 BREAKING CHANGE 等不兼容变更说明；没有就整段连同它前面的空行一起省略。
7. 语言跟「最近提交」保持一致；没有历史提交时用中文。
8. 不要编造改动里没有的内容。";

/// 前端传来的接口配置。密钥不在这里——前端只知道「哪家提供商」，正文由后端按
/// provider id 去系统钥匙串取（见 `secrets.rs`）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// OpenAI 兼容接口的基地址，例如 https://api.deepseek.com/v1
    base_url: String,
    /// 默认模型所在的提供商 id，密钥按它去钥匙串里查
    provider_id: String,
    model: String,
    /// 开发调试用：`src-tauri/.env` 里那个密钥。前端传不进来，只在 debug 构建里
    /// 由 `apply` 填上；它优先于钥匙串——`.env` 本来就该盖住界面上的配置。
    #[serde(skip)]
    dev_api_key: Option<String>,
}

impl AiConfig {
    /// 开发调试时用 `src-tauri/.env` 里的值盖掉前端传来的值。逐字段来：只写了一个键
    /// 的 `.env` 不会把另外两个字段清空。
    fn apply(&mut self, overrides: &dev::AiOverrides) {
        if let Some(base_url) = &overrides.base_url {
            self.base_url = base_url.clone();
        }
        if let Some(model) = &overrides.model {
            self.model = model.clone();
        }
        if let Some(api_key) = &overrides.api_key {
            self.dev_api_key = Some(api_key.clone());
        }
    }

    /// 拼出生效的 (基地址, 密钥, 模型)。缺哪样就报哪样——用户知道该去哪儿补。
    ///
    /// 读钥匙串是同步阻塞的，所以这个方法**必须在第一个 await 之前调用**，
    /// 别把系统调用夹在异步中间（和 git 那边一个道理）。
    fn resolve(&self) -> Result<(String, String, String), String> {
        let base_url = self.base_url.trim().trim_end_matches('/').to_string();
        let model = self.model.trim().to_string();
        if base_url.is_empty() || model.is_empty() {
            // 开发调试版可以只写 src-tauri/.env，提示里带上这条，免得以为没救
            return Err(if cfg!(debug_assertions) {
                "请先在「设置 → 智能体 → 模型提供商」里填写接口地址和模型，或写进 src-tauri/.env"
                    .to_string()
            } else {
                "请先在「设置 → 智能体 → 模型提供商」里填写接口地址和模型".to_string()
            });
        }

        let api_key = match &self.dev_api_key {
            Some(key) => key.clone(),
            None => crate::secrets::get(&self.provider_id)?.unwrap_or_default(),
        };
        if api_key.trim().is_empty() {
            return Err(format!(
                "提供商「{}」还没保存 API 密钥，请在「设置 → 智能体 → 模型提供商」里填一个",
                self.provider_id
            ));
        }
        Ok((base_url, api_key.trim().to_string(), model))
    }
}

/// 发一次 chat completions，返回模型输出的原文（不做任何后处理）。
///
/// 只走 Rust 侧的 HTTP：密钥不进 WebView，也不受各厂商的跨域限制。
/// 两个功能（生成提交信息 / 解读改动）共用，调用方自己拼提示词、自己清理输出。
async fn chat(
    config: &AiConfig,
    system: &str,
    user: &str,
    temperature: f32,
) -> Result<String, String> {
    let (base_url, api_key, model) = config.resolve()?;

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "temperature": temperature,
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|reason| format!("无法创建 HTTP 客户端: {reason}"))?;

    let response = client
        .post(format!("{base_url}/chat/completions"))
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|reason| format!("请求大模型失败: {reason}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|reason| format!("读取大模型响应失败: {reason}"))?;

    if !status.is_success() {
        // 厂商的报错（配额、鉴权、模型名写错）都在 body 里，整段透传比只看状态码有用
        return Err(format!(
            "大模型返回 {code}: {detail}",
            code = status.as_u16(),
            detail = truncate(&text, MAX_ERROR_CHARS),
        ));
    }

    // 不定义严格的响应结构体：换一家接口少一层字段就可能反序列化失败，
    // 用 Value 逐层取更耐操，取不到时把原文片段带出来方便排查
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("无法解析大模型响应: {}", truncate(&text, MAX_ERROR_CHARS)))?;
    let content = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .ok_or_else(|| {
            format!(
                "大模型响应里没有消息内容: {}",
                truncate(&text, MAX_ERROR_CHARS)
            )
        })?;

    Ok(content.to_string())
}

/// 让大模型根据当前仓库的暂存区改动生成一条提交信息。
#[tauri::command]
pub async fn ai_generate_commit_message(
    state: tauri::State<'_, FsState>,
    root: String,
    config: AiConfig,
) -> Result<String, String> {
    // 覆盖要赶在 resolve() 之前：面板留空、只写 .env 时也得能跑
    let mut config = config;
    config.apply(&dev::read_overrides());
    // 先挡一道：配置不全时不必去读 diff。顺带把钥匙串那一次读也挪到
    // 第一个 await 之前——它是同步阻塞的
    config.resolve()?;

    // git 是同步阻塞的，赶在第一个 await 之前跑完，别让 std 的锁跨越 await 点
    let context = git::commit_context(&state.checked_root(&root)?)?;
    if context.diff.trim().is_empty() {
        return Err("暂存区没有可生成的改动".to_string());
    }

    let (system, user) = build_prompt(&context);
    // 低温度：提交信息要稳、可复现，不需要发挥
    let raw = chat(&config, &system, &user, 0.3).await?;

    let message = clean_message(&raw);
    if message.is_empty() {
        return Err("大模型返回了空的提交信息".to_string());
    }
    Ok(message)
}

/// 让大模型解释一个文件。产物是 markdown 正文，直接交给界面渲染，所以
/// **不做** clean_message 那套去围栏处理——代码块本来就要留着。
///
/// `source` 决定看什么：给了就解释那次改动（diff），传 `null` 就解释整个文件
/// 的职责与实现逻辑（只读、不依赖 git，非仓库里也能用）。两种解读共用同一个
/// 命令与 HTTP/错误处理，只是喂给模型的正文和 system 提示不同。
#[tauri::command]
pub async fn ai_explain_change(
    state: tauri::State<'_, FsState>,
    root: String,
    config: AiConfig,
    path: String,
    source: Option<git::DiffSource>,
) -> Result<String, String> {
    // 同 ai_generate_commit_message：覆盖必须早于 resolve()，钥匙串那次同步读也赶在 await 之前
    let mut config = config;
    config.apply(&dev::read_overrides());
    config.resolve()?;

    // 同 ai_generate_commit_message：git / 读文件是同步阻塞的，先跑完再 await
    let root = state.checked_root(&root)?;
    let (system, user) = match &source {
        Some(source) => {
            let diff = git::file_diff_text(&root, &path, source)?;
            if diff.trim().is_empty() {
                return Err("这个文件没有可解读的改动".to_string());
            }
            build_explain_prompt(&root, &path, source, &diff)
        }
        None => {
            // 沙箱校验、大小上限、二进制判定都在 read_text_file 里
            let content = crate::fs_api::read_text_file(&root, &path)?;
            if content.trim().is_empty() {
                return Err("这个文件是空的".to_string());
            }
            // 显示用工作区相对路径：绝对路径那串前缀在提示里只是噪音
            let display = Path::new(&path)
                .strip_prefix(&root)
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.clone());
            build_file_prompt(&display, &content)
        }
    };
    // 解释要按事实说，温度低一点免得编出 diff / 文件里没有的行为
    let raw = chat(&config, &system, &user, 0.2).await?;

    let text = raw.trim().to_string();
    if text.is_empty() {
        return Err("大模型返回了空的解读".to_string());
    }
    Ok(text)
}

/// 解读改动的系统提示。产物要直接渲染成 markdown 给用户看，所以按固定结构
/// 输出，省得模型自由发挥时把结论埋在废话里。
const EXPLAIN_SYSTEM_PROMPT: &str = "\
你是代码审查助手，负责解释一次改动的 diff 到底改了什么。

按下面的结构输出 markdown，不要加额外的前言、结尾或代码围栏：
1. 第一行一句话说清这次改动的目的。
2. 然后用无序列表分点列出具体改了什么。提到函数名、字段名、配置项时用反引号包起来。
3. 如果发现了值得注意的地方（破坏性变更、边界情况、可能的 bug），另起一段以「注意：」开头列出；没有就不写这段。

规则：
1. 用中文，直接讲改动内容和它的影响，不要复述 diff 原文，也不要贴大段代码。
2. 只依据 diff 里看得到的事实，推断不出来的一律不提。
3. 整篇控制在 300 字以内，不写「本次改动」「我们」这类空话。";

/// 拼解读用的 system / user 两条消息。单独抽出来是为了能直接跑单测。
fn build_explain_prompt(
    root: &Path,
    path: &str,
    source: &DiffSource,
    diff: &str,
) -> (String, String) {
    // 显示用工作区相对路径：绝对路径那串前缀在提示里只是噪音
    let display = Path::new(path)
        .strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string());

    // 交代清楚跟谁比，否则模型分不清哪些行是新增、哪些是原有代码
    let origin = match source {
        DiffSource::Unstaged => "未暂存的改动（暂存区 → 工作区）".to_string(),
        DiffSource::Staged => "已暂存的改动（HEAD → 暂存区）".to_string(),
        // rev 已经过 checked_rev 校验，全是十六进制，按字节切安全
        DiffSource::Commit { rev } => format!("提交 {} 中的改动", &rev[..rev.len().min(7)]),
    };

    let mut user = format!("文件：{display}\n改动来源：{origin}\n\n改动 diff：\n");
    user.push_str(&truncate(diff, MAX_DIFF_CHARS));
    if diff.chars().count() > MAX_DIFF_CHARS {
        // 告诉模型改动被截过，免得它以为改动就这么多、漏掉后面的部分
        user.push_str("\n…（改动过大，此处已截断）");
    }

    (EXPLAIN_SYSTEM_PROMPT.to_string(), user)
}

/// 解析整个文件的系统提示。同样按固定结构输出 markdown，省得模型自由发挥时
/// 把结论埋在废话里。
const FILE_SYSTEM_PROMPT: &str = "\
你是代码解析助手，负责说明一个文件的职责和它的实现逻辑。

按下面的结构输出 markdown，不要加额外的前言、结尾或代码围栏：
1. 第一行一句话说清这个文件是做什么的。
2. 然后用一段话讲它的实现逻辑：关键的函数、类型、数据流。提到标识符时用反引号包起来。
3. 如果发现了值得注意的地方（对外入口、副作用、外部依赖、边界情况），另起一段以「注意：」开头列出；没有就不写这段。

规则：
1. 用中文，直接讲文件做什么和怎么做的，不要复述原文，也不要贴大段代码。
2. 只依据文件内容里看得到的事实，推断不出来的一律不提。
3. 整篇控制在 500 字以内，不写「本文件」「我们」这类空话。";

/// 拼解析文件用的 system / user 两条消息。单独抽出来是为了能直接跑单测。
fn build_file_prompt(display: &str, content: &str) -> (String, String) {
    let mut user = format!("文件：{display}\n\n文件内容：\n");
    user.push_str(&truncate(content, MAX_FILE_CHARS));
    if content.chars().count() > MAX_FILE_CHARS {
        // 告诉模型文件被截过，免得它以为文件就这么长、漏掉后面的部分
        user.push_str("\n…（文件过大，此处已截断）");
    }

    (FILE_SYSTEM_PROMPT.to_string(), user)
}

/// 起草反馈正文时，喂给模型的仓库文件清单最多列多少条。
/// 清单只用来让模型挑相关文件，列太多纯属烧 token。
const MAX_TREE_ENTRIES: usize = 400;

/// 让模型挑相关文件时最多挑几个。
const MAX_CONTEXT_FILES: usize = 8;

/// 单个相关文件喂给模型的字符上限。
const MAX_CONTEXT_FILE_CHARS: usize = 4_000;

/// 所有相关文件合起来的字符上限。
const MAX_CONTEXT_CHARS: usize = 20_000;

/// 分类值 → 中文名。和前端 `CATEGORIES` 对齐；认不出的值原样带过去。
fn category_label(category: &str) -> &str {
    match category {
        "bug" => "缺陷",
        "feature" => "建议",
        "other" => "其他",
        other => other,
    }
}

/// 列一份工作区内的文件清单（相对路径、正斜杠），供模型挑相关文件。
/// 返回 (清单, 是否被上限截断)。
fn repo_files(root: &Path) -> (Vec<String>, bool) {
    let mut files: Vec<String> = Vec::new();
    let complete = crate::fs_api::walk_files(root, &mut |path| {
        if files.len() >= MAX_TREE_ENTRIES {
            return false;
        }
        files.push(
            path.strip_prefix(root)
                .map(|rest| rest.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/")),
        );
        true
    });
    // 遍历顺序取决于目录项的返回顺序，排一下让同样的仓库给出同样的清单
    files.sort();
    (files, !complete)
}

/// 把模型给的一行折算成清单里真实存在的路径。
///
/// 模型常给路径加上序号、反引号、行号或一句说明，所以先做宽松的精确匹配，
/// 再退一步取「这一行包含的、最长的那个已知路径」。认不出来就返回 None——
/// 宁可少读一个文件，也不能拿编出来的路径去读盘。
fn match_known(line: &str, known: &[String]) -> Option<String> {
    let trimmed = line.trim().trim_start_matches(|c: char| {
        c == '-' || c == '*' || c == '`' || c == '"' || c == '.' || c == ' ' || c.is_ascii_digit()
    });
    let candidate = trimmed.trim_matches('`').trim_matches('"').trim();
    if let Some(hit) = known.iter().find(|path| path.as_str() == candidate) {
        return Some(hit.clone());
    }
    known
        .iter()
        .filter(|path| candidate.contains(path.as_str()))
        .max_by_key(|path| path.len())
        .cloned()
}

/// 解析模型挑出来的文件清单，只保留清单里真实存在的路径。
fn parse_selected_files(raw: &str, known: &[String]) -> Vec<String> {
    let mut picked: Vec<String> = Vec::new();
    for line in raw.lines() {
        if picked.len() >= MAX_CONTEXT_FILES {
            break;
        }
        let Some(path) = match_known(line, known) else {
            continue;
        };
        if !picked.contains(&path) {
            picked.push(path);
        }
    }
    picked
}

/// 把挑中的文件读成一段可喂给模型的正文。读不了的文件（太大 / 二进制 / 不存在）
/// 直接跳过——为一个大文件让整次生成失败不值得。
fn read_context_files(root: &Path, files: &[String]) -> String {
    let mut out = String::new();
    let mut budget = MAX_CONTEXT_CHARS;
    for relative in files {
        // 沙箱校验、大小上限、二进制判定都在 read_text_file 里
        let Ok(content) = crate::fs_api::read_text_file(root, relative) else {
            continue;
        };
        let block = format!("--- {relative} ---\n{}\n\n", truncate(&content, MAX_CONTEXT_FILE_CHARS));
        let cost = block.chars().count();
        if cost > budget {
            break;
        }
        budget -= cost;
        out.push_str(&block);
    }
    out
}

/// 第一趟用的 system 提示：只挑文件，不要正文。
const PICK_FILES_PROMPT: &str = "\
你要为起草一条 issue 挑出需要参考的仓库文件。
用户会给一条线索和仓库的文件清单，你挑出与线索最相关的文件。
规则：
1. 只输出文件路径，每行一个，必须和清单里的写法完全一致。
2. 按相关度从高到低排列，最多 8 个。
3. 一个相关的都没有时，只输出「无」。
4. 不要输出解释、序号、行号或任何其它文字。";

/// 第二趟用的 system 提示：结构照仓库里的 `.codebuddy/commands/gitee-issue-add.md`——
/// 只写有内容的小节，判断必须落在真实代码上。
const FEEDBACK_PROMPT: &str = "\
你是 Gitee issue 起草助手，负责把用户给的线索写成本仓库一条 issue 的「详细描述」。

严格按下面的 markdown 结构输出，只写有内容的小节，没有的整节省略，不要加前言、结尾或代码围栏：

## 背景

当前行为是什么、为什么需要改（引用相关文件路径，必要时带行号）。

## 期望

改完之后应该是什么样，写成可验收的行为描述。

## 实现要点

（可选）排查到的落点：相关文件、已知坑、跨平台差异、需要同步改的地方。

## 验收

怎么验证这条做完了（跑什么命令、界面怎么点）。

规则：
1. 用中文。判断和结论必须基于给出的代码，不许凭印象编；引用了文件就带路径。
2. 代码里看不出实现落点时就省略「实现要点」，不要编造。
3. 不要重复标题，不写「本次」「我们」这类空话。
4. 只输出正文本身，不要输出标题行。";

/// 拼第一趟（挑文件）的 system / user 两条消息。
fn build_pick_prompt(title: &str, category: &str, tree: &str, truncated: bool) -> (String, String) {
    let mut user = format!(
        "线索：{title}\n类型：{}\n\n仓库文件清单：\n{tree}",
        category_label(category)
    );
    if truncated {
        // 告诉模型清单被截过，免得它以为仓库就这么大
        user.push_str("\n…（文件过多，此处只列了一部分）");
    }
    (PICK_FILES_PROMPT.to_string(), user)
}

/// 拼第二趟（写正文）的 system / user 两条消息。
fn build_feedback_prompt(title: &str, category: &str, context: &str) -> (String, String) {
    let mut user = format!("线索（标题）：{title}\n类型：{}\n\n", category_label(category));
    if context.trim().is_empty() {
        user.push_str("（没能取到相关文件内容，只能依据线索本身来写）");
    } else {
        user.push_str("相关文件内容：\n");
        user.push_str(context);
    }
    (FEEDBACK_PROMPT.to_string(), user)
}

/// 让大模型根据标题（线索）和当前工作区的代码，写一条反馈的「详细描述」。
///
/// 分两趟：先从文件清单里挑出相关文件，再把它们的内容喂进去起草正文。
/// 单趟做不到「结合代码现状」——线索是自然语言，没法直接当关键词去搜文件。
#[tauri::command]
pub async fn ai_generate_feedback_body(
    state: tauri::State<'_, FsState>,
    root: String,
    config: AiConfig,
    title: String,
    category: String,
) -> Result<String, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("请先填个标题，生成时拿它当线索".to_string());
    }

    // 覆盖要赶在 resolve() 之前；钥匙串那次同步读也在第一个 await 之前
    let mut config = config;
    config.apply(&dev::read_overrides());
    config.resolve()?;

    // 遍历工作区是同步阻塞的，先跑完再 await
    let root = state.checked_root(&root)?;
    let (files, truncated) = repo_files(&root);
    if files.is_empty() {
        return Err("这个工作区里没有可参考的文件".to_string());
    }

    // 第一趟：挑相关文件。温度给低——挑文件不需要发挥
    let (pick_system, pick_user) = build_pick_prompt(&title, &category, &files.join("\n"), truncated);
    let picked_raw = chat(&config, &pick_system, &pick_user, 0.1).await?;
    let picked = parse_selected_files(&picked_raw, &files);

    // 第二趟：读文件、起草正文
    let context = read_context_files(&root, &picked);
    let (system, user) = build_feedback_prompt(&title, &category, &context);
    let raw = chat(&config, &system, &user, 0.3).await?;

    let text = raw.trim().to_string();
    if text.is_empty() {
        return Err("大模型返回了空的内容".to_string());
    }
    Ok(text)
}

/// 拼 system / user 两条消息。单独抽出来是为了能直接跑单测。
fn build_prompt(context: &git::CommitContext) -> (String, String) {
    let mut user = String::new();
    match &context.branch {
        Some(branch) => user.push_str(&format!("当前分支：{branch}\n")),
        None => user.push_str("当前分支：未知（游离 HEAD 或空仓库）\n"),
    }

    if context.recent_subjects.is_empty() {
        user.push_str("最近提交：无（这是仓库的第一次提交）\n");
    } else {
        user.push_str("最近提交（供措辞参考）：\n");
        for subject in &context.recent_subjects {
            user.push_str(&format!("- {subject}\n"));
        }
    }

    user.push_str("\n暂存区改动：\n");
    user.push_str(&truncate(&context.diff, MAX_DIFF_CHARS));
    if context.diff.chars().count() > MAX_DIFF_CHARS {
        // 告诉模型改动被截过，免得它以为改动就这么多、漏掉后面的部分
        user.push_str("\n…（改动过大，此处已截断）");
    }

    (SYSTEM_PROMPT.to_string(), user)
}

/// 按字符截断。按字节切会把多字节字符劈成两半，`String` 直接构造失败。
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

/// 清理模型输出。有些模型会用 ``` 围栏或引号把提交信息包起来，
/// 直接写进提交框会带上这些多余字符。
fn clean_message(raw: &str) -> String {
    let mut text = raw.trim();

    // 剥代码块围栏：只认首尾成对的，中间正文原样保留
    if let Some(rest) = text.strip_prefix("```") {
        // 围栏后面紧跟的那一行是语言标识（```text），跳过
        let body = rest.split_once('\n').map(|(_, body)| body).unwrap_or(rest);
        if let Some(inner) = body.trim_end().strip_suffix("```") {
            text = inner.trim();
        }
    }

    // 整体被引号包住时也剥掉。只认 ASCII 引号，且首尾都得是同一个，
    // 免得误伤正文里本来就有的引号
    let bytes = text.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        text = &text[1..text.len() - 1];
    }

    text.trim().to_string()
}

/// 连接测试的探针超时。比正式生成短：用户点一下就在等结果，不该干等一分钟。
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// 把请求阶段的失败翻译成人话。厂商的报错在有响应时走 `describe_status`，
/// 这里只管根本没拿到响应那几种。
fn describe_request_error(reason: reqwest::Error) -> String {
    if reason.is_timeout() {
        return "连接超时：接口没在预期时间内响应，检查地址是否正确、是否需要代理".to_string();
    }
    if reason.is_connect() {
        return format!("网络错误：连不上这个地址（{reason}）");
    }
    format!("请求失败：{reason}")
}

/// 把非 2xx 响应翻译成「用户能照着修」的提示，顺带带上厂商原文。
fn describe_status(status: reqwest::StatusCode, text: &str) -> String {
    let code = status.as_u16();
    let detail = truncate(text, MAX_ERROR_CHARS);
    match code {
        401 | 403 => format!("鉴权失败（{code}）：API 密钥可能不对或已过期。{detail}"),
        404 => format!("接口返回 404：地址可能写错了，OpenAI 兼容基地址通常以 /v1 结尾。{detail}"),
        429 => format!("被限流（{code}）：稍后再试，或检查配额。{detail}"),
        500..=599 => format!("服务端错误（{code}）：{detail}"),
        _ => format!("接口返回 {code}：{detail}"),
    }
}

/// `GET /models` 里的一条模型。只取前端用得上的两个字段，
/// 各家的 `owned_by` / `created` 之类一律不管。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModel {
    /// 接口认的模型 ID，直接当 ProviderModel.id 用
    pub id: String,
    /// 接口给的显示名。多数 OpenAI 兼容实现只回 id，那就留空、前端回落成 id
    pub name: String,
}

/// 解析 `GET /models` 的响应。抽成纯函数是为了能单测——这条路径不值得为它起网络。
///
/// 结构不对（不是 JSON、没有 `data` 数组）算错误；`data` 是空数组不算，
/// 那是「接口能用但这个账号看不到模型」，报错反而误导。
/// 解析出来的按 id 排序：接口给的顺序各家不同，排一下界面才稳定。
fn parse_models(text: &str) -> Result<Vec<RemoteModel>, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| format!("无法解析模型列表: {}", truncate(text, MAX_ERROR_CHARS)))?;
    let list = value
        .get("data")
        .and_then(|data| data.as_array())
        .ok_or_else(|| {
            format!(
                "响应里没有模型列表（期望 data 数组）: {}",
                truncate(text, MAX_ERROR_CHARS)
            )
        })?;

    let mut models: Vec<RemoteModel> = Vec::new();
    for item in list {
        let Some(id) = item.get("id").and_then(|id| id.as_str()) else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        // 有的实现会给重名条目，去重免得在界面上出现两行一样的
        if models.iter().any(|model| model.id == id) {
            continue;
        }
        let name = item
            .get("name")
            .and_then(|name| name.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        models.push(RemoteModel {
            id: id.to_string(),
            name,
        });
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

/// 探针和拉列表共用的密钥解析：优先用界面上刚敲、还没保存的那份，
/// 否则按 provider id 去系统钥匙串取。本地模型两边都空是正常情况，返回空串。
///
/// 读钥匙串是同步阻塞调用，所以调用方要保证它在第一个 `await` 之前跑完。
fn resolve_probe_key(provider_id: &str, api_key: Option<String>) -> Result<String, String> {
    match api_key.map(|key| key.trim().to_string()) {
        Some(key) if !key.is_empty() => Ok(key),
        _ if provider_id.trim().is_empty() => Ok(String::new()),
        _ => Ok(crate::secrets::get(provider_id.trim())?.unwrap_or_default()),
    }
}

/// 退化的探针：一次只要 1 个 token，同样能验证鉴权和模型名，几乎不花钱。
/// 给那些不实现 `GET /models` 的兼容服务用。
async fn probe_with_chat(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
        "stream": false,
    });

    let mut request = client
        .post(format!("{base_url}/chat/completions"))
        .json(&body);
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }

    let response = request.send().await.map_err(describe_request_error)?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if status.is_success() {
        return Ok("连接成功（该接口不支持列出模型，已用一次极小的对话请求验证）".to_string());
    }
    if status.as_u16() == 404 {
        return Err(format!(
            "模型「{model}」不存在，或接口地址有误（404）：{}",
            truncate(&text, MAX_ERROR_CHARS)
        ));
    }
    Err(describe_status(status, &text))
}

/// 测试一个提供商的连通性：鉴权、网络、地址是否写对。
///
/// 先打 `GET /models`——便宜、且能同时验证鉴权与网络；有些 OpenAI 兼容实现
/// 不提供这条路由（回 404/405），那就退化成一次极小的对话请求。
///
/// 密钥优先用 `api_key`（用户在输入框里刚敲、还没保存的那份），为空则按
/// `provider_id` 去系统钥匙串取。本地模型两边都空是正常情况，直接不带鉴权头。
///
/// 这里**不套** `dev::AiOverrides`：测的是用户在界面上填的那份配置。
#[tauri::command]
pub async fn ai_test_provider(
    base_url: String,
    provider_id: String,
    api_key: Option<String>,
    model: String,
) -> Result<String, String> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("请先填写接口地址".to_string());
    }
    let model = model.trim().to_string();
    // 同步阻塞的系统调用，放在第一个 await 之前
    let api_key = resolve_probe_key(&provider_id, api_key)?;

    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|reason| format!("无法创建 HTTP 客户端: {reason}"))?;

    let mut request = client.get(format!("{base_url}/models"));
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }

    let response = request.send().await.map_err(describe_request_error)?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if status.is_success() {
        return Ok(match parse_models(&text) {
            Ok(models) => format!("连接成功，接口报告 {} 个可用模型", models.len()),
            Err(_) => "连接成功，但响应里没有模型列表".to_string(),
        });
    }

    if matches!(status.as_u16(), 404 | 405) {
        if model.is_empty() {
            return Err(format!(
                "接口不支持 GET /models（{}）。请先填一个模型名，再测试连接",
                status.as_u16()
            ));
        }
        return probe_with_chat(&client, &base_url, &api_key, &model).await;
    }

    Err(describe_status(status, &text))
}

/// 从提供商拉一份可用模型列表，给设置面板的「从接口拉取」用。
///
/// 走的是和连接测试同一条 `GET /models`，密钥来源也一样（优先界面上刚敲的那份）。
/// 这条路由不是所有 OpenAI 兼容实现都有，没有的话直接报错——这里**不**退化成
/// 对话请求：拉列表本来就是可选操作，猜不出来模型名。
#[tauri::command]
pub async fn ai_list_provider_models(
    base_url: String,
    provider_id: String,
    api_key: Option<String>,
) -> Result<Vec<RemoteModel>, String> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("请先填写接口地址".to_string());
    }
    // 同步阻塞的系统调用，放在第一个 await 之前
    let api_key = resolve_probe_key(&provider_id, api_key)?;

    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|reason| format!("无法创建 HTTP 客户端: {reason}"))?;

    let mut request = client.get(format!("{base_url}/models"));
    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_key}"));
    }

    let response = request.send().await.map_err(describe_request_error)?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(match status.as_u16() {
            404 | 405 => format!(
                "这个接口没有 GET /models 路由（{}），模型只能手动填",
                status.as_u16()
            ),
            _ => describe_status(status, &text),
        });
    }

    let models = parse_models(&text)?;
    if models.is_empty() {
        return Err("接口能连上，但没返回任何模型；模型只能手动填".to_string());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn context(diff: &str) -> git::CommitContext {
        git::CommitContext {
            diff: diff.to_string(),
            branch: Some("main".to_string()),
            recent_subjects: vec!["feat: 上一件事".to_string()],
        }
    }

    #[test]
    fn build_file_prompt_carries_the_path_and_content() {
        let (system, user) = build_file_prompt("src/lib/ai.ts", "export const x = 1;");
        assert!(system.contains("代码解析助手"));
        assert!(user.contains("src/lib/ai.ts"));
        assert!(user.contains("export const x = 1;"));
        // 没超限就不该出现截断提示，否则模型会以为文件没写完
        assert!(!user.contains("已截断"));
    }

    #[test]
    fn build_file_prompt_flags_an_oversized_file() {
        let content = "a".repeat(MAX_FILE_CHARS + 1);
        let (_, user) = build_file_prompt("big.ts", &content);
        assert!(user.contains("文件过大"), "超限时要告诉模型被截过");
    }

    #[test]
    fn parse_models_reads_ids_and_names() {
        let models = parse_models(
            r#"{"object":"list","data":[
                {"id":"deepseek-reasoner","object":"model","owned_by":"deepseek"},
                {"id":"deepseek-chat","name":"DeepSeek Chat"}
            ]}"#,
        )
        .unwrap();
        // 按 id 排序：接口给的顺序各家不同，排一下界面才稳定
        assert_eq!(
            models,
            vec![
                RemoteModel {
                    id: "deepseek-chat".to_string(),
                    name: "DeepSeek Chat".to_string()
                },
                RemoteModel {
                    id: "deepseek-reasoner".to_string(),
                    name: String::new()
                },
            ]
        );
    }

    #[test]
    fn parse_models_skips_junk_entries() {
        let models = parse_models(
            r#"{"data":[{"id":"ok"},{"id":"  "},{},{"id":123},{"id":"ok"},{"name":"no id"}]}"#,
        )
        .unwrap();
        // 没 id / 空 id / 重名的条目都要丢掉，不然界面上会出现空白行和重复行
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "ok");
    }

    #[test]
    fn parse_models_distinguishes_empty_from_broken() {
        // 空数组是「接口能用但账号看不到模型」，不算错误
        assert_eq!(parse_models(r#"{"data":[]}"#).unwrap(), Vec::new());
        // 结构不对才算错误
        assert!(parse_models("{}").is_err());
        assert!(parse_models("<html>502</html>").is_err());
    }

    #[test]
    fn resolve_probe_key_prefers_the_unsaved_draft() {
        // 传了草稿就用草稿，不去碰钥匙串
        assert_eq!(
            resolve_probe_key("deepseek", Some("  sk-draft  ".to_string())).unwrap(),
            "sk-draft"
        );
        // 没有 provider id 时无从查起，返回空串（本地模型不带鉴权头）
        assert_eq!(resolve_probe_key("", None).unwrap(), "");
        assert_eq!(
            resolve_probe_key("  ", Some("   ".to_string())).unwrap(),
            ""
        );
    }

    #[test]
    fn describe_status_keeps_vendor_detail() {
        let text = r#"{"error":{"message":"invalid api key"}}"#;
        let unauthorized = describe_status(reqwest::StatusCode::UNAUTHORIZED, text);
        assert!(unauthorized.contains("鉴权失败"));
        assert!(unauthorized.contains("invalid api key"));

        let limited = describe_status(reqwest::StatusCode::TOO_MANY_REQUESTS, text);
        assert!(limited.contains("限流"));

        let not_found = describe_status(reqwest::StatusCode::NOT_FOUND, text);
        assert!(not_found.contains("/v1"));

        // 没归类的状态码也要带上码和原文，别给一句光秃秃的失败
        let weird = describe_status(reqwest::StatusCode::IM_A_TEAPOT, text);
        assert!(weird.contains("418"));
        assert!(weird.contains("invalid api key"));
    }

    #[test]
    fn describe_status_truncates_long_bodies() {
        // 厂商有时回整页 HTML，别把它全塞进设置面板
        let long = "x".repeat(MAX_ERROR_CHARS + 500);
        let message = describe_status(reqwest::StatusCode::BAD_REQUEST, &long);
        assert!(message.chars().count() < MAX_ERROR_CHARS + 100);
    }

    #[test]
    fn truncate_keeps_text_within_limit() {
        assert_eq!(truncate("abcdef", 10), "abcdef");
        assert_eq!(truncate("abcdef", 6), "abcdef");
    }

    #[test]
    fn truncate_cuts_on_char_boundary() {
        // 全是多字节字符：按字节切会 panic，按字符切才对
        assert_eq!(truncate("中文中文", 2), "中文");
    }

    #[test]
    fn clean_strips_code_fence() {
        assert_eq!(clean_message("```\nfeat: 加个东西\n```"), "feat: 加个东西");
        assert_eq!(
            clean_message("```text\nfix: 修个 bug\n```"),
            "fix: 修个 bug"
        );
    }

    #[test]
    fn clean_strips_surrounding_quotes() {
        assert_eq!(clean_message("\"feat: 加个东西\""), "feat: 加个东西");
        assert_eq!(clean_message("'fix: 修个 bug'"), "fix: 修个 bug");
    }

    #[test]
    fn clean_leaves_plain_message_untouched() {
        assert_eq!(clean_message("  feat: 加个东西\n"), "feat: 加个东西");
        // 只有一侧有引号时不能剥，否则会把正文吃掉
        assert_eq!(
            clean_message("fix: 处理 \"a\" 的情况"),
            "fix: 处理 \"a\" 的情况"
        );
    }

    #[test]
    fn prompt_carries_branch_subjects_and_diff() {
        let (system, user) = build_prompt(&context("+ 一行改动"));
        assert!(system.contains("提交信息"));
        assert!(user.contains("当前分支：main"));
        assert!(user.contains("- feat: 上一件事"));
        assert!(user.contains("+ 一行改动"));
    }

    #[test]
    fn prompt_asks_for_the_conventional_template() {
        let (system, _) = build_prompt(&context("+ 一行改动"));
        assert!(system.contains("<type>(<scope>): <subject>"));
        assert!(system.contains("<body>"));
        assert!(system.contains("<footer>"));
        // type 的候选得列全，否则模型会自己编
        for kind in ["feat", "fix", "docs", "refactor", "chore"] {
            assert!(system.contains(kind), "缺少 type: {kind}");
        }
        // body 要精简、多个改动点分条列出，别退化成逐文件流水账
        assert!(system.contains("精简"));
        assert!(system.contains("分条"));
    }

    #[test]
    fn prompt_handles_empty_history() {
        let empty = git::CommitContext {
            diff: "x".to_string(),
            branch: None,
            recent_subjects: Vec::new(),
        };
        let (_, user) = build_prompt(&empty);
        assert!(user.contains("当前分支：未知"));
        assert!(user.contains("这是仓库的第一次提交"));
    }

    // ---- 解读改动 ----

    /// 一律从 root 拼路径，不手写分隔符：`\` 在 Unix 上只是普通字符，
    /// 写死 `D:\ws` 会让 strip_prefix 直接落空——测试看着绿，其实什么都没验。
    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from("D:\\ws")
        } else {
            PathBuf::from("/ws")
        }
    }

    fn under(part: &str) -> PathBuf {
        root().join(part)
    }

    #[test]
    fn explain_prompt_carries_a_relative_path_and_the_diff() {
        let path = under("src").join("main.rs");
        let (system, user) = build_explain_prompt(
            &root(),
            &path.to_string_lossy(),
            &DiffSource::Unstaged,
            "+ 一行改动",
        );
        // 显示的是工作区相对路径、正斜杠，不是那串绝对路径
        assert!(user.contains("文件：src/main.rs"));
        assert!(!user.contains("ws"), "不该把工作区绝对路径前缀带进去");
        assert!(user.contains("未暂存的改动"));
        assert!(user.contains("+ 一行改动"));
        assert!(system.contains("markdown"));
    }

    #[test]
    fn explain_prompt_names_the_commit_and_the_staged_baseline() {
        let path = under("a.ts");
        let (_, staged) =
            build_explain_prompt(&root(), &path.to_string_lossy(), &DiffSource::Staged, "x");
        assert!(staged.contains("已暂存的改动"));

        let (_, commit) = build_explain_prompt(
            &root(),
            &path.to_string_lossy(),
            &DiffSource::Commit {
                rev: "0123456789abcdef".to_string(),
            },
            "x",
        );
        // 提交号只取前 7 位，整串 hex 塞进提示里没有意义
        assert!(commit.contains("提交 0123456 中的改动"));
        assert!(!commit.contains("0123456789abcdef"));
    }

    #[test]
    fn explain_prompt_marks_a_truncated_diff() {
        let path = under("big.ts");
        let long = "x".repeat(MAX_DIFF_CHARS + 10);
        let (_, user) = build_explain_prompt(
            &root(),
            &path.to_string_lossy(),
            &DiffSource::Unstaged,
            &long,
        );
        assert!(user.contains("已截断"));
    }

    // ---- 生成反馈正文 ----

    fn known_paths() -> Vec<String> {
        ["src/lib/ai.ts", "src/components/FeedbackDialog.tsx", "README.md"]
            .iter()
            .map(|item| item.to_string())
            .collect()
    }

    #[test]
    fn parse_selected_files_keeps_only_real_paths() {
        let picked = parse_selected_files(
            "1. `src/components/FeedbackDialog.tsx`\n- src/lib/ai.ts:120\n编出来的/没有.ts\n无",
            &known_paths(),
        );
        // 序号 / 反引号 / 行号都要能剥掉，编出来的路径必须丢掉
        assert_eq!(
            picked,
            vec![
                "src/components/FeedbackDialog.tsx".to_string(),
                "src/lib/ai.ts".to_string(),
            ]
        );
    }

    #[test]
    fn parse_selected_files_dedupes_and_caps() {
        let known: Vec<String> = (0..12).map(|index| format!("f{index}.ts")).collect();
        let mut lines = vec!["f0.ts".to_string(), "f0.ts".to_string()];
        lines.extend((0..12).map(|index| format!("f{index}.ts")));
        let picked = parse_selected_files(&lines.join("\n"), &known);

        assert_eq!(picked.len(), MAX_CONTEXT_FILES);
        // 重复的路径不该占掉两个位置
        assert_eq!(picked[0], "f0.ts");
        assert_eq!(picked[1], "f1.ts");
    }

    #[test]
    fn parse_selected_files_returns_empty_when_nothing_matches() {
        assert!(parse_selected_files("无", &known_paths()).is_empty());
    }

    #[test]
    fn build_pick_prompt_carries_the_clue_and_the_tree() {
        let (system, user) =
            build_pick_prompt("反馈面板加生成", "feature", "src/a.ts\nsrc/b.ts", true);
        assert!(system.contains("只输出文件路径"));
        assert!(user.contains("线索：反馈面板加生成"));
        assert!(user.contains("建议"), "分类要翻成中文");
        assert!(user.contains("src/a.ts"));
        // 截断时要说明，免得模型以为仓库就这么大
        assert!(user.contains("只列了一部分"));
    }

    #[test]
    fn build_feedback_prompt_asks_for_the_sections() {
        let (system, user) = build_feedback_prompt("标题", "bug", "--- src/a.ts ---\ncode\n");
        for section in ["## 背景", "## 期望", "## 实现要点", "## 验收"] {
            assert!(system.contains(section), "缺少小节: {section}");
        }
        assert!(user.contains("缺陷"));
        assert!(user.contains("--- src/a.ts ---"));
    }

    #[test]
    fn build_feedback_prompt_handles_missing_code_context() {
        let (_, user) = build_feedback_prompt("标题", "other", "  ");
        assert!(user.contains("没能取到相关文件内容"));
    }

    #[test]
    fn repo_files_lists_relative_paths_and_skips_heavy_dirs() {
        let dir = std::env::temp_dir().join("codedock-ai-repo-files");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("a.ts"), "x").unwrap();
        std::fs::write(dir.join("README.md"), "x").unwrap();
        // 被跳过的目录里的文件不该出现在清单里
        std::fs::create_dir_all(dir.join("node_modules").join("pkg")).unwrap();
        std::fs::write(dir.join("node_modules").join("pkg").join("index.js"), "x").unwrap();

        let (files, truncated) = repo_files(&dir);
        assert_eq!(files, vec!["README.md".to_string(), "src/a.ts".to_string()]);
        assert!(!truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
