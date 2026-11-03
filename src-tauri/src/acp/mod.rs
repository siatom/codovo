//! 对话面板：把支持 ACP 的 AI CLI 当成 stdio 子进程接进来。
//!
//! 和 `agent` 模块（进程内 Rig 应用助手）是两条独立的通道：
//! - 终端里的 CLI 不动，仍旧走 PTY；
//! - 同一工作区的 provider 配置共享 ACP 子进程，每个 `chatId` 一个 session，事件走 `acp-event`。
//!
//! 生命周期按工作区 root 归档：关工作区、退出应用时统一收掉，和预演 / 助手槽位一致。

mod event;
mod launch;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::v1::schema::{
    CancelNotification, ContentBlock, InitializeRequest, ListSessionsRequest, LoadSessionRequest,
    NewSessionRequest, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, ResumeSessionRequest, SelectedPermissionOutcome, SessionId,
    SessionNotification, TextContent,
};
// SessionSetup 只在 acp_probe 探针里用得到，不参与正常启动路径
#[cfg(test)]
use agent_client_protocol::v1::SessionSetup;
use agent_client_protocol::v1::{ActiveSession, Dispatch as V1Dispatch, SessionMessage};
use agent_client_protocol::{
    AcpAgent, Agent, Client, schema::ProtocolVersion, v1::schema::Implementation,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::{oneshot, watch};

use crate::fs_api::FsState;

use event::{AcpEvent, AcpInfo, PermissionChoice};

const START_TIMEOUT: Duration = Duration::from_secs(60);

/// 前端传进来的环境变量。空 key 的条目忽略。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEnvVar {
    key: String,
    value: String,
}

