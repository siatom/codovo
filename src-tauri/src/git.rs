use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::fs_api::{self, FsState};

/// 只读查询的超时：本地仓库的 status 通常几十毫秒。超时只作废这一次查询，
/// 前端继续显示上一次的状态，界面不会被拖住。
const TIMEOUT: Duration = Duration::from_secs(5);

/// 写操作的超时：add/commit 在超大仓库上比 status 慢得多
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// 单次回传的条目上限。正常项目远到不了这个量级，设上限是防止异常仓库
/// （比如刚 clone 下来、.gitignore 还没写）把 IPC 和渲染拖垮。
const MAX_ENTRIES: usize = 4000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// 绝对路径（原生分隔符），打开文件用
    path: String,
    /// 工作区相对路径（正斜杠），改动列表显示用
    relative: String,
    /// porcelain v2 的 XY 两列：X 是暂存区状态，Y 是工作区状态
    index: char,
    worktree: char,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    /// 改动条目总数，可能大于 files.len()（见 MAX_ENTRIES）
    changed: u32,
    files: Vec<FileStatus>,
}

impl GitStatus {
    fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            changed: 0,
            files: Vec::new(),
        }
    }
}

/// 一个改动文件的两侧内容，给 Monaco 的 diff 编辑器用。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// 基线侧。这个版本里没有该路径（新增/未跟踪）时是空串
    original: String,
    /// 当前侧。文件被删掉时是空串
    modified: String,
    /// 任一侧是二进制
    is_binary: bool,
    /// 任一侧超过 MAX_TEXT_SIZE
    too_large: bool,
}

/// 差异跟谁比。前端传的就是这个结构（serde 标签联合）。
///
/// 用枚举而不是"一个 staged 布尔 + 一个可选 rev"：后者到了调用处还得再判断
/// 一次“到底看哪个”，容易写漏；枚举让每种组合在编译期就是穷尽的。
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum DiffSource {
    /// index ↔ 工作区
    Unstaged,
    /// HEAD ↔ index
    Staged,
    /// `<rev>^` ↔ `<rev>`
    Commit { rev: String },
}

/// 提交历史里的一条。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    hash: String,
    short: String,
    author: String,
    /// Unix 秒，界面自己折算成"多久前"
    time: i64,
    subject: String,
}

/// 某个提交里改动的一个文件。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// 绝对路径，点开差异用
    path: String,
    /// 工作区相对路径（正斜杠），显示用
    relative: String,
    /// A / M / D / R / C
    status: char,
}

/// 一侧的内容。不存在和"读不出来"是两回事，后面的合成要看这个区分。
#[derive(Debug)]
enum Side {
    /// 该版本里没有这个路径（新增、未跟踪、已删除）
    Missing,
    TooLarge,
    Binary,
    Text(String),
}

impl Side {
    fn text(self) -> String {
        match self {
            Side::Text(text) => text,
            _ => String::new(),
        }
    }

    fn is_binary(&self) -> bool {
        matches!(self, Side::Binary)
    }

    fn is_too_large(&self) -> bool {
        matches!(self, Side::TooLarge)
    }
}

/// 两侧合成最终结果：太大或二进制时两侧都给空串，前端据此只显示一条提示。
fn to_diff(original: Side, modified: Side) -> FileDiff {
    let too_large = original.is_too_large() || modified.is_too_large();
    let is_binary = original.is_binary() || modified.is_binary();
    if too_large || is_binary {
        return FileDiff {
            original: String::new(),
            modified: String::new(),
            is_binary,
            too_large,
        };
    }
    FileDiff {
        original: original.text(),
        modified: modified.text(),
        is_binary: false,
        too_large: false,
    }
}

/// 起一个 git 进程并把输出拿回来。
///
/// `Err` 表示 git 根本没跑起来（没装、超时）；退出码是不是 0 由调用方
/// 自己看返回的 `Output`——只读和写操作对它的解释正好相反。
fn run_git_raw(
    dir: &Path,
    global: &[&str],
    args: &[&str],
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .args(global)
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);

    // 起线程 + recv_timeout：Command 自己没有超时，卡在文件系统上的 git
    // 会把调用它的线程一起带走
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(command.output());
    });

    match receiver.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(reason)) => Err(format!("无法执行 git: {reason}")),
        // 写操作超时后 git 可能还在跑、最后其实成功了，所以不能说死是失败
        Err(_) => Err(format!(
            "git 超过 {} 秒没有响应，操作结果未知，请稍后确认",
            timeout.as_secs()
        )),
    }
}

/// 只读查询。
///
/// `--no-optional-locks`：轮询用的 status 不该抢 index.lock，把用户自己在
/// 终端里敲的 git 命令挡在门外。非 0 退出属于正常结果（比如目录不是仓库），
/// 返回 `Ok(None)`，调用方据此停掉轮询。
fn run_git(dir: &Path, args: &[&str]) -> Result<Option<Vec<u8>>, String> {
    let output = run_git_raw(dir, &["--no-optional-locks"], args, TIMEOUT)?;
    Ok(output.status.success().then_some(output.stdout))
}

