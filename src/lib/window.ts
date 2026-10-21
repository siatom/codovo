import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 用户点了窗口关闭按钮。后端把这一下拦了下来（`CloseRequested` 里 `prevent_close`），
 * 只把事件递过来——是收进托盘还是真退出，取决于当前开着几个工作区，这事前端才知道。
 */
export function onCloseRequested(handler: () => void): Promise<UnlistenFn> {
  return listen("app://close-requested", () => handler());
}

/** 真正退出：后端在 `RunEvent` 里会顺手收掉 shell、opencode 与目录监听 */
export function quitApp(): Promise<void> {
  return invoke("app_quit");
}

/** 只关窗口，程序继续在托盘里跑；终端与智能体不受影响 */
export function hideToTray(): Promise<void> {
  return invoke("app_hide_to_tray");
}

/* ---------- 自绘标题栏的窗口按钮 ---------- */
/* 系统标题栏去掉了（`decorations: false`），这些动作由界面发起。
   拖动与双击最大化不在这里：它们由 `data-tauri-drag-region` 交给系统处理，
   这样贴边分屏、拖回还原等原生行为才留得住。 */

/** 最小化到任务栏 */
export function minimizeWindow(): Promise<void> {
  return invoke("window_minimize");
}

/** 最大化 / 还原。返回切换后的状态，用来换按钮图标 */
export function toggleMaximizeWindow(): Promise<boolean> {
  return invoke("window_toggle_maximize");
}

/** 当前是否最大化。系统侧的操作（拖拽贴边、Win+↑、系统菜单）会改它 */
export function isWindowMaximized(): Promise<boolean> {
  return invoke("window_is_maximized");
}

/** 关闭窗口。和点系统关闭按钮同一条路：后端拦下后问「收进托盘还是退出」 */
export function closeWindow(): Promise<void> {
  return invoke("window_close");
}

/** 标题栏右键：弹系统菜单（还原 / 移动 / 大小 / 最小化 / 最大化 / 关闭） */
export function showWindowSystemMenu(): Promise<void> {
  return invoke("window_show_system_menu");
}
