use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::encoding::{self, FileEncoding};

/// 文本类操作（读文件、看差异）的大小上限，两个模块共用
pub(crate) const MAX_TEXT_SIZE: u64 = 2 * 1024 * 1024;

/// 图片预览的体积上限。比文本宽松得多——图片只能整张加载，没有"读一段"的说法；
/// 但 base64 还要再涨三分之一，再大就别让 IPC 扛了。
const MAX_IMAGE_SIZE: u64 = 10 * 1024 * 1024;

/// 二进制判定：只看前 8192 字节里有没有 NUL。
/// 完整读一遍大文件再判断不值得，这个启发式对源码仓库够准。
pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8192)].contains(&0)
}

/// 用户打开过的工作区根（canonical 路径）。
///
/// 单窗口下会同时存在多个工作区，所以命令一律显式带上 `root`；但前端传来的路径
/// 不可信，只有在这里登记过的才算数——否则等于把任意目录交给前端去读写，沙箱白做。
pub struct FsState {
    known: Mutex<HashSet<PathBuf>>,
}

impl FsState {
    pub fn new() -> Self {
        Self {
            known: Mutex::new(HashSet::new()),
        }
    }

    /// 登记一个工作区根（统一 canonical 化后返回）。前端「打开工作区」和切换工作区都走这里。
    ///
    /// 存进去的路径带不带 `\\?\` 前缀、大小写对不对，会直接决定 `resolve` 的前缀校验
    /// 过不过，所以不能在调用处各写各的。
    pub(crate) fn register(&self, path: PathBuf) -> Result<PathBuf, String> {
        let target = canonical(path);
        self.known
            .lock()
            .map_err(|e| e.to_string())?
            .insert(target.clone());
        Ok(target)
    }

    /// 把命令里传来的 `root` 折算成真实的沙箱根，不在白名单里就拒绝。
    pub(crate) fn checked_root(&self, raw: &str) -> Result<PathBuf, String> {
        let candidate = PathBuf::from(raw);
        let known = self.known.lock().map_err(|e| e.to_string())?;
        if known.contains(&candidate) {
            Ok(candidate)
        } else {
            Err(format!("未登记的工作区目录: {raw}"))
        }
    }

    /// 关闭工作区时把根从白名单摘掉，别让它无限涨
    pub(crate) fn forget(&self, root: &str) {
        if let Ok(mut known) = self.known.lock() {
            known.remove(Path::new(root));
        }
    }
}

/// 词法归一化：`a/../b` -> `b`。目标文件还不存在时 canonicalize 会失败，
/// 所以创建类操作只能靠它来挡 `..`。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Windows 的 canonicalize 会带上 `\\?\` 前缀，直接和前端传来的路径比较会不相等。
/// 目录监听拿到的路径也可能带这个前缀，所以对 watcher 也开放。
pub(crate) fn simplify(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(rest);
        }
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
    }
    path
}

fn canonical(path: PathBuf) -> PathBuf {
    simplify(path.canonicalize().unwrap_or_else(|_| normalize(&path)))
}

/// 前端传来的路径一律视为不可信：解析后必须落在**这个工作区**的根内。
///
/// 已存在的路径直接 canonicalize（会跟随软链接，能挡住"工作区里放一个指向
/// 外部的软链接"这种逃逸）。路径（或它的若干层父目录）还不存在时，向上找到
/// 最近存在的祖先 canonicalize 它，再把缺的那几段词法拼回去：`git status`
/// 会报出整个目录被删后的 `dir/a.txt`，那时 `dir` 已经不存在了，坚持"父目录
/// 必须存在"会让删除类改动完全没法提交。安全性不变——存在的那一段照样
/// canonicalize，软链接逃逸还是被挡在外面。
pub(crate) fn resolve(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let candidate = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };
    let candidate = normalize(&candidate);

    let mut missing: Vec<OsString> = Vec::new();
    let mut probe = candidate.as_path();
    let base = loop {
        match probe.canonicalize() {
            Ok(real) => break simplify(real),
            Err(_) => {
                let name = probe
                    .file_name()
                    .ok_or_else(|| format!("非法路径: {raw}"))?
                    .to_os_string();
                missing.push(name);
                probe = probe.parent().ok_or_else(|| format!("非法路径: {raw}"))?;
            }
        }
    };

    let mut target = base;
    for name in missing.iter().rev() {
        target.push(name);
    }

    if target != root && !target.starts_with(root) {
        return Err(format!("路径越界（不在工作区内）: {raw}"));
    }
    Ok(target)
}

fn display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    /// 最近修改时间（Unix 毫秒）。读不到就是 0，前端当「未知」处理
    modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    text: String,
    is_binary: bool,
    too_large: bool,
    /// 检测到的编码标签（如 `gbk`）。前端保存时原样回传给 `fs_write_file`，
    /// 才能按原编码写回；二进制 / 超限时为空串。
    encoding: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageContent {
    /// 能直接喂给 `<img src>` 的 data URL；超限时是空串
    data: String,
    too_large: bool,
}

/// 打开 / 切换工作区：登记这个工作区的**全部工作目录**，并把目录监听整体换成这一组。
///
/// 一次收一组而不是逐个调，是因为监听是「整组替换」的：逐个来的话后一个根会把前一个
/// 顶掉，文件树只有最后一根是活的。返回 canonical 后的路径列表，顺序跟传入一致
/// （`roots[0]` 是主要根）。
///
/// 监听失败不影响用——文件树还有刷新按钮——所以只吞掉错误，不把切换搞失败。
#[tauri::command]
pub fn workspace_activate(
    app: tauri::AppHandle,
    state: tauri::State<'_, FsState>,
    watch: tauri::State<'_, crate::watcher::WatchState>,
    roots: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut resolved = Vec::with_capacity(roots.len());
    for raw in &roots {
        let target = PathBuf::from(raw);
        if !target.is_dir() {
            return Err(format!("不是有效的目录: {raw}"));
        }
        resolved.push(state.register(target)?);
    }
    watch.watch_roots(app, &resolved);
    Ok(resolved.iter().map(|root| display(root)).collect())
}

/// 只登记这一组根、**不换目录监听**：编辑一个「开着、但不是当前显示」的工作区时用。
///
/// 监听只跟当前工作区（切过去时才由 `workspace_activate` 整体换），所以给后台工作区改
/// 工作目录时不能顺手 activate——那会把监听抢到它身上，当前工作区的文件树就不刷了。
#[tauri::command]
pub fn workspace_register(
    state: tauri::State<'_, FsState>,
    roots: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut resolved = Vec::with_capacity(roots.len());
    for raw in &roots {
        let target = PathBuf::from(raw);
        if !target.is_dir() {
            return Err(format!("不是有效的目录: {raw}"));
        }
        resolved.push(state.register(target)?);
    }
    Ok(resolved.iter().map(|root| display(root)).collect())
}

