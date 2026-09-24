use std::time::Duration;

use serde::Deserialize;

use crate::fs_api::FsState;
use crate::git;

/// 单次喂给模型的 diff 上限（按字符算，不是字节）。常见的输入窗口足够放下
/// 这个量级，再大只是把 token 烧在无关的大文件上。
const MAX_DIFF_CHARS: usize = 24_000;

/// 接口冷启动 + 大模型首包可能很慢，给足时间；超时只作废这一次生成。
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// 出错时回传给界面的响应体片段上限，别把整段 HTML 错误页塞进面板。
const MAX_ERROR_CHARS: usize = 500;

/// 系统提示写死在这里：产物只有一条提交信息，让模型自由发挥没有好处。
const SYSTEM_PROMPT: &str = "\
你是 Git 提交信息助手，根据用户提供的暂存区改动写一条提交信息。
硬性要求：
1. 只输出提交信息本身，不要任何解释、前言、代码块围栏或引号。
2. 首行是一句话概括，不超过 72 个字符，用祈使句。
3. 改动较多时，首行后空一行，再用「- 」列出简要要点。
4. 语言跟「最近提交」保持一致；没有历史提交时用中文。
5. 不要编造改动里没有的内容。";

/// 前端传来的接口配置。三个字段都由用户填，空的话直接拒绝，不去打扰接口。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitConfig {
    /// OpenAI 兼容接口的基地址，例如 https://api.deepseek.com/v1
    base_url: String,
    api_key: String,
    model: String,
}

/// 让大模型根据当前仓库的暂存区改动生成一条提交信息。
///
/// 只走 Rust 侧的 HTTP：密钥不进 WebView，也不受各厂商的跨域限制。
#[tauri::command]
pub async fn ai_generate_commit_message(
    state: tauri::State<'_, FsState>,
    config: AiCommitConfig,
) -> Result<String, String> {
    let base_url = config.base_url.trim().trim_end_matches('/').to_string();
    let api_key = config.api_key.trim().to_string();
    let model = config.model.trim().to_string();
    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err("请先在「设置 → AI」里填写接口地址、模型和密钥".to_string());
    }

    // git 是同步阻塞的，赶在第一个 await 之前跑完，别让 std 的锁跨越 await 点
    let context = git::commit_context(&state)?;
    if context.diff.trim().is_empty() {
        return Err("暂存区没有可生成的改动".to_string());
    }

    let (system, user) = build_prompt(&context);
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        // 低温度：提交信息要稳、可复现，不需要发挥
        "temperature": 0.3,
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

    let message = clean_message(content);
    if message.is_empty() {
        return Err("大模型返回了空的提交信息".to_string());
    }
    Ok(message)
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
}
