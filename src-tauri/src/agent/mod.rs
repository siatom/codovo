//! 对话式智能体：进程内的 Rig 运行时。
//!
//! 与切 opencode 之前最大的不同：没有子进程、没有 HTTP / SSE、没有 MCP 工具桥。
//! 一个工作区一个槽位（`Slot`），槽位里放着会话目录、当前配置和正在跑的那一轮。
//!
//! 事件仍然走 `agent-event`，但载荷是我们自己的形状（见 `lib/agent.ts` 的 reducer），
//! 不再解析 opencode 的两代协议。

mod config;
mod prompt;
mod store;
mod tools;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use rig_agent::agent::MultiTurnStreamItem;
use rig_agent::AgentBuilder;
use rig_core::message::AssistantContent;
use rig_core::streaming::{Item, StreamEvent};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

pub use config::AgentConfig;
pub use prompt::Kind;
pub use store::SessionSummary;

use crate::fs_api::FsState;
use crate::llm;
use store::SessionStore;
use tools::app::AppBridge;
use tools::db::{DbTarget, DbTools};

/// 事件名，与 `lib/agent.ts` 对齐。
const EVENT_NAME: &str = "agent-event";

/// 会话日志名。一个会话只有一个对话，没有子 agent。
const LOG: &str = "main";

/// 一轮对话最多跑多少次模型调用。工具调用与回填都占轮次，留够余量；
/// 真跑飞了也要有个上限，别让模型无限自问自答。
const MAX_TURNS: usize = 32;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    /// 生效的模型引用 `provider/model`
    model: String,
    /// 这个槽位的工作目录
    workspace: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    /// 槽位是否已经建起来
    running: bool,
    /// 是否有正在跑的一轮
    busy: bool,
}

/// 一个工作区（或一个哨兵 root）对应的运行时。
struct Slot {
    kind: Kind,
    /// 预览助手要操作的项目根；其余种类等于槽位自己的 root
    workspace: PathBuf,
    sessions: SessionStore,
    config: Mutex<AgentConfig>,
    /// 正在跑的会话 id。同一个会话不允许并发两轮（Rig 的会话日志是乐观追加，
    /// 两轮同时写会被拒）
    busy: Mutex<HashSet<String>>,
    /// 会话 id -> 这一轮的任务句柄，abort 时直接掐掉
    handles: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl Slot {
    fn config(&self) -> Result<AgentConfig, String> {
        self.config
            .lock()
            .map(|config| config.clone())
            .map_err(|e| e.to_string())
    }

    fn mark_busy(&self, session: &str) -> Result<(), String> {
        let mut busy = self.busy.lock().map_err(|e| e.to_string())?;
        if !busy.insert(session.to_string()) {
            return Err("这一轮还没跑完".to_string());
        }
        Ok(())
    }

    fn set_handle(&self, session: &str, handle: tauri::async_runtime::JoinHandle<()>) {
        if let Ok(mut handles) = self.handles.lock() {
            handles.insert(session.to_string(), handle);
        }
    }

    /// 一轮结束（成功、失败或被掐断）都走这里。
    fn finish(&self, session: &str) {
        if let Ok(mut busy) = self.busy.lock() {
            busy.remove(session);
        }
        if let Ok(mut handles) = self.handles.lock() {
            handles.remove(session);
        }
    }

    fn abort(&self, session: &str) -> bool {
        let handle = self
            .handles
            .lock()
            .ok()
            .and_then(|mut handles| handles.remove(session));
        match handle {
            Some(handle) => {
                handle.abort();
                if let Ok(mut busy) = self.busy.lock() {
                    busy.remove(session);
                }
                true
            }
            None => false,
        }
    }
}

/// 全局运行时状态：槽位、界面桥、数据库工具。
pub struct AgentState {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    bridge: Mutex<Option<Arc<AppBridge>>>,
    db_target: Arc<DbTarget>,
    db_tools: Mutex<Option<Arc<DbTools>>>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            bridge: Mutex::new(None),
            db_target: Arc::new(DbTarget::default()),
            db_tools: Mutex::new(None),
        }
    }

    /// 工具依赖。界面桥与数据库工具都是进程级单例：它们的 pending / 连接缓存
    /// 要跨轮次、跨会话复用。
    fn deps(&self, app: &AppHandle) -> tools::Deps {
        let bridge = {
            let mut slot = self.bridge.lock().expect("界面桥锁中毒");
            match slot.as_ref() {
                Some(bridge) => Arc::clone(bridge),
                None => {
                    let bridge = AppBridge::new(app.clone());
                    *slot = Some(Arc::clone(&bridge));
                    bridge
                }
            }
        };
        let db = {
            let mut slot = self.db_tools.lock().expect("数据库工具锁中毒");
            match slot.as_ref() {
                Some(db) => Arc::clone(db),
                None => {
                    let db = DbTools::new(Arc::clone(&self.db_target));
                    *slot = Some(Arc::clone(&db));
                    db
                }
            }
        };
        tools::Deps { bridge, db }
    }

    /// 退出应用时掐掉所有在跑的一轮。
    pub fn kill_all(&self) {
        let slots = match self.slots.lock() {
            Ok(slots) => slots,
            Err(_) => return,
        };
        for slot in slots.values() {
            if let Ok(mut handles) = slot.handles.lock() {
                for (_, handle) in handles.drain() {
                    handle.abort();
                }
            }
            if let Ok(mut busy) = slot.busy.lock() {
                busy.clear();
            }
        }
    }
}