/// 写操作。
///
/// 不带 `--no-optional-locks`：写操作该抢 index.lock 就抢，抢不到时把 git
/// 的报错透传给用户，比静默乱写正确。
///
/// `--literal-pathspecs` 是全局选项，必须排在子命令之前，放到后面会被 git
/// 当成一个 pathspec。它关掉 pathspec 的通配符和 `:(...)` 魔法——文件名里
/// 带 `*` `?` `[` 时才不会被当成模式匹配到别的文件。
fn run_git_checked(dir: &Path, args: &[&str]) -> Result<(), String> {
    let output = run_git_raw(dir, &["--literal-pathspecs"], args, WRITE_TIMEOUT)?;
    if output.status.success() {
        return Ok(());
    }
    Err(git_error(&output))
}

/// git 的报错常常是多行一大段（比如没配 user.name 时的 Author identity
/// unknown，里面直接带着该敲的命令），整段回传比截一行有用。stderr 空才退回 stdout。
fn git_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = if stderr.trim().is_empty() { stdout } else { stderr };
    let text = text.trim();
    if text.is_empty() {
        format!("git 退出码 {}", output.status.code().unwrap_or(-1))
    } else {
        text.to_string()
    }
}

/// Windows 上不隐藏的话，每次轮询都会闪一个控制台黑框
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// porcelain v2 记录里第 2 个字段是 XY
fn xy_of(record: &str) -> (char, char) {
    let field = record.split(' ').nth(1).unwrap_or("");
    let mut chars = field.chars();
    (chars.next().unwrap_or('.'), chars.next().unwrap_or('.'))
}

/// 跳过前 skip 个空格分隔的字段，剩下的整段就是路径（路径本身可能含空格）
fn path_of(record: &str, skip: usize) -> &str {
    let mut rest = record;
    for _ in 0..skip {
        match rest.find(' ') {
            Some(index) => rest = &rest[index + 1..],
            None => return "",
        }
    }
    rest
}

/// 解析 `git status --porcelain=v2 -z` 的输出。
///
/// `prefix` 是工作区相对仓库根的路径（仓库根就是工作区时为空串），
/// 用来把仓库级的条目折算成工作区内的路径——工作区可能只是仓库的一个子目录。
fn parse_status(raw: &[u8], prefix: &str, root: &Path) -> GitStatus {
    let mut status = GitStatus {
        is_repo: true,
        ..GitStatus::not_repo()
    };
    let mut records = raw.split(|byte| *byte == 0);

    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);

        if let Some(head) = text.strip_prefix("# branch.head ") {
            // detached HEAD 时这里是字面量 "(detached)"，没有分支名可显示
            status.branch = Some(head.to_string()).filter(|name| name != "(detached)");
            continue;
        }
        if let Some(ab) = text.strip_prefix("# branch.ab ") {
            // 形如 "+2 -3"；没有上游分支时整行不出现
            for part in ab.split_whitespace() {
                if let Some(value) = part.strip_prefix('+') {
                    status.ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix('-') {
                    status.behind = value.parse().unwrap_or(0);
                }
            }
            continue;
        }
        if text.starts_with("# ") {
            continue;
        }

        // 每种记录的字段数是固定的，路径在最后且可能含空格，所以按"跳 n 个字段"取
        let (xy, path) = match text.chars().next() {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            Some('1') => (xy_of(&text), path_of(&text, 8)),
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<原路径>
            Some('2') => {
                let fields = (xy_of(&text), path_of(&text, 9));
                records.next(); // 重命名记录后面还跟着原路径，得一并吞掉
                fields
            }
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            Some('u') => (xy_of(&text), path_of(&text, 10)),
            // ? <path>
            Some('?') => (('?', '?'), path_of(&text, 1)),
            _ => continue, // '!' 之类，界面不关心
        };

        let Some(relative) = path.strip_prefix(prefix) else {
            continue;
        };
        // 未跟踪目录整条折叠成 "dir/"，尾巴上的斜杠要去掉才能和文件树里的路径对上
        let relative = relative.trim_end_matches('/');
        if relative.is_empty() {
            continue;
        }

        status.changed += 1;
        if status.files.len() < MAX_ENTRIES {
            status.files.push(FileStatus {
                path: root
                    .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
                    .to_string_lossy()
                    .to_string(),
                relative: relative.to_string(),
                index: xy.0,
                worktree: xy.1,
            });
        }
    }

    status
}

/// 只读查询当前工作区的 git 状态。抽出来给写命令复用：写完之后直接回传新状态，
/// 前端一次 IPC 就能把界面刷到位，不用干等下一个轮询周期。
fn status_of(state: &FsState) -> Result<GitStatus, String> {
    let root = state.root()?;

    // --show-prefix 一次调用回答两件事：目录是不是仓库（不是则非 0 退出），
    // 以及工作区相对仓库根的位置（仓库根就是工作区时输出空行）
    let prefix = match run_git(&root, &["rev-parse", "--show-prefix"])? {
        Some(bytes) => String::from_utf8_lossy(&bytes).trim().to_string(),
        None => return Ok(GitStatus::not_repo()),
    };

    // -z：路径不做引号转义，空格和中文原样拿到，省掉一整套反解析
    // --untracked-files=normal：未跟踪的目录整条折叠成一项，避免刚 clone
    // 下来的仓库把条目数撑爆（.gitignore 挡住的目录本来就不会出现）
    let raw = run_git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
        ],
    )?
    .ok_or("git status 执行失败")?;

    Ok(parse_status(&raw, &prefix, &root))
}

