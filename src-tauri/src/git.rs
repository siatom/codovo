use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
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
    /// 这条是不是一个目录。正常为 false——status 用 `--untracked-files=all` 逐个列出
    /// 未跟踪文件、不折叠目录；只有 `normal` 那种折叠形态才会带尾斜杠（见 parse_status 的
    /// 防御分支）。前端据此不把它当成文件去读——读目录会报 "Is a directory"。
    is_dir: bool,
    /// 这一侧增删了几行。`None` = 该侧没有改动，或者统计不出来（二进制、未跟踪）。
    /// 两侧各存一份：同一个文件在两个分组里显示的是各自那一侧的改动量。
    staged_added: Option<u32>,
    staged_removed: Option<u32>,
    unstaged_added: Option<u32>,
    unstaged_removed: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    branch: Option<String>,
    /// HEAD 指向的提交号；还没提交过（`(initial)`）时为 None。
    /// 前端拿它的变化当"历史该重拉了"的信号——在终端里 commit/amend/reset
    /// 之后，改动列表靠轮询能自己好，时间线不会。
    head: Option<String>,
    ahead: u32,
    behind: u32,
    /// 仓库正卡在一次没结束的多步操作里（合并 / 变基 / 拣选 / 还原，有冲突待解决
    /// 或已解决待收尾）。为真时前端切到"进行中"界面并挡住 push / 切分支等操作。
    merging: bool,
    /// 进行中的具体操作类型：merge / rebase / cherryPick / revert；没有进行中的
    /// 操作时是 None。只有 merge 能用 `merge --continue` / `--abort` 收尾，
    /// 其余三种得回终端用各自的子命令，前端据此决定给不给那对按钮。
    merge_kind: Option<String>,
    /// 未合并（冲突）条目数。porcelain 的 u 记录，含 AA/DD 这种 XY 里没有 U 的
    conflicts: u32,
    /// 改动**文件**总数：未跟踪目录已展开成文件、不按目录计（见 status_of_with_counts）。
    /// 可能大于 files.len()（见 MAX_ENTRIES）
    changed: u32,
    files: Vec<FileStatus>,
}

impl GitStatus {
    fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            head: None,
            ahead: 0,
            behind: 0,
            merging: false,
            merge_kind: None,
            conflicts: 0,
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
    /// `<from>` ↔ `<to>`，两侧都是任意 ref（分支 / 标签 / HEAD / 提交号）。
    /// 比较任意两个提交、或者拿某个提交跟一个分支比，走的就是这一支
    Range { from: String, to: String },
}

/// 放弃修改要还原到哪一侧。同样用标签枚举而不是一个 `staged: bool`：
/// 调用处一眼能看出语义，也免得"true 到底是丢弃暂存还是丢弃工作区"这种
/// 要翻签名才明白的代码。
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum DiscardSource {
    /// 工作区 → index。暂存区里的改动留着（「改动」组）
    Unstaged,
    /// 工作区 + index → HEAD，暂存的和未暂存的改动一起丢（「暂存的改动」组）
    Staged,
}

/// 一个 hunk 要往哪边落。和 DiscardSource 同一个思路：标签枚举比 bool 好读。
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum HunkAction {
    /// 把这个 hunk 加进暂存区（`git apply --cached`）
    Stage,
    /// 把这个 hunk 从暂存区退回去（`git apply --cached --reverse`）。基线是 HEAD 侧，
    /// 工作区一个字节都不动。
    Unstage,
    /// 把这个 hunk 从工作区丢掉（`git apply --reverse`）
    Discard,
}

/// 一个文件里的一段改动（统一 diff 里的一个 `@@` 块）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchHunk {
    /// `@@ -12,6 +12,7 @@ fn foo()` 整行（去掉行尾换行），界面显示用
    header: String,
    /// 这个 hunk 的原文：`@@` 行 + 内容行，行尾换行原样保留。
    /// 界面拼补丁时把它接在文件级头后面，一个字节都不改地交回给 `git apply`。
    text: String,
    added: u32,
    removed: u32,
}

/// 一个未暂存文件的 hunk 列表。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHunks {
    /// 文件级头（`diff --git` 到第一个 `@@` 之前）。拼补丁时要带上
    header: String,
    /// 空 = 这个文件做不了逐块操作（二进制、纯新增 / 删除、不是 UTF-8 文本），
    /// 界面这时只给整文件操作
    hunks: Vec<PatchHunk>,
}

/// 挂在某个提交上的引用（分支 / 远程分支 / 标签）。图形化历史拿它画行内的标签 chip。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    /// 短名，去掉 refs/heads、refs/remotes、refs/tags 前缀
    name: String,
    /// "head"（当前分支，HEAD 指向）/ "branch" / "remote" / "tag"
    kind: String,
}

/// 时间线里的一条。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    hash: String,
    short: String,
    author: String,
    /// Unix 秒，界面自己折算成"多久前"
    time: i64,
    subject: String,
    /// 提交信息里主题之后的正文（原样，含换行），悬停浮框要展示；没有正文时为空串
    body: String,
    /// 父提交的完整 hash。画泳道连线要用；根提交为空
    parents: Vec<String>,
    /// 这个提交上挂的引用（分支 / 远程 / 标签）
    refs: Vec<CommitRef>,
}

/// 一条提交的改动规模，悬停浮框上显示「N 个文件，N 行插入，N 行删除」。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStat {
    files: u32,
    insertions: u32,
    deletions: u32,
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
///
/// `env` 是给子进程额外设的环境变量。目前只有网络操作要用（关掉交互式提问）。
fn run_git_raw(
    dir: &Path,
    global: &[&str],
    args: &[&str],
    timeout: Duration,
    env: &[(&str, &str)],
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
    for (key, value) in env {
        command.env(key, value);
    }
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
    let output = run_git_raw(dir, &["--no-optional-locks"], args, TIMEOUT, &[])?;
    Ok(output.status.success().then_some(output.stdout))
}

/// 只读查询，且关掉 pathspec 的通配符魔法。
///
/// 看单个文件的 diff 要走到 pathspec，文件名里带 `*` `?` `[` 时不加
/// `--literal-pathspecs` 会匹配到别的文件（见 run_git_checked 的说明）。
fn run_git_literal(dir: &Path, args: &[&str]) -> Result<Option<Vec<u8>>, String> {
    let output = run_git_raw(
        dir,
        &["--no-optional-locks", "--literal-pathspecs"],
        args,
        TIMEOUT,
        &[],
    )?;
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
    run_git_checked_env(dir, args, &[])
}

/// 同上，但给子进程额外设环境变量。
///
/// `--continue` 系列子命令在需要用户确认提交信息时会拉起编辑器；我们没有 TTY，
/// 编辑器一开就永远等不到输入、把整个写操作超时耗光（表现为"卡住"）。调用方传
/// `GIT_EDITOR=true` 让它直接接受默认信息。其余写操作不需要 env，走 `run_git_checked`。
fn run_git_checked_env(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<(), String> {
    let output = run_git_raw(dir, &["--literal-pathspecs"], args, WRITE_TIMEOUT, env)?;
    if output.status.success() {
        return Ok(());
    }
    Err(git_error(&output))
}

/// 网络操作超时。本地 git 几十毫秒就回来了，clone/fetch 一个大仓库却可能要几分钟，
/// 拿写操作的 30 秒去卡它必然误报。超时只作废这一次操作，报错文案里已注明"结果未知"。
const NETWORK_TIMEOUT: Duration = Duration::from_secs(180);

/// fetch / pull / push 统一走这里。
///
/// `GIT_TERMINAL_PROMPT=0` 是必须的：我们没有 TTY，不关掉交互式提问的话 git 会
/// 一直等着输入用户名密码，直到把整个超时耗光才报"超时"，用户完全看不出是缺凭据。
/// 凭据交给系统上已配好的 credential helper / ssh-agent，没有就报错让人去终端处理一次。
///
/// 不带 `--no-optional-locks`：这些操作本来就要更新 refs 和 index.lock，
/// 该抢锁就抢，抢不到时把 git 的报错透传出来比静默乱写正确。
fn run_git_network(dir: &Path, args: &[&str]) -> Result<(), String> {
    let output = run_git_raw(
        dir,
        &[],
        args,
        NETWORK_TIMEOUT,
        &[("GIT_TERMINAL_PROMPT", "0")],
    )?;
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
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
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
        if let Some(oid) = text.strip_prefix("# branch.oid ") {
            // 空仓库（还没有任何提交）时这里是字面量 "(initial)"
            status.head = Some(oid.to_string()).filter(|oid| oid != "(initial)");
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
            // 未合并（冲突）记录。AA/DD 这种 XY 里没有 U，只能靠记录类型认；
            // 计数要在下面的 MAX_ENTRIES 截断之前，否则条目超限时冲突数会被少算
            Some('u') => {
                status.conflicts += 1;
                (xy_of(&text), path_of(&text, 10))
            }
            // ? <path>
            Some('?') => (('?', '?'), path_of(&text, 1)),
            _ => continue, // '!' 之类，界面不关心
        };

        let Some(relative) = path.strip_prefix(prefix) else {
            continue;
        };
        // 防御：`--untracked-files=normal` 会把未跟踪目录整条折叠成 "dir/"，尾巴上带斜杠。
        // 现在用的是 all（逐个文件列出），正常不会出现尾斜杠，但保留这段——真拿到了也能
        // 去掉斜杠对上文件树路径、并标成目录。先用尾斜杠记下"这是目录"，去掉就看不出
        let is_dir = relative.ends_with('/');
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
                is_dir,
                // 行数 porcelain 里没有，由 status_of 再跑一次 numstat 填进来
                staged_added: None,
                staged_removed: None,
                unstaged_added: None,
                unstaged_removed: None,
            });
        }
    }

    status
}

/// 解析 `git diff --numstat -z` 的输出：`<增>\t<删>\t<路径>\0`。
///
/// 重命名/复制时路径字段是**空的**，后面另跟两个 NUL 分隔的 token（旧路径、新路径）——
/// 实测就是这个格式，取新路径（界面显示和点开看的都是它）。
/// 二进制文件的增删两列都是 `-`，转成 None：显示「-/-」不如什么都不显示。
fn parse_numstat(raw: &[u8]) -> Vec<(String, Option<u32>, Option<u32>)> {
    let tokens: Vec<&[u8]> = raw.split(|byte| *byte == 0).collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        if token.is_empty() {
            index += 1;
            continue;
        }
        let text = String::from_utf8_lossy(token);
        let mut parts = text.splitn(3, '\t');
        let added = to_count(parts.next().unwrap_or(""));
        let removed = to_count(parts.next().unwrap_or(""));
        let path = parts.next().unwrap_or("");
        // 路径空 = 重命名记录，旧、新路径各占后面一个 token
        if path.is_empty() && index + 2 < tokens.len() {
            let renamed = String::from_utf8_lossy(tokens[index + 2]).into_owned();
            out.push((renamed, added, removed));
            index += 3;
            continue;
        }
        out.push((path.to_string(), added, removed));
        index += 1;
    }
    out
}

/// numstat 的计数列。二进制是 `-`，认不出的一律 None（不显示比显示错的好）
fn to_count(text: &str) -> Option<u32> {
    text.parse().ok()
}

/// numstat 的输出折成「工作区相对路径 -> (增, 删)」。
///
/// 越界的直接跳过：工作区只是仓库的子目录时 git 仍会报整个仓库的改动，口径和
/// `parse_status` 一致。未跟踪的文件不会出现在 numstat 里（`git diff` 看不见它们），
/// 它们的计数天然是 None。
fn counts_by_path(raw: &[u8], prefix: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let mut map = HashMap::new();
    for (path, added, removed) in parse_numstat(raw) {
        let Some(relative) = path.strip_prefix(prefix) else {
            continue;
        };
        let relative = relative.trim_end_matches('/');
        if relative.is_empty() {
            continue;
        }
        map.insert(relative.to_string(), (added, removed));
    }
    map
}

/// 只读查询当前工作区的 git 状态（带增删行数）。抽出来给写命令复用：写完之后直接
/// 回传新状态，前端一次 IPC 就能把界面刷到位，不用干等下一个轮询周期。
fn status_of(root: &Path) -> Result<GitStatus, String> {
    status_of_with_counts(root, true)
}

/// 同 `status_of`，但可跳过增删行数那两次 numstat。
///
/// `with_counts=false` 时 `staged_*` / `unstaged_*` 全是 None。`git_status` 被前端每
/// 2 秒轮询一次，而行数只有「变更」面板会显示——面板收着、在看别的模块时，这两次
/// numstat 就是白起两个 git 进程。写命令一律走 `status_of`（要行数），它们不轮询、
/// 不受影响。
fn status_of_with_counts(root: &Path, with_counts: bool) -> Result<GitStatus, String> {
    // --show-prefix 一次调用回答两件事：目录是不是仓库（不是则非 0 退出），
    // 以及工作区相对仓库根的位置（仓库根就是工作区时输出空行）
    let prefix = match run_git(root, &["rev-parse", "--show-prefix"])? {
        Some(bytes) => String::from_utf8_lossy(&bytes).trim().to_string(),
        None => return Ok(GitStatus::not_repo()),
    };

    // -z：路径不做引号转义，空格和中文原样拿到，省掉一整套反解析
    // --untracked-files=all：未跟踪的**文件**逐个列出，不把整个目录折叠成一项——
    // 这样改动数按文件计、改动列表也到文件级（normal 会把含 N 个文件的目录算成 1 个）。
    // .gitignore 挡住的目录两种模式都不会出现；条目上限由 MAX_ENTRIES 兜底
    let raw = run_git(
        root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?
    .ok_or("git status 执行失败")?;

    let mut status = parse_status(&raw, &prefix, root);

    // 增删行数 porcelain 里没有，得另跑两次 numstat。没有改动时直接跳过，
    // 别为一次空结果白起两个进程；调用方不要行数时（轮询且面板没开）也跳过
    if with_counts && !status.files.is_empty() {
        let unstaged = run_git(root, &["diff", "--numstat", "-z"])?.unwrap_or_default();
        let staged = run_git(root, &["diff", "--cached", "--numstat", "-z"])?.unwrap_or_default();
        let unstaged_counts = counts_by_path(&unstaged, &prefix);
        let staged_counts = counts_by_path(&staged, &prefix);
        for file in &mut status.files {
            if let Some((added, removed)) = unstaged_counts.get(&file.relative) {
                file.unstaged_added = *added;
                file.unstaged_removed = *removed;
            }
            if let Some((added, removed)) = staged_counts.get(&file.relative) {
                file.staged_added = *added;
                file.staged_removed = *removed;
            }
        }
    }

    // 进行中的多步操作得另查：porcelain v2 不暴露 MERGE_HEAD / REBASE_HEAD 之类。
    // merging 仍表示"有任何多步操作没结束"（继续挡住 push / 切分支等），merge_kind
    // 再细分是哪一种，前端据此决定给不给"完成合并 / 中止合并"那对按钮。
    let state = merge_state(root)?;
    status.merging = state.is_some();
    status.merge_kind = state.map(str::to_string);
    Ok(status)
}

/// 把工作区根初始化成一个 git 仓库（默认分支 main）。
///
/// 目录已经是仓库时 `git init` 是幂等的：不会报错、也不会清掉已有历史，所以不用先
/// 探一次。写完直接回新状态，前端一次 IPC 就能把界面刷到位，不用等下一个轮询周期。
///
/// 分支名写死 main 而不是让 git 用全局的 init.defaultBranch：界面上的按钮说的就是
/// 「初始化 Git 仓库」，用户按下去该拿到和 Codovo 仓库本身一致的结果，而不是被
/// 本机配置决定；另外 git 2.28+ 才会在空仓库的 status 里报出分支名，`-b` 顺带保证了
/// 刚初始化完的面板能显示分支。
fn init_git_repo(root: &Path) -> Result<GitStatus, String> {
    run_git_checked(root, &["init", "-b", "main"])?;
    status_of(root)
}

/// 把前端传来的绝对路径折算成"工作区内的相对路径（正斜杠）"。
///
/// 一律先过 `fs_api::resolve` 的沙箱校验。返回的第二个值是 resolve 之后
/// 的绝对路径（看差异时要用它读工作区文件）。
fn workspace_relative(root: &Path, raw: &str) -> Result<(PathBuf, String), String> {
    let target = fs_api::resolve(root, raw)?;
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
fn pathspecs(root: &Path, raw: &[String]) -> Result<Vec<String>, String> {
    raw.iter()
        .map(|item| workspace_relative(root, item).map(|(_, spec)| spec))
        .collect()
}

/// 没指定路径就是"全部"。
///
/// 这里必须给出 pathspec `.`：工作区可能只是仓库的一个子目录，不带 pathspec 的
/// `git add -A` 会把**整个仓库**都暂存了，用户在界面上根本看不出来。
fn all_or_specs(root: &Path, paths: &Option<Vec<String>>) -> Result<Vec<String>, String> {
    match paths {
        Some(list) if !list.is_empty() => pathspecs(root, list),
        _ => Ok(vec![".".to_string()]),
    }
}

fn stage_paths(root: &Path, paths: &Option<Vec<String>>) -> Result<GitStatus, String> {
    let specs = all_or_specs(root, paths)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(specs.iter().map(String::as_str));
    run_git_checked(root, &args)?;
    status_of(root)
}

fn unstage_paths(root: &Path, paths: &Option<Vec<String>>) -> Result<GitStatus, String> {
    let specs = all_or_specs(root, paths)?;

    // 还没有任何提交的仓库里 `restore --staged` 会 could not resolve HEAD，
    // 只能用 `rm --cached` 把条目从 index 里摘掉（不碰工作区文件）。
    // 反过来也不能一律用它：有 HEAD 时它会把"未暂存的修改"变成
    // "已暂存的删除 + 未跟踪"，语义完全错。
    let has_head = run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"])?.is_some();
    let mut args = if has_head {
        vec!["restore", "--staged", "--"]
    } else {
        // --ignore-unmatch：容忍"其实没暂存"的路径，别让状态快照过期就报错
        vec!["rm", "--cached", "-r", "-f", "--ignore-unmatch", "--"]
    };
    args.extend(specs.iter().map(String::as_str));
    run_git_checked(root, &args)?;
    status_of(root)
}

/// 放弃某些文件的改动。
///
/// 两种还原目标对应界面上的两个分组，语义不同，不能合成一条命令：
/// - `Unstaged` 只动工作区（`restore --worktree`，源是 index），暂存区里
///   已经放好的改动留着——这样 `MM` 这种文件在两个组里各放弃一次是两件事。
/// - `Staged` 把 index 和工作区一起还原到 HEAD，也就是"这个文件回到上次提交的样子"。
///
/// 不接受空路径，也不提供"全部"：丢弃是按分组来的，两个分组的还原目标不一样，
/// 用 pathspec `.` 一把梭会把另一组的改动也带上。
///
/// 新增的文件（HEAD 里没有、index 里是 `A`）不在支持范围内：还原到 HEAD 等于
/// 把文件删掉。前端据此不给按钮，要删就去终端或文件管理器。
fn discard_paths(
    root: &Path,
    paths: &[String],
    source: &DiscardSource,
) -> Result<GitStatus, String> {
    if paths.is_empty() {
        return Err("没有指定要放弃的文件".to_string());
    }
    let specs = pathspecs(root, paths)?;

    let mut args: Vec<&str> = match source {
        DiscardSource::Unstaged => vec!["restore", "--worktree", "--"],
        DiscardSource::Staged => vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"],
    };
    args.extend(specs.iter().map(String::as_str));
    run_git_checked(root, &args)?;
    status_of(root)
}

/// 把一份单文件的统一 diff 拆成「文件级头 + 各个 hunk」。
///
/// 按 `@@` 起始行切：它之前的是头（`diff --git` / `index` / `---` / `+++`），之后
/// 每个 hunk 从 `@@` 行到下一个 `@@` 行为止。hunk 的内容行前缀只有空格 / `+` / `-`，
/// `\ No newline at end of file` 以 `\` 开头，都不会被误判成新 hunk 的开始。
///
/// 行尾一律原样留着（含每行末尾的换行）：拼回去要一个字节不改地交给 `git apply`，
/// 这里少一个换行补丁就对不上了。
fn split_patch(text: &str) -> (String, Vec<PatchHunk>) {
    let mut header = String::new();
    let mut hunks: Vec<PatchHunk> = Vec::new();
    let mut current: Option<PatchHunk> = None;

    for line in text.split_inclusive('\n') {
        if line.starts_with("@@") {
            if let Some(done) = current.take() {
                hunks.push(done);
            }
            current = Some(PatchHunk {
                header: line.trim_end_matches(['\n', '\r']).to_string(),
                text: line.to_string(),
                added: 0,
                removed: 0,
            });
        } else if let Some(hunk) = current.as_mut() {
            hunk.text.push_str(line);
            match line.as_bytes().first() {
                Some(b'+') => hunk.added += 1,
                Some(b'-') => hunk.removed += 1,
                _ => {}
            }
        } else {
            header.push_str(line);
        }
    }
    if let Some(done) = current {
        hunks.push(done);
    }
    (header, hunks)
}

/// 取某个文件某一侧的 hunk 列表。
///
/// 未暂存侧（`git diff`）的原始输出一份两用——`--cached` 应用就是「暂存这块」，
/// `--reverse` 应用就是「丢掉这块」，不用为两个方向各生成一份；暂存侧（`git diff
/// --cached`）的基线是 HEAD，`--cached --reverse` 应用就是「取消暂存这块」。
///
/// `--no-color` 是必须的，带了颜色码的补丁交给 `git apply` 会直接认不出来。
/// 不加 `normalize_newlines`——那条链是为了让**比对**不被 CRLF 干扰，补丁必须和
/// 工作区字节一致，归一过就 apply 不上了。
fn file_hunks(root: &Path, path: &str, staged: bool) -> Result<FileHunks, String> {
    let (_, spec) = workspace_relative(root, path)?;
    let args: Vec<&str> = if staged {
        vec!["diff", "--cached", "--no-color", "-U3", "--", &spec]
    } else {
        vec!["diff", "--no-color", "-U3", "--", &spec]
    };
    let raw = run_git_literal(root, &args)?.unwrap_or_default();

    // diff 里混进非 UTF-8 字节（文件是别的编码）就没法原样走 JSON 往返，跨过去
    // 会变成替换字符、补丁当场失效。这种情况退回整文件操作，界面不给逐块按钮
    let Ok(text) = String::from_utf8(raw) else {
        return Ok(FileHunks {
            header: String::new(),
            hunks: Vec::new(),
        });
    };

    let (header, hunks) = split_patch(&text);
    Ok(FileHunks { header, hunks })
}

/// 把一段补丁应用下去：进暂存区，或者从工作区撤掉。
///
/// 补丁先写成临时文件再 `git apply <file>`：`run_git_raw` 的 stdin 是
/// `Stdio::null()`，喂不进管道；改 stdin 要动所有调用方，代价比多写一个文件大。
fn apply_patch(root: &Path, patch: &str, action: &HunkAction) -> Result<GitStatus, String> {
    if patch.trim().is_empty() {
        return Err("没有要应用的改动".to_string());
    }

    // 名字带上 pid + 自增序号：并发调用写同名文件会互相截断
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!(
        "codovo-hunk-{}-{seq}.patch",
        std::process::id()
    ));
    fs::write(&file, patch.as_bytes()).map_err(|reason| format!("写临时补丁失败: {reason}"))?;
    let file_arg = file.to_string_lossy().to_string();

    // `--recount` 让 git 自己数 `@@` 里的行数，不认副本里的旧计数。补丁是刚由
    // `git diff` 生成的，本来就算得准，这里纯粹是防御——手工改过的补丁也能落下去
    let mut args: Vec<&str> = vec!["apply", "--recount"];
    match action {
        HunkAction::Stage => args.push("--cached"),
        HunkAction::Unstage => {
            // 退回暂存区：反向作用在 index 上，工作区不动
            args.push("--cached");
            args.push("--reverse");
        }
        HunkAction::Discard => args.push("--reverse"),
    }
    args.push("--");
    args.push(&file_arg);
    let result = run_git_checked(root, &args);

    // 成功失败都清掉：临时文件留着除了占地方没有别的用
    fs::remove_file(&file).ok();
    result?;
    status_of(root)
}

/// 从 `@@ -a,b +c,d @@` 里抠出两侧的起始行号（不含计数）。解析不出来时给 (0, 0)。
///
/// 只取起始行号：行数由我们按选中的行重算（`--recount` 也会兜一层），起始行号则要
/// 原样保留——它决定补丁往哪一行的上下文上贴。
fn hunk_start(header: &str) -> (u32, u32) {
    let rest = header.strip_prefix("@@ -").unwrap_or("");
    let mut parts = rest.split(' ');
    let parse_start = |field: &str| -> u32 {
        field
            .trim_start_matches('+')
            .split(',')
            .next()
            .unwrap_or("")
            .parse()
            .unwrap_or(0)
    };
    let old = parse_start(parts.next().unwrap_or(""));
    let new = parse_start(parts.next().unwrap_or(""));
    (old, new)
}

/// 把「选中若干行」转成一份只含这些改动的补丁。
///
/// 补丁仍由 `git diff` 生成、原样交给 `git apply`（不为行级操作另起一套 apply），
/// 这里只做一件事：**把没选中的改动在补丁里还原成基线**，让它们不被这次操作带走。
///
/// 还原方向取决于补丁是正向还是反向 apply：
/// - 正向（`Stage`，`--cached`）：补丁的「old 侧」是 index。没选中的删除行要退回
///   上下文（index 里这行还在），没选中的新增行整条去掉（不许进 index）。
/// - 反向（`Discard` / `Unstage`，`--reverse`）：补丁匹配的是目标侧（工作区 / index）。
///   正好相反——没选中的新增行退回上下文（目标里这行还在），没选中的删除行整条去掉。
///
/// 之所以两种方向处理的是相反的那种行：未选中的行只有退回上下文才能让补丁在
/// 「基线侧」和「目标侧」两头都对得上，凭空删一行会让其中一头对不齐。
///
/// `selected` 是 hunk 正文（`@@` 行之后）里选中的行下标，与界面上的行号一致。
/// `patch` 一次只带一个 hunk（界面按块调用），多了说明调用方拼错了。
fn patch_for_lines(patch: &str, selected: &[u32], action: &HunkAction) -> Result<String, String> {
    let (header, hunks) = split_patch(patch);
    let hunk = match hunks.as_slice() {
        [only] => only,
        [] => return Err("没有可以应用的改动".to_string()),
        _ => return Err("行级操作一次只能处理一个改动块".to_string()),
    };

    let picked: std::collections::HashSet<u32> = selected.iter().copied().collect();
    // 反向 apply 的两类动作都按「目标侧」理解（见上）
    let reverse = matches!(action, HunkAction::Discard | HunkAction::Unstage);
    let (old_start, new_start) = hunk_start(&hunk.header);

    let mut body = String::new();
    let mut old_count = 0u32;
    let mut new_count = 0u32;
    let mut has_change = false;
    // 上一行有没有被保留：`\ No newline at end of file` 要跟着它，被丢掉就没意义了
    let mut kept_previous = false;

    // 只按换行切、保留行尾——补丁的字节要和 `git diff` 输出完全一致才 apply 得上
    for (offset, line) in hunk.text.split_inclusive('\n').enumerate() {
        if offset == 0 {
            continue; // `@@` 行，稍后按新计数重写
        }
        let body_index = (offset - 1) as u32;
        let tag = line.as_bytes().first().copied().unwrap_or(b' ');
        match tag {
            b'\\' => {
                // 末尾无换行的标记：上一行还在就原样留下，丢了它也没意义
                if kept_previous {
                    body.push_str(line);
                }
            }
            b'+' => {
                if picked.contains(&body_index) {
                    body.push_str(line);
                    new_count += 1;
                    has_change = true;
                    kept_previous = true;
                } else if reverse {
                    // 退回上下文：目标侧这一行还在，结果里也保留
                    body.push(' ');
                    body.push_str(&line[1..]);
                    old_count += 1;
                    new_count += 1;
                    kept_previous = true;
                } else {
                    // 正向：不许进 index，整条去掉
                    kept_previous = false;
                }
            }
            b'-' => {
                if picked.contains(&body_index) {
                    body.push_str(line);
                    old_count += 1;
                    has_change = true;
                    kept_previous = true;
                } else if reverse {
                    // 反向：它本来就不在目标侧，整条去掉
                    kept_previous = false;
                } else {
                    // 正向：退回上下文，index 里这行还在
                    body.push(' ');
                    body.push_str(&line[1..]);
                    old_count += 1;
                    new_count += 1;
                    kept_previous = true;
                }
            }
            _ => {
                // 上下文行原样保留（两侧都在）
                body.push_str(line);
                old_count += 1;
                new_count += 1;
                kept_previous = true;
            }
        }
    }

    if !has_change {
        return Err("选中的行里没有可应用的改动".to_string());
    }

    // hunk 头保留原起始行号、按新内容重算计数；`@@` 后面那段函数提示也原样带回去
    let suffix = hunk.header.find(" @@").map(|i| &hunk.header[i + 3..]).unwrap_or("");
    let new_hunk = format!(
        "@@ -{old_start},{old_count} +{new_start},{new_count} @@{suffix}\n{body}"
    );
    Ok(format!("{header}{new_hunk}"))
}

fn commit_staged(root: &Path, message: &str) -> Result<GitStatus, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    // message 走 argv 直传（不起 shell），$、反引号、分号都只是普通字符；
    // 多行也原样接受，不用 --cleanup=verbatim，用 -m 的默认 whitespace 正好
    run_git_checked(root, &["commit", "-m", message])?;
    status_of(root)
}

/// 用当前暂存区的内容改写 HEAD 那条提交，`--no-edit` 时沿用原来的提交信息。
///
/// 会改写历史：已经推上去的提交 amend 之后本地和远程就分叉了。界面据此在提交过
/// 的内容上给确认框（见 GitChangesPane 的 pendingAmend）。
fn amend_commit(root: &Path, message: Option<&str>) -> Result<GitStatus, String> {
    match message.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => run_git_checked(root, &["commit", "--amend", "-m", text])?,
        None => {
            // 暂存区为空时 `git commit --amend --no-edit` 什么都不改，却照样 0 退出，
            // 界面会误报「成功」。`git diff --cached --quiet` 无暂存改动时 0 退出
            // （run_git 于是返回 Some），据此挡掉。给了 -m 时不拦——那是纯改提交信息，有意义
            if run_git(root, &["diff", "--cached", "--quiet"])?.is_some() {
                return Err("没有要修正的内容".to_string());
            }
            run_git_checked(root, &["commit", "--amend", "--no-edit"])?
        }
    };
    status_of(root)
}

