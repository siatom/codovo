use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// 文本类操作（读文件、看差异）的大小上限，两个模块共用
pub(crate) const MAX_TEXT_SIZE: u64 = 2 * 1024 * 1024;

/// 二进制判定：只看前 8192 字节里有没有 NUL。
/// 完整读一遍大文件再判断不值得，这个启发式对源码仓库够准。
pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8192)].contains(&0)
}

/// 工作区根目录。启动时为空——由用户显式选目录（或前端恢复上次的选择），
/// 没选之前所有文件操作都拒绝执行。
pub struct FsState {
    root: Mutex<Option<PathBuf>>,
}

impl FsState {
    pub fn new() -> Self {
        Self {
            root: Mutex::new(None),
        }
    }

    /// 给同 crate 的 git 模块复用：git 也只认这一个工作区根
    pub(crate) fn root(&self) -> Result<PathBuf, String> {
        self.root
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "尚未选择工作目录".to_string())
    }

    /// 设置工作区根，并统一 canonical 化。
    /// 存进去的路径带不带 `\\?\` 前缀、大小写对不对，会直接决定 `resolve`
    /// 的前缀校验过不过，所以不能在调用处各写各的。
    pub(crate) fn set_root(&self, path: PathBuf) -> Result<PathBuf, String> {
        let target = canonical(path);
        *self.root.lock().map_err(|e| e.to_string())? = Some(target.clone());
        Ok(target)
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
fn simplify(path: PathBuf) -> PathBuf {
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

/// 前端传来的路径一律视为不可信：解析后必须落在工作区根内。
///
/// 已存在的路径直接 canonicalize（会跟随软链接，能挡住"工作区里放一个指向
/// 外部的软链接"这种逃逸）。路径（或它的若干层父目录）还不存在时，向上找到
/// 最近存在的祖先 canonicalize 它，再把缺的那几段词法拼回去：`git status`
/// 会报出整个目录被删后的 `dir/a.txt`，那时 `dir` 已经不存在了，坚持"父目录
/// 必须存在"会让删除类改动完全没法提交。安全性不变——存在的那一段照样
/// canonicalize，软链接逃逸还是被挡在外面。
pub(crate) fn resolve(state: &FsState, raw: &str) -> Result<PathBuf, String> {
    let root = state.root()?;
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
                probe = probe
                    .parent()
                    .ok_or_else(|| format!("非法路径: {raw}"))?;
            }
        }
    };

    let mut target = base;
    for name in missing.iter().rev() {
        target.push(name);
    }

    if target != root && !target.starts_with(&root) {
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    text: String,
    is_binary: bool,
    too_large: bool,
}

#[tauri::command]
pub fn fs_root(state: tauri::State<'_, FsState>) -> Result<Option<String>, String> {
    let root = state.root.lock().map_err(|e| e.to_string())?;
    Ok(root.as_ref().map(|p| display(p)))
}