/// 关闭一个工作区：收掉它每个工作目录的终端与 opencode 进程、停掉各自的目录监听
/// （只在正听着它时），并把根从白名单摘掉。前端「移除工作区」和「关闭工作区」都走这里。
#[tauri::command]
pub fn workspace_close(
    state: tauri::State<'_, FsState>,
    watch: tauri::State<'_, crate::watcher::WatchState>,
    pty: tauri::State<'_, crate::pty::PtyState>,
    agent: tauri::State<'_, crate::agent::AgentState>,
    roots: Vec<String>,
) {
    for root in &roots {
        agent.kill_workspace(root);
        let _ = pty.kill_workspace(root);
        watch.stop_if(Path::new(root));
        state.forget(root);
    }
}

/// 列目录。抽出来是为了能在单元测试里直接验证过滤/排序规则。
fn list_entries(dir: &Path) -> Result<Vec<Entry>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}: {e}", display(dir)))?;

    let mut entries = Vec::new();
    for item in read.flatten() {
        // 以 `.` 开头的隐藏项照常列出：.env / .github 这类文件恰恰是常要编辑的
        let name = item.file_name().to_string_lossy().to_string();
        let item_path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        // 多一次 stat，只为悬停时能显示修改时间。目录列不长，值这点开销
        let modified = item
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(Entry {
            name,
            path: display(&item_path),
            is_dir,
            modified,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
pub fn fs_list_dir(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
) -> Result<Vec<Entry>, String> {
    let dir = resolve(&state.checked_root(&root)?, &path)?;
    list_entries(&dir)
}

/// 搜索时整个跳过的目录名（小写比较）。这些目录动辄几万个文件，
/// 不跳过一次搜索就能把界面卡住。目录监听也用这份名单。
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".output",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".idea",
    "vendor",
];

/// 这个名字的目录要不要在遍历/监听里跳过。大小写不敏感。
pub(crate) fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name.to_lowercase().as_str())
}

/// 一次最多返回多少条。再多前端也画不动，而且用户不会往下翻。
const MAX_HITS: usize = 300;

/// 最多看多少个目录项就收手：极端情况下（巨大的仓库、命中极少）
/// 不能让这个线程一直跑下去。
const MAX_VISITS: usize = 100_000;

