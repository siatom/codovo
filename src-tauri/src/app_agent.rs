//! Codovo「应用助手」的 MCP 工具服务（stdio 传输）。
//!
//! opencode 通过 `opencode.json` 的 `mcp.app` 拉起它（`codovo.exe --mcp-app`），
//! 走标准 MCP stdio 协议（换行分隔的 JSON-RPC 2.0）。
//!
//! **为什么不能像数据库 Agent 那样直接干活**：数据库 Agent 的操作对象（库）在进程外
//! 可达，而这个 Agent 要改的东西——设置（`codovo.settings`）、工作区列表
//! （`codovo.workspaceList`）、右栏模块与全屏状态——全都在**前端 WebView** 里
//! （localStorage + React state）。本进程是 opencode 拉起的**独立子进程**，够不着。
//!
//! 所以这里只做「传话」：把工具调用写成一个请求文件，由前端轮询取走、执行、再把结果
//! 写回来（目录由 `CODOVO_APP_MAILBOX` 指定）。选文件邮箱而不是「主进程转发」，是为了
//! 和既有的 `db_agent` 目标文件同一套做法（临时文件 + rename 原子写、不引入常驻监听或
//! 端口），改动最小；代价是前端要挂一个 500ms 的轮询，只是读一个小文件，可以接受。
//!
//! `initialize` 阶段不碰任何 I/O，连邮箱目录都不建——否则 opencode 默认 5s 的握手超时
//! 会把工具判成不可用。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 客户端没给 protocolVersion 时的兜底版本。
pub(crate) const DEFAULT_PROTOCOL: &str = "2025-06-18";

/// 等前端执行完的时限。要**短于** opencode.json 里给这个 MCP 配的 `timeout`（120s），
/// 否则超时那一下是 opencode 掐断的、错误文案没法自己写。留出来的 10s 给往返。
pub(crate) const WAIT_TIMEOUT: Duration = Duration::from_secs(110);

/// 轮询响应文件的间隔。前端那边是 500ms 一轮，这里密一点免得白等一个整周期。
const POLL_INTERVAL: Duration = Duration::from_millis(80);

/// 请求文件 / 响应文件名，和前端 `lib/app-agent.ts` 对齐。
pub(crate) const REQUEST_FILE: &str = "request.json";
pub(crate) const RESPONSE_FILE: &str = "response.json";

/// 请求 id 的自增段，配合 pid 与纳秒保证唯一。
static REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

// ---- 邮箱文件（MCP 子进程写请求、读响应；前端反过来）----

/// 界面操作邮箱目录。和 `db_agent` 的 target 文件一样刻意放在 opencode 配置目录
/// **之外**：那个目录在停服务时会被整个 `remove_dir_all` 掉。
pub(crate) fn mailbox_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("拿不到配置目录: {e}"))?
        .join("app-agent");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(dir)
}

/// 原子写一个 JSON 文件：先写临时文件再 rename，免得对端正好读到半截内容。
pub(crate) fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写入失败: {e}"))
}

/// 前端取走一条待执行的界面操作请求。没有就返回 None；取走即删除，同一条不会被处理两次。
pub(crate) fn take_request_at(path: &Path) -> Result<Option<AppAgentRequest>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        // 不存在是常态（绝大多数轮询都没有请求）
        Err(_) => return Ok(None),
    };
    // 先删再解析：解析失败也不该反复重试同一条坏请求
    let _ = std::fs::remove_file(path);
    match serde_json::from_str::<AppAgentRequest>(&text) {
        Ok(request) => Ok(Some(request)),
        Err(e) => Err(format!("解析界面操作请求失败: {e}")),
    }
}

/// 前端把执行结果写回去。
pub(crate) fn respond_at(path: &Path, id: &str, ok: bool, result: &str) -> Result<(), String> {
    write_json(path, &json!({ "id": id, "ok": ok, "result": result }))
}

// ---- Tauri 命令 ----

