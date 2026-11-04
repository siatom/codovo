//! 应用助手的界面工具：改设置、工作区与右栏布局。
//!
//! 这些操作的对象在 **WebView** 里（localStorage + React state），Rust 侧够不着，
//! 所以工具只负责把调用投给前端并等回执。切 Rig 之前这条链路是
//! 「MCP 子进程 → 文件邮箱 → 前端 500ms 轮询」，现在是「进程内工具 → 事件 → oneshot」：
//! 少了子进程与文件，前端也不用再轮询。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rig_core::message::ToolName;
use rig_core::tool::{DynamicTool, ToolExecutionError, ToolOutput};
use rig_core::wasm_compat::WasmBoxedFuture;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// 投给前端的事件名，与 `lib/app-agent.ts` 对齐。
pub const REQUEST_EVENT: &str = "app-agent-request";

/// 等前端执行的时限。比确认框的耐心长一点，又不至于让模型干等。
const WAIT_TIMEOUT: Duration = Duration::from_secs(120);

/// 前端回执。
pub struct Reply {
    pub ok: bool,
    pub result: String,
}

/// 界面操作通道：一次调用 = 一个 id + 一条等待回执的 oneshot。
pub struct AppBridge {
    app: AppHandle,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
}

impl AppBridge {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// 把一次工具调用交给前端，等它执行完。
    async fn call(&self, tool: &str, args: Value) -> Result<String, String> {
        let id = next_id();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            pending.insert(id.clone(), sender);
        }

        let payload = json!({ "id": id, "tool": tool, "args": args });
        if let Err(error) = self.app.emit(REQUEST_EVENT, payload) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(format!("把操作交给界面失败：{error}"));
        }

        match tokio::time::timeout(WAIT_TIMEOUT, receiver).await {
            Ok(Ok(reply)) if reply.ok => Ok(reply.result),
            Ok(Ok(reply)) => Err(if reply.result.trim().is_empty() {
                "操作失败（界面没有给出原因）".to_string()
            } else {
                reply.result
            }),
            // 发送端被丢掉：界面刷新或应用退出
            Ok(Err(_)) => Err("界面没有回应这次操作".to_string()),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err("等待界面响应超时：确认框可能一直没有被处理".to_string())
            }
        }
    }

    /// 前端执行完回填结果。返回 false 表示这次请求已经超时作废。
    pub fn respond(&self, id: &str, ok: bool, result: String) -> bool {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(id));
        match sender {
            Some(sender) => sender.send(Reply { ok, result }).is_ok(),
            None => false,
        }
    }
}

/// 十个界面工具。
pub fn tools(bridge: Arc<AppBridge>) -> Vec<DynamicTool> {
    vec![
        tool(
            "get_state",
            "读取 Codovo 当前状态：设置项、工作区列表、右栏当前模块与展开状态、全屏状态。回答「现在字号是多少」这类问题前先调它。",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            Arc::clone(&bridge),
        ),
        tool(
            "update_settings",
            "修改 Codovo 设置。patch 里每个键是设置字段名（如 terminalFontSize、editorAutoSave、theme），值为新值。不确定字段名时先看技能说明或调 get_state。",
            json!({
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
            }),
            Arc::clone(&bridge),
        ),
        tool(
            "add_workspace",
            "把磁盘上的一个目录加为 Codovo 工作区并打开它。路径必须是绝对路径；目录不存在会失败。",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "工作目录的绝对路径" },
                    "name": { "type": "string", "description": "显示名，省略则取目录名" },
                    "group": { "type": "string", "description": "分组名，省略则未分组" }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            Arc::clone(&bridge),
        ),
        tool(
            "rename_workspace",
            "改一个工作区的显示名（不改磁盘目录名）。workspace 传现有名字或路径。",
            json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "工作区名或工作目录路径" },
                    "name": { "type": "string", "description": "新显示名" }
                },
                "required": ["workspace", "name"],
                "additionalProperties": false
            }),
            Arc::clone(&bridge),
        ),
        tool(
            "pin_workspace",
            "置顶 / 取消置顶一个工作区。pinned=true 置顶、false 取消。",
            json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "工作区名或工作目录路径" },
                    "pinned": { "type": "boolean", "description": "true 置顶，false 取消" }
                },
                "required": ["workspace", "pinned"],
                "additionalProperties": false
            }),
            Arc::clone(&bridge),
        ),
        tool(
            "remove_workspace",
            "从列表里移除一个工作区（只去掉 Codovo 的记录，不删磁盘目录）。执行前会弹确认框，用户拒绝就取消。",
            json!({
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "工作区名或工作目录路径" }
                },
                "required": ["workspace"],
                "additionalProperties": false
            }),
            Arc::clone(&bridge),
        ),
        tool(
            "reset_settings",
            "把设置恢复默认。section 省略表示恢复全部；给了就只恢复那一页（appearance / terminal / editor / shortcuts / agent）。会先弹确认框。",
            json!({
                "type": "object",
                "properties": {
                    "section": { "type": "string", "description": "要恢复的分类，省略表示全部" }
                },
                "additionalProperties": false
            }),
            Arc::clone(&bridge),
        ),
        tool(
            "switch_panel",
            "切到右边栏的某个模块（并展开右栏）。panel 取 files / changes / browser / remote / database / preview / deploy。",
            json!({
                "type": "object",
                "properties": {
                    "panel": {
                        "type": "string",
                        "description": "files / changes / browser / remote / database / preview / deploy"
                    }
                },
                "required": ["panel"],
                "additionalProperties": false
            }),
            Arc::clone(&bridge),
        ),
        tool(
            "set_right_pane",
            "展开或收起整条右边栏。open=true 展开，false 收起（收起后只剩一条图标条）。",
            json!({
                "type": "object",
                "properties": {
                    "open": { "type": "boolean", "description": "true 展开，false 收起" }
                },
                "required": ["open"],
                "additionalProperties": false
            }),
            Arc::clone(&bridge),
        ),
        tool(
            "set_fullscreen",
            "切换全屏区域。area 取 none（退出全屏）/ left（终端那一列铺满）/ right（整个右边栏铺满）。",
            json!({
                "type": "object",
                "properties": {
                    "area": { "type": "string", "description": "none / left / right" }
                },
                "required": ["area"],
                "additionalProperties": false
            }),
            bridge,
        ),
    ]
}

/// 一个工具：把参数原样投给前端，回执转成模型能读的文本。
fn tool(name: &'static str, description: &str, parameters: Value, bridge: Arc<AppBridge>) -> DynamicTool {
    DynamicTool::new(
        ToolName::new(name).expect("工具名是常量，不会为空"),
        description,
        parameters,
        move |args: Value| {
            let bridge = Arc::clone(&bridge);
            boxed(async move {
                bridge
                    .call(name, args)
                    .await
                    .map(ToolOutput::text)
                    .map_err(ToolExecutionError::other)
            })
        },
    )
}

/// 把任意 future 装箱成 Rig 要的形状。
fn boxed<F>(future: F) -> WasmBoxedFuture<'static, Result<ToolOutput, ToolExecutionError>>
where
    F: std::future::Future<Output = Result<ToolOutput, ToolExecutionError>> + Send + 'static,
{
    Box::pin(future)
}

/// 请求 id：进程内自增就够——同一时刻只有一个应用实例持有这些 pending。
fn next_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("app-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}