/// `acp_start` 的入参。字段多了点，收成一个对象，命令签名也干净。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStartInput {
    root: String,
    chat_id: String,
    provider: String,
    command: String,
    roots: Vec<String>,
    env: Vec<AcpEnvVar>,
    /// 要恢复的 ACP session id；为空则新建
    resume_session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStatus {
    running: bool,
    busy: bool,
    info: Option<AcpInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpListedSession {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

/// 列出 Agent 持久化的 ACP 会话。Agent 未声明 session/list 时返回空列表。
#[tauri::command]
pub async fn acp_list_sessions(
    state: tauri::State<'_, AcpState>,
    fs_state: tauri::State<'_, FsState>,
    provider: String,
    command: String,
    root: String,
    env: Vec<AcpEnvVar>,
) -> Result<Vec<AcpListedSession>, String> {
    if !launch::supported(&provider) {
        return Ok(Vec::new());
    }
    let cwd = fs_state.checked_root(&root)?;
    let env: Vec<(String, String)> = env
        .into_iter()
        .filter(|item| !item.key.trim().is_empty())
        .map(|item| (item.key, item.value))
        .collect();
    let key = runtime_key(&root, &provider, &command, &env);
    if let Some(runtime) = state.runtime(&key)? {
        let meta = tokio::time::timeout(START_TIMEOUT, runtime.wait_ready())
            .await
            .map_err(|_| "ACP 进程启动超时（60 秒）".to_string())??;
        if !meta.can_list {
            return Ok(Vec::new());
        }
        let connection = runtime.connection()?;
        return tokio::time::timeout(START_TIMEOUT, list_sessions_on(&connection, cwd))
            .await
            .map_err(|_| "ACP 会话历史读取超时（60 秒）".to_string())?
            .map_err(|error| error.to_string());
    }
    let config = launch::agent_config(&provider, &command, &env, &cwd)?;
    let request_cwd = cwd.clone();

    tokio::time::timeout(START_TIMEOUT, async move {
        Client
            .v1()
            .name("Codovo")
            .connect_with(AcpAgent::new(config), async move |cx| {
                let init = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("Codovo", env!("CARGO_PKG_VERSION"))),
                    )
                    .block_task()
                    .await?;
                if init.agent_capabilities.session_capabilities.list.is_none() {
                    return Ok(Vec::new());
                }
                list_sessions_on(&cx, request_cwd).await
            })
            .await
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "ACP 会话历史读取超时（60 秒）".to_string())?
    .map_err(|error| error.to_string())
}

async fn list_sessions_on(
    connection: &agent_client_protocol::v1::ConnectionTo<Agent>,
    cwd: PathBuf,
) -> Result<Vec<AcpListedSession>, agent_client_protocol::Error> {
    let mut cursor = None;
    let mut sessions = Vec::new();
    // 避免异常 Agent 永远返回 cursor 导致无限请求。
    for _ in 0..20 {
        let mut request = ListSessionsRequest::new().cwd(cwd.clone());
        if let Some(value) = cursor.take() {
            request = request.cursor(value);
        }
        let page = connection.send_request(request).block_task().await?;
        sessions.extend(page.sessions.into_iter().map(|session| AcpListedSession {
            session_id: session.session_id.to_string(),
            cwd: session.cwd.display().to_string(),
            title: session.title,
            updated_at: session.updated_at,
        }));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(sessions)
}

struct Connector {
    connection: agent_client_protocol::v1::ConnectionTo<Agent>,
    session_id: agent_client_protocol::v1::schema::SessionId,
}

#[derive(Debug, Clone)]
struct AgentMeta {
    agent_name: String,
    agent_version: String,
    can_load: bool,
    can_resume: bool,
    can_list: bool,
}

/// 同一工作区、同一 provider 配置共享一个 ACP stdio 进程与连接；每条对话仍有独立 session。
struct AgentRuntime {
    key: String,
    root: String,
    connection: Mutex<Option<agent_client_protocol::v1::ConnectionTo<Agent>>>,
    ready: watch::Sender<Option<Result<AgentMeta, String>>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl AgentRuntime {
    fn new(key: String, root: String) -> (Self, oneshot::Receiver<()>) {
        let (ready, _) = watch::channel(None);
        let (stop, stop_rx) = oneshot::channel();
        (
            Self {
                key,
                root,
                connection: Mutex::new(None),
                ready,
                stop: Mutex::new(Some(stop)),
            },
            stop_rx,
        )
    }

    async fn wait_ready(&self) -> Result<AgentMeta, String> {
        let mut ready = self.ready.subscribe();
        loop {
            if let Some(result) = ready.borrow_and_update().clone() {
                return result;
            }
            ready
                .changed()
                .await
                .map_err(|_| "ACP 进程已退出".to_string())?;
        }
    }

    fn request_stop(&self) {
        if let Ok(mut stop) = self.stop.lock() {
            if let Some(tx) = stop.take() {
                let _ = tx.send(());
            }
        }
    }

    fn connection(&self) -> Result<agent_client_protocol::v1::ConnectionTo<Agent>, String> {
        self.connection
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .cloned()
            .ok_or_else(|| "ACP 进程还未就绪".to_string())
    }
}

struct PendingPermission {
    request_id: String,
    /// `MatchDispatch` 拿到的是未标注协议版本的 responder，回包时按原始 JSON-RPC 发回去
    responder: agent_client_protocol::Responder<RequestPermissionResponse>,
}

struct Chat {
    id: String,
    root: String,
    info: Mutex<Option<AcpInfo>>,
    connector: Mutex<Option<Connector>>,
    pending: Mutex<Option<PendingPermission>>,
    /// 一轮 prompt 还没结束
    busy: AtomicBool,
    /// 停止这条 session 的 update reader
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl Chat {
    fn new(root: &str, id: &str) -> Self {
        Self {
            id: id.to_string(),
            root: root.to_string(),
            info: Mutex::new(None),
            connector: Mutex::new(None),
            pending: Mutex::new(None),
            busy: AtomicBool::new(false),
            stop: Mutex::new(None),
        }
    }

    fn set_stop(&self, tx: oneshot::Sender<()>) {
        if let Ok(mut stop) = self.stop.lock() {
            *stop = Some(tx);
        }
    }

    fn request_stop(&self) {
        if let Ok(mut stop) = self.stop.lock() {
            if let Some(tx) = stop.take() {
                let _ = tx.send(());
            }
        }
        if self.busy.load(Ordering::SeqCst) {
            if let Ok(connector) = self.connector() {
                let _ = connector
                    .connection
                    .send_notification(CancelNotification::new(connector.session_id));
            }
        }
        // 协议要求取消一轮时，把挂着的权限请求也按 cancelled 回掉
        self.cancel_permission();
    }

    fn set_connector(
        &self,
        connection: agent_client_protocol::v1::ConnectionTo<Agent>,
        session_id: agent_client_protocol::v1::schema::SessionId,
    ) {
        if let Ok(mut slot) = self.connector.lock() {
            *slot = Some(Connector {
                connection,
                session_id,
            });
        }
    }

    fn connector(&self) -> Result<Connector, String> {
        self.connector
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|connector| Connector {
                connection: connector.connection.clone(),
                session_id: connector.session_id.clone(),
            })
            .ok_or_else(|| "对话还没启动完成".to_string())
    }

    fn set_info(&self, info: AcpInfo) {
        if let Ok(mut slot) = self.info.lock() {
            *slot = Some(info);
        }
    }

    fn set_pending(&self, pending: PendingPermission) {
        // 同一时刻只允许一条权限请求挂着；旧的直接按取消回掉，免得 responder 悬空
        self.cancel_permission();
        if let Ok(mut slot) = self.pending.lock() {
            *slot = Some(pending);
        }
    }

    fn take_pending(&self, request_id: &str) -> Option<PendingPermission> {
        let mut slot = self.pending.lock().ok()?;
        let matches = slot
            .as_ref()
            .map(|pending| pending.request_id == request_id)
            .unwrap_or(false);
        if matches { slot.take() } else { None }
    }

    /// 把还挂着的权限请求按 cancelled 回掉。返回是否真的回了一条。
    fn cancel_permission(&self) -> bool {
        let pending = self.pending.lock().ok().and_then(|mut slot| slot.take());
        match pending {
            Some(pending) => {
                let _ = pending.responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ));
                true
            }
            None => false,
        }
    }

    fn begin_turn(&self) -> bool {
        !self.busy.swap(true, Ordering::SeqCst)
    }

    fn finish_turn(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

/// 进程级的对话表：key 是前端生成的 chatId。
///
/// chatId 里已经带了工作区信息，但事件和关闭仍按 root 过滤，和 `agent` 模块一致。
pub struct AcpState {
    chats: Arc<Mutex<HashMap<String, Arc<Chat>>>>,
    runtimes: Arc<Mutex<HashMap<String, Arc<AgentRuntime>>>>,
}

impl AcpState {
    pub fn new() -> Self {
        Self {
            chats: Arc::new(Mutex::new(HashMap::new())),
            runtimes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn runtime(&self, key: &str) -> Result<Option<Arc<AgentRuntime>>, String> {
        Ok(self
            .runtimes
            .lock()
            .map_err(|e| e.to_string())?
            .get(key)
            .cloned())
    }

    fn insert_runtime(
        &self,
        runtime: Arc<AgentRuntime>,
    ) -> Result<(Arc<AgentRuntime>, bool), String> {
        let mut runtimes = self.runtimes.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = runtimes.get(&runtime.key) {
            return Ok((Arc::clone(existing), false));
        }
        runtimes.insert(runtime.key.clone(), Arc::clone(&runtime));
        Ok((runtime, true))
    }

    fn insert(&self, chat: Arc<Chat>) -> Result<(), String> {
        let mut chats = self.chats.lock().map_err(|e| e.to_string())?;
        if chats.contains_key(&chat.id) {
            return Err("这个对话已经在运行了".to_string());
        }
        chats.insert(chat.id.clone(), chat);
        Ok(())
    }

    fn get(&self, root: &str, chat_id: &str) -> Result<Arc<Chat>, String> {
        let chats = self.chats.lock().map_err(|e| e.to_string())?;
        let chat = chats
            .get(chat_id)
            .ok_or_else(|| "这个对话已经结束了".to_string())?;
        if chat.root != root {
            return Err("对话不属于这个工作区".to_string());
        }
        Ok(Arc::clone(chat))
    }

    fn remove_if_same(&self, chat_id: &str, chat: &Arc<Chat>) {
        if let Ok(mut chats) = self.chats.lock() {
            let same = chats
                .get(chat_id)
                .map(|current| Arc::ptr_eq(current, chat))
                .unwrap_or(false);
            if same {
                chats.remove(chat_id);
            }
        }
    }

    /// 关工作区 / 退出应用时统一收摊。返回收了几条。
    fn stop_where(&self, predicate: impl Fn(&Chat) -> bool) -> usize {
        let targets: Vec<Arc<Chat>> = match self.chats.lock() {
            Ok(chats) => chats
                .values()
                .filter(|chat| predicate(chat))
                .cloned()
                .collect(),
            Err(_) => return 0,
        };
        for chat in &targets {
            chat.request_stop();
        }
        targets.len()
    }

    pub fn kill_all(&self) {
        self.stop_where(|_| true);
        self.stop_runtimes(|_| true);
    }

    fn stop_root(&self, root: &str) {
        self.stop_where(|chat| chat.root == root);
        self.stop_runtimes(|runtime| runtime.root == root);
    }

    fn stop_runtimes(&self, predicate: impl Fn(&AgentRuntime) -> bool) {
        let Ok(mut runtimes) = self.runtimes.lock() else {
            return;
        };
        let keys: Vec<String> = runtimes
            .iter()
            .filter(|(_, runtime)| predicate(runtime))
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(runtime) = runtimes.remove(&key) {
                runtime.request_stop();
            }
        }
    }
}

/// 关工作区时调用，和 `agent::stop_root` 同一个位置。
pub fn stop_root(state: &AcpState, root: &str) {
    state.stop_root(root);
}

fn runtime_key(root: &str, provider: &str, command: &str, env: &[(String, String)]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    command.hash(&mut hasher);
    env.hash(&mut hasher);
    format!("{root}\0{provider}\0{:016x}", hasher.finish())
}

async fn get_or_start_runtime(
    state: &AcpState,
    key: String,
    root: String,
    config: agent_client_protocol::AcpAgentConfig,
) -> Result<(Arc<AgentRuntime>, AgentMeta), String> {
    let (runtime, stop_rx) = AgentRuntime::new(key.clone(), root);
    let (runtime, is_new) = state.insert_runtime(Arc::new(runtime))?;
    if is_new {
        let runtimes = Arc::clone(&state.runtimes);
        let runtime_for_task = Arc::clone(&runtime);
        tauri::async_runtime::spawn(async move {
            run_agent_runtime(Arc::clone(&runtime_for_task), config, stop_rx).await;
            if let Ok(mut runtimes) = runtimes.lock() {
                if runtimes
                    .get(&runtime_for_task.key)
                    .is_some_and(|current| Arc::ptr_eq(current, &runtime_for_task))
                {
                    runtimes.remove(&runtime_for_task.key);
                }
            }
        });
    }

    match tokio::time::timeout(START_TIMEOUT, runtime.wait_ready()).await {
        Ok(Ok(meta)) => Ok((runtime, meta)),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            runtime.request_stop();
            Err("ACP 进程启动超时（60 秒）".to_string())
        }
    }
}

async fn run_agent_runtime(
    runtime: Arc<AgentRuntime>,
    config: agent_client_protocol::AcpAgentConfig,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let runtime_for_connection = Arc::clone(&runtime);
    let result = Client
        .v1()
        .name("Codovo")
        .connect_with(AcpAgent::new(config), async move |cx| {
            let init = tokio::select! {
                _ = &mut stop_rx => return Ok(()),
                result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("Codovo", env!("CARGO_PKG_VERSION"))),
                    )
                    .block_task() => result?,
            };
            let meta = AgentMeta {
                agent_name: init
                    .agent_info
                    .as_ref()
                    .map(|info| info.name.clone())
                    .unwrap_or_else(|| "ACP Agent".to_string()),
                agent_version: init
                    .agent_info
                    .as_ref()
                    .map(|info| info.version.clone())
                    .unwrap_or_default(),
                can_load: init.agent_capabilities.load_session,
                can_resume: init
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some(),
                can_list: init.agent_capabilities.session_capabilities.list.is_some(),
            };
            if let Ok(mut slot) = runtime_for_connection.connection.lock() {
                *slot = Some(cx.clone());
            }
            runtime_for_connection.ready.send_replace(Some(Ok(meta)));
            let _ = stop_rx.await;
            Ok(())
        })
        .await;

    if runtime.ready.borrow().is_none() {
        let message = result
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "ACP 进程在初始化完成前已停止".to_string());
        runtime.ready.send_replace(Some(Err(message)));
    }
    if let Ok(mut slot) = runtime.connection.lock() {
        *slot = None;
    }
}

