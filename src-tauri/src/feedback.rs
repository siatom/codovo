//! 意见反馈：把用户填的内容直接建成 Gitee issue，并在本地留一份记录用于跟踪状态。
//!
//! **为什么走本机 gitee CLI 而不是自己发 HTTP**：Gitee 前面挂着 WAF（响应带
//! `bdwaf-request-id`），按客户端指纹放行。同一令牌、同一 URL、同一秒，curl /
//! PowerShell / openssl / WebView fetch / 官方 CLI 都能过，只有 reqwest 的请求被固定
//! 判成「令牌不存在」（401）——rustls 和 SChannel 两种后端都试过，HTTP 层能改的都改过。
//! 顺带的好处是令牌完全不用进本应用：CLI 自己存凭据，我们既不碰钥匙串也不碰明文。
//!
//! **Windows 上 npm 装的 `gitee` 只有 `.cmd` 垫片**：`CreateProcess` 不认垫片，得借
//! cmd.exe 起，而 cmd.exe 按换行切命令行——实测多行正文只留下第一行。所以垫片这条改成
//! 用 node 跑它的入口脚本（垫片自己干的就是这件事），参数走 argv，多行原样送达。
//! 原生 exe（go install / release 包）直接 spawn 即可，参数数组天然安全。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::agent::{hide_console, resolve_launch, Launch};

/// 反馈目标的仓库。换仓库只改这两行——网页兜底地址也由它们拼出来。
const OWNER: &str = "silicon-atom";
const REPO: &str = "code-dock";

/// 官方 CLI 的命令名，走 PATH 找（复用 agent 那套 Windows 后缀探测）。
const CLI: &str = "gitee";

/// npm 包装层里入口脚本相对垫片所在目录的位置。垫片内容就是
/// `node <pkgroot>/bin/index.js %*`，只是它得经 cmd.exe 才跑得起来，会被换行截断。
///
/// 只有 Windows 版 `shim_to_node` 用它（别的平台垫片自己就能跑），跟着一起 cfg，
/// 否则在 macOS / Linux 上会因「当前平台用不到」报 dead_code。
#[cfg(windows)]
const NPM_ENTRY: &str = "node_modules/@gitee/gitee-cli/bin/index.js";

/// 单次调用的超时。CLI 是本地进程，正常几百毫秒内返回。
const CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// 出错时回传给界面的输出片段上限，别把整段日志塞进弹窗。
const MAX_ERROR_CHARS: usize = 500;

/// 记录文件名，落在 `app_config_dir()` 下（与 opencode 配置同级）。
const STORE_FILE: &str = "feedback.json";

/// 一条提交过的反馈。字段刻意保持精简：正文和大段讨论都在 Gitee 那边，
/// 这里只是「本机提过什么、现在什么状态」的索引。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackRecord {
    /// Gitee issue 编号，形如 `IKIHSS`——**不是**数字 id
    pub number: String,
    pub title: String,
    /// 网页地址，界面点它跳浏览器
    pub url: String,
    /// open / progressing / closed / rejected
    pub state: String,
    /// bug / feature / other
    pub category: String,
    /// 提交时间（毫秒时间戳）
    pub created_at: i64,
    /// 最近一次刷新状态的时间（毫秒时间戳）
    pub updated_at: i64,
}

/// 落盘的外壳。套一层对象而不是裸数组，将来加字段不用改文件格式。
#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    records: Vec<FeedbackRecord>,
}

/// 刷新结果：能更新的更新，坏掉的单独报出来。
///
/// 不因一条查不到就让整次刷新失败——那样一条失效编号会永远挡住其余记录的状态。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub records: Vec<FeedbackRecord>,
    /// 每条失败的原因，界面原样提示
    pub errors: Vec<String>,
}