/// 前端轮询用：取一条待执行的界面操作，没有就返回 null。
#[tauri::command]
pub fn app_agent_take_request(
    app: tauri::AppHandle,
) -> Result<Option<AppAgentRequest>, String> {
    take_request_at(&mailbox_dir(&app)?.join(REQUEST_FILE))
}

/// 前端执行完（或确认被拒）后把结果写回，等着的 MCP 调用据此返回。
#[tauri::command]
pub fn app_agent_respond(
    app: tauri::AppHandle,
    id: String,
    ok: bool,
    result: String,
) -> Result<(), String> {
    respond_at(&mailbox_dir(&app)?.join(RESPONSE_FILE), &id, ok, &result)
}

/// 一条界面操作请求。`tool` 是 MCP 工具名（不带 `app_` 前缀），`args` 原样透传。
#[derive(Debug, Serialize, Deserialize)]
pub struct AppAgentRequest {
    pub id: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
}

// ---- MCP stdio server ----

/// MCP server 入口。由 `main()` 在 Tauri 初始化之前调用，返回进程退出码。
///
/// 全程同步：这里不需要异步 I/O，单个工具调用就是「写文件 + 轮询读文件」，
/// 请求本来也是一条一条来的，起 tokio 运行时反而绕。
pub fn run_stdio() -> i32 {
    let mailbox = std::env::var("CODOVO_APP_MAILBOX")
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
                eprintln!("app-mcp: 读 stdin 失败: {error}");
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
                eprintln!("app-mcp: 解析请求失败: {error}");
                continue;
            }
        };
        let Some(response) = handle(mailbox.as_deref(), request) else {
            continue;
        };
        let text = match serde_json::to_string(&response) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("app-mcp: 序列化响应失败: {error}");
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
                "serverInfo": { "name": "codovo-app", "version": env!("CARGO_PKG_VERSION") },
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
        other => {
            // 未知方法：有 id 就回 error，没有就当通知忽略
            id.map(|id| error_response(id, -32601, &format!("未知方法: {other}")))
        }
    }
}

pub(crate) fn ok_response(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result })
}

pub(crate) fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

/// 工具清单。名字在 opencode 侧会带上 server 前缀（`app_`）。
///
/// 每个工具的描述都写明「改什么、影响哪里」，模型据此挑工具；真正执行在前端，
/// 这里只负责把参数原样投递过去。
fn tool_definitions() -> Value {
    json!([
        {
            "name": "get_state",
            "description": "读取 Codovo 当前状态：设置项、工作区列表、右栏当前模块与展开状态、全屏状态。回答「现在字号是多少」这类问题前先调它。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "name": "update_settings",
            "description": "修改 Codovo 设置。patch 里每个键是设置字段名（如 terminalFontSize、editorAutoSave、theme），值为新值。不确定字段名时先看技能说明或调 get_state。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "patch": {
                        "type": "object",
                        "description": "要改的设置项，键为字段名、值为新值",
                        "additionalProperties": true
                    }
                },
                "required": ["patch"],
                "additionalProperties": false
            }
        },
        {
            "name": "add_workspace",
            "description": "把磁盘上的一个目录加为 Codovo 工作区并打开它。路径必须是绝对路径；目录不存在会失败。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "工作目录的绝对路径" },
                    "name": { "type": "string", "description": "显示名，省略则取目录名" }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        },
        {
            "name": "rename_workspace",
            "description": "改一个工作区的显示名（不改磁盘目录名）。workspace 传现有名字或路径。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "工作区名或工作目录路径" },
                    "name": { "type": "string", "description": "新显示名" }
                },
                "required": ["workspace", "name"],
                "additionalProperties": false
            }
        },
        {
            "name": "pin_workspace",
            "description": "置顶 / 取消置顶一个工作区。pinned=true 置顶、false 取消。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "工作区名或工作目录路径" },
                    "pinned": { "type": "boolean", "description": "true 置顶，false 取消" }
                },
                "required": ["workspace", "pinned"],
                "additionalProperties": false
            }
        },
        {
            "name": "remove_workspace",
            "description": "从列表里移除一个工作区（只去掉 Codovo 的记录，不删磁盘目录）。执行前会弹确认框，用户拒绝就取消。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "工作区名或工作目录路径" }
                },
                "required": ["workspace"],
                "additionalProperties": false
            }
        },
        {
            "name": "reset_settings",
            "description": "把设置恢复默认。section 省略表示恢复全部；给了就只恢复那一页（appearance / terminal / editor / shortcuts / agent）。会先弹确认框。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "section": {
                        "type": "string",
                        "description": "要恢复的分类，省略表示全部"
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "switch_panel",
            "description": "切到右边栏的某个模块（并展开右栏）。panel 取 files / changes / browser / remote / database / preview / deploy。文件搜索已并入 files（files 里可切换按名称 / 按内容搜索）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "panel": {
                        "type": "string",
                        "description": "files / changes / browser / remote / database / preview / deploy"
                    }
                },
                "required": ["panel"],
                "additionalProperties": false
            }
        },
        {
            "name": "set_right_pane",
            "description": "展开或收起整条右边栏。open=true 展开，false 收起（收起后只剩一条图标条）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "open": { "type": "boolean", "description": "true 展开，false 收起" }
                },
                "required": ["open"],
                "additionalProperties": false
            }
        },
        {
            "name": "set_fullscreen",
            "description": "切换全屏区域。area 取 none（退出全屏）/ left（终端与智能体那一列铺满）/ right（整个右边栏铺满）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "area": { "type": "string", "description": "none / left / right" }
                },
                "required": ["area"],
                "additionalProperties": false
            }
        }
    ])
}