#[tauri::command]
pub fn fs_set_root(state: tauri::State<'_, FsState>, path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if !target.is_dir() {
        return Err(format!("不是有效的目录: {path}"));
    }
    Ok(display(&state.set_root(target)?))
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
        entries.push(Entry {
            name,
            path: display(&item_path),
            is_dir,
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
pub fn fs_list_dir(state: tauri::State<'_, FsState>, path: String) -> Result<Vec<Entry>, String> {
    let dir = resolve(&state, &path)?;
    list_entries(&dir)
}

/// 搜索时整个跳过的目录名（小写比较）。这些目录动辄几万个文件，
/// 不跳过一次搜索就能把界面卡住。
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

/// 一次最多返回多少条。再多前端也画不动，而且用户不会往下翻。
const MAX_HITS: usize = 300;

/// 最多看多少个目录项就收手：极端情况下（巨大的仓库、命中极少）
/// 不能让这个线程一直跑下去。
const MAX_VISITS: usize = 100_000;

/// 按文件名递归搜工作区，大小写不敏感的子串匹配。只返回文件，不返回目录。
#[tauri::command(async)]
pub fn fs_search_files(
    state: tauri::State<'_, FsState>,
    query: String,
) -> Result<Vec<String>, String> {
    let root = state.root()?;
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
    // 显式栈而不是递归：目录嵌套很深时不会把调用栈压爆
    let mut stack = vec![root.to_path_buf()];
    let mut visits = 0usize;

    while let Some(dir) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for item in read.flatten() {
            visits += 1;
            if visits > MAX_VISITS || hits.len() >= MAX_HITS {
                hits.sort();
                return hits;
            }

            // file_type() 是 lstat 语义，不跟随软链接：指向外面的软链接目录
            // 不会被当成目录走下去，顺带挡掉循环链接
            let Ok(kind) = item.file_type() else {
                continue;
            };
            let name = item.file_name().to_string_lossy().to_string();

            if kind.is_dir() {
                if !SKIP_DIRS.contains(&name.to_lowercase().as_str()) {
                    stack.push(item.path());
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            if name.to_lowercase().contains(&needle) {
                hits.push(display(&item.path()));
            }
        }
    }

    // 遍历顺序取决于目录项的返回顺序，排一下让同样的查询给出同样的结果
    hits.sort();
    hits
}

#[tauri::command]
pub fn fs_read_file(state: tauri::State<'_, FsState>, path: String) -> Result<FileContent, String> {
    let file = resolve(&state, &path)?;
    let meta = fs::metadata(&file).map_err(|e| format!("读取文件失败 {}: {e}", display(&file)))?;

    if meta.len() > MAX_TEXT_SIZE {
        return Ok(FileContent {
            text: String::new(),
            is_binary: false,
            too_large: true,
        });
    }

    let bytes = fs::read(&file).map_err(|e| format!("读取文件失败 {}: {e}", display(&file)))?;
    if looks_binary(&bytes) {
        return Ok(FileContent {
            text: String::new(),
            is_binary: true,
            too_large: false,
        });
    }

    Ok(FileContent {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        is_binary: false,
        too_large: false,
    })
}

#[tauri::command]
pub fn fs_write_file(
    state: tauri::State<'_, FsState>,
    path: String,
    text: String,
) -> Result<(), String> {
    let file = resolve(&state, &path)?;
    fs::write(&file, text).map_err(|e| format!("写入文件失败 {}: {e}", display(&file)))
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
        let root = std::env::temp_dir().join(format!("codedock-test-{}-{unique}", std::process::id()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let state = FsState::new();
        state.set_root(workspace).unwrap();
        (state, root)
    }

    #[test]
    fn rejects_everything_before_a_workspace_is_chosen() {
        let state = FsState::new();
        assert!(resolve(&state, "D:\\anything.txt").is_err());
        assert!(state.root().is_err());
    }

    #[test]
    fn rejects_parent_traversal() {
        let (state, root) = temp_state();
        let outside = root.join("secret.txt");
        assert!(resolve(&state, outside.to_str().unwrap()).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn allows_new_file_inside_root() {
        let (state, root) = temp_state();

        // 父目录还不存在也放行：git 报出的"整个目录被删"就是这个形状
        // （`D src/old/a.txt`，而 src/old 已经没了），拦在这里会让删除类改动
        // 没法暂存。真正的失败留给 OS——写文件时父目录不存在会报错。
        let nested = state.root().unwrap().join("nested").join("new.txt");
        assert_eq!(resolve(&state, nested.to_str().unwrap()).unwrap(), nested);

        let flat = state.root().unwrap().join("new.txt");
        assert_eq!(resolve(&state, flat.to_str().unwrap()).unwrap(), flat);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn lists_dotfiles_and_puts_dirs_first() {
        let (state, root) = temp_state();
        let workspace = state.root().unwrap();
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
    fn searches_file_names_and_skips_heavy_dirs() {
        let (state, root) = temp_state();
        let workspace = state.root().unwrap();
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src").join("Main.rs"), "").unwrap();
        fs::write(workspace.join("README.md"), "").unwrap();
        fs::create_dir_all(workspace.join("node_modules").join("pkg")).unwrap();
        fs::write(workspace.join("node_modules").join("pkg").join("main.js"), "").unwrap();

        let hits = search_files(&workspace, "main");
        assert_eq!(hits.len(), 1, "只该命中 src/Main.rs: {hits:?}");
        assert!(hits[0].ends_with("Main.rs"), "命中的路径不对: {hits:?}");

        assert_eq!(search_files(&workspace, "readme").len(), 1, "应该大小写不敏感");
        assert!(search_files(&workspace, "src").is_empty(), "目录不该算命中");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn search_ignores_an_empty_needle() {
        let (state, root) = temp_state();
        let workspace = state.root().unwrap();
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
        let linked = std::os::unix::fs::symlink(&outside, state.root().unwrap().join("link")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, state.root().unwrap().join("link")).is_ok();

        // 建软链接通常需要权限，建不出来就跳过
        if linked {
            let escaping = state.root().unwrap().join("link").join("pwned.txt");
            assert!(resolve(&state, escaping.to_str().unwrap()).is_err());

            // 向上找祖先不能变成绕过前缀校验的后门：软链接下面的目录不存在时，
            // 拼回去的路径落在工作区外，照样要拒绝
            let deeper = state.root().unwrap().join("link").join("missing").join("pwned.txt");
            assert!(resolve(&state, deeper.to_str().unwrap()).is_err());
        }
        fs::remove_dir_all(&root).ok();
    }
}
