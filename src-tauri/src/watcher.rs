use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::fs_api::{is_skipped_dir, simplify};

/// 前端监听的事件名。载荷是「内容变了、需要重新列一遍」的目录绝对路径。
pub const CHANGED_EVENT: &str = "fs-changed";

/// 文件内容变了（终端、git、别的编辑器、智能体写的），载荷是这些文件的绝对路径。
/// 和 `CHANGED_EVENT` 分开：那个是给文件树重列用的，这个是给编辑器重读用的；
/// 合成一条的话，编辑器每存一次盘都要把整棵树刷一遍。
pub const FILE_CHANGED_EVENT: &str = "fs-file-changed";

/// 攒多久才发一次。解包/切换分支会连着打出几百个事件，逐个发会把 IPC 打爆，
/// 而文件树要的只是"最终长什么样"，中间态没有意义。
const DEBOUNCE: Duration = Duration::from_millis(300);

/// 防抖通道里跑的东西：要么是「这个目录要重列」，要么是「这个文件内容变了」。
enum Signal {
    Dir(PathBuf),
    File(PathBuf),
    /// 换工作区，让防抖线程收摊
    Stop,
}

/// 各窗口的目录监听，**按窗口 label 分片**：一个窗口一份。关窗或换根时只换自己的。
pub struct WatchState {
    inner: Mutex<HashMap<String, Watch>>,
}

struct Watch {
    /// 持有它才在监听，丢了监听就停了
    _watcher: RecommendedWatcher,
    /// 给防抖线程发信号，`Stop` 表示让它退出
    stop: Sender<Signal>,
}

impl WatchState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 监听本窗口 `root` 下的目录结构变化。调用方拿不到监听器也不该影响正常使用，
    /// 所以出错只返回 Err 让上面忽略。
    ///
    /// 事件定向发给 `label` 对应的窗口：多窗口下广播会让别的窗口收到不属于自己的
    /// 变更，进而去重列一个它根本不显示的工作区。
    pub fn watch(&self, app: AppHandle, label: &str, root: &Path) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Signal>();
        let event_tx = tx.clone();
        let event_root = root.to_path_buf();

        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            let Ok(event) = result else {
                // 监听本身出问题（缓冲溢出等）不该把界面搞崩，丢一轮即可
                return;
            };
            if should_refresh(&event.kind, &event.paths) {
                for dir in changed_dirs(&event_root, &event.paths) {
                    let _ = event_tx.send(Signal::Dir(dir));
                }
            }
            // 内容变了的文件：不挑事件类型，靠"现在是不是一个真实文件"兜底。
            // 各平台的保存姿势不一样（直接写、原子替换、inotify 的 CLOSE_WRITE），
            // 按事件类型逐个枚举迟早会漏，代价只是多几次 is_file。
            for file in changed_files(&event_root, &event.paths) {
                if file.is_file() {
                    let _ = event_tx.send(Signal::File(file));
                }
            }
        })
        .map_err(|e| format!("启动目录监听失败: {e}"))?;

        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| format!("监听目录失败 {}: {e}", root.display()))?;

        let emitter = app.clone();
        let target = label.to_string();
        std::thread::spawn(move || {
            // 攒批：收到第一个事件后，一直吃到静默满 DEBOUNCE 为止再发
            while let Ok(first) = rx.recv() {
                if matches!(first, Signal::Stop) {
                    return;
                }
                let mut dirs: HashSet<PathBuf> = HashSet::new();
                let mut files: HashSet<PathBuf> = HashSet::new();
                // 第一个事件也要算进去，所以先存下来、进循环再归位
                let mut pending = first;
                loop {
                    match pending {
                        Signal::Stop => return,
                        Signal::Dir(dir) => {
                            dirs.insert(dir);
                        }
                        Signal::File(file) => {
                            files.insert(file);
                        }
                    }
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(next) => pending = next,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                if !dirs.is_empty() {
                    let _ = emitter.emit_to(&target, CHANGED_EVENT, sorted_paths(dirs));
                }
                if !files.is_empty() {
                    let _ = emitter.emit_to(&target, FILE_CHANGED_EVENT, sorted_paths(files));
                }
            }
        });

        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        // 换工作区：先停本窗口的旧监听——丢掉 watcher 就停了，再让防抖线程收到
        // Stop 退出，否则旧根目录上的事件会继续发给已经切换过去的界面。
        // 只动自己这个 label：别的窗口的监听与这次切换无关。
        if let Some(old) = inner.insert(
            label.to_string(),
            Watch {
                _watcher: watcher,
                stop: tx,
            },
        ) {
            let _ = old.stop.send(Signal::Stop);
        }
        Ok(())
    }

    /// 关窗时停掉这个窗口的监听
    pub fn stop(&self, label: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(old) = inner.remove(label) {
                let _ = old.stop.send(Signal::Stop);
            }
        }
    }

    /// 应用退出时兜底：把所有窗口的防抖线程叫停
    pub fn stop_all(&self) {
        // 先取出 label 列表再逐个停，别持着锁去调 stop（它会再取一次锁）
        let labels: Vec<String> = match self.inner.lock() {
            Ok(inner) => inner.keys().cloned().collect(),
            Err(_) => return,
        };
        for label in labels {
            self.stop(&label);
        }
    }
}