/// 反馈目标的描述，给前端拼网页地址用（CLI 不可用时的兜底路径）。
///
/// 刻意让后端当唯一来源：仓库写在上面的常量里，前端再抄一份迟早会漂移。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackTarget {
    pub owner: String,
    pub repo: String,
    /// 新建 issue 的网页地址，前端在它后面接预填参数
    pub web_new_issue: String,
}

/// gitee CLI 能不能用。没装 / 没登录都要如实告诉界面，好让它切到网页兜底。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// PATH 里找不找得到 CLI
    pub available: bool,
    /// `gitee auth status` 是否成功（CLI 自己那套凭据）
    pub logged_in: bool,
    /// 给用户看的原文：找不到时的提示，或 CLI 自己吐的原因
    pub detail: String,
}

/// 按字符截断（按字节切会在多字节字符上 panic）。
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// 从 Gitee 返回的 issue 对象里取编号 / 网页地址 / 状态。
///
/// 用 `Value` 逐层取而不是定义严格结构体：Gitee 换字段名或加字段时，反序列化
/// 失败会把整个功能打死，逐层取最多少一个字段。缺编号就没法跟踪，那才算失败。
fn parse_issue(value: &serde_json::Value) -> Result<(String, String, String), String> {
    let number = value
        .get("number")
        .and_then(|item| item.as_str())
        .filter(|item| !item.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "Gitee 响应里没有 issue 编号: {}",
                truncate(&value.to_string(), MAX_ERROR_CHARS)
            )
        })?
        .to_string();

    // html_url 缺失时自己拼一个：链接是给人点的，不能因为少个字段就变成死文本
    let url = value
        .get("html_url")
        .and_then(|item| item.as_str())
        .filter(|item| !item.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://gitee.com/{OWNER}/{REPO}/issues/{number}"));

    // 状态读不到时当 open：刚建出来的必然没关，比空字符串好判断
    let state = value
        .get("state")
        .and_then(|item| item.as_str())
        .unwrap_or("open")
        .to_string();

    Ok((number, url, state))
}

/// 把一次查询到的状态写回对应记录。找不到编号就原样返回 `false`（记录可能
/// 已被用户删掉，不是错误）。
fn apply_state(records: &mut [FeedbackRecord], number: &str, state: &str) -> bool {
    match records.iter_mut().find(|item| item.number == number) {
        Some(record) => {
            record.state = state.to_string();
            record.updated_at = now_ms();
            true
        }
        None => false,
    }
}

/// 记录文件路径。目录可能还不存在，写的时候会建。
fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|reason| format!("拿不到配置目录: {reason}"))?
        .join(STORE_FILE))
}

/// 从磁盘读记录。文件不存在 = 从没提过反馈（空列表，不是错误）；
/// 但**解析失败要报错**——那意味着用户的历史还在文件里，静默当空列表会让下一次
/// 落盘把它覆盖掉。
fn read_from(path: &Path) -> Result<Vec<FeedbackRecord>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(reason) if reason.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(reason) => return Err(format!("读取反馈记录失败: {reason}")),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let store: Store = serde_json::from_str(&text)
        .map_err(|reason| format!("反馈记录文件已损坏（{}）: {reason}", path.display()))?;
    Ok(store.records)
}

/// 写回磁盘。先写临时文件再 rename：中途断电 / 崩了也不会留下半截 JSON，
/// 那样下次连读都读不出来。
fn write_to(path: &Path, records: &[FeedbackRecord]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|reason| format!("创建配置目录失败: {reason}"))?;
    }
    let store = Store {
        records: records.to_vec(),
    };
    let text = serde_json::to_string_pretty(&store)
        .map_err(|reason| format!("序列化反馈记录失败: {reason}"))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|reason| format!("写入反馈记录失败: {reason}"))?;
    std::fs::rename(&temp, path).map_err(|reason| format!("保存反馈记录失败: {reason}"))
}