/// 递归遍历工作区里的文件：跳过 SKIP_DIRS，用显式栈避免深目录压爆调用栈。
/// `on_file` 返回 false 表示不必再往下走了（比如结果已经收满）。
/// 返回值是「是否走完了」—— false 说明是提前收手，不是真的没有更多。
///
/// `pub(crate)`：生成反馈正文时也要列一遍工作区文件（见 `ai.rs`），
/// 跳目录 / 防爆栈的规则只能有一份。
pub(crate) fn walk_files(root: &Path, on_file: &mut dyn FnMut(&Path) -> bool) -> bool {
    // 显式栈而不是递归：目录嵌套很深时不会把调用栈压爆
    let mut stack = vec![root.to_path_buf()];
    let mut visits = 0usize;

    while let Some(dir) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for item in read.flatten() {
            visits += 1;
            if visits > MAX_VISITS {
                return false;
            }

            // file_type() 是 lstat 语义，不跟随软链接：指向外面的软链接目录
            // 不会被当成目录走下去，顺带挡掉循环链接
            let Ok(kind) = item.file_type() else {
                continue;
            };

            if kind.is_dir() {
                let name = item.file_name().to_string_lossy().to_string();
                if !is_skipped_dir(&name) {
                    stack.push(item.path());
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            if !on_file(&item.path()) {
                return false;
            }
        }
    }
    true
}

/// 按文件名递归搜工作区，大小写不敏感的子串匹配。只返回文件，不返回目录。
#[tauri::command(async)]
pub fn fs_search_files(
    state: tauri::State<'_, FsState>,
    root: String,
    query: String,
) -> Result<Vec<String>, String> {
    let root = state.checked_root(&root)?;
    Ok(search_files(&root, &query))
}

/// 抽出来是为了能在单元测试里直接跑，不用起 tauri 的 State。
fn search_files(root: &Path, query: &str) -> Vec<String> {
    let needle = query.trim().to_lowercase();
    // 空查询会命中所有文件，没有意义
    if needle.is_empty() {
        return Vec::new();
    }

    let mut hits: Vec<String> = Vec::new();
    walk_files(root, &mut |path| {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.to_lowercase().contains(&needle) {
            hits.push(display(path));
        }
        hits.len() < MAX_HITS
    });

    // 遍历顺序取决于目录项的返回顺序，排一下让同样的查询给出同样的结果
    hits.sort();
    hits
}

#[tauri::command]
pub fn fs_read_file(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
) -> Result<FileContent, String> {
    let file = resolve(&state.checked_root(&root)?, &path)?;
    let meta = fs::metadata(&file).map_err(|e| format!("读取文件失败 {}: {e}", display(&file)))?;

    if meta.len() > MAX_TEXT_SIZE {
        return Ok(FileContent {
            text: String::new(),
            is_binary: false,
            too_large: true,
            encoding: String::new(),
        });
    }

    let bytes = fs::read(&file).map_err(|e| format!("读取文件失败 {}: {e}", display(&file)))?;
    // UTF-16 文本里到处是 NUL，会被 `looks_binary` 误判成二进制，所以先认一遍 BOM
    if encoding::detect_bom(&bytes).is_none() && looks_binary(&bytes) {
        return Ok(FileContent {
            text: String::new(),
            is_binary: true,
            too_large: false,
            encoding: String::new(),
        });
    }

    // 按检测到的编码解码。认不出编码就明确报错，不拿 lossy 的结果蒙混过去——
    // 那正是「非 UTF-8 文件保存即损坏」的成因。
    let encoding = encoding::detect(&bytes).ok_or_else(|| {
        format!(
            "无法识别文件编码（支持 UTF-8 / UTF-16 / GBK / Big5）: {}",
            display(&file)
        )
    })?;
    match encoding::decode(&bytes, encoding) {
        Ok(text) => Ok(FileContent {
            text,
            is_binary: false,
            too_large: false,
            encoding: encoding.label().to_string(),
        }),
        // 认出了编码却解不干净（多半是二进制被猜成了 GBK）：按二进制处理更安全，
        // 绝不让编辑器拿着一份带替换字符的内容去保存
        Err(_) => Ok(FileContent {
            text: String::new(),
            is_binary: true,
            too_large: false,
            encoding: String::new(),
        }),
    }
}

/// 按「文本文件」的规矩读一个文件的全文，读不了就直接报错。
///
/// 与 `fs_read_file` 的分工：那个要回三态（空文本 + 标志位），给编辑器自己判怎么显示；
/// 这里只服务于一次性拿全文的调用方（如让大模型解析文件），拿不到就让它失败，
/// 判定（沙箱、大小上限、二进制）和 `fs_read_file` 完全一致，不另起一套。
pub(crate) fn read_text_file(root: &Path, raw: &str) -> Result<String, String> {
    let file = resolve(root, raw)?;
    let meta = fs::metadata(&file).map_err(|e| format!("读取文件失败 {}: {e}", display(&file)))?;
    if meta.len() > MAX_TEXT_SIZE {
        return Err("文件太大（超过 2 MB），无法解析".to_string());
    }
    let bytes = fs::read(&file).map_err(|e| format!("读取文件失败 {}: {e}", display(&file)))?;
    if looks_binary(&bytes) {
        return Err("这不是文本文件，无法解析".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 能直接渲染的图片扩展名 → MIME。**`svg` 故意不在列**：它是文本，编辑器里已经当
/// xml 打开、能编辑能高亮，挪去图片预览反而是倒退；`tif` 这类浏览器不认。
fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// 读一张图片当预览。返回 data URL 而不是文件路径：走 asset 协议得在
/// tauri.conf 里另开一份 scope，而这里的路径本来就要过工作区沙箱这一关。
/// 抽出来是为了单测能直接跑（`tauri::State` 在测试里造不出来）。
fn read_image_at(root: &Path, path: &str) -> Result<ImageContent, String> {
    let file = resolve(root, path)?;
    // 先按扩展名挡一道：不然任何二进制文件都能借这个命令把内容读出去
    let mime =
        image_mime(&file).ok_or_else(|| format!("不是可预览的图片格式: {}", display(&file)))?;
    let meta = fs::metadata(&file).map_err(|e| format!("读取图片失败 {}: {e}", display(&file)))?;

    if meta.len() > MAX_IMAGE_SIZE {
        return Ok(ImageContent {
            data: String::new(),
            too_large: true,
        });
    }

    let bytes = fs::read(&file).map_err(|e| format!("读取图片失败 {}: {e}", display(&file)))?;
    Ok(ImageContent {
        data: format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
        too_large: false,
    })
}

#[tauri::command]
pub fn fs_read_image(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
) -> Result<ImageContent, String> {
    read_image_at(&state.checked_root(&root)?, &path)
}

/// 按指定编码把文本写回文件。
///
/// `encoding` 是打开时检测到的编码标签，由前端原样回传。为空表示调用方没带
/// （新建文件，或非编辑器调用），这时只允许写 UTF-8；已有文件若不是 UTF-8，
/// 宁可报错也不能按 UTF-8 覆盖——那正是原编码被冲掉的成因。
fn write_text_file(file: &Path, text: &str, encoding: Option<&str>) -> Result<(), String> {
    let encoding = match encoding {
        Some(label) => FileEncoding::from_label(label)
            .ok_or_else(|| format!("不支持的编码: {label}"))?,
        None => {
            if let Ok(existing) = fs::read(file) {
                if !existing.is_empty() && std::str::from_utf8(&existing).is_err() {
                    return Err(format!(
                        "{} 不是 UTF-8 文件，缺少原编码信息，已拒绝保存以免损坏",
                        display(file)
                    ));
                }
            }
            FileEncoding::Utf8
        }
    };
    let bytes = encoding::encode(text, encoding)?;
    fs::write(file, bytes).map_err(|e| format!("写入文件失败 {}: {e}", display(file)))
}

#[tauri::command]
pub fn fs_write_file(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
    text: String,
    encoding: Option<String>,
) -> Result<(), String> {
    let file = resolve(&state.checked_root(&root)?, &path)?;
    write_text_file(&file, &text, encoding.as_deref())
}

/// 名称校验：只能是一段名字，不能是空 / `.` / `..`，也不许夹分隔符。
/// 新建和重命名共用同一套规则——两处各写一份迟早会走偏。
fn validate_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("文件名无效".to_string());
    }
    Ok(())
}

fn validate_create_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    let name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "文件名无效".to_string())?;
    validate_name(name)?;

    let target = resolve(root, path)?;
    if target.exists() {
        return Err(format!("目标已存在: {}", display(&target)));
    }
    let parent = target.parent().ok_or_else(|| "父目录无效".to_string())?;
    let metadata =
        fs::metadata(parent).map_err(|e| format!("父目录不存在 {}: {e}", display(parent)))?;
    if !metadata.is_dir() {
        return Err(format!("父路径不是目录: {}", display(parent)));
    }
    Ok(target)
}

/// 真正的创建逻辑抽出来，单测才能直接跑（`tauri::State` 在测试里造不出来）
fn create_file_at(root: &Path, path: &str) -> Result<(), String> {
    let file = validate_create_target(root, path)?;
    // 用 create_new 而不是 fs::write：写命令会静默覆盖同名文件，新建不该有这种副作用
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map(|_| ())
        .map_err(|e| format!("创建文件失败 {}: {e}", display(&file)))
}

fn create_directory_at(root: &Path, path: &str) -> Result<(), String> {
    let directory = validate_create_target(root, path)?;
    // 只建一层：名称里带分隔符的中间目录不该被隐式创建出来
    fs::create_dir(&directory).map_err(|e| format!("创建文件夹失败 {}: {e}", display(&directory)))
}

#[tauri::command]
pub fn fs_create_file(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
) -> Result<(), String> {
    create_file_at(&state.checked_root(&root)?, &path)
}

#[tauri::command]
pub fn fs_create_directory(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
) -> Result<(), String> {
    create_directory_at(&state.checked_root(&root)?, &path)
}

// ==================== 重命名与删除 ====================