/// 撤销最近一条提交：HEAD 退回上一个提交，改动原样留在暂存区（`--soft`），
/// 工作区一个字节都不动。再点一次「提交」就能把它改完重提。
fn undo_commit(root: &Path) -> Result<GitStatus, String> {
    // 先判有没有 HEAD：空仓库（从未提交）走不到下面，报「没有可撤销的提交」
    // 比「游离 HEAD」准确。注意空仓库的 `rev-parse --abbrev-ref HEAD` 也会输出
    // 字面量 HEAD 并非 0 退出，所以这两个检查的先后不能反
    if run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"])?.is_none() {
        return Err("还没有提交可以撤销".to_string());
    }
    // 游离 HEAD 下没有分支可退，而且下面那条 `update-ref -d HEAD` 会把 `.git/HEAD`
    // 这个**文件**直接删掉，仓库当场变成 `not a git repository`（实测 git 2.54）。
    // 这不是「撤销提交」该干的事，先挡住
    if current_branch(root)?.is_none() {
        return Err("游离 HEAD 状态下不能撤销提交，先切到一个分支上".to_string());
    }
    // 唯一那条提交没有父提交可退，退到 HEAD~1 会报 unknown revision。
    // 直接删掉分支引用，仓库回到「还没提交过」的状态，index 原样留着
    if run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD~1"])?.is_none() {
        run_git_checked(root, &["update-ref", "-d", "HEAD"])?;
        return status_of(root);
    }
    run_git_checked(root, &["reset", "--soft", "HEAD~1"])?;
    status_of(root)
}

/// 工作区相对仓库根的前缀（仓库根就是工作区时是空串）。
/// `Ok(None)` 表示这个目录不是仓库——`rev-parse --show-prefix` 非 0 退出。
fn repo_prefix(root: &Path) -> Result<Option<String>, String> {
    Ok(run_git(root, &["rev-parse", "--show-prefix"])?
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string()))
}

/// 当前分支名；游离 HEAD（输出字面量 "HEAD"）和空仓库（非 0 退出）都是 None。
fn current_branch(root: &Path) -> Result<Option<String>, String> {
    Ok(run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .filter(|name| !name.is_empty() && name != "HEAD"))
}

// ---- 分支 ----

/// 给分支下拉用的一条本地分支。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// 短名，如 main / feature/x
    name: String,
    /// 上游短名，如 origin/main；没配上游时是 None
    upstream: Option<String>,
    /// 相对上游领先/落后的条数；没上游时都是 0
    ahead: u32,
    behind: u32,
    /// 上游被删了（`[gone]`）——这时 ahead/behind 没有意义，界面只提示一下
    gone: bool,
    /// 是不是当前所在的分支
    current: bool,
    /// 被**另一个** worktree 检出的那个工作树路径；没被别的 worktree 占用时是 None。
    /// git 不允许同一分支被两个 worktree 同时检出，切过去必然报错，界面据此提前拦下。
    worktree: Option<String>,
}

/// 解析 `%(upstream:track)`：形如 `[ahead 1, behind 2]` / `[gone]` / 空串（与上游同步）。
/// 没配上游时这一列同样是空串，靠 upstream 那一列是不是空来区分。
fn parse_track(text: &str) -> (u32, u32, bool) {
    let gone = text.contains("gone");
    let mut ahead = 0;
    let mut behind = 0;
    for part in text.trim_matches(['[', ']']).split(',') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("ahead ") {
            ahead = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = part.strip_prefix("behind ") {
            behind = value.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, gone)
}

/// 解析 `for-each-ref` 的输出。字段之间 `%x1f`，记录结尾 `%x00`（后面还跟着
/// for-each-ref 自己的换行，所以每条都 trim 一下）。
fn parse_branches(raw: &[u8]) -> Vec<BranchInfo> {
    let mut branches = Vec::new();
    for record in raw.split(|byte| *byte == 0) {
        let text = String::from_utf8_lossy(record);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let mut fields = text.split('\u{1f}');
        let name = fields.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let upstream = fields.next().unwrap_or("").trim();
        let (ahead, behind, gone) = parse_track(fields.next().unwrap_or(""));
        let current = fields.next().unwrap_or("").trim() == "*";
        branches.push(BranchInfo {
            name,
            upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            ahead,
            behind,
            gone,
            current,
            // 占用信息不在 for-each-ref 里，由 branches_of 另外查出来回填
            worktree: None,
        });
    }
    branches
}

/// 「分支短名 → 检出它的工作树路径」，只收**别的**工作树（排除 root 自己那个）。
///
/// git 不允许同一分支被两个 worktree 同时检出，切到被别的工作树占用的分支必然报
/// `already used by worktree`。这里提前查出来，让分支列表能标出来、提前拦下。
/// 非仓库 / 没装 git 时返回空映射，不影响分支列表本身。
fn worktree_owners(root: &Path) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    let Some(raw) = run_git(root, &["worktree", "list", "--porcelain"]).ok().flatten() else {
        return owners;
    };
    let text = String::from_utf8_lossy(&raw);
    // root 所属的工作树根：root 可能是仓库子目录，也可能就是某个 worktree
    let top = run_git(root, &["rev-parse", "--show-toplevel"])
        .ok()
        .flatten()
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .filter(|value| !value.is_empty());
    for item in parse_worktrees(&text) {
        let Some(branch) = item.branch else {
            continue; // 游离 HEAD / bare 不占用分支
        };
        // 目录已经不存在的失效记录（外部 rm -rf 后没跑 prune 留下的）不算「占用」：
        // 它并没有真的检出这个分支，却会让分支列表提前拦下切换，而那条记录又切不过去
        // （目录都没了），用户既切不了分支也没有清理入口。交给 prune 处理。
        if item.prunable || !Path::new(&item.path).is_dir() {
            continue;
        }
        // 当前工作树自己的分支不算「被占用」（它本来就显示成 current）
        if top.as_deref().is_some_and(|value| same_dir(value, &item.path)) {
            continue;
        }
        owners.insert(branch, item.path);
    }
    owners
}

/// 本地分支清单。只列 `refs/heads`——远程分支要切必须先建出本地跟踪分支，
/// 那是另一件事，不进这一版。
fn branches_of(root: &Path) -> Result<Vec<BranchInfo>, String> {
    // 分隔符用 `%1f` 而不是 `%x1f`：**ref-filter 这套格式是 `%NN` 两位十六进制**，
    // 写 `%x1f` 会原样输出这五个字符（`git log` 的 `%x1f` 才是那个写法，别混）。
    // HEAD 那一列是 `*`（当前分支）或空格，用来标出当前所在的那条
    const FORMAT: &str =
        "--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%00";
    let Some(raw) = run_git(root, &["for-each-ref", FORMAT, "refs/heads"])? else {
        return Ok(Vec::new());
    };
    let mut branches = parse_branches(&raw);
    // 占用信息不在 for-each-ref 里，另行查 worktree 列表回填
    let owners = worktree_owners(root);
    for branch in &mut branches {
        if let Some(path) = owners.get(&branch.name) {
            branch.worktree = Some(path.clone());
        }
    }
    Ok(branches)
}

/// 分支名先过一遍这两道，再交给 git。
///
/// 以 `-` 开头的名字会被 git 当成选项（`switch -b` 之类），必须挡掉；
/// 合法性交给 `check-ref-format`，它报错比 `switch` 的「not a valid object name」
/// 直白得多。返回值直接拼进错误文案。
fn check_branch_name(root: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    if name.starts_with('-') {
        return Err(format!("分支名不能以 - 开头：{name}"));
    }
    if run_git(root, &["check-ref-format", "--branch", name])?.is_none() {
        return Err(format!("分支名不合法：{name}"));
    }
    Ok(())
}

/// `git switch` 的报错里，唯一值得翻译的是「分支已被别的工作树检出」：原文是
/// `fatal: 'x' is already used by worktree at 'D:/...'`，直接透给用户既看不懂也
/// 不知怎么办。翻成中文并带上工作树路径，指个方向。
fn friendly_switch_error(name: &str, err: &str) -> String {
    const MARKER: &str = "is already used by worktree at ";
    if let Some(rest) = err.split(MARKER).nth(1) {
        let path = rest.trim().trim_matches(|c| c == '\'' || c == '"');
        if !path.is_empty() {
            return format!("分支 {name} 已被工作树 {path} 检出，不能在这里切换。");
        }
    }
    err.to_string()
}

fn switch_branch(root: &Path, name: &str) -> Result<GitStatus, String> {
    let name = name.trim();
    check_branch_name(root, name)?;
    // 用 switch 而不是 checkout：checkout 还能接受路径，语义太杂，容易把分支名
    // 当成文件。工作区有未提交改动时 git 自己会拒绝或带走，报错原文透传给用户
    if let Err(err) = run_git_checked(root, &["switch", name]) {
        return Err(friendly_switch_error(name, &err));
    }
    status_of(root)
}

fn create_branch(root: &Path, name: &str) -> Result<GitStatus, String> {
    let name = name.trim();
    check_branch_name(root, name)?;
    run_git_checked(root, &["switch", "-c", name])?;
    status_of(root)
}

// ---- 标签 ----

/// 一个标签，时间线的行内 chip 和「打标签 / 删标签」菜单都用它。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    /// 短名，去掉 refs/tags/ 前缀
    name: String,
    /// 附注标签为 true，轻量标签为 false
    annotated: bool,
    /// 指向的提交短号
    target: String,
    /// 附注标签的说明；轻量标签为空串
    message: String,
}

/// 解析 `for-each-ref refs/tags` 的输出。字段之间 `%1f`、记录结尾 `%00`（同 branches_of）。
///
/// 两处只有实测才知道的细节：
/// - **附注标签**的 `%(objecttype)` 是 `tag`、`%(objectname)` 是 tag 对象本身，
///   它指向的提交在 peeled 列（`%(*objectname:short)`）里；轻量标签没有 peeled 列
///   （该列为空），`%(objectname:short)` 才是提交本身。
/// - `%(contents:subject)` 对**轻量标签**会回落到**提交主题**（不是空的），所以只有
///   附注标签才取它当说明，否则轻量标签的 message 会莫名其妙变成提交标题。
fn parse_tags(raw: &[u8]) -> Vec<TagInfo> {
    let mut tags = Vec::new();
    for record in raw.split(|byte| *byte == 0) {
        let text = String::from_utf8_lossy(record);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let mut fields = text.split('\u{1f}');
        let name = fields.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let objecttype = fields.next().unwrap_or("").trim();
        let objectname = fields.next().unwrap_or("").trim();
        let peeled = fields.next().unwrap_or("").trim();
        let subject = fields.next().unwrap_or("").trim();
        let annotated = objecttype == "tag";
        // 附注标签取 peeled 才是它指向的提交；轻量标签的 peeled 为空，退回 objectname
        let target = if annotated && !peeled.is_empty() {
            peeled
        } else {
            objectname
        };
        tags.push(TagInfo {
            name,
            annotated,
            target: target.to_string(),
            message: if annotated {
                subject.to_string()
            } else {
                String::new()
            },
        });
    }
    tags
}

/// 标签清单。空仓库 / 没标签时返回空数组。
fn tags_of(root: &Path) -> Result<Vec<TagInfo>, String> {
    // 分隔符用 `%1f` 而不是 `%x1f`：ref-filter 这套格式是 `%NN` 两位十六进制
    // （和 branches_of 同一个坑，别混 `git log` 的 `%x1f` 写法）
    const FORMAT: &str = "--format=%(refname:short)%1f%(objecttype)%1f%(objectname:short)%1f%(*objectname:short)%1f%(contents:subject)%00";
    // 没有标签时 git 正常返回空输出、退出码 0；不是仓库时 run_git 给 None
    let Some(raw) = run_git(root, &["for-each-ref", FORMAT, "refs/tags"])? else {
        return Ok(Vec::new());
    };
    Ok(parse_tags(&raw))
}

/// 建标签。`message` 给了就是附注标签（`-a -m`），没给就是轻量标签。
/// `target` 缺省打在当前 HEAD 上（不传那个位置参数）。
///
/// 用 `run_git_checked` 统一错误透传：名字非法（空、空格、`..`、`~` 等）时 git
/// 自己会报错，比我们复刻一遍 `check-ref-format` 的规则更准。
fn create_tag(
    root: &Path,
    name: &str,
    message: Option<&str>,
    target: Option<&str>,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["tag"];
    match message {
        // 空串也是「有值」：勾了附注标签却没写说明，git 仍该建出附注标签
        Some(message) => {
            args.push("-a");
            args.push(name);
            args.push("-m");
            args.push(message);
        }
        None => args.push(name),
    }
    if let Some(target) = target.map(str::trim).filter(|text| !text.is_empty()) {
        args.push(target);
    }
    run_git_checked(root, &args)
}

/// 删标签。只动标签引用，不碰时间线。
fn delete_tag(root: &Path, name: &str) -> Result<(), String> {
    run_git_checked(root, &["tag", "-d", name])
}

// ---- stash ----

/// 一条 stash 记录。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// `stash@{n}` 里的那个 n，恢复 / 丢弃时要原样带回去
    index: u32,
    /// git 自己生成的说明，形如 `WIP on main: abc1234 上一条提交`
    message: String,
    /// stash 本身是个提交，点开能当提交看
    hash: String,
    /// 创建时间（Unix 秒）
    time: i64,
}

fn parse_stashes(raw: &[u8]) -> Vec<StashEntry> {
    let mut out = Vec::new();
    for record in raw.split(|byte| *byte == 0) {
        let text = String::from_utf8_lossy(record);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let mut fields = text.split('\u{1f}');
        // %gd 给的是 `stash@{0}`，只要里面那个数字
        let selector = fields.next().unwrap_or("");
        let Some(index) = selector
            .trim()
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse::<u32>()
            .ok()
        else {
            continue;
        };
        out.push(StashEntry {
            index,
            hash: fields.next().unwrap_or("").trim().to_string(),
            time: fields.next().unwrap_or("").trim().parse().unwrap_or(0),
            message: fields.next().unwrap_or("").to_string(),
        });
    }
    out
}

/// 已存下的 stash，最新的在最前（`stash@{0}`）。
fn stashes_of(root: &Path) -> Result<Vec<StashEntry>, String> {
    const FORMAT: &str = "--format=%gd%x1f%H%x1f%ct%x1f%s%x00";
    // 没有 stash 时 git 正常返回空输出，退出码是 0
    let Some(raw) = run_git(root, &["stash", "list", FORMAT])? else {
        return Ok(Vec::new());
    };
    Ok(parse_stashes(&raw))
}

/// 把当前改动收进 stash。
///
/// **不收未跟踪的新文件**（不给 `--include-untracked`）：默认语义下新文件会留在原地，
/// 这比「文件突然从工作区消失」安全；界面上按钮的 title 写明了这一点。
///
/// 只有未跟踪文件时 git 会打印 `No local changes to save` 但**以 0 退出**——照原样
/// 返回的话界面会以为成功了，而实际什么也没发生（用户点了按钮看不到反应）。所以
/// 用「stash 条数有没有变多」判一次，没变多就如实报错。
fn stash_push(root: &Path, message: Option<&str>) -> Result<GitStatus, String> {
    let before = stashes_of(root)?.len();

    let mut args = vec!["stash", "push"];
    let text = message.map(str::trim).filter(|text| !text.is_empty());
    if let Some(text) = text {
        args.push("-m");
        args.push(text);
    }
    run_git_checked(root, &args)?;

    if stashes_of(root)?.len() <= before {
        return Err(
            "没有可以储藏的改动（未跟踪的新文件不在储藏范围内，先暂存它或手动处理）"
                .to_string(),
        );
    }
    status_of(root)
}

/// `stash@{index}` 的字面写法。`format!` 里花括号要写两遍
fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

/// 恢复并删掉那条 stash。冲突时 git 不删记录，报错原文透传。
fn stash_pop(root: &Path, index: u32) -> Result<GitStatus, String> {
    run_git_checked(root, &["stash", "pop", &stash_ref(index)])?;
    status_of(root)
}

/// 只恢复、保留记录（同一条可以 apply 到多个分支上）
fn stash_apply(root: &Path, index: u32) -> Result<GitStatus, String> {
    run_git_checked(root, &["stash", "apply", &stash_ref(index)])?;
    status_of(root)
}

fn stash_drop(root: &Path, index: u32) -> Result<GitStatus, String> {
    run_git_checked(root, &["stash", "drop", &stash_ref(index)])?;
    status_of(root)
}

/// 仓库是不是正卡在一次没结束的合并里（有冲突待解决，或已解决但还没提交）。
///
/// 用 MERGE_HEAD 而不是解析 status：porcelain v2 根本不暴露合并状态，而且
/// 冲突文件全部 add 完之后 unmerged 记录就消失了，靠 status 判会提前认为
/// "合并结束了"。rev-parse 自己会解析真实 gitdir（含 worktree 那种情况），
/// 比手拼 `.git/MERGE_HEAD` 路径稳。`-q` 压掉"不存在"的报错，非 0 退出即 false。
fn is_merging(root: &Path) -> Result<bool, String> {
    Ok(run_git(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])?.is_some())
}

/// 当前卡在哪种多步操作里（有冲突待解决，或已解决但还没收尾）。
///
/// 除了 merge，rebase / cherry-pick / revert 也会把仓库留在"进行中"状态，但它们
/// 收尾用的子命令各不相同（`rebase --continue` / `cherry-pick --continue` …），
/// 不能复用 `merge --continue`，所以光知道"有没有进行中的操作"不够，还得知道是哪种，
/// 前端才能给出对应的引导。
///
/// 用 `rev-parse --verify` 探测而不是手拼 `.git/REBASE_HEAD`：rev-parse 自己会解析
/// 真实 gitdir（worktree、子目录都在内），比拼路径稳；`-q` 压掉"不存在"的报错，
/// 非 0 退出即视为没有。
///
/// 顺序按"专有标记优先"排，把最通用的 CHERRY_PICK_HEAD 放最后：rebase / revert
/// 在内部都借用了拣选的机制，历史上（或某些版本里）会一并留下 CHERRY_PICK_HEAD，
/// 先查它就会把变基 / 还原误判成拣选。实测 git 2.55 下四种状态各自只留一个标记，
/// 但按这个顺序排更保险。
fn merge_state(root: &Path) -> Result<Option<&'static str>, String> {
    for (head, kind) in [
        ("MERGE_HEAD", "merge"),
        ("REBASE_HEAD", "rebase"),
        ("REVERT_HEAD", "revert"),
        ("CHERRY_PICK_HEAD", "cherryPick"),
    ] {
        if run_git(root, &["rev-parse", "-q", "--verify", head])?.is_some() {
            return Ok(Some(kind));
        }
    }
    Ok(None)
}

/// 两侧内容统一按 LF 比较。
///
/// 本机 `core.autocrlf=true`：index 里存的是 LF、工作区常是 CRLF。不归一就会
/// 出现"整个文件都改了"的假差异。归一之后正好和 `git diff` 的默认行为一致——
/// 只改行尾的改动本来也不该显示出来。归一放在**解码之后**的字符串上做（见 `classify`）。
fn normalize_newlines(text: String) -> String {
    text.replace("\r\n", "\n")
}

fn classify(bytes: Vec<u8>) -> Side {
    // cat-file -s 报的是 raw blob 大小，取回来先兜一道，免得白解码一个超大对象
    if bytes.len() as u64 > fs_api::MAX_TEXT_SIZE {
        return Side::TooLarge;
    }
    // 按检测到的编码解码。以前这里 `from_utf8_lossy`：GBK / Big5 的非法字节全变成
    // U+FFFD，差异正文整个花掉；`decode_text` 顺带先认 BOM，UTF-16 也不会因 NUL 被误判成二进制。
    match fs_api::decode_text(&bytes) {
        Some(text) => Side::Text(normalize_newlines(text)),
        None => Side::Binary,
    }
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
fn file_diff(root: &Path, path: &str, source: &DiffSource) -> Result<FileDiff, String> {
    // --show-prefix 一次调用同时回答"是不是仓库"和"工作区在仓库里的哪一层"。
    // 工作区可能只是仓库的子目录，而 `cat-file` 的 `<path>` 是相对仓库根的，
    // 所以这里必须把 prefix 拼上（pathspecs 那个相对工作区的写法不能直接用）。
    let prefix = repo_prefix(root)?.ok_or("这个目录不是 git 仓库")?;
    let (target, relative) = workspace_relative(root, path)?;
    let repo_path = format!("{prefix}{relative}");

    let (original, modified) = match source {
        DiffSource::Staged => (
            blob_side(root, &format!("HEAD:{repo_path}"))?,
            blob_side(root, &format!(":{repo_path}"))?,
        ),
        DiffSource::Unstaged => (
            blob_side(root, &format!(":{repo_path}"))?,
            worktree_side(&target)?,
        ),
        DiffSource::Commit { rev } => {
            let rev = checked_rev(rev)?;
            // 根提交没有父提交，`<rev>^` 解析不了 —— 正好落成空基线，
            // 语义上也对：根提交里的文件本来就都是新增的
            (
                blob_side(root, &format!("{rev}^:{repo_path}"))?,
                blob_side(root, &format!("{rev}:{repo_path}"))?,
            )
        }
        DiffSource::Range { from, to } => {
            // 两侧都是任意 ref，先各自解析成完整 hash：`from` 侧缺失=新增、
            // `to` 侧缺失=删除，blob_side 的 Missing 正好表达这两种
            let from = resolve_commit(root, from)?;
            let to = resolve_commit(root, to)?;
            (
                blob_side(root, &format!("{from}:{repo_path}"))?,
                blob_side(root, &format!("{to}:{repo_path}"))?,
            )
        }
    };

    Ok(to_diff(original, modified))
}

/// 一个改动文件的统一 diff 文本，喂给大模型解读用。
///
/// 取 `git diff` 的原文而不是 `file_diff` 的两侧全文：diff 只带改动的上下文，
/// 同样长度下信息密度高得多，大文件也不会一上来就被截掉后面一大半。
///
/// 未跟踪的文件没有基线，`git diff` 一行都不出，这时把工作区文件整个当成新增
/// 内容——右键一个刚建的文件，总得有东西可讲。
pub(crate) fn file_diff_text(
    root: &Path,
    path: &str,
    source: &DiffSource,
) -> Result<String, String> {
    let (target, spec) = workspace_relative(root, path)?;
    // 提交号 / ref 字符串要活得比 args 久（args 里存的是借用），先在 match 外面拿到手
    let rev = match source {
        DiffSource::Commit { rev } => Some(checked_rev(rev)?),
        _ => None,
    };
    // 范围比较的两侧也各自解析成完整 hash，`{from}..{to}` 这个参数同样要活过 args
    let range = match source {
        DiffSource::Range { from, to } => {
            Some(format!("{}..{}", resolve_commit(root, from)?, resolve_commit(root, to)?))
        }
        _ => None,
    };
    let args: Vec<&str> = if let Some(rev) = rev.as_deref() {
        // 只看这个文件本身，`--format=` 把提交头也去掉，剩下的全是 diff
        vec!["show", "--no-color", "--format=", rev, "--", &spec]
    } else if let Some(range) = range.as_deref() {
        vec!["diff", "--no-color", range, "--", &spec]
    } else if matches!(source, DiffSource::Staged) {
        vec!["diff", "--cached", "--no-color", "--", &spec]
    } else {
        vec!["diff", "--no-color", "--", &spec]
    };

    if let Some(raw) = run_git_literal(root, &args)? {
        // diff 头部是 ASCII、正文是文件原始字节：按检测到的编码解，GBK / Big5 的改动
        // 才不会在 AI 解读里变成乱码；解不出来（真二进制）才退回 lossy
        let text = fs_api::decode_text(&raw)
            .unwrap_or_else(|| String::from_utf8_lossy(&raw).into_owned())
            .trim_end()
            .to_string();
        if !text.is_empty() {
            return Ok(text);
        }
    }

    // 走到这儿只可能是未跟踪的新文件（已删除、已暂存新增的 diff 都不是空的）
    match worktree_side(&target)? {
        Side::Text(body) => {
            let mut text = String::from("(新增文件，下面是全部内容)\n");
            for line in body.lines() {
                text.push('+');
                text.push_str(line);
                text.push('\n');
            }
            Ok(text)
        }
        Side::Binary => Err("这是二进制文件，看不出改了哪些内容".to_string()),
        Side::TooLarge => Err("文件太大，读不出内容来解读".to_string()),
        Side::Missing => Err("这个文件没有可解读的改动".to_string()),
    }
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

/// 把一个任意 ref（提交号 / 分支 / 标签 / HEAD 等）解析成完整提交 hash。
///
/// 和 `checked_rev` 那条严格十六进制路径分开：历史列表给的本来就是完整 hash，
/// 但「比较任意两个提交 / 与分支比较」要接受分支名、`HEAD`、短 hash 这些写法。
/// 用 `rev-parse --verify --end-of-options`：`--end-of-options` 挡住以 `-` 开头的
/// 字符串被当成 git 选项（比如把 `--foo` 当开关），`--verify` 保证它确实解析得到
/// 一个提交（`^{commit}` 顺带把 tag 解到它指向的提交）；解不出就报错，不放它
/// 带着 revspec 语法（`..`、`^`、`@{...}`）继续往下走。
fn resolve_commit(root: &Path, raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("提交或引用不能为空".to_string());
    }
    let spec = format!("{text}^{{commit}}");
    match run_git(root, &["rev-parse", "--verify", "--end-of-options", &spec])? {
        Some(bytes) => {
            let hash = String::from_utf8_lossy(&bytes)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if hash.is_empty() {
                return Err(format!("不是合法的提交或引用: {raw}"));
            }
            Ok(hash)
        }
        None => Err(format!("不是合法的提交或引用: {raw}")),
    }
}

// ---- 时间线 ----

/// `%x1f` 分隔字段、`%x00` 结尾。字段里可能带空格（作者名、提交信息、装饰名），
/// 所以不能用空格或换行当分隔符。`%P` 是父 hash（空格分隔，可能多个）、`%D` 是引用装饰、
/// `%b` 是正文（多行，所以放最后，解析时取剩余部分）。
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%D%x1f%s%x1f%b%x00";

/// 一次拉多少条。界面上还有「加载更多」，所以给个够用的默认值就行。
const LOG_PAGE: u32 = 50;
const LOG_MAX: u32 = 500;

/// 解析 `%D` 的装饰串（配合 `--decorate=full`，形如
/// `HEAD -> refs/heads/main, refs/remotes/origin/main, refs/tags/v1.0`）。
///
/// 分类靠 refs 前缀；万一某版 git 的 `%D` 不受 `--decorate=full` 影响、给的是短名，
/// 就退化成「含 `/` 视为远程」的兜底判断——本地分支带斜杠时会被误判，属于可接受的降级。
fn parse_decorations(raw: &str) -> Vec<CommitRef> {
    let mut refs = Vec::new();
    for token in raw.split(", ") {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        // `HEAD -> <ref>`：HEAD 指向的分支，单独标成 head
        if let Some(target) = token.strip_prefix("HEAD -> ") {
            refs.push(CommitRef {
                name: short_ref_name(target),
                kind: "head".to_string(),
            });
            continue;
        }
        if token == "HEAD" {
            refs.push(CommitRef {
                name: "HEAD".to_string(),
                kind: "head".to_string(),
            });
            continue;
        }
        // 标签带 `tag: ` 前缀。`--decorate=full` 下它后面仍是全名（`tag: refs/tags/v1.0`），
        // 得照样剥前缀——只去掉 `tag: ` 会显示成 `refs/tags/v1.0`。
        if let Some(name) = token.strip_prefix("tag: ") {
            refs.push(CommitRef {
                name: short_ref_name(name),
                kind: "tag".to_string(),
            });
            continue;
        }
        let kind = if token.starts_with("refs/tags/") {
            "tag"
        } else if token.starts_with("refs/heads/") {
            "branch"
        } else if token.starts_with("refs/remotes/") {
            "remote"
        } else if token.contains('/') {
            // 兜底：拿不到全名时，带斜杠的当远程分支
            "remote"
        } else {
            "branch"
        };
        refs.push(CommitRef {
            name: short_ref_name(token),
            kind: kind.to_string(),
        });
    }
    refs
}

/// 去掉 `refs/heads/`、`refs/remotes/`、`refs/tags/` 前缀，只留显示用的短名。
fn short_ref_name(reference: &str) -> String {
    reference
        .strip_prefix("refs/heads/")
        .or_else(|| reference.strip_prefix("refs/remotes/"))
        .or_else(|| reference.strip_prefix("refs/tags/"))
        .unwrap_or(reference)
        .to_string()
}

fn parse_log(raw: &[u8]) -> Vec<Commit> {
    raw.split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let owned = String::from_utf8_lossy(record);
            // git 会在每条记录之间插一个换行，落在 `%x00` 后面；不剥掉的话它会粘到
            // 下一条记录的 `%H` 上（`%H` 在最前），父 hash 就对不上了、泳道全散开
            let text = owned.trim_start_matches(['\n', '\r']);
            let mut fields = text.split('\u{1f}');
            let hash = fields.next()?.to_string();
            let short = fields.next()?.to_string();
            let author = fields.next()?.to_string();
            let time = fields.next()?.parse().unwrap_or(0);
            let parents = fields
                .next()
                .unwrap_or_default()
                .split(' ')
                .filter(|parent| !parent.is_empty())
                .map(str::to_string)
                .collect();
            let refs = parse_decorations(fields.next().unwrap_or_default());
            let subject = fields.next().unwrap_or_default().to_string();
            // 正文放最后，取剩余全部：它本身是多行文本，里面再有分隔符也不会被切断
            let body = fields.collect::<Vec<_>>().join("\u{1f}");
            Some(Commit {
                hash,
                short,
                author,
                time,
                subject,
                body: body.trim().to_string(),
                parents,
                refs,
            })
        })
        .collect()
}

