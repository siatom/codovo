use std::collections::HashSet;
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

/// 攒多久才发一次。解包/切换分支会连着打出几百个事件，逐个发会把 IPC 打爆，
/// 而文件树要的只是"最终长什么样"，中间态没有意义。
const DEBOUNCE: Duration = Duration::from_millis(300);

/// 当前工作区的目录监听。换工作区时整体换掉。
pub struct WatchState {
    inner: Mutex<Option<Watch>>,
}

struct Watch {
    /// 持有它才在监听，丢了监听就停了
    _watcher: RecommendedWatcher,
    /// 给防抖线程发信号，`None` 表示让它退出
    stop: Sender<Option<PathBuf>>,
}

impl WatchState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// 监听 `root` 下的目录结构变化。调用方拿不到监听器也不该影响正常使用，
    /// 所以出错只返回 Err 让上面忽略。
    pub fn watch(&self, app: AppHandle, root: &Path) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Option<PathBuf>>();
        let event_tx = tx.clone();
        let event_root = root.to_path_buf();

        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            let Ok(event) = result else {
                // 监听本身出问题（缓冲溢出等）不该把界面搞崩，丢一轮即可
                return;
            };
            // 只关心"目录结构"变化：改动文件内容（编辑器保存）不影响文件树
            if !matches!(
                event.kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(ModifyKind::Name(_))
            ) {
                return;
            }
            for dir in changed_dirs(&event_root, &event.paths) {
                let _ = event_tx.send(Some(dir));
            }
        })
        .map_err(|e| format!("启动目录监听失败: {e}"))?;

        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| format!("监听目录失败 {}: {e}", root.display()))?;

        let emitter = app.clone();
        std::thread::spawn(move || {
            // 攒批：收到第一个事件后，一直吃到静默满 DEBOUNCE 为止再发
            while let Ok(first) = rx.recv() {
                let Some(first) = first else { return };
                let mut dirs: HashSet<PathBuf> = HashSet::new();
                dirs.insert(first);
                loop {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(Some(dir)) => {
                            dirs.insert(dir);
                        }
                        Ok(None) => return,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                let mut list: Vec<String> = dirs
                    .into_iter()
                    .map(|dir| dir.to_string_lossy().to_string())
                    .collect();
                // 排序只为让同样的变更给出同样的载荷，方便日志和测试比对
                list.sort();
                let _ = emitter.emit(CHANGED_EVENT, list);
            }
        });

        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        // 换工作区：先停旧的——丢掉 watcher 就停了，再让防抖线程收到 None 退出，
        // 否则旧根目录上的事件会继续发给已经切换过去的界面
        if let Some(old) = inner.take() {
            let _ = old.stop.send(None);
        }
        *inner = Some(Watch {
            _watcher: watcher,
            stop: tx,
        });
        Ok(())
    }
}

/// 事件路径 -> 需要重新列一遍的目录（也就是它的父目录）。
///
/// 跳过 `node_modules` / `target` 这类重目录**里面**的任何变化：那些目录动辄
/// 几万个文件，构建一次就能把界面刷爆，而且它们本来也不是用户手动组织的结构。
/// 但重目录**自己**被建出来时要放行，否则新建一个 `dist` 会在文件树里消失。
fn changed_dirs(root: &Path, paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for raw in paths {
        let path = simplify(raw.clone());
        if path == root {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            // 事件落在工作区外（根目录被改名/删掉时会这样），不关文件树的事
            continue;
        };
        let mut parts: Vec<String> = relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy().to_string())
            .collect();
        // 最后一段是变化目标本身，不算"在重目录里面"
        parts.pop();
        if parts.iter().any(|part| is_skipped_dir(part)) {
            continue;
        }
        if let Some(parent) = path.parent() {
            out.push(parent.to_path_buf());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("D:\\ws")
    }

    #[test]
    fn maps_a_change_to_its_parent_directory() {
        let dirs = changed_dirs(&root(), &[PathBuf::from("D:\\ws\\src\\main.rs")]);
        assert_eq!(dirs, vec![PathBuf::from("D:\\ws\\src")]);
    }

    #[test]
    fn skips_changes_inside_heavy_directories() {
        assert!(changed_dirs(&root(), &[PathBuf::from("D:\\ws\\target\\debug\\app.exe")]).is_empty());
        assert!(changed_dirs(&root(), &[PathBuf::from("D:\\ws\\node_modules\\pkg\\index.js")]).is_empty());
        // 大小写不敏感
        assert!(changed_dirs(&root(), &[PathBuf::from("D:\\ws\\TARGET\\a")]).is_empty());
    }

    #[test]
    fn still_reports_a_heavy_directory_being_created() {
        let dirs = changed_dirs(&root(), &[PathBuf::from("D:\\ws\\dist")]);
        assert_eq!(dirs, vec![root()], "重目录自己出现时要刷新它所在的目录");
    }

    #[test]
    fn ignores_the_root_itself_and_anything_outside() {
        assert!(changed_dirs(&root(), &[PathBuf::from("D:\\ws")]).is_empty());
        assert!(changed_dirs(&root(), &[PathBuf::from("D:\\elsewhere\\a.txt")]).is_empty());
    }

    #[test]
    fn strips_the_windows_verbatim_prefix() {
        // notify 在 Windows 上可能给出 `\\?\` 前缀，不剥掉就拼不上工作区根
        let dirs = changed_dirs(&root(), &[PathBuf::from(r"\\?\D:\ws\a.txt")]);
        assert_eq!(dirs, vec![root()]);
    }
}