/// 就地改名。`new_name` 只是一段名字（`validate_name` 挡掉分隔符），所以文件
/// 不会跑到别的目录去，也不用再校验一次是否越界。
fn rename_at(source: &Path, new_name: &str) -> Result<String, String> {
    validate_name(new_name)?;
    let name = new_name.trim();
    if !source.exists() {
        return Err(format!("路径不存在: {}", display(source)));
    }

    let parent = source.parent().ok_or_else(|| "父目录无效".to_string())?;
    let target = parent.join(name);
    if target == source {
        // 名字一模一样，什么都没发生
        return Ok(display(&target));
    }

    // Windows 上大小写不敏感，`a.txt` -> `A.txt` 时 exists() 会说"目标已存在"，
    // 但它其实就是自己。统一小写比一遍，把这种只改大小写的情况放行给 fs::rename
    let occupied = target.exists()
        && target.to_string_lossy().to_lowercase() != source.to_string_lossy().to_lowercase();
    if occupied {
        return Err(format!("目标已存在: {}", display(&target)));
    }

    fs::rename(source, &target).map_err(|e| format!("重命名失败 {}: {e}", display(source)))?;
    Ok(display(&target))
}

/// 删除文件或整个目录（递归）。**不可撤销**，前端必须先跟用户确认。
fn delete_at(target: &Path) -> Result<(), String> {
    // 路径已经过 resolve 的 canonicalize，指向的就是磁盘上真实的那一项
    if target.is_dir() {
        fs::remove_dir_all(target).map_err(|e| format!("删除失败 {}: {e}", display(target)))
    } else {
        fs::remove_file(target).map_err(|e| format!("删除失败 {}: {e}", display(target)))
    }
}

fn rename_entry(root: &Path, path: &str, new_name: &str) -> Result<String, String> {
    let source = resolve(root, path)?;
    // 工作区根没有父目录，也不该被改名——改掉之后前后端的沙箱边界就对不上了
    if source == root {
        return Err("不能重命名工作区根目录".to_string());
    }
    rename_at(&source, new_name)
}

fn delete_entry(root: &Path, path: &str) -> Result<(), String> {
    let target = resolve(root, path)?;
    if target == root {
        return Err("不能删除工作区根目录".to_string());
    }
    delete_at(&target)
}

/// 重命名，返回改名后的绝对路径——前端据此把编辑器标签上的路径一起换掉。
#[tauri::command]
pub fn fs_rename(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    rename_entry(&state.checked_root(&root)?, &path, &new_name)
}

#[tauri::command]
pub fn fs_delete(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
) -> Result<(), String> {
    delete_entry(&state.checked_root(&root)?, &path)
}

// ==================== 全工作区的内容搜索与替换 ====================

/// 一次搜索最多返回多少条匹配。再多前端也画不动，用户不会往下翻。
const MAX_MATCHES: usize = 1000;

/// 一次搜索最多涉及多少个文件（按相对路径排序后取前面的那些）。
const MAX_FILES: usize = 200;

/// 三个开关，和 VS Code 搜索框右边那排一致
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1 起算
    line: u32,
    /// 1 起算，按 **UTF-16 单位**算 —— Monaco 的列就是这套，前端能直接喂给 Range
    column: u32,
    /// 匹配长度，同样是 UTF-16 单位
    length: u32,
    /// 整行原文，面板直接拿去渲染
    text: String,
}

/// 前端从 `SearchMatch` 里挑出这三个字段回传，用来定位要替换的那一处。
/// 行列同样是 UTF-16 单位，和 Monaco 一致。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchPosition {
    /// 1 起算
    line: u32,
    /// 1 起算，UTF-16 单位
    column: u32,
    /// 匹配长度，UTF-16 单位
    length: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    path: String,
    /// 工作区内的相对路径（正斜杠），面板显示用
    relative: String,
    matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    files: Vec<SearchFile>,
    /// 撞到上限被截断了
    truncated: bool,
    /// 有多少个文件因为超过 2MB 被跳过
    skipped_large: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFile {
    path: String,
    replaced: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFailure {
    path: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    files: Vec<ReplacedFile>,
    total_replaced: usize,
    /// 单个文件失败不影响其它文件，失败的都记在这里
    errors: Vec<ReplaceFailure>,
}

/// 把查询串编译成模式。非正则态先转义，用户敲的 `.` `*` 都当字面量。
fn build_pattern(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let source = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexBuilder::new(&source)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| format!("正则表达式有误：{e}"))
}

/// 匹配两侧是不是词边界。不用 `\b`：查询首尾本身是非词字符时它会误判，
/// 而且 regex crate 没有 lookaround。中文算 alphanumeric，所以中文串内部
/// 不会出现边界，紧挨着中文也不会被误判成词首/词尾。
fn is_whole_word(line: &str, start: usize, end: usize) -> bool {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let before = line[..start].chars().next_back();
    let after = line[end..].chars().next();
    !before.is_some_and(word) && !after.is_some_and(word)
}

/// 按行切开，回调拿到行号（1 起算）、行首在全文里的字节偏移、去掉行尾符的行内容。
/// 行尾怎么算（LF / CRLF / 最后一行没有换行）只在这里处理一次。
fn for_each_line<'a, F: FnMut(u32, usize, &'a str) -> bool>(text: &'a str, mut on_line: F) {
    let mut offset = 0usize;
    // 行号交给 zip 的递增序列，省掉手动维护的计数器
    for (number, chunk) in (1u32..).zip(text.split_inclusive('\n')) {
        let line = chunk.strip_suffix('\n').unwrap_or(chunk);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if !on_line(number, offset, line) {
            return;
        }
        offset += chunk.len();
    }
}

/// 行内字节偏移 -> 1 起算的 UTF-16 列号
fn utf16_column(line: &str, byte_offset: usize) -> u32 {
    line[..byte_offset].encode_utf16().count() as u32 + 1
}

/// 找第 line 行（1 起算）的行首偏移和去掉行尾符的内容
fn line_at(text: &str, line: u32) -> Option<(usize, &str)> {
    let mut found = None;
    for_each_line(text, |number, offset, body| {
        if number == line {
            found = Some((offset, body));
            return false;
        }
        true
    });
    found
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|rest| rest.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| display(path))
}

/// 收集一个文件里所有命中的位置，最多要 limit 条
fn matches_in_text(
    text: &str,
    pattern: &Regex,
    options: &SearchOptions,
    limit: usize,
) -> Vec<SearchMatch> {
    let mut found = Vec::new();
    for_each_line(text, |number, _offset, line| {
        for hit in pattern.find_iter(line) {
            if options.whole_word && !is_whole_word(line, hit.start(), hit.end()) {
                continue;
            }
            found.push(SearchMatch {
                line: number,
                column: utf16_column(line, hit.start()),
                length: hit.as_str().encode_utf16().count() as u32,
                text: line.to_string(),
            });
            if found.len() >= limit {
                return false;
            }
        }
        true
    });
    found
}

