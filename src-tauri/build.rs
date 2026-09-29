use std::env;

fn main() {
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
    if env::var("PROFILE").as_deref() == Ok("debug") {
        let mut patch = env::var("TAURI_CONFIG")
            .ok()
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
            .filter(serde_json::Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}));
        patch["identifier"] = serde_json::Value::String("com.codedock.dev".to_string());
        println!("cargo:rustc-env=TAURI_CONFIG={patch}");
    }
}