/// 把前端传来的绝对路径折算成"工作区内的相对路径（正斜杠）"。
///
/// 一律先过 `fs_api::resolve` 的沙箱校验。返回的第二个值是 resolve 之后
/// 的绝对路径（看差异时要用它读工作区文件）。
fn workspace_relative(state: &FsState, root: &Path, raw: &str) -> Result<(PathBuf, String), String> {
    let target = fs_api::resolve(state, raw)?;
    let relative = target
        .strip_prefix(root)
        .map_err(|_| format!("路径越界（不在工作区内）: {raw}"))?;
    // git 内部一律用正斜杠
    let spec = relative.to_string_lossy().replace('\\', "/");
    if spec.is_empty() {
        return Err(format!("路径指向工作区根，不能当成改动项: {raw}"));
    }
    Ok((target, spec))
}

/// 把前端传来的绝对路径折算成相对工作区的 pathspec。
///
/// 命令是 `git -C <工作区>` 跑的，pathspec 天然相对工作区，所以 strip 掉工作区
/// 前缀就够了，不用管仓库根在哪。
fn pathspecs(state: &FsState, root: &Path, raw: &[String]) -> Result<Vec<String>, String> {
    raw.iter()
        .map(|item| workspace_relative(state, root, item).map(|(_, spec)| spec))
        .collect()
}

/// 没指定路径就是"全部"。
///
/// 这里必须给出 pathspec `.`：工作区可能只是仓库的一个子目录，不带 pathspec 的
/// `git add -A` 会把**整个仓库**都暂存了，用户在界面上根本看不出来。
fn all_or_specs(
    state: &FsState,
    root: &Path,
    paths: &Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    match paths {
        Some(list) if !list.is_empty() => pathspecs(state, root, list),
        _ => Ok(vec![".".to_string()]),
    }
}

fn stage_paths(state: &FsState, paths: &Option<Vec<String>>) -> Result<GitStatus, String> {
    let root = state.root()?;
    let specs = all_or_specs(state, &root, paths)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(specs.iter().map(String::as_str));
    run_git_checked(&root, &args)?;
    status_of(state)
}

fn unstage_paths(state: &FsState, paths: &Option<Vec<String>>) -> Result<GitStatus, String> {
    let root = state.root()?;
    let specs = all_or_specs(state, &root, paths)?;

    // 还没有任何提交的仓库里 `restore --staged` 会 could not resolve HEAD，
    // 只能用 `rm --cached` 把条目从 index 里摘掉（不碰工作区文件）。
    // 反过来也不能一律用它：有 HEAD 时它会把"未暂存的修改"变成
    // "已暂存的删除 + 未跟踪"，语义完全错。
    let has_head = run_git(&root, &["rev-parse", "--verify", "--quiet", "HEAD"])?.is_some();
    let mut args = if has_head {
        vec!["restore", "--staged", "--"]
    } else {
        // --ignore-unmatch：容忍"其实没暂存"的路径，别让状态快照过期就报错
        vec!["rm", "--cached", "-r", "-f", "--ignore-unmatch", "--"]
    };
    args.extend(specs.iter().map(String::as_str));
    run_git_checked(&root, &args)?;
    status_of(state)
}

fn commit_staged(state: &FsState, message: &str) -> Result<GitStatus, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    let root = state.root()?;
    // message 走 argv 直传（不起 shell），$、反引号、分号都只是普通字符；
    // 多行也原样接受，不用 --cleanup=verbatim，用 -m 的默认 whitespace 正好
    run_git_checked(&root, &["commit", "-m", message])?;
    status_of(state)
}

/// 工作区相对仓库根的前缀（仓库根就是工作区时是空串）。
/// `Ok(None)` 表示这个目录不是仓库——`rev-parse --show-prefix` 非 0 退出。
fn repo_prefix(root: &Path) -> Result<Option<String>, String> {
    Ok(run_git(root, &["rev-parse", "--show-prefix"])?
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string()))
}

/// 两侧内容统一按 LF 比较。
///
/// 本机 `core.autocrlf=true`：index 里存的是 LF、工作区常是 CRLF。不归一就会
/// 出现"整个文件都改了"的假差异。归一之后正好和 `git diff` 的默认行为一致——
/// 只改行尾的改动本来也不该显示出来。
fn normalize_newlines(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).replace("\r\n", "\n")
}

fn classify(bytes: Vec<u8>) -> Side {
    if fs_api::looks_binary(&bytes) {
        return Side::Binary;
    }
    // cat-file -s 报的是 raw blob 大小，取回来再兜一次
    if bytes.len() as u64 > fs_api::MAX_TEXT_SIZE {
        return Side::TooLarge;
    }
    Side::Text(normalize_newlines(bytes))
}

/// 取某个版本里的 blob：`HEAD:src/a.ts`（HEAD 版）或 `:src/a.ts`（index 版）。
///
/// 路径必须是**相对仓库根**的。用 `cat-file blob` 而不是 `show`：plumbing，
/// 没有 pager、也不受 textconv/filter 影响，二进制原样拿到。
fn blob_side(root: &Path, spec: &str) -> Result<Side, String> {
    // 先问大小：`cat-file blob` 会把整个对象读进内存，大文件得提前挡住。
    // 探不到（退出码非 0）正好落在 run_git 的 Ok(None) 上，表示这个版本里
    // 没有这个路径——新增、未跟踪、已删除都会走到这里，不是错误。
    let Some(size) = run_git(root, &["cat-file", "-s", spec])? else {
        return Ok(Side::Missing);
    };
    let size: u64 = String::from_utf8_lossy(&size).trim().parse().unwrap_or(0);
    if size > fs_api::MAX_TEXT_SIZE {
        return Ok(Side::TooLarge);
    }

    match run_git(root, &["cat-file", "blob", spec])? {
        Some(bytes) => Ok(classify(bytes)),
        None => Ok(Side::Missing),
    }
}

