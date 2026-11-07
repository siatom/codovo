use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;

use crate::launch::{resolve_launch, wrap_with_cmd, Launch};
use crate::fs_api::simplify;
use crate::pty::home_dir;

mod opencode_process;

/// 只读文件头就够：cwd 和标题在本机实测最远 32KB（claude 的首条提问），
/// 留到 128KB 兜住"第一轮就粘贴超大内容"的极端情况。
/// 绝不读整个文件——本机有 4.3MB 的会话，一百多个文件全读是几十 MB。
///
/// codex 不走这条：它的头比别家重得多，见 CODEX_SCAN_BYTES。
const HEAD_BYTES: u64 = 128 * 1024;

/// Codex 会话的扫描上限。它第一行 session_meta 里就带整份 base_instructions（本机约 19KB），
/// 后面还有 memory、多 agent 角色等 developer 消息，真正的用户提问实测落在 120KB～390KB
/// 之间（Codex Desktop 起的会话最靠后）。固定读一段头必然漏标题，所以 codex 按行往后读、
/// 拿到标题就停，这里只是兜住"整份都是注入内容"的会话。
const CODEX_SCAN_BYTES: u64 = 2 * 1024 * 1024;

/// 先探开头这一小段找 cwd。cwd 一般写在第一条记录里，8KB 够；够不着再退回整段。
const PEEK_BYTES: u64 = 8 * 1024;

/// 返回条数上限。侧边栏那块地方只放得下十来条，剩下的靠滚动，
/// 同时兜住"某个项目目录里堆了几百个会话"的情况。
const MAX_SESSIONS: usize = 50;

/// 标题最长多少字符。一行放不下，太长也没意义
const TITLE_CHARS: usize = 60;

/// opencode 的 `session list` 要连它自己的后台服务，服务没起时更慢。
/// 前端是异步等的（命令标了 async），所以这里给宽一点，别把慢当成失败。
const OPENCODE_TIMEOUT: Duration = Duration::from_secs(20);

/// CLI 自己塞进会话里的模板文本，不是用户说的话。
/// 中断标记那条是 claude 的：本机 9 个会话的首条 user 就是它——
/// 那种会话压根没有真正的提问，显示「未命名会话」比显示这个标记诚实。
///
/// codex 那几条是它自己往会话里写的注入内容：工作区指令（AGENTS.md）、环境上下文、
/// Desktop 打开的页面占位、附件清单、以及「之前的 agent 历史」补丁。它们都以 user
/// 身份落盘，不挡掉就会变成标题。
const NOISE_PREFIXES: &[&str] = &[
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-",
    "<system-reminder",
    "<user-prompt-submit-hook",
    "[Request interrupted by user",
    "# AGENTS.md instructions",
    "<environment_context",
    "<external_codex_apps",
    "# Files mentioned by the user",
    "The following is the Codex agent history",
];