/// Windows 上 npm 装出来的垫片得换成「node + 入口脚本」，理由见模块头。
///
/// 只在垫片旁边找入口脚本：npm 的全局 bin 目录和包目录是固定的相对位置。
/// 找不到就报错让用户改用原生 exe，不去别处瞎猜。
#[cfg(windows)]
fn shim_to_node(shim: &Path, args: &[String]) -> Result<Command, String> {
    let entry = shim
        .parent()
        .map(|dir| dir.join(NPM_ENTRY))
        .filter(|path| path.is_file())
        .ok_or_else(|| format!("找不到 gitee CLI 的入口脚本（{NPM_ENTRY}），请改装原生版 gitee"))?;
    // node 跟着 npm 一起来，PATH 里应该有；没有就让 Command 自己报错
    let node = crate::agent::find_on_path("node", std::env::var_os("PATH").as_deref())
        .unwrap_or_else(|| PathBuf::from("node"));
    let mut command = Command::new(node);
    command.arg(entry).args(args);
    Ok(command)
}

/// 非 Windows 上 npm 的垫片是个 shell 脚本，Process 直接能跑，不用绕。
#[cfg(not(windows))]
fn shim_to_node(shim: &Path, args: &[String]) -> Result<Command, String> {
    let mut command = Command::new(shim);
    command.args(args);
    Ok(command)
}

/// 把 `gitee <args>` 解析成一个能 spawn 的命令。
fn cli_command(args: &[String]) -> Result<Command, String> {
    // GUI 进程从 Dock / 开始菜单启动时 PATH 可能不全，和起 opencode 时同一个理由
    let path = crate::shell_env::resolved_path(&crate::shell_env::default_shell(), None);
    let launch = resolve_launch(CLI, path.as_deref()).map_err(|_| {
        "在 PATH 里找不到 gitee 命令。请先安装官方 CLI（npm i -g @gitee/gitee-cli）\
         并执行 gitee auth login"
            .to_string()
    })?;
    match launch {
        Launch::Direct(found) => {
            let mut command = Command::new(found);
            command.args(args);
            Ok(command)
        }
        Launch::ViaCmd(found) => shim_to_node(&found, args),
    }
}

/// 跑一次 CLI 并收下 stdout。失败时把 stderr（没有就 stdout）整段带出来——
/// Gitee 的报错常常多行，截成一句反而看不出问题在哪。
fn run_cli(args: &[String]) -> Result<String, String> {
    let mut command = cli_command(args)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);

    // 起线程 + recv_timeout：Command 自己没有超时，卡住的进程会把调用它的线程一起带走
    // （同 cli_sessions.rs 的写法）
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(command.output());
    });
    let output = match receiver.recv_timeout(CLI_TIMEOUT) {
        Ok(Ok(output)) => output,
        Ok(Err(reason)) => return Err(format!("无法执行 gitee: {reason}")),
        Err(_) => return Err(format!("gitee 超过 {} 秒没有响应", CLI_TIMEOUT.as_secs())),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() { &stdout } else { &stderr };
        return Err(if detail.is_empty() {
            "gitee 命令执行失败，没有输出".to_string()
        } else {
            truncate(detail, MAX_ERROR_CHARS)
        });
    }
    Ok(stdout)
}

#[tauri::command]
pub fn feedback_target() -> FeedbackTarget {
    FeedbackTarget {
        owner: OWNER.to_string(),
        repo: REPO.to_string(),
        web_new_issue: format!("https://gitee.com/{OWNER}/{REPO}/issues/new"),
    }
}

/// CLI 是否可用、是否已登录。界面据此决定给「提交反馈」还是「在浏览器中打开」。
#[tauri::command]
pub fn feedback_cli_status() -> CliStatus {
    let args: Vec<String> = ["auth", "status", "--no-tui"]
        .iter()
        .map(|item| item.to_string())
        .collect();
    if let Err(reason) = cli_command(&args) {
        return CliStatus {
            available: false,
            logged_in: false,
            detail: reason,
        };
    }
    match run_cli(&args) {
        // 成功时 CLI 会打印「Logged in to gitee.com as …」，界面用不上，不带回去了
        Ok(_) => CliStatus {
            available: true,
            logged_in: true,
            detail: String::new(),
        },
        Err(reason) => CliStatus {
            available: true,
            logged_in: false,
            detail: reason,
        },
    }
}

