use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
/// 持续写入没有静默窗口，也要定期通知前端，不能一直等到任务结束。
const MAX_BATCH_DELAY: Duration = Duration::from_secs(1);

/// 防抖通道里跑的东西：要么是「这个目录要重列」，要么是「这个文件内容变了」。
enum Signal {
    Dir(PathBuf),
    File(PathBuf),
    /// 换工作区，让防抖线程收摊
    Stop,
}

/// 当前工作区的目录监听。切工作区时整体换掉。
///
/// 一个工作区可能挂多个工作目录，所以这里是一**组**根、而不是一个：每个根各有一套
/// 监听和防抖线程，否则后加的根会把先加的顶掉，文件树只有最后一根是活的。
pub struct WatchState {
    /// 连根一起记着：关闭工作区时要据此判断该不该停，别停了别人的
    current: Mutex<Vec<(PathBuf, Watch)>>,
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
            current: Mutex::new(Vec::new()),
        }
    }

    /// 盯着这一组根（一个工作区的全部工作目录）。
    ///
    /// 整体替换当前监听：切工作区时旧的逐个停掉，免得旧根目录上的事件继续发给已经切
    /// 过去的界面。单个根起不来（目录被删了等）只跳过它，不妨碍其余根。
    pub fn watch_roots(&self, app: AppHandle, roots: &[PathBuf]) {
        let fresh: Vec<(PathBuf, Watch)> = roots
            .iter()
            .filter_map(|root| {
                start_watch(&app, root)
                    .ok()
                    .map(|item| (root.clone(), item))
            })
            .collect();

        let Ok(mut inner) = self.current.lock() else {
            return;
        };
        for (_, old) in inner.drain(..) {
            let _ = old.stop.send(Signal::Stop);
        }
        *inner = fresh;
    }

    /// 关窗、退出时停掉全部监听（防抖线程收到 Stop 就退出）
    pub fn stop(&self) {
        if let Ok(mut inner) = self.current.lock() {
            for (_, old) in inner.drain(..) {
                let _ = old.stop.send(Signal::Stop);
            }
        }
    }

    /// 关掉某一根的监听。**不在当前监听集合里的根什么都不做**——
    /// 否则关掉一个后台工作区会把当前工作区的文件树刷新一起停掉。
    pub fn stop_if(&self, root: &Path) {
        if let Ok(mut inner) = self.current.lock() {
            let mut kept = Vec::with_capacity(inner.len());
            for (watched, watch) in inner.drain(..) {
                if watched == root {
                    let _ = watch.stop.send(Signal::Stop);
                } else {
                    kept.push((watched, watch));
                }
            }
            *inner = kept;
        }
    }
}

/// 为一根建一套监听：notify 的 watcher + 一个攒批的防抖线程。
///
/// 拆出来是因为一个工作区可能挂多个根——每组各自持有自己的 `event_root` 做归属过滤，
/// 共用一个 watcher 的话就分不清事件落在哪个根上了。
fn start_watch(app: &AppHandle, root: &Path) -> Result<Watch, String> {
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
        // 内容变了的文件：删除 / 改名也要发，否则前端永远收不到「文件没了」，
        // 标签上的「已删除」状态不可达。其余事件仍靠"现在是不是一个真实文件"兜底：
        // 各平台的保存姿势不一样（直接写、原子替换、inotify 的 CLOSE_WRITE），
        // 按事件类型逐个枚举迟早会漏，代价只是多几次 is_file。
        for file in changed_files(&event_root, &event.paths) {
            if should_emit_file(&event.kind, &file) {
                let _ = event_tx.send(Signal::File(file));
            }
        }
    })
    .map_err(|e| format!("启动目录监听失败: {e}"))?;

    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败 {}: {e}", root.display()))?;

    let emitter = app.clone();
    std::thread::spawn(move || {
        collect_batches(rx, |dirs, files| {
            if !dirs.is_empty() {
                let _ = emitter.emit(CHANGED_EVENT, sorted_paths(dirs));
            }
            if !files.is_empty() {
                let _ = emitter.emit(FILE_CHANGED_EVENT, sorted_paths(files));
            }
        });
    });

    Ok(Watch {
        _watcher: watcher,
        stop: tx,
    })
}