/// 按主题 / 作者 / 正文做不区分大小写的子串匹配。
///
/// 用 Rust 后置过滤，而不是 git 的 `--grep` + `--author`：git 把这两个条件是
/// **AND** 起来的（实测 `--grep=X --author=X` 只返回同时命中两者的提交），我们要的是
/// 「任一命中」，没有单条 git 命令能表达。代价是过滤只作用于已经拉下来的那一段，
/// 所以过滤时把拉取条数顶到上限（见 log_filtered）。
fn filter_commits(commits: Vec<Commit>, needle: &str) -> Vec<Commit> {
    let needle = needle.to_lowercase();
    commits
        .into_iter()
        .filter(|commit| {
            commit.subject.to_lowercase().contains(&needle)
                || commit.author.to_lowercase().contains(&needle)
                || commit.body.to_lowercase().contains(&needle)
        })
        .collect()
}

/// 拉时间线，可带过滤。`path` 给 git 当 pathspec（`git log -- <path>`），
/// `filter` 走 filter_commits 后置匹配。
fn log_filtered(
    root: &Path,
    limit: u32,
    filter: Option<&str>,
    path: Option<&str>,
) -> Result<Vec<Commit>, String> {
    if repo_prefix(root)?.is_none() {
        return Ok(Vec::new());
    }

    let filter = filter.map(str::trim).filter(|text| !text.is_empty());
    let path = path.map(str::trim).filter(|text| !text.is_empty());

    // 过滤是把结果筛掉一部分，还按普通的一页去取的话，前面一段没命中就看着像「没有」，
    // 所以过滤时一次顶到上限。
    let want = if filter.is_some() || path.is_some() {
        LOG_MAX
    } else {
        limit
    };
    let count = want.clamp(1, LOG_MAX).to_string();
    let arg = format!("--max-count={count}");
    // 空仓库（还没有任何提交）时 git log 非 0 退出，那不是错误，给空列表。
    // `--topo-order` 保证父提交一定排在子提交之后（画泳道图的前提，默认的时间序做不到）；
    // `--decorate=full` 让 `%D` 给出 refs/… 全名，好把分支 / 远程 / 标签分开。
    let mut args: Vec<&str> = vec!["log", &arg, "--topo-order", "--decorate=full", LOG_FORMAT];
    if let Some(path) = path {
        // `--` 之后一律按字面路径理解，省得带 `*`、`[` 的路径名被当通配符
        args.push("--");
        args.push(path);
    }
    let raw = run_git(root, &args)?.unwrap_or_default();
    let commits = parse_log(&raw);
    Ok(match filter {
        Some(needle) => filter_commits(commits, needle),
        None => commits,
    })
}

/// 还没推送到上游的提交号（HEAD 有、上游没有的那几条），界面拿它在历史里标出来。
///
/// 交给 git 算，不在前端按 `ahead` 的条数从前往后数：合并进来的提交同样算 ahead，
/// 而它们在 `git log` 里和已推送的提交是交错排的；两边都有新提交（分叉）时上游那条
/// 根本不在 HEAD 的历史里，就更数不出来了。
///
/// 没有上游时 `@{u}` 解析不了，git 非 0 退出 → `run_git` 给 None → 空列表，
/// 不是错误（`ahead` 那时也是 0，界面上本来就没有要标的东西）。
fn unpushed_of(root: &Path) -> Result<Vec<String>, String> {
    if repo_prefix(root)?.is_none() {
        return Ok(Vec::new());
    }
    let Some(raw) = run_git(root, &["log", "--format=%H", "@{u}..HEAD"])? else {
        return Ok(Vec::new());
    };
    Ok(String::from_utf8_lossy(&raw)
        .lines()
        .map(str::trim)
        .filter(|hash| !hash.is_empty())
        .map(str::to_string)
        .collect())
}

/// 解析 `--name-status -z` 的输出：`<状态>\0<路径>\0` 交替出现。
/// 重命名/复制多一个 token，是 `<R100>\0<原路径>\0<新路径>\0`。
fn parse_name_status(raw: &[u8], prefix: &str, root: &Path) -> Vec<CommitFile> {
    let mut files = Vec::new();
    let mut tokens = raw
        .split(|byte| *byte == 0)
        .filter(|token| !token.is_empty());

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

fn files_of(root: &Path, rev: &str) -> Result<Vec<CommitFile>, String> {
    let prefix = repo_prefix(root)?.ok_or("这个目录不是 git 仓库")?;
    let rev = checked_rev(rev)?;
    let raw = run_git(root, &["show", "--name-status", "-z", "--format=", &rev])?
        .ok_or("git show 执行失败")?;
    Ok(parse_name_status(&raw, &prefix, root))
}

/// 两个 ref 之间改动过的文件列表（比较视图用）。
///
/// 和 `files_of` 的区别：后者是「某个提交相对它父提交」，这里是「任意两点之间」，
/// 两侧都能是分支 / 标签 / HEAD。`git diff <from>..<to>` 直接比两棵树，rename / 新增 /
/// 删除都照 `--name-status` 给出来，解析交给同一个 `parse_name_status`（R/C 已处理）。
/// `from` 与 `to` 解析成同一个提交时 diff 为空、返回空列表，不是错误——界面上提示
/// 「没有差异」即可。
fn compare_files(root: &Path, from: &str, to: &str) -> Result<Vec<CommitFile>, String> {
    let prefix = repo_prefix(root)?.ok_or("这个目录不是 git 仓库")?;
    let from = resolve_commit(root, from)?;
    let to = resolve_commit(root, to)?;
    let raw = run_git(root, &["diff", "--name-status", "-z", &format!("{from}..{to}")])?
        .ok_or("git diff 执行失败")?;
    Ok(parse_name_status(&raw, &prefix, root))
}

/// 一条提交的改动规模，悬停浮框上显示。
///
/// 走 `--numstat` 而不是 `--shortstat`：后者是给人看的、会随 locale 变（"2 files changed…"
/// 有翻译），数值反而不好取；`--numstat` 每行是 `增\t删\t路径`，二进制给 `-\t-`，语言无关。
/// 和 `files_of` 一样按 `git show` 的默认口径（合并提交是空 diff），两边对得上。
fn stat_of(root: &Path, rev: &str) -> Result<CommitStat, String> {
    let rev = checked_rev(rev)?;
    let raw = run_git(root, &["show", "--numstat", "--format=", &rev])?
        .ok_or("git show 执行失败")?;
    let text = String::from_utf8_lossy(&raw);
    let mut stat = CommitStat {
        files: 0,
        insertions: 0,
        deletions: 0,
    };
    for line in text.lines() {
        let mut columns = line.split('\t');
        let (Some(added), Some(removed)) = (columns.next(), columns.next()) else {
            continue;
        };
        // 二进制文件给的是 `-`，只算文件数、不计行数
        stat.files += 1;
        stat.insertions += added.parse::<u32>().unwrap_or(0);
        stat.deletions += removed.parse::<u32>().unwrap_or(0);
    }
    Ok(stat)
}

/// 「按主题分条提交」要喂给大模型的原料。和单条提交时的取料不同：单条只喂暂存区，
/// 这个要把已暂存、未暂存、未跟踪一起算上——分条提交面对的是「整个工作区里还没提交的这一堆改动」。
pub struct CommitPlanContext {
    /// `git diff HEAD` 的原文（已暂存 + 未暂存一起，相对工作区根）；空仓库无 HEAD 时退回 `--cached`
    pub diff: String,
    /// 全部改动条目的工作区相对路径（含未跟踪；未跟踪目录会折叠成 `dir/`）。给模型的合法路径白名单
    pub files: Vec<String>,
    /// 当前分支；游离 HEAD 或空仓库时为 None
    pub branch: Option<String>,
    /// 最近几条提交的主题，给模型当措辞参考
    pub recent_subjects: Vec<String>,
}

/// 取「相对 HEAD 的全部改动」的 diff + 文件清单 + 分支 + 近期提交主题。全走只读的 `run_git`，
/// 非 0 退出（空仓库的 log、游离 HEAD 的 rev-parse）当"没有"处理，不算错误。
pub(crate) fn commit_plan_context(root: &Path) -> Result<CommitPlanContext, String> {
    // 游离 HEAD 时 `--abbrev-ref` 输出字面量 "HEAD"，等于没有分支名
    let branch = current_branch(root)?;

    // 空仓库里没有提交，git log 非 0 退出 → None → 空列表
    let recent_subjects = run_git(root, &["log", "-5", "--format=%s"])?
        .map(|bytes| {
            String::from_utf8_lossy(&bytes)
                .lines()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    // 文件清单取自 status：已暂存、未暂存、未跟踪都在 files 里，未跟踪目录会折叠成 `dir/`。
    // **不排除目录**——`git add -A -- dir/` 能整目录收进来，排掉反而会漏掉整个新目录，
    // 分条执行后留下残余。
    let files = status_of(root)?
        .files
        .iter()
        .map(|file| file.relative.clone())
        .collect();

    // 有 HEAD 时 `diff HEAD` 一次拿到「工作区相对 HEAD」的全部改动（暂存的 + 没暂存的）；
    // 空仓库（还没提交过）没有 HEAD，退回 `--cached`，按空树比照样列出已暂存的新增。
    // `--relative` 让路径相对工作区根，和上面 status 的 relative 同一个口径
    // （工作区可能只是仓库的子目录，不对齐的话模型看到的是两套路径）。
    // 同 `file_diff_text`：按检测到的编码解，GBK / Big5 的内容才不会喂一坨乱码给模型。
    let has_head = run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"])?.is_some();
    let args: Vec<&str> = if has_head {
        vec!["diff", "HEAD", "--relative", "--no-color"]
    } else {
        vec!["diff", "--cached", "--relative", "--no-color"]
    };
    let diff = run_git(root, &args)?
        .map(|bytes| {
            fs_api::decode_text(&bytes)
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).into_owned())
        })
        .unwrap_or_default();

    Ok(CommitPlanContext {
        diff,
        files,
        branch,
        recent_subjects,
    })
}

// ---- 远程操作 ----

/// 从远程取回引用，不动工作区，也不动当前分支。fetch 完 ahead/behind 就准了，
/// 用户可以据此决定要不要拉。不带 remote 参数：按当前分支的上游走，
/// 没有远程仓库时 git 自己会报错，原样透传比我们自己编一句更有用。
fn fetch_remote(root: &Path) -> Result<GitStatus, String> {
    run_git_network(root, &["fetch"])?;
    status_of(root)
}

/// 拉取。
///
/// `--ff-only`：只走保守的快进路径。本地和远程分叉时直接失败，不悄悄产生一个
/// 合并提交、也不把仓库带进冲突状态——真分叉交给用户点「合并」按钮，显式地选择
/// 生成合并提交（见 merge_upstream）。
/// `--no-rebase`：把用户全局配置里的 `pull.rebase=true` 压掉，行为在哪儿都一样。
/// ff-only 不会生成合并提交，所以不需要 `--no-edit`。
fn pull_remote(root: &Path) -> Result<GitStatus, String> {
    if current_branch(root)?.is_none() {
        return Err("当前不在任何分支上（游离 HEAD），无法拉取".to_string());
    }
    run_git_network(root, &["pull", "--ff-only", "--no-rebase"])?;
    status_of(root)
}

/// 推送。
///
/// 新分支第一次推要顺手 `-u`：不建立跟踪关系的话推完 ahead/behind 还是空的，
/// 用户看不出到底推成功没有，下次还得再推一次。
/// 被拒时先快进拉取再重推一次；拉不动（本地已分叉，或网络/凭据有问题）就
/// 原样报错，这里不做 force push、也不解决冲突。
fn push_remote(root: &Path) -> Result<GitStatus, String> {
    let branch = current_branch(root)?.ok_or("当前不在任何分支上（游离 HEAD），无法推送")?;

    // 上游存在时 `@{u}` 能解析出 origin/main 这样的名字；非 0 退出即没有上游
    let has_upstream = run_git(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?
    .is_some();

    if has_upstream {
        if let Err(rejected) = run_git_network(root, &["push"]) {
            // 落后于远程时 git 会拒绝推送。这里不去解析 stderr 认「non-fast-forward」
            // 那几个词——文案随 git 版本和语言环境变（见下面分叉那条测试的注释）。
            // 直接补一次快进拉取：能快进说明确实是纯落后，拉完重推一次就成；
            // ff-only 拉不动说明本地也提交了、已经分叉，把两边的 git 原文一起
            // 回传，怎么处理交给终端。
            //
            // 也不能拿本地 status 的 behind 当闸门：push 被拒时 git 并不更新
            // refs/remotes/*，那会儿 behind 往往还是 0，重试就永远不会触发。
            run_git_network(root, &["pull", "--ff-only", "--no-rebase"])
                .map_err(|blocked| format!("{rejected}\n{blocked}"))?;
            run_git_network(root, &["push"])?;
        }
    } else {
        // 没配上游就推到第一个远程。`git remote` 按字母序输出，常见仓库里
        // origin 天然排在最前；一个远程都没有时给一句能看懂的提示
        let remote = run_git(root, &["remote"])?
            .and_then(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .lines()
                    .next()
                    .map(str::to_string)
            })
            .filter(|name| !name.is_empty())
            .ok_or("没有配置远程仓库，先在终端里 git remote add")?;
        run_git_network(root, &["push", "-u", &remote, &branch])?;
    }

    status_of(root)
}

/// 合并上游：先取回引用，再把上游分支合进当前分支。
///
/// 刻意不用 `git pull`：pull 把"网络"和"改工作区"揉成一次调用，失败时没法区分
/// 是网络断了（工作区没动，可以直接重试）还是合并冲突（工作区已经进了合并状态，
/// 得让用户解决或中止）。拆两步后 fetch 失败就是网络问题，merge 失败再看
/// MERGE_HEAD 判是不是冲突。顺带也绕开用户的 pull.rebase / pull.ff 配置。
///
/// 不加 `--no-ff`：纯落后时按默认快进，只有真分叉才生成合并提交，和 pull 一致。
/// `--no-edit`：用 git 生成的默认合并信息，不弹编辑器（我们本来也没有 TTY）。
///
/// 目标固定 `@{u}` 而不是 `FETCH_HEAD`：无参 fetch 可能一次取回多个 ref，
/// FETCH_HEAD 在那种情况下有歧义，而 `@{u}` 明确指向当前分支的远程跟踪分支。
fn merge_upstream(root: &Path) -> Result<GitStatus, String> {
    if current_branch(root)?.is_none() {
        return Err("当前不在任何分支上（游离 HEAD），无法合并".to_string());
    }
    if is_merging(root)? {
        return Err("已经有一次没结束的合并，先解决冲突提交或中止它".to_string());
    }
    // 上游必须先存在。放在 fetch 之前查：没有跟踪分支时先报的会是 fetch 的错，
    // 那句更难懂，也帮不到用户
    if run_git(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?
    .is_none()
    {
        return Err("当前分支没有上游分支，先在终端里 push -u 建立跟踪关系".to_string());
    }

    run_git_network(root, &["fetch"])?;

    if let Err(failed) = run_git_checked(root, &["merge", "--no-edit", "@{u}"]) {
        // 冲突会让 merge 非 0 退出，并在仓库里留下 MERGE_HEAD。这不是"失败"，
        // 而是"等用户解决"——照常把状态回传，前端据 merging 切到合并中界面。
        // 工作区脏、钩子失败等别的原因不会留下 MERGE_HEAD，走下面的 Err 透传
        if is_merging(root)? {
            return status_of(root);
        }
        return Err(failed);
    }
    status_of(root)
}

/// 中止当前进行中的多步操作：把工作区和 index 回到操作开始之前。
///
/// 四种操作各用各的子命令（`merge --abort` / `rebase --abort` / `revert --abort` /
/// `cherry-pick --abort`），不能复用。不在任何进行中状态时当 no-op 返回当前状态：
/// 按钮本就存在竞态，这时报一句"没有可中止的操作"对用户没意义，反而像个 bug。
fn merge_abort(root: &Path) -> Result<GitStatus, String> {
    let Some(kind) = merge_state(root)? else {
        return status_of(root);
    };
    let args: &[&str] = match kind {
        "rebase" => &["rebase", "--abort"],
        "revert" => &["revert", "--abort"],
        "cherryPick" => &["cherry-pick", "--abort"],
        _ => &["merge", "--abort"],
    };
    run_git_checked(root, args)?;
    status_of(root)
}

/// 完成当前进行中的多步操作。
///
/// merge 的收尾是生成合并提交，用 `commit --no-edit` 直接吃 git 准备好的 MERGE_MSG；
/// 不复用 commit_staged：那要用户手写信息，而且会盖掉 MERGE_MSG 里那段
/// "Merge branch ..." 的默认说明。变基 / 拣选 / 还原各走自己的 `--continue`。
///
/// 还有没解决的冲突时 git 自己会拒绝并列出一条条 unmerged 路径，
/// run_git_checked 把它的原文原样透传，前端错误区（whitespace-pre-wrap）放得下。
///
/// `--continue` 可能拉起编辑器让我们确认提交信息（我们没有 TTY，会卡到超时），
/// 统一带上 `GIT_EDITOR` / `GIT_SEQUENCE_EDITOR=true` 直接接受默认信息；合并那条
/// `commit --no-edit` 本就不开编辑器，一并设上也无害。
fn merge_continue(root: &Path) -> Result<GitStatus, String> {
    let Some(kind) = merge_state(root)? else {
        return Err("当前没有正在进行的合并 / 变基 / 拣选 / 还原".to_string());
    };
    let args: &[&str] = match kind {
        "rebase" => &["rebase", "--continue"],
        "revert" => &["revert", "--continue"],
        "cherryPick" => &["cherry-pick", "--continue"],
        _ => &["commit", "--no-edit"],
    };
    run_git_checked_env(
        root,
        args,
        &[("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")],
    )?;
    status_of(root)
}

/// 冲突文件怎么解决：留当前侧（ours）/ 传入侧（theirs）/ 两侧都要。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    Ours,
    Theirs,
    Both,
}

/// 解决一个冲突文件，然后把它标记为已解决（`git add` 进 index、清掉冲突条目）。
///
/// `Ours` / `Theirs` 让 git 从对应 stage 里检出该文件的一侧（`checkout --ours` 取
/// stage 2 = 当前分支侧，`--theirs` 取 stage 3 = 传入侧）；`Both` 读工作区里带冲突
/// 标记的文件，把每个冲突块替换成"ours 段 + theirs 段"（去掉三行标记）再写回。
///
/// pathspec 的取法和 stage_paths 一致：命令以工作区为 cwd、pathspec 相对工作区，
/// 靠 workspace_relative 剥出前缀（见 pathspecs）。
fn resolve_conflict(
    root: &Path,
    path: &str,
    choice: &ConflictChoice,
) -> Result<GitStatus, String> {
    let (target, spec) = workspace_relative(root, path)?;

    match choice {
        ConflictChoice::Ours => {
            run_git_checked(root, &["checkout", "--ours", "--", &spec])?;
        }
        ConflictChoice::Theirs => {
            run_git_checked(root, &["checkout", "--theirs", "--", &spec])?;
        }
        ConflictChoice::Both => {
            let text =
                fs::read_to_string(&target).map_err(|reason| format!("读取冲突文件失败：{reason}"))?;
            let merged = combine_conflict_markers(&text)?;
            fs::write(&target, merged).map_err(|reason| format!("写入解决结果失败：{reason}"))?;
        }
    }
    // 两侧都标记为已解决：git add 把工作区内容写进 index、清掉冲突条目
    run_git_checked(root, &["add", "--", &spec])?;
    status_of(root)
}

/// 把工作区里带冲突标记的文本合成"保留两者"的结果。
///
/// 每个冲突块形如
/// ```text
/// <<<<<<< HEAD
/// ours
/// =======
/// theirs
/// >>>>>>>
/// ```
/// 输出把标记行去掉、留下「ours 段的行 + theirs 段的行」。diff3 风格还会多一段
/// `|||||||` 基线，整段丢掉。一个文件里可能有多个冲突块，逐个处理。
///
/// 逐行按 `split_inclusive('\n')` 走、行尾原样保留：最后一个冲突块后面可能没有换行，
/// 用 `lines()` 拆开再拼回去会丢信息。冲突标记在行首，判之前先剥掉行尾的 `\r`（CRLF 文件）。
///
/// 没有冲突块、或标记不配对（中途断掉）时返回 Err——不静默产出一个半成品文件。
fn combine_conflict_markers(text: &str) -> Result<String, String> {
    #[derive(PartialEq)]
    enum Stage {
        Outside,
        Ours,
        Base,
        Theirs,
    }
    let mut stage = Stage::Outside;
    let mut out = String::with_capacity(text.len());
    // ours / theirs 两段先各自攒着，等读到 `>>>>>>>` 时按"先 ours 后 theirs"的顺序吐出来
    // （标记行本身不输出）。theirs 不能边读边直接写 out——那样会排在 ours 前面。
    let mut ours: Vec<&str> = Vec::new();
    let mut theirs: Vec<&str> = Vec::new();
    let mut blocks = 0usize;

    for line in text.split_inclusive('\n') {
        let bare = line.strip_suffix('\n').unwrap_or(line);
        let bare = bare.strip_suffix('\r').unwrap_or(bare);
        let marker = |prefix: &str| bare.starts_with(prefix);
        match stage {
            Stage::Outside => {
                if marker("<<<<<<<") {
                    stage = Stage::Ours;
                    ours.clear();
                    theirs.clear();
                    blocks += 1;
                } else {
                    out.push_str(line);
                }
            }
            Stage::Ours => {
                if marker("|||||||") {
                    stage = Stage::Base;
                } else if marker("=======") {
                    stage = Stage::Theirs;
                } else if marker("<<<<<<<") || marker(">>>>>>>") {
                    return Err("冲突标记不配对，无法保留两者".to_string());
                } else {
                    ours.push(line);
                }
            }
            Stage::Base => {
                // 基线段（diff3 风格）整段丢掉，保留两者不需要它
                if marker("=======") {
                    stage = Stage::Theirs;
                } else if marker("<<<<<<<") || marker(">>>>>>>") {
                    return Err("冲突标记不配对，无法保留两者".to_string());
                }
            }
            Stage::Theirs => {
                if marker(">>>>>>>") {
                    for keep in ours.drain(..) {
                        out.push_str(keep);
                    }
                    for keep in theirs.drain(..) {
                        out.push_str(keep);
                    }
                    stage = Stage::Outside;
                } else if marker("<<<<<<<") || marker("=======") {
                    return Err("冲突标记不配对，无法保留两者".to_string());
                } else {
                    theirs.push(line);
                }
            }
        }
    }

    if stage != Stage::Outside {
        return Err("冲突标记不完整，无法保留两者".to_string());
    }
    if blocks == 0 {
        return Err("这个文件里没有冲突标记，可能不是冲突文件".to_string());
    }
    Ok(out)
}

// ---- worktree ----

/// 一个 git worktree（`git worktree list --porcelain` 的一条）。
///
/// `path` 是给前端当 `root` 用的绝对路径：目录存在时是**登记过白名单的 canonical
/// 路径**，前端可以原样拿它去调别的 git 命令，不会被 `checked_root` 拒掉。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// 工作树目录的绝对路径
    path: String,
    /// 目录名（下拉项的主标题）
    name: String,
    /// 检出的分支短名；游离 HEAD 或 bare 时为 None
    branch: Option<String>,
    /// 游离 HEAD（没检出任何分支）
    detached: bool,
    /// bare 仓库的主工作树（没有工作区文件）
    bare: bool,
    /// 被 lock
    locked: bool,
    /// lock 的原因（`worktree lock --reason` 给的），可能为空
    lock_reason: Option<String>,
    /// 目录已经不在、可以被 prune
    prunable: bool,
    /// prunable 的原因，可能为空
    prune_reason: Option<String>,
    /// 目录此刻是否真实存在（prunable 的是 false）
    exists: bool,
    /// 是不是传进来的那个 root 所在的工作树
    current: bool,
}

/// porcelain 的一条原始记录，`current` / `exists` 这些要额外查或判断的字段还没填。
#[derive(Default)]
struct RawWorktree {
    path: String,
    branch: Option<String>,
    detached: bool,
    bare: bool,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
    prune_reason: Option<String>,
}

/// 解析 `git worktree list --porcelain`。
///
/// 记录之间用空行分隔，但每条都以 `worktree <path>` 开头，所以逐行看前缀、遇到新
/// `worktree` 行就收尾上一条，不必真的按空行切。`HEAD <sha>` 行用不上，忽略。
fn parse_worktrees(text: &str) -> Vec<RawWorktree> {
    // Git for Windows 偶发在首行前带 BOM，不剥掉第一行的 `worktree ` 就匹配不上
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out: Vec<RawWorktree> = Vec::new();
    let mut current: Option<RawWorktree> = None;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(done) = current.take() {
                out.push(done);
            }
            current = Some(RawWorktree {
                path: path.trim().to_string(),
                ..Default::default()
            });
            continue;
        }
        let Some(item) = current.as_mut() else {
            continue;
        };
        if let Some(name) = line.strip_prefix("branch ") {
            // refs/heads/feat -> feat；别的命名空间（detached 不会走这里）原样留
            item.branch = Some(name.trim().trim_start_matches("refs/heads/").to_string());
        } else if line == "detached" {
            item.detached = true;
        } else if line == "bare" {
            item.bare = true;
        } else if let Some(rest) = line.strip_prefix("locked") {
            item.locked = true;
            let reason = rest.trim();
            if !reason.is_empty() {
                item.lock_reason = Some(reason.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("prunable") {
            item.prunable = true;
            let reason = rest.trim();
            if !reason.is_empty() {
                item.prune_reason = Some(reason.to_string());
            }
        }
    }
    if let Some(done) = current.take() {
        out.push(done);
    }
    out
}

/// 两个路径是不是同一个目录。Windows 上盘符大小写、`/` 与 `\` 都可能不一致，
/// 先归一化再比（和前端 `pathKey` 同一套语义）。
fn same_dir(a: &str, b: &str) -> bool {
    a.replace('\\', "/").to_lowercase() == b.replace('\\', "/").to_lowercase()
}

/// 列出 root 所属仓库的全部 worktree。
///
/// 目录存在的工作树顺手 `register` 进白名单（返回 canonical 路径）：前端把选中的
/// worktree 当 root 调 `git_status` 等命令时，必须先在这一层登记过，否则会被沙箱拒掉。
/// 不存在的（prunable）只标记、不登记——它本来就没法当目录用。
fn worktrees_of(root: &Path, state: &FsState) -> Result<Vec<WorktreeInfo>, String> {
    // 非仓库 / 没装 git：当空列表返回，前端据此把入口藏起来
    let Some(raw) = run_git(root, &["worktree", "list", "--porcelain"])? else {
        return Ok(Vec::new());
    };
    let text = String::from_utf8_lossy(&raw);
    let raw_items = parse_worktrees(&text);

    // root 所在的工作树根（root 可能是仓库的子目录，也可能就是某个 worktree）
    let top = run_git(root, &["rev-parse", "--show-toplevel"])?
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .filter(|value| !value.is_empty());

    let mut out = Vec::with_capacity(raw_items.len());
    for item in raw_items {
        let dir = PathBuf::from(&item.path);
        let exists = dir.is_dir();
        let path = if exists {
            state.register(dir)?.to_string_lossy().to_string()
        } else {
            item.path.clone()
        };
        let name = Path::new(&path)
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let current = top.as_deref().is_some_and(|value| same_dir(value, &path));
        out.push(WorktreeInfo {
            path,
            name,
            branch: item.branch,
            detached: item.detached,
            bare: item.bare,
            locked: item.locked,
            lock_reason: item.lock_reason,
            prunable: item.prunable,
            prune_reason: item.prune_reason,
            exists,
            current,
        });
    }
    Ok(out)
}

/// 当前仓库的全部 worktree。目录不是仓库 / 没有 worktree 时返回空数组，不是错误。
#[tauri::command(async)]
pub fn git_worktree_list(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<Vec<WorktreeInfo>, String> {
    let root = state.checked_root(&root)?;
    worktrees_of(&root, &state)
}

/// 清理失效的 worktree 记录（`git worktree prune`）。
///
/// 目录被外部删掉、又没跑过 prune 时，`git worktree list` 会一直留着那条 prunable
/// 记录，它检出的分支也就一直「被占用」——主工作树和别的 worktree 都切不过去。这里
/// 跑一次 prune 把记录清掉，分支随之释放。返回清理后的列表，调用方直接落地即可。
#[tauri::command(async)]
pub fn git_worktree_prune(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<Vec<WorktreeInfo>, String> {
    let root = state.checked_root(&root)?;
    run_git_checked(&root, &["worktree", "prune"])?;
    worktrees_of(&root, &state)
}

/// 一个 worktree 的**轻量动态状态**，供「工作树概览」逐条标注。
///
/// 只带概览要用的几项：未提交改动数、领先 / 落后、进行中的多步操作与冲突数。
/// 文件明细不带——概览只看「有没有、有几个」，逐条列出只会白白撑大 IPC。
/// 字段口径与 `git_status` **完全一致**（同一套 `status_of_with_counts` 算出来的），
/// 免得概览和面板当前工作树两处数字打架。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    /// 工作树目录的绝对路径；和 `WorktreeInfo.path` 同一写法（canonical），前端按它对齐
    path: String,
    /// 检出的分支短名；游离 HEAD 时为 None
    branch: Option<String>,
    /// HEAD 的提交号；空仓库时为 None
    head: Option<String>,
    /// 未提交的**文件**数（未跟踪目录已按文件展开计）
    changed: u32,
    /// 未合并（冲突）条目数，含 AA/DD 这种 XY 里没有 U 的
    conflicts: u32,
    /// 卡在一次没结束的多步操作里（合并 / 变基 / 拣选 / 还原）
    merging: bool,
    /// 进行中的具体操作类型；没有时是 None
    merge_kind: Option<String>,
    ahead: u32,
    behind: u32,
}

/// 逐个工作树汇总轻量状态。
///
/// 先复用 `worktrees_of` 拿 canonical 路径（顺带把存在的工作树登记进白名单），再对每个
/// **目录存在、非 bare** 的工作树跑一次不带 numstat 的 status（行数概览用不上，省两个
/// git 进程）。bare 没有工作区文件、prunable 的目录都没了，一律跳过——给它们算状态没
/// 有意义。
///
/// 成本是「工作树数 × 一次 git status」，比单根轮询重，调用方必须按可见性和更慢的节奏
/// 去拉（前端只在概览露在眼前时、约 10 秒一次）。
fn worktree_statuses_of(root: &Path, state: &FsState) -> Result<Vec<WorktreeStatus>, String> {
    let worktrees = worktrees_of(root, state)?;
    let mut out = Vec::with_capacity(worktrees.len());
    for item in worktrees {
        // bare 没有工作区文件；目录不存在（prunable）连 cd 都进不去，都没法算状态
        if !item.exists || item.bare {
            continue;
        }
        let status = match status_of_with_counts(Path::new(&item.path), false) {
            Ok(status) => status,
            // 单棵工作树读失败（比如目录刚好被外部删掉）不该拖垮整个列表：跳过它
            Err(_) => continue,
        };
        out.push(WorktreeStatus {
            path: item.path,
            branch: status.branch,
            head: status.head,
            changed: status.changed,
            conflicts: status.conflicts,
            merging: status.merging,
            merge_kind: status.merge_kind,
            ahead: status.ahead,
            behind: status.behind,
        });
    }
    Ok(out)
}

/// 仓库下每个工作树的轻量状态。目录不是仓库 / 没有工作树时返回空数组，不是错误。
#[tauri::command(async)]
pub fn git_worktree_status(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<Vec<WorktreeStatus>, String> {
    let root = state.checked_root(&root)?;
    worktree_statuses_of(&root, &state)
}

// ---- 变更中心（workstream） ----
//
// 「变更中心」不再以单个工作区的文件暂存为中心，而是以「一条工作线」为单位：
// 一个 worktree（或一条没被检出的本地分支）+ 它相对基准分支的提交。这里只做
// 只读汇总和少量生命周期操作，不改变任何工作区的编辑上下文。

/// 变更中心里的一条工作线：一个 worktree，或一条没被检出的本地分支。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamInfo {
    /// worktree 绝对路径；未检出分支为空串
    path: String,
    /// 显示名：worktree 用目录名，未检出分支用分支名
    name: String,
    /// main = 工作区根所在检出；worktree = 其他工作树；branch = 未检出分支
    kind: String,
    branch: Option<String>,
    /// 对照的基准分支
    base: Option<String>,
    /// base 与 head 的 merge-base
    base_sha: Option<String>,
    /// 基准分支当前的提交号；和 head 相同说明这条工作线还没有独有提交
    base_head: Option<String>,
    head: Option<String>,
    detached: bool,
    bare: bool,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
    prune_reason: Option<String>,
    exists: bool,
    current: bool,
    /// 未提交文件数
    changed: u32,
    conflicts: u32,
    merging: bool,
    merge_kind: Option<String>,
    /// 相对 base 领先 / 落后
    ahead: u32,
    behind: u32,
    /// 相对上游分支的领先 / 落后（当前检出卡片用；没配上游时为 0）
    upstream_ahead: u32,
    upstream_behind: u32,
    last_commit_time: i64,
    last_commit_subject: String,
    /// base...head（已提交部分）的改动规模
    diff_files: u32,
    additions: u32,
    deletions: u32,
    /// 分支已经完全合进 base
    merged: bool,
}

/// 审阅工作台里的一个文件。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    /// 绝对路径；未检出分支的文件没有工作区路径，退回仓库根下的拼接路径
    path: String,
    /// 相对仓库根的正斜杠路径
    relative: String,
    /// A / M / D / R / C / ?（未跟踪）
    status: String,
    /// 未提交文件里，改动是否在暂存区
    staged: bool,
    /// 是不是未提交改动
    dirty: bool,
    additions: u32,
    deletions: u32,
}

/// 审阅工作台里的一条提交。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommit {
    hash: String,
    short: String,
    author: String,
    /// Unix 秒
    time: i64,
    subject: String,
}