/// 把会话记录写成 jsonl 文件的那几家 CLI -> 相对用户主目录的位置。
///
/// opencode 不在这张表里：它的会话在 sqlite 库里（而且 schema 正在从 `session`
/// 迁到 `session_v2`，只读打开还读不到 WAL 里没 checkpoint 的新数据），所以改走
/// 它自己的 `session list --format json`，见 `list_opencode`。
/// 这几端都用 `/` 拼：Windows 的 Path 也认它。
fn provider_projects_dir(provider: &str) -> Option<&'static str> {
    match provider {
        "codebuddy" => Some(".codebuddy/projects"),
        "claude" => Some(".claude/projects"),
        "codex" => Some(".codex/sessions"),
        // Qoder CLI（可执行文件叫 qodercli）照抄了 claude 的布局：
        // ~/.qoder/projects/<slug>/<session-uuid>.jsonl
        "qoder" => Some(".qoder/projects"),
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

/// 列出某个 CLI 在当前工作区的会话历史。
///
/// `command` 是用户在设置里配的那条命令（`opencode`、`npx opencode`、完整路径，
/// 后面带 `--auto` 这类运行期参数也行），只有 opencode 这一支用得上——它的记录
/// 得靠 opencode 自己来读。
///
/// opencode 那一支异步等待子进程及输出，不能挡住 UI。
#[tauri::command]
pub async fn cli_list_sessions(
    provider: String,
    cwd: String,
    command: String,
) -> Result<Vec<CliSession>, String> {
    if provider == "opencode" {
        return list_opencode(&command, &cwd).await;
    }
    let relative =
        provider_projects_dir(&provider).ok_or_else(|| format!("不支持的 AI CLI: {provider}"))?;
    // 拿不到主目录、没装过这个 CLI，都当"没有会话"——列不出历史不是错误
    let Some(home) = home_dir() else {
        return Ok(Vec::new());
    };
    Ok(list_sessions_in(&home.join(relative), &provider, &cwd))
}

/// 把一条命令行拆成「可执行文件」+「前置参数」。
///
/// 用户可能填 `npx opencode` 这种带包管理器的形式，也可能填完整路径。
/// 按空白拆是最省事的做法，代价是**路径带空格就拆不对**——和 GUI 侧
/// `resolve_launch` 只认单个可执行文件是同一个约束，不在这里额外支持引号。
fn split_command(command: &str) -> Option<(String, Vec<String>)> {
    let mut parts = command.split_whitespace();
    let program = parts.next()?.to_string();
    Some((program, parts.map(str::to_string).collect()))
}

/// 列会话时实际要传的前置参数。
///
/// 用户配的命令常带运行期参数（`opencode --auto`），这些参数只对交互式启动有
/// 意义：`session list` 子命令会把它们当成非法 flag 直接报错
/// （Unrecognized flag: --auto in command opencode session）。所以只保留到 CLI
/// 名字为止——`npx -y opencode` 里 npx 的参数和包名留下，`--auto` 这类丢掉。
/// 认不出名字的写法无从判断哪些是运行期参数，按原样传。
fn session_list_command(command: &str) -> Option<(String, Vec<String>)> {
    let (program, leading) = split_command(command)?;
    let stop = std::iter::once(program.as_str())
        .chain(leading.iter().map(String::as_str))
        .position(is_opencode);
    let Some(stop) = stop else {
        return Some((program, leading));
    };
    Some((program, leading.into_iter().take(stop).collect()))
}

/// 这个参数词是不是 opencode 本身。`npx @scope/opencode`、`C:\bin\opencode.cmd`
/// 都算——和前端 `cli-sessions.ts` 的 `cliKey` 同一套规则。
fn is_opencode(token: &str) -> bool {
    let base = token
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(token)
        .to_ascii_lowercase();
    let stem = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .or_else(|| base.strip_suffix(".bat"))
        .or_else(|| base.strip_suffix(".ps1"))
        .unwrap_or(&base);
    stem == "opencode"
}

/// 借 opencode 自己列会话。
///
/// 它的输出（`--format json`）正好是我们要的字段，而且已经按项目过滤、最新在前，
/// 所以这里不重新过滤也不重排，只做数量和字段的兜底。
async fn list_opencode(command: &str, cwd: &str) -> Result<Vec<CliSession>, String> {
    let (program, leading) =
        session_list_command(command).ok_or_else(|| "没有配置 opencode 命令".to_string())?;

    // PATH 用登录 shell 解析出来的那份：从 Dock / 开始菜单启动时进程自己的 PATH
    // 可能不全（和 agent.rs 起服务时同一个理由）
    let path =
        crate::shell_env::resolved_path(&crate::shell_env::default_shell(), Some(Path::new(cwd)));
    let launch = resolve_launch(&program, path.as_deref())?;

    let mut args = leading;
    args.extend(
        ["session", "list", "--format", "json", "--max-count"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.push(MAX_SESSIONS.to_string());

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut command = match launch {
        Launch::Direct(found) => {
            let mut cmd = Command::new(found);
            cmd.args(&arg_refs);
            cmd
        }
        // Windows 上 npm 装出来的只有 .cmd 垫片，CreateProcess 不认
        Launch::ViaCmd(found) => wrap_with_cmd(&found, &arg_refs),
    };
    command.current_dir(cwd);
    let output = opencode_process::capture(command, OPENCODE_TIMEOUT)
        .await
        .map_err(|reason| format!("无法执行 {program}: {reason}"))?;

    if !output.status.success() {
        // 整段回传：opencode 的报错常常是多行，截成一行反而看不出问题在哪
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            format!("opencode session list 退出码 {:?}", output.status.code())
        } else {
            detail
        });
    }

    Ok(parse_opencode_sessions(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// 解析 `opencode session list --format json` 的输出。
///
/// 抽出来是为了能在单测里喂 JSON 字面量，不必真的装 opencode。
/// 老版本没有 `--format json`，这里会拿到表格文本、解析不出数组——返回空列表，
/// 由调用方（或"这个目录还没有会话"的空态）兜住。
fn parse_opencode_sessions(raw: &str) -> Vec<CliSession> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };

    let mut found: Vec<CliSession> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(|v| v.as_str())?;
            if id.is_empty() {
                return None;
            }
            Some(CliSession {
                id: id.to_string(),
                // opencode 自己起的标题，通常不为空；真为空就交给前端显示「未命名会话」
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                // 已经是 Unix 毫秒，和别家对齐了才回给前端
                updated: item.get("updated").and_then(|v| v.as_u64()).unwrap_or(0),
                cwd: item
                    .get("directory")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect();

    // 顺序本来就是最新在前，不再重排，只封顶
    found.truncate(MAX_SESSIONS);
    found
}

/// 标题的三个候选槽，优先级从高到低。codebuddy 三档都有，claude / qoder 只有最后一档。
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
    // 目录不存在 = 没装过 / 没跑过这个 CLI，是正常情况
    let Ok(entries) = fs::read_dir(projects) else {
        return Vec::new();
    };

    // 先把候选文件连 mtime 一起收齐：目录遍历没法并行，读文件可以
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    // 布局固定是 <项目目录>/<会话 id>.jsonl，只扫两层。旁边的 <id>/tool-results/、
    // memory/ 这些目录被"只认 .jsonl 文件"挡在外面
    for entry in entries.flatten() {
        let dir = entry.path();
        let batch: Vec<PathBuf> = if provider == "codex" {
            let mut paths = Vec::new();
            collect_jsonl_files(&dir, &mut paths);
            paths
        } else {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            entries.flatten().map(|file| file.path()).collect()
        };
        for path in batch {
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            // 开了就退的会话是 0 字节，本机一大堆（一个项目目录 16 个文件里 10 个是空的）
            if !meta.is_file() || meta.len() == 0 {
                continue;
            }
            files.push((path, mtime_ms(&meta)));
        }
    }

    // 读文件按 CPU 数切片并行：几百个会话时单线程光读文件头就要几百毫秒
    let workers = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .min(8);
    let chunk = files.len().div_ceil(workers).max(1);
    let mut found = Vec::new();
    std::thread::scope(|scope| {
        // 借出去而不是搬进去：每个线程都要用同一个目标目录
        let target = &target;
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|slice| {
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for (path, updated) in slice {
                        if let Some(session) = read_session(path, provider, target, *updated) {
                            out.push(session);
                        }
                    }
                    out
                })
            })
            .collect();
        for handle in handles {
            // 某个线程 panic 了就只丢它那一份，别把整个列表变成空
            if let Ok(part) = handle.join() {
                found.extend(part);
            }
        }
    });

    // 最近活动的在前；同毫秒并列时按 id 兜底，保证同样的磁盘状态给出同样的顺序
    found.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    found.truncate(MAX_SESSIONS);
    found
}

