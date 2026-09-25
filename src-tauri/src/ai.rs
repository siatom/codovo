use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::fs_api::FsState;
use crate::git::{self, DiffSource};

/// 单次喂给模型的 diff 上限（按字符算，不是字节）。常见的输入窗口足够放下
/// 这个量级，再大只是把 token 烧在无关的大文件上。
const MAX_DIFF_CHARS: usize = 24_000;

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

/// 前端传来的接口配置。三个字段都由用户填，空的话直接拒绝，不去打扰接口。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// OpenAI 兼容接口的基地址，例如 https://api.deepseek.com/v1
    base_url: String,
    api_key: String,
    model: String,
}

impl AiConfig {
    /// 三个字段都填全了才去请求，缺一个就报同一句话——用户知道该去哪儿补。
    fn ready(&self) -> Result<(String, String, String), String> {
        let base_url = self.base_url.trim().trim_end_matches('/').to_string();
        let api_key = self.api_key.trim().to_string();
        let model = self.model.trim().to_string();
        if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
            return Err("请先在「设置 → AI」里填写接口地址、模型和密钥".to_string());
        }
        Ok((base_url, api_key, model))
    }
}

/// 发一次 chat completions，返回模型输出的原文（不做任何后处理）。
///
/// 只走 Rust 侧的 HTTP：密钥不进 WebView，也不受各厂商的跨域限制。
/// 两个功能（生成提交信息 / 解读改动）共用，调用方自己拼提示词、自己清理输出。
async fn chat(config: &AiConfig, system: &str, user: &str, temperature: f32) -> Result<String, String> {
    let (base_url, api_key, model) = config.ready()?;

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
    config: AiConfig,
) -> Result<String, String> {
    // 先挡一道：配置不全时不必去读 diff
    config.ready()?;

    // git 是同步阻塞的，赶在第一个 await 之前跑完，别让 std 的锁跨越 await 点
    let context = git::commit_context(&state)?;
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

/// 让大模型解释一个改动文件里到底改了什么。产物是 markdown 正文，直接交给
/// 界面渲染，所以**不做** clean_message 那套去围栏处理——代码块本来就要留着。
#[tauri::command]
pub async fn ai_explain_change(
    state: tauri::State<'_, FsState>,
    config: AiConfig,
    path: String,
    source: git::DiffSource,
) -> Result<String, String> {
    config.ready()?;

    // 同 ai_generate_commit_message：git 是同步阻塞的，先跑完再 await
    let root = state.root()?;
    let diff = git::file_diff_text(&state, &path, &source)?;
    if diff.trim().is_empty() {
        return Err("这个文件没有可解读的改动".to_string());
    }

    let (system, user) = build_explain_prompt(&root, &path, &source, &diff);
    // 解释要按事实说，温度低一点免得编出 diff 里没有的行为
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
        assert_eq!(clean_message("fix: 处理 \"a\" 的情况"), "fix: 处理 \"a\" 的情况");
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
        let (_, staged) = build_explain_prompt(
            &root(),
            &path.to_string_lossy(),
            &DiffSource::Staged,
            "x",
        );
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
}