/// 一条工作线的审阅数据。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamReview {
    branch: String,
    base: String,
    base_sha: Option<String>,
    head: Option<String>,
    detached: bool,
    commits: Vec<ReviewCommit>,
    /// 已提交部分的文件
    files: Vec<ReviewFile>,
    /// 工作树里还没提交的文件
    dirty_files: Vec<ReviewFile>,
    changed: u32,
    conflicts: u32,
    additions: u32,
    deletions: u32,
}

/// 工作线的基准分支：优先 origin/HEAD 指向的分支，其次本地 main / master。
/// 仓库既没有远程默认分支、也没有 main / master 时退回当前分支。
fn default_base(root: &Path) -> Option<String> {
    if let Ok(Some(raw)) = run_git(
        root,
        &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ) {
        let text = String::from_utf8_lossy(&raw).trim().to_string();
        if let Some((_, name)) = text.split_once('/') {
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    for name in ["main", "master"] {
        let spec = format!("refs/heads/{name}");
        if matches!(
            run_git(root, &["rev-parse", "--verify", "--quiet", &spec]),
            Ok(Some(_))
        ) {
            return Some(name.to_string());
        }
    }
    current_branch(root).ok().flatten()
}

/// `for-each-ref` 的一行：分支名、提交号、提交时间、主题。
struct RawBranchRef {
    name: String,
    head: String,
    time: i64,
    subject: String,
}

fn branch_refs(root: &Path) -> Vec<RawBranchRef> {
    const FORMAT: &str =
        "--format=%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(subject)%00";
    let Some(raw) = run_git(
        root,
        &["for-each-ref", "--sort=-committerdate", FORMAT, "refs/heads"],
    )
    .ok()
    .flatten()
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for record in raw.split(|byte| *byte == 0) {
        let text = String::from_utf8_lossy(record);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let mut fields = text.splitn(4, '\u{1f}');
        let name = fields.next().unwrap_or("").trim();
        let head = fields.next().unwrap_or("").trim();
        let time = fields.next().unwrap_or("").trim().parse().unwrap_or(0);
        let subject = fields.next().unwrap_or("").trim();
        if name.is_empty() || head.is_empty() {
            continue;
        }
        out.push(RawBranchRef {
            name: name.to_string(),
            head: head.to_string(),
            time,
            subject: subject.to_string(),
        });
    }
    out
}

fn merge_base_of(root: &Path, a: &str, b: &str) -> Option<String> {
    run_git(root, &["merge-base", a, b])
        .ok()
        .flatten()
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .filter(|text| !text.is_empty())
}

/// a 是不是 b 的祖先。`merge-base --is-ancestor` 成功时没有输出，只能看退出码。
fn is_ancestor(root: &Path, a: &str, b: &str) -> bool {
    matches!(
        run_git(root, &["merge-base", "--is-ancestor", a, b]),
        Ok(Some(_))
    )
}

/// 相对 base 的领先 / 落后条数。
fn divergence_of(root: &Path, base: &str, head: &str) -> (u32, u32) {
    let Some(raw) = run_git(
        root,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...{head}"),
        ],
    )
    .ok()
    .flatten()
    else {
        return (0, 0);
    };
    let text = String::from_utf8_lossy(&raw);
    let mut parts = text.split_whitespace();
    // base...head 的左侧是 base 独有（落后），右侧是 head 独有（领先）
    let behind = parts.next().and_then(|value| value.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|value| value.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn last_commit_of(root: &Path) -> Option<(i64, String)> {
    let raw = run_git(root, &["log", "-1", "--format=%ct%x1f%s"])
        .ok()
        .flatten()?;
    let text = String::from_utf8_lossy(&raw);
    let (time, subject) = text.trim().split_once('\u{1f}')?;
    Some((time.trim().parse().unwrap_or(0), subject.trim().to_string()))
}

/// 两个提交之间的改动规模（文件数 / 新增行 / 删除行）。
fn diff_stat_between(root: &Path, from: &str, to: &str) -> (u32, u32, u32) {
    let Some(raw) = run_git(root, &["diff", "--numstat", &format!("{from}..{to}")])
        .ok()
        .flatten()
    else {
        return (0, 0, 0);
    };
    let text = String::from_utf8_lossy(&raw);
    let mut files = 0;
    let mut additions = 0;
    let mut deletions = 0;
    for line in text.lines() {
        let mut columns = line.split('\t');
        let (Some(added), Some(removed)) = (columns.next(), columns.next()) else {
            continue;
        };
        files += 1;
        additions += added.parse::<u32>().unwrap_or(0);
        deletions += removed.parse::<u32>().unwrap_or(0);
    }
    (files, additions, deletions)
}

/// 按路径取两个提交之间的增删行数，给审阅文件列表标注。
fn diff_counts_by_path(root: &Path, from: &str, to: &str) -> HashMap<String, (u32, u32)> {
    let mut out = HashMap::new();
    let Some(raw) = run_git(root, &["diff", "--numstat", &format!("{from}..{to}")])
        .ok()
        .flatten()
    else {
        return out;
    };
    let text = String::from_utf8_lossy(&raw);
    for line in text.lines() {
        let mut columns = line.split('\t');
        let (Some(added), Some(removed), Some(path)) =
            (columns.next(), columns.next(), columns.next())
        else {
            continue;
        };
        // 重命名时 numstat 的路径形如 `old => new`，这里不强行映射，交给整行统计
        out.insert(
            path.to_string(),
            (
                added.parse().unwrap_or(0),
                removed.parse().unwrap_or(0),
            ),
        );
    }
    out
}

/// 不启动 4 个 `rev-parse` 的合并状态探测：直接看 gitdir 里的标记文件。
/// 只用于变更中心的批量概览；单根状态仍走 `merge_state`，保留原有语义。
fn merge_state_quick(root: &Path) -> Option<&'static str> {
    let raw = run_git(root, &["rev-parse", "--absolute-git-dir"])
        .ok()
        .flatten()?;
    let dir = PathBuf::from(String::from_utf8_lossy(&raw).trim().to_string());
    if dir.join("MERGE_HEAD").is_file() {
        return Some("merge");
    }
    if dir.join("REBASE_HEAD").is_file()
        || dir.join("rebase-merge").is_dir()
        || dir.join("rebase-apply").is_dir()
    {
        return Some("rebase");
    }
    if dir.join("REVERT_HEAD").is_file() {
        return Some("revert");
    }
    if dir.join("CHERRY_PICK_HEAD").is_file() {
        return Some("cherryPick");
    }
    None
}

/// 一条工作线的基础字段。worktree 和 branch-only 两路各自填动态部分。
fn empty_workstream(
    path: String,
    name: String,
    kind: &str,
    base: Option<String>,
) -> WorkstreamInfo {
    WorkstreamInfo {
        path,
        name,
        kind: kind.to_string(),
        branch: None,
        base,
        base_sha: None,
        base_head: None,
        head: None,
        detached: false,
        bare: false,
        locked: false,
        lock_reason: None,
        prunable: false,
        prune_reason: None,
        exists: false,
        current: false,
        changed: 0,
        conflicts: 0,
        merging: false,
        merge_kind: None,
        ahead: 0,
        behind: 0,
        upstream_ahead: 0,
        upstream_behind: 0,
        last_commit_time: 0,
        last_commit_subject: String::new(),
        diff_files: 0,
        additions: 0,
        deletions: 0,
        merged: false,
    }
}

/// 汇总仓库下所有工作树 + 有独有提交的未检出分支。
///
/// 动态部分只跑一次 `status`（不带 numstat）、一次 log -1、一次 merge-base、
/// 一次 rev-list 和一次 numstat；比原来的「每根一次 2 秒 status」便宜得多，
/// 且只在变更中心可见时由前端按较慢节奏拉取。
fn workstreams_of(root: &Path, state: &FsState) -> Result<Vec<WorkstreamInfo>, String> {
    let worktrees = worktrees_of(root, state)?;
    let base = default_base(root);
    // 基准分支的当前提交：用来区分「刚建出来、还没有独有提交」和「真的合并过」。
    // 两者都是 `merged = true`，但前者不该显示成「已合并」、也不该进清理建议。
    let base_head = base
        .as_deref()
        .and_then(|name| resolve_commit(root, name).ok());
    let mut out = Vec::with_capacity(worktrees.len());
    let mut checked_out: HashSet<String> = HashSet::new();

    for item in worktrees {
        if let Some(branch) = &item.branch {
            checked_out.insert(branch.clone());
        }
        let kind = if item.current { "main" } else { "worktree" };
        let mut info = empty_workstream(
            item.path.clone(),
            item.name.clone(),
            kind,
            base.clone(),
        );
        info.branch = item.branch.clone();
        info.base_head = base_head.clone();
        info.detached = item.detached;
        info.bare = item.bare;
        info.locked = item.locked;
        info.lock_reason = item.lock_reason.clone();
        info.prunable = item.prunable;
        info.prune_reason = item.prune_reason.clone();
        info.exists = item.exists;
        info.current = item.current;

        if item.exists && !item.bare {
            let dir = Path::new(&item.path);
            if let Ok(status) = status_of_with_counts(dir, false) {
                info.branch = status.branch.clone().or(info.branch);
                info.head = status.head.clone();
                info.changed = status.changed;
                info.conflicts = status.conflicts;
                info.upstream_ahead = status.ahead;
                info.upstream_behind = status.behind;
                info.merge_kind = merge_state_quick(dir)
                    .map(str::to_string)
                    .or(status.merge_kind.clone());
                info.merging = info.merge_kind.is_some();
                let base_name = info.base.clone();
                let head = info.head.clone();
                if let (Some(base_name), Some(head)) =
                    (base_name.as_deref(), head.as_deref())
                {
                    let (ahead, behind) = divergence_of(dir, base_name, head);
                    info.ahead = ahead;
                    info.behind = behind;
                    info.base_sha = merge_base_of(dir, base_name, head);
                    info.merged = is_ancestor(dir, head, base_name);
                    if let Some(sha) = info.base_sha.clone() {
                        let (files, additions, deletions) =
                            diff_stat_between(dir, &sha, head);
                        info.diff_files = files;
                        info.additions = additions;
                        info.deletions = deletions;
                    }
                }
            }
            if let Some((time, subject)) = last_commit_of(dir) {
                info.last_commit_time = time;
                info.last_commit_subject = subject;
            }
        }
        out.push(info);
    }

    // 只建了分支、没建 worktree 的 agent 产物也要能被看到。
    if let Some(base_name) = base.as_deref() {
        // branch_refs 已按 committerdate 倒序，这里直接取最近的一批
        let branches = branch_refs(root);
        let mut count = 0;
        for branch in branches {
            if count >= 12 {
                break;
            }
            if branch.name == base_name || checked_out.contains(&branch.name) {
                continue;
            }
            let (ahead, behind) = divergence_of(root, base_name, &branch.head);
            // 没有独有提交的分支只是基准分支的副本，列出来全是噪音
            if ahead == 0 {
                continue;
            }
            let base_sha = merge_base_of(root, base_name, &branch.head);
            let (files, additions, deletions) = match base_sha.as_deref() {
                Some(sha) => diff_stat_between(root, sha, &branch.head),
                None => (0, 0, 0),
            };
            let mut info = empty_workstream(
                String::new(),
                branch.name.clone(),
                "branch",
                Some(base_name.to_string()),
            );
            info.branch = Some(branch.name);
            info.base_sha = base_sha;
            info.base_head = base_head.clone();
            info.head = Some(branch.head);
            info.ahead = ahead;
            info.behind = behind;
            info.last_commit_time = branch.time;
            info.last_commit_subject = branch.subject;
            info.diff_files = files;
            info.additions = additions;
            info.deletions = deletions;
            out.push(info);
            count += 1;
        }
    }

    Ok(out)
}

/// 校验前端传来的 worktree 路径确实是这个仓库的工作树，并返回 canonical 路径。
/// 不传 / 传空串表示「不是 worktree」（未检出分支），走仓库根。
fn checked_worktree(
    root: &Path,
    state: &FsState,
    path: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(raw) = path.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let worktrees = worktrees_of(root, state)?;
    let target = worktrees
        .into_iter()
        .find(|item| same_dir(&item.path, raw))
        .ok_or_else(|| format!("找不到这个工作树：{raw}"))?;
    if !target.exists || target.bare {
        return Err("这个工作树目录不存在或不可用".to_string());
    }
    Ok(Some(PathBuf::from(target.path)))
}

fn review_of(
    root: &Path,
    worktree: Option<&Path>,
    branch: Option<&str>,
    base: Option<&str>,
) -> Result<WorkstreamReview, String> {
    let dir = worktree.unwrap_or(root);
    let base_name = base
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| default_base(root))
        .ok_or("找不到基准分支，无法审阅")?;
    let head = match branch.map(str::trim).filter(|value| !value.is_empty()) {
        // 未检出分支没有工作区，只能在仓库根上解析分支名
        Some(name) if worktree.is_none() => resolve_commit(root, name)?,
        _ => resolve_commit(dir, "HEAD")?,
    };
    let base_sha = merge_base_of(dir, &base_name, &head);

    let mut commits = Vec::new();
    let mut files = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;

    if let Some(sha) = base_sha.as_deref() {
        if sha != head {
            let raw = run_git(
                dir,
                &[
                    "log",
                    "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%00",
                    &format!("{sha}..{head}"),
                ],
            )?
            .unwrap_or_default();
            for record in raw.split(|byte| *byte == 0) {
                let text = String::from_utf8_lossy(record);
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let mut fields = text.splitn(5, '\u{1f}');
                let hash = fields.next().unwrap_or("").trim();
                let short = fields.next().unwrap_or("").trim();
                let author = fields.next().unwrap_or("").trim();
                let time = fields.next().unwrap_or("").trim().parse().unwrap_or(0);
                let subject = fields.next().unwrap_or("").trim();
                if hash.is_empty() {
                    continue;
                }
                commits.push(ReviewCommit {
                    hash: hash.to_string(),
                    short: short.to_string(),
                    author: author.to_string(),
                    time,
                    subject: subject.to_string(),
                });
            }

            let raw = run_git(
                dir,
                &[
                    "diff",
                    "--name-status",
                    "-z",
                    &format!("{sha}..{head}"),
                ],
            )?
            .unwrap_or_default();
            let counts = diff_counts_by_path(dir, sha, &head);
            for file in parse_name_status(&raw, "", dir) {
                let (added, removed) = counts
                    .get(&file.relative)
                    .copied()
                    .unwrap_or((0, 0));
                files.push(ReviewFile {
                    path: file.path,
                    relative: file.relative,
                    status: file.status.to_string(),
                    staged: false,
                    dirty: false,
                    additions: added,
                    deletions: removed,
                });
            }
            let (_, stat_additions, stat_deletions) = diff_stat_between(dir, sha, &head);
            additions = stat_additions;
            deletions = stat_deletions;
        }
    }

    let mut dirty_files = Vec::new();
    let mut changed = 0;
    let mut conflicts = 0;
    if let Some(path) = worktree {
        // 审阅列表要显示每个未提交文件的 +/−，这里必须带 numstat；
        // 清单概览那边才用 `false` 省掉两次 git 进程。
        if let Ok(status) = status_of_with_counts(path, true) {
            changed = status.changed;
            conflicts = status.conflicts;
            for file in status.files {
                if file.is_dir {
                    continue;
                }
                // 两边都有改动时优先看工作区（agent 更可能留下未暂存的后续修改）；
                // 只有「暂存了、工作区没再改」才走暂存区那一侧。
                let staged =
                    file.index != '.' && file.index != '?' && file.worktree == '.';
                let status_char = if file.index == '?' {
                    '?'
                } else if file.index != '.' {
                    file.index
                } else {
                    file.worktree
                };
                let added = file.staged_added.unwrap_or(0) + file.unstaged_added.unwrap_or(0);
                let removed =
                    file.staged_removed.unwrap_or(0) + file.unstaged_removed.unwrap_or(0);
                additions += added;
                deletions += removed;
                dirty_files.push(ReviewFile {
                    path: file.path,
                    relative: file.relative,
                    status: status_char.to_string(),
                    staged,
                    dirty: true,
                    additions: added,
                    deletions: removed,
                });
            }
        }
    }

    let branch_name = branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| current_branch(dir).ok().flatten())
        .unwrap_or_else(|| head.clone());

    Ok(WorkstreamReview {
        branch: branch_name,
        base: base_name,
        base_sha,
        head: Some(head),
        detached: worktree.is_some_and(|path| current_branch(path).ok().flatten().is_none()),
        commits,
        files,
        dirty_files,
        changed,
        conflicts,
        additions,
        deletions,
    })
}

/// 变更中心的只读汇总。
#[tauri::command(async)]
pub fn workstream_list(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<Vec<WorkstreamInfo>, String> {
    let root = state.checked_root(&root)?;
    workstreams_of(&root, &state)
}

/// 一条工作线的审阅数据。`path` 为空时按 `branch` 解析未检出分支。
#[tauri::command(async)]
pub fn workstream_review(
    state: tauri::State<'_, FsState>,
    root: String,
    path: Option<String>,
    branch: Option<String>,
    base: Option<String>,
) -> Result<WorkstreamReview, String> {
    let root = state.checked_root(&root)?;
    let worktree = checked_worktree(&root, &state, path.as_deref())?;
    review_of(
        &root,
        worktree.as_deref(),
        branch.as_deref(),
        base.as_deref(),
    )
}

/// 已提交文件在审阅工作台里的逐块 diff。`relative` 是仓库根相对路径。
#[tauri::command(async)]
pub fn workstream_file_hunks(
    state: tauri::State<'_, FsState>,
    root: String,
    path: Option<String>,
    relative: String,
    from: String,
    to: String,
) -> Result<FileHunks, String> {
    let root = state.checked_root(&root)?;
    let worktree = checked_worktree(&root, &state, path.as_deref())?;
    let dir = worktree.as_deref().unwrap_or(&root);
    let from = checked_rev(&from)?;
    let to = checked_rev(&to)?;
    let relative = relative.replace('\\', "/");
    if relative.is_empty()
        || relative.starts_with('/')
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("路径不合法：{relative}"));
    }
    let raw = run_git_literal(
        dir,
        &[
            "diff",
            "--no-color",
            "-U3",
            &format!("{from}..{to}"),
            "--",
            &relative,
        ],
    )?
    .ok_or("git diff 执行失败")?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let (header, hunks) = split_patch(&text);
    Ok(FileHunks { header, hunks })
}

fn merge_workstream(
    root: &Path,
    branch: &str,
    base: Option<&str>,
) -> Result<GitStatus, String> {
    let branch = branch.trim();
    check_branch_name(root, branch)?;
    let current = current_branch(root)?.ok_or("当前不在分支上，不能合并")?;
    if let Some(base) = base.map(str::trim).filter(|v| !v.is_empty()) {
        if base != current {
            return Err(format!(
                "当前在 {current}，不是基准分支 {base}。先切换回基准分支再合并。"
            ));
        }
    }
    if branch == current {
        return Err("不能把当前分支合并到它自己".to_string());
    }
    let status = status_of(root)?;
    if status.merging {
        return Err("仓库正处在未完成的合并 / 变基中，先收尾再合并".to_string());
    }
    if status.changed > 0 {
        return Err(format!(
            "主工作区还有 {} 处未提交改动，先提交或暂存后再合并",
            status.changed
        ));
    }
    run_git_checked(root, &["merge", "--no-ff", "--no-edit", branch])?;
    status_of(root)
}

/// 把一条工作线合并进当前基准分支。要求主工作区干净、当前就在基准分支上。
#[tauri::command(async)]
pub fn workstream_merge(
    state: tauri::State<'_, FsState>,
    root: String,
    branch: String,
    base: Option<String>,
) -> Result<GitStatus, String> {
    let root = state.checked_root(&root)?;
    merge_workstream(&root, &branch, base.as_deref())
}

/// 移除一个已合并 / 干净的工作树。默认保留分支（之后还能用 `worktree add` 找回）。
/// 有未提交改动时**拒绝**，不提供静默 force 的入口。
#[tauri::command(async)]
pub fn workstream_remove(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
) -> Result<Vec<WorkstreamInfo>, String> {
    let root = state.checked_root(&root)?;
    let worktrees = worktrees_of(&root, &state)?;
    let target = worktrees
        .into_iter()
        .find(|item| same_dir(&item.path, &path))
        .ok_or_else(|| format!("找不到这个工作树：{path}"))?;
    if target.current {
        return Err("不能移除工作区当前所在的检出".to_string());
    }
    if target.bare {
        return Err("不能移除 bare 仓库".to_string());
    }
    if target.locked {
        return Err(format!(
            "工作树被锁定{}，先解锁再移除",
            target
                .lock_reason
                .as_deref()
                .filter(|reason| !reason.is_empty())
                .map(|reason| format!("（{reason}）"))
                .unwrap_or_default()
        ));
    }
    if target.prunable || !target.exists {
        run_git_checked(&root, &["worktree", "prune"])?;
        return workstreams_of(&root, &state);
    }
    let status = status_of_with_counts(Path::new(&target.path), false)?;
    if status.merging {
        return Err("工作树正处在未完成的合并 / 变基中，先收尾再移除".to_string());
    }
    if status.changed > 0 {
        return Err(format!(
            "工作树还有 {} 处未提交改动，不能直接移除",
            status.changed
        ));
    }
    run_git_checked(&root, &["worktree", "remove", target.path.as_str()])?;
    workstreams_of(&root, &state)
}

/// 把 `.worktrees/` 写进本地 `.git/info/exclude`（只在本机生效，不进版本库）。
/// 只追加、不改已有内容；失败不影响创建，最多让主工作区多一条未跟踪目录。
fn ensure_worktrees_excluded(top: &Path) {
    let raw = match run_git(
        top,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) {
        Ok(Some(bytes)) => Some(bytes),
        _ => run_git(top, &["rev-parse", "--git-common-dir"])
            .ok()
            .flatten(),
    };
    let Some(raw) = raw else { return };
    let text = String::from_utf8_lossy(&raw).trim().to_string();
    if text.is_empty() {
        return;
    }
    let mut common = PathBuf::from(&text);
    if common.is_relative() {
        let joined = top.join(&common);
        common = joined.canonicalize().unwrap_or(joined);
    }
    let exclude = common.join("info").join("exclude");
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|line| {
        let line = line.trim();
        line == ".worktrees/" || line == ".worktrees"
    }) {
        return;
    }
    if let Some(parent) = exclude.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(".worktrees/\n");
    let _ = fs::write(&exclude, next);
}

fn create_workstream(
    root: &Path,
    state: &FsState,
    name: &str,
    base: Option<String>,
) -> Result<Vec<WorkstreamInfo>, String> {
    let name = name.trim();
    check_branch_name(root, name)?;
    let base = base
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| current_branch(root).ok().flatten())
        .ok_or("找不到基准分支")?;
    let top = run_git(root, &["rev-parse", "--show-toplevel"])?
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("这个目录不是 git 仓库")?;
    let top = PathBuf::from(top);
    let slug: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        return Err("分支名里没有可用的目录名".to_string());
    }
    // 统一放在仓库内的 .worktrees/ 下，和 worktree 技能的布局一致。
    // 同时把它写进本地 .git/info/exclude：这个目录只属于本机，不该出现在
    // 主工作区的 status 里，也不该改仓库里受版本管理的 .gitignore。
    let container = top.join(".worktrees");
    let dir = container.join(slug);
    if dir.exists() {
        return Err(format!("目标目录已经存在：{}", dir.display()));
    }
    fs::create_dir_all(&container).map_err(|reason| format!("创建目录失败: {reason}"))?;
    ensure_worktrees_excluded(&top);
    let dir_text = dir.to_string_lossy().to_string();
    run_git_checked(
        root,
        &["worktree", "add", "-b", name, dir_text.as_str(), base.as_str()],
    )?;
    workstreams_of(root, state)
}

/// 新建一条工作线：在仓库同级目录建 worktree + 分支。
#[tauri::command(async)]
pub fn workstream_create(
    state: tauri::State<'_, FsState>,
    root: String,
    name: String,
    base: Option<String>,
) -> Result<Vec<WorkstreamInfo>, String> {
    let root = state.checked_root(&root)?;
    create_workstream(&root, &state, &name, base)
}

#[tauri::command(async)]
pub fn git_status(
    state: tauri::State<'_, FsState>,
    root: String,
    with_counts: Option<bool>,
) -> Result<GitStatus, String> {
    // 缺省当 true：老前端不传这个参数时行为不变
    status_of_with_counts(&state.checked_root(&root)?, with_counts.unwrap_or(true))
}

/// 把工作区根初始化成 git 仓库（默认分支 main）。已经是仓库时幂等，不动已有历史。
#[tauri::command(async)]
pub fn git_init(state: tauri::State<'_, FsState>, root: String) -> Result<GitStatus, String> {
    init_git_repo(&state.checked_root(&root)?)
}

/// 暂存。`paths` 为空表示全部暂存。
#[tauri::command(async)]
pub fn git_stage(
    state: tauri::State<'_, FsState>,
    root: String,
    paths: Option<Vec<String>>,
) -> Result<GitStatus, String> {
    stage_paths(&state.checked_root(&root)?, &paths)
}

/// 取消暂存。`paths` 为空表示全部取消。
#[tauri::command(async)]
pub fn git_unstage(
    state: tauri::State<'_, FsState>,
    root: String,
    paths: Option<Vec<String>>,
) -> Result<GitStatus, String> {
    unstage_paths(&state.checked_root(&root)?, &paths)
}

/// 放弃某些文件的改动，还原到 index（unstaged）或 HEAD（staged）。不可撤销。
#[tauri::command(async)]
pub fn git_discard(
    state: tauri::State<'_, FsState>,
    root: String,
    paths: Vec<String>,
    source: DiscardSource,
) -> Result<GitStatus, String> {
    discard_paths(&state.checked_root(&root)?, &paths, &source)
}

/// 某个文件的 hunk 列表，界面据此逐个列出、逐块 / 逐行操作。
/// `staged` 为 true 时取暂存侧（HEAD↔index），否则取未暂存侧（index↔工作区）。
#[tauri::command(async)]
pub fn git_file_hunks(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
    staged: Option<bool>,
) -> Result<FileHunks, String> {
    file_hunks(&state.checked_root(&root)?, &path, staged.unwrap_or(false))
}