/// 把工具调用投进邮箱，等前端执行完再拿结果。
pub(crate) fn call_tool(mailbox: Option<&Path>, request: &Value) -> Result<String, String> {
    let name = request
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = request
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let dir = mailbox.ok_or("没有配置界面操作通道（缺少 CODOVO_APP_MAILBOX）")?;
    let id = next_request_id();
    let response_path = dir.join(RESPONSE_FILE);
    // 先清掉上一轮的响应，再写请求：反过来的话前端可能在「写请求」与「清响应」之间
    // 就把新响应写了，然后被这里删掉
    let _ = std::fs::remove_file(&response_path);
    write_json(
        &dir.join(REQUEST_FILE),
        &json!({ "id": id, "tool": name, "args": args }),
    )?;

    wait_response(&response_path, &id, WAIT_TIMEOUT)
}

/// 轮询响应文件，直到 id 对上或超时。
///
/// **必须校验 id**：超时后前端仍可能把上一条的结果写进来，认错就会张冠李戴。
pub(crate) fn wait_response(path: &Path, id: &str, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if value.get("id").and_then(Value::as_str) == Some(id) {
                    let _ = std::fs::remove_file(path);
                    let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
                    let result = value
                        .get("result")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    return if ok {
                        Ok(result)
                    } else if result.is_empty() {
                        Err("操作失败（界面没有给出原因）".to_string())
                    } else {
                        Err(result)
                    };
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    Err("等待 Codovo 界面响应超时：应用可能没在运行，或确认框一直没有被处理".to_string())
}

/// 请求 id：pid + 自增序号 + 纳秒。前两者保证同进程内不重，纳秒挡住进程重启后的撞号。
pub(crate) fn next_request_id() -> String {
    let seq = REQUEST_SEQ.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{seq}-{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codovo-app-agent-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn tool_definitions_cover_the_expected_actions() {
        let tools = tool_definitions();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "get_state",
                "update_settings",
                "add_workspace",
                "rename_workspace",
                "pin_workspace",
                "remove_workspace",
                "reset_settings",
                "switch_panel",
                "set_right_pane",
                "set_fullscreen",
            ]
        );
        // 有参数的工具必须把关键字段标成 required，否则模型可能漏传
        let by_name = |name: &str| -> Value {
            tools
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap()
                .clone()
        };
        assert_eq!(by_name("update_settings")["inputSchema"]["required"][0], "patch");
        assert_eq!(by_name("add_workspace")["inputSchema"]["required"][0], "path");
        assert_eq!(by_name("switch_panel")["inputSchema"]["required"][0], "panel");
        // get_state 不该要任何参数
        assert!(by_name("get_state")["inputSchema"]["properties"]
            .as_object()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn responses_carry_the_right_envelope() {
        let ok = ok_response(Some(json!(1)), json!({ "a": 1 }));
        assert_eq!(ok["jsonrpc"], "2.0");
        assert_eq!(ok["id"], 1);
        assert_eq!(ok["result"]["a"], 1);

        let err = error_response(json!(2), -32601, "nope");
        assert_eq!(err["id"], 2);
        assert_eq!(err["error"]["code"], -32601);
    }

    #[test]
    fn initialize_answers_without_touching_the_mailbox() {
        // 握手必须立刻回：给一个根本不存在的邮箱目录，也不能出错、更不能去建它
        let missing = std::env::temp_dir().join("codovo-app-agent-never-created");
        let _ = std::fs::remove_dir_all(&missing);
        let response = handle(
            Some(&missing),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2024-11-05" } }),
        )
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(response["result"]["serverInfo"]["name"], "codovo-app");
        assert!(!missing.exists());
    }

    #[test]
    fn take_request_removes_the_file_and_returns_none_when_absent() {
        let dir = temp_dir("take");
        let path = dir.join(REQUEST_FILE);
        assert!(take_request_at(&path).unwrap().is_none());

        write_json(
            &path,
            &json!({ "id": "r1", "tool": "switch_panel", "args": { "panel": "changes" } }),
        )
        .unwrap();
        let taken = take_request_at(&path).unwrap().unwrap();
        assert_eq!(taken.id, "r1");
        assert_eq!(taken.tool, "switch_panel");
        assert_eq!(taken.args["panel"], "changes");
        // 取走即删除：同一条不会被处理两次
        assert!(!path.exists());
        assert!(take_request_at(&path).unwrap().is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn take_request_drops_malformed_payloads() {
        let dir = temp_dir("malformed");
        let path = dir.join(REQUEST_FILE);
        std::fs::write(&path, "{ not json").unwrap();
        // 坏请求返回错误、且已被删掉，不会卡住后面的轮询
        assert!(take_request_at(&path).is_err());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wait_response_only_accepts_the_matching_id() {
        let dir = temp_dir("wait");
        let path = dir.join(RESPONSE_FILE);
        respond_at(&path, "stale", true, "上一轮的").unwrap();

        // id 对不上时不能当成自己的响应
        let err = wait_response(&path, "mine", Duration::from_millis(120)).unwrap_err();
        assert!(err.contains("超时"));

        respond_at(&path, "mine", true, "已把终端字号改成 16").unwrap();
        assert_eq!(
            wait_response(&path, "mine", Duration::from_secs(2)).unwrap(),
            "已把终端字号改成 16"
        );
        // 读到就删，别留给下一次调用
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wait_response_maps_failures_to_errors() {
        let dir = temp_dir("fail");
        let path = dir.join(RESPONSE_FILE);
        respond_at(&path, "r1", false, "找不到名为「foo」的工作区").unwrap();
        let err = wait_response(&path, "r1", Duration::from_secs(2)).unwrap_err();
        assert!(err.contains("找不到名为「foo」的工作区"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_ids_are_unique() {
        let a = next_request_id();
        let b = next_request_id();
        assert_ne!(a, b);
        assert!(a.starts_with(&std::process::id().to_string()));
    }

    #[test]
    fn call_tool_without_a_mailbox_fails_fast() {
        let request = json!({ "params": { "name": "get_state", "arguments": {} } });
        assert!(call_tool(None, &request).is_err());
    }
}
