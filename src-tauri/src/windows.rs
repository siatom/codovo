//! 多窗口：一个窗口一个项目工作区，各自跑自己的终端与智能体。
//!
//! 为什么要一个登记表：窗口 label 是后端「这份状态属于谁」的唯一凭据（见各状态里的
//! 分片），而新建窗口时得先把根与监听播进对应 label 再建窗，前端一启动调 `fs_root`
//! 就能拿到自己的目录，不必把路径塞进 URL。

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::fs_api::FsState;
use crate::watcher::WatchState;

/// 窗口 label 分配器。
pub struct WindowRegistry {
    next: AtomicU32,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self {
            next: AtomicU32::new(1),
        }
    }

    /// 分配 label。**单调自增、永不复用**：关窗后各状态里的清理可能滞后一瞬，
    /// 复用会让新窗口捡到上一个窗口的残留状态。
    fn allocate(&self) -> String {
        format!("win-{}", self.next.fetch_add(1, Ordering::Relaxed))
    }
}

/// 在新窗口里打开一个项目。
///
/// 用后端建窗而不是前端 `WebviewWindow`：label 分配、根与监听的播种、建窗失败时的
/// 回滚要一气呵成，拆成两次 IPC 就会留下竞态；前端也不必申请建窗权限。
#[tauri::command]
pub async fn project_window_open(
    app: AppHandle,
    fs: tauri::State<'_, FsState>,
    watch: tauri::State<'_, WatchState>,
    registry: tauri::State<'_, WindowRegistry>,
    path: String,
) -> Result<String, String> {
    let target = std::path::PathBuf::from(&path);
    if !target.is_dir() {
        return Err(format!("不是有效的目录: {path}"));
    }

    let label = registry.allocate();
    // 先把根与监听播进去，新窗口的前端一启动就能读到
    let root = fs.set_root(&label, target)?;
    // 监听起不来不影响用（文件树还有刷新按钮），和 `fs_set_root` 一个态度
    let _ = watch.watch(app.clone(), &label, &root);

    // 前端地址不能自己拼：`WebviewUrl::App("index.html")` 在 dev 下实测会让新窗口停在
    // about:blank。主窗口那儿的地址一定是对的（dev 是 http://localhost:5273/，打包后是
    // tauri://localhost/），取它来用；不按 label 找主窗口，label 是 Tauri 内部定的。
    let frontend_url = app.webview_windows().values().find_map(|w| w.url().ok());
    let url = match frontend_url.clone() {
        Some(frontend) if matches!(frontend.scheme(), "http" | "https") => {
            WebviewUrl::External(frontend)
        }
        _ => WebviewUrl::App("index.html".into()),
    };

    let built = WebviewWindowBuilder::new(&app, &label, url)
        .title(format!("CodeDock — {}", window_title(&root)))
        // 新窗口不最大化：否则会把主窗口整个盖住；尺寸给个够用的默认值
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .build();

    let window = match built {
        Ok(window) => window,
        Err(reason) => {
            // 建窗失败要回滚，否则留下一个没人用的根和挂在后台的监听
            fs.remove(&label);
            watch.stop(&label);
            return Err(format!("打开窗口失败: {reason}"));
        }
    };

    // dev 下 builder 给的地址实测不一定生效（窗口会停在 about:blank），显式再导航
    // 一次兜住；打包后不存在 http 地址，不用走这一步。
    if let Some(frontend) = frontend_url.filter(|u| matches!(u.scheme(), "http" | "https")) {
        let _ = window.navigate(frontend);
    }
    Ok(label)
}

/// 窗口标题用目录名，取不到（比如盘符根）就退回完整路径
fn window_title(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string())
}
