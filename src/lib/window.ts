import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 用户点了窗口关闭按钮。后端把这一下拦了下来（`CloseRequested` 里 `prevent_close`），
 * 只把事件递过来——是收进托盘还是真退出，取决于当前开着几个项目，这事前端才知道。
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