// ---- 命令 ----

/// 启动（或恢复）一个对话。幂等性由前端控制：同一个 chatId 正在跑时直接报错。
#[tauri::command]
pub async fn acp_start(
    app: AppHandle,
    state: tauri::State<'_, AcpState>,
    fs_state: tauri::State<'_, FsState>,
    input: AcpStartInput,
) -> Result<AcpInfo, String> {
    let AcpStartInput {
        root,
        chat_id,
        provider,
        command,
        roots,
        env,
        resume_session_id,
    } = input;
    if !launch::supported(&provider) {
        return Err(format!("{provider} 还没有接入 ACP 对话"));
    }

    // 工作区边界：cwd 和附加目录都必须是登记过的根
    let cwd = fs_state.checked_root(&root)?;
    let mut additional = Vec::new();
    for raw in &roots {
        let path = fs_state.checked_root(raw)?;
        if path != cwd && !additional.contains(&path) {
            additional.push(path);
        }
    }

    let env: Vec<(String, String)> = env
        .into_iter()
        .filter(|item| !item.key.trim().is_empty())
        .map(|item| (item.key, item.value))
        .collect();
    let config = launch::agent_config(&provider, &command, &env, &cwd)?;
    let key = runtime_key(&root, &provider, &command, &env);
    let chat = Arc::new(Chat::new(&root, &chat_id));
    state.insert(Arc::clone(&chat))?;
    let (runtime, meta) = match get_or_start_runtime(&state, key, root.clone(), config).await {
        Ok(value) => value,
        Err(error) => {
            state.remove_if_same(&chat_id, &chat);
            return Err(error);
        }
    };
    let connection = match runtime.connection() {
        Ok(connection) => connection,
        Err(error) => {
            state.remove_if_same(&chat_id, &chat);
            return Err(error);
        }
    };
    let (mut session, session_id, resumed) = match tokio::time::timeout(
        START_TIMEOUT,
        create_session(
            &connection,
            &meta,
            cwd.clone(),
            additional,
            resume_session_id,
        ),
    )
    .await
    {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            state.remove_if_same(&chat_id, &chat);
            return Err(error);
        }
        Err(_) => {
            state.remove_if_same(&chat_id, &chat);
            return Err("ACP session 创建超时（60 秒）".to_string());
        }
    };
    let info = AcpInfo {
        provider: provider.clone(),
        agent_name: meta.agent_name,
        agent_version: meta.agent_version,
        session_id: session_id.to_string(),
        cwd: cwd.display().to_string(),
        resumed,
        can_load: meta.can_load,
        can_resume: meta.can_resume,
    };
    chat.set_connector(connection, session_id);
    chat.set_info(info.clone());
    let (stop_tx, stop_rx) = oneshot::channel();
    chat.set_stop(stop_tx);
    let chats = Arc::clone(&state.chats);
    let app_for_task = app.clone();
    let chat_for_task = Arc::clone(&chat);
    event::emit(
        &app,
        &root,
        &chat_id,
        AcpEvent::Ready { info: info.clone() },
    );
    tauri::async_runtime::spawn(async move {
        run_chat_session(
            app_for_task,
            Arc::clone(&chat_for_task),
            &mut session,
            stop_rx,
        )
        .await;
        if let Ok(mut chats) = chats.lock() {
            if chats
                .get(&chat_for_task.id)
                .is_some_and(|current| Arc::ptr_eq(current, &chat_for_task))
            {
                chats.remove(&chat_for_task.id);
            }
        }
    });
    Ok(info)
}

