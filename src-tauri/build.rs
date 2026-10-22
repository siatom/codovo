use std::env;

/// release 构建的防线：`tauri_build` 会把环境变量 `TAURI_CONFIG` 当 json patch 合并进配置，
/// 一旦终端里残留了 build.rs 给 debug 用的那份 dev patch，release 就会静默产出
/// identifier 为 `com.codedock.dev`、图标是金色的「伪安装版」——数据目录和任务栏图标
/// 全跟着变，用户会以为工作区历史丢了。这里在动 tauri_build 之前直接失败，避免再默默产出。
fn reject_dev_overrides(patch: &serde_json::Value) {
    let identifier = patch.get("identifier").and_then(serde_json::Value::as_str);
    let dev_icon = patch
        .get("bundle")
        .and_then(|bundle| bundle.get("icon"))
        .and_then(serde_json::Value::as_array)
        .map(|icons| {
            icons
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|icon| icon.replace('\\', "/").starts_with("icons/dev/"))
        })
        .unwrap_or(false);

    if identifier == Some("com.codedock.dev") || dev_icon {
        panic!(
            "release 构建检测到 dev 配置覆盖（TAURI_CONFIG 里带 com.codedock.dev / icons/dev）。\n\
             这会产出 identifier 和图标都是 dev 的安装版，WebView 数据目录、任务栏图标、\
             工作区历史都会跟着变成 dev 的。\n\
             请清掉该环境变量后重新构建：PowerShell 用 Remove-Item Env:TAURI_CONFIG，\
             bash 用 unset TAURI_CONFIG。"
        );
    }
}

fn main() {
    let profile = env::var("PROFILE").unwrap_or_default();
    // 环境里可能残留 CLI 或上一次构建留下的 TAURI_CONFIG，先解析出来：
    // debug 要在此基础上叠加 dev 配置，release 则要拿它做污染检查。
    let overrides = env::var("TAURI_CONFIG")
        .ok()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .filter(serde_json::Value::is_object);

    if profile != "debug" {
        if let Some(overrides) = &overrides {
            reject_dev_overrides(overrides);
        }
    }

    tauri_build::build();

    // 单实例锁（tauri-plugin-single-instance）是按 app identifier 命名的：dev 版和安装版
    // 如果共用 tauri.conf.json 里那个 identifier，后启动的会被先启动的直接顶掉，「开着一个
    // 已安装的、再起一个 dev」就没法同时用。debug 构建给 identifier 加 `.dev` 后缀，两者
    // 各自单实例、互不干扰；release 保持原值，安装包和数据目录都不变。
    //
    // 走 TAURI_CONFIG：tauri-codegen 会把它当 json patch 合并到从 tauri.conf.json 读出的
    // 基础配置上（见 tauri-codegen 的 get_config）。CLI 自己也可能设了这个环境变量
    // （比如 --config），所以先读出来叠加，别整个覆盖掉。
    // cargo:rustc-env 只作用于编译本 crate 的那次 rustc，而 generate_context! 正是在那个
    // 进程里展开的，能读到。
    if profile == "debug" {
        let mut patch = overrides.unwrap_or_else(|| serde_json::json!({}));
        patch["identifier"] = serde_json::Value::String("com.codedock.dev".to_string());

        // dev 版图标换琥珀橙，跟安装版的蓝色尖括号一眼分清：exe 资源图标（任务栏 / 托盘）
        // 与窗口图标都取自 bundle.icon，指到 icons/dev/ 这一套即可。那套由
        // `npx tauri icon icons/icon-dev.svg -o icons/dev` 生成；release 仍用 icons/ 下的蓝色。
        // 逐层取对象再 insert，不整个覆盖 bundle，保留 CLI 可能设进去的其它字段。
        let root = patch.as_object_mut().expect("patch 在上一行已保证是对象");
        let bundle = root
            .entry("bundle")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(bundle) = bundle.as_object_mut() {
            bundle.insert(
                "icon".to_string(),
                serde_json::json!([
                    "icons/dev/32x32.png",
                    "icons/dev/128x128.png",
                    "icons/dev/128x128@2x.png",
                    "icons/dev/icon.icns",
                    "icons/dev/icon.ico"
                ]),
            );
        }

        println!("cargo:rustc-env=TAURI_CONFIG={patch}");
    }
}