// ---- 命令 ----

/// 启动（或复用）某个槽位的运行时。幂等：同一个 root 已经在就直接更新配置返回。
#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: tauri::State<'_, AgentState>,
    fs_state: tauri::State<'_, FsState>,
    root: String,
    config: AgentConfig,
) -> Result<AgentInfo, String> {
    // 覆盖要赶在下面判空之前：面板留空、只写 .env 时也得能起
    let mut config = config;
    config.apply(&crate::dev::read_overrides());

    // 先验一遍模型配置：没配提供商时早点报错，别等用户发消息才失败
    config.model_spec(None)?;

    let kind = if config.database {
        Kind::Database
    } else if config.preview {
        Kind::Preview
    } else {
        Kind::App
    };

    // 工作目录：预览助手是它要预览的那个项目；其余就是槽位自己的 root。
    // 数据库助手不属于任何工作区，用应用配置目录下的空目录，省得去碰白名单。
    let workspace = match kind {
        Kind::Preview => {
            let workspace_root = config.workspace_root.trim();
            if workspace_root.is_empty() {
                return Err("预览助手缺少工作区路径".to_string());
            }
            fs_state.checked_root(workspace_root)?
        }
        Kind::Database => {
            let dir = app
                .path()
                .app_config_dir()
                .map_err(|e| format!("拿不到配置目录：{e}"))?
                .join("db-agent");
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
            dir
        }
        Kind::App => fs_state.checked_root(&root)?,
    };

    let dir = sessions_dir(&app, &root)?;
    let sessions = SessionStore::open(dir)?;

    let _slot = {
        let mut slots = state.slots.lock().map_err(|e| e.to_string())?;
        match slots.get(&root) {
            Some(existing) => {
                // 同一个 root 重复启动：换一份配置就行，会话与在跑的一轮都不动
                if let Ok(mut current) = existing.config.lock() {
                    *current = config.clone();
                }
                Arc::clone(existing)
            }
            None => {
                let slot = Arc::new(Slot {
                    kind,
                    workspace: workspace.clone(),
                    sessions,
                    config: Mutex::new(config.clone()),
                    busy: Mutex::new(HashSet::new()),
                    handles: Mutex::new(HashMap::new()),
                });
                slots.insert(root.clone(), Arc::clone(&slot));
                slot
            }
        }
    };
    Ok(AgentInfo {
        model: config.resolved_default_model().unwrap_or_default(),
        workspace: workspace.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn agent_status(state: tauri::State<'_, AgentState>, root: String) -> AgentStatus {
    let slots = state.slots.lock().ok();
    let slot = slots.as_ref().and_then(|slots| slots.get(&root).cloned());
    match slot {
        Some(slot) => AgentStatus {
            running: true,
            busy: slot
                .busy
                .lock()
                .map(|busy| !busy.is_empty())
                .unwrap_or(false),
        },
        None => AgentStatus {
            running: false,
            busy: false,
        },
    }
}

/// 停掉某个槽位：掐掉在跑的一轮并丢掉槽位。关闭工作区时调。
#[tauri::command]
pub fn agent_stop(state: tauri::State<'_, AgentState>, root: String) {
    stop_root(&state, &root);
}

/// 收掉某个 root 的槽位。关闭工作区时连预览助手的哨兵槽位一起收。
pub fn stop_root(state: &AgentState, root: &str) {
    let slot = state
        .slots
        .lock()
        .ok()
        .and_then(|mut slots| slots.remove(root));
    if let Some(slot) = slot {
        if let Ok(mut handles) = slot.handles.lock() {
            for (_, handle) in handles.drain() {
                handle.abort();
            }
        }
    }
}

/// 预览助手的哨兵 root。它不属于任何工作区，只是给每个工作区一个独立的槽位；
/// 前端 `lib/preview-agent.ts` 的 `previewAgentRoot` 与它对齐。
pub fn preview_root(workspace: &str) -> String {
    format!("__preview_agent__::{workspace}")
}

#[tauri::command]
pub fn agent_create_session(
    state: tauri::State<'_, AgentState>,
    root: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    let slot = slot_of(&state, &root)?;
    let title = title.unwrap_or_default();
    let id = slot.sessions.create(&title)?;
    Ok(json!({ "id": id }))
}

#[tauri::command]
pub fn agent_list_sessions(
    state: tauri::State<'_, AgentState>,
    root: String,
) -> Result<Vec<SessionSummary>, String> {
    slot_of(&state, &root)?.sessions.list()
}

/// 拉某个会话的历史消息，打开会话时灌一次，之后靠事件增量。
#[tauri::command]
pub fn agent_messages(
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let messages = slot_of(&state, &root)?.sessions.history(&session_id)?;
    serde_json::to_value(messages).map_err(|e| e.to_string())
}

/// 发一条消息。立刻返回，正文靠事件流推回来。
#[tauri::command]
pub fn agent_send(
    app: AppHandle,
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
    text: String,
    model: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".to_string());
    }

    let slot = slot_of(&state, &root)?;
    let config = slot.config()?;
    let spec = config.model_spec(model.as_deref())?;
    let preamble = prompt::build(slot.kind, &config);
    let deps = state.deps(&app);
    let tool_list = tools::build(slot.kind, &deps, &app, &slot.workspace);
    let store = slot.sessions.store(&session_id)?;
    let sessions = &slot.sessions;

    slot.mark_busy(&session_id)?;

    // 标题只在还没有的时候补一次
    sessions.touch(&session_id, Some(&text))?;

    let app_handle = app.clone();
    let root_key = root.clone();
    let session = session_id.clone();
    let message_id = format!("live-{session}-{}", next_seq());
    let slot_for_task = Arc::clone(&slot);

    let handle = tauri::async_runtime::spawn(async move {
        emit(
            &app_handle,
            &root_key,
            json!({ "type": "runStarted", "sessionId": session, "messageId": message_id, "text": text.as_str() }),
        );

        // 建模型失败（地址 / 模型名不对）要在这一轮里报掉，不能吞成静默的空白回复
        let model = match llm::build(&spec) {
            Ok(model) => model,
            Err(error) => {
                emit(
                    &app_handle,
                    &root_key,
                    json!({ "type": "runFailed", "sessionId": session, "messageId": message_id, "message": error }),
                );
                slot_for_task.finish(&session);
                return;
            }
        };

        let agent = AgentBuilder::new(model)
            .preamble(preamble)
            .dynamic_tools(tool_list)
            .memory(store)
            .conversation(LOG)
            .build();

        // Rig 的 prompt 默认只允许 1 轮：不放开的话，模型一调工具就会以
        // 「reached the max turns limit of 1」结束。一轮 = 一次模型调用，
        // 工具调用与回填都要占轮次，给足余量。
        let mut stream = agent.prompt(text).max_turns(MAX_TURNS).stream();
        let mut failed: Option<String> = None;

        while let Some(item) = stream.next().await {
            match item {
                Ok(MultiTurnStreamItem::StreamAssistantItem(item)) => match item {
                    Item::Event(StreamEvent::Text { text, .. }) => emit(
                        &app_handle,
                        &root_key,
                        json!({ "type": "textDelta", "sessionId": session, "messageId": message_id, "delta": text }),
                    ),
                    Item::Event(StreamEvent::Reasoning { text, .. }) => emit(
                        &app_handle,
                        &root_key,
                        json!({ "type": "reasoningDelta", "sessionId": session, "messageId": message_id, "delta": text }),
                    ),
                    // 工具调用在参数收齐（End）时才报：这时才有完整的 id 与入参，
                    // 前端也只需要一张卡片，不必自己拼 JSON 片段
                    Item::Event(StreamEvent::End {
                        content: AssistantContent::ToolCall(call),
                        ..
                    }) => emit(
                        &app_handle,
                        &root_key,
                        json!({
                            "type": "toolCall",
                            "sessionId": session,
                            "messageId": message_id,
                            "callId": call.id.to_string(),
                            "tool": call.function.name.to_string(),
                            "input": serde_json::Value::Object(call.function.arguments.clone()),
                        }),
                    ),
                    _ => {}
                },
                Ok(MultiTurnStreamItem::ToolResult { tool_result }) => {
                    let text = result_text(&tool_result);
                    emit(
                        &app_handle,
                        &root_key,
                        json!({
                            "type": "toolResult",
                            "sessionId": session,
                            "callId": tool_result.call.to_string(),
                            "ok": !tool_result.is_error,
                            "output": text,
                        }),
                    );
                }
                Ok(_) => {}
                Err(error) => {
                    failed = Some(format!("{error}"));
                    break;
                }
            }
        }

        match failed {
            Some(message) => emit(
                &app_handle,
                &root_key,
                json!({ "type": "runFailed", "sessionId": session, "messageId": message_id, "message": message }),
            ),
            None => emit(
                &app_handle,
                &root_key,
                json!({ "type": "runFinished", "sessionId": session, "messageId": message_id }),
            ),
        }

        slot_for_task.finish(&session);
    });

    slot.set_handle(&session_id, handle);
    Ok(())
}

/// 打断当前这一轮。被打断的一轮不会写进会话历史（Rig 只在整轮成功后才保存）。
#[tauri::command]
pub fn agent_abort(
    app: AppHandle,
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
) {
    let Ok(slot) = slot_of(&state, &root) else {
        return;
    };
    if !slot.abort(&session_id) {
        return;
    }
    // 被掐断的那一轮来不及走自己的收尾，这里替它发一条结束事件：
    // 否则界面上的「停止中」会一直转，直到用户切走再切回来。
    emit(
        &app,
        &root,
        json!({ "type": "runFinished", "sessionId": session_id, "messageId": "" }),
    );
}

#[tauri::command]
pub fn agent_delete_session(
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
) -> Result<(), String> {
    let slot = slot_of(&state, &root)?;
    slot.abort(&session_id);
    slot.sessions.delete(&session_id)
}

#[tauri::command]
pub fn agent_rename_session(
    state: tauri::State<'_, AgentState>,
    root: String,
    session_id: String,
    title: String,
) -> Result<(), String> {
    slot_of(&state, &root)?.sessions.rename(&session_id, &title)
}

/// 前端执行完一次界面工具后回填结果。
#[tauri::command]
pub fn app_agent_respond(
    state: tauri::State<'_, AgentState>,
    id: String,
    ok: bool,
    result: String,
) -> bool {
    let bridge = state
        .bridge
        .lock()
        .ok()
        .and_then(|bridge| bridge.as_ref().cloned());
    match bridge {
        Some(bridge) => bridge.respond(&id, ok, result),
        None => false,
    }
}

/// 数据库助手当前面向哪个连接。前端在切换连接时调用。
#[tauri::command]
pub fn db_agent_set_target(
    state: tauri::State<'_, AgentState>,
    request: crate::database::DbConnectRequest,
) -> Result<(), String> {
    state.db_target.set(request)
}

// ---- 内部 ----

fn slot_of(state: &tauri::State<'_, AgentState>, root: &str) -> Result<Arc<Slot>, String> {
    state
        .slots
        .lock()
        .map_err(|e| e.to_string())?
        .get(root)
        .cloned()
        .ok_or_else(|| "智能体还没启动".to_string())
}

fn emit(app: &AppHandle, root: &str, event: serde_json::Value) {
    let _ = app.emit(EVENT_NAME, json!({ "root": root, "event": event }));
}

/// 每发一轮就换一个消息 id：前端 reducer 按 id 归并，同一会话的下一轮要是还用
/// 上一轮的 id，新内容会被接到上一条助手消息后面。
fn next_seq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// 工具结果的文本部分。界面上工具卡只展示纯文本。
fn result_text(result: &rig_core::message::ToolResult) -> String {
    let mut text = String::new();
    for item in &result.content {
        if !text.is_empty() {
            text.push('\n');
        }
        match item {
            rig_core::message::ToolResultContent::Text(value) => text.push_str(&value.text),
            rig_core::message::ToolResultContent::Json { value } => {
                text.push_str(&value.to_string())
            }
            _ => {}
        }
    }
    text
}

/// 会话目录：`<配置目录>/agent-sessions/<工作区哈希>`。
fn sessions_dir(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("拿不到配置目录：{e}"))?
        .join("agent-sessions")
        .join(workspace_dir_name(root));
    Ok(dir)
}

/// 把 root 变成目录名：非法字符换成 `_`，再缀一段稳定 hash 保证唯一。
fn workspace_dir_name(root: &str) -> String {
    let mut safe: String = root
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    // 路径长了只留尾部，免得超文件名长度上限
    if safe.len() > 60 {
        safe = safe.split_off(safe.len() - 60);
    }
    format!("{safe}-{:016x}", stable_hash(Path::new(root)))
}

/// FNV-1a。不用 std 的 `DefaultHasher`：它的输出不保证跨 Rust 版本稳定，
/// 换个版本编译就会把会话目录换掉。
fn stable_hash(path: &Path) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{sse, serve};

    /// 一个原样回显 text 的工具，用来验证工具卡能落到会话历史里。
    fn echo_tool() -> rig_core::tool::DynamicTool {
        rig_core::tool::DynamicTool::new(
            rig_core::message::ToolName::new("echo").unwrap(),
            "原样回显 text",
            json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
            |args: serde_json::Value| {
                Box::pin(async move {
                    let text = args
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    Ok::<_, rig_core::tool::ToolExecutionError>(rig_core::tool::ToolOutput::text(text))
                }) as rig_core::wasm_compat::WasmBoxedFuture<'static, _>
            },
        )
    }

    #[tokio::test]
    async fn a_round_trip_with_a_tool_call_lands_in_the_session_history() {
        // 第一轮：模型要调 echo；第二轮：拿到结果后收尾
        let first = sse(&[
            r#"{"id":"1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"text\":\"hi\"}"}}]},"finish_reason":null}]}"#,
            r#"{"id":"1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        ]);
        let second = sse(&[
            r#"{"id":"2","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"回显成功"},"finish_reason":null}]}"#,
            r#"{"id":"2","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        ]);
        let (base_url, server) = serve(vec![first, second]);

        let dir = std::env::temp_dir().join(format!("codovo-agent-test-{}", next_seq()));
        std::fs::create_dir_all(&dir).unwrap();
        let sessions = SessionStore::open(dir.clone()).unwrap();
        let id = sessions.create("").unwrap();
        sessions.touch(&id, Some("第一句话")).unwrap();

        let spec = llm::ModelSpec {
            base_url,
            model: "test-model".to_string(),
            api_key: None,
        };
        let agent = AgentBuilder::new(llm::build(&spec).unwrap())
            .preamble("你是助手")
            .dynamic_tools(vec![echo_tool()])
            .memory(sessions.store(&id).unwrap())
            .conversation(LOG)
            .build();

        let mut stream = agent.prompt("你好").max_turns(MAX_TURNS).stream();
        while futures::StreamExt::next(&mut stream).await.is_some() {}

        let history = sessions.history(&id).unwrap();
        // 工具结果那条 user 消息没有正文，会被折掉：只剩「问 → 调工具 → 答」
        let roles: Vec<&str> = history.iter().map(|message| message.role).collect();
        assert_eq!(roles, ["user", "assistant", "assistant"]);

        let mut cards = 0;
        let mut texts = Vec::new();
        for message in &history {
            for part in &message.parts {
                match part {
                    store::UiPart::Text { text, .. } => texts.push(text.clone()),
                    store::UiPart::Tool { tool, state, .. } => {
                        cards += 1;
                        assert_eq!(tool, "echo");
                        assert_eq!(state.status, "completed");
                        assert_eq!(state.output.as_deref(), Some("hi"));
                    }
                    store::UiPart::Reasoning { .. } => {}
                }
            }
        }
        assert_eq!(cards, 1, "历史里应当有一张工具卡");
        assert!(texts.iter().any(|text| text == "回显成功"), "正文：{texts:?}");

        // 标题按首句起，之后不再改
        assert_eq!(sessions.list().unwrap()[0].title, "第一句话");

        std::fs::remove_dir_all(&dir).ok();
        server.join().unwrap();
    }
}