/// 发一条消息。立即返回，正文和工具事件通过 `acp-event` 推回来。
#[tauri::command]
pub fn acp_prompt(
    app: AppHandle,
    state: tauri::State<'_, AcpState>,
    root: String,
    chat_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".to_string());
    }
    let chat = state.get(&root, &chat_id)?;
    let connector = chat.connector()?;
    if !chat.begin_turn() {
        return Err("这一轮还没跑完".to_string());
    }

    let prompt = PromptRequest::new(
        connector.session_id.clone(),
        vec![ContentBlock::Text(TextContent::new(text))],
    );
    let app = app.clone();
    let chat_for_task = Arc::clone(&chat);
    tauri::async_runtime::spawn(async move {
        let result = connector.connection.send_request(prompt).block_task().await;
        match result {
            Ok(response) => {
                let stop_reason = serde_json::to_value(response.stop_reason).unwrap_or(Value::Null);
                event::emit(
                    &app,
                    &chat_for_task.root,
                    &chat_for_task.id,
                    AcpEvent::PromptDone { stop_reason },
                );
            }
            Err(error) => event::emit(
                &app,
                &chat_for_task.root,
                &chat_for_task.id,
                AcpEvent::Error {
                    message: error.to_string(),
                },
            ),
        }
        chat_for_task.finish_turn();
    });
    Ok(())
}