/// 应用一段补丁：把选中的 hunk 加进暂存区 / 退回暂存区，或把工作区里的这些改动撤掉。
#[tauri::command(async)]
pub fn git_apply_patch(
    state: tauri::State<'_, FsState>,
    root: String,
    patch: String,
    action: HunkAction,
) -> Result<GitStatus, String> {
    apply_patch(&state.checked_root(&root)?, &patch, &action)
}

/// 应用一段补丁里**选中的那几行**：其余改动在补丁里还原成基线，只有选中的行进
/// 暂存区 / 退回暂存区 / 从工作区撤掉。补丁走和整块操作同一套 `apply_patch`。
#[tauri::command(async)]
pub fn git_apply_lines(
    state: tauri::State<'_, FsState>,
    root: String,
    patch: String,
    lines: Vec<u32>,
    action: HunkAction,
) -> Result<GitStatus, String> {
    let root = state.checked_root(&root)?;
    let patch = patch_for_lines(&patch, &lines, &action)?;
    apply_patch(&root, &patch, &action)
}

/// 提交暂存区。
#[tauri::command(async)]
pub fn git_commit(
    state: tauri::State<'_, FsState>,
    root: String,
    message: String,
) -> Result<GitStatus, String> {
    commit_staged(&state.checked_root(&root)?, &message)
}

/// 一组分条提交：一条提交信息 + 归属它的文件（工作区相对路径）。前端把 AI 给出的方案原样传回来执行。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGroup {
    message: String,
    files: Vec<String>,
}

/// 按方案分条提交：先清空暂存区，再逐组「暂存这几个文件 → 提交」，最后回一个状态。
///
/// 分条提交的前提就是重新编排暂存区——先全取消暂存，免得上一组、或用户此前的手工暂存混进这一组。
/// 逐组走的还是 `stage_paths` + `commit_staged`，和界面上单条提交同一条链路。
/// 某组跑挂了直接返回该组的 git 报错，已经提交的组留在历史里——不做回滚（回滚更危险，
/// 而且会对已经写进历史的提交再动一次手）。
fn commit_groups(root: &Path, groups: Vec<CommitGroup>) -> Result<GitStatus, String> {
    // 空信息 / 空文件的组直接丢掉：让它们进循环只会白跑一遍 git 再报错
    let groups: Vec<CommitGroup> = groups
        .into_iter()
        .filter(|group| !group.message.trim().is_empty() && !group.files.is_empty())
        .collect();
    if groups.is_empty() {
        return Err("提交方案是空的".to_string());
    }

    // 先整个清空暂存区，再按组重排——分条提交本来就是在重新划分哪些改动进哪一条
    unstage_paths(root, &None)?;
    for group in groups {
        stage_paths(root, &Some(group.files))?;
        commit_staged(root, &group.message)?;
    }
    status_of(root)
}

#[tauri::command(async)]
pub fn git_commit_groups(
    state: tauri::State<'_, FsState>,
    root: String,
    groups: Vec<CommitGroup>,
) -> Result<GitStatus, String> {
    commit_groups(&state.checked_root(&root)?, groups)
}

/// 修正最近一次提交：把当前暂存区的内容并进去，并可选地改提交信息。
#[tauri::command(async)]
pub fn git_amend(
    state: tauri::State<'_, FsState>,
    root: String,
    message: Option<String>,
) -> Result<GitStatus, String> {
    amend_commit(&state.checked_root(&root)?, message.as_deref())
}

/// 撤销最近一次提交，改动留在暂存区。它会把 HEAD 指回去，已经推出去的提交撤销后
/// 本地就和远程分叉了——所以界面那边要过确认框。
#[tauri::command(async)]
pub fn git_undo_commit(state: tauri::State<'_, FsState>, root: String) -> Result<GitStatus, String> {
    undo_commit(&state.checked_root(&root)?)
}

/// 本地分支清单，给分支下拉用。
#[tauri::command(async)]
pub fn git_branches(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<Vec<BranchInfo>, String> {
    branches_of(&state.checked_root(&root)?)
}

/// 切到已有的本地分支。
#[tauri::command(async)]
pub fn git_switch_branch(
    state: tauri::State<'_, FsState>,
    root: String,
    name: String,
) -> Result<GitStatus, String> {
    switch_branch(&state.checked_root(&root)?, &name)
}

/// 从当前 HEAD 建一条新分支并切过去。
#[tauri::command(async)]
pub fn git_create_branch(
    state: tauri::State<'_, FsState>,
    root: String,
    name: String,
) -> Result<GitStatus, String> {
    create_branch(&state.checked_root(&root)?, &name)
}

/// 标签清单。
#[tauri::command(async)]
pub fn git_tag_list(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<Vec<TagInfo>, String> {
    tags_of(&state.checked_root(&root)?)
}

/// 建标签：给了 message 就是附注标签，否则轻量标签；target 缺省打在当前 HEAD 上。
#[tauri::command(async)]
pub fn git_create_tag(
    state: tauri::State<'_, FsState>,
    root: String,
    name: String,
    message: Option<String>,
    target: Option<String>,
) -> Result<(), String> {
    create_tag(
        &state.checked_root(&root)?,
        &name,
        message.as_deref(),
        target.as_deref(),
    )
}

/// 删标签（只动标签引用）。
#[tauri::command(async)]
pub fn git_delete_tag(
    state: tauri::State<'_, FsState>,
    root: String,
    name: String,
) -> Result<(), String> {
    delete_tag(&state.checked_root(&root)?, &name)
}

/// 已存下的 stash 列表。
#[tauri::command(async)]
pub fn git_stash_list(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<Vec<StashEntry>, String> {
    stashes_of(&state.checked_root(&root)?)
}

/// 把当前改动收进 stash。不收未跟踪的新文件（理由见 stash_push）。
#[tauri::command(async)]
pub fn git_stash_push(
    state: tauri::State<'_, FsState>,
    root: String,
    message: Option<String>,
) -> Result<GitStatus, String> {
    stash_push(&state.checked_root(&root)?, message.as_deref())
}

/// 恢复并删掉那条 stash。
#[tauri::command(async)]
pub fn git_stash_pop(
    state: tauri::State<'_, FsState>,
    root: String,
    index: u32,
) -> Result<GitStatus, String> {
    stash_pop(&state.checked_root(&root)?, index)
}

/// 恢复那条 stash，记录留着。
#[tauri::command(async)]
pub fn git_stash_apply(
    state: tauri::State<'_, FsState>,
    root: String,
    index: u32,
) -> Result<GitStatus, String> {
    stash_apply(&state.checked_root(&root)?, index)
}

/// 丢掉那条 stash（只动 stash 记录，不碰工作区）。
#[tauri::command(async)]
pub fn git_stash_drop(
    state: tauri::State<'_, FsState>,
    root: String,
    index: u32,
) -> Result<GitStatus, String> {
    stash_drop(&state.checked_root(&root)?, index)
}

/// 一个改动文件的两侧内容，给编辑器的差异视图用。
#[tauri::command(async)]
pub fn git_file_diff(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
    source: DiffSource,
) -> Result<FileDiff, String> {
    file_diff(&state.checked_root(&root)?, &path, &source)
}

/// 时间线，最新的在最前。`limit` 不传就取一页。
///
/// `filter` 按主题 / 作者 / 正文匹配，`path` 按改动过的路径过滤——两者互斥，
/// 前端一次只传一个（路径必须交给 git 的 pathspec，正文 / 作者却没法用单条 git
/// 命令「任一命中」，见 filter_commits）。
#[tauri::command(async)]
pub fn git_log(
    state: tauri::State<'_, FsState>,
    root: String,
    limit: Option<u32>,
    filter: Option<String>,
    path: Option<String>,
) -> Result<Vec<Commit>, String> {
    log_filtered(
        &state.checked_root(&root)?,
        limit.unwrap_or(LOG_PAGE),
        filter.as_deref(),
        path.as_deref(),
    )
}

/// 某个提交改了哪些文件。
#[tauri::command(async)]
pub fn git_commit_files(
    state: tauri::State<'_, FsState>,
    root: String,
    rev: String,
) -> Result<Vec<CommitFile>, String> {
    files_of(&state.checked_root(&root)?, &rev)
}

/// 两个 ref（提交 / 分支 / 标签 / HEAD）之间改动过的文件列表，给比较视图用。
#[tauri::command(async)]
pub fn git_compare_files(
    state: tauri::State<'_, FsState>,
    root: String,
    from: String,
    to: String,
) -> Result<Vec<CommitFile>, String> {
    compare_files(&state.checked_root(&root)?, &from, &to)
}

/// 某个提交改了多少文件、增删多少行。悬停浮框用：按需拉，前端按 hash 缓存。
#[tauri::command(async)]
pub fn git_commit_stat(
    state: tauri::State<'_, FsState>,
    root: String,
    rev: String,
) -> Result<CommitStat, String> {
    stat_of(&state.checked_root(&root)?, &rev)
}

/// 时间线里哪些提交还没推送到上游。
///
/// 单独一个命令而不是塞进 `git_status`：status 每 2 秒轮询一次，这份结果只在
/// 时间线重拉时用得上（HEAD 变了 / 手动刷新 / 推完之后 ahead 归零），
/// 没必要让每次轮询都多起一个 git 进程。
#[tauri::command(async)]
pub fn git_unpushed(state: tauri::State<'_, FsState>, root: String) -> Result<Vec<String>, String> {
    unpushed_of(&state.checked_root(&root)?)
}

/// 从远程取回引用，不动工作区。
#[tauri::command(async)]
pub fn git_fetch(state: tauri::State<'_, FsState>, root: String) -> Result<GitStatus, String> {
    fetch_remote(&state.checked_root(&root)?)
}

/// 拉取当前分支的上游，只允许快进。
#[tauri::command(async)]
pub fn git_pull(state: tauri::State<'_, FsState>, root: String) -> Result<GitStatus, String> {
    pull_remote(&state.checked_root(&root)?)
}

/// 推送当前分支；没有上游时顺手建立跟踪关系。
#[tauri::command(async)]
pub fn git_push(state: tauri::State<'_, FsState>, root: String) -> Result<GitStatus, String> {
    push_remote(&state.checked_root(&root)?)
}

/// 合并当前分支的上游：先 fetch 再 merge。分叉时生成合并提交；
/// 冲突时不报错，而是把仓库留在合并状态，前端据 merging 切到"合并中"界面。
#[tauri::command(async)]
pub fn git_merge(state: tauri::State<'_, FsState>, root: String) -> Result<GitStatus, String> {
    merge_upstream(&state.checked_root(&root)?)
}

/// 中止正在进行的合并，工作区回到合并前。不在合并态时是 no-op。
#[tauri::command(async)]
pub fn git_merge_abort(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<GitStatus, String> {
    merge_abort(&state.checked_root(&root)?)
}

/// 冲突都解决并暂存后，用 MERGE_MSG 提交，完成这次合并。
#[tauri::command(async)]
pub fn git_merge_continue(
    state: tauri::State<'_, FsState>,
    root: String,
) -> Result<GitStatus, String> {
    merge_continue(&state.checked_root(&root)?)
}

/// 解决一个冲突文件：接受当前侧 / 传入侧 / 保留两者，然后把它标记为已解决。
#[tauri::command(async)]
pub fn git_resolve_conflict(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
    choice: ConflictChoice,
) -> Result<GitStatus, String> {
    resolve_conflict(&state.checked_root(&root)?, &path, &choice)
}

/// 一批路径里，哪些被 .gitignore 之类的排除规则忽略了。文件树按这个把条目置灰。
#[tauri::command(async)]
pub fn git_ignored(
    state: tauri::State<'_, FsState>,
    root: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    ignored_paths(&state.checked_root(&root)?, &paths)
}

/// 把一条路径追加进工作区根的 `.gitignore`。已经有一条同样的规则时什么都不做。
#[tauri::command(async)]
pub fn git_add_to_ignore(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
) -> Result<(), String> {
    add_to_ignore(&state.checked_root(&root)?, &path)
}

/// 一次问 git 多少条路径。argv 有命令行长度上限（Windows 是 32767 个字符），
/// 80 条离上限还远，又不用为一个目录起太多次进程。
const IGNORE_CHUNK: usize = 80;

/// 忽略判定交给 `git check-ignore`，不在前端解析 .gitignore：嵌套 .gitignore、
/// 取反 `!`、目录整棵子树继承这些规则自己实现必然出错。
///
/// **不带 `--no-index`**：已经被跟踪的文件即使匹配规则也不算忽略（这正是 git 的
/// 语义），界面只该把真被过滤掉的置灰。
///
/// 路径走 argv 而不是 `--stdin`：`run_git_raw` 的 stdin 是关掉的，为它单开一套
/// 写管道的路不值当。代价是输出不能带 `-z`（git 只在 `--stdin` 下认它），只能按行读。
fn ignored_paths(root: &Path, raw: &[String]) -> Result<Vec<String>, String> {
    // 绝对路径 -> 喂给 git 的相对路径。越界的（前端理论上不会传）跳过而不是整批报错：
    // 这只是个显示效果，不该因为一条脏路径就让整棵树都不置灰
    let mut specs: Vec<(String, String)> = Vec::new();
    for item in raw {
        let Ok((target, spec)) = workspace_relative(root, item) else {
            continue;
        };
        // 形如 `dist/` 的规则只匹配目录，路径不带尾斜杠 git 就不认它
        let is_dir = std::fs::metadata(&target)
            .map(|meta| meta.is_dir())
            .unwrap_or(false);
        let spec = if is_dir { format!("{spec}/") } else { spec };
        specs.push((item.clone(), spec));
    }

    let mut ignored = Vec::new();
    for chunk in specs.chunks(IGNORE_CHUNK) {
        let mut args: Vec<&str> = vec!["check-ignore", "--"];
        args.extend(chunk.iter().map(|(_, spec)| spec.as_str()));
        // 退出码 1 是「一条都没匹配」，不是错误；run_git 已经把它折成 None
        let Some(bytes) = run_git(root, &args)? else {
            continue;
        };
        // 没有 --stdin 就用不了 -z（git 直接报 fatal），输出是按行一条。
        // git 回显的就是传进去的那份路径，抹掉尾斜杠再对回来。
        // 文件名里带换行会解析错：Windows 上不允许，Unix 上属于病态输入，不管。
        for line in String::from_utf8_lossy(&bytes).lines() {
            let hit = trim_spec(line);
            if let Some((abs, _)) = chunk.iter().find(|(_, spec)| trim_spec(spec) == hit) {
                ignored.push(abs.clone());
            }
        }
    }
    Ok(ignored)
}

/// 抹掉 git 回显里的尾斜杠（目录我们传的是 `dir/`）和 Windows 可能带上的行尾
fn trim_spec(text: &str) -> &str {
    text.trim_end_matches(['\r', '/'])
}

/// 写进 .gitignore 的一行规则里需要转义的字符。
///
/// `*?[]` 是通配符、反斜杠自己是转义符——不转义的话文件名里带这些字符就会匹配到
/// 别的文件（和 `--literal-pathspecs` 要挡的是同一类问题）。行首的 `#` 是注释、
/// `!` 是取反，行尾空格会被 gitignore 当空白吃掉，这三样也得转义。
fn escape_gitignore(spec: &str) -> String {
    let mut out = String::with_capacity(spec.len() + 2);
    for (index, ch) in spec.chars().enumerate() {
        let special = match ch {
            '\\' | '*' | '?' | '[' | ']' => true,
            '#' | '!' => index == 0,
            _ => false,
        };
        if special {
            out.push('\\');
        }
        out.push(ch);
    }
    // 尾空格的转义要补在空格**前面**。目录的尾斜杠是后面才加的，
    // 所以 `dir /` 里的空格不算行尾，天然不用处理
    if out.ends_with(' ') {
        out.insert(out.len() - 1, '\\');
    }
    out
}

/// 把一条路径追加进工作区根的 `.gitignore`。
///
/// 写工作区根而不是仓库根：工作区可能只是仓库的一个子目录，而 .gitignore 的规则
/// 本来就以自己所在的目录为基准，写在这里不用先算出仓库根在哪一层；git 支持嵌套的
/// .gitignore，两种情形下都生效。
///
/// 不去校验是不是仓库：这只是往一个文本文件里追加一行，目录还不是仓库时写了也无害
/// （将来 init 的时候规则正好现成）。界面上按 `isRepo` 决定给不给这个菜单项。
fn add_to_ignore(root: &Path, raw: &str) -> Result<(), String> {
    let (target, mut spec) = workspace_relative(root, raw)?;
    // 目录带尾斜杠，和 ignored_paths 喂给 check-ignore 的写法一致：不然一条
    // `build` 会把同名的**文件**也一起忽略掉
    let is_dir = std::fs::metadata(&target)
        .map(|meta| meta.is_dir())
        .unwrap_or(false);
    if is_dir {
        spec.push('/');
    }
    let entry = escape_gitignore(&spec);

    let file = root.join(".gitignore");
    let existing = match std::fs::read(&file) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| ".gitignore 不是 UTF-8 文本，没有改动它".to_string())?,
        Err(reason) if reason.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(reason) => return Err(format!("读取 .gitignore 失败: {reason}")),
    };

    // 已经有这条规则就当无事发生；`build` 和 `build/` 说的是同一件事
    let bare = entry.trim_end_matches('/');
    if existing.lines().any(|line| line.trim_end() == bare) {
        return Ok(());
    }

    let mut next = existing;
    // 原文件最后一行没有换行就先补一个，否则新规则会和它粘成一条
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&entry);
    next.push('\n');
    std::fs::write(&file, next).map_err(|reason| format!("写入 .gitignore 失败: {reason}"))
}

/// 一次克隆的进度事件。`percent` 解析不出来时为 None（比如 "Cloning into..." 这类
/// 没有百分比的阶段），前端据此显示不确定态进度条。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloneProgress {
    /// 对应前端发起的那次克隆，前端按它过滤（同一窗口可能有别的克隆在跑）
    id: String,
    /// 阶段名（Counting / Compressing / Receiving / Resolving…），给进度条上的文案用
    phase: String,
    percent: Option<u8>,
    /// 原始那一行，出错或需要看细节时直接展示
    text: String,
}

/// 从 git 的进度行里抠出百分比：`Receiving objects:  45% (45/100)` -> 45。
/// 取 `%` 之前连续的十进制数字；没有 `%` 或取不到数字就返回 None，封顶 100。
fn parse_percent(line: &str) -> Option<u8> {
    let index = line.find('%')?;
    let digits: String = line[..index]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let value: u32 = digits.chars().rev().collect::<String>().parse().ok()?;
    Some(value.min(100) as u8)
}

/// 进度行的阶段名：取冒号前的部分（`Receiving objects:  45% …` -> `Receiving objects`）。
/// 没有冒号的行（`Cloning into 'x'...`）原样返回。
fn clone_phase(line: &str) -> &str {
    match line.split_once(':') {
        Some((head, _)) => head.trim(),
        None => line.trim(),
    }
}

/// 从仓库 URL 推导目录名：`https://github.com/foo/bar.git` -> bar。
/// 兼容 scp 风格（`git@github.com:foo/bar.git`，最后一段用冒号分隔）与结尾斜杠。
fn derive_repo_name(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next().unwrap_or(trimmed);
    last.strip_suffix(".git").unwrap_or(last).trim().to_string()
}

/// 把一行 git 输出变成进度事件发出去。percent / phase 解析不出来也照发，
/// 前端至少能显示原始文案。
fn emit_clone_progress(app: &tauri::AppHandle, id: &str, text: &str) {
    use tauri::Emitter;

    let payload = CloneProgress {
        id: id.to_string(),
        phase: clone_phase(text).to_string(),
        percent: parse_percent(text),
        text: text.to_string(),
    };
    let _ = app.emit("git-clone-progress", payload);
}

