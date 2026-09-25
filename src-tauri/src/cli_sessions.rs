use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::fs_api::simplify;
use crate::pty::home_dir;

/// 只读文件头就够：cwd 和标题在本机实测最远 32KB（claude 的首条提问），
/// 留到 128KB 兜住"第一轮就粘贴超大内容"的极端情况。
/// 绝不读整个文件——本机有 4.3MB 的会话，一百多个文件全读是几十 MB。
const HEAD_BYTES: u64 = 128 * 1024;

/// 返回条数上限。侧边栏那块地方只放得下十来条，剩下的靠滚动，
/// 同时兜住"某个项目目录里堆了几百个会话"的情况。
const MAX_SESSIONS: usize = 50;

/// 标题最长多少字符。一行放不下，太长也没意义
const TITLE_CHARS: usize = 60;

/// CLI 自己塞进会话里的模板文本，不是用户说的话。
/// 末尾那条是 claude 的中断标记，本机 9 个会话的首条 user 就是它——
/// 那种会话压根没有真正的提问，显示「未命名会话」比显示这个标记诚实。
const NOISE_PREFIXES: &[&str] = &[
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-",
    "<system-reminder",
    "<user-prompt-submit-hook",
    "[Request interrupted by user",
];

/// 认得的 CLI -> 会话记录相对用户主目录的位置。不认识的就是不支持。
/// 三端都用 `/` 拼：Windows 的 Path 也认它。
fn provider_projects_dir(provider: &str) -> Option<&'static str> {
    match provider {
        "codebuddy" => Some(".codebuddy/projects"),
        "claude" => Some(".claude/projects"),
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSession {
    /// 取文件名词干——这才是 resume 要传的 id，比从记录里抠 sessionId 可靠
    pub id: String,
    /// 抠不出来时是空串，前端显示「未命名会话」
    pub title: String,
    /// 文件最后修改时间，Unix 毫秒（前端复用 formatTime 显示"多久前"）
    pub updated: u64,
    /// 记录里的 cwd 原样回传，仅供排查
    pub cwd: String,
}

#[tauri::command]
pub fn cli_list_sessions(provider: String, cwd: String) -> Result<Vec<CliSession>, String> {
    let relative = provider_projects_dir(&provider)
        .ok_or_else(|| format!("不支持的 AI CLI: {provider}"))?;
    // 拿不到主目录、没装过这个 CLI，都当"没有会话"——列不出历史不是错误
    let Some(home) = home_dir() else {
        return Ok(Vec::new());
    };
    Ok(list_sessions_in(&home.join(relative), &provider, &cwd))
}

/// 标题的三个候选槽，优先级从高到低。codebuddy 三档都有，claude 只有最后一档。
#[derive(Default)]
struct Titles {
    /// codebuddy 的 ai-title.aiTitle，模型现起的标题，最贴近"这次对话在聊什么"
    ai: String,
    /// codebuddy 里 providerData.source == "initial-user-message" 的 summary
    summary: String,
    /// 第一条像样的用户输入
    first: String,
}

impl Titles {
    fn pick(&self) -> String {
        if !self.ai.is_empty() {
            return self.ai.clone();
        }
        if !self.summary.is_empty() {
            return self.summary.clone();
        }
        self.first.clone()
    }
}

struct HeadScan {
    cwd: String,
    title: String,
}

/// 抽出来是为了能在单测里直接造夹具验证过滤与排序规则（同 fs_api::list_entries）。
fn list_sessions_in(projects: &Path, provider: &str, cwd: &str) -> Vec<CliSession> {
    let target = cwd_key(cwd);
    let mut found = Vec::new();
    // 目录不存在 = 没装过 / 没跑过这个 CLI，是正常情况
    let Ok(entries) = fs::read_dir(projects) else {
        return found;
    };

    // 布局固定是 <项目目录>/<会话 id>.jsonl，只扫两层。旁边的 <id>/tool-results/、
    // memory/ 这些目录被"只认 .jsonl 文件"挡在外面
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = file.metadata() else {
                continue;
            };
            // 开了就退的会话是 0 字节，本机一大堆（一个项目目录 16 个文件里 10 个是空的）
            if !meta.is_file() || meta.len() == 0 {
                continue;
            }
            let Some(head) = read_head(&path) else {
                continue;
            };
            let Some(scan) = scan_head(&head, provider) else {
                continue;
            };
            // 按 cwd 字段正向匹配。不去反算 slug——slug 有损，路径里本身的 '-'
            // 和分隔符是撞的，两家 CLI 的规则还不一样
            if cwd_key(&scan.cwd) != target {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            found.push(CliSession {
                id: id.to_string(),
                title: scan.title,
                updated: mtime_ms(&meta),
                cwd: scan.cwd,
            });
        }
    }

    // 最近活动的在前；同毫秒并列时按 id 兜底，保证同样的磁盘状态给出同样的顺序
    found.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    found.truncate(MAX_SESSIONS);
    found
}