/// 静默防抖和最大等待共同约束一批；单独抽出，便于直接验证持续事件流和退出。
fn collect_batches(rx: Receiver<Signal>, mut emit: impl FnMut(HashSet<PathBuf>, HashSet<PathBuf>)) {
    while let Ok(first) = rx.recv() {
        let deadline = Instant::now() + MAX_BATCH_DELAY;
        let mut dirs = HashSet::new();
        let mut files = HashSet::new();
        let mut pending = first;
        let mut disconnected = false;
        loop {
            match pending {
                // 换根或退出后不再向旧界面发事件，仍保留原来的取消语义。
                Signal::Stop => return,
                Signal::Dir(dir) => {
                    dirs.insert(dir);
                }
                Signal::File(file) => {
                    files.insert(file);
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(DEBOUNCE.min(remaining)) {
                Ok(next) => pending = next,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    // 所有生产者退出时仍发完尾批；显式 Stop 则直接取消。
                    disconnected = true;
                    break;
                }
            }
        }
        emit(dirs, files);
        if disconnected {
            return;
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
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => {
            true
        }
        EventKind::Modify(ModifyKind::Data(_)) => paths.iter().any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == ".gitignore")
        }),
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

/// 这个事件路径要不要作为「文件内容变了」发给编辑器。
///
/// 删除 / 改名必须发：事件到达时路径已经不在磁盘上，不能再用 `is_file` 过滤，
/// 否则前端永远收不到「文件被删了」。目录路径也会被发出去，前端拿
/// `pathsPresent` 复核后自然匹配不到文件标签。其余事件仍只认真实文件。
fn should_emit_file(kind: &EventKind, path: &Path) -> bool {
    match kind {
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => true,
        _ => path.is_file(),
    }
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

    #[test]
    fn sustained_events_flush_before_the_stream_stops_and_keep_the_tail() {
        let (tx, rx) = mpsc::channel();
        let (batch_tx, batches) = mpsc::channel();
        let started = Instant::now();
        let worker = std::thread::spawn(move || {
            collect_batches(rx, |_, files| {
                batch_tx.send((started.elapsed(), files)).unwrap();
            });
        });
        // 超过十秒的真实持续流：每个间隔都短于静默防抖，旧实现直到结束才发。
        let producer = std::thread::spawn(move || {
            for i in 0..105 {
                tx.send(Signal::File(PathBuf::from(format!("file-{i}"))))
                    .unwrap();
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let allowance = MAX_BATCH_DELAY + Duration::from_millis(750);
        let (first_at, first) = batches
            .recv_timeout(allowance)
            .expect("持续流必须定期发出首批");
        assert!(first_at <= allowance);
        let mut all = first;
        let mut previous = first_at;
        let mut count = 1;
        for (at, files) in batches {
            assert!(at - previous <= allowance, "批次间隔超出最大延迟及调度余量");
            previous = at;
            all.extend(files);
            count += 1;
        }
        producer.join().unwrap();
        worker.join().unwrap();
        assert!(count >= 8, "持续事件流不应合成单一大批次");
        assert_eq!(all.len(), 105, "包括最后的尾批在内，所有路径都必须送达");
    }

    #[test]
    fn short_bursts_are_deduplicated_and_flushed_after_silence() {
        let (tx, rx) = mpsc::channel();
        let (batch_tx, batches) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            collect_batches(rx, |dirs, files| {
                batch_tx.send((dirs, files)).unwrap();
            });
        });
        for _ in 0..3 {
            tx.send(Signal::Dir(PathBuf::from("src"))).unwrap();
            tx.send(Signal::File(PathBuf::from("src/main.rs"))).unwrap();
        }
        let (dirs, files) = batches.recv_timeout(MAX_BATCH_DELAY).unwrap();
        assert_eq!(sorted_paths(dirs), ["src"]);
        assert_eq!(sorted_paths(files), ["src/main.rs"]);
        tx.send(Signal::Stop).unwrap();
        worker.join().unwrap();
        assert!(batches.try_recv().is_err(), "短突发只能产生一批");
    }

    #[test]
    fn stop_cancels_a_pending_batch_without_waiting_for_the_deadline() {
        let (tx, rx) = mpsc::channel();
        tx.send(Signal::File(PathBuf::from("pending"))).unwrap();
        tx.send(Signal::Stop).unwrap();
        let started = Instant::now();
        collect_batches(rx, |_, _| panic!("Stop 之后不能发送旧批次"));
        assert!(started.elapsed() < DEBOUNCE);
    }

    #[test]
    fn disconnect_flushes_the_last_batch() {
        let (tx, rx) = mpsc::channel();
        tx.send(Signal::File(PathBuf::from("last"))).unwrap();
        drop(tx);
        let mut batches = Vec::new();
        collect_batches(rx, |_, files| batches.push(sorted_paths(files)));
        assert_eq!(batches, [vec!["last".to_string()]]);
    }

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
    fn emits_file_signals_for_removed_and_renamed_paths() {
        use notify::event::{RemoveKind, RenameMode};

        // 删除 / 改名时路径已经不在磁盘上，不能再拿 is_file 把它筛掉；
        // 前端会再用 pathsPresent 判断，目录路径匹配不到文件标签。
        let gone = under(&["src", "gone.rs"]);
        assert!(should_emit_file(
            &EventKind::Remove(RemoveKind::File),
            &gone
        ));
        assert!(should_emit_file(
            &EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            &gone
        ));
        assert!(should_emit_file(
            &EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &gone
        ));
    }

    #[test]
    fn only_emits_file_signals_for_existing_files_on_content_changes() {
        use notify::event::DataChange;

        // 正文变化仍要求路径此刻是文件：目录 / 已删除的路径不该当文件送给编辑器
        let missing = under(&["src", "missing.rs"]);
        assert!(!should_emit_file(
            &EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            &missing
        ));
        assert!(!should_emit_file(
            &EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            &under(&["src", "missing-dir"])
        ));
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
        // 同一个文件要喂给四次断言，借它的引用而不是 clone 出一个单元素数组
        use std::slice::from_ref;

        let file = under(&["src", "main.rs"]);
        let content = EventKind::Modify(ModifyKind::Data(DataChange::Content));

        assert!(should_refresh(
            &EventKind::Create(CreateKind::File),
            from_ref(&file)
        ));
        assert!(should_refresh(
            &EventKind::Remove(RemoveKind::File),
            from_ref(&file)
        ));
        assert!(should_refresh(
            &EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            from_ref(&file)
        ));
        // 编辑器保存正文不影响文件树
        assert!(!should_refresh(&content, from_ref(&file)));
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
