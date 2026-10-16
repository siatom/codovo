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
//! **一请求一文件**：预览助手是**每个工作区一个进程**（哨兵 root 按工作区区分），
//! 两个工作区的助手可能同时调工具，固定文件名（`request.json`）会互相覆盖，
//! 所以请求 / 响应都按调用 id 命名（`request-<id>.json` / `response-<id>.json`）。
//! 每条请求还会带上本进程所属的工作区（`CODEDOCK_PREVIEW_ROOT`），前端据此决定操作哪个项目。
//!
//! `initialize` 阶段不碰任何 I/O，连邮箱目录都不建——否则 opencode 默认 5s 的握手超时
//! 会把工具判成不可用。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::Manager;

use crate::app_agent::{
    error_response, next_request_id, ok_response, wait_response, write_json, AppAgentRequest,
    DEFAULT_PROTOCOL, WAIT_TIMEOUT,
};

/// 请求 / 响应文件名前缀。一请求一文件，避免多进程互相覆盖（见文件头说明）。
const REQUEST_PREFIX: &str = "request-";
const RESPONSE_PREFIX: &str = "response-";

/// 孤儿响应文件的保留时长：MCP 调用超时后前端才把结果写回，就留下没人取的响应文件，
/// 顺手清掉。等前端轮询时做，不另起线程。
const RESPONSE_TTL: Duration = Duration::from_secs(300);

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

/// 预览助手的哨兵 root 前缀。它不是工作区路径——后端据此把预览助手与终端区智能体分开，
/// 并**按工作区取不同哨兵**：每个工作区一个 slot、一个 opencode 进程，cwd 指向该工作区。
/// 前端 `lib/preview-agent.ts` 的 `previewAgentRoot` 与它对齐。
const AGENT_ROOT_PREFIX: &str = "__preview_agent__::";

/// 由工作区根拼出预览助手的哨兵 root。
pub fn agent_root(workspace_root: &str) -> String {
    format!("{AGENT_ROOT_PREFIX}{workspace_root}")
}

// ---- Tauri 命令 ----

/// 前端轮询用：取一条待执行的预览操作，没有就返回 null。
#[tauri::command]
pub fn preview_agent_take_request(
    app: tauri::AppHandle,
) -> Result<Option<AppAgentRequest>, String> {
    let dir = mailbox_dir(&app)?;
    prune_responses(&dir);
    take_request_in(&dir)
}

/// 前端执行完（或失败）后把结果写回，等着的 MCP 调用据此返回。
#[tauri::command]
pub fn preview_agent_respond(
    app: tauri::AppHandle,
    id: String,
    ok: bool,
    result: String,
) -> Result<(), String> {
    let dir = mailbox_dir(&app)?;
    write_json(
        &dir.join(format!("{RESPONSE_PREFIX}{id}.json")),
        &json!({ "id": id, "ok": ok, "result": result }),
    )
}

/// 取一条待执行的请求：扫邮箱里的 `request-*.json`，拿最早的。取走即删。
fn take_request_in(dir: &Path) -> Result<Option<AppAgentRequest>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // 目录还没建出来 = 没有任何请求，是常态
        Err(_) => return Ok(None),
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| has_prefix_suffix(path, REQUEST_PREFIX, ".json"))
        .collect();
    candidates.sort();
    let Some(path) = candidates.into_iter().next() else {
        return Ok(None);
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        // 拿不到就当没请求：多半是别的东西刚删了它，下一次轮询再说
        Err(_) => return Ok(None),
    };
    // 先删再解析：解析失败也不该反复重试同一条坏请求
    let _ = std::fs::remove_file(&path);
    match serde_json::from_str::<AppAgentRequest>(&text) {
        Ok(request) => Ok(Some(request)),
        Err(e) => Err(format!("解析预览操作请求失败: {e}")),
    }
}

/// 清掉没人来取的旧响应文件（详见 [`RESPONSE_TTL`]）。失败不报错，下次再试。
fn prune_responses(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !has_prefix_suffix(&path, RESPONSE_PREFIX, ".json") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .map(|age| age > RESPONSE_TTL)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn has_prefix_suffix(path: &Path, prefix: &str, suffix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with(prefix) && name.ends_with(suffix))
        .unwrap_or(false)
}