/// 克隆一个仓库到 `parent/name`，边跑边把进度 emit 出去，返回克隆出的绝对路径。
///
/// 目标目录必须不存在——`git clone` 允许克隆进一个已存在的**空**目录，但那样目录里
/// 可能藏着用户自己的东西，宁可直接报错让换个名字。
fn clone_repo(
    app: &tauri::AppHandle,
    id: &str,
    url: &str,
    parent: &str,
    name: Option<&str>,
    branch: Option<&str>,
    depth: Option<u32>,
) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("请填写仓库地址".to_string());
    }

    let parent_path = Path::new(parent);
    if !parent_path.is_dir() {
        return Err(format!("父目录不存在或不是目录: {parent}"));
    }

    let dir_name = match name.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None => derive_repo_name(url),
    };
    // 目录名必须是单段：带分隔符或 `..` 就能把它带到父目录之外
    if dir_name.is_empty() || dir_name == "." || dir_name == ".." || dir_name.contains(['/', '\\']) {
        return Err(format!("非法的目录名: {dir_name}"));
    }

    let target = parent_path.join(&dir_name);
    if target.exists() {
        return Err(format!("目录已存在: {}", target.display()));
    }

    let mut args: Vec<String> = vec!["clone".into(), "--progress".into()];
    if let Some(branch) = branch.map(str::trim).filter(|value| !value.is_empty()) {
        args.push("--branch".into());
        args.push(branch.to_string());
    }
    if let Some(depth) = depth.filter(|value| *value > 0) {
        args.push("--depth".into());
        args.push(depth.to_string());
    }
    args.push(url.to_string());
    args.push(dir_name.clone());

    let mut command = Command::new("git");
    command
        .args(&args)
        .current_dir(parent_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // 没有 TTY：私有仓库交给系统上配好的凭据，缺了就报错，别卡在输入密码上
    command.env("GIT_TERMINAL_PROMPT", "0");
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|reason| format!("无法执行 git: {reason}"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 git 输出".to_string())?;

    // 边读边发进度，读完把整段 stderr 还给主线程当错误信息
    let app = app.clone();
    let id = id.to_string();
    let reader = std::thread::spawn(move || {
        let mut all: Vec<u8> = Vec::new();
        let mut pending: Vec<u8> = Vec::new();
        let mut reader = stderr;
        let mut chunk = [0u8; 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    pending.extend_from_slice(&chunk[..count]);
                    // git 用 \r 原地刷新进度、用 \n 结束一行，两种都当分隔符
                    while let Some(index) = pending.iter().position(|b| *b == b'\r' || *b == b'\n')
                    {
                        let line: Vec<u8> = pending.drain(..=index).collect();
                        all.extend_from_slice(&line);
                        let text =
                            String::from_utf8_lossy(&line[..line.len() - 1]).trim().to_string();
                        if !text.is_empty() {
                            emit_clone_progress(&app, &id, &text);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        all.extend_from_slice(&pending);
        all
    });

    let status = child.wait();
    let stderr = reader.join().unwrap_or_default();

    match status {
        Ok(status) if status.success() => Ok(target.to_string_lossy().to_string()),
        Ok(_) => {
            // 进度行也在 stderr 里，把 \r 换成换行，读起来才不是一行糊到底
            let text = String::from_utf8_lossy(&stderr).replace('\r', "\n");
            let text = text.trim();
            Err(if text.is_empty() {
                "git clone 失败".to_string()
            } else {
                text.to_string()
            })
        }
        Err(reason) => Err(format!("等待 git 结束失败: {reason}")),
    }
}

/// 克隆一个 Git 仓库并返回它在本地的绝对路径；成功后前端把它当新工作区打开。
///
/// 克隆是长任务，**必须 async + spawn_blocking**：Tauri 的同步命令跑在主线程上，
/// 直接 `child.wait()` 会把整个界面卡住。进度通过 `git-clone-progress` 事件推送。
#[tauri::command]
pub async fn git_clone(
    app: tauri::AppHandle,
    id: String,
    url: String,
    parent: String,
    name: Option<String>,
    branch: Option<String>,
    depth: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        clone_repo(
            &app,
            &id,
            &url,
            &parent,
            name.as_deref(),
            branch.as_deref(),
            depth,
        )
    })
    .await
    .map_err(|reason| format!("克隆任务异常结束: {reason}"))?
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
        assert_eq!(status.head.as_deref(), Some("1234567890abcdef"));
        assert_eq!((status.ahead, status.behind), (2, 3));
        assert_eq!(status.changed, 0);
    }

    #[test]
    fn a_repo_without_commits_has_no_head() {
        let status = parse_status(
            &output(&["# branch.oid (initial)", "# branch.head main"]),
            "",
            &workspace(),
        );
        assert_eq!(status.head, None);
        assert_eq!(status.branch.as_deref(), Some("main"));
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
        assert!(!untracked.is_dir, "普通文件不能标成目录");

        // 未跟踪目录带尾斜杠，要标成 is_dir，前端才能不把它当文件读
        let dir = status
            .files
            .iter()
            .find(|file| file.path.ends_with("brandnew"))
            .expect("未跟踪目录应该在里面");
        assert!(dir.is_dir, "未跟踪目录要标成 is_dir");
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
        let missing = std::env::temp_dir().join("codovo-not-a-repo-ever");
        assert_eq!(
            run_git(&missing, &["rev-parse", "--show-prefix"]).unwrap(),
            None
        );
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
        let top =
            std::env::temp_dir().join(format!("codovo-git-{}-{unique}", std::process::id()));
        let repo = top.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let state = FsState::new();
        let root = state.register(repo).unwrap();
        (state, root, top)
    }

    fn init_repo(repo: &Path) {
        assert!(git(repo, &["init", "-q", "."]), "git init 失败");
        assert!(git(repo, &["config", "user.email", "codovo@test"]));
        assert!(git(repo, &["config", "user.name", "codovo"]));
    }

    fn path_of_file(repo: &Path, name: &str) -> String {
        repo.join(name).to_string_lossy().to_string()
    }

    /// 读文本并抹平行尾：本机 core.autocrlf 会把检出时的 LF 变成 CRLF，
    /// 直接比字符串会挂在行尾上
    fn read_text(path: &Path) -> String {
        fs::read_to_string(path).unwrap().replace("\r\n", "\n")
    }

    fn cleanup(top: &Path) {
        // .git 里有只读对象，删不掉就算了
        fs::remove_dir_all(top).ok();
    }

    #[test]
    fn pathspecs_are_relative_to_the_workspace_and_stay_inside() {
        let (_state, repo, top) = temp_repo();
        fs::create_dir_all(repo.join("src")).unwrap();

        let specs = pathspecs(&repo, &[path_of_file(&repo, "src/a.ts")]).unwrap();
        assert_eq!(specs, vec!["src/a.ts"]);

        // 工作区外的路径必须被沙箱挡下
        let outside = top.join("secret.txt").to_string_lossy().to_string();
        assert!(pathspecs(&repo, &[outside]).is_err());

        // 没给路径就是"全部"，而且必须落在工作区内
        assert_eq!(all_or_specs(&repo, &None).unwrap(), vec!["."]);
        assert_eq!(all_or_specs(&repo, &Some(vec![])).unwrap(), vec!["."]);

        cleanup(&top);
    }

    #[test]
    fn stages_then_unstages_before_the_first_commit() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("app.ts"), "a\n").unwrap();

        let after = stage_paths(&repo, &Some(vec![path_of_file(&repo, "app.ts")])).unwrap();
        assert_eq!(after.files.len(), 1);
        assert_eq!((after.files[0].index, after.files[0].worktree), ('A', '.'));

        // 这个仓库还没有 HEAD，restore --staged 会 fatal，必须走 rm --cached
        let after = unstage_paths(&repo, &Some(vec![path_of_file(&repo, "app.ts")])).unwrap();
        assert_eq!(after.files.len(), 1);
        assert_eq!((after.files[0].index, after.files[0].worktree), ('?', '?'));

        cleanup(&top);
    }

    #[test]
    fn commit_groups_makes_one_commit_per_group() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        // 先来一条初始提交，后面 unstage 才走 restore 那条支路
        fs::write(repo.join("base.txt"), "base\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "chore: 初始").unwrap();

        // 三个新文件，打算拆成两条提交
        fs::write(repo.join("a.ts"), "a\n").unwrap();
        fs::write(repo.join("b.ts"), "b\n").unwrap();
        fs::write(repo.join("c.ts"), "c\n").unwrap();
        // 先把 b、c 手工暂存上：分条要先清空暂存区再重排，b 该落到第一条而不是跟着 c
        stage_paths(
            &repo,
            &Some(vec![path_of_file(&repo, "b.ts"), path_of_file(&repo, "c.ts")]),
        )
        .unwrap();

        let groups = vec![
            CommitGroup {
                message: "feat: 加 a".to_string(),
                files: vec![path_of_file(&repo, "a.ts"), path_of_file(&repo, "b.ts")],
            },
            CommitGroup {
                message: "fix: 修 c".to_string(),
                files: vec![path_of_file(&repo, "c.ts")],
            },
        ];
        let after = commit_groups(&repo, groups).unwrap();
        // 提交完工作区干净：三个新文件都进了提交，base.txt 没动
        assert!(after.files.is_empty(), "提交后不该还有改动: {:?}", after.files);

        let subjects = run_git(&repo, &["log", "-2", "--format=%s"]).unwrap().unwrap();
        let subjects = String::from_utf8_lossy(&subjects);
        let lines: Vec<&str> = subjects.lines().collect();
        assert_eq!(lines[0], "fix: 修 c");
        assert_eq!(lines[1], "feat: 加 a");

        // b.ts 该落在第一条（feat）里，不能被 c 那条带走
        let files = run_git(&repo, &["show", "--name-only", "--format=", "HEAD~1"])
            .unwrap()
            .unwrap();
        let files = String::from_utf8_lossy(&files);
        assert!(files.contains("a.ts") && files.contains("b.ts"), "a.ts/b.ts 应在 feat 那条: {files}");
        assert!(!files.contains("c.ts"), "c.ts 不该出现在 feat 那条: {files}");

        cleanup(&top);
    }

    #[test]
    fn commit_groups_rejects_an_empty_plan() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        // 全是空组（空信息 / 空文件）→ 直接报错，不白跑一遍 git
        let empty = vec![
            CommitGroup {
                message: "  ".to_string(),
                files: vec!["x.ts".to_string()],
            },
            CommitGroup {
                message: "feat: 有信息但没文件".to_string(),
                files: Vec::new(),
            },
        ];
        assert!(commit_groups(&repo, empty).is_err());

        cleanup(&top);
    }

    #[test]
    fn commit_plan_context_covers_tracked_and_untracked_changes() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("tracked.txt"), "one\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "chore: 初始").unwrap();

        // 一个已跟踪文件的改动 + 一个未跟踪的新文件
        fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        fs::write(repo.join("new.ts"), "n\n").unwrap();

        let context = commit_plan_context(&repo).unwrap();
        // 清单要含未跟踪的新文件（`git diff HEAD` 里看不到它，靠 status 补上）
        assert!(context.files.iter().any(|file| file == "tracked.txt"));
        assert!(context.files.iter().any(|file| file == "new.ts"));
        // diff 是相对 HEAD 的，能解释已跟踪文件的改动
        assert!(context.diff.contains("tracked.txt"));

        cleanup(&top);
    }

    #[test]
    fn unstaging_after_a_commit_keeps_the_worktree_change() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo.join("app.ts");
        fs::write(&file, "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(&file, "a\nb\n").unwrap();
        let staged = stage_paths(&repo, &None).unwrap();
        assert_eq!(
            (staged.files[0].index, staged.files[0].worktree),
            ('M', '.')
        );

        let after = unstage_paths(&repo, &None).unwrap();
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
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::create_dir_all(repo.join("old")).unwrap();
        fs::write(repo.join("old").join("a.txt"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::remove_dir_all(repo.join("old")).unwrap();

        let status = status_of(&repo).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].relative, "old/a.txt");

        // old 整个目录都没了，resolve 得靠"向上找最近存在的祖先"才能过
        let after = stage_paths(&repo, &Some(vec![status.files[0].path.clone()])).unwrap();
        assert_eq!((after.files[0].index, after.files[0].worktree), ('D', '.'));

        cleanup(&top);
    }

    #[test]
    fn treats_pathspec_wildcards_literally() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        // `[1]` 在 git 的 pathspec 里是字符类，会匹配到 a1.txt；
        // Windows 文件名不允许 * 和 ?，所以用中括号当代表
        for name in ["a[1].txt", "a1.txt"] {
            fs::write(repo.join(name), "x\n").unwrap();
        }

        let after = stage_paths(&repo, &Some(vec![path_of_file(&repo, "a[1].txt")])).unwrap();
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
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::create_dir_all(repo.join("brandnew").join("nested")).unwrap();
        fs::write(repo.join("brandnew").join("a.txt"), "a\n").unwrap();
        fs::write(repo.join("brandnew").join("nested").join("b.txt"), "b\n").unwrap();

        // --untracked-files=all 把未跟踪目录展开成文件：改动数按文件计、列表也到文件级
        // （normal 会把整个目录折叠成一条 "brandnew"，数量按目录算 1）
        let status = status_of(&repo).unwrap();
        let mut relatives: Vec<&str> = status.files.iter().map(|file| file.relative.as_str()).collect();
        relatives.sort_unstable();
        assert_eq!(relatives, vec!["brandnew/a.txt", "brandnew/nested/b.txt"]);
        assert_eq!(status.changed, 2, "数量要按文件算，不是按目录");
        assert!(status.files.iter().all(|file| !file.is_dir), "all 模式下不该有目录条目");

        // 传目录路径仍能整目录暂存（pathspecs 会给目录补尾斜杠）
        let after = stage_paths(&repo, &Some(vec![path_of_file(&repo, "brandnew")])).unwrap();
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
        let sub = state.register(sub).unwrap();

        // 不带 pathspec 的 add -A 会把仓库根那个文件也暂存了，界面上看不出来
        let after = stage_paths(&sub, &None).unwrap();
        let staged: Vec<&str> = after
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect();
        assert_eq!(staged, vec!["inside.txt"]);
        assert!(sub.join("inside.txt").is_file());

        cleanup(&top);
    }

    #[test]
    fn commit_failures_surface_gits_own_message() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("app.ts"), "a\n").unwrap();

        // 什么都没暂存就提交：git 在 stderr 上给出原因并返回非 0。
        // 关键是那段原文要原样带回来（它是多行的），而不是被吞成一句通用错误
        let error = commit_staged(&repo, "init").unwrap_err();
        assert!(!error.trim().is_empty());
        assert!(error.lines().count() > 1, "报错被截断了: {error:?}");

        // 空信息在前端就该拦住，到这儿也要有个明确说法
        assert!(commit_staged(&repo, "   ")
            .unwrap_err()
            .contains("不能为空"));

        cleanup(&top);
    }

    // ---- 差异视图：同样是跑真 git 的用例 ----

    /// `classify` 要按检测到的编码解码，不能像以前那样 lossy 成替换字符
    #[test]
    fn classify_decodes_legacy_encodings() {
        const CN: &str = "这是一个使用旧编码的中文文本，用来验证编码检测与往返保存。";
        let gbk = crate::encoding::encode(CN, crate::encoding::FileEncoding::Gbk).unwrap();
        match classify(gbk) {
            Side::Text(text) => assert_eq!(text, CN, "GBK 文件应当解成正确正文"),
            _ => panic!("GBK 文本不该被判成二进制 / 过大"),
        }

        // CRLF 归一仍然生效
        match classify(b"a\r\nb".to_vec()) {
            Side::Text(text) => assert_eq!(text, "a\nb"),
            _ => panic!("普通文本应当解成 Text"),
        }

        // 含 NUL 的真二进制仍然算二进制
        assert!(classify(vec![0u8, 1, 2]).is_binary());
    }

    #[test]
    fn new_file_baseline_is_empty() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "fresh.txt");
        fs::write(&path, "a\n").unwrap();

        // 还没暂存：index 里没有这条，基线是空
        let diff = file_diff(&repo, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "a\n");
        assert!(!diff.is_binary && !diff.too_large);

        // 没有 HEAD 的仓库里暂存进来，基线依然是空
        stage_paths(&repo, &None).unwrap();
        let diff = file_diff(&repo, &path, &DiffSource::Staged).unwrap();
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "a\n");

        cleanup(&top);
    }

    #[test]
    fn modified_file_has_both_sides() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(&path, "a\nb\n").unwrap();
        // 未暂存：基线是 index（还是提交时的 "a\n"）
        let diff = file_diff(&repo, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "a\nb\n");

        cleanup(&top);
    }

    #[test]
    fn staged_diff_uses_head_as_baseline() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(&path, "a\nb\n").unwrap();
        stage_paths(&repo, &None).unwrap();

        // 暂存后基线从 index 换成 HEAD
        let diff = file_diff(&repo, &path, &DiffSource::Staged).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "a\nb\n");
        // 同一个文件此时未暂存侧没有改动，两边内容一致
        let unstaged = file_diff(&repo, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(unstaged.original, unstaged.modified);

        cleanup(&top);
    }

    // ---- 解读用的 diff 文本 ----

    #[test]
    fn diff_text_shows_the_change_for_each_source() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(&path, "a\nb\n").unwrap();
        let unstaged = file_diff_text(&repo, &path, &DiffSource::Unstaged).unwrap();
        assert!(unstaged.contains("+b"), "应当带上新增那一行：{unstaged}");
        assert!(unstaged.contains("app.ts"));

        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "more").unwrap();
        // 提交之后看这个提交：基线是它的父提交，照样能看出加了 b
        let rev = run_git(&repo, &["rev-parse", "HEAD"]).unwrap().unwrap();
        let rev = String::from_utf8_lossy(&rev).trim().to_string();
        let commit = file_diff_text(&repo, &path, &DiffSource::Commit { rev }).unwrap();
        assert!(commit.contains("+b"), "提交里的改动应当能取到：{commit}");

        cleanup(&top);
    }

    #[test]
    fn diff_text_falls_back_to_the_whole_file_when_untracked() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        // 未跟踪的文件 `git diff` 什么都不出，得把内容当成整个新增
        let path = path_of_file(&repo, "fresh.txt");
        fs::write(&path, "hello\nworld\n").unwrap();

        let text = file_diff_text(&repo, &path, &DiffSource::Unstaged).unwrap();
        assert!(text.contains("新增文件"));
        assert!(text.contains("+hello"));
        assert!(text.contains("+world"));

        cleanup(&top);
    }

    #[test]
    fn diff_text_keeps_wildcard_filenames_literal() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        // `[1]` 在 git 的 pathspec 里是字符类，会匹配到 a1.txt；
        // Windows 文件名不允许 * 和 ?，所以用中括号当代表
        let target = path_of_file(&repo, "a[1].txt");
        fs::write(&target, "one\n").unwrap();
        fs::write(path_of_file(&repo, "a1.txt"), "two\n").unwrap();

        let text = file_diff_text(&repo, &target, &DiffSource::Unstaged).unwrap();
        assert!(text.contains("+one"), "应当只有 a[1].txt 的内容：{text}");
        assert!(!text.contains("+two"), "不该把 a1.txt 也带上：{text}");

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
        let sub = state.register(sub).unwrap();
        stage_paths(&sub, &None).unwrap();
        commit_staged(&sub, "init").unwrap();

        let path = path_of_file(&sub, "inside.txt");
        fs::write(&path, "a\nb\n").unwrap();

        // `cat-file` 的路径是相对仓库根的，工作区只是子目录时必须拼上 prefix
        let diff = file_diff(&sub, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "a\nb\n");

        cleanup(&top);
    }

    #[test]
    fn deleted_file_has_empty_current_side() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "gone.txt");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::remove_file(&path).unwrap();
        let diff = file_diff(&repo, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "");

        cleanup(&top);
    }

    #[test]
    fn normalizes_crlf_so_line_endings_alone_are_not_a_diff() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "app.ts");
        // index 里存 LF（本项目 autocrlf=true 下的常态），工作区是 CRLF
        fs::write(&path, "a\nb\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(&path, "a\r\nb\r\n").unwrap();
        let diff = file_diff(&repo, &path, &DiffSource::Unstaged).unwrap();
        assert_eq!(diff.original, diff.modified, "只改行尾不该报成差异");

        cleanup(&top);
    }

    #[test]
    fn non_repo_rejects_with_message() {
        let (_state, repo, top) = temp_repo();
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();

        // 目录存在但没 init 过，repo_prefix 返回 None
        let error = file_diff(&repo, &path, &DiffSource::Unstaged).unwrap_err();
        assert!(error.contains("不是 git 仓库"), "{error:?}");

        cleanup(&top);
    }

    // ---- 时间线与提交内的差异 ----

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
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        // 空仓库里 git log 非 0 退出，这不是错误
        assert!(log_filtered(&repo, LOG_PAGE, None, None).unwrap().is_empty());
        cleanup(&top);
    }

    #[test]
    fn log_lists_newest_first_and_parses_fields() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo.join("app.ts");
        fs::write(&file, "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "第一条").unwrap();

        fs::write(&file, "a\nb\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "第二条 带 空格").unwrap();

        let commits = log_filtered(&repo, LOG_PAGE, None, None).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "第二条 带 空格", "最新的排最前");
        assert_eq!(commits[1].subject, "第一条");
        assert_eq!(commits[0].hash.len(), 40);
        assert_eq!(commits[0].short.len(), 7);
        assert!(!commits[0].author.is_empty());
        assert!(commits[0].time > 0);

        // limit 要生效
        assert_eq!(log_filtered(&repo, 1, None, None).unwrap().len(), 1);

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
        stage_paths(&repo, &None).unwrap();
        let head = commit_staged(&repo, "init").unwrap();
        let _ = head;
        let rev = log_filtered(&repo, 1, None, None).unwrap()[0].hash.clone();

        // 工作区切到 sub/：仓库根那个 outside.txt 不该出现在列表里
        let sub = state.register(repo.join("sub")).unwrap();
        let files = files_of(&sub, &rev).unwrap();
        let mut relatives: Vec<&str> = files.iter().map(|f| f.relative.as_str()).collect();
        relatives.sort_unstable();
        assert_eq!(relatives, vec!["inside.txt", "nested/deep.txt"]);
        assert_eq!(files[0].status, 'A');
        // path 得是工作区里的绝对路径，点开差异要用
        assert!(files
            .iter()
            .all(|f| f.path.starts_with(&sub.to_string_lossy().to_string())));

        cleanup(&top);
    }

    #[test]
    fn commit_diff_uses_the_parent_as_the_baseline() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let path = path_of_file(&repo, "app.ts");
        fs::write(&path, "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        // 第二次提交之后工作区再改一通，确保看的确实是提交本身而不是工作区
        fs::write(&path, "a\nb\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "改一行").unwrap();
        fs::write(&path, "a\nb\nc\n").unwrap();

        let rev = log_filtered(&repo, 1, None, None).unwrap()[0].hash.clone();
        let diff = file_diff(&repo, &path, &DiffSource::Commit { rev }).unwrap();
        assert_eq!(diff.original, "a\n");
        assert_eq!(diff.modified, "a\nb\n", "看的是提交里的版本，不是工作区");

        // 根提交没有父，基线该落到空
        let root_rev = log_filtered(&repo, 2, None, None).unwrap()[1].hash.clone();
        let first = file_diff(&repo, &path, &DiffSource::Commit { rev: root_rev }).unwrap();
        assert_eq!(first.original, "");
        assert_eq!(first.modified, "a\n");

        cleanup(&top);
    }

    #[test]
    fn commit_files_reports_deletions() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("keep.txt"), "k\n").unwrap();
        fs::write(repo.join("gone.txt"), "g\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::remove_file(repo.join("gone.txt")).unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "删掉一个").unwrap();

        let rev = log_filtered(&repo, 1, None, None).unwrap()[0].hash.clone();
        let files = files_of(&repo, &rev).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative, "gone.txt");
        assert_eq!(files[0].status, 'D');

        cleanup(&top);
    }

    // ---- 放弃修改：同样是跑真 git 的用例 ----

    #[test]
    fn discard_needs_an_explicit_path() {
        // 不做"全部"：两个分组的还原目标不一样，pathspec `.` 会把另一组也带上
        let (_state, repo, top) = temp_repo();
        let error = discard_paths(&repo, &[], &DiscardSource::Unstaged).unwrap_err();
        assert!(error.contains("没有指定"), "{error}");
        cleanup(&top);
    }

    #[test]
    fn discarding_the_worktree_restores_it_from_the_index() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo.join("app.ts");
        fs::write(&file, "one\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(&file, "two\n").unwrap();
        assert_eq!(status_of(&repo).unwrap().files.len(), 1);

        let after = discard_paths(
            &repo,
            &[path_of_file(&repo, "app.ts")],
            &DiscardSource::Unstaged,
        )
        .unwrap();
        assert_eq!(read_text(&file), "one\n");
        assert!(after.files.is_empty(), "工作区回到 index 后就该是干净的");

        cleanup(&top);
    }

    #[test]
    fn discarding_a_staged_change_reverts_index_and_worktree_to_head() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo.join("app.ts");
        fs::write(&file, "one\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(&file, "two\n").unwrap();
        stage_paths(&repo, &None).unwrap();

        let after = discard_paths(
            &repo,
            &[path_of_file(&repo, "app.ts")],
            &DiscardSource::Staged,
        )
        .unwrap();
        assert_eq!(read_text(&file), "one\n");
        assert!(after.files.is_empty(), "index 和工作区都该回到 HEAD");

        cleanup(&top);
    }

    #[test]
    fn discarding_the_worktree_keeps_what_is_staged() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo.join("app.ts");
        fs::write(&file, "one\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        // 先暂存一版、再在工作区改一版，状态就是 MM
        fs::write(&file, "two\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        fs::write(&file, "three\n").unwrap();
        let status = status_of(&repo).unwrap();
        assert_eq!(
            (status.files[0].index, status.files[0].worktree),
            ('M', 'M')
        );

        // 「改动」组的放弃只动工作区：回到 index 里的 "two"，暂存的那版留着
        let after = discard_paths(
            &repo,
            &[path_of_file(&repo, "app.ts")],
            &DiscardSource::Unstaged,
        )
        .unwrap();
        assert_eq!(read_text(&file), "two\n");
        assert_eq!(after.files.len(), 1);
        assert_eq!((after.files[0].index, after.files[0].worktree), ('M', '.'));

        cleanup(&top);
    }

    // ---- hunk 级：把一个文件的改动拆成块，单独暂存 / 放弃 ----

    #[test]
    fn splits_a_patch_into_header_and_hunks() {
        let patch = "diff --git a/x b/x\n\
                     index 1111111..2222222 100644\n\
                     --- a/x\n\
                     +++ b/x\n\
                     @@ -1,4 +1,5 @@\n\
                     \x20top\n\
                     -old\n\
                     +new\n\
                     +more\n\
                     \x20tail\n\
                     @@ -10,3 +11,3 @@ fn tail()\n\
                     -a\n\
                     +b\n\
                     \x20z\n";
        let (header, hunks) = split_patch(patch);

        assert_eq!(
            header,
            "diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n"
        );
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].header, "@@ -1,4 +1,5 @@");
        assert_eq!((hunks[0].added, hunks[0].removed), (2, 1));
        assert_eq!(hunks[1].header, "@@ -10,3 +11,3 @@ fn tail()");
        assert_eq!((hunks[1].added, hunks[1].removed), (1, 1));
        // 拼回去要一个字节不差：补丁是原样交给 git apply 的
        assert_eq!(
            format!("{}{}{}", header, hunks[0].text, hunks[1].text),
            patch
        );
    }

    #[test]
    fn keeps_the_no_newline_marker_inside_its_hunk() {
        // 文件末尾没有换行时 git 会补一行 `\ No newline ...`，它以 `\` 开头，
        // 不能被当成新 hunk 的开始，也不能计进增删行数
        let patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n";
        let (_, hunks) = split_patch(patch);
        assert_eq!(hunks.len(), 1);
        assert_eq!((hunks[0].added, hunks[0].removed), (1, 1));
        assert!(hunks[0].text.contains("\\ No newline at end of file"));
    }

    /// 造一个文件：第一行和中间一行各改一处，中间隔着足够多的上下文，
    /// `git diff` 会把它们分成两个 hunk（默认上下文 3 行）
    fn repo_with_two_hunks(repo: &Path) -> PathBuf {
        let file = repo.join("app.ts");
        let base: String = (1..=30).map(|line| format!("line {line}\n")).collect();
        fs::write(&file, &base).unwrap();
        stage_paths(repo, &None).unwrap();
        commit_staged(repo, "init").unwrap();

        let mut changed: Vec<String> = (1..=30).map(|line| format!("line {line}\n")).collect();
        changed[1] = "line 2 changed\n".to_string();
        changed[25] = "line 26 changed\n".to_string();
        fs::write(&file, changed.concat()).unwrap();
        file
    }

    #[test]
    fn stages_only_the_selected_hunk() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo_with_two_hunks(&repo);

        let hunks = file_hunks(&repo, &path_of_file(&repo, "app.ts"), false).unwrap();
        assert_eq!(hunks.hunks.len(), 2, "两处相隔 24 行，应该切成两个 hunk");

        // 只暂存第二个 hunk
        let patch = format!("{}{}", hunks.header, hunks.hunks[1].text);
        let status = apply_patch(&repo, &patch, &HunkAction::Stage).unwrap();

        let staged = String::from_utf8(
            run_git(&repo, &["diff", "--cached", "--no-color"])
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(staged.contains("line 26 changed"), "{staged}");
        assert!(!staged.contains("line 2 changed"), "{staged}");
        // 工作区两处改动都还在，只有 index 动了
        assert_eq!(read_text(&file), {
            let mut text: Vec<String> = (1..=30).map(|line| format!("line {line}\n")).collect();
            text[1] = "line 2 changed\n".to_string();
            text[25] = "line 26 changed\n".to_string();
            text.concat()
        });
        assert_eq!((status.files[0].index, status.files[0].worktree), ('M', 'M'));

        cleanup(&top);
    }

    #[test]
    fn discards_only_the_selected_hunk() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo_with_two_hunks(&repo);

        let hunks = file_hunks(&repo, &path_of_file(&repo, "app.ts"), false).unwrap();
        assert_eq!(hunks.hunks.len(), 2);

        // 只丢掉第一个 hunk：第 2 行回到原样，第 26 行的改动留着
        let patch = format!("{}{}", hunks.header, hunks.hunks[0].text);
        apply_patch(&repo, &patch, &HunkAction::Discard).unwrap();

        let text = read_text(&file);
        assert!(text.contains("line 2\n"), "{text}");
        assert!(!text.contains("line 2 changed"), "{text}");
        assert!(text.contains("line 26 changed"), "{text}");

        cleanup(&top);
    }

    /// 工作区是 CRLF、index 是 LF（`core.autocrlf=true` 的机器就是这样）。
    ///
    /// 这条链上**不能**过 `normalize_newlines`：那是给「两侧内容比对」用的，补丁必须
    /// 和工作区字节一致，归一过就 apply 不上了。反过来说，只要不多此一举，
    /// 补丁由 `git diff` 生成、再由 `git apply` 落回去，行尾转换是自洽的——实测
    /// 不需要 `--ignore-whitespace`。
    #[test]
    fn hunks_round_trip_with_a_crlf_worktree() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        assert!(git(&repo, &["config", "core.autocrlf", "true"]));

        let file = repo.join("app.ts");
        let crlf = |lines: &[String]| lines.join("\r\n") + "\r\n";
        let base: Vec<String> = (1..=30).map(|line| format!("line {line}")).collect();
        fs::write(&file, crlf(&base)).unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        let mut changed = base.clone();
        changed[1] = "line 2 changed".to_string();
        changed[25] = "line 26 changed".to_string();
        fs::write(&file, crlf(&changed)).unwrap();

        // 提交后工作区是 CRLF，但整文件不该显示成"改过了"：autocrlf 已经把它折算掉
        let hunks = file_hunks(&repo, &path_of_file(&repo, "app.ts"), false).unwrap();
        assert_eq!(hunks.hunks.len(), 2, "行尾不该被算成改动");

        // 暂存第二块，再丢掉第一块：一个动 index、一个动工作区
        apply_patch(
            &repo,
            &format!("{}{}", hunks.header, hunks.hunks[1].text),
            &HunkAction::Stage,
        )
        .unwrap();
        let staged = String::from_utf8(
            run_git(&repo, &["diff", "--cached", "--no-color"])
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(staged.contains("line 26 changed"), "{staged}");
        assert!(!staged.contains("line 2 changed"), "{staged}");

        let hunks = file_hunks(&repo, &path_of_file(&repo, "app.ts"), false).unwrap();
        assert_eq!(hunks.hunks.len(), 1, "刚暂存过的那块不该再出现");
        apply_patch(
            &repo,
            &format!("{}{}", hunks.header, hunks.hunks[0].text),
            &HunkAction::Discard,
        )
        .unwrap();
        // 丢掉的是工作区那一侧：行尾仍是 CRLF，第 26 行那处改动留着
        let text = fs::read(&file).unwrap();
        let text = String::from_utf8(text).unwrap();
        assert!(text.contains("line 2\r\n"), "{text:?}");
        assert!(!text.contains("line 2 changed"), "{text:?}");
        assert!(text.contains("line 26 changed"), "{text:?}");

        cleanup(&top);
    }

    #[test]
    fn a_clean_file_has_no_hunks() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo.join("app.ts");
        fs::write(&file, "one\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        // 已经提交、工作区没动：diff 是空的，不该报错也不该有 hunk
        let hunks = file_hunks(&repo, &path_of_file(&repo, "app.ts"), false).unwrap();
        assert!(hunks.hunks.is_empty());

        cleanup(&top);
    }

    #[test]
    fn applying_an_empty_patch_is_refused() {
        let (_state, repo, top) = temp_repo();
        assert!(apply_patch(&repo, "  \n", &HunkAction::Stage).is_err());
        cleanup(&top);
    }

    // ---- 行级：在一个 hunk 里只对选中的几行动手 ----

    /// 一个 hunk、两处相邻的改动（l2→l2x、l5→l5x），正文下标固定：
    /// 1 = `-l2`、2 = `+l2x`、5 = `-l5`、6 = `+l5x`
    fn one_hunk_patch() -> &'static str {
        "diff --git a/x b/x\n\
         index 1111111..2222222 100644\n\
         --- a/x\n\
         +++ b/x\n\
         @@ -1,7 +1,7 @@\n\
         \x20l1\n\
         -l2\n\
         +l2x\n\
         \x20l3\n\
         \x20l4\n\
         -l5\n\
         +l5x\n\
         \x20l6\n\
         \x20l7\n"
    }

    /// 造一个只有这一个 hunk 的仓库，工作区已改，还没暂存
    fn repo_with_one_hunk(repo: &Path) -> PathBuf {
        let file = repo.join("x");
        let base = "l1\nl2\nl3\nl4\nl5\nl6\nl7\n";
        fs::write(&file, base).unwrap();
        stage_paths(repo, &None).unwrap();
        commit_staged(repo, "init").unwrap();
        fs::write(&file, "l1\nl2x\nl3\nl4\nl5x\nl6\nl7\n").unwrap();
        file
    }

    #[test]
    fn lines_to_patch_keeps_only_the_selected_change() {
        // 正向（进暂存）：没选中的删除行退回上下文、没选中的新增行整条去掉
        let stage = patch_for_lines(one_hunk_patch(), &[6], &HunkAction::Stage).unwrap();
        assert!(stage.contains("@@ -1,7 +1,8 @@"), "{stage}");
        assert!(stage.contains("\x20l2\n"), "没选中的删除行要退回上下文：{stage}");
        assert!(!stage.contains("+l2x"), "没选中的新增行该整条去掉：{stage}");
        assert!(stage.contains("\x20l5\n"), "{stage}");
        assert!(stage.contains("+l5x"), "{stage}");

        // 反向（放弃 / 取消暂存）：正好相反
        let reverse = patch_for_lines(one_hunk_patch(), &[6], &HunkAction::Discard).unwrap();
        assert!(reverse.contains("@@ -1,6 +1,7 @@"), "{reverse}");
        assert!(!reverse.contains("-l2"), "没选中的删除行该整条去掉：{reverse}");
        assert!(reverse.contains("\x20l2x\n"), "没选中的新增行要退回上下文：{reverse}");
        assert!(reverse.contains("+l5x"), "{reverse}");
    }

    #[test]
    fn lines_to_patch_refuses_a_multi_hunk_patch() {
        let patch = format!("{}{}", one_hunk_patch(), "@@ -20,1 +20,1 @@\n-a\n+b\n");
        assert!(patch_for_lines(&patch, &[0], &HunkAction::Stage).is_err());
        assert!(patch_for_lines("", &[0], &HunkAction::Stage).is_err());
    }

    #[test]
    fn stages_only_the_selected_lines() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo_with_one_hunk(&repo);

        let patch = one_hunk_patch();
        let staged = patch_for_lines(patch, &[5, 6], &HunkAction::Stage).unwrap();
        apply_patch(&repo, &staged, &HunkAction::Stage).unwrap();

        let cached = String::from_utf8(
            run_git(&repo, &["diff", "--cached", "--no-color"]).unwrap().unwrap(),
        )
        .unwrap();
        assert!(cached.contains("+l5x"), "{cached}");
        assert!(!cached.contains("l2x"), "没选中的那处不该进暂存区：{cached}");
        // 工作区两处改动都还在
        assert_eq!(read_text(&file), "l1\nl2x\nl3\nl4\nl5x\nl6\nl7\n");

        cleanup(&top);
    }

    #[test]
    fn discards_only_the_selected_lines() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo_with_one_hunk(&repo);

        let patch = patch_for_lines(one_hunk_patch(), &[5, 6], &HunkAction::Discard).unwrap();
        apply_patch(&repo, &patch, &HunkAction::Discard).unwrap();

        // 只有 l5 那一处回到原样，l2x 的改动留着
        assert_eq!(read_text(&file), "l1\nl2x\nl3\nl4\nl5\nl6\nl7\n");

        cleanup(&top);
    }

    #[test]
    fn unstages_only_the_selected_lines() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        let file = repo_with_one_hunk(&repo);
        // 先把两处改动都暂存
        stage_paths(&repo, &None).unwrap();
        assert!(file_hunks(&repo, &path_of_file(&repo, "x"), true).unwrap().hunks.len() == 1);

        let patch = patch_for_lines(one_hunk_patch(), &[5, 6], &HunkAction::Unstage).unwrap();
        apply_patch(&repo, &patch, &HunkAction::Unstage).unwrap();

        let cached = String::from_utf8(
            run_git(&repo, &["diff", "--cached", "--no-color"]).unwrap().unwrap(),
        )
        .unwrap();
        assert!(cached.contains("+l2x"), "没选中的那处该留在暂存区：{cached}");
        assert!(!cached.contains("l5x"), "选中的那处该退回：{cached}");
        // 取消暂存不动工作区
        assert_eq!(read_text(&file), "l1\nl2x\nl3\nl4\nl5x\nl6\nl7\n");

        cleanup(&top);
    }

    #[test]
    fn filters_commits_by_subject_author_or_body() {
        let make = |subject: &str, author: &str, body: &str| Commit {
            hash: subject.to_string(),
            short: subject.to_string(),
            author: author.to_string(),
            time: 0,
            subject: subject.to_string(),
            body: body.to_string(),
            parents: Vec::new(),
            refs: Vec::new(),
        };
        let commits = || {
            vec![
                make("Add login", "Alice", ""),
                make("Fix parser", "Bob", "touches the lexer"),
                make("Docs", "Carol", ""),
            ]
        };
        // 主题命中
        assert_eq!(filter_commits(commits(), "login").len(), 1);
        // 作者命中（不是用 --author 拼出来的 AND）
        assert_eq!(filter_commits(commits(), "bob").len(), 1);
        // 正文命中
        assert_eq!(filter_commits(commits(), "lexer").len(), 1);
        // 大小写不敏感
        assert_eq!(filter_commits(commits(), "ALICE").len(), 1);
        // 都不命中
        assert_eq!(filter_commits(commits(), "zzz").len(), 0);
    }

    #[test]
    fn log_filters_by_text_and_by_path() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "add alpha feature").unwrap();
        fs::write(repo.join("b.txt"), "b\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "fix beta bug").unwrap();

        // 主题过滤
        let hits = log_filtered(&repo, 50, Some("alpha"), None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].subject, "add alpha feature");

        // 路径过滤走 git 的 pathspec：只有碰过 b.txt 的那条
        let hits = log_filtered(&repo, 50, None, Some("b.txt")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].subject, "fix beta bug");

        // 过滤不命中就是空
        assert!(log_filtered(&repo, 50, Some("nope"), None).unwrap().is_empty());
        // 不带过滤时照旧
        assert_eq!(log_filtered(&repo, 50, None, None).unwrap().len(), 2);

        cleanup(&top);
    }

    // ---- 远程操作：本地裸仓库当远程，不联网 ----

    /// 分支名显式定成 main。`init.defaultBranch` 在不同机器上可能是 master，
    /// 裸仓库的 HEAD 指向不存在的 ref 时克隆下来是个空仓库，测试会莫名其妙地挂。
    fn init_repo_on_main(repo: &Path) {
        assert!(
            git(repo, &["init", "-q", "-b", "main", "."]),
            "git init 失败"
        );
        assert!(git(repo, &["config", "user.email", "codovo@test"]));
        assert!(git(repo, &["config", "user.name", "codovo"]));
    }

    fn bare_remote(top: &Path) -> PathBuf {
        assert!(
            git(top, &["init", "--bare", "-q", "-b", "main", "remote.git"]),
            "建裸仓库失败"
        );
        top.join("remote.git")
    }

    /// 在别的克隆里造一个提交并推上去，用来模拟"远程那边有更新"
    fn push_from_another_clone(top: &Path, remote_url: &str, name: &str) {
        assert!(git(top, &["clone", "-q", remote_url, "other"]));
        let other = top.join("other");
        assert!(git(&other, &["config", "user.email", "codovo@test"]));
        assert!(git(&other, &["config", "user.name", "codovo"]));
        fs::write(other.join(name), "r\n").unwrap();
        assert!(git(&other, &["add", "-A"]));
        assert!(git(&other, &["commit", "-q", "-m", "remote side"]));
        assert!(git(&other, &["push", "-q"]));
    }

    /// 在别的克隆里改**同一个文件的同一行**再推上去，制造一次真冲突。
    /// `push_from_another_clone` 写的是新文件，永远不会冲突，这里要的是对撞。
    fn push_conflicting_change(top: &Path, remote_url: &str, name: &str, content: &str) {
        assert!(git(top, &["clone", "-q", remote_url, "conflict-clone"]));
        let other = top.join("conflict-clone");
        assert!(git(&other, &["config", "user.email", "codovo@test"]));
        assert!(git(&other, &["config", "user.name", "codovo"]));
        fs::write(other.join(name), content).unwrap();
        assert!(git(&other, &["add", "-A"]));
        assert!(git(&other, &["commit", "-q", "-m", "remote side"]));
        assert!(git(&other, &["push", "-q"]));
    }

    /// 建好一个"已推到远程、本地再提交一条"的分叉仓库（非冲突）。
    /// 返回 (repo, top, remote_url)；调用方负责 cleanup(top)。
    fn diverged_repo(remote_file: &str) -> (PathBuf, PathBuf, String) {
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let remote_url = bare_remote(&top).to_string_lossy().to_string();
        assert!(git(&repo, &["remote", "add", "origin", &remote_url]));

        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        push_remote(&repo).unwrap();

        push_from_another_clone(&top, &remote_url, remote_file);

        // 本地也提交一个，两条线就此分叉
        fs::write(repo.join("local-side.txt"), "l\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "local side").unwrap();

        (repo, top, remote_url)
    }

    /// 建好一个"本地和远程改了同一行"的仓库，并真的发起一次会冲突的合并。
    /// 返回 (repo, top, 合并前的 HEAD)；调用方负责 cleanup(top)。
    fn conflicted_repo() -> (PathBuf, PathBuf, Option<String>) {
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let remote_url = bare_remote(&top).to_string_lossy().to_string();
        assert!(git(&repo, &["remote", "add", "origin", &remote_url]));

        fs::write(repo.join("app.ts"), "base\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        push_remote(&repo).unwrap();

        // 远程把同一行改成 remote、本地改成 local，两个 hunk 正面对撞
        push_conflicting_change(&top, &remote_url, "app.ts", "remote\n");
        fs::write(repo.join("app.ts"), "local\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "local side").unwrap();
        let head_before = status_of(&repo).unwrap().head;

        let after = merge_upstream(&repo).unwrap();
        assert!(after.merging, "前置条件：这次合并应当冲突并停在合并状态");

        (repo, top, head_before)
    }

    #[test]
    fn push_then_fetch_then_pull_round_trips() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let remote_url = bare_remote(&top).to_string_lossy().to_string();
        assert!(git(&repo, &["remote", "add", "origin", &remote_url]));

        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        // 第一次推没有上游，必须顺手建立跟踪关系，推完 ahead/behind 才是 0/0
        let after = push_remote(&repo).unwrap();
        assert_eq!(after.branch.as_deref(), Some("main"));
        assert_eq!((after.ahead, after.behind), (0, 0));

        push_from_another_clone(&top, &remote_url, "from-other.txt");

        // fetch 只动引用：behind 变成 1，但工作区里还没这个文件
        let after = fetch_remote(&repo).unwrap();
        assert_eq!((after.ahead, after.behind), (0, 1));
        assert!(!repo.join("from-other.txt").exists());

        // pull 快进：文件回来了，behind 归零
        let after = pull_remote(&repo).unwrap();
        assert_eq!((after.ahead, after.behind), (0, 0));
        // 比 trim 后的内容：本机 core.autocrlf 会把检出时的 LF 变成 CRLF
        assert_eq!(
            fs::read_to_string(repo.join("from-other.txt"))
                .unwrap()
                .trim(),
            "r"
        );

        cleanup(&top);
    }

    #[test]
    fn unpushed_lists_commits_the_upstream_does_not_have() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let remote_url = bare_remote(&top).to_string_lossy().to_string();
        assert!(git(&repo, &["remote", "add", "origin", &remote_url]));

        // 还没有上游：问不出来，给空列表而不是报错
        assert!(unpushed_of(&repo).unwrap().is_empty());

        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let pushed = commit_staged(&repo, "init").unwrap().head.unwrap();
        push_remote(&repo).unwrap();
        // 刚推完，HEAD 和上游是同一条
        assert!(unpushed_of(&repo).unwrap().is_empty());

        fs::write(repo.join("app.ts"), "a\nb\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let second = commit_staged(&repo, "local 1").unwrap().head.unwrap();
        fs::write(repo.join("app.ts"), "a\nb\nc\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let third = commit_staged(&repo, "local 2").unwrap().head.unwrap();

        // 最新的在最前，已经推上去的那条不能在里面
        assert_eq!(unpushed_of(&repo).unwrap(), vec![third, second]);
        assert!(!unpushed_of(&repo).unwrap().contains(&pushed));

        cleanup(&top);
    }

    #[test]
    fn unpushed_leaves_out_the_remote_side_of_a_divergence() {
        if !git_available() {
            return;
        }
        // 两边各有新提交：只有本地那一条算未推送，远程那条不该被标上
        let (repo, top, _remote_url) = diverged_repo("from-remote.txt");
        let head = status_of(&repo).unwrap().head.unwrap();
        assert_eq!(unpushed_of(&repo).unwrap(), vec![head]);
        cleanup(&top);
    }

    #[test]
    fn pull_refuses_to_merge_when_the_branch_has_diverged() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let remote_url = bare_remote(&top).to_string_lossy().to_string();
        assert!(git(&repo, &["remote", "add", "origin", &remote_url]));

        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        push_remote(&repo).unwrap();

        push_from_another_clone(&top, &remote_url, "remote-side.txt");

        // 本地也提交一个，两条线就此分叉
        fs::write(repo.join("local-side.txt"), "l\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "local side").unwrap();
        let head_before = status_of(&repo).unwrap().head;

        // --ff-only 必须拒绝。只断言"失败了"和"HEAD 没动"：报错文案是 git 自己的，
        // 会随版本和语言环境变，照着某句英文去断言会在别人的机器上挂掉
        let error = pull_remote(&repo).unwrap_err();
        assert!(!error.trim().is_empty());
        assert_eq!(status_of(&repo).unwrap().head, head_before);
        // 没有被带进合并状态：仍然是干净的单线历史，随时可以在终端里处理
        assert_eq!(log_filtered(&repo, 5, None, None).unwrap().len(), 2);

        cleanup(&top);
    }

    #[test]
    fn push_fast_forwards_when_the_remote_is_ahead() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let remote_url = bare_remote(&top).to_string_lossy().to_string();
        assert!(git(&repo, &["remote", "add", "origin", &remote_url]));

        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        push_remote(&repo).unwrap();

        push_from_another_clone(&top, &remote_url, "remote-side.txt");

        // 本地没提交、只是落后：push 被拒后应当自动快进再重推成功。
        // 注意本地没 fetch 过，behind 这会儿还是 0，所以这一步只能靠
        // push 失败去触发拉取，不能拿 behind 当闸门
        let after = push_remote(&repo).unwrap();
        assert_eq!((after.ahead, after.behind), (0, 0));
        // 比 trim 后的内容：本机 core.autocrlf 会把检出时的 LF 变成 CRLF
        assert_eq!(
            fs::read_to_string(repo.join("remote-side.txt"))
                .unwrap()
                .trim(),
            "r"
        );

        cleanup(&top);
    }

    #[test]
    fn push_fails_and_keeps_the_history_when_the_branch_has_diverged() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let remote_url = bare_remote(&top).to_string_lossy().to_string();
        assert!(git(&repo, &["remote", "add", "origin", &remote_url]));

        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        push_remote(&repo).unwrap();

        push_from_another_clone(&top, &remote_url, "remote-side.txt");

        // 本地也提交一个，自动重试里的 ff-only pull 必然失败
        fs::write(repo.join("local-side.txt"), "l\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "local side").unwrap();
        let head_before = status_of(&repo).unwrap().head;

        // 断言"失败了"和"HEAD 没动"就够了：报错文案是 git 自己的，会随版本和
        // 语言环境变，照着某句英文去断言会在别人的机器上挂掉
        let error = push_remote(&repo).unwrap_err();
        assert!(!error.trim().is_empty());
        assert_eq!(status_of(&repo).unwrap().head, head_before);
        // 没有被带进合并状态，也没有凭空多出一条提交
        assert_eq!(log_filtered(&repo, 5, None, None).unwrap().len(), 2);

        cleanup(&top);
    }

    // ---- 忽略判定 ----

    #[test]
    fn reports_only_paths_that_git_actually_ignores() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);

        fs::write(repo.join(".gitignore"), "ignored.txt\nbuild/\n*.log\n").unwrap();
        fs::write(repo.join("kept.txt"), "k\n").unwrap();
        fs::write(repo.join("ignored.txt"), "i\n").unwrap();
        fs::create_dir(repo.join("build")).unwrap();
        fs::write(repo.join("build").join("out.bin"), "b\n").unwrap();
        fs::write(repo.join("kept.log"), "l\n").unwrap();
        // 强行跟踪一个匹配规则的文件：进过 index 之后 git 就不认为它被忽略了
        assert!(git(&repo, &["add", "-f", "kept.log"]));

        let build = repo.join("build").to_string_lossy().to_string();
        let listed = vec![
            path_of_file(&repo, "kept.txt"),
            path_of_file(&repo, "ignored.txt"),
            path_of_file(&repo, ".gitignore"),
            build.clone(),
            path_of_file(&repo, "kept.log"),
        ];
        let ignored = ignored_paths(&repo, &listed).unwrap();

        assert!(ignored.contains(&path_of_file(&repo, "ignored.txt")));
        // 目录规则 `build/` 只有带上尾斜杠才匹配得上
        assert!(ignored.contains(&build));
        assert!(!ignored.contains(&path_of_file(&repo, "kept.txt")));
        assert!(!ignored.contains(&path_of_file(&repo, ".gitignore")));
        // 已跟踪的不算忽略，这正是「不带 --no-index」的意义
        assert!(!ignored.contains(&path_of_file(&repo, "kept.log")));

        cleanup(&top);
    }

    #[test]
    fn ignore_check_is_empty_outside_a_repository() {
        // 不是仓库时 check-ignore 非 0 退出，应当安静地给空结果——文件树照样能用
        let (_state, repo, top) = temp_repo();
        fs::write(repo.join("a.txt"), "a\n").unwrap();

        let ignored = ignored_paths(&repo, &[path_of_file(&repo, "a.txt")]).unwrap();
        assert!(ignored.is_empty());

        cleanup(&top);
    }

    // ---- 加入 .gitignore ----

    #[test]
    fn escapes_characters_that_would_change_meaning() {
        // 通配符和反斜杠不转义会匹配到别的文件
        assert_eq!(escape_gitignore("a[1].txt"), "a\\[1\\].txt");
        assert_eq!(escape_gitignore("star*.txt"), "star\\*.txt");
        assert_eq!(escape_gitignore("back\\slash"), "back\\\\slash");
        // 行首的注释 / 取反标记要转义，出现在中间就没有特殊含义了
        assert_eq!(escape_gitignore("#note"), "\\#note");
        assert_eq!(escape_gitignore("!keep"), "\\!keep");
        assert_eq!(escape_gitignore("a#b!c"), "a#b!c");
        // 行尾空格会被 gitignore 吃掉，转义才留得住
        assert_eq!(escape_gitignore("trail "), "trail\\ ");
    }

    #[test]
    fn appends_a_file_and_a_directory_rule() {
        let (_state, repo, top) = temp_repo();
        fs::write(repo.join("app.log"), "l\n").unwrap();
        fs::create_dir(repo.join("build")).unwrap();

        add_to_ignore(&repo, &path_of_file(&repo, "app.log")).unwrap();
        add_to_ignore(&repo, &path_of_file(&repo, "build")).unwrap();

        // 规则一律正斜杠；目录带尾斜杠，只匹配目录
        assert_eq!(read_text(&repo.join(".gitignore")), "app.log\nbuild/\n");

        cleanup(&top);
    }

    #[test]
    fn does_not_append_a_rule_twice() {
        let (_state, repo, top) = temp_repo();
        fs::write(repo.join("app.log"), "l\n").unwrap();

        add_to_ignore(&repo, &path_of_file(&repo, "app.log")).unwrap();
        add_to_ignore(&repo, &path_of_file(&repo, "app.log")).unwrap();

        assert_eq!(read_text(&repo.join(".gitignore")), "app.log\n");

        cleanup(&top);
    }

    #[test]
    fn treats_a_trailing_slash_as_the_same_rule() {
        let (_state, repo, top) = temp_repo();
        fs::create_dir(repo.join("build")).unwrap();
        // 手写的规则没有尾斜杠，但说的就是这个目录，不该再写一条
        fs::write(repo.join(".gitignore"), "build\n").unwrap();

        add_to_ignore(&repo, &path_of_file(&repo, "build")).unwrap();

        assert_eq!(read_text(&repo.join(".gitignore")), "build\n");

        cleanup(&top);
    }

    #[test]
    fn appends_after_a_file_without_a_final_newline() {
        let (_state, repo, top) = temp_repo();
        fs::write(repo.join(".gitignore"), "dist").unwrap();
        fs::write(repo.join("app.log"), "l\n").unwrap();

        add_to_ignore(&repo, &path_of_file(&repo, "app.log")).unwrap();

        // 不补换行的话两条规则会粘成 `distapp.log`
        assert_eq!(read_text(&repo.join(".gitignore")), "dist\napp.log\n");

        cleanup(&top);
    }

    #[test]
    fn the_written_rule_is_honored_by_git() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("app.log"), "l\n").unwrap();
        fs::create_dir(repo.join("build")).unwrap();
        fs::write(repo.join("build").join("out.bin"), "b\n").unwrap();

        add_to_ignore(&repo, &path_of_file(&repo, "app.log")).unwrap();
        add_to_ignore(&repo, &path_of_file(&repo, "build")).unwrap();

        let listed = vec![path_of_file(&repo, "app.log"), path_of_file(&repo, "build")];
        let ignored = ignored_paths(&repo, &listed).unwrap();
        assert!(ignored.contains(&path_of_file(&repo, "app.log")));
        // 目录规则要能被 check-ignore 认出来（尾斜杠的写法必须对得上）
        assert!(ignored.contains(&path_of_file(&repo, "build")));

        cleanup(&top);
    }

    // ---- 合并：分叉、冲突、中止、完成 ----

    #[test]
    fn merge_creates_a_merge_commit_when_the_branch_has_diverged() {
        if !git_available() {
            return;
        }
        let (repo, top, _remote_url) = diverged_repo("remote-side.txt");

        let after = merge_upstream(&repo).unwrap();
        assert!(!after.merging);
        assert_eq!(after.conflicts, 0);
        // init + 远程那条 + 本地那条 + 合并提交本身
        assert_eq!(log_filtered(&repo, 5, None, None).unwrap().len(), 4);
        assert_eq!((after.ahead, after.behind), (2, 0));
        assert!(repo.join("remote-side.txt").exists());
        assert!(repo.join("local-side.txt").exists());

        cleanup(&top);
    }

    #[test]
    fn merge_fast_forwards_when_only_behind() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        let remote_url = bare_remote(&top).to_string_lossy().to_string();
        assert!(git(&repo, &["remote", "add", "origin", &remote_url]));

        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        push_remote(&repo).unwrap();

        push_from_another_clone(&top, &remote_url, "from-other.txt");

        // 本地没有自己的提交：应当快进，不该凭空多一个合并提交（没加 --no-ff）
        let after = merge_upstream(&repo).unwrap();
        assert_eq!((after.ahead, after.behind), (0, 0));
        assert_eq!(log_filtered(&repo, 5, None, None).unwrap().len(), 2);
        assert!(repo.join("from-other.txt").exists());

        cleanup(&top);
    }

    #[test]
    fn merge_stops_in_conflict_and_reports_merging() {
        if !git_available() {
            return;
        }
        let (repo, top, _head_before) = conflicted_repo();

        // 冲突不是"失败"：返回 Ok，靠 merging 表达"等用户解决"
        let after = status_of(&repo).unwrap();
        assert!(after.merging);
        assert!(after.conflicts >= 1);
        assert!(is_merging(&repo).unwrap());
        // 冲突期间没有产生提交
        assert_eq!(log_filtered(&repo, 5, None, None).unwrap().len(), 2);
        assert!(read_text(&repo.join("app.ts")).contains("<<<<<<<"));

        cleanup(&top);
    }

    #[test]
    fn merge_abort_returns_to_the_pre_merge_state() {
        if !git_available() {
            return;
        }
        let (repo, top, head_before) = conflicted_repo();

        let after = merge_abort(&repo).unwrap();
        assert!(!after.merging);
        assert_eq!(after.conflicts, 0);
        assert!(!is_merging(&repo).unwrap());
        assert_eq!(after.head, head_before);
        assert_eq!(log_filtered(&repo, 5, None, None).unwrap().len(), 2);
        // 冲突标记被清掉，文件回到本地那一版
        assert_eq!(read_text(&repo.join("app.ts")).trim(), "local");

        cleanup(&top);
    }

    #[test]
    fn merge_abort_is_a_noop_outside_a_merge() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        let head_before = status_of(&repo).unwrap().head;

        // 没有合并可中止时不该报错，也不该动 HEAD
        let after = merge_abort(&repo).unwrap();
        assert!(!after.merging);
        assert_eq!(after.head, head_before);

        cleanup(&top);
    }

    #[test]
    fn merge_continue_refuses_while_conflicts_remain() {
        if !git_available() {
            return;
        }
        let (repo, top, _head_before) = conflicted_repo();

        // 冲突没解决就想提交：git 自己会拒绝。只断言"失败了 + 还在合并中 + 没多提交"
        let error = merge_continue(&repo).unwrap_err();
        assert!(!error.trim().is_empty());
        assert!(is_merging(&repo).unwrap());
        assert_eq!(log_filtered(&repo, 5, None, None).unwrap().len(), 2);

        cleanup(&top);
    }

    #[test]
    fn merge_continue_commits_the_resolved_merge() {
        if !git_available() {
            return;
        }
        let (repo, top, _head_before) = conflicted_repo();

        // 解决冲突：写一版结果并暂存，再让 git 用 MERGE_MSG 提交
        fs::write(repo.join("app.ts"), "resolved\n").unwrap();
        stage_paths(&repo, &None).unwrap();

        let after = merge_continue(&repo).unwrap();
        assert!(!after.merging);
        assert_eq!(after.conflicts, 0);
        // init + 远程那条 + 本地那条 + 合并提交本身
        assert_eq!(log_filtered(&repo, 5, None, None).unwrap().len(), 4);
        assert_eq!((after.ahead, after.behind), (2, 0));
        assert_eq!(read_text(&repo.join("app.ts")).trim(), "resolved");

        cleanup(&top);
    }

    // ---- 冲突解决：接受某一侧 / 保留两者 ----

    #[test]
    fn resolve_conflict_ours_keeps_the_local_side() {
        if !git_available() {
            return;
        }
        let (repo, top, _head_before) = conflicted_repo();
        let path = path_of_file(&repo, "app.ts");

        let after = resolve_conflict(&repo, &path, &ConflictChoice::Ours).unwrap();
        // ours = 本地（HEAD）那一侧；标记文件被换成纯内容并 add 进 index
        assert_eq!(read_text(&repo.join("app.ts")).trim(), "local");
        assert_eq!(after.conflicts, 0);
        // 冲突解决 ≠ 收尾：仓库仍处在"进行中的合并"里，等 --continue
        assert!(after.merging);

        cleanup(&top);
    }

    #[test]
    fn resolve_conflict_theirs_keeps_the_incoming_side() {
        if !git_available() {
            return;
        }
        let (repo, top, _head_before) = conflicted_repo();
        let path = path_of_file(&repo, "app.ts");

        let after = resolve_conflict(&repo, &path, &ConflictChoice::Theirs).unwrap();
        assert_eq!(read_text(&repo.join("app.ts")).trim(), "remote");
        assert_eq!(after.conflicts, 0);

        cleanup(&top);
    }

    #[test]
    fn resolve_conflict_both_keeps_both_sides_without_markers() {
        if !git_available() {
            return;
        }
        let (repo, top, _head_before) = conflicted_repo();
        let path = path_of_file(&repo, "app.ts");

        let after = resolve_conflict(&repo, &path, &ConflictChoice::Both).unwrap();
        let text = read_text(&repo.join("app.ts"));
        assert!(!text.contains("<<<<<<<"));
        assert!(!text.contains("======="));
        assert!(!text.contains(">>>>>>>"));
        assert!(text.contains("local"));
        assert!(text.contains("remote"));
        assert_eq!(after.conflicts, 0);

        cleanup(&top);
    }

    #[test]
    fn resolve_conflict_refuses_a_file_without_conflict_markers() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("app.ts"), "plain\n").unwrap();
        let path = path_of_file(&repo, "app.ts");

        // 普通文件没有冲突块，"保留两者"要给清楚的报错而不是静默成功
        let error = resolve_conflict(&repo, &path, &ConflictChoice::Both).unwrap_err();
        assert!(error.contains("冲突标记"));

        cleanup(&top);
    }

    #[test]
    fn combine_conflict_markers_handles_multiple_blocks_and_no_final_newline() {
        // 两个冲突块 + 中间一段公共内容
        let text = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\nmid\n<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> other";
        // theirs 段的行带着它自己的换行，后面紧跟 `>>>>>>>`，所以结果以 `d\n` 收尾
        assert_eq!(combine_conflict_markers(text).unwrap(), "a\nb\nmid\nc\nd\n");

        // diff3 风格多一段 `|||||||` 基线，整段丢掉
        let text = "<<<<<<< HEAD\na\n||||||| base\nbase\n=======\nb\n>>>>>>> other\n";
        assert_eq!(combine_conflict_markers(text).unwrap(), "a\nb\n");

        // 最后一个冲突块之后的公共内容没有尾换行，也要原样保住
        let text = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\ntail";
        assert_eq!(combine_conflict_markers(text).unwrap(), "a\nb\ntail");

        // 没有冲突标记：报错
        assert!(combine_conflict_markers("plain\n").is_err());
        // 标记不配对（缺 `>>>>>>>`）：报错
        assert!(combine_conflict_markers("<<<<<<< HEAD\na\n=======\nb\n").is_err());
    }

    #[test]
    fn merge_then_push_succeeds() {
        if !git_available() {
            return;
        }
        let (repo, top, _remote_url) = diverged_repo("remote-side.txt");

        merge_upstream(&repo).unwrap();
        let after = push_remote(&repo).unwrap();
        assert_eq!((after.ahead, after.behind), (0, 0));
        assert!(!after.merging);

        cleanup(&top);
    }

    #[test]
    fn merge_without_an_upstream_is_refused() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("app.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        let head_before = status_of(&repo).unwrap().head;

        // 没有上游就没有可合并的分支，得在 fetch 之前就拦住
        let error = merge_upstream(&repo).unwrap_err();
        assert!(!error.trim().is_empty());
        assert_eq!(status_of(&repo).unwrap().head, head_before);

        cleanup(&top);
    }

    // ---- 增删行数 ----

    #[test]
    fn numstat_parses_plain_renames_and_binary() {
        let parsed = parse_numstat(&output(&["2\t1\tsrc/a.ts"]));
        assert_eq!(parsed, vec![("src/a.ts".to_string(), Some(2), Some(1))]);

        // 重命名：路径字段是空的，后面另跟旧、新两个 token，取新路径
        let parsed = parse_numstat(&output(&["0\t0\t", "old.txt", "new.txt"]));
        assert_eq!(parsed, vec![("new.txt".to_string(), Some(0), Some(0))]);

        // 二进制两列都是 `-`，转成 None（界面上不显示，别显示成 0）
        let parsed = parse_numstat(&output(&["-\t-\tlogo.png"]));
        assert_eq!(parsed, vec![("logo.png".to_string(), None, None)]);
    }

    #[test]
    fn numstat_counts_skip_paths_outside_a_nested_workspace() {
        // 工作区只是仓库的 sub/ 时，git 仍会报仓库里别处的改动
        let raw = output(&["1\t0\tsub/inside.txt", "1\t0\tsubber.txt", "1\t0\telsewhere.txt"]);
        let counts = counts_by_path(&raw, "sub/");
        assert_eq!(counts.len(), 1);
        assert_eq!(counts.get("inside.txt"), Some(&(Some(1), Some(0))));
    }

    #[test]
    fn numstat_counts_match_non_utf8_paths() {
        // 路径含非法 UTF-8 字节（0xff）时，status 与 numstat 两侧都走
        // `String::from_utf8_lossy`，同一串字节换出同一个替换串，因此计数能对上。
        // 钉住这个结论：将来谁把某一侧改成按原始字节做键，这里会先炸
        let mut status_raw = Vec::new();
        status_raw.extend_from_slice(b"1 M. N... 100644 100644 100644 aaaa bbbb bad");
        status_raw.push(0xff);
        status_raw.extend_from_slice(b".txt");
        status_raw.push(0);

        let mut numstat_raw = Vec::new();
        numstat_raw.extend_from_slice(b"3\t1\tbad");
        numstat_raw.push(0xff);
        numstat_raw.extend_from_slice(b".txt");
        numstat_raw.push(0);

        let status = parse_status(&status_raw, "", &workspace());
        assert_eq!(status.files.len(), 1);
        let file = &status.files[0];

        let counts = counts_by_path(&numstat_raw, "");
        assert_eq!(
            counts.get(&file.relative),
            Some(&(Some(3), Some(1))),
            "非 UTF-8 路径的行数应当能落到文件上（relative = {:?}）",
            file.relative
        );
    }

    #[test]
    fn status_reports_added_and_removed_lines() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("app.ts"), "a\nb\nc\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        // 未暂存：改了 1 行、加了 2 行
        fs::write(repo.join("app.ts"), "a\nB\nc\nd\ne\n").unwrap();
        let status = status_of(&repo).unwrap();
        let file = &status.files[0];
        assert_eq!((file.unstaged_added, file.unstaged_removed), (Some(3), Some(1)));
        // 暂存区还没动，这一侧不该有数字
        assert_eq!((file.staged_added, file.staged_removed), (None, None));

        // 暂存之后再问：这次落在暂存那一侧
        stage_paths(&repo, &None).unwrap();
        let status = status_of(&repo).unwrap();
        let file = &status.files[0];
        assert_eq!((file.staged_added, file.staged_removed), (Some(3), Some(1)));
        assert_eq!((file.unstaged_added, file.unstaged_removed), (None, None));

        cleanup(&top);
    }

    #[test]
    fn untracked_files_get_no_line_counts() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("brandnew.txt"), "x\n").unwrap();
        // 未跟踪的文件 numstat 看不见它，计数只能是 None——界面上显示成「?」
        let status = status_of(&repo).unwrap();
        assert_eq!(status.files.len(), 1);
        let file = &status.files[0];
        assert_eq!(
            (file.staged_added, file.unstaged_added),
            (None, None)
        );
        cleanup(&top);
    }

    #[test]
    fn status_without_counts_skips_line_counts() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("app.ts"), "a\nb\nc\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        fs::write(repo.join("app.ts"), "a\nB\nc\nd\ne\n").unwrap();

        // with_counts=false（轮询时「变更」面板没开）：条目还在，但不跑 numstat，行数全 None
        let lean = status_of_with_counts(&repo, false).unwrap();
        assert_eq!(lean.files.len(), 1);
        let file = &lean.files[0];
        assert_eq!(
            (file.unstaged_added, file.unstaged_removed),
            (None, None)
        );

        // 同一个工作区，要行数时照常拿到
        let full = status_of_with_counts(&repo, true).unwrap();
        let file = &full.files[0];
        assert_eq!((file.unstaged_added, file.unstaged_removed), (Some(3), Some(1)));

        cleanup(&top);
    }

    // ---- 修正 / 撤销提交 ----

    #[test]
    fn amend_folds_the_index_into_the_last_commit() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let first = commit_staged(&repo, "first").unwrap().head.unwrap();

        fs::write(repo.join("a.txt"), "1\n2\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let amended = amend_commit(&repo, Some("first (fixed)")).unwrap();

        assert_ne!(amended.head.as_deref(), Some(first.as_str()), "提交号该变了");
        assert!(amended.files.is_empty(), "改动已经被并进提交里，列表该空了");
        // 还是只有一条提交，`--amend` 不是新加一条
        let count = run_git(&repo, &["rev-list", "--count", "HEAD"]).unwrap().unwrap();
        assert_eq!(String::from_utf8_lossy(&count).trim(), "1");
        // 提交信息也换成新的了
        let subject = run_git(&repo, &["log", "-1", "--format=%s"]).unwrap().unwrap();
        assert_eq!(String::from_utf8_lossy(&subject).trim(), "first (fixed)");

        // 不带信息时沿用原来那条
        fs::write(repo.join("a.txt"), "1\n2\n3\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        amend_commit(&repo, None).unwrap();
        let subject = run_git(&repo, &["log", "-1", "--format=%s"]).unwrap().unwrap();
        assert_eq!(String::from_utf8_lossy(&subject).trim(), "first (fixed)");

        cleanup(&top);
    }

    #[test]
    fn amend_without_message_rejects_empty_index() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "first").unwrap();

        // 暂存区空 + 不给信息：`--amend --no-edit` 是 no-op，git 照样 0 退出，
        // 得由我们报错，别让界面误报「成功」
        let err = amend_commit(&repo, None).unwrap_err();
        assert!(err.contains("没有要修正的内容"), "实际: {err}");

        // 只改提交信息：暂存区空但给了 -m，允许（不是 no-op）
        let amended = amend_commit(&repo, Some("first (renamed)")).unwrap();
        assert!(amended.files.is_empty());
        let subject = run_git(&repo, &["log", "-1", "--format=%s"]).unwrap().unwrap();
        assert_eq!(String::from_utf8_lossy(&subject).trim(), "first (renamed)");

        // 有暂存改动 + 不给信息：正常 amend（沿用原信息）
        fs::write(repo.join("a.txt"), "1\n2\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let amended = amend_commit(&repo, None).unwrap();
        assert!(amended.files.is_empty());
        let subject = run_git(&repo, &["log", "-1", "--format=%s"]).unwrap().unwrap();
        assert_eq!(String::from_utf8_lossy(&subject).trim(), "first (renamed)");

        cleanup(&top);
    }

    #[test]
    fn undo_commit_keeps_the_changes_staged() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let first = commit_staged(&repo, "first").unwrap().head.unwrap();

        fs::write(repo.join("b.txt"), "x\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "second").unwrap();

        let undone = undo_commit(&repo).unwrap();
        assert_eq!(undone.head.as_deref(), Some(first.as_str()), "HEAD 该退回上一条");
        // --soft：改动留在暂存区，工作区不动
        let added = undone
            .files
            .iter()
            .find(|file| file.relative == "b.txt")
            .expect("b.txt 该回到改动列表里");
        assert_eq!((added.index, added.worktree), ('A', '.'));
        assert!(repo.join("b.txt").exists(), "工作区文件不该被删");

        cleanup(&top);
    }

    #[test]
    fn undo_the_only_commit_returns_to_an_unborn_branch() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "only").unwrap();

        // 唯一一条提交没有父提交可以退，得走 update-ref 那条路
        let undone = undo_commit(&repo).unwrap();
        assert!(undone.head.is_none(), "该回到「还没提交过」的状态");
        assert_eq!(undone.files.len(), 1);
        assert_eq!((undone.files[0].index, undone.files[0].worktree), ('A', '.'));

        cleanup(&top);
    }

    #[test]
    fn undo_is_refused_on_a_detached_head() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let first = commit_staged(&repo, "first").unwrap().head.unwrap();

        // 游离在唯一那条提交上：HEAD~1 不存在，会走到 update-ref 那条路。
        // 实测那条命令会把 `.git/HEAD` 文件删掉、仓库变成 not a git repository，
        // 所以必须在这里就被挡住
        assert!(git(&repo, &["checkout", "--detach", &first]));
        let error = undo_commit(&repo).unwrap_err();
        assert!(error.contains("游离"), "{error}");
        // 仓库还是好的
        assert!(repo_prefix(&repo).unwrap().is_some(), "仓库不该被搞坏");
        assert!(repo.join(".git/HEAD").exists(), ".git/HEAD 不该被删掉");

        cleanup(&top);
    }

    #[test]
    fn undo_in_an_empty_repository_says_there_is_nothing_to_undo() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        // 空仓库：`rev-parse --abbrev-ref HEAD` 会输出字面量 HEAD 并非 0 退出，
        // 和游离 HEAD 撞在一起。这两条检查的先后顺序决定了用户看到哪句话
        let error = undo_commit(&repo).unwrap_err();
        assert!(error.contains("还没有提交"), "{error}");

        cleanup(&top);
    }

    // ---- 分支 ----

    #[test]
    fn branch_list_marks_the_current_one_and_creates_switches() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        let list = branches_of(&repo).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "main");
        assert!(list[0].current);
        assert_eq!(list[0].upstream, None, "还没推过，没有上游");

        let created = create_branch(&repo, "feature/x").unwrap();
        assert_eq!(created.branch.as_deref(), Some("feature/x"));
        let list = branches_of(&repo).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|item| item.name == "main" && !item.current));
        assert!(list.iter().any(|item| item.name == "feature/x" && item.current));

        let switched = switch_branch(&repo, "main").unwrap();
        assert_eq!(switched.branch.as_deref(), Some("main"));

        // 以 - 开头会被 git 当成选项，必须自己挡掉；带空格的不是合法分支名
        assert!(switch_branch(&repo, "-bad").is_err());
        assert!(create_branch(&repo, "bad name").is_err());
        assert!(create_branch(&repo, "").is_err());

        cleanup(&top);
    }

    #[test]
    fn switching_to_a_branch_checked_out_in_another_worktree_is_explained() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        assert!(git(&repo, &["branch", "feat/x"]));

        // 把 feat/x 在另一个 worktree 里检出——之后 git 就不许别处再切它
        let wt = top.join("repo-wt");
        assert!(
            git(&repo, &["worktree", "add", wt.to_str().unwrap(), "feat/x"]),
            "git worktree add 失败"
        );

        // 分支列表要标出它被哪个工作树占用
        let list = branches_of(&repo).unwrap();
        let feat = list.iter().find(|item| item.name == "feat/x").unwrap();
        assert!(!feat.current);
        let owner = feat.worktree.as_deref().expect("应标出占用它的工作树");
        assert!(same_dir(owner, wt.to_str().unwrap()), "实际占用者：{owner}");

        // 直接切会被友好地拦下（中文 + 分支名），而不是抛英文 fatal
        let err = switch_branch(&repo, "feat/x").unwrap_err();
        assert!(err.contains("已被工作树"), "实际：{err}");
        assert!(err.contains("feat/x"), "实际：{err}");

        cleanup(&top);
    }

    /// 目录被外部删掉（没跑 prune）留下的 prunable 记录不该再占着分支——否则分支列表
    /// 会提前拦下切换，而那条记录又切不过去（目录都没了），用户被堵死。清理后才真正释放。
    #[test]
    fn a_deleted_worktree_stops_owning_its_branch_and_can_be_pruned() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        assert!(git(&repo, &["branch", "feat/x"]));

        let wt = top.join("repo-wt");
        assert!(
            git(&repo, &["worktree", "add", wt.to_str().unwrap(), "feat/x"]),
            "git worktree add 失败"
        );

        // 目录还在：分支列表标出占用者
        let list = branches_of(&repo).unwrap();
        assert!(
            list.iter()
                .find(|item| item.name == "feat/x")
                .unwrap()
                .worktree
                .is_some()
        );

        // 手动删目录（不跑 prune）：git 会留下一条 prunable 记录
        fs::remove_dir_all(&wt).unwrap();
        let list = branches_of(&repo).unwrap();
        assert!(
            list.iter()
                .find(|item| item.name == "feat/x")
                .unwrap()
                .worktree
                .is_none(),
            "目录已删除的工作树不该再占用分支"
        );

        // 列表里仍能看出它是失效记录（供前端给「清理」入口）
        let wts = worktrees_of(&repo, &state).unwrap();
        let stale = wts
            .iter()
            .find(|item| same_dir(&item.path, wt.to_str().unwrap()))
            .expect("应留下失效记录");
        assert!(!stale.exists && stale.prunable, "应为 prunable 且目录不存在");

        // prune 之后记录消失，分支占用随之释放
        run_git_checked(&repo, &["worktree", "prune"]).unwrap();
        let wts = worktrees_of(&repo, &state).unwrap();
        assert!(
            wts.iter()
                .all(|item| !same_dir(&item.path, wt.to_str().unwrap())),
            "prune 后不该再有这条记录"
        );

        cleanup(&top);
    }

    /// 概览要逐条标注每个工作树脏不脏、在哪个分支上。这里造一个「干净的主工作树 +
    /// 有未提交改动的工作树」，断言汇总能分别标出来，且口径和 status 一致。
    #[test]
    fn worktree_statuses_summarize_each_worktree() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();
        assert!(git(&repo, &["branch", "feat/x"]));

        let wt = top.join("repo-wt");
        assert!(
            git(&repo, &["worktree", "add", wt.to_str().unwrap(), "feat/x"]),
            "git worktree add 失败"
        );
        // 在别的工作树里留一处未提交改动
        fs::write(wt.join("dirty.txt"), "wip\n").unwrap();

        let list = worktree_statuses_of(&repo, &state).unwrap();
        let main = list
            .iter()
            .find(|item| same_dir(&item.path, repo.to_str().unwrap()))
            .expect("主工作树应在列表里");
        assert_eq!(main.branch.as_deref(), Some("main"));
        assert_eq!(main.changed, 0, "主工作树是干净的");
        assert!(!main.merging);

        let other = list
            .iter()
            .find(|item| same_dir(&item.path, wt.to_str().unwrap()))
            .expect("另一个工作树应在列表里");
        assert_eq!(other.branch.as_deref(), Some("feat/x"));
        assert_eq!(other.changed, 1, "未跟踪的新文件要算进改动数");
        assert_eq!(other.conflicts, 0);
        assert!(!other.merging);

        cleanup(&top);
    }

    #[test]
    fn branch_list_reports_upstream_and_divergence() {
        if !git_available() {
            return;
        }
        let (repo, top, _url) = diverged_repo("from-remote.txt");
        // 不 fetch 的话 behind 还是陈旧的
        fetch_remote(&repo).unwrap();

        let list = branches_of(&repo).unwrap();
        let main = list.iter().find(|item| item.name == "main").unwrap();
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert_eq!((main.ahead, main.behind), (1, 1));
        assert!(!main.gone);

        cleanup(&top);
    }

    #[test]
    fn switching_branches_replaces_the_working_tree() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("on-main.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        create_branch(&repo, "feature").unwrap();
        // 在 feature 上另提交一个文件
        fs::write(repo.join("on-feature.txt"), "2\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "feature work").unwrap();
        assert!(repo.join("on-feature.txt").exists());

        // 切回 main：feature 上那个文件该从工作区消失（这正是要提醒用户的地方）
        switch_branch(&repo, "main").unwrap();
        assert!(repo.join("on-main.txt").exists());
        assert!(
            !repo.join("on-feature.txt").exists(),
            "切分支该把工作区换成那条分支的内容"
        );

        cleanup(&top);
    }

    // ---- 标签 ----

    #[test]
    fn tag_list_distinguishes_lightweight_and_annotated() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        let head = commit_staged(&repo, "init").unwrap().head.unwrap();
        let short = head[..7].to_string();

        // 没有标签时是空数组，不是错误
        assert!(tags_of(&repo).unwrap().is_empty());

        create_tag(&repo, "light", None, None).unwrap();
        create_tag(&repo, "annot", Some("附注说明"), None).unwrap();

        let tags = tags_of(&repo).unwrap();
        assert_eq!(tags.len(), 2);

        let light = tags.iter().find(|tag| tag.name == "light").unwrap();
        assert!(!light.annotated, "轻量标签不该被标成附注");
        // 轻量标签的 objectname 就是它直接指向的提交
        assert_eq!(light.target, short);
        assert!(light.message.is_empty(), "轻量标签不该带说明");

        let annot = tags.iter().find(|tag| tag.name == "annot").unwrap();
        assert!(annot.annotated);
        // 附注标签的 objectname 是 tag 对象本身，target 必须取 peeled 才指向提交
        assert_eq!(annot.target, short);
        assert_eq!(annot.message, "附注说明");

        // 删掉之后列表里就没了
        delete_tag(&repo, "light").unwrap();
        let remaining = tags_of(&repo).unwrap();
        let names: Vec<&str> = remaining.iter().map(|tag| tag.name.as_str()).collect();
        assert_eq!(names, vec!["annot"]);

        cleanup(&top);
    }

    // ---- stash ----

    #[test]
    fn stash_round_trips_through_push_and_pop() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(repo.join("a.txt"), "1\n2\n").unwrap();
        let pushed = stash_push(&repo, Some("wip")).unwrap();
        assert!(pushed.files.is_empty(), "收进 stash 之后工作区该干净了");

        let list = stashes_of(&repo).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].index, 0);
        assert!(list[0].message.contains("wip"), "{}", list[0].message);
        assert_eq!(list[0].hash.len(), 40);

        let popped = stash_pop(&repo, 0).unwrap();
        assert_eq!(popped.files.len(), 1);
        assert!(stashes_of(&repo).unwrap().is_empty(), "pop 之后记录该没了");
        // 内容原样回来（抹平行尾，本机 autocrlf 会改行尾）
        assert_eq!(read_text(&repo.join("a.txt")), "1\n2\n");

        cleanup(&top);
    }

    #[test]
    fn stash_apply_keeps_the_record_while_drop_removes_it() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("a.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        fs::write(repo.join("a.txt"), "1\n2\n").unwrap();
        stash_push(&repo, None).unwrap();

        let applied = stash_apply(&repo, 0).unwrap();
        assert_eq!(applied.files.len(), 1);
        assert_eq!(stashes_of(&repo).unwrap().len(), 1, "apply 不该删记录");

        // drop 只删记录，工作区里的改动留着
        let dropped = stash_drop(&repo, 0).unwrap();
        assert!(stashes_of(&repo).unwrap().is_empty());
        assert_eq!(dropped.files.len(), 1, "drop 不动工作区");

        cleanup(&top);
    }

    #[test]
    fn stash_push_leaves_untracked_files_alone() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("tracked.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        // 一个改动 + 一个未跟踪的新文件
        fs::write(repo.join("tracked.txt"), "1\n2\n").unwrap();
        fs::write(repo.join("brandnew.txt"), "x\n").unwrap();
        let pushed = stash_push(&repo, None).unwrap();

        // 未跟踪的那个不参与 stash，仍在工作区里（默认语义，也免得文件突然消失）
        assert!(
            repo.join("brandnew.txt").exists(),
            "未跟踪文件不该被收走"
        );
        assert_eq!(pushed.files.len(), 1);
        assert_eq!(pushed.files[0].relative, "brandnew.txt");

        cleanup(&top);
    }

    #[test]
    fn stash_push_reports_a_no_op_instead_of_succeeding_silently() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("tracked.txt"), "1\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        // 只剩未跟踪文件：git 打印 "No local changes to save" 但**以 0 退出**。
        // 不判这一下的话界面会以为成功，实际什么都没发生
        fs::write(repo.join("brandnew.txt"), "x\n").unwrap();
        let error = stash_push(&repo, Some("空的")).unwrap_err();
        assert!(error.contains("没有可以储藏"), "{error}");
        assert!(stashes_of(&repo).unwrap().is_empty(), "不该凭空多出一条");
        assert!(repo.join("brandnew.txt").exists(), "工作区也不该被动");

        // 工作区完全干净时同理
        fs::remove_file(repo.join("brandnew.txt")).unwrap();
        assert!(stash_push(&repo, None).is_err());

        cleanup(&top);
    }

    /// 按 `%x1f` 分隔字段、`%x00` 结尾的真实形态拼一条提交记录
    fn log_record(fields: &[&str]) -> Vec<u8> {
        let mut raw = fields.join("\u{1f}").into_bytes();
        raw.push(0);
        raw
    }

    #[test]
    fn parses_parents_and_decorations_from_log() {
        let mut raw = log_record(&[
            "aaaa",
            "a1",
            "张三",
            "1700000000",
            "bbbb cccc",
            "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/tags/v1.0",
            "主题 带 空格",
            "- 正文第一行\n- 正文第二行\n",
        ]);
        // 第二条：无装饰、根提交（没有父）。记录之间那个 `\n` 是 git 自己插的，
        // 必须剥掉，否则会粘到下一条的 `%H` 上、父 hash 匹配不上
        raw.push(b'\n');
        raw.extend(log_record(&["bbbb", "b1", "李四", "1699990000", "", "", "根提交", ""]));

        let commits = parse_log(&raw);
        assert_eq!(commits.len(), 2);

        let first = &commits[0];
        assert_eq!(first.hash, "aaaa");
        assert_eq!(first.parents, vec!["bbbb", "cccc"]);
        // 主题里的空格不能被当成字段分隔符
        assert_eq!(first.subject, "主题 带 空格");
        // 正文是多行的，末尾的换行要剥掉
        assert_eq!(first.body, "- 正文第一行\n- 正文第二行");
        let refs: Vec<(&str, &str)> = first
            .refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str()))
            .collect();
        assert_eq!(
            refs,
            vec![("main", "head"), ("origin/main", "remote"), ("v1.0", "tag")]
        );

        let root = &commits[1];
        assert_eq!(root.hash, "bbbb");
        assert!(root.parents.is_empty());
        assert!(root.refs.is_empty());
        assert!(root.body.is_empty(), "没有正文时是空串，不是缺字段");
    }

    #[test]
    fn commit_stat_counts_files_and_lines() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("a.txt"), "1\n2\n3\n").unwrap();
        fs::write(repo.join("b.txt"), "x\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "init").unwrap();

        let rev = log_filtered(&repo, 1, None, None).unwrap()[0].hash.clone();
        let stat = stat_of(&repo, &rev).unwrap();
        assert_eq!(stat.files, 2);
        assert_eq!(stat.insertions, 4);
        assert_eq!(stat.deletions, 0);

        cleanup(&top);
    }

    #[test]
    fn decorations_fall_back_to_short_names() {
        // 万一某版 git 的 %D 给的是短名（不受 --decorate=full 影响）
        let refs = parse_decorations("HEAD -> main, origin/main, tag: v1.0");
        let pairs: Vec<(&str, &str)> = refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![("main", "head"), ("origin/main", "remote"), ("v1.0", "tag")]
        );
    }

    #[test]
    fn decorations_strip_refs_tags_prefix_in_full_form() {
        // --decorate=full 下标签是全名（`tag: refs/tags/v1.0`），`tag: ` 后面还得再剥一层，
        // 否则 chip 会显示成 refs/tags/v1.0
        let refs = parse_decorations(
            "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0",
        );
        let pairs: Vec<(&str, &str)> = refs
            .iter()
            .map(|r| (r.name.as_str(), r.kind.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![("main", "head"), ("origin/main", "remote"), ("v1.0", "tag")]
        );
    }

    #[test]
    fn reads_clone_percent() {
        assert_eq!(parse_percent("Receiving objects:  45% (45/100)"), Some(45));
        assert_eq!(
            parse_percent("Resolving deltas: 100% (10/10), done."),
            Some(100)
        );
        assert_eq!(parse_percent("Cloning into 'x'..."), None);
        // 超过 100 也封顶
        assert_eq!(parse_percent("Receiving objects: 250%"), Some(100));
    }

    #[test]
    fn names_clone_phase() {
        assert_eq!(
            clone_phase("Receiving objects:  45% (45/100)"),
            "Receiving objects"
        );
        assert_eq!(clone_phase("Cloning into 'x'..."), "Cloning into 'x'...");
    }

    #[test]
    fn derives_repo_name_from_urls() {
        assert_eq!(derive_repo_name("https://github.com/foo/bar.git"), "bar");
        assert_eq!(derive_repo_name("https://github.com/foo/bar/"), "bar");
        assert_eq!(derive_repo_name("git@github.com:foo/bar.git"), "bar");
        assert_eq!(derive_repo_name("https://host/foo/bar"), "bar");
        assert_eq!(derive_repo_name("   "), "");
    }

    #[test]
    fn parses_worktree_list() {
        // 覆盖分支 / 游离 / locked / prunable 四种记录，外加首行的 BOM
        let raw = concat!(
            "\u{feff}worktree C:/repo\n",
            "HEAD 1234567890abcdef\n",
            "branch refs/heads/main\n",
            "\n",
            "worktree C:/repo-detached\n",
            "HEAD 1234567890abcdef\n",
            "detached\n",
            "\n",
            "worktree C:/repo-locked\n",
            "HEAD 1234567890abcdef\n",
            "branch refs/heads/feat\n",
            "locked working on it\n",
            "\n",
            "worktree C:/repo-gone\n",
            "HEAD 1234567890abcdef\n",
            "branch refs/heads/old\n",
            "prunable gitdir file points to non-existent location\n",
        );
        let items = parse_worktrees(raw);
        assert_eq!(items.len(), 4, "BOM 不该让第一条丢匹配");

        assert_eq!(items[0].path, "C:/repo");
        assert_eq!(items[0].branch.as_deref(), Some("main"));
        assert!(!items[0].detached && !items[0].locked && !items[0].prunable);

        assert!(items[1].detached);
        assert_eq!(items[1].branch, None);

        assert!(items[2].locked);
        assert_eq!(items[2].lock_reason.as_deref(), Some("working on it"));
        assert_eq!(items[2].branch.as_deref(), Some("feat"));

        assert!(items[3].prunable);
        assert_eq!(
            items[3].prune_reason.as_deref(),
            Some("gitdir file points to non-existent location")
        );
    }

    #[test]
    fn parses_a_bare_worktree() {
        let raw = "worktree C:/repo.git\nHEAD 1234567890abcdef\nbare\n";
        let items = parse_worktrees(raw);
        assert_eq!(items.len(), 1);
        assert!(items[0].bare);
        assert_eq!(items[0].branch, None);
    }

    #[test]
    fn no_worktrees_parses_to_empty() {
        assert!(parse_worktrees("").is_empty());
    }

    #[test]
    fn same_dir_ignores_case_and_separators() {
        assert!(same_dir("C:/Repo/Main", "c:\\repo\\main"));
        assert!(!same_dir("C:/repo", "C:/repo/other"));
    }

    #[test]
    fn initializes_a_plain_directory_on_main_and_is_idempotent() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        // 还没 init：状态就是"不是仓库"，界面上那个按钮正是照它冒出来的
        assert!(!status_of(&repo).unwrap().is_repo);

        let after = init_git_repo(&repo).unwrap();
        assert!(after.is_repo);
        // 分支名由 `-b main` 定死，不受本机 init.defaultBranch 影响
        assert_eq!(after.branch.as_deref(), Some("main"));

        // 幂等：已经有历史之后再跑一次不报错，HEAD 也不动
        assert!(git(&repo, &["config", "user.email", "codovo@test"]));
        assert!(git(&repo, &["config", "user.name", "codovo"]));
        fs::write(repo.join("a.ts"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "first").unwrap();
        let head = status_of(&repo).unwrap().head;
        assert!(head.is_some());

        assert!(init_git_repo(&repo).unwrap().is_repo);
        assert_eq!(status_of(&repo).unwrap().head, head);

        cleanup(&top);
    }

    // ---- 比较任意两个提交 / 与分支比较 ----

    #[test]
    fn compare_files_lists_changes_between_two_commits() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        // 第一个提交：base + a
        fs::write(repo.join("base.txt"), "base\n").unwrap();
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "one").unwrap();
        let first = run_git(&repo, &["rev-parse", "HEAD"]).unwrap().unwrap();
        let first = String::from_utf8_lossy(&first).trim().to_string();

        // 第二个提交：改 a、新增 b
        fs::write(repo.join("a.txt"), "a2\n").unwrap();
        fs::write(repo.join("b.txt"), "b\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "two").unwrap();
        let second = run_git(&repo, &["rev-parse", "HEAD"]).unwrap().unwrap();
        let second = String::from_utf8_lossy(&second).trim().to_string();

        let files = compare_files(&repo, &first, &second).unwrap();
        let listed: Vec<&str> = files.iter().map(|file| file.relative.as_str()).collect();
        assert!(listed.contains(&"a.txt"), "a.txt 应出现: {listed:?}");
        assert!(listed.contains(&"b.txt"), "b.txt 应出现: {listed:?}");
        // base.txt 两次提交之间没动，不该混进来
        assert!(!listed.contains(&"base.txt"), "未改动的文件不该出现: {listed:?}");

        // 反向比较：从后往前看，b.txt 是删除、a.txt 仍是修改
        let files = compare_files(&repo, &second, &first).unwrap();
        assert_eq!(
            files.iter().find(|file| file.relative == "b.txt").map(|file| file.status),
            Some('D')
        );

        // from 与 to 相同时没有差异，返回空列表而不是报错
        assert!(compare_files(&repo, &first, &first).unwrap().is_empty());

        cleanup(&top);
    }

    #[test]
    fn workstream_list_sees_worktree_and_branch_only() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("base.txt"), "base\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "base").unwrap();

        // 工作树里再提交一次，模拟 agent 的产物
        let wt = top.join("wt-demo");
        let wt_text = wt.to_string_lossy().to_string();
        assert!(git(
            &repo,
            &["worktree", "add", "-q", "-b", "agent/demo", &wt_text, "main"]
        ));
        fs::write(wt.join("feature.txt"), "feature\n").unwrap();
        assert!(git(&wt, &["add", "-A"]));
        assert!(git(&wt, &["commit", "-q", "-m", "agent change"]));

        // 只建分支、不建工作树的那一类
        assert!(git(&repo, &["branch", "agent/orphan", "main"]));
        assert!(git(&repo, &["switch", "-q", "agent/orphan"]));
        fs::write(repo.join("orphan.txt"), "orphan\n").unwrap();
        assert!(git(&repo, &["add", "-A"]));
        assert!(git(&repo, &["commit", "-q", "-m", "orphan change"]));
        assert!(git(&repo, &["switch", "-q", "main"]));

        let items = workstreams_of(&repo, &state).unwrap();
        let demo = items
            .iter()
            .find(|item| item.branch.as_deref() == Some("agent/demo"))
            .expect("工作树应该出现在清单里");
        assert_eq!(demo.kind, "worktree");
        assert_eq!(demo.base.as_deref(), Some("main"));
        assert_eq!(demo.ahead, 1);
        assert!(!demo.merged);
        assert_eq!(demo.diff_files, 1);
        assert_eq!(demo.additions, 1);
        assert_eq!(demo.changed, 0);

        let orphan = items
            .iter()
            .find(|item| item.branch.as_deref() == Some("agent/orphan"))
            .expect("未检出分支应该出现在清单里");
        assert_eq!(orphan.kind, "branch");
        assert_eq!(orphan.ahead, 1);
        assert!(orphan.path.is_empty());

        // 审阅数据：基准到 head 的提交和文件都要能拿到
        let review = review_of(&repo, Some(&wt), Some("agent/demo"), Some("main")).unwrap();
        assert_eq!(review.branch, "agent/demo");
        assert_eq!(review.commits.len(), 1);
        assert_eq!(review.files.len(), 1);
        assert_eq!(review.files[0].relative, "feature.txt");

        cleanup(&top);
    }

    #[test]
    fn workstream_merge_merges_agent_branch_into_clean_main() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("base.txt"), "base\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "base").unwrap();

        let wt = top.join("wt-merge");
        let wt_text = wt.to_string_lossy().to_string();
        assert!(git(
            &repo,
            &["worktree", "add", "-q", "-b", "agent/merge", &wt_text, "main"]
        ));
        fs::write(wt.join("feature.txt"), "feature\n").unwrap();
        assert!(git(&wt, &["add", "-A"]));
        assert!(git(&wt, &["commit", "-q", "-m", "agent change"]));
        let head = run_git(&repo, &["rev-parse", "agent/merge"])
            .unwrap()
            .unwrap();
        let head = String::from_utf8_lossy(&head).trim().to_string();

        let status = merge_workstream(&repo, "agent/merge", Some("main")).unwrap();
        assert_eq!(status.changed, 0);
        assert!(is_ancestor(&repo, &head, "main"));

        let items = workstreams_of(&repo, &state).unwrap();
        let merged = items
            .iter()
            .find(|item| item.branch.as_deref() == Some("agent/merge"))
            .expect("合并后的工作树仍在清单里");
        assert!(merged.merged);

        cleanup(&top);
    }

    #[test]
    fn workstream_create_makes_worktree_under_dot_worktrees() {
        if !git_available() {
            return;
        }
        let (state, repo, top) = temp_repo();
        init_repo_on_main(&repo);
        fs::write(repo.join("base.txt"), "base\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "base").unwrap();

        let items = create_workstream(&repo, &state, "agent/new", Some("main".to_string())).unwrap();
        let created = items
            .iter()
            .find(|item| item.branch.as_deref() == Some("agent/new"))
            .expect("新建分支应该出现在清单里");
        assert_eq!(created.kind, "worktree");
        assert!(created.exists);
        assert!(Path::new(&created.path).is_dir());
        // 统一建在仓库内的 .worktrees/ 下
        assert!(created
            .path
            .replace('\\', "/")
            .contains("/repo/.worktrees/agent-new"));
        // 并且写进本地 exclude，主工作区不该多出未跟踪目录
        let exclude = fs::read_to_string(repo.join(".git/info/exclude")).unwrap_or_default();
        assert!(exclude.lines().any(|line| line.trim() == ".worktrees/"));

        cleanup(&top);
    }

    #[test]
    fn resolve_commit_accepts_refs_and_rejects_junk() {
        if !git_available() {
            return;
        }
        let (_state, repo, top) = temp_repo();
        init_repo(&repo);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        stage_paths(&repo, &None).unwrap();
        commit_staged(&repo, "one").unwrap();
        let head = run_git(&repo, &["rev-parse", "HEAD"]).unwrap().unwrap();
        let head = String::from_utf8_lossy(&head).trim().to_string();

        // 当前分支名、HEAD、短 hash 都该解析到同一个提交（分支名不写死，
        // 免得依赖本机 init.defaultBranch 是 main 还是 master）
        let branch = run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().unwrap();
        let branch = String::from_utf8_lossy(&branch).trim().to_string();
        assert_eq!(resolve_commit(&repo, &branch).unwrap(), head);
        assert_eq!(resolve_commit(&repo, "HEAD").unwrap(), head);
        assert_eq!(resolve_commit(&repo, &head[..7]).unwrap(), head);

        // 乱串 / 空串一律报错，不能悄悄解成别的提交
        assert!(resolve_commit(&repo, "no-such-ref").is_err());
        assert!(resolve_commit(&repo, "   ").is_err());

        cleanup(&top);
    }
}
