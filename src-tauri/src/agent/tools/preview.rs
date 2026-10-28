//! 预览助手的工具：探测、启动、停止、查状态。
//!
//! 以前走 MCP 子进程 + 文件邮箱，因为预览进程池在主进程里、子进程够不着。
//! 现在工具就在主进程内，直接调 `preview` 的命令函数即可。

use rig_core::message::ToolName;
use rig_core::tool::{DynamicTool, ToolExecutionError, ToolOutput};
use rig_core::wasm_compat::WasmBoxedFuture;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::fs_api::FsState;
use crate::preview::{self, PreviewState};

/// 四个预览工具。`root` 是要预览的项目根（不是哨兵）。
pub fn tools(app: AppHandle, root: String) -> Vec<DynamicTool> {
    vec![
        detect(app.clone(), root.clone()),
        start(app.clone(), root.clone()),
        stop(app.clone(), root.clone()),
        status(app, root),
    ]
}

fn detect(app: AppHandle, root: String) -> DynamicTool {
    DynamicTool::new(
        ToolName::new("detect").expect("工具名是常量"),
        "探测当前工作区该用什么方式预览：返回 kind / command / port / reason / warnings。不确定怎么启动时先调它。",
        json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        move |_args: Value| {
            let app = app.clone();
            let root = root.clone();
            boxed(async move {
                let fs = app.state::<FsState>();
                let detection = preview::preview_detect(fs, root).map_err(ToolExecutionError::other)?;
                to_text(&detection)
            })
        },
    )
}

fn start(app: AppHandle, root: String) -> DynamicTool {
    DynamicTool::new(
        ToolName::new("start").expect("工具名是常量"),
        "启动当前工作区的预览（已在跑会先停掉）。command / port 可覆盖探测结果；启动后返回状态与地址。",
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "自定义启动命令，省略用探测结果" },
                "port": { "type": "integer", "description": "自定义端口，省略用探测结果" }
            },
            "additionalProperties": false
        }),
        move |args: Value| {
            let app = app.clone();
            let root = root.clone();
            boxed(async move {
                let command = args
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let port = args
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|value| u16::try_from(value).ok());

                let state = app.state::<PreviewState>();
                let fs = app.state::<FsState>();
                let status = preview::preview_start(app.clone(), state, fs, root, command, port).map_err(ToolExecutionError::other)?;
                to_text(&status)
            })
        },
    )
}

fn stop(app: AppHandle, root: String) -> DynamicTool {
    DynamicTool::new(
        ToolName::new("stop").expect("工具名是常量"),
        "停掉当前工作区的预览进程。",
        json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        move |_args: Value| {
            let app = app.clone();
            let root = root.clone();
            boxed(async move {
                let state = app.state::<PreviewState>();
                preview::preview_stop(state, root);
                Ok(ToolOutput::text("已停止"))
            })
        },
    )
}

fn status(app: AppHandle, root: String) -> DynamicTool {
    DynamicTool::new(
        ToolName::new("status").expect("工具名是常量"),
        "查当前工作区的预览状态：是否就绪、地址 / CDP 调试端口、最近日志。启动后用它确认结果。",
        json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        move |_args: Value| {
            let app = app.clone();
            let root = root.clone();
            boxed(async move {
                let state = app.state::<PreviewState>();
                let status = preview::preview_status(state, root);
                to_text(&status)
            })
        },
    )
}

fn to_text<T: serde::Serialize>(value: &T) -> Result<ToolOutput, ToolExecutionError> {
    let text = serde_json::to_string(value).map_err(|e| ToolExecutionError::other(e.to_string()))?;
    Ok(ToolOutput::text(text))
}

fn boxed<F>(future: F) -> WasmBoxedFuture<'static, Result<ToolOutput, ToolExecutionError>>
where
    F: std::future::Future<Output = Result<ToolOutput, ToolExecutionError>> + Send + 'static,
{
    Box::pin(future)
}