/// 排序只为让同样的变更给出同样的载荷，方便日志和测试比对
fn sorted_paths(paths: HashSet<PathBuf>) -> Vec<String> {
    let mut list: Vec<String> = paths
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    list.sort();
    list
}

/// 这次事件该不该让文件树重列。
///
/// 一般只认"目录结构"变化——改动文件内容（编辑器保存）不影响文件树。但
/// `.gitignore` 是例外：条目置灰用的忽略状态就是按它算的，改完得跟着重列，
/// 否则用户刚把某个目录加进忽略名单，界面却毫无反应。
fn should_refresh(kind: &EventKind, paths: &[PathBuf]) -> bool {
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => true,
        EventKind::Modify(ModifyKind::Data(_)) => {
            paths.iter().any(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == ".gitignore")
            })
        }
        _ => false,
    }
}

/// 事件路径 -> 需要重新列一遍的目录（也就是它的父目录）。
fn changed_dirs(root: &Path, paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for raw in paths {
        let path = simplify(raw.clone());
        if !is_relevant(root, &path) {
            continue;
        }
        if let Some(parent) = path.parent() {
            out.push(parent.to_path_buf());
        }
    }
    out
}

/// 事件路径 -> 内容可能变了的文件（就是它自己）。这里只做"该不该关心"的清洗，
/// 是不是真的文件由调用方现查磁盘——事件到达时它可能已经被删了。
fn changed_files(root: &Path, paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for raw in paths {
        let path = simplify(raw.clone());
        if is_relevant(root, &path) {
            out.push(path);
        }
    }
    out
}

