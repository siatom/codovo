//! 自绘标题栏要用的窗口操作。
//!
//! 去掉系统标题栏（`decorations: false`）后，拖动、双击最大化、右键系统菜单、
//! 最小化 / 最大化 / 关闭这些原本由系统处理的动作都得由界面自己发起。这里只做一层
//! 薄封装——组件不直接 invoke，统一走 `src/lib/window.ts`。
//!
//! 关闭刻意走 `window.close()`：它在 Windows 上就是一条 `WM_CLOSE`，于是和点系统
//! 关闭按钮完全同一条路（后端拦下 `CloseRequested`、问前端「收进托盘还是退出」）。

use tauri::WebviewWindow;

/// 最小化。窗口进任务栏，终端与智能体照跑
#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

/// 最大化 / 还原。返回切换后的状态，界面据此换按钮图标，省得再问一次
#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    Ok(!maximized)
}

/// 当前是不是最大化。拖拽贴边、Win+↑、系统菜单这些不经过界面的操作会改状态，
/// 界面只在窗口尺寸变化时回来问一次
#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

/// 关窗。走 `WM_CLOSE`，后续由 `on_window_event` 里的 `CloseRequested` 接手
#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

/// 标题栏右键：弹系统菜单（还原 / 移动 / 大小 / 最小化 / 最大化 / 关闭）。
///
/// 菜单项的状态由系统维护（`WM_INITMENUPOPUP`），所以最大化时「最大化」「移动」
/// 「大小」会自己变灰，和系统标题栏一致。
///
/// **必须是同步命令**：`TrackPopupMenuEx` 要跑在拥有窗口的消息循环线程上，而且会
/// 阻塞到菜单关闭——Tauri 的同步命令正好在主线程执行。
#[tauri::command]
pub fn window_show_system_menu(window: WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        show_system_menu(&window)
    }
    // macOS / Linux 没有「窗口系统菜单」这个概念，标题栏右键不响应
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("当前平台没有窗口系统菜单".into())
    }
}

#[cfg(windows)]
fn show_system_menu(window: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetSystemMenu, PostMessageW, SetForegroundWindow, TrackPopupMenuEx,
        TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_NULL, WM_SYSCOMMAND,
    };

    // tauri 用 windows crate 的 HWND（新类型），windows-sys 这边是裸指针别名，转一手即可
    let raw = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd: HWND = raw.0 as _;

    unsafe {
        let menu = GetSystemMenu(hwnd, 0);
        if menu.is_null() {
            return Err("这个窗口没有系统菜单".into());
        }
        let mut cursor = POINT::default();
        if GetCursorPos(&mut cursor) == 0 {
            return Err("取不到鼠标位置".into());
        }
        // 系统菜单的老规矩：弹之前先把窗口提到前台，否则点菜单外面关掉后，
        // 第一次点击会被这次菜单吞掉
        SetForegroundWindow(hwnd);
        let command = TrackPopupMenuEx(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            cursor.x,
            cursor.y,
            hwnd,
            std::ptr::null(),
        );
        PostMessageW(hwnd, WM_NULL, 0, 0);
        if command != 0 {
            // 交回系统处理：SC_CLOSE 会走 CloseRequested，SC_MOVE / SC_SIZE 进入
            // 方向键调整模式，和系统标题栏右键选同一项的表现一样
            PostMessageW(hwnd, WM_SYSCOMMAND, command as usize, 0);
        }
    }
    Ok(())
}