/// 工作区那一侧。文件被删掉了就是 Missing，不是错误。
fn worktree_side(path: &Path) -> Result<Side, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(classify(bytes)),
        Err(reason) if reason.kind() == std::io::ErrorKind::NotFound => Ok(Side::Missing),
        Err(reason) => Err(format!("读取文件失败 {}: {reason}", path.display())),
    }
}

/// 一个文件的两侧内容。
///
/// 基线照 VS Code：未暂存的改动比 `index ↔ 工作区`，暂存的改动比 `HEAD ↔ index`，
/// 看某个提交则比 `<rev>^ ↔ <rev>`。
fn file_diff(state: &FsState, path: &str, source: &DiffSource) -> Result<FileDiff, String> {
    let root = state.root()?;
    // --show-prefix 一次调用同时回答"是不是仓库"和"工作区在仓库里的哪一层"。
    // 工作区可能只是仓库的子目录，而 `cat-file` 的 `<path>` 是相对仓库根的，
    // 所以这里必须把 prefix 拼上（pathspecs 那个相对工作区的写法不能直接用）。
    let prefix = repo_prefix(&root)?.ok_or("这个目录不是 git 仓库")?;
    let (target, relative) = workspace_relative(state, &root, path)?;
    let repo_path = format!("{prefix}{relative}");

    let (original, modified) = match source {
        DiffSource::Staged => (
            blob_side(&root, &format!("HEAD:{repo_path}"))?,
            blob_side(&root, &format!(":{repo_path}"))?,
        ),
        DiffSource::Unstaged => (
            blob_side(&root, &format!(":{repo_path}"))?,
            worktree_side(&target)?,
        ),
        DiffSource::Commit { rev } => {
            let rev = checked_rev(rev)?;
            // 根提交没有父提交，`<rev>^` 解析不了 —— 正好落成空基线，
            // 语义上也对：根提交里的文件本来就都是新增的
            (
                blob_side(&root, &format!("{rev}^:{repo_path}"))?,
                blob_side(&root, &format!("{rev}:{repo_path}"))?,
            )
        }
    };

    Ok(to_diff(original, modified))
}

/// 只接受十六进制提交号。
///
/// rev 会被拼进 `cat-file` 的 revision spec，放任任意字符串等于把 revspec 语法
/// （`..`、`^`、`@{...}`、`:/正则`）暴露给调用方。历史列表给的本来就是完整 hash，
/// 按十六进制校验完全够用。
fn checked_rev(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.len() < 4 || text.len() > 40 || !text.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("不是合法的提交号: {raw}"));
    }
    Ok(text.to_string())
}

// ---- 提交历史 ----

/// `%x1f` 分隔字段、`%x00` 结尾。字段里可能带空格（作者名、提交信息），
/// 所以不能用空格或换行当分隔符。
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x00";

/// 一次拉多少条。界面上还有「加载更多」，所以给个够用的默认值就行。
const LOG_PAGE: u32 = 50;
const LOG_MAX: u32 = 500;

