// 直接编译生产模块，在 Windows CI 验证进程清理而无需安装 Tauri 的 GUI 构建环境。
#[allow(dead_code)]
#[path = "../../src-tauri/src/launch.rs"]
mod launch;
#[allow(dead_code)]
#[path = "../../src-tauri/src/cli_sessions/opencode_process.rs"]
mod opencode_process;
