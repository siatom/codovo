//! 系统托盘：关掉窗口后程序还留在这儿，点图标能把主窗口唤回来。
//!
//! 三端行为有差异，别按一个平台的经验改：Linux 走 appindicator，**左键单击通常
//! 不派发事件**，那边只能靠右键菜单的「显示主窗口」；macOS 上理想是单色模板图，
//! 这里先复用应用图标（彩色），要不要换模板图再说。
//!
//! 悬停提示（tooltip）取自 `productName`，Windows / macOS 有效；Linux 的
//! appindicator 不提供 tooltip 接口，那边看不到属正常。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindow};

/// 把主窗口亮出来并抢焦点。托盘点击、macOS 点 Dock 图标都走这儿
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // 可能是被隐藏的、也可能只是最小化了，两种都还原一遍
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 建托盘。图标沿用应用图标（构建时从 `bundle.icon` 挑的那张），省得再配一份
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        // 鼠标悬停在托盘图标上时显示应用名（Windows / macOS 生效）
        .tooltip(app.package_info().name.clone())
        // 左键留给「唤回窗口」，菜单只走右键
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            // 必须走 app.exit：`RunEvent` 里那套清理才会跑到，shell / opencode
            // / 目录监听才收得干净，直接退进程会留下孤儿
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// 真正退出。和托盘里的「退出」是同一条路
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// 关窗但继续后台跑。前端在确认框里选了「最小化到托盘」时调
#[tauri::command]
pub fn app_hide_to_tray(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}
