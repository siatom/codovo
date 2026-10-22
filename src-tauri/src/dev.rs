//! 开发调试期的本地覆盖：AI 的接口地址 / 模型 / 密钥可以从 `src-tauri/.env` 里读。
//!
//! 只在 debug 构建里生效——release 下 `read_overrides` 恒返回空，打包出去的版本里
//! 连读文件的代码路径都不存在。
//!
//! 刻意不用 `dotenvy`：它会把变量 `set_var` 进进程环境，而 PTY 终端（`pty.rs` 用
//! `CommandBuilder` 起 shell）和 opencode 子进程都继承进程环境，密钥会跟着泄漏到
//! 用户随手开的每一个终端里。这里只解析成结构体，绝不碰进程环境。

use serde::Serialize;

/// 只认这三个键，文件里写别的会被忽略。
/// 只在解析路径存在的构建里需要，否则正式版会报 dead_code。
#[cfg(any(debug_assertions, test))]
const KEY_BASE_URL: &str = "CODOVO_AI_BASE_URL";
#[cfg(any(debug_assertions, test))]
const KEY_MODEL: &str = "CODOVO_AI_MODEL";
#[cfg(any(debug_assertions, test))]
const KEY_API_KEY: &str = "CODOVO_AI_API_KEY";

/// `.env` 里读到的覆盖值。`None` = 这个键没写（或写了空值），保持前端传来的值不动。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AiOverrides {
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
}

/// 回给前端的形状。密钥只回「有没有」，正文不出后端——沿用「密钥不进 WebView」的口径。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevAiOverrides {
    /// 空串表示没覆盖
    pub base_url: String,
    pub model: String,
    pub api_key_set: bool,
}

/// 解析函数只在开发构建和测试里编译：正式版整条解析路径都不该存在。
#[cfg(any(debug_assertions, test))]
fn parse_env(content: &str) -> Vec<(String, String)> {
    // 记事本存 UTF-8 会带 BOM，不剥掉的话第一个键名前面会多一个看不见的字符
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);

    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            // 按第一个 = 切：密钥里偶尔带 =，不能按最后一个切
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), unquote(value.trim())))
        })
        .collect()
}

/// 剥掉成对的引号，方便写带空格的值。只有一侧有引号时原样返回，免得把正文吃掉。
#[cfg(any(debug_assertions, test))]
fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

/// 从 `.env` 正文里挑出那三个键。同一个键写多行时以最后一行为准。
#[cfg(any(debug_assertions, test))]
fn overrides_from(content: &str) -> AiOverrides {
    let mut overrides = AiOverrides::default();
    for (key, value) in parse_env(content) {
        let slot = match key.as_str() {
            KEY_BASE_URL => &mut overrides.base_url,
            KEY_MODEL => &mut overrides.model,
            KEY_API_KEY => &mut overrides.api_key,
            _ => continue,
        };
        // 写了空值等于没写：否则一个 `KEY=` 会把设置面板里填好的值清掉
        *slot = if value.is_empty() { None } else { Some(value) };
    }
    overrides
}

/// 读一次 `.env`。每次调用都重读——文件很小，改完下一次调用就生效，不必重启进程。
///
/// 读不到、不是 UTF-8（PowerShell 的 `Out-File` 默认写 UTF-16）都当没配：
/// 这是开发期的便利功能，不该因为它写坏了就让 AI 调用整体失败。
#[cfg(debug_assertions)]
pub fn read_overrides() -> AiOverrides {
    // 用编译期的源码目录而不是 cwd：换个地方启动 exe 也还是读到同一个文件
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env");
    match std::fs::read_to_string(path) {
        Ok(content) => overrides_from(&content),
        Err(_) => AiOverrides::default(),
    }
}

/// 正式版没有读这个文件的代码路径。
#[cfg(not(debug_assertions))]
pub fn read_overrides() -> AiOverrides {
    AiOverrides::default()
}

/// 界面拿它显示「当前值已被 .env 覆盖」。正式版恒为空。
#[tauri::command]
pub fn dev_ai_overrides() -> DevAiOverrides {
    let overrides = read_overrides();
    DevAiOverrides {
        base_url: overrides.base_url.unwrap_or_default(),
        model: overrides.model.unwrap_or_default(),
        api_key_set: overrides.api_key.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_skips_comments_and_blank_lines() {
        let parsed = parse_env("# 注释\n\nCODOVO_AI_MODEL=gpt-4o-mini\n");
        assert_eq!(
            parsed,
            vec![("CODOVO_AI_MODEL".to_string(), "gpt-4o-mini".to_string())]
        );
    }

    #[test]
    fn parse_handles_crlf_and_bom() {
        // Windows 上这两样最常见：BOM 会污染第一个键名，CRLF 的 \r 会留在值尾
        let parsed = parse_env("\u{feff}CODOVO_AI_API_KEY=sk-1\r\nCODOVO_AI_MODEL=m\r\n");
        assert_eq!(
            parsed[0],
            ("CODOVO_AI_API_KEY".to_string(), "sk-1".to_string())
        );
        assert_eq!(
            parsed[1],
            ("CODOVO_AI_MODEL".to_string(), "m".to_string())
        );
    }

    #[test]
    fn parse_keeps_equals_inside_value() {
        let parsed = parse_env("CODOVO_AI_API_KEY=abc=def");
        assert_eq!(parsed[0].1, "abc=def");
    }

    #[test]
    fn parse_strips_matching_quotes_only() {
        let parsed = parse_env("A=\"a b\"\nB='c d'\nC=\"只开一边");
        assert_eq!(parsed[0].1, "a b");
        assert_eq!(parsed[1].1, "c d");
        assert_eq!(parsed[2].1, "\"只开一边");
    }

    #[test]
    fn overrides_take_only_known_keys() {
        let overrides = overrides_from("OTHER=1\nCODOVO_AI_MODEL=m");
        assert_eq!(overrides.model.as_deref(), Some("m"));
        assert_eq!(overrides.base_url, None);
        assert_eq!(overrides.api_key, None);
    }

    #[test]
    fn overrides_last_write_wins() {
        let overrides = overrides_from("CODOVO_AI_MODEL=a\nCODOVO_AI_MODEL=b");
        assert_eq!(overrides.model.as_deref(), Some("b"));
    }

    #[test]
    fn overrides_treat_empty_value_as_absent() {
        let overrides = overrides_from("CODOVO_AI_BASE_URL=\nCODOVO_AI_API_KEY=");
        assert_eq!(overrides, AiOverrides::default());
    }
}
