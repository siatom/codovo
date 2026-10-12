// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(linker_messages)]

fn main() {
    // 数据库 Agent 的 MCP 工具服务：opencode 按 opencode.json 的 mcp.db 拉起本 exe 时走这条。
    // 必须在 Tauri 初始化之前分流，否则会多开一个窗口、还会去抢单实例锁
    if std::env::args().nth(1).as_deref() == Some("--mcp-db") {
        std::process::exit(codedock_lib::run_db_mcp());
    }
    // 应用助手的 MCP 工具服务（界面操作），同样在 Tauri 初始化之前分流
    if std::env::args().nth(1).as_deref() == Some("--mcp-app") {
        std::process::exit(codedock_lib::run_app_mcp());
    }
    // 预览助手的 MCP 工具服务（启动/停止项目预览），同样在 Tauri 初始化之前分流
    if std::env::args().nth(1).as_deref() == Some("--mcp-preview") {
        std::process::exit(codedock_lib::run_preview_mcp());
    }
    codedock_lib::run()
}