/// 列出本机提交过的反馈记录。
#[tauri::command]
pub fn feedback_list(app: tauri::AppHandle) -> Result<Vec<FeedbackRecord>, String> {
    read_from(&store_path(&app)?)
}

/// 提交一条反馈：借 CLI 建成 Gitee issue，并把索引记到本地。
///
/// `body` 由前端拼好（分类行 + 正文 + 环境信息）——浏览器兜底路径也要用同一段文案，
/// 放前端一处生成才不会两边漂移。
#[tauri::command]
pub fn feedback_submit(
    app: tauri::AppHandle,
    title: String,
    body: String,
    category: String,
) -> Result<FeedbackRecord, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("请先填个标题".to_string());
    }
    let path = store_path(&app)?;

    // repo 用 -R 显式指定：工作区可能根本不是这个仓库，不能靠 CLI 去推断
    let repo = format!("{OWNER}/{REPO}");
    let args: Vec<String> = [
        "issue", "create", "-R", &repo, "--no-tui", "-j", "-t", &title, "-b", &body,
    ]
    .iter()
    .map(|item| item.to_string())
    .collect();
    let stdout = run_cli(&args)?;

    let value: serde_json::Value = serde_json::from_str(&stdout).map_err(|_| {
        format!(
            "无法解析 gitee 的输出: {}",
            truncate(&stdout, MAX_ERROR_CHARS)
        )
    })?;
    let (number, url, state) = parse_issue(&value)?;

    let record = FeedbackRecord {
        number,
        title,
        url,
        state,
        category,
        created_at: now_ms(),
        updated_at: now_ms(),
    };

    // 落盘失败时 issue 其实已经建出去了，把编号一起报出来，用户还能手动去追
    let mut records = read_from(&path)?;
    records.insert(0, record.clone());
    write_to(&path, &records).map_err(|reason| {
        format!(
            "{reason}（issue 已创建：{}，编号 {}）",
            record.url, record.number
        )
    })?;
    Ok(record)
}

/// 逐条刷新提交过的反馈状态。
#[tauri::command]
pub fn feedback_refresh(app: tauri::AppHandle) -> Result<RefreshResult, String> {
    let path = store_path(&app)?;
    let mut records = read_from(&path)?;
    if records.is_empty() {
        return Ok(RefreshResult {
            records,
            errors: Vec::new(),
        });
    }

    let repo = format!("{OWNER}/{REPO}");
    let mut errors = Vec::new();
    // 单条失败只记不动：编号可能是仓库侧被删了，其余记录的状态照样该刷新
    for record in records.clone() {
        let args: Vec<String> = [
            "issue",
            "view",
            "-R",
            &repo,
            "--no-tui",
            "-j",
            &record.number,
        ]
        .iter()
        .map(|item| item.to_string())
        .collect();
        let parsed = run_cli(&args).and_then(|stdout| {
            serde_json::from_str::<serde_json::Value>(&stdout)
                .map_err(|_| format!("无法解析 gitee 的输出: {}", truncate(&stdout, 120)))
        });
        match parsed.and_then(|value| parse_issue(&value)) {
            Ok((number, _, state)) => {
                apply_state(&mut records, &number, &state);
            }
            Err(reason) => errors.push(format!("#{} {reason}", record.number)),
        }
    }
    // 状态更新也要落盘，否则下次打开界面看到的还是旧状态
    write_to(&path, &records)?;
    Ok(RefreshResult { records, errors })
}