fn read_head(path: &Path) -> Option<String> {
    // take() 按值吃掉 file，所以不用 mut
    let file = fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(HEAD_BYTES as usize);
    file.take(HEAD_BYTES).read_to_end(&mut buf).ok()?;
    // 用 lossy 而不是严格 UTF-8：截断处可能刚好落在多字节序列中间，
    // 替换成 U+FFFD 就行——那一行本来就是半行，JSON 解析必然失败被跳过，
    // 前面完整的行不受影响
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn scan_head(head: &str, provider: &str) -> Option<HeadScan> {
    let mut cwd = String::new();
    let mut titles = Titles::default();

    // 整段头扫完、不提前退出：实测 codebuddy 的 ai-title 排在 summary 后面，
    // 一见到 summary 就收工会把更好的标题漏掉
    for line in head.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // 半行 / 非 JSON，丢掉继续
        };
        // claude 前几行是 permission-mode / file-history-snapshot，没有 cwd，
        // 所以不能只看第一行
        if cwd.is_empty() {
            if let Some(text) = value.get("cwd").and_then(|v| v.as_str()) {
                cwd = text.to_string();
            }
        }
        match provider {
            "codebuddy" => scan_codebuddy(&value, &mut titles),
            "claude" => scan_claude(&value, &mut titles),
            _ => {}
        }
    }

    // 抠不出 cwd 就没法归属到哪个项目，只能丢
    if cwd.is_empty() {
        return None;
    }
    Some(HeadScan {
        cwd,
        title: titles.pick(),
    })
}

fn scan_codebuddy(value: &serde_json::Value, titles: &mut Titles) {
    match value.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "ai-title" if titles.ai.is_empty() => {
            if let Some(text) = value.get("aiTitle").and_then(|v| v.as_str()) {
                titles.ai = clean_title(text);
            }
        }
        // 判据是 source 而不是"位置靠前"：同一个文件靠后还有一堆 periodic /
        // pre-compact 的上下文压缩摘要，拿那些会得到 <conversation_history_summary>
        "summary" if titles.summary.is_empty() => {
            if value
                .pointer("/providerData/source")
                .and_then(|v| v.as_str())
                == Some("initial-user-message")
            {
                if let Some(text) = value.get("summary").and_then(|v| v.as_str()) {
                    titles.summary = clean_title(text);
                }
            }
        }
        // 前两档都没有时的兜底。第一条 user 常常是 <system-reminder ...>，
        // 被 clean_title 丢掉后会留空，于是后面的 user 消息继续顶上
        "message"
            if titles.first.is_empty()
                && value.get("role").and_then(|v| v.as_str()) == Some("user") =>
        {
            titles.first = block_text(value.get("content"), "input_text");
        }
        _ => {}
    }
}

fn scan_claude(value: &serde_json::Value, titles: &mut Titles) {
    if !titles.first.is_empty() || value.get("type").and_then(|v| v.as_str()) != Some("user") {
        return;
    }
    // isMeta 是 /plugin、/model 这类命令回显，isSidechain 是子代理塞进来的提示词
    if value.get("isMeta").and_then(|v| v.as_bool()) == Some(true)
        || value.get("isSidechain").and_then(|v| v.as_bool()) == Some(true)
    {
        return;
    }
    // clean_title 返回空串时不能当成"找到了"——交给下一条 user 记录继续试
    titles.first = claude_user_text(value.get("message"));
}