/// 读一个会话文件，cwd 对不上就返回 None。
///
/// 先只读开头一小段找 cwd：绝大多数文件属于别的项目，到此为止就够了（128KB 全读
/// 一遍的话，几百个会话就是几十 MB）。命中的才读满 HEAD_BYTES 去抠标题。
///
/// 开头这段没读出 cwd（第一条就是一大段粘贴内容之类）时退回整段重扫，别漏掉会话。
fn read_session(path: &Path, provider: &str, target: &str, updated: u64) -> Option<CliSession> {
    // codex 的标题落在头部 128KB 之后是常态，得单独按行往后读
    if provider == "codex" {
        return read_codex_session(path, target, updated);
    }
    if let Some(scan) = read_prefix(path, PEEK_BYTES).and_then(|peek| scan_head(&peek, provider)) {
        // 按 cwd 字段正向匹配。不去反算 slug——slug 有损，路径里本身的 '-'
        // 和分隔符是撞的，各家 CLI 的规则还不一样
        if cwd_key(&scan.cwd) != target {
            return None;
        }
    }
    let head = read_head(path)?;
    let scan = scan_head(&head, provider)?;
    if cwd_key(&scan.cwd) != target {
        return None;
    }
    let id = path.file_stem().and_then(|stem| stem.to_str())?;
    Some(CliSession {
        id: id.to_string(),
        title: scan.title,
        updated,
        cwd: scan.cwd,
    })
}