fn parse_log(raw: &[u8]) -> Vec<Commit> {
    raw.split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let text = String::from_utf8_lossy(record);
            let mut fields = text.split('\u{1f}');
            let hash = fields.next()?.to_string();
            let short = fields.next()?.to_string();
            let author = fields.next()?.to_string();
            let time = fields.next()?.parse().unwrap_or(0);
            Some(Commit {
                hash,
                short,
                author,
                time,
                subject: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

fn log_of(state: &FsState, limit: u32) -> Result<Vec<Commit>, String> {
    let root = state.root()?;
    if repo_prefix(&root)?.is_none() {
        return Ok(Vec::new());
    }

    let count = limit.clamp(1, LOG_MAX).to_string();
    let arg = format!("--max-count={count}");
    // 空仓库（还没有任何提交）时 git log 非 0 退出，那不是错误，给空列表
    let raw = run_git(&root, &["log", &arg, LOG_FORMAT])?.unwrap_or_default();
    Ok(parse_log(&raw))
}

/// 解析 `--name-status -z` 的输出：`<状态>\0<路径>\0` 交替出现。
/// 重命名/复制多一个 token，是 `<R100>\0<原路径>\0<新路径>\0`。
fn parse_name_status(raw: &[u8], prefix: &str, root: &Path) -> Vec<CommitFile> {
    let mut files = Vec::new();
    let mut tokens = raw.split(|byte| *byte == 0).filter(|token| !token.is_empty());

    while let Some(status_token) = tokens.next() {
        let status = String::from_utf8_lossy(status_token)
            .chars()
            .next()
            .unwrap_or('M');
        let renamed = status == 'R' || status == 'C';
        // 重命名/复制时第一个路径是原路径，界面上要点的是新路径
        let first = tokens.next();
        let path = if renamed { tokens.next() } else { first };
        let Some(path) = path else { break };

        let repo_path = String::from_utf8_lossy(path).replace('\\', "/");
        let Some(relative) = repo_path.strip_prefix(prefix) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        files.push(CommitFile {
            path: root
                .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
                .to_string_lossy()
                .to_string(),
            relative: relative.to_string(),
            status,
        });
    }

    files
}

fn files_of(state: &FsState, rev: &str) -> Result<Vec<CommitFile>, String> {
    let root = state.root()?;
    let prefix = repo_prefix(&root)?.ok_or("这个目录不是 git 仓库")?;
    let rev = checked_rev(rev)?;
    let raw = run_git(&root, &["show", "--name-status", "-z", "--format=", &rev])?
        .ok_or("git show 执行失败")?;
    Ok(parse_name_status(&raw, &prefix, &root))
}

#[tauri::command(async)]
pub fn git_status(state: tauri::State<'_, FsState>) -> Result<GitStatus, String> {
    status_of(&state)
}

/// 暂存。`paths` 为空表示全部暂存。
#[tauri::command(async)]
pub fn git_stage(
    state: tauri::State<'_, FsState>,
    paths: Option<Vec<String>>,
) -> Result<GitStatus, String> {
    stage_paths(&state, &paths)
}

/// 取消暂存。`paths` 为空表示全部取消。
#[tauri::command(async)]
pub fn git_unstage(
    state: tauri::State<'_, FsState>,
    paths: Option<Vec<String>>,
) -> Result<GitStatus, String> {
    unstage_paths(&state, &paths)
}

/// 提交暂存区。
#[tauri::command(async)]
pub fn git_commit(
    state: tauri::State<'_, FsState>,
    message: String,
) -> Result<GitStatus, String> {
    commit_staged(&state, &message)
}

/// 一个改动文件的两侧内容，给编辑器的差异视图用。
#[tauri::command(async)]
pub fn git_file_diff(
    state: tauri::State<'_, FsState>,
    path: String,
    source: DiffSource,
) -> Result<FileDiff, String> {
    file_diff(&state, &path, &source)
}

/// 提交历史，最新的在最前。`limit` 不传就取一页。
#[tauri::command(async)]
pub fn git_log(
    state: tauri::State<'_, FsState>,
    limit: Option<u32>,
) -> Result<Vec<Commit>, String> {
    log_of(&state, limit.unwrap_or(LOG_PAGE))
}

/// 某个提交改了哪些文件。
#[tauri::command(async)]
pub fn git_commit_files(
    state: tauri::State<'_, FsState>,
    rev: String,
) -> Result<Vec<CommitFile>, String> {
    files_of(&state, &rev)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 按 -z 的真实格式拼输入：记录之间是 NUL 而不是换行
    fn output(tokens: &[&str]) -> Vec<u8> {
        let mut raw = Vec::new();
        for token in tokens {
            raw.extend_from_slice(token.as_bytes());
            raw.push(0);
        }
        raw
    }

    fn workspace() -> PathBuf {
        PathBuf::from("D:\\ws")
    }

    /// 断言用的是拼出来的路径，换平台也不会因为分隔符挂掉
    fn at(name: &str) -> String {
        workspace().join(name).to_string_lossy().to_string()
    }

    #[test]
    fn reads_branch_and_ahead_behind() {
        let status = parse_status(
            &output(&[
                "# branch.oid 1234567890abcdef",
                "# branch.head main",
                "# branch.ab +2 -3",
            ]),
            "",
            &workspace(),
        );

        assert!(status.is_repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!((status.ahead, status.behind), (2, 3));
        assert_eq!(status.changed, 0);
    }

    #[test]
    fn detached_head_has_no_branch_name() {
        let status = parse_status(&output(&["# branch.head (detached)"]), "", &workspace());
        assert_eq!(status.branch, None);
        assert!(status.is_repo);
    }

    #[test]
    fn maps_records_to_absolute_paths_and_xy() {
        let status = parse_status(
            &output(&[
                "# branch.head main",
                "1 .M N... 100644 100644 100644 aaaa bbbb tracked.txt",
                "1 D. N... 100644 000000 000000 aaaa 0000 带 空格.txt",
                "? brandnew/",
                "? untracked.txt",
            ]),
            "",
            &workspace(),
        );

        let paths: Vec<&str> = status.files.iter().map(|file| file.path.as_str()).collect();
        assert!(paths.contains(&at("tracked.txt").as_str()), "{paths:?}");
        // 未跟踪目录整条折叠成 "dir/"，尾斜杠必须去掉
        assert!(paths.contains(&at("brandnew").as_str()), "{paths:?}");
        // 路径里的空格不能被当成字段分隔符
        assert!(paths.contains(&at("带 空格.txt").as_str()), "{paths:?}");
        assert_eq!(status.changed, 4);

        let deleted = status
            .files
            .iter()
            .find(|file| file.path.ends_with("带 空格.txt"))
            .expect("删除的条目应该在里面");
        assert_eq!((deleted.index, deleted.worktree), ('D', '.'));

        let untracked = status
            .files
            .iter()
            .find(|file| file.path.ends_with("untracked.txt"))
            .expect("未跟踪的条目应该在里面");
        assert_eq!((untracked.index, untracked.worktree), ('?', '?'));
        // relative 一律正斜杠，界面直接拿来显示
        assert_eq!(untracked.relative, "untracked.txt");
    }

    #[test]
    fn skips_entries_outside_a_nested_workspace() {
        let status = parse_status(
            &output(&[
                "# branch.head main",
                "1 .M N... 100644 100644 100644 aaaa bbbb sub/inside.txt",
                "1 .M N... 100644 100644 100644 aaaa bbbb elsewhere.txt",
                // 前缀是 "sub/"，同名前缀的兄弟文件不能被算进来
                "1 .M N... 100644 100644 100644 aaaa bbbb subber.txt",
            ]),
            "sub/",
            &workspace(),
        );

        let paths: Vec<&str> = status.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, vec![at("inside.txt")]);
        // 相对路径也要按工作区折算，而不是仓库根
        assert_eq!(status.files[0].relative, "inside.txt");
        assert_eq!(status.changed, 1);
    }

    #[test]
    fn rename_record_swallows_the_original_path() {
        let status = parse_status(
            &output(&[
                "2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt",
                "old.txt",
                "1 .M N... 100644 100644 100644 aaaa bbbb next.txt",
            ]),
            "",
            &workspace(),
        );

        let paths: Vec<&str> = status.files.iter().map(|file| file.path.as_str()).collect();
        // 原路径是记录的一部分，不能被当成一条独立条目
        assert_eq!(paths, vec![at("new.txt"), at("next.txt")]);
    }

    #[test]
    fn caps_the_entry_list_but_keeps_counting() {
        let many: Vec<String> = (0..MAX_ENTRIES + 10)
            .map(|index| format!("? f{index}.txt"))
            .collect();
        let mut tokens: Vec<&str> = vec!["# branch.head main"];
        tokens.extend(many.iter().map(String::as_str));

        let status = parse_status(&output(&tokens), "", &workspace());
        assert_eq!(status.files.len(), MAX_ENTRIES);
        assert_eq!(status.changed as usize, MAX_ENTRIES + 10);
    }

    #[test]
    fn non_repo_workspace_reports_itself_as_such() {
        // 拿一个不存在的目录当工作区：rev-parse 必然非 0 退出
        let missing = std::env::temp_dir().join("codedock-not-a-repo-ever");
        assert_eq!(run_git(&missing, &["rev-parse", "--show-prefix"]).unwrap(), None);
    }

    // ---- 写操作：下面这些都跑真 git，机器上没有 git 就跳过 ----

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    /// 建一个临时工作区。返回的根是 canonical 形式（和 FsState 里存的、
    /// FileStatus.path 拼出来的是同一个写法），断言可以直接比。
    fn temp_repo() -> (FsState, PathBuf, PathBuf) {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let unique = SEQ.fetch_add(1, Ordering::Relaxed);
        let top = std::env::temp_dir().join(format!("codedock-git-{}-{unique}", std::process::id()));
        let repo = top.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let state = FsState::new();
        let root = state.set_root(repo).unwrap();
        (state, root, top)
    }

    fn init_repo(repo: &Path) {
        assert!(git(repo, &["init", "-q", "."]), "git init 失败");
        assert!(git(repo, &["config", "user.email", "codedock@test"]));
        assert!(git(repo, &["config", "user.name", "codedock"]));
    }

    fn path_of_file(repo: &Path, name: &str) -> String {
        repo.join(name).to_string_lossy().to_string()
    }

    fn cleanup(top: &Path) {
        // .git 里有只读对象，删不掉就算了
        fs::remove_dir_all(top).ok();
    }

    #[test]
    fn pathspecs_are_relative_to_the_workspace_and_stay_inside() {
        let (state, repo, top) = temp_repo();
        fs::create_dir_all(repo.join("src")).unwrap();

        let specs = pathspecs(&state, &repo, &[path_of_file(&repo, "src/a.ts")]).unwrap();
        assert_eq!(specs, vec!["src/a.ts"]);

        // 工作区外的路径必须被沙箱挡下
        let outside = top.join("secret.txt").to_string_lossy().to_string();
        assert!(pathspecs(&state, &repo, &[outside]).is_err());

        // 没给路径就是"全部"，而且必须落在工作区内
        assert_eq!(all_or_specs(&state, &repo, &None).unwrap(), vec!["."]);
        assert_eq!(all_or_specs(&state, &repo, &Some(vec![])).unwrap(), vec!["."]);

        cleanup(&top);
    }

    #[test]
    fn stages_then_unstages_before_the_first_commit() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("app.ts"), "a\n").unwrap();

        let after = stage_paths(&state, &Some(vec![path_of_file(&repo, "app.ts")])).unwrap();
        assert_eq!(after.files.len(), 1);
        assert_eq!((after.files[0].index, after.files[0].worktree), ('A', '.'));

        // 这个仓库还没有 HEAD，restore --staged 会 fatal，必须走 rm --cached
        let after = unstage_paths(&state, &Some(vec![path_of_file(&repo, "app.ts")])).unwrap();
        assert_eq!(after.files.len(), 1);
        assert_eq!((after.files[0].index, after.files[0].worktree), ('?', '?'));

        cleanup(&top);
    }

    #[test]
    fn unstaging_after_a_commit_keeps_the_worktree_change() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo.join("app.ts");
        fs::write(&file, "a\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        fs::write(&file, "a\nb\n").unwrap();
        let staged = stage_paths(&state, &None).unwrap();
        assert_eq!((staged.files[0].index, staged.files[0].worktree), ('M', '.'));

        let after = unstage_paths(&state, &None).unwrap();
        // 有 HEAD 时必须回到"工作区已修改"，而不是"已暂存的删除 + 未跟踪"
        assert_eq!(after.files.len(), 1);
        assert_eq!((after.files[0].index, after.files[0].worktree), ('.', 'M'));

        cleanup(&top);
    }

    #[test]
    fn stages_a_deletion_of_a_whole_directory() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::create_dir_all(repo.join("old")).unwrap();
        fs::write(repo.join("old").join("a.txt"), "a\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        fs::remove_dir_all(repo.join("old")).unwrap();

        let status = status_of(&state).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].relative, "old/a.txt");

        // old 整个目录都没了，resolve 得靠"向上找最近存在的祖先"才能过
        let after = stage_paths(&state, &Some(vec![status.files[0].path.clone()])).unwrap();
        assert_eq!((after.files[0].index, after.files[0].worktree), ('D', '.'));

        cleanup(&top);
    }

    #[test]
    fn treats_pathspec_wildcards_literally() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        // `[1]` 在 git 的 pathspec 里是字符类，会匹配到 a1.txt；
        // Windows 文件名不允许 * 和 ?，所以用中括号当代表
        for name in ["a[1].txt", "a1.txt"] {
            fs::write(repo.join(name), "x\n").unwrap();
        }

        let after = stage_paths(&state, &Some(vec![path_of_file(&repo, "a[1].txt")])).unwrap();
        let staged: Vec<&str> = after
            .files
            .iter()
            .filter(|file| file.index == 'A')
            .map(|file| file.relative.as_str())
            .collect();
        assert_eq!(staged, vec!["a[1].txt"], "文件名里的通配符必须当字面量");

        let untouched = after
            .files
            .iter()
            .find(|file| file.relative == "a1.txt")
            .expect("另一个文件也该出现在状态里");
        assert_eq!(untouched.index, '?', "a1.txt 不该被顺带暂存");

        cleanup(&top);
    }

    #[test]
    fn stages_a_whole_untracked_directory() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::create_dir_all(repo.join("brandnew").join("nested")).unwrap();
        fs::write(repo.join("brandnew").join("a.txt"), "a\n").unwrap();
        fs::write(repo.join("brandnew").join("nested").join("b.txt"), "b\n").unwrap();

        // --untracked-files=normal 会把未跟踪目录折叠成一条
        let status = status_of(&state).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].relative, "brandnew");

        let after = stage_paths(&state, &Some(vec![status.files[0].path.clone()])).unwrap();
        let mut staged: Vec<&str> = after
            .files
            .iter()
            .filter(|file| file.index == 'A')
            .map(|file| file.relative.as_str())
            .collect();
        staged.sort_unstable();
        assert_eq!(staged, vec!["brandnew/a.txt", "brandnew/nested/b.txt"]);

        cleanup(&top);
    }

    #[test]
    fn stage_all_does_not_reach_outside_a_nested_workspace() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("outside.txt"), "o\n").unwrap();
        let sub = repo.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("inside.txt"), "i\n").unwrap();
        let sub = state.set_root(sub).unwrap();

        // 不带 pathspec 的 add -A 会把仓库根那个文件也暂存了，界面上看不出来
        let after = stage_paths(&state, &None).unwrap();
        let staged: Vec<&str> = after.files.iter().map(|file| file.relative.as_str()).collect();
        assert_eq!(staged, vec!["inside.txt"]);
        assert!(sub.join("inside.txt").is_file());

        cleanup(&top);
    }

    #[test]
    fn commit_failures_surface_gits_own_message() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("app.ts"), "a\n").unwrap();

        // 什么都没暂存就提交：git 在 stderr 上给出原因并返回非 0。
        // 关键是那段原文要原样带回来（它是多行的），而不是被吞成一句通用错误
        let error = commit_staged(&state, "init").unwrap_err();
        assert!(!error.trim().is_empty());
        assert!(error.lines().count() > 1, "报错被截断了: {error:?}");

        // 空信息在前端就该拦住，到这儿也要有个明确说法
        assert!(commit_staged(&state, "   ").unwrap_err().contains("不能为空"));

        cleanup(&top);
    }

    // ---- 差异视图：同样是跑真 git 的用例 ----

    #[test]
    fn new_file_baseline_is_empty() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "fresh.txt");
        fs::write(&path, "a\n").unwrap();

        // 还没暂存：index 里没有这条，基线是空
        let diff = file_diff(&state, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "a\n");
        assert!(!diff.is_binary && !diff.too_large);

        // 没有 HEAD 的仓库里暂存进来，基线依然是空
        stage_paths(&state, &None).unwrap();
        let diff = file_diff(&state, &path, &DiffSource::Staged).unwrap();
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "a\n");

        cleanup(&top);
    }

    #[test]
    fn modified_file_has_both_sides() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        fs::write(&path, "a\nb\n").unwrap();
        // 未暂存：基线是 index（还是提交时的 "a\n"）
        let diff = file_diff(&state, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "a\nb\n");

        cleanup(&top);
    }

    #[test]
    fn staged_diff_uses_head_as_baseline() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        fs::write(&path, "a\nb\n").unwrap();
        stage_paths(&state, &None).unwrap();

        // 暂存后基线从 index 换成 HEAD
        let diff = file_diff(&state, &path, &DiffSource::Staged).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "a\nb\n");
        // 同一个文件此时未暂存侧没有改动，两边内容一致
        let unstaged = file_diff(&state, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(unstaged.original, unstaged.modified);

        cleanup(&top);
    }

    #[test]
    fn subdirectory_workspace_uses_repo_relative_path() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let sub = repo.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("inside.txt"), "a\n").unwrap();
        let sub = state.set_root(sub).unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        let path = path_of_file(&sub, "inside.txt");
        fs::write(&path, "a\nb\n").unwrap();

        // `cat-file` 的路径是相对仓库根的，工作区只是子目录时必须拼上 prefix
        let diff = file_diff(&state, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "a\nb\n");

        cleanup(&top);
    }

    #[test]
    fn deleted_file_has_empty_current_side() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "gone.txt");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        fs::remove_file(&path).unwrap();
        let diff = file_diff(&state, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "");

        cleanup(&top);
    }

    #[test]
    fn normalizes_crlf_so_line_endings_alone_are_not_a_diff() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "app.ts");
        // index 里存 LF（本项目 autocrlf=true 下的常态），工作区是 CRLF
        fs::write(&path, "a\nb\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        fs::write(&path, "a\r\nb\r\n").unwrap();
        let diff = file_diff(&state, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, diff.modified, "只改行尾不该报成差异");

        cleanup(&top);
    }

    #[test]
    fn non_repo_rejects_with_message() {
        let (state, repo, top) = temp_repo();
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();

        // 目录存在但没 init 过，repo_prefix 返回 None
        let error = file_diff(&state, &path, &DiffSource::Unstaged).unwrap_err();
        assert!(error.contains("不是 git 仓库"), "{error:?}");

        cleanup(&top);
    }

    // ---- 提交历史与提交内的差异 ----

    #[test]
    fn rejects_a_rev_that_is_not_a_hash() {
        // rev 会被拼进 revision spec，只放十六进制过去
        assert!(checked_rev("HEAD").is_err());
        assert!(checked_rev("main~2").is_err());
        assert!(checked_rev("abc^").is_err());
        assert!(checked_rev(":/fix").is_err());
        assert!(checked_rev("abc").is_err(), "太短");
        assert!(checked_rev(&"a".repeat(41)).is_err(), "太长");
        assert_eq!(checked_rev(" 6f0f354 ").unwrap(), "6f0f354");
    }

    #[test]
    fn log_is_empty_before_the_first_commit() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        // 空仓库里 git log 非 0 退出，这不是错误
        assert!(log_of(&state, LOG_PAGE).unwrap().is_empty());
        cleanup(&top);
    }

    #[test]
    fn log_lists_newest_first_and_parses_fields() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo.join("app.ts");
        fs::write(&file, "a\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "第一条").unwrap();

        fs::write(&file, "a\nb\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "第二条 带 空格").unwrap();

        let commits = log_of(&state, LOG_PAGE).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "第二条 带 空格", "最新的排最前");
        assert_eq!(commits[1].subject, "第一条");
        assert_eq!(commits[0].hash.len(), 40);
        assert_eq!(commits[0].short.len(), 7);
        assert!(!commits[0].author.is_empty());
        assert!(commits[0].time > 0);

        // limit 要生效
        assert_eq!(log_of(&state, 1).unwrap().len(), 1);

        cleanup(&top);
    }

    #[test]
    fn commit_files_use_repo_relative_paths_in_a_nested_workspace() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::create_dir_all(repo.join("sub").join("nested")).unwrap();
        fs::write(repo.join("outside.txt"), "o\n").unwrap();
        fs::write(repo.join("sub").join("inside.txt"), "i\n").unwrap();
        fs::write(repo.join("sub").join("nested").join("deep.txt"), "d\n").unwrap();
        stage_paths(&state, &None).unwrap();
        let head = commit_staged(&state, "init").unwrap();
        let _ = head;
        let rev = log_of(&state, 1).unwrap()[0].hash.clone();

        // 工作区切到 sub/：仓库根那个 outside.txt 不该出现在列表里
        let sub = state.set_root(repo.join("sub")).unwrap();
        let files = files_of(&state, &rev).unwrap();
        let mut relatives: Vec<&str> = files.iter().map(|f| f.relative.as_str()).collect();
        relatives.sort_unstable();
        assert_eq!(relatives, vec!["inside.txt", "nested/deep.txt"]);
        assert_eq!(files[0].status, 'A');
        // path 得是工作区里的绝对路径，点开差异要用
        assert!(files.iter().all(|f| f.path.starts_with(&sub.to_string_lossy().to_string())));

        cleanup(&top);
    }

    #[test]
    fn commit_diff_uses_the_parent_as_the_baseline() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        // 第二次提交之后工作区再改一通，确保看的确实是提交本身而不是工作区
        fs::write(&path, "a\nb\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "改一行").unwrap();
        fs::write(&path, "a\nb\nc\n").unwrap();

        let rev = log_of(&state, 1).unwrap()[0].hash.clone();
        let diff = file_diff(&state, &path, &DiffSource::Commit { rev }).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "a\nb\n", "看的是提交里的版本，不是工作区");

        // 根提交没有父，基线该落到空
        let root_rev = log_of(&state, 2).unwrap()[1].hash.clone();
        let first = file_diff(&state, &path, &DiffSource::Commit { rev: root_rev }).unwrap();
        assert_eq!(first.original, "");
        assert_eq!(first.modified, "a\n");

        cleanup(&top);
    }

    #[test]
    fn commit_files_reports_deletions() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("keep.txt"), "k\n").unwrap();
        fs::write(repo.join("gone.txt"), "g\n").unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "init").unwrap();

        fs::remove_file(repo.join("gone.txt")).unwrap();
        stage_paths(&state, &None).unwrap();
        commit_staged(&state, "删掉一个").unwrap();

        let rev = log_of(&state, 1).unwrap()[0].hash.clone();
        let files = files_of(&state, &rev).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative, "gone.txt");
        assert_eq!(files[0].status, 'D');

        cleanup(&top);
    }
}