/// 从本地历史里删掉一条。只清索引，**不动 Gitee 上的 issue**。
#[tauri::command]
pub fn feedback_delete(
    app: tauri::AppHandle,
    number: String,
) -> Result<Vec<FeedbackRecord>, String> {
    let path = store_path(&app)?;
    let mut records = read_from(&path)?;
    records.retain(|item| item.number != number);
    write_to(&path, &records)?;
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(number: &str, state: &str) -> FeedbackRecord {
        FeedbackRecord {
            number: number.to_string(),
            title: format!("标题 {number}"),
            url: format!("https://gitee.com/{OWNER}/{REPO}/issues/{number}"),
            state: state.to_string(),
            category: "bug".to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn parse_issue_reads_the_three_fields() {
        let value = serde_json::json!({
            "id": 34455196,
            "number": "IKIHSS",
            "state": "open",
            "html_url": "https://gitee.com/y_project/RuoYi/issues/IKIHSS",
        });
        let (number, url, state) = parse_issue(&value).unwrap();
        assert_eq!(number, "IKIHSS");
        assert_eq!(url, "https://gitee.com/y_project/RuoYi/issues/IKIHSS");
        assert_eq!(state, "open");
    }

    #[test]
    fn parse_issue_falls_back_for_missing_optional_fields() {
        // 少了链接和状态仍要能用：链接自己拼，状态按刚创建算 open
        let value = serde_json::json!({ "number": "IKING7" });
        let (number, url, state) = parse_issue(&value).unwrap();
        assert_eq!(number, "IKING7");
        assert!(url.ends_with("/issues/IKING7"));
        assert_eq!(state, "open");
    }

    #[test]
    fn parse_issue_rejects_a_response_without_number() {
        // 没有编号就没法跟踪，这算真失败，且提示里要带上原文片段
        let value = serde_json::json!({ "message": "Not Found Project" });
        let error = parse_issue(&value).unwrap_err();
        assert!(error.contains("编号"));
        assert!(error.contains("Not Found Project"));
    }

    #[test]
    fn apply_state_only_touches_the_matching_record() {
        let mut records = vec![sample("IKIHSS", "open"), sample("IKING7", "open")];
        assert!(apply_state(&mut records, "IKING7", "closed"));
        assert_eq!(records[0].state, "open");
        assert_eq!(records[1].state, "closed");
        // 记不存在的编号不是错误，只是没改到东西
        assert!(!apply_state(&mut records, "IUNKNOWN", "closed"));
    }

    #[test]
    fn store_round_trips_through_the_file() {
        let dir = std::env::temp_dir().join("codedock-feedback-test");
        let path = dir.join("feedback.json");
        let _ = std::fs::remove_file(&path);

        // 还没写过：空列表，不是错误
        assert!(read_from(&path).unwrap().is_empty());

        let records = vec![sample("IKIHSS", "open"), sample("IKING7", "closed")];
        write_to(&path, &records).unwrap();
        let loaded = read_from(&path).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[1].number, "IKING7");
        assert_eq!(loaded[1].state, "closed");

        // 临时文件不该留下（rename 掉了）
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_from_reports_a_corrupted_file_instead_of_emptying_it() {
        let dir = std::env::temp_dir().join("codedock-feedback-test-corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("feedback.json");
        std::fs::write(&path, "{ 这不是 json").unwrap();
        // 必须报错：静默返回空列表会让下一次落盘覆盖掉用户的历史
        assert!(read_from(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn truncate_cuts_on_char_boundary() {
        assert_eq!(truncate("abcdef", 6), "abcdef");
        assert_eq!(truncate("中文中文", 2), "中文");
    }

    #[test]
    fn target_points_at_the_expected_repository() {
        // 换仓库时改的是上面两行常量，这条把「改了但没改全」钉住
        let target = feedback_target();
        assert_eq!(target.owner, "silicon-atom");
        assert_eq!(target.repo, "code-dock");
        assert!(target
            .web_new_issue
            .ends_with("/silicon-atom/code-dock/issues/new"));
    }
}