#[tauri::command(async)]
pub fn fs_search_content(
    state: tauri::State<'_, FsState>,
    root: String,
    query: String,
    options: SearchOptions,
) -> Result<SearchResult, String> {
    let root = state.checked_root(&root)?;
    search_content(&root, &query, &options)
}

/// 抽出来是为了能在单元测试里直接跑，不用起 tauri 的 State
fn search_content(
    root: &Path,
    query: &str,
    options: &SearchOptions,
) -> Result<SearchResult, String> {
    // 空查询会命中每一行的行首位置，没有意义
    if query.is_empty() {
        return Ok(SearchResult {
            files: Vec::new(),
            truncated: false,
            skipped_large: 0,
        });
    }
    let pattern = build_pattern(query, options)?;

    let mut files: Vec<SearchFile> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    let mut skipped_large = 0usize;

    walk_files(root, &mut |path| {
        if files.len() >= MAX_FILES || total >= MAX_MATCHES {
            truncated = true;
            return false;
        }

        let Ok(meta) = fs::metadata(path) else {
            return true;
        };
        if meta.len() > MAX_TEXT_SIZE {
            skipped_large += 1;
            return true;
        }
        let Ok(bytes) = fs::read(path) else {
            return true;
        };
        if looks_binary(&bytes) {
            return true;
        }

        // 和编辑器读文件一致：宽容处理非法字节，这样列号才和 Monaco 里的 model 对得上
        let text = String::from_utf8_lossy(&bytes);
        let matches = matches_in_text(&text, &pattern, options, MAX_MATCHES - total);
        if matches.is_empty() {
            return true;
        }

        total += matches.len();
        files.push(SearchFile {
            path: display(path),
            relative: relative_path(root, path),
            matches,
        });
        true
    });

    // 遍历顺序取决于目录项的返回顺序，排一下让同样的查询给出同样的结果
    files.sort_by(|a, b| a.relative.cmp(&b.relative));

    Ok(SearchResult {
        files,
        truncated,
        skipped_large,
    })
}

/// 替换只动合法 UTF-8 的文件：非法字节经 `from_utf8_lossy` 会变成替换字符，
/// 一写回就把原文件的其余部分也改了。
fn read_utf8(file: &Path) -> Result<String, String> {
    let bytes = fs::read(file).map_err(|e| format!("读取文件失败 {}: {e}", display(file)))?;
    String::from_utf8(bytes).map_err(|_| format!("{} 不是 UTF-8 文本，已跳过", display(file)))
}

#[tauri::command]
pub fn fs_replace_one(
    state: tauri::State<'_, FsState>,
    root: String,
    path: String,
    position: MatchPosition,
    query: String,
    options: SearchOptions,
    replacement: String,
) -> Result<(), String> {
    let file = resolve(&state.checked_root(&root)?, &path)?;
    replace_one(
        &file,
        position.line,
        position.column,
        position.length,
        &query,
        &options,
        &replacement,
    )
}

/// 单条替换只动这一处。位置会漂移，所以三级降级：
/// ① 前端给的行列还在、长度也对得上 → 换它；
/// ② 这一行只剩一个匹配 → 换它（文件被人加了几行这种）；
/// ③ 都对不上 → 报错让用户重搜。**不直接信任前端传来的行列**，否则会写错地方。
fn replace_one(
    file: &Path,
    line: u32,
    column: u32,
    length: u32,
    query: &str,
    options: &SearchOptions,
    replacement: &str,
) -> Result<(), String> {
    if query.is_empty() {
        return Err("搜索内容不能为空".to_string());
    }
    let pattern = build_pattern(query, options)?;
    let text = read_utf8(file)?;

    let (start, content) = line_at(&text, line)
        .ok_or_else(|| format!("{} 的第 {line} 行已经不在了，请重新搜索", display(file)))?;

    let hits: Vec<(usize, usize)> = pattern
        .find_iter(content)
        .filter(|hit| !options.whole_word || is_whole_word(content, hit.start(), hit.end()))
        .map(|hit| (hit.start(), hit.end()))
        .collect();

    let target = hits
        .iter()
        .find(|(from, to)| {
            utf16_column(content, *from) == column
                && content[*from..*to].encode_utf16().count() as u32 == length
        })
        .or_else(|| if hits.len() == 1 { hits.first() } else { None })
        .ok_or_else(|| format!("{} 的内容已经变了，请重新搜索", display(file)))?;

    let mut next = String::with_capacity(text.len() + replacement.len());
    next.push_str(&text[..start + target.0]);
    next.push_str(replacement);
    next.push_str(&text[start + target.1..]);

    fs::write(file, next).map_err(|e| format!("写入文件失败 {}: {e}", display(file)))
}

fn replace_all_in_file(
    file: &Path,
    pattern: &Regex,
    options: &SearchOptions,
    replacement: &str,
) -> Result<usize, String> {
    let text = read_utf8(file)?;

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for_each_line(&text, |_, offset, body| {
        for hit in pattern.find_iter(body) {
            if options.whole_word && !is_whole_word(body, hit.start(), hit.end()) {
                continue;
            }
            ranges.push((offset + hit.start(), offset + hit.end()));
        }
        true
    });

    if ranges.is_empty() {
        return Ok(0);
    }

    // 从后往前替换：前面的偏移就不会被替换结果的长度影响。
    // 这样也天然保住了原文件的行尾风格（CRLF 不会被改成 LF）
    let mut next = text;
    for (from, to) in ranges.iter().rev() {
        next.replace_range(*from..*to, replacement);
    }

    fs::write(file, next).map_err(|e| format!("写入文件失败 {}: {e}", display(file)))?;
    Ok(ranges.len())
}

