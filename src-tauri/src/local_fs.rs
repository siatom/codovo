use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 远程连接的「本地文件」面板用的命令。
///
/// 和 `fs_api` 的区别：这里**不查工作区白名单**——本地面板要像 WinSCP 那样自由
/// 浏览整个文件系统（主目录起、可向上越出、能切盘符），路径本来就在工作区之外。
/// 安全性上可接受：这是本地桌面应用、前端就是应用本体，而且 `sftp_download`
/// 本就往任意本地路径写文件。这几个命令只做文件管理，不做内容编辑。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// 目录一律给 0，前端也不显示
    size: u64,
    /// 秒级 Unix 时间戳，0 表示未知。刻意和 `SftpEntry` 对齐，前端共用格式化函数
    mtime: u64,
}

fn display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// 文件名合法性：只允许一段名字，挡掉分隔符和 `.` / `..`。
/// 与 `fs_api::validate_name` 同规则——本地面板的新建 / 改名也要挡这些。
fn validate_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("名称无效".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn local_home() -> Result<String, String> {
    crate::pty::home_dir()
        .map(|dir| display(&dir))
        .ok_or_else(|| "定位用户主目录失败".to_string())
}

/// 文件系统的顶层入口。Windows 是盘符列表（探测 A:\ … Z:\ 哪些存在，不引 winapi），
/// 其它平台就是根目录。前端面包屑的第一段「此电脑」点开就是这里。
fn roots() -> Vec<LocalEntry> {
    #[cfg(windows)]
    {
        let mut out = Vec::new();
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).exists() {
                out.push(LocalEntry {
                    name: root.clone(),
                    path: root,
                    is_dir: true,
                    size: 0,
                    mtime: 0,
                });
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        vec![LocalEntry {
            name: "/".to_string(),
            path: "/".to_string(),
            is_dir: true,
            size: 0,
            mtime: 0,
        }]
    }
}

fn list_local(dir: &Path) -> Result<Vec<LocalEntry>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}: {e}", display(dir)))?;

    let mut entries = Vec::new();
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let item_path = item.path();
        let meta = item.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = match &meta {
            Some(m) if !is_dir => m.len(),
            _ => 0,
        };
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(LocalEntry {
            name,
            path: display(&item_path),
            is_dir,
            size,
            mtime,
        });
    }

    // 目录优先，同类按名字排（大小写不敏感），和远程面板一致
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 列目录。`path` 传空串表示「此电脑」那一层（Windows 盘符列表 / Unix 根）。
#[tauri::command]
pub fn local_list_dir(path: String) -> Result<Vec<LocalEntry>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(roots());
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_dir() {
        return Err(format!("不是有效的目录: {trimmed}"));
    }
    list_local(&dir)
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "目录名无效".to_string())?;
    validate_name(name)?;
    if target.exists() {
        return Err(format!("目标已存在: {}", display(&target)));
    }
    let parent = target.parent().ok_or_else(|| "父目录无效".to_string())?;
    if !parent.is_dir() {
        return Err(format!("父目录不存在: {}", display(parent)));
    }
    // 只建一层，和 fs_api 的 create_directory 一致
    fs::create_dir(&target).map_err(|e| format!("创建文件夹失败 {}: {e}", display(&target)))
}

/// 就地改名。`new_name` 只是一段名字（validate_name 挡掉分隔符），返回新路径。
#[tauri::command]
pub fn local_rename(path: String, new_name: String) -> Result<String, String> {
    validate_name(&new_name)?;
    let source = PathBuf::from(path.trim());
    if !source.exists() {
        return Err(format!("路径不存在: {}", display(&source)));
    }
    let parent = source.parent().ok_or_else(|| "父目录无效".to_string())?;
    let target = parent.join(new_name.trim());
    if target == source {
        return Ok(display(&target));
    }
    // Windows 大小写不敏感：只改大小写时 exists() 会说"已存在"，但那是它自己
    let occupied = target.exists()
        && target.to_string_lossy().to_lowercase() != source.to_string_lossy().to_lowercase();
    if occupied {
        return Err(format!("目标已存在: {}", display(&target)));
    }
    fs::rename(&source, &target).map_err(|e| format!("重命名失败 {}: {e}", display(&source)))?;
    Ok(display(&target))
}

/// 删除文件或整个目录（递归）。**不可撤销**，前端必须先确认。
#[tauri::command]
pub fn local_remove(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if !target.exists() {
        return Err(format!("路径不存在: {}", display(&target)));
    }
    // 盘符根 / Unix 根没有父目录，绝不能整个删掉
    if target.parent().is_none() {
        return Err("不能删除文件系统根目录".to_string());
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("删除失败 {}: {e}", display(&target)))
    } else {
        fs::remove_file(&target).map_err(|e| format!("删除失败 {}: {e}", display(&target)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_rejects_separators_and_dots() {
        assert!(validate_name("a.txt").is_ok());
        assert!(validate_name("  ").is_err());
        assert!(validate_name(".").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
    }

    #[test]
    fn roots_are_usable_directories() {
        let list = roots();
        assert!(!list.is_empty());
        for entry in &list {
            assert!(entry.is_dir);
            assert!(!entry.path.is_empty());
            assert!(Path::new(&entry.path).is_dir());
        }
    }
}