/// 读一个 Codex 会话文件。
///
/// 不能像别家那样"读一段头就够"：真正的提问在 120KB～390KB 之后（见 CODEX_SCAN_BYTES）。
/// 所以按行往后读，拿到第一条像样的用户输入就停；cwd 只认第一行的 session_meta，
/// 对不上（绝大多数文件属于别的项目）立刻返回，不为别的项目白读几百 KB。
///
/// resume 用的是 session_meta 里的 UUID 而不是文件名：文件名带 rollout- 前缀和时间戳。
fn read_codex_session(path: &Path, target: &str, updated: u64) -> Option<CliSession> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut titles = Titles::default();
    let mut cwd = String::new();
    let mut id = None;
    let mut consumed = 0u64;
    let mut buf = Vec::new();

    while consumed < CODEX_SCAN_BYTES {
        buf.clear();
        let read = reader.read_until(b'\n', &mut buf).ok()?;
        if read == 0 {
            break;
        }
        consumed += read as u64;
        // 整行都读到了，不会切在多字节序列中间；lossy 只是兜住万一写坏的字节
        let line = String::from_utf8_lossy(&buf);
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue; // 非 JSON 的行，丢掉继续
        };
        if cwd.is_empty() {
            if let Some(text) = value
                .pointer("/payload/cwd")
                .or_else(|| value.get("cwd"))
                .and_then(|v| v.as_str())
            {
                cwd = text.to_string();
                if cwd_key(&cwd) != target {
                    return None;
                }
            }
        }
        // 只认 session_meta 里的 id：response_item 也带 payload.id，但那是 msg_ 开头的
        // 消息 id，拿去 resume 会失败
        if id.is_none() && value.get("type").and_then(|v| v.as_str()) == Some("session_meta") {
            id = value
                .pointer("/payload/id")
                .and_then(|v| v.as_str())
                .filter(|value| !value.is_empty())
                .map(str::to_string);
        }
        scan_codex(&value, &mut titles);
        if !titles.first.is_empty() {
            break;
        }
    }

    // 抠不出 cwd 就没法归属到哪个项目，只能丢
    if cwd.is_empty() || cwd_key(&cwd) != target {
        return None;
    }
    let stem = path.file_stem().and_then(|stem| stem.to_str())?;
    Some(CliSession {
        id: id.unwrap_or_else(|| stem.to_string()),
        title: titles.pick(),
        updated,
        cwd,
    })
}

fn collect_jsonl_files(path: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, output);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

fn read_head(path: &Path) -> Option<String> {
    read_prefix(path, HEAD_BYTES)
}