/// 取消当前这一轮。挂着的权限请求按 cancelled 回掉。
#[tauri::command]
pub fn acp_cancel(
    state: tauri::State<'_, AcpState>,
    root: String,
    chat_id: String,
) -> Result<(), String> {
    let chat = state.get(&root, &chat_id)?;
    chat.cancel_permission();
    let connector = chat.connector()?;
    connector
        .connection
        .send_notification(CancelNotification::new(connector.session_id.clone()))
        .map_err(|error| error.to_string())
}

/// 回一条权限请求。`option_id` 为空表示取消。
#[tauri::command]
pub fn acp_respond_permission(
    state: tauri::State<'_, AcpState>,
    root: String,
    chat_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let chat = state.get(&root, &chat_id)?;
    let pending = chat
        .take_pending(&request_id)
        .ok_or_else(|| "这条权限请求已经失效了".to_string())?;
    let outcome = match option_id {
        Some(option_id) => {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
        }
        None => RequestPermissionOutcome::Cancelled,
    };
    pending
        .responder
        .respond(RequestPermissionResponse::new(outcome))
        .map_err(|error| error.to_string())
}

/// 主动结束一个对话（关标签 / 切换 CLI）。进程由 SDK 优雅收尾。
#[tauri::command]
pub fn acp_stop(
    state: tauri::State<'_, AcpState>,
    root: String,
    chat_id: String,
) -> Result<(), String> {
    let chat = state.get(&root, &chat_id)?;
    chat.request_stop();
    Ok(())
}

