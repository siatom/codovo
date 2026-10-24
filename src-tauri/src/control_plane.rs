//! M1 控制面：领域协议、平台元数据 SQLite、Registry/Profile、Session 和 Event Store。
//!
//! 这里刻意不复用用户数据库工具（`database.rs`）或 opencode 的原生数据库。
//! 平台数据属于 Codovo 自己的控制面，放在 Tauri app data 目录并由迁移版本管理。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{FromRow, Row, SqlitePool};
use tauri::{AppHandle, Manager};
use tokio::sync::OnceCell;

static ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let sequence = ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{millis:x}_{sequence:x}")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

/// 统一接入方式。未知值不能默认为能力已支持。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationMode {
    Pty,
    Headless,
    NativeApi,
}

impl Default for IntegrationMode {
    fn default() -> Self {
        Self::Pty
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub mode: IntegrationMode,
    pub structured_events: bool,
    pub stream_text: bool,
    pub persistent_session: bool,
    pub session_resume: bool,
    pub session_fork: bool,
    pub interactive_turn: bool,
    pub native_tool_events: bool,
    pub approval_callback: bool,
    pub native_task_events: bool,
    pub token_usage: bool,
    pub model_selection: bool,
    pub native_subagents: bool,
}

impl Default for AgentCapabilities {
    fn default() -> Self {
        Self {
            mode: IntegrationMode::Pty,
            structured_events: false,
            stream_text: true,
            persistent_session: false,
            session_resume: false,
            session_fork: false,
            interactive_turn: true,
            native_tool_events: false,
            approval_callback: false,
            native_task_events: false,
            token_usage: false,
            model_selection: false,
            native_subagents: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHandle {
    pub adapter_instance_id: String,
    pub transport: String,
    pub native_session_id: Option<String>,
    pub process_id: Option<u32>,
    pub connection_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlPlaneError {
    Unavailable,
    UnsupportedCapability,
    AuthRequired,
    Timeout,
    Conflict,
    PermissionDenied,
    TransportError,
    InvalidInput,
    StorageError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallation {
    pub adapter_id: String,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub auth: String,
    pub supported_modes: Vec<IntegrationMode>,
    pub diagnostics: Vec<String>,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub adapter_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub args: Vec<String>,
    /// 只允许非敏感环境变量；密钥必须使用系统凭据库引用。
    pub env: HashMap<String, String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRecord {
    pub id: String,
    pub adapter_id: String,
    pub profile_id: Option<String>,
    pub root: Option<String>,
    pub native_session_id: Option<String>,
    pub transport: String,
    pub recovery_strategy: String,
    pub status: String,
    pub last_seen_at: i64,
    pub native_metadata: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEventEnvelope {
    pub schema_version: i64,
    pub event_id: String,
    pub event_key: String,
    pub event_type: String,
    pub source: String,
    pub adapter_id: String,
    pub profile_id: Option<String>,
    pub session_id: Option<String>,
    pub native_session_id: Option<String>,
    pub run_id: Option<String>,
    pub sequence: Option<i64>,
    pub occurred_at: i64,
    pub recorded_at: i64,
    pub payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub adapter_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateInput {
    pub adapter_id: String,
    pub profile_id: Option<String>,
    pub root: Option<String>,
    pub native_session_id: Option<String>,
    pub transport: String,
    pub recovery_strategy: String,
    pub status: Option<String>,
    pub native_metadata: Option<serde_json::Value>,
}

#[derive(Debug, FromRow)]
struct ProfileRow {
    id: String,
    name: String,
    adapter_id: String,
    command: String,
    cwd: Option<String>,
    args_json: String,
    env_json: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, FromRow)]
struct SessionRow {
    id: String,
    adapter_id: String,
    profile_id: Option<String>,
    root: Option<String>,
    native_session_id: Option<String>,
    transport: String,
    recovery_strategy: String,
    status: String,
    last_seen_at: i64,
    native_metadata_json: String,
}

#[derive(Debug, FromRow)]
struct EventRow {
    schema_version: i64,
    event_id: String,
    event_key: String,
    event_type: String,
    source: String,
    adapter_id: String,
    profile_id: Option<String>,
    session_id: Option<String>,
    native_session_id: Option<String>,
    run_id: Option<String>,
    sequence: Option<i64>,
    occurred_at: i64,
    recorded_at: i64,
    payload_json: String,
}

pub struct ControlPlaneState {
    pool: OnceCell<SqlitePool>,
}

impl ControlPlaneState {
    pub fn new() -> Self {
        Self {
            pool: OnceCell::const_new(),
        }
    }

    pub async fn pool(&self, app: &AppHandle) -> Result<&SqlitePool, String> {
        self.pool
            .get_or_try_init(|| async move {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| format!("获取平台数据目录失败：{error}"))?;
                std::fs::create_dir_all(&dir)
                    .map_err(|error| format!("创建平台数据目录失败：{error}"))?;
                let path = dir.join("codovo-control-plane.sqlite3");
                let options = SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true)
                    .foreign_keys(true);
                let pool = SqlitePoolOptions::new()
                    .max_connections(4)
                    .connect_with(options)
                    .await
                    .map_err(|error| format!("打开平台数据库失败：{error}"))?;
                migrate(&pool).await?;
                Ok(pool)
            })
            .await
    }

    pub async fn mark_unknown(&self, app: &AppHandle) -> Result<u64, String> {
        let pool = self.pool(app).await?;
        let result = sqlx::query(
            "UPDATE agent_sessions SET status = 'unknown', last_seen_at = ? WHERE status IN ('starting', 'running', 'waiting_input')",
        )
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(storage_error)?;
        Ok(result.rows_affected())
    }
}

impl Default for ControlPlaneState {
    fn default() -> Self {
        Self::new()
    }
}

async fn migrate(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(pool)
        .await
        .map_err(storage_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
        .execute(pool).await.map_err(storage_error)?;
    let applied: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
        .fetch_one(pool)
        .await
        .map_err(storage_error)?;
    if applied.unwrap_or(0) < 1 {
        let mut tx = pool.begin().await.map_err(storage_error)?;
        sqlx::query("CREATE TABLE IF NOT EXISTS agent_installations (adapter_id TEXT PRIMARY KEY, executable_path TEXT, version TEXT, auth TEXT NOT NULL, supported_modes_json TEXT NOT NULL, diagnostics_json TEXT NOT NULL, checked_at INTEGER NOT NULL)").execute(&mut *tx).await.map_err(storage_error)?;
        sqlx::query("CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter_id TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, args_json TEXT NOT NULL, env_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").execute(&mut *tx).await.map_err(storage_error)?;
        sqlx::query("CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, profile_id TEXT, root TEXT, native_session_id TEXT, transport TEXT NOT NULL, recovery_strategy TEXT NOT NULL, status TEXT NOT NULL, last_seen_at INTEGER NOT NULL, native_metadata_json TEXT NOT NULL)").execute(&mut *tx).await.map_err(storage_error)?;
        sqlx::query("CREATE TABLE IF NOT EXISTS execution_events (event_id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, event_key TEXT NOT NULL, schema_version INTEGER NOT NULL, event_type TEXT NOT NULL, source TEXT NOT NULL, profile_id TEXT, session_id TEXT, native_session_id TEXT, run_id TEXT, sequence INTEGER, occurred_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL, payload_json TEXT NOT NULL, UNIQUE(adapter_id, event_key))").execute(&mut *tx).await.map_err(storage_error)?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status)",
        )
        .execute(&mut *tx)
        .await
        .map_err(storage_error)?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_execution_events_session ON execution_events(session_id, recorded_at)").execute(&mut *tx).await.map_err(storage_error)?;
        sqlx::query("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)")
            .bind(now_ms())
            .execute(&mut *tx)
            .await
            .map_err(storage_error)?;
        tx.commit().await.map_err(storage_error)?;
    }
    Ok(())
}

fn storage_error(error: sqlx::Error) -> String {
    format!("平台数据库错误：{error}")
}

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("序列化平台数据失败：{error}"))
}

fn parse<T: for<'de> Deserialize<'de>>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("解析 {label} 失败：{error}"))
}

fn validate_profile(input: &AgentProfileInput) -> Result<(), String> {
    if input.name.trim().is_empty()
        || input.adapter_id.trim().is_empty()
        || input.command.trim().is_empty()
    {
        return Err("Agent Profile 的名称、适配器和命令不能为空".into());
    }
    for key in input.env.keys() {
        let upper = key.to_ascii_uppercase();
        if [
            "TOKEN",
            "SECRET",
            "PASSWORD",
            "API_KEY",
            "PRIVATE_KEY",
            "CREDENTIAL",
        ]
        .iter()
        .any(|part| upper.contains(part))
        {
            return Err(format!("环境变量 {key} 可能包含凭据，请改用系统凭据库引用"));
        }
    }
    Ok(())
}

fn profile_from_row(row: ProfileRow) -> Result<AgentProfile, String> {
    Ok(AgentProfile {
        id: row.id,
        name: row.name,
        adapter_id: row.adapter_id,
        command: row.command,
        cwd: row.cwd,
        args: parse(&row.args_json, "Profile 参数")?,
        env: parse(&row.env_json, "Profile 环境变量")?,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn session_from_row(row: SessionRow) -> Result<AgentSessionRecord, String> {
    Ok(AgentSessionRecord {
        id: row.id,
        adapter_id: row.adapter_id,
        profile_id: row.profile_id,
        root: row.root,
        native_session_id: row.native_session_id,
        transport: row.transport,
        recovery_strategy: row.recovery_strategy,
        status: row.status,
        last_seen_at: row.last_seen_at,
        native_metadata: parse(&row.native_metadata_json, "Session 元数据")?,
    })
}

fn event_from_row(row: EventRow) -> Result<ExecutionEventEnvelope, String> {
    Ok(ExecutionEventEnvelope {
        schema_version: row.schema_version,
        event_id: row.event_id,
        event_key: row.event_key,
        event_type: row.event_type,
        source: row.source,
        adapter_id: row.adapter_id,
        profile_id: row.profile_id,
        session_id: row.session_id,
        native_session_id: row.native_session_id,
        run_id: row.run_id,
        sequence: row.sequence,
        occurred_at: row.occurred_at,
        recorded_at: row.recorded_at,
        payload: parse(&row.payload_json, "事件 payload")?,
    })
}

#[tauri::command]
pub async fn control_registry_scan(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    queries: Vec<crate::installer::AgentCliQuery>,
) -> Result<Vec<AgentInstallation>, String> {
    let statuses = crate::installer::check_agent_clis(queries).await?;
    let pool = state.pool(&app).await?;
    let checked = now_ms();
    let mut result = Vec::with_capacity(statuses.len());
    for status in statuses {
        let installation = AgentInstallation {
            adapter_id: status.id,
            executable_path: None,
            version: status.version,
            auth: if status.installed {
                "unknown".into()
            } else {
                "unavailable".into()
            },
            supported_modes: vec![IntegrationMode::Pty],
            diagnostics: if status.installed {
                vec!["命令可执行；认证和结构化能力尚未验证".into()]
            } else {
                vec!["未在 PATH 中找到命令".into()]
            },
            checked_at: checked,
        };
        sqlx::query("INSERT INTO agent_installations(adapter_id, executable_path, version, auth, supported_modes_json, diagnostics_json, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(adapter_id) DO UPDATE SET executable_path=excluded.executable_path, version=excluded.version, auth=excluded.auth, supported_modes_json=excluded.supported_modes_json, diagnostics_json=excluded.diagnostics_json, checked_at=excluded.checked_at")
            .bind(&installation.adapter_id).bind(&installation.executable_path).bind(&installation.version).bind(&installation.auth)
            .bind(json(&installation.supported_modes)?).bind(json(&installation.diagnostics)?).bind(checked).execute(pool).await.map_err(storage_error)?;
        result.push(installation);
    }
    Ok(result)
}

#[tauri::command]
pub async fn control_registry_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
) -> Result<Vec<AgentInstallation>, String> {
    let rows = sqlx::query("SELECT adapter_id, executable_path, version, auth, supported_modes_json, diagnostics_json, checked_at FROM agent_installations ORDER BY adapter_id")
        .fetch_all(state.pool(&app).await?).await.map_err(storage_error)?;
    rows.into_iter()
        .map(|row| {
            Ok(AgentInstallation {
                adapter_id: row.try_get("adapter_id").map_err(|e| e.to_string())?,
                executable_path: row.try_get("executable_path").map_err(|e| e.to_string())?,
                version: row.try_get("version").map_err(|e| e.to_string())?,
                auth: row.try_get("auth").map_err(|e| e.to_string())?,
                supported_modes: parse(
                    &row.try_get::<String, _>("supported_modes_json")
                        .map_err(|e| e.to_string())?,
                    "能力模式",
                )?,
                diagnostics: parse(
                    &row.try_get::<String, _>("diagnostics_json")
                        .map_err(|e| e.to_string())?,
                    "诊断",
                )?,
                checked_at: row.try_get("checked_at").map_err(|e| e.to_string())?,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn control_profile_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
) -> Result<Vec<AgentProfile>, String> {
    let rows = sqlx::query_as::<_, ProfileRow>("SELECT id, name, adapter_id, command, cwd, args_json, env_json, created_at, updated_at FROM agent_profiles ORDER BY name")
        .fetch_all(state.pool(&app).await?).await.map_err(storage_error)?;
    rows.into_iter().map(profile_from_row).collect()
}

#[tauri::command]
pub async fn control_profile_upsert(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    input: AgentProfileInput,
) -> Result<AgentProfile, String> {
    validate_profile(&input)?;
    let pool = state.pool(&app).await?;
    let now = now_ms();
    let profile = AgentProfile {
        id: input.id.unwrap_or_else(|| id("profile")),
        name: input.name.trim().to_string(),
        adapter_id: input.adapter_id.trim().to_string(),
        command: input.command.trim().to_string(),
        cwd: input.cwd.filter(|value| !value.trim().is_empty()),
        args: input.args,
        env: input.env,
        created_at: now,
        updated_at: now,
    };
    let args_json = json(&profile.args)?;
    let env_json = json(&profile.env)?;
    sqlx::query("INSERT INTO agent_profiles(id, name, adapter_id, command, cwd, args_json, env_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, adapter_id=excluded.adapter_id, command=excluded.command, cwd=excluded.cwd, args_json=excluded.args_json, env_json=excluded.env_json, updated_at=excluded.updated_at")
        .bind(&profile.id).bind(&profile.name).bind(&profile.adapter_id).bind(&profile.command).bind(&profile.cwd).bind(args_json).bind(env_json).bind(profile.created_at).bind(profile.updated_at).execute(pool).await.map_err(storage_error)?;
    Ok(profile)
}

#[tauri::command]
pub async fn control_profile_delete(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    sqlx::query("DELETE FROM agent_profiles WHERE id = ?")
        .bind(id)
        .execute(state.pool(&app).await?)
        .await
        .map_err(storage_error)?;
    Ok(())
}

#[tauri::command]
pub async fn control_session_create(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    input: SessionCreateInput,
) -> Result<AgentSessionRecord, String> {
    if input.adapter_id.trim().is_empty() || input.transport.trim().is_empty() {
        return Err("Session 的 adapter_id 和 transport 不能为空".into());
    }
    let session = AgentSessionRecord {
        id: id("session"),
        adapter_id: input.adapter_id,
        profile_id: input.profile_id,
        root: input.root,
        native_session_id: input.native_session_id,
        transport: input.transport,
        recovery_strategy: input.recovery_strategy,
        status: input.status.unwrap_or_else(|| "detached".into()),
        last_seen_at: now_ms(),
        native_metadata: input.native_metadata.unwrap_or(serde_json::json!({})),
    };
    sqlx::query("INSERT INTO agent_sessions(id, adapter_id, profile_id, root, native_session_id, transport, recovery_strategy, status, last_seen_at, native_metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&session.id).bind(&session.adapter_id).bind(&session.profile_id).bind(&session.root).bind(&session.native_session_id).bind(&session.transport).bind(&session.recovery_strategy).bind(&session.status).bind(session.last_seen_at).bind(json(&session.native_metadata)?).execute(state.pool(&app).await?).await.map_err(storage_error)?;
    Ok(session)
}

#[tauri::command]
pub async fn control_session_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    root: Option<String>,
) -> Result<Vec<AgentSessionRecord>, String> {
    let pool = state.pool(&app).await?;
    let rows = if let Some(root) = root {
        sqlx::query_as::<_, SessionRow>("SELECT id, adapter_id, profile_id, root, native_session_id, transport, recovery_strategy, status, last_seen_at, native_metadata_json FROM agent_sessions WHERE root = ? ORDER BY last_seen_at DESC").bind(root).fetch_all(pool).await
    } else {
        sqlx::query_as::<_, SessionRow>("SELECT id, adapter_id, profile_id, root, native_session_id, transport, recovery_strategy, status, last_seen_at, native_metadata_json FROM agent_sessions ORDER BY last_seen_at DESC").fetch_all(pool).await
    };
    rows.map_err(storage_error)?
        .into_iter()
        .map(session_from_row)
        .collect()
}

#[tauri::command]
pub async fn control_session_update_status(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    id: String,
    status: String,
) -> Result<(), String> {
    if status.trim().is_empty() {
        return Err("Session 状态不能为空".into());
    }
    sqlx::query("UPDATE agent_sessions SET status = ?, last_seen_at = ? WHERE id = ?")
        .bind(status)
        .bind(now_ms())
        .bind(id)
        .execute(state.pool(&app).await?)
        .await
        .map_err(storage_error)?;
    Ok(())
}

#[tauri::command]
pub async fn control_event_record(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    mut event: ExecutionEventEnvelope,
) -> Result<bool, String> {
    if event.schema_version <= 0
        || event.event_key.trim().is_empty()
        || event.adapter_id.trim().is_empty()
    {
        return Err("事件缺少 schemaVersion、eventKey 或 adapterId".into());
    }
    if event.event_id.trim().is_empty() {
        event.event_id = id("event");
    }
    if event.recorded_at <= 0 {
        event.recorded_at = now_ms();
    }
    let result = sqlx::query("INSERT OR IGNORE INTO execution_events(event_id, adapter_id, event_key, schema_version, event_type, source, profile_id, session_id, native_session_id, run_id, sequence, occurred_at, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&event.event_id).bind(&event.adapter_id).bind(&event.event_key).bind(event.schema_version).bind(&event.event_type).bind(&event.source).bind(&event.profile_id).bind(&event.session_id).bind(&event.native_session_id).bind(&event.run_id).bind(event.sequence).bind(event.occurred_at).bind(event.recorded_at).bind(json(&event.payload)?).execute(state.pool(&app).await?).await.map_err(storage_error)?;
    Ok(result.rows_affected() == 1)
}

#[tauri::command]
pub async fn control_event_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    session_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<ExecutionEventEnvelope>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let offset = offset.unwrap_or(0).max(0);
    let pool = state.pool(&app).await?;
    let rows = if let Some(session_id) = session_id {
        sqlx::query_as::<_, EventRow>("SELECT schema_version, event_id, event_key, event_type, source, adapter_id, profile_id, session_id, native_session_id, run_id, sequence, occurred_at, recorded_at, payload_json FROM execution_events WHERE session_id = ? ORDER BY recorded_at, event_id LIMIT ? OFFSET ?").bind(session_id).bind(limit).bind(offset).fetch_all(pool).await
    } else {
        sqlx::query_as::<_, EventRow>("SELECT schema_version, event_id, event_key, event_type, source, adapter_id, profile_id, session_id, native_session_id, run_id, sequence, occurred_at, recorded_at, payload_json FROM execution_events ORDER BY recorded_at, event_id LIMIT ? OFFSET ?").bind(limit).bind(offset).fetch_all(pool).await
    };
    rows.map_err(storage_error)?
        .into_iter()
        .map(event_from_row)
        .collect()
}

#[tauri::command]
pub async fn control_reconcile(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
) -> Result<u64, String> {
    state.mark_unknown(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_default_to_safe_pty_values() {
        let value = AgentCapabilities::default();
        assert_eq!(value.mode, IntegrationMode::Pty);
        assert!(!value.structured_events);
        assert!(!value.approval_callback);
        assert!(!value.session_resume);
    }

    #[test]
    fn profile_rejects_secret_like_environment_keys() {
        let input = AgentProfileInput {
            id: None,
            name: "x".into(),
            adapter_id: "fake".into(),
            command: "fake".into(),
            cwd: None,
            args: vec![],
            env: HashMap::from([("API_TOKEN".into(), "secret".into())]),
        };
        assert!(validate_profile(&input).is_err());
    }

    #[test]
    fn event_ids_are_unique() {
        assert_ne!(id("event"), id("event"));
    }
}