/// codebuddy 的 content 是内容块数组，用户输入在 input_text 块里
fn block_text(content: Option<&serde_json::Value>, block_type: &str) -> String {
    let Some(items) = content.and_then(|v| v.as_array()) else {
        return String::new();
    };
    for item in items {
        if item.get("type").and_then(|v| v.as_str()) != Some(block_type) {
            continue;
        }
        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
            let cleaned = clean_title(text);
            if !cleaned.is_empty() {
                return cleaned;
            }
        }
    }
    String::new()
}

/// claude 的 message.content 有两种壳：字符串，或内容块数组——数组里绝大多数
/// 是 tool_result（工具输出回灌），那不是用户说的话，必须跳过
fn claude_user_text(message: Option<&serde_json::Value>) -> String {
    match message.and_then(|m| m.get("content")) {
        Some(serde_json::Value::String(text)) => clean_title(text),
        Some(serde_json::Value::Array(items)) => {
            for item in items {
                if item.get("type").and_then(|v| v.as_str()) != Some("text") {
                    continue;
                }
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    let cleaned = clean_title(text);
                    if !cleaned.is_empty() {
                        return cleaned;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// 折叠空白 + 丢掉 CLI 自己的模板文本 + 按**字符**截断（按字节会切坏多字节）。
/// 返回空串表示这条不能当标题，调用方继续找下一条。
fn clean_title(raw: &str) -> String {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || NOISE_PREFIXES.iter().any(|p| text.starts_with(p)) {
        return String::new();
    }
    text.chars().take(TITLE_CHARS).collect()
}

/// cwd 归一的比较键：Windows 上分隔符（CLI 可能记 `/` 也可能记 `\`）、大小写、
/// `\\?\` 前缀都可能不一致，不归一就会把同一个目录认成两个。
///
/// 不在这里做 realpath：macOS 上 `/tmp` 会被记成 `/private/tmp`，真要解析得每条
/// 记录都 canonicalize 一次。词法归一对"从工作区根起的 CLI"够用。
///
/// 也不能复用 fs_api::resolve——会话记录在用户主目录下，在工作区根之外，
/// 它那句前缀校验会直接拒掉。
fn cwd_key(raw: &str) -> String {
    simplify(PathBuf::from(raw))
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 每个测试各用一个目录：cargo test 默认并行跑，共用同名目录时，
    /// 一个测试收尾的 remove_dir_all 会把另一个测试刚写好的夹具删掉。
    fn temp_projects() -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let unique = SEQ.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "codedock-cli-sessions-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// 夹具里的 cwd 一律写这个假路径，不用真实的临时目录：临时目录在 macOS 上
    /// 带着 /var -> /private/var 的软链，cwd_key 只做词法归一，两边写一样的
    /// 字符串才能稳定匹配上。
    const WORK: &str = "/Users/someone/work";

    fn write_session(projects: &Path, slug: &str, id: &str, lines: &[&str]) {
        let dir = projects.join(slug);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{id}.jsonl")), lines.join("\n")).unwrap();
    }

    #[test]
    fn cwd_key_normalizes_windows_paths() {
        assert_eq!(cwd_key(r"\\?\C:\Work\Proj\"), cwd_key("c:/work/proj"));
        assert_eq!(cwd_key("/Users/a/proj/"), cwd_key("/Users/a/proj"));
    }

    #[test]
    fn missing_projects_dir_is_empty_not_error() {
        let projects = temp_projects();
        assert!(list_sessions_in(&projects.join("nope"), "claude", WORK).is_empty());
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn lists_only_sessions_of_the_given_cwd() {
        let projects = temp_projects();
        write_session(
            &projects,
            "-Users-someone-work",
            "aaaa-1111",
            &[r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"在当前项目里干活"}],"cwd":"/Users/someone/work"}"#],
        );
        // 同一个 slug 目录下也可能混着别的 cwd（slug 有损，两个不同路径可能撞进一个目录）
        write_session(
            &projects,
            "-Users-someone-work",
            "bbbb-2222",
            &[r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"别的目录"}],"cwd":"/Users/someone/other"}"#],
        );

        let found = list_sessions_in(&projects, "claude", WORK);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "aaaa-1111");
        // cwd 是原样回传的，不做归一
        assert_eq!(found[0].cwd, WORK);
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn codebuddy_prefers_ai_title_and_skips_empty_files() {
        let projects = temp_projects();
        write_session(
            &projects,
            "work",
            "aaaa-1111",
            &[
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<system-reminder data-role=\"command-caveat\">Caveat"}],"cwd":"/Users/someone/work"}"#,
                r#"{"type":"summary","summary":"用户说的第一句话","providerData":{"source":"initial-user-message"}}"#,
                r#"{"type":"ai-title","aiTitle":"修复终端环境加载"}"#,
                r#"{"type":"summary","summary":"<conversation_history_summary>\nSummary:","providerData":{"source":"periodic"}}"#,
            ],
        );
        // 开了就退的会话：0 字节，不该出现在列表里
        write_session(&projects, "work", "cccc-3333", &[""]);

        let found = list_sessions_in(&projects, "codebuddy", WORK);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "修复终端环境加载");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn codebuddy_falls_back_past_noise_and_periodic_summaries() {
        let projects = temp_projects();
        write_session(
            &projects,
            "work",
            "aaaa-1111",
            &[
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<system-reminder>nope"}],"cwd":"/Users/someone/work"}"#,
                r#"{"type":"summary","summary":"周期性压缩摘要","providerData":{"source":"periodic"}}"#,
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"  真正   的标题  "}]}"#,
            ],
        );

        let found = list_sessions_in(&projects, "codebuddy", WORK);
        assert_eq!(found.len(), 1);
        // 空白被折叠，噪声和 periodic 摘要都不参与
        assert_eq!(found[0].title, "真正 的标题");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn claude_takes_first_real_prompt_across_both_content_shapes() {
        let projects = temp_projects();
        write_session(
            &projects,
            "-Users-someone-work",
            "aaaa-1111",
            &[
                r#"{"type":"permission-mode","permissionMode":"default"}"#,
                r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","content":"No files found"}]},"cwd":"/Users/someone/work"}"#,
                r#"{"type":"user","message":{"role":"user","content":"<command-message>setup</command-message>"}}"#,
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
                r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"子代理的提示词"}}"#,
                r#"{"type":"user","message":{"role":"user","content":"检查计划完成情况并继续"}}"#,
            ],
        );

        let found = list_sessions_in(&projects, "claude", WORK);
        assert_eq!(found.len(), 1);
        // tool_result 块、<command-message> 噪声、claude 自己的中断标记、
        // isSidechain 的子代理提示词，全都要跳过
        assert_eq!(found[0].title, "检查计划完成情况并继续");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn session_without_any_real_prompt_has_an_empty_title() {
        let projects = temp_projects();
        write_session(
            &projects,
            "-Users-someone-work",
            "aaaa-1111",
            &[
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"cwd":"/Users/someone/work"}"#,
            ],
        );

        let found = list_sessions_in(&projects, "claude", WORK);
        assert_eq!(found.len(), 1);
        // 一条真话都没有时不该硬造标题，前端会显示「未命名会话」
        assert_eq!(found[0].title, "");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn claude_accepts_text_blocks_and_sorts_by_updated() {
        let projects = temp_projects();
        write_session(
            &projects,
            "-Users-someone-work",
            "aaaa-1111",
            &[
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"数组壳里的提问"}]},"cwd":"/Users/someone/work"}"#,
            ],
        );
        write_session(
            &projects,
            "-Users-someone-work",
            "bbbb-2222",
            &[
                r#"{"type":"user","message":{"role":"user","content":"第二条"},"cwd":"/Users/someone/work"}"#,
            ],
        );

        let found = list_sessions_in(&projects, "claude", WORK);
        assert_eq!(found.len(), 2);
        // 按 id 取而不是按下标：两次写入可能落在同一毫秒，同毫秒时按 id 兜底，
        // 那时候谁排前面取决于 id 而不是写入顺序，按下标断言会随机翻车
        let by_id = |id: &str| found.iter().find(|item| item.id == id).unwrap();
        assert_eq!(by_id("aaaa-1111").title, "数组壳里的提问");
        assert_eq!(by_id("bbbb-2222").title, "第二条");
        // 只验证单调不倒序
        assert!(found[0].updated >= found[1].updated);
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn rejects_unknown_provider() {
        assert!(provider_projects_dir("opencode").is_none());
        assert!(provider_projects_dir("codebuddy").is_some());
        assert!(provider_projects_dir("claude").is_some());
    }
}