#[tauri::command]
pub fn fs_replace_all(
    state: tauri::State<'_, FsState>,
    root: String,
    paths: Vec<String>,
    query: String,
    options: SearchOptions,
    replacement: String,
) -> Result<ReplaceResult, String> {
    if query.is_empty() {
        return Err("搜索内容不能为空".to_string());
    }
    let pattern = build_pattern(&query, &options)?;
    let root = state.checked_root(&root)?;

    let mut files = Vec::new();
    let mut errors = Vec::new();
    let mut total = 0usize;

    for raw in paths {
        // 搜索是从工作区根遍历的、路径天然安全；替换的路径来自前端，必须过一遍沙箱
        let file = match resolve(&root, &raw) {
            Ok(path) => path,
            Err(message) => {
                errors.push(ReplaceFailure { path: raw, message });
                continue;
            }
        };
        match replace_all_in_file(&file, &pattern, &options, &replacement) {
            Ok(0) => {}
            Ok(count) => {
                total += count;
                files.push(ReplacedFile {
                    path: display(&file),
                    replaced: count,
                });
            }
            Err(message) => errors.push(ReplaceFailure {
                path: display(&file),
                message,
            }),
        }
    }

    Ok(ReplaceResult {
        files,
        total_replaced: total,
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 每个测试各用一个目录：cargo test 默认并行跑，共用同名目录时，
    /// 一个测试收尾的 remove_dir_all 会把另一个测试刚写好的夹具删掉。
    fn temp_state() -> (FsState, PathBuf) {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let unique = SEQ.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("codedock-test-{}-{unique}", std::process::id()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let state = FsState::new();
        state.register(workspace).unwrap();
        (state, root)
    }

    /// 测试里只登记一个工作区，取它的根当沙箱
    fn workspace_root(state: &FsState) -> PathBuf {
        state
            .known
            .lock()
            .unwrap()
            .iter()
            .next()
            .expect("测试里应该已经登记了工作区")
            .clone()
    }

    #[test]
    fn rejects_everything_before_a_workspace_is_chosen() {
        let state = FsState::new();
        // 一个工作区都没登记过：连根都取不出来，自然也没有可操作的沙箱
        assert!(state.checked_root("D:\\anything.txt").is_err());
    }

    #[test]
    fn rejects_parent_traversal() {
        let (state, root) = temp_state();
        let outside = root.join("secret.txt");
        assert!(resolve(&workspace_root(&state), outside.to_str().unwrap()).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn allows_new_file_inside_root() {
        let (state, root) = temp_state();

        // 父目录还不存在也放行：git 报出的"整个目录被删"就是这个形状
        // （`D src/old/a.txt`，而 src/old 已经没了），拦在这里会让删除类改动
        // 没法暂存。真正的失败留给 OS——写文件时父目录不存在会报错。
        let nested = workspace_root(&state).join("nested").join("new.txt");
        assert_eq!(
            resolve(&workspace_root(&state), nested.to_str().unwrap()).unwrap(),
            nested
        );

        let flat = workspace_root(&state).join("new.txt");
        assert_eq!(
            resolve(&workspace_root(&state), flat.to_str().unwrap()).unwrap(),
            flat
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn lists_dotfiles_and_puts_dirs_first() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        fs::write(workspace.join(".env"), "A=1").unwrap();
        fs::create_dir_all(workspace.join(".github")).unwrap();
        fs::write(workspace.join("main.rs"), "").unwrap();

        let entries = list_entries(&workspace).unwrap();
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&".env"), "隐藏文件应该被列出: {names:?}");
        assert!(names.contains(&".github"), "隐藏目录应该被列出: {names:?}");
        assert_eq!(entries[0].name, ".github", "目录要排在文件前面: {names:?}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn creates_a_file_and_a_directory() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);

        let file = workspace.join("new.txt");
        create_file_at(&workspace_root(&state), file.to_str().unwrap()).unwrap();
        assert!(file.is_file());
        assert_eq!(fs::read_to_string(&file).unwrap(), "", "新文件应该是空的");

        let dir = workspace.join("src");
        create_directory_at(&workspace_root(&state), dir.to_str().unwrap()).unwrap();
        assert!(dir.is_dir());
        // 已有目录里再建一层文件
        let nested = dir.join("main.rs");
        create_file_at(&workspace_root(&state), nested.to_str().unwrap()).unwrap();
        assert!(nested.is_file());

        // 中文和空格也要能建
        let spaced = workspace.join("我的 笔记.md");
        create_file_at(&workspace_root(&state), spaced.to_str().unwrap()).unwrap();
        assert!(spaced.is_file());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_to_overwrite_an_existing_target() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("a.txt");
        fs::write(&file, "original").unwrap();

        assert!(
            create_file_at(&workspace_root(&state), file.to_str().unwrap()).is_err(),
            "不能覆盖已有文件"
        );
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "original",
            "失败时不能动原文件"
        );

        let dir = workspace.join("src");
        fs::create_dir(&dir).unwrap();
        assert!(
            create_directory_at(&workspace_root(&state), dir.to_str().unwrap()).is_err(),
            "不能覆盖已有目录"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_a_missing_or_non_directory_parent() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);

        // 父目录不存在：创建类操作用的是词法归一化，resolve 放行，由这一层拦住
        let orphan = workspace.join("nope").join("a.txt");
        assert!(create_file_at(&workspace_root(&state), orphan.to_str().unwrap()).is_err());

        // 父路径是个文件
        let file = workspace.join("a.txt");
        fs::write(&file, "").unwrap();
        let below_file = file.join("a.txt");
        assert!(create_file_at(&workspace_root(&state), below_file.to_str().unwrap()).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_rejects_traversal_and_invalid_names() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);

        let outside = root.join("outside.txt");
        assert!(
            create_file_at(&workspace_root(&state), outside.to_str().unwrap()).is_err(),
            "越界要拒绝"
        );
        assert!(!outside.exists());

        for bad in ["", ".", ".."] {
            let target = format!("{}/{}", workspace.to_string_lossy(), bad);
            assert!(
                create_file_at(&workspace_root(&state), &target).is_err(),
                "{bad:?} 不该被当成名称"
            );
        }

        let dir = workspace.join("src");
        fs::create_dir(&dir).unwrap();
        assert!(
            create_directory_at(
                &workspace_root(&state),
                dir.join("a").join("b").to_str().unwrap()
            )
            .is_err(),
            "中间目录不存在时不该用 create_dir_all 造出来"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn renames_a_file_and_a_directory() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);

        let file = workspace.join("old.txt");
        fs::write(&file, "hi").unwrap();
        let renamed =
            rename_entry(&workspace_root(&state), file.to_str().unwrap(), "new.txt").unwrap();
        assert_eq!(renamed, display(&workspace.join("new.txt")));
        assert!(!file.exists());
        assert_eq!(
            fs::read_to_string(workspace.join("new.txt")).unwrap(),
            "hi",
            "内容要跟着走"
        );

        let dir = workspace.join("src");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("main.rs"), "").unwrap();
        let moved = rename_entry(&workspace_root(&state), dir.to_str().unwrap(), "app").unwrap();
        assert!(
            workspace.join("app").join("main.rs").is_file(),
            "目录要连内容一起搬"
        );
        assert!(moved.ends_with("app"));

        // 名称带首尾空格是允许的（trim 掉），中文和空格也要能改
        let spaced = rename_entry(
            &workspace_root(&state),
            workspace.join("new.txt").to_str().unwrap(),
            "我的 笔记.md",
        )
        .unwrap();
        assert!(spaced.ends_with("我的 笔记.md"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_refuses_bad_names_and_occupied_targets() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("a.txt");
        fs::write(&file, "a").unwrap();
        fs::write(workspace.join("b.txt"), "b").unwrap();

        for bad in ["", "  ", ".", "..", "sub/c.txt", r"sub\c.txt"] {
            assert!(
                rename_entry(&workspace_root(&state), file.to_str().unwrap(), bad).is_err(),
                "{bad:?} 不该被当成名称"
            );
        }
        assert!(file.exists(), "校验失败时原文件一个字节都不该动");

        assert!(
            rename_entry(&workspace_root(&state), file.to_str().unwrap(), "b.txt").is_err(),
            "不能覆盖同名文件"
        );
        assert_eq!(fs::read_to_string(workspace.join("b.txt")).unwrap(), "b");

        // 改名不能跨目录：名称里带分隔符已经被上面挡掉了，越界的写法也一并拒绝
        let outside = root.join("outside.txt");
        assert!(rename_entry(&workspace_root(&state), outside.to_str().unwrap(), "x.txt").is_err());

        // 工作区根不能被改名，否则前后端的沙箱边界就对不上了
        assert!(rename_entry(&workspace_root(&state), workspace.to_str().unwrap(), "other").is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_only_changes_the_case_of_a_name() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("readme.md");
        fs::write(&file, "hi").unwrap();

        // Windows 上 exists() 会说"目标已存在"，但它就是自己，不该被拦下
        let renamed =
            rename_entry(&workspace_root(&state), file.to_str().unwrap(), "README.md").unwrap();
        assert_eq!(renamed.to_lowercase(), display(&file).to_lowercase());
        assert!(workspace.join("README.md").exists() || workspace.join("readme.md").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn deletes_files_and_directories_recursively() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);

        let file = workspace.join("a.txt");
        fs::write(&file, "").unwrap();
        delete_entry(&workspace_root(&state), file.to_str().unwrap()).unwrap();
        assert!(!file.exists());

        let dir = workspace.join("src");
        fs::create_dir_all(dir.join("deep")).unwrap();
        fs::write(dir.join("deep").join("main.rs"), "").unwrap();
        delete_entry(&workspace_root(&state), dir.to_str().unwrap()).unwrap();
        assert!(!dir.exists(), "目录要连里面的文件一起删掉");

        // 越界和工作区根都不许删
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        assert!(delete_entry(&workspace_root(&state), outside.to_str().unwrap()).is_err());
        assert!(outside.is_dir(), "越界时不能真删");
        assert!(delete_entry(&workspace_root(&state), workspace.to_str().unwrap()).is_err());
        assert!(workspace.is_dir());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn searches_file_names_and_skips_heavy_dirs() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src").join("Main.rs"), "").unwrap();
        fs::write(workspace.join("README.md"), "").unwrap();
        fs::create_dir_all(workspace.join("node_modules").join("pkg")).unwrap();
        fs::write(
            workspace.join("node_modules").join("pkg").join("main.js"),
            "",
        )
        .unwrap();

        let hits = search_files(&workspace, "main");
        assert_eq!(hits.len(), 1, "只该命中 src/Main.rs: {hits:?}");
        assert!(hits[0].ends_with("Main.rs"), "命中的路径不对: {hits:?}");

        assert_eq!(
            search_files(&workspace, "readme").len(),
            1,
            "应该大小写不敏感"
        );
        assert!(search_files(&workspace, "src").is_empty(), "目录不该算命中");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn search_ignores_an_empty_needle() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        fs::write(workspace.join("a.txt"), "").unwrap();

        assert!(search_files(&workspace, "").is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn follows_symlinked_parent_for_new_files() {
        let (state, root) = temp_state();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();

        #[cfg(unix)]
        let linked =
            std::os::unix::fs::symlink(&outside, workspace_root(&state).join("link")).is_ok();
        #[cfg(windows)]
        let linked =
            std::os::windows::fs::symlink_dir(&outside, workspace_root(&state).join("link")).is_ok();

        // 建软链接通常需要权限，建不出来就跳过
        if linked {
            let escaping = workspace_root(&state).join("link").join("pwned.txt");
            assert!(resolve(&workspace_root(&state), escaping.to_str().unwrap()).is_err());

            // 向上找祖先不能变成绕过前缀校验的后门：软链接下面的目录不存在时，
            // 拼回去的路径落在工作区外，照样要拒绝
            let deeper = workspace_root(&state)
                .join("link")
                .join("missing")
                .join("pwned.txt");
            assert!(resolve(&workspace_root(&state), deeper.to_str().unwrap()).is_err());
        }
        fs::remove_dir_all(&root).ok();
    }

    fn opts(case_sensitive: bool, whole_word: bool, regex: bool) -> SearchOptions {
        SearchOptions {
            case_sensitive,
            whole_word,
            regex,
        }
    }

    #[test]
    fn content_search_honours_the_three_switches() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        fs::write(workspace.join("a.txt"), "Hello world\nhello there\n").unwrap();

        let plain = search_content(&workspace, "hello", &opts(false, false, false)).unwrap();
        assert_eq!(plain.files.len(), 1);
        assert_eq!(plain.files[0].matches.len(), 2, "默认该大小写不敏感");
        assert_eq!(plain.files[0].matches[0].line, 1);
        assert_eq!(plain.files[0].matches[0].column, 1);
        assert_eq!(plain.files[0].matches[0].length, 5);
        assert_eq!(plain.files[0].matches[0].text, "Hello world");
        assert_eq!(plain.files[0].relative, "a.txt", "路径要相对工作区");

        let sensitive = search_content(&workspace, "hello", &opts(true, false, false)).unwrap();
        assert_eq!(sensitive.files[0].matches.len(), 1);
        assert_eq!(sensitive.files[0].matches[0].line, 2);

        // 全字：`hell` 命中 `hello` 中间，应该被挡掉
        assert_eq!(
            search_content(&workspace, "hell", &opts(false, false, false))
                .unwrap()
                .files[0]
                .matches
                .len(),
            2
        );
        assert!(
            search_content(&workspace, "hell", &opts(false, true, false))
                .unwrap()
                .files
                .is_empty(),
            "全字匹配不该命中 hello 里的 hell"
        );

        let regex = search_content(&workspace, "h.llo", &opts(false, false, true)).unwrap();
        assert_eq!(regex.files[0].matches.len(), 2, "正则态不该把 . 当字面量");
        let literal = search_content(&workspace, "h.llo", &opts(false, false, false)).unwrap();
        assert!(literal.files.is_empty(), "非正则态 . 是字面量");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn whole_word_treats_chinese_as_word_characters() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        fs::write(workspace.join("cn.txt"), "中文测试\n中文\n").unwrap();

        let found = search_content(&workspace, "中文", &opts(false, true, false)).unwrap();
        assert_eq!(found.files[0].matches.len(), 1, "只该命中单独成行的那个");
        assert_eq!(found.files[0].matches[0].line, 2, "紧挨中文不算词边界");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn content_search_reports_a_broken_regex() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let error = match search_content(&workspace, "a(", &opts(false, false, true)) {
            Ok(_) => panic!("非法正则不该返回结果"),
            Err(message) => message,
        };
        assert!(error.contains("正则表达式有误"), "{error}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn content_search_skips_large_and_binary_files() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        fs::write(
            workspace.join("big.txt"),
            "x".repeat(MAX_TEXT_SIZE as usize + 1),
        )
        .unwrap();
        fs::write(workspace.join("bin.dat"), [0u8, 1, 2, b'x']).unwrap();
        fs::write(workspace.join("small.txt"), "xx\n").unwrap();

        let result = search_content(&workspace, "x", &opts(false, false, false)).unwrap();
        assert_eq!(result.skipped_large, 1, "大文件要被记一笔");
        assert_eq!(result.files.len(), 1, "二进制和超限的都不该有结果");
        assert!(result.files[0].relative.ends_with("small.txt"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn replaces_one_match_and_keeps_line_endings() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("a.txt");
        fs::write(&file, "one two\r\none\r\n").unwrap();

        replace_one(&file, 1, 1, 3, "one", &opts(false, false, false), "1").unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "1 two\r\none\r\n",
            "只换第一处，且 CRLF 不能被改成 LF"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn falls_back_to_the_only_match_on_that_line() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("a.txt");
        fs::write(&file, "one\n").unwrap();

        // 前端给的位置已经过期（列号长度都对不上），但这一行只有一个匹配，照样能换
        replace_one(&file, 1, 99, 99, "one", &opts(false, false, false), "1").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "1\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_when_it_cannot_tell_which_match_to_replace() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("a.txt");
        fs::write(&file, "one one\n").unwrap();

        // 两个匹配 + 位置对不上 = 猜不出来该换哪个，必须报错而不是乱写
        let error =
            replace_one(&file, 1, 99, 99, "one", &opts(false, false, false), "1").unwrap_err();
        assert!(error.contains("已经变了"), "{error}");
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "one one\n",
            "报错的路径上一个字节都不该动"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn replaces_every_occurrence() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("a.txt");
        fs::write(&file, "one two one\n").unwrap();
        let pattern = build_pattern("one", &opts(false, false, false)).unwrap();

        let count = replace_all_in_file(&file, &pattern, &opts(false, false, false), "1").unwrap();
        assert_eq!(count, 2);
        assert_eq!(fs::read_to_string(&file).unwrap(), "1 two 1\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_to_touch_a_non_utf8_file() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("gbk.txt");
        // GBK 的「你好」：不是合法 UTF-8，也没有 NUL
        let original = vec![0xC4u8, 0xE3, 0xBA, 0xC3];
        fs::write(&file, &original).unwrap();

        let error = replace_one(&file, 1, 1, 1, "a", &opts(false, false, false), "b").unwrap_err();
        assert!(error.contains("UTF-8"), "{error}");
        assert_eq!(fs::read(&file).unwrap(), original, "原文件一个字节都不该动");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn writes_back_the_original_non_utf8_encoding() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("gbk.txt");

        let original = encoding::encode("旧编码", FileEncoding::Gbk).unwrap();
        fs::write(&file, &original).unwrap();

        // 前端回传打开时检测到的编码，保存必须按同一个编码写回
        let next = "新的 GBK 内容";
        write_text_file(&file, next, Some("gbk")).unwrap();
        let written = fs::read(&file).unwrap();
        assert_eq!(
            encoding::decode(&written, FileEncoding::Gbk).unwrap(),
            next,
            "写回的内容要能用 GBK 解回来"
        );
        assert_ne!(written, next.as_bytes(), "不能偷偷写成 UTF-8");

        // 带上不认识 / 缺失的编码信息时，非 UTF-8 文件必须拒绝，不能被 UTF-8 覆盖
        let error = write_text_file(&file, "x", None).unwrap_err();
        assert!(error.contains("拒绝保存"), "{error}");
        assert_eq!(fs::read(&file).unwrap(), written, "拒绝时一个字节都不该动");
        assert!(write_text_file(&file, "x", Some("latin1")).is_err());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn writes_utf8_when_no_encoding_is_given_for_a_new_file() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let file = workspace.join("new.txt");

        // 文件还不存在（新建后立刻保存）：没有编码信息就按 UTF-8 写
        write_text_file(&file, "你好，世界", None).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "你好，世界");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reads_images_as_data_urls_and_rejects_other_files() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        // 内容不重要，验的是 MIME 推断和 base64 编码；扩展名故意大写
        let raw = [0x89u8, b'P', b'N', b'G'];
        let image_path = workspace.join("shot.PNG");
        fs::write(&image_path, raw).unwrap();
        fs::write(workspace.join("a.txt"), "hi").unwrap();

        let image = read_image_at(&workspace_root(&state), image_path.to_str().unwrap()).unwrap();
        assert!(
            image.data.starts_with("data:image/png;base64,"),
            "{}",
            image.data
        );
        assert!(!image.too_large);
        let encoded = image.data.split_once(',').unwrap().1;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
            raw,
            "base64 不能丢字节"
        );

        // 文本文件不给预览：否则借这个命令能绕开 fs_read_file 的上限把二进制读出去
        let error = read_image_at(
            &workspace_root(&state),
            workspace.join("a.txt").to_str().unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("不是可预览的图片格式"), "{error}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn skips_oversized_images() {
        let (state, root) = temp_state();
        let workspace = workspace_root(&state);
        let big = workspace.join("big.png");
        fs::write(&big, vec![0u8; MAX_IMAGE_SIZE as usize + 1]).unwrap();

        let image = read_image_at(&workspace_root(&state), big.to_str().unwrap()).unwrap();
        assert!(image.too_large);
        assert!(image.data.is_empty(), "超限就别把内容编码出来");
        fs::remove_dir_all(&root).ok();
    }
}