/// 这个事件路径值不值得关心：在 root 里，且不落在 `node_modules` / `target` 这类
/// 重目录**里面**。那些目录动辄几万个文件，构建一次就能把界面刷爆，而且它们本来
/// 也不是用户手动组织的结构。重目录**自己**算关心（新建一个 `dist` 得能在树里
/// 出现、内容也得能读），所以判据是"除去最后一段之后"还有没有重目录名。
fn is_relevant(root: &Path, path: &Path) -> bool {
    if path == root {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        // 事件落在工作区外（根目录被改名/删掉时会这样），不关我们的事
        return false;
    };
    let mut parts: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_string())
        .collect();
    // 最后一段是变化目标本身，不算"在重目录里面"
    parts.pop();
    !parts.iter().any(|part| is_skipped_dir(part))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 路径一律从 root 拼出来，不手写分隔符：`\` 在 Unix 上只是普通字符，
    /// 写死 `D:\ws` 会让 strip_prefix 直接落空——测试看着绿，其实什么都没验。
    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from("D:\\ws")
        } else {
            PathBuf::from("/ws")
        }
    }

    /// root 下的路径，如 `under(&["src", "main.rs"])`
    fn under(parts: &[&str]) -> PathBuf {
        parts.iter().fold(root(), |acc, part| acc.join(part))
    }

    #[test]
    fn maps_a_change_to_its_parent_directory() {
        let dirs = changed_dirs(&root(), &[under(&["src", "main.rs"])]);
        assert_eq!(dirs, vec![under(&["src"])]);
    }

    #[test]
    fn skips_changes_inside_heavy_directories() {
        assert!(changed_dirs(&root(), &[under(&["target", "debug", "app.exe"])]).is_empty());
        assert!(changed_dirs(&root(), &[under(&["node_modules", "pkg", "index.js"])]).is_empty());
        // 大小写不敏感
        assert!(changed_dirs(&root(), &[under(&["TARGET", "a"])]).is_empty());
    }

    #[test]
    fn maps_a_content_change_to_the_file_itself() {
        let file = under(&["src", "main.rs"]);
        assert_eq!(
            changed_files(&root(), std::slice::from_ref(&file)),
            vec![file]
        );
    }

    #[test]
    fn skips_content_changes_inside_heavy_directories() {
        // 构建一次会往 target 里写几千个文件，全发给编辑器等于每次都重读一遍
        assert!(changed_files(&root(), &[under(&["target", "debug", "app.exe"])]).is_empty());
        assert!(changed_files(&root(), &[under(&["node_modules", "pkg", "index.js"])]).is_empty());
        // 重目录自己不是文件，交给调用方的 is_file 挡掉
        assert_eq!(
            changed_files(&root(), &[under(&["dist"])]),
            vec![under(&["dist"])]
        );
    }

    #[test]
    fn still_reports_a_heavy_directory_being_created() {
        let dirs = changed_dirs(&root(), &[under(&["dist"])]);
        assert_eq!(dirs, vec![root()], "重目录自己出现时要刷新它所在的目录");
    }

    #[test]
    fn ignores_the_root_itself_and_anything_outside() {
        assert!(changed_dirs(&root(), &[root()]).is_empty());
        // 工作区外：换根目录而不是换盘符，Unix 上才拼得出来
        let outside = if cfg!(windows) {
            PathBuf::from("D:\\elsewhere\\a.txt")
        } else {
            PathBuf::from("/elsewhere/a.txt")
        };
        assert!(changed_dirs(&root(), &[outside]).is_empty());
    }

    #[test]
    fn refreshes_on_structure_changes_but_not_on_content_edits() {
        use notify::event::{CreateKind, DataChange, RemoveKind, RenameMode};

        let file = under(&["src", "main.rs"]);
        let content = EventKind::Modify(ModifyKind::Data(DataChange::Content));

        assert!(should_refresh(
            &EventKind::Create(CreateKind::File),
            &[file.clone()]
        ));
        assert!(should_refresh(
            &EventKind::Remove(RemoveKind::File),
            &[file.clone()]
        ));
        assert!(should_refresh(
            &EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            &[file.clone()]
        ));
        // 编辑器保存正文不影响文件树
        assert!(!should_refresh(&content, &[file]));
    }

    #[test]
    fn refreshes_when_gitignore_changes() {
        use notify::event::DataChange;

        // 忽略状态是按 .gitignore 算的，它被改写就得跟着重列
        assert!(should_refresh(
            &EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            &[under(&[".gitignore"])]
        ));
    }

    // `\\?\` 前缀是 Windows 独有的形态，Unix 上它只是普通文件名，剥前缀那套逻辑无从触发
    #[cfg(windows)]
    #[test]
    fn strips_the_windows_verbatim_prefix() {
        // notify 在 Windows 上可能给出 `\\?\` 前缀，不剥掉就拼不上工作区根
        let dirs = changed_dirs(&root(), &[PathBuf::from(r"\\?\D:\ws\a.txt")]);
        assert_eq!(dirs, vec![root()]);
    }
}