/// 面板重新挂载时问一下后端还在不在。
#[tauri::command]
pub fn acp_status(state: tauri::State<'_, AcpState>, root: String, chat_id: String) -> AcpStatus {
    let Ok(chat) = state.get(&root, &chat_id) else {
        return AcpStatus {
            running: false,
            busy: false,
            info: None,
        };
    };
    AcpStatus {
        running: chat
            .connector
            .lock()
            .ok()
            .map(|slot| slot.is_some())
            .unwrap_or(false),
        busy: chat.busy.load(Ordering::SeqCst),
        info: chat.info.lock().ok().and_then(|slot| slot.clone()),
    }
}

/// 在共享连接上创建一条独立 ACP session。
async fn create_session(
    connection: &agent_client_protocol::v1::ConnectionTo<Agent>,
    meta: &AgentMeta,
    cwd: PathBuf,
    additional: Vec<PathBuf>,
    resume_session_id: Option<String>,
) -> Result<(ActiveSession<'static, Agent>, SessionId, bool), String> {
    if let Some(id) = resume_session_id.map(SessionId::new) {
        if meta.can_load {
            let request =
                LoadSessionRequest::new(id.clone(), cwd).additional_directories(additional);
            let setup = connection
                .load_session_from(request)
                .block_task()
                .start_session()
                .await
                .map_err(|error| error.to_string())?;
            return Ok((setup.session, id, true));
        }
        if meta.can_resume {
            let request =
                ResumeSessionRequest::new(id.clone(), cwd).additional_directories(additional);
            let setup = connection
                .resume_session_from(request)
                .block_task()
                .start_session()
                .await
                .map_err(|error| error.to_string())?;
            return Ok((setup.session, id, true));
        }
    }

    let mut request = NewSessionRequest::new(cwd);
    if !additional.is_empty() {
        request = request.additional_directories(additional);
    }
    let setup = connection
        .build_session_from(request)
        .block_task()
        .start_session()
        .await
        .map_err(|error| error.to_string())?;
    Ok((setup.session, setup.response.session_id, false))
}