// ---- MCP stdio server ----

/// MCP server 入口。由 `main()` 在 Tauri 初始化之前调用，返回进程退出码。
pub fn run_stdio() -> i32 {
    let mailbox = std::env::var("CODEDOCK_PREVIEW_MAILBOX")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    // 这个助手属于哪个工作区。工具调用时一并转给前端（见 call_tool）。
    let workspace_root = std::env::var("CODEDOCK_PREVIEW_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty());

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
        let Some(response) = handle(mailbox.as_deref(), workspace_root.as_deref(), request) else {
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
fn handle(mailbox: Option<&Path>, workspace_root: Option<&str>, request: Value) -> Option<Value> {
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
            let outcome = call_tool(mailbox, workspace_root, &request);
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

/// 把工具调用投进邮箱，等前端执行完再拿结果。
///
/// 顺带把本进程所属的工作区（`workspace_root`）塞进参数：预览助手一个工作区一个进程，
/// 前端得知道该操作哪个项目。模型自己传了 `path` 时以它为准，不覆盖。
fn call_tool(
    mailbox: Option<&Path>,
    workspace_root: Option<&str>,
    request: &Value,
) -> Result<String, String> {
    let name = request
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut args = request
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let (Some(root), Value::Object(map)) = (workspace_root, &mut args) {
        map.entry("root".to_string()).or_insert_with(|| json!(root));
    }

    let dir = mailbox.ok_or("没有配置预览操作通道（缺少 CODEDOCK_PREVIEW_MAILBOX）")?;
    let id = next_request_id();
    let response_path = dir.join(format!("{RESPONSE_PREFIX}{id}.json"));
    // 先清掉自己的响应路径（理论上不存在），再写请求
    let _ = std::fs::remove_file(&response_path);
    write_json(
        &dir.join(format!("{REQUEST_PREFIX}{id}.json")),
        &json!({ "id": id, "tool": name, "args": args }),
    )?;

    wait_response(&response_path, &id, WAIT_TIMEOUT)
}

/// 工具清单。名字在 opencode 侧会带上 server 前缀（`preview_`）。
///
/// 每个工具都作用于**本助手所属的工作区**（后端启动时把该路径经 `CODEDOCK_PREVIEW_ROOT`
/// 交给本进程、调用时一并转给前端），所以参数里不再需要 path。
///
/// 真正执行在前端（见 `src/lib/preview-agent.ts`），这里只负责把参数原样投递过去。
fn tool_definitions() -> Value {
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
            "description": "启动预览进程：web 项目起 dev server、Tauri 项目起带 CDP 调试端口的 dev 实例。已在跑的先停掉。起不来时可以改 command / port 重试。",
            "inputSchema": {
                "type": "object",
                "properties": {
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
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "name": "status",
            "description": "查预览运行状态：是否在跑、地址 / CDP 调试端口、以及最近的进程日志。启动后确认是否就绪、或启动失败时定位原因，都看它返回的日志。",
            "inputSchema": {
                "type": "object",
                "properties": {},
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
            None,
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
        assert!(call_tool(None, None, &request).is_err());
    }

    #[test]
    fn take_request_picks_up_a_prefixed_request_and_removes_it() {
        let dir = std::env::temp_dir().join(format!(
            "codedock-preview-agent-take-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 没有请求时返回 None
        assert!(take_request_in(&dir).unwrap().is_none());

        // 固定文件名（别的 agent 用的）不该被认领
        write_json(&dir.join("request.json"), &json!({ "id": "x", "tool": "stop" })).unwrap();
        assert!(take_request_in(&dir).unwrap().is_none());

        write_json(
            &dir.join("request-7-1-1.json"),
            &json!({ "id": "r1", "tool": "start", "args": { "command": "pnpm dev" } }),
        )
        .unwrap();
        let taken = take_request_in(&dir).unwrap().unwrap();
        assert_eq!(taken.id, "r1");
        assert_eq!(taken.tool, "start");
        // 取走即删：同一条不会被处理两次
        assert!(take_request_in(&dir).unwrap().is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