/// 读文件开头最多 `limit` 字节。
///
/// 用 lossy 而不是严格 UTF-8：截断处可能刚好落在多字节序列中间，替换成 U+FFFD
/// 就行——那一行本来就是半行，JSON 解析必然失败被跳过，前面完整的行不受影响。
fn read_prefix(path: &Path, limit: u64) -> Option<String> {
    // take() 按值吃掉 file，所以不用 mut
    let file = fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(limit as usize);
    file.take(limit).read_to_end(&mut buf).ok()?;
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
            let text = value
                .get("cwd")
                .and_then(|v| v.as_str())
                .or_else(|| value.pointer("/payload/cwd").and_then(|v| v.as_str()));
            if let Some(text) = text {
                cwd = text.to_string();
            }
        }
        match provider {
            "codebuddy" => scan_codebuddy(&value, &mut titles),
            "claude" => scan_claude(&value, &mut titles),
            "qoder" => scan_claude(&value, &mut titles),
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

fn scan_codex(value: &serde_json::Value, titles: &mut Titles) {
    if !titles.first.is_empty() {
        return;
    }
    let payload = value.get("payload");
    let is_user = payload.and_then(|v| v.get("type")).and_then(|v| v.as_str())
        == Some("user_message")
        || payload.and_then(|v| v.get("role")).and_then(|v| v.as_str()) == Some("user");
    if !is_user {
        return;
    }
    let title = payload
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
        .and_then(non_empty_title)
        .or_else(|| codex_content_title(payload.and_then(|v| v.get("content"))));

    // Codex 新版把工作区指令、环境上下文、附件清单这些注入内容都以 user 身份写进日志；
    // 它们不是用户这轮对话的标题。clean_title 按 NOISE_PREFIXES 丢掉后继续往下扫，
    // 才能拿到后面真正的提问，而旧版 event_msg 格式仍走同一条路径。
    if let Some(title) = title {
        titles.first = title;
    }
}

fn non_empty_title(text: &str) -> Option<String> {
    let title = clean_title(text);
    (!title.is_empty()).then_some(title)
}

fn codex_content_title(content: Option<&serde_json::Value>) -> Option<String> {
    match content {
        Some(serde_json::Value::String(text)) => non_empty_title(text),
        Some(serde_json::Value::Array(_)) => non_empty_title(&block_text(content, "input_text")),
        _ => None,
    }
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

/// claude 的记录形状：顶层 type=user，正文在 message.content（字符串或内容块数组）。
/// qoder 的 jsonl 基本照抄了这一套（多一个 humanInput.text，但和 message.content
/// 是同一句话，用不上），所以两家共用这一个扫描器。
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
            "codovo-cli-sessions-{}-{unique}",
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
            &[
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"在当前项目里干活"}],"cwd":"/Users/someone/work"}"#,
            ],
        );
        // 同一个 slug 目录下也可能混着别的 cwd（slug 有损，两个不同路径可能撞进一个目录）
        write_session(
            &projects,
            "-Users-someone-work",
            "bbbb-2222",
            &[
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"别的目录"}],"cwd":"/Users/someone/other"}"#,
            ],
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
    fn recognizes_supported_providers() {
        assert!(provider_projects_dir("opencode").is_none());
        assert!(provider_projects_dir("codebuddy").is_some());
        assert!(provider_projects_dir("claude").is_some());
        assert!(provider_projects_dir("codex").is_some());
        assert!(provider_projects_dir("qoder").is_some());
    }

    /// Qoder 的目录布局和记录形状都跟 claude 一样（<slug>/<id>.jsonl、type=user +
    /// message.content），所以走 scan_claude。这里钉住三件事：文件名当 id、按 cwd
    /// 过滤、标题取第一条真正的人说的话。
    #[test]
    fn qoder_takes_first_real_prompt_and_uses_file_stem_as_id() {
        let projects = temp_projects();
        write_session(
            &projects,
            "D--CodeProjects-codovo",
            "4da63787-3b3a-4168-aa1d-d4467fd04675",
            &[
                r#"{"type":"workspace-directories","sessionId":"4da63787-3b3a-4168-aa1d-d4467fd04675","directories":["/Users/someone/work"]}"#,
                // 工具结果回灌也是 type=user，但不是人说的话
                r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","content":"No files found"}]},"cwd":"/Users/someone/work"}"#,
                r#"{"type":"user","isSidechain":false,"origin":{"kind":"human"},"humanInput":{"text":"将软件所有的图标重绘"},"message":{"role":"user","content":"将软件所有的图标重绘"},"cwd":"/Users/someone/work"}"#,
            ],
        );
        // slug 有损，同一个目录里可能混着别的 cwd
        write_session(
            &projects,
            "D--CodeProjects-codovo",
            "bbbb-2222",
            &[
                r#"{"type":"user","message":{"role":"user","content":"别的目录"},"cwd":"/Users/someone/other"}"#,
            ],
        );

        let found = list_sessions_in(&projects, "qoder", WORK);
        assert_eq!(found.len(), 1);
        // resume 要的是文件名词干（记录里的 sessionId 也是它，但以文件名为准）
        assert_eq!(found[0].id, "4da63787-3b3a-4168-aa1d-d4467fd04675");
        assert_eq!(found[0].title, "将软件所有的图标重绘");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn lists_codex_sessions_from_nested_date_dirs() {
        let projects = temp_projects();
        write_session(
            &projects.join("2026").join("03").join("17"),
            "ignored",
            "rollout-2026-03-17T00-00-00-12345678-aaaa-bbbb",
            &[
                r#"{"timestamp":"2026-03-17T00:00:00Z","type":"session_meta","payload":{"id":"session-uuid","cwd":"/Users/someone/work"}}"#,
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"修复 Codex 历史"}}"#,
            ],
        );
        let found = list_sessions_in(&projects, "codex", WORK);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "session-uuid");
        assert_eq!(found[0].title, "修复 Codex 历史");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn codex_skips_injected_workspace_context_when_naming_sessions() {
        let projects = temp_projects();
        write_session(
            &projects.join("2026").join("03").join("17"),
            "ignored",
            "rollout-2026-03-17T00-00-00-12345678-cccc-dddd",
            &[
                r#"{"type":"session_meta","payload":{"id":"session-context","cwd":"/Users/someone/work"}}"#,
                r##"{"type":"message","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/someone/work\n\n<INSTRUCTIONS>..."}]}}"##,
                r#"{"type":"message","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"优化 Codex 历史对话名称"}]}}"#,
            ],
        );

        let found = list_sessions_in(&projects, "codex", WORK);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "优化 Codex 历史对话名称");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn codex_finds_the_title_beyond_the_plain_head_limit() {
        let projects = temp_projects();
        let dir = projects.join("2026").join("03").join("18");
        fs::create_dir_all(&dir).unwrap();
        // Codex 的头部有整份 base_instructions + memory + 多 agent 角色，本机实测真正的
        // 提问落在 120KB～390KB 之后。这里用一个 200KB 的 developer 消息复现那个形状。
        let filler = "x".repeat(200 * 1024);
        let lines = [
            r#"{"type":"session_meta","payload":{"id":"session-big","cwd":"/Users/someone/work"}}"#
                .to_string(),
            format!(
                r#"{{"type":"response_item","payload":{{"type":"message","role":"developer","content":[{{"type":"input_text","text":"{filler}"}}]}}}}"#
            ),
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"补充常用 AI CLI 的图标"}]}}"#
                .to_string(),
        ];
        fs::write(
            dir.join("rollout-2026-03-18T00-00-00-12345678-eeee-ffff.jsonl"),
            lines.join("\n"),
        )
        .unwrap();
        // 同一个目录里放一个别的项目的会话：读第一行就该跳过，不该被算进来
        let other = [
            r#"{"type":"session_meta","payload":{"id":"session-other","cwd":"/Users/someone/other"}}"#
                .to_string(),
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"别的目录"}]}}"#
                .to_string(),
        ];
        fs::write(
            dir.join("rollout-2026-03-18T00-00-01-12345678-aaaa-bbbb.jsonl"),
            other.join("\n"),
        )
        .unwrap();

        let found = list_sessions_in(&projects, "codex", WORK);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "session-big");
        assert_eq!(found[0].title, "补充常用 AI CLI 的图标");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn codex_skips_injected_app_and_attachment_blocks() {
        let projects = temp_projects();
        let dir = projects.join("2026").join("03").join("19");
        fs::create_dir_all(&dir).unwrap();
        let lines = [
            r#"{"type":"session_meta","payload":{"id":"session-noise","cwd":"/Users/someone/work"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":" # Files mentioned by the user: ## shot.png: C:/tmp/shot.png"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"确认"}]}}"#,
        ];
        fs::write(
            dir.join("rollout-2026-03-19T00-00-00-12345678-cccc-dddd.jsonl"),
            lines.join("\n"),
        )
        .unwrap();

        let found = list_sessions_in(&projects, "codex", WORK);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "确认");
        fs::remove_dir_all(&projects).ok();
    }

    #[test]
    fn splits_the_configured_command() {
        assert_eq!(
            split_command("opencode"),
            Some(("opencode".to_string(), Vec::new()))
        );
        // 带包管理器的形式：program 是 npx，opencode 变成前置参数
        assert_eq!(
            split_command("npx opencode"),
            Some(("npx".to_string(), vec!["opencode".to_string()]))
        );
        assert_eq!(
            split_command("  /opt/bin/opencode  "),
            Some(("/opt/bin/opencode".to_string(), Vec::new()))
        );
        // 空串 / 只有空白都拆不出 program
        assert_eq!(split_command(""), None);
        assert_eq!(split_command("   "), None);
    }

    #[test]
    fn session_list_keeps_launcher_args_but_drops_runtime_flags() {
        let leading = |command: &str| session_list_command(command).unwrap().1;

        // 运行期参数只对交互式启动有效，session list 不认，必须丢掉
        assert!(leading("opencode --auto").is_empty());
        assert!(leading(r"C:\tools\opencode.cmd --auto").is_empty());
        // 包管理器和它自己的参数要留下，否则起不来
        assert_eq!(leading("npx opencode"), vec!["opencode"]);
        assert_eq!(leading("npx -y opencode"), vec!["-y", "opencode"]);
        // CLI 名字之后的运行期参数丢掉，之前的都保留
        assert_eq!(
            leading("npx -y @sst/opencode --auto"),
            vec!["-y", "@sst/opencode"]
        );
        // 认不出 CLI 名时无从判断，按原样传
        assert_eq!(
            leading("npx -y some-wrapper --auto"),
            vec!["-y", "some-wrapper", "--auto"]
        );
    }

    #[test]
    fn parses_opencode_json_output() {
        let raw = r#"[
          {"id":"ses_aaa","title":"修 auth 中间件","updated":1773762499903,
           "created":1773762497649,"projectId":"p1","directory":"/Users/someone/work"},
          {"id":"ses_bbb","title":"","updated":1773762405278,"directory":"/Users/someone/work"}
        ]"#;
        let found = parse_opencode_sessions(raw);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, "ses_aaa");
        assert_eq!(found[0].title, "修 auth 中间件");
        // 已经是毫秒，不该被再折算一次
        assert_eq!(found[0].updated, 1773762499903);
        assert_eq!(found[0].cwd, "/Users/someone/work");
        // 标题为空时留空串，交给前端显示「未命名会话」
        assert_eq!(found[1].title, "");
    }

    #[test]
    fn opencode_parser_tolerates_junk() {
        // 空目录就是这么答的
        assert!(parse_opencode_sessions("[]").is_empty());
        // 老版本没有 --format json，吐的是表格文本
        assert!(parse_opencode_sessions("ses_aaa\t标题\t3/17/2026").is_empty());
        // 缺 id 的条目要丢掉，不能让后面几条跟着陪葬
        let raw = r#"[{"title":"没有 id"},{"id":"ses_ok","title":"好的","updated":1}]"#;
        let found = parse_opencode_sessions(raw);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "ses_ok");
        // 缺 updated / directory 时回落 0 和空串，不能 panic
        let bare = parse_opencode_sessions(r#"[{"id":"ses_x"}]"#);
        assert_eq!(bare.len(), 1);
        assert_eq!(bare[0].updated, 0);
        assert_eq!(bare[0].cwd, "");
        // 顶层不是数组
        assert!(parse_opencode_sessions(r#"{"sessions":[]}"#).is_empty());
    }
}