async fn run_chat_session(
    app: AppHandle,
    chat: Arc<Chat>,
    session: &mut ActiveSession<'static, Agent>,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let close_reason = loop {
        tokio::select! {
            _ = &mut stop_rx => break "对话已结束".to_string(),
            message = session.read_update() => match message {
                Ok(SessionMessage::Message(dispatch)) => {
                    handle_dispatch(&app, &chat, dispatch).await;
                }
                Ok(SessionMessage::PromptResponse(response)) => {
                    if let Err(error) = response {
                        event::emit(&app, &chat.root, &chat.id, AcpEvent::Error {
                            message: error.to_string(),
                        });
                    }
                }
                Err(error) => {
                    event::emit(&app, &chat.root, &chat.id, AcpEvent::Error {
                        message: error.to_string(),
                    });
                    break error.to_string();
                }
                Ok(_) => {}
            }
        }
    };
    event::emit(
        &app,
        &chat.root,
        &chat.id,
        AcpEvent::Closed {
            reason: close_reason,
        },
    );
    if let Ok(mut slot) = chat.connector.lock() {
        *slot = None;
    }
    chat.cancel_permission();
    chat.finish_turn();
}

async fn handle_dispatch(app: &AppHandle, chat: &Arc<Chat>, dispatch: V1Dispatch) {
    let app_for_update = app.clone();
    let chat_for_update = Arc::clone(chat);
    let app_for_permission = app.clone();
    let chat_for_permission = Arc::clone(chat);

    let result = MatchDispatch::new(dispatch.into_raw())
        .if_notification(async move |notification: SessionNotification| {
            if let Ok(update) = serde_json::to_value(&notification.update) {
                event::emit(
                    &app_for_update,
                    &chat_for_update.root,
                    &chat_for_update.id,
                    AcpEvent::Update { update },
                );
            }
            Ok(())
        })
        .await
        .if_request(async move |request: RequestPermissionRequest, responder| {
            let request_id = format!("perm_{}", uuid::Uuid::new_v4().simple());
            let tool_call = serde_json::to_value(&request.tool_call).unwrap_or(Value::Null);
            let options: Vec<PermissionChoice> = request
                .options
                .iter()
                .map(|option| PermissionChoice {
                    option_id: option.option_id.to_string(),
                    name: option.name.clone(),
                    kind: serde_json::to_value(option.kind)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_string))
                        .unwrap_or_default(),
                })
                .collect();
            chat_for_permission.set_pending(PendingPermission {
                request_id: request_id.clone(),
                responder,
            });
            event::emit(
                &app_for_permission,
                &chat_for_permission.root,
                &chat_for_permission.id,
                AcpEvent::Permission {
                    request_id,
                    tool_call,
                    options,
                },
            );
            Ok(())
        })
        .await
        .otherwise_ignore();

    if let Err(error) = result {
        event::emit(
            app,
            &chat.root,
            &chat.id,
            AcpEvent::Error {
                message: error.to_string(),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_rejects_duplicate_chat_id() {
        let state = AcpState::new();
        let chat = Arc::new(Chat::new("root", "chat"));
        state.insert(Arc::clone(&chat)).unwrap();
        assert!(state.insert(chat).is_err());
    }

    #[test]
    fn state_requires_matching_root() {
        let state = AcpState::new();
        let chat = Arc::new(Chat::new("root-a", "chat"));
        state.insert(chat).unwrap();
        assert!(state.get("root-b", "chat").is_err());
        assert!(state.get("root-a", "chat").is_ok());
    }

    #[test]
    fn busy_flag_allows_one_turn() {
        let chat = Chat::new("root", "chat");
        assert!(chat.begin_turn());
        assert!(!chat.begin_turn());
        chat.finish_turn();
        assert!(chat.begin_turn());
    }

    #[test]
    fn runtime_pool_key_includes_workspace_and_cli_configuration() {
        let env = vec![("A".to_string(), "one".to_string())];
        let key = runtime_key("root", "opencode", "opencode", &env);
        assert_eq!(key, runtime_key("root", "opencode", "opencode", &env));
        assert_ne!(key, runtime_key("other-root", "opencode", "opencode", &env));
        assert_ne!(key, runtime_key("root", "codebuddy", "opencode", &env));
        assert_ne!(
            key,
            runtime_key("root", "opencode", "opencode --flag", &env)
        );
        assert_ne!(key, runtime_key("root", "opencode", "opencode", &[]));
    }

    /// 手动验证用：需要本机装好并登录 opencode。
    /// 跑 `cargo test --lib acp_probe -- --ignored --nocapture` 看 initialize + session/new 是否通过。
    #[tokio::test]
    #[ignore = "手动验证 ACP 入口：需要本机已安装并登录 opencode"]
    async fn acp_probe_opencode() {
        let config = launch::agent_config(
            "opencode",
            "opencode",
            &[],
            &std::env::current_dir().unwrap(),
        )
        .unwrap();
        let result = Client
            .v1()
            .name("CodovoProbe")
            .connect_with(
                AcpAgent::new(config),
                async |cx| {
                    let init = cx
                        .send_request(
                            InitializeRequest::new(ProtocolVersion::V1).client_info(
                                Implementation::new("CodovoProbe", env!("CARGO_PKG_VERSION")),
                            ),
                        )
                        .block_task()
                        .await?;
                    println!("initialize: {:?}", init.agent_info);
                    let cwd = std::env::current_dir().unwrap();
                    let SessionSetup {
                        mut session,
                        response,
                        ..
                    } = cx
                        .build_session(cwd)
                        .block_task()
                        .start_session()
                        .await?;
                    println!("session/new: {}", response.session_id);
                    // 同一 ACP 子进程 / connection 上再开一条 session，覆盖共享运行时关键路径。
                    let second_session = cx
                        .build_session(std::env::current_dir().unwrap())
                        .block_task()
                        .start_session()
                        .await?;
                    println!("session/new (shared connection): {}", second_session.response.session_id);

                    // 和 acp_prompt 一样：prompt 直接走 connection，响应由请求句柄收；
                    // 流式更新则从 session 的 update 流里读。
                    let prompt = cx
                        .send_request(PromptRequest::new(
                            response.session_id.clone(),
                            vec![ContentBlock::Text(TextContent::new(
                                "只回复 OK 两个字母，不要调用任何工具。",
                            ))],
                        ))
                        .block_task()
                        .await?;
                    println!("prompt stop_reason: {:?}", prompt.stop_reason);

                    let mut output = String::new();
                    for _ in 0..200 {
                        match tokio::time::timeout(Duration::from_millis(200), session.read_update())
                            .await
                        {
                            Ok(Ok(SessionMessage::Message(dispatch))) => {
                                let parsed = MatchDispatch::new(dispatch.into_raw())
                                    .if_notification(
                                        async |notification: SessionNotification| {
                                            if let agent_client_protocol::v1::schema::SessionUpdate::AgentMessageChunk(chunk) =
                                                notification.update
                                            {
                                                if let ContentBlock::Text(text) = chunk.content {
                                                    print!("{}", text.text);
                                                    output.push_str(&text.text);
                                                }
                                            }
                                            Ok(())
                                        },
                                    )
                                    .await
                                    .otherwise_ignore();
                                if let Err(error) = parsed {
                                    println!("update error: {error}");
                                }
                            }
                            Ok(Ok(_)) => {}
                            _ => break,
                        }
                    }
                    println!("\ncollected: {output:?}");
                    Ok(())
                },
            )
            .await;
        result.unwrap();
    }

    /// 手动验证用：检查本机 Qoder CLI 是否能以 `--acp` 完成协议初始化。
    #[tokio::test]
    #[ignore = "手动验证 Qoder ACP：需要本机已安装并登录 Qoder CLI"]
    async fn acp_probe_qoder_initialize() {
        let config =
            launch::agent_config("qoder", "qodercli", &[], &std::env::current_dir().unwrap())
                .unwrap();
        let result = Client
            .v1()
            .name("CodovoQoderProbe")
            .connect_with(AcpAgent::new(config), async |cx| {
                let init = cx
                    .send_request(InitializeRequest::new(ProtocolVersion::V1).client_info(
                        Implementation::new("CodovoQoderProbe", env!("CARGO_PKG_VERSION")),
                    ))
                    .block_task()
                    .await?;
                println!("Qoder ACP initialize: {:?}", init.agent_info);
                Ok(())
            })
            .await;
        result.unwrap();
    }
}
