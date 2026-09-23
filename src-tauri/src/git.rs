use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

use crate::fs_api::FsState;

/// git 卡住时的兜底（网络盘、超大仓库）。超时只作废这一次查询，
/// 前端继续显示上一次的状态，界面不会被拖住。
const TIMEOUT: Duration = Duration::from_secs(5);

/// 单次回传的条目上限。正常项目远到不了这个量级，设上限是防止异常仓库
/// （比如刚 clone 下来、.gitignore 还没写）把 IPC 和渲染拖垮。
const MAX_ENTRIES: usize = 4000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// 绝对路径（原生分隔符），和文件树里的 path 同一套写法
    path: String,
    /// porcelain v2 的 XY 两列：X 是暂存区状态，Y 是工作区状态
    index: char,
    worktree: char,
}

#[derive(Serialize)]
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

/// 跑一条 git 子命令。
///
/// `Err` 表示 git 根本没跑起来（没装、超时），调用方据此停掉轮询；
/// `Ok(None)` 表示命令跑了但退出码非 0（比如目录不是仓库），属于正常情况。
fn run_git(dir: &Path, args: &[&str]) -> Result<Option<Vec<u8>>, String> {
    let mut command = Command::new("git");
    command
        // 不抢 index.lock：轮询用的 status 不该把用户自己的 git 命令挡在门外
        .arg("--no-optional-locks")
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

    match receiver.recv_timeout(TIMEOUT) {
        Ok(Ok(output)) if output.status.success() => Ok(Some(output.stdout)),
        Ok(Ok(_)) => Ok(None),
        Ok(Err(reason)) => Err(format!("无法执行 git: {reason}")),
        Err(_) => Err(format!("git 响应超时（{} 秒）", TIMEOUT.as_secs())),
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
        let relative = relative
            .trim_end_matches('/')
            .replace('/', std::path::MAIN_SEPARATOR_STR);
        if relative.is_empty() {
            continue;
        }

        status.changed += 1;
        if status.files.len() < MAX_ENTRIES {
            status.files.push(FileStatus {
                path: root.join(&relative).to_string_lossy().to_string(),
                index: xy.0,
                worktree: xy.1,
            });
        }
    }

    status
}

#[tauri::command(async)]
pub fn git_status(state: tauri::State<'_, FsState>) -> Result<GitStatus, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
}
