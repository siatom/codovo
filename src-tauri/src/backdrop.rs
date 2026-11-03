//! 窗口背景效果：界面透明度低于 100% 时让整个窗口透出桌面。
//!
//! 真正的透明来自窗口本身——`tauri.conf.json` 里开了 `transparent: true`，Windows 上
//! tao 会用 DWM 的 blur-behind 空区域让窗口支持逐像素 alpha，macOS 的窗口透明本来就是
//! 真的。界面各层底色都按 CSS 变量 `--ui-alpha` 折算成 rgba（见 styles.css），桌面就
//! 透出来了。所以主界面的透明度**不能**再让系统接管整体 alpha：分层窗口（WS_EX_LAYERED
//! + LWA_ALPHA）会把整个窗口连文字一起按同一个 alpha 压扁，界面对比度一起塌，而且和
//! tao 已经设好的 blur-behind 打架，实测在 WebView2 上根本不生效。
//!
//! 这里只补平台特有的那一层：macOS 用 Vibrancy，Windows 用 Acrylic 给透明区域提供稳定的
//! 系统 backdrop。两者都不改窗口整体 alpha，文字仍按原来的不透明度绘制；Linux 交给桌面
//! 合成器处理。

use tauri::WebviewWindow;

/// 设置界面透明度（百分比）。低于 100 时给 macOS 铺毛玻璃，回到 100 时清掉。
///
/// dark 只影响 macOS 那层毛玻璃的着色，由界面按当前主题传进来
/// （选「跟随系统」时前端给的也已经是解析后的深浅色）。
#[tauri::command]
pub fn window_set_transparency(
    window: WebviewWindow,
    percent: u8,
    dark: bool,
) -> Result<(), String> {
    let percent = percent.clamp(0, 100);

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{
            apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
        };

        let _ = dark;
        // 不透明时把毛玻璃清掉，窗口恢复成普通实心窗口
        if percent >= 100 {
            let _ = clear_vibrancy(&window);
            return Ok(());
        }
        apply_vibrancy(
            &window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            None,
        )
        .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, clear_acrylic};

        if percent >= 100 {
            let _ = clear_acrylic(&window);
            return Ok(());
        }

        // Acrylic 只承接 CSS 透明层背后的桌面；真正的深浅与透明度由前端各层背景控制。
        // alpha 不能是 0（Windows 的 Acrylic API 会忽略它），所以保留一个最小 tint。
        let tint = if dark { (6, 8, 11, 1) } else { (255, 255, 255, 1) };
        apply_acrylic(&window, Some(tint)).map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let _ = (&window, percent, dark);
    }

    Ok(())
}
