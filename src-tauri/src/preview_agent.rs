//! CodeDock「预览助手」的 MCP 工具服务（stdio 传输）。
//!
//! opencode 通过 `opencode.json` 的 `mcp.preview` 拉起它（`codedock.exe --mcp-preview`），
//! 走标准 MCP stdio 协议（换行分隔的 JSON-RPC 2.0）。
//!
//! **为什么走文件邮箱桥**：预览进程池的唯一事实来源是主进程的 `preview::PreviewState`
//! （右栏 iframe 的地址、日志、启停状态都靠它），而本进程是 opencode 拉起的**独立子进程**，
//! 够不着；预览助手还要把右栏切到「预览」模块，也只有前端能做。所以这里只做「传话」：
//! 把工具调用写成请求文件，前端轮询取走 → 调 `preview_start` 等命令 → 写回结果。
//! 邮箱文件与 `app_agent` 同一套做法（临时文件 + rename 原子写），只是目录不同。
//!
//! `initialize` 阶段不碰任何 I/O，连邮箱目录都不建——否则 opencode 默认 5s 的握手超时
//! 会把工具判成不可用。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::Manager;

use crate::app_agent::{
    call_tool, error_response, ok_response, respond_at, take_request_at, AppAgentRequest,
    DEFAULT_PROTOCOL, REQUEST_FILE, RESPONSE_FILE,
};

/// 预览助手邮箱目录。和 app / db 的邮箱一样刻意放在 opencode 配置目录**之外**：
/// 那个目录在停服务时会被整个 `remove_dir_all` 掉。
pub(crate) fn mailbox_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("拿不到配置目录: {e}"))?
        .join("preview-agent");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(dir)
}

// ---- Tauri 命令 ----

/// 前端轮询用：取一条待执行的预览操作，没有就返回 null。
#[tauri::command]
pub fn preview_agent_take_request(
    app: tauri::AppHandle,
) -> Result<Option<AppAgentRequest>, String> {
    take_request_at(&mailbox_dir(&app)?.join(REQUEST_FILE))
}

/// 前端执行完（或失败）后把结果写回，等着的 MCP 调用据此返回。
#[tauri::command]
pub fn preview_agent_respond(
    app: tauri::AppHandle,
    id: String,
    ok: bool,
    result: String,
) -> Result<(), String> {
    respond_at(&mailbox_dir(&app)?.join(RESPONSE_FILE), &id, ok, &result)
}

// ---- MCP stdio server ----

/// MCP server 入口。由 `main()` 在 Tauri 初始化之前调用，返回进程退出码。
pub fn run_stdio() -> i32 {
    let mailbox = std::env::var("CODEDOCK_PREVIEW_MAILBOX")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);

    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return 0, // 对端关了 stdin
            Ok(_) => {}
            Err(error) => {
                eprintln!("preview-mcp: 读 stdin 失败: {error}");
                return 1;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("preview-mcp: 解析请求失败: {error}");
                continue;
            }
        };
        let Some(response) = handle(mailbox.as_deref(), request) else {
            continue;
        };
        let text = match serde_json::to_string(&response) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("preview-mcp: 序列化响应失败: {error}");
                continue;
            }
        };
        if writeln!(out, "{text}").and_then(|_| out.flush()).is_err() {
            return 1;
        }
    }
}

/// 处理一条 JSON-RPC 请求；通知（没有 id）返回 None（不回响应）。
fn handle(mailbox: Option<&Path>, request: Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");

    match method {
        "initialize" => {
            let protocol = request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL);
            let result = json!({
                "protocolVersion": protocol,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "codedock-preview", "version": env!("CARGO_PKG_VERSION") },
            });
            Some(ok_response(id, result))
        }
        "notifications/initialized" => None,
        "ping" => Some(ok_response(id, json!({}))),
        "tools/list" => Some(ok_response(id, json!({ "tools": tool_definitions() }))),
        "tools/call" => {
            let outcome = call_tool(mailbox, &request);
            let result = match outcome {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(message) => json!({
                    "content": [{ "type": "text", "text": format!("错误：{message}") }],
                    "isError": true,
                }),
            };
            Some(ok_response(id, result))
        }
        other => id.map(|id| error_response(id, -32601, &format!("未知方法: {other}"))),
    }
}

/// 工具清单。名字在 opencode 侧会带上 server 前缀（`preview_`）。
///
/// 真正执行在前端（见 `src/lib/preview-agent.ts`），这里只负责把参数原样投递过去。
fn tool_definitions() -> Value {
    let path_prop = json!({
        "type": "string",
        "description": "工作目录的绝对路径，省略表示当前活动工作区"
    });
    json!([
        {
            "name": "detect",
            "description": "探测当前工作区是什么项目（web / Tauri 桌面）、该用什么命令启动、大概在哪个端口。启动预览前先调它，按 reason 判断依据决定要不要改命令。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "name": "start",
            "description": "启动预览进程：web 项目起 dev server、Tauri 项目起带 CDP 调试端口的 dev 实例，并把右栏切到「预览」模块。已在跑的先停掉。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path_prop.clone(),
                    "command": { "type": "string", "description": "自定义启动命令，省略则用探测结果" },
                    "port": { "type": "number", "description": "端口，省略则用探测结果" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "stop",
            "description": "停止预览进程。",
            "inputSchema": {
                "type": "object",
                "properties": { "path": path_prop.clone() },
                "additionalProperties": false
            }
        },
        {
            "name": "status",
            "description": "查预览运行状态：是否在跑、地址 / CDP 调试端口、最近日志。",
            "inputSchema": {
                "type": "object",
                "properties": { "path": path_prop },
                "additionalProperties": false
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_cover_the_expected_actions() {
        let tools = tool_definitions();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["detect", "start", "stop", "status"]);
        // detect 不该要任何参数
        let detect = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "detect")
            .unwrap();
        assert!(detect["inputSchema"]["properties"]
            .as_object()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn initialize_answers_without_touching_the_mailbox() {
        // 握手必须立刻回：给一个根本不存在的邮箱目录，也不能出错、更不能去建它
        let missing = std::env::temp_dir().join("codedock-preview-agent-never-created");
        let _ = std::fs::remove_dir_all(&missing);
        let response = handle(
            Some(&missing),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2024-11-05" } }),
        )
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(response["result"]["serverInfo"]["name"], "codedock-preview");
        assert!(!missing.exists());
    }

    #[test]
    fn call_tool_without_a_mailbox_fails_fast() {
        let request = json!({ "params": { "name": "detect", "arguments": {} } });
        assert!(call_tool(None, &request).is_err());
    }
}
