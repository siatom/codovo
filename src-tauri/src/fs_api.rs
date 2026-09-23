use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

const MAX_TEXT_SIZE: u64 = 2 * 1024 * 1024;

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
/// 外部的软链接"这种逃逸）；尚不存在的路径 canonicalize 它的父目录再拼文件名，
/// 否则 `工作区/软链接目录/新文件` 会绕过前缀检查。
fn resolve(state: &FsState, raw: &str) -> Result<PathBuf, String> {
    let root = state.root()?;
    let candidate = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };
    let candidate = normalize(&candidate);

    let target = match candidate.canonicalize() {
        Ok(real) => simplify(real),
        Err(_) => {
            let parent = candidate
                .parent()
                .ok_or_else(|| format!("非法路径: {raw}"))?;
            let real_parent = parent
                .canonicalize()
                .map(simplify)
                .map_err(|_| format!("目录不存在: {}", display(parent)))?;
            match candidate.file_name() {
                Some(name) => real_parent.join(name),
                None => real_parent,
            }
        }
    };

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
    let target = canonical(PathBuf::from(&path));
    if !target.is_dir() {
        return Err(format!("不是有效的目录: {path}"));
    }
    let mut root = state.root.lock().map_err(|e| e.to_string())?;
    *root = Some(target.clone());
    Ok(display(&target))
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
    let probe = &bytes[..bytes.len().min(8192)];
    if probe.contains(&0) {
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
        *state.root.lock().unwrap() = Some(canonical(workspace));
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
        let target = state.root().unwrap().join("nested").join("new.txt");
        // nested 不存在时应该直接报错，而不是放行
        assert!(resolve(&state, target.to_str().unwrap()).is_err());

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
        }
        fs::remove_dir_all(&root).ok();
    }
}
