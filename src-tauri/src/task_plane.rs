//! M2 任务控制面：Goal/Milestone/Task、Proposal、依赖、Run、项目与验收证据。
//!
//! 该模块只负责领域约束与平台存储；实际 Agent 进程仍由 M1 Runtime/Adapter 管理。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Row, SqlitePool};
use tauri::{AppHandle, Manager};

use crate::control_plane::ControlPlaneState;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis() as i64)
        .unwrap_or_default()
}

fn id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub id: String,
    pub goal_id: String,
    pub title: String,
    pub status: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub goal_id: Option<String>,
    pub milestone_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: i64,
    pub acceptance: Vec<String>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub task_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub payload: serde_json::Value,
    pub source: String,
    pub status: String,
    pub decided_by: Option<String>,
    pub decided_at: Option<i64>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub attempt_no: i64,
    pub status: String,
    pub profile_id: Option<String>,
    pub session_id: Option<String>,
    pub worktree_id: Option<String>,
    pub baseline_sha: Option<String>,
    pub baseline_dirty: Option<bool>,
    pub final_sha: Option<String>,
    pub final_dirty: Option<bool>,
    pub changed_paths: Vec<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub project_id: String,
    pub root: String,
    pub default_branch: Option<String>,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLease {
    pub id: String,
    pub repository_id: String,
    pub path: String,
    pub owner_task_id: Option<String>,
    pub owner_run_id: Option<String>,
    pub locked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub id: String,
    pub run_id: String,
    pub kind: String,
    pub status: String,
    pub summary: String,
    pub evidence: serde_json::Value,
    pub source: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalInput {
    pub id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub expected_version: Option<i64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneInput {
    pub id: Option<String>,
    pub goal_id: String,
    pub title: String,
    pub status: Option<String>,
    pub expected_version: Option<i64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub id: Option<String>,
    pub goal_id: Option<String>,
    pub milestone_id: Option<String>,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub acceptance: Option<Vec<String>>,
    pub expected_version: Option<i64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalInput {
    pub id: Option<String>,
    pub task_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub payload: serde_json::Value,
    pub source: String,
    pub expected_version: Option<i64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    pub task_id: String,
    pub profile_id: Option<String>,
    pub worktree_id: Option<String>,
    pub baseline_sha: Option<String>,
    pub baseline_dirty: Option<bool>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationInput {
    pub run_id: String,
    pub kind: String,
    pub status: String,
    pub summary: String,
    pub evidence: serde_json::Value,
    pub source: String,
}

#[derive(Debug, FromRow)]
struct GoalRow {
    id: String,
    title: String,
    description: String,
    status: String,
    version: i64,
    created_at: i64,
    updated_at: i64,
}
#[derive(Debug, FromRow)]
struct MilestoneRow {
    id: String,
    goal_id: String,
    title: String,
    status: String,
    version: i64,
    created_at: i64,
    updated_at: i64,
}
#[derive(Debug, FromRow)]
struct TaskRow {
    id: String,
    goal_id: Option<String>,
    milestone_id: Option<String>,
    parent_id: Option<String>,
    title: String,
    description: String,
    status: String,
    priority: i64,
    acceptance_json: String,
    version: i64,
    created_at: i64,
    updated_at: i64,
}
#[derive(Debug, FromRow)]
struct ProposalRow {
    id: String,
    task_id: Option<String>,
    kind: String,
    title: String,
    payload_json: String,
    source: String,
    status: String,
    decided_by: Option<String>,
    decided_at: Option<i64>,
    version: i64,
}
#[derive(Debug, FromRow)]
struct RunRow {
    id: String,
    task_id: String,
    attempt_no: i64,
    status: String,
    profile_id: Option<String>,
    session_id: Option<String>,
    worktree_id: Option<String>,
    baseline_sha: Option<String>,
    baseline_dirty: Option<i64>,
    final_sha: Option<String>,
    final_dirty: Option<i64>,
    changed_paths_json: String,
    started_at: i64,
    finished_at: Option<i64>,
    error: Option<String>,
}

fn invalid(message: impl Into<String>) -> String {
    format!("invalid_input: {}", message.into())
}
fn storage(error: sqlx::Error) -> String {
    format!("storage_error: {error}")
}
fn parse_json<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|e| format!("storage_error: {e}"))
}
fn bool_value(value: Option<i64>) -> Option<bool> {
    value.map(|v| v != 0)
}

fn goal(row: GoalRow) -> Goal {
    Goal {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}
fn milestone(row: MilestoneRow) -> Milestone {
    Milestone {
        id: row.id,
        goal_id: row.goal_id,
        title: row.title,
        status: row.status,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}
fn task(row: TaskRow) -> Result<Task, String> {
    Ok(Task {
        id: row.id,
        goal_id: row.goal_id,
        milestone_id: row.milestone_id,
        parent_id: row.parent_id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        acceptance: parse_json(&row.acceptance_json)?,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}
fn proposal(row: ProposalRow) -> Result<Proposal, String> {
    Ok(Proposal {
        id: row.id,
        task_id: row.task_id,
        kind: row.kind,
        title: row.title,
        payload: parse_json(&row.payload_json)?,
        source: row.source,
        status: row.status,
        decided_by: row.decided_by,
        decided_at: row.decided_at,
        version: row.version,
    })
}
fn run(row: RunRow) -> Result<TaskRun, String> {
    Ok(TaskRun {
        id: row.id,
        task_id: row.task_id,
        attempt_no: row.attempt_no,
        status: row.status,
        profile_id: row.profile_id,
        session_id: row.session_id,
        worktree_id: row.worktree_id,
        baseline_sha: row.baseline_sha,
        baseline_dirty: bool_value(row.baseline_dirty),
        final_sha: row.final_sha,
        final_dirty: bool_value(row.final_dirty),
        changed_paths: parse_json(&row.changed_paths_json)?,
        started_at: row.started_at,
        finished_at: row.finished_at,
        error: row.error,
    })
}

async fn pool(
    state: &tauri::State<'_, ControlPlaneState>,
    app: &AppHandle,
) -> Result<&SqlitePool, String> {
    let pool = state.pool(app).await?;
    ensure_schema(pool).await?;
    Ok(pool)
}

/// 应用启动时执行 M2 幂等迁移；命令入口仍会再次调用，兼容热升级和旧数据库。
pub async fn initialize(state: &ControlPlaneState, app: &AppHandle) -> Result<(), String> {
    let pool = state.pool(app).await?;
    ensure_schema(pool).await
}

async fn ensure_schema(pool: &SqlitePool) -> Result<(), String> {
    let statements = [
        "CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS milestones (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL, milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL, parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, acceptance_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, PRIMARY KEY(task_id, depends_on_id), CHECK(task_id <> depends_on_id))",
        "CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, kind TEXT NOT NULL, title TEXT NOT NULL, payload_json TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, decided_at INTEGER, version INTEGER NOT NULL DEFAULT 1)",
        "CREATE TABLE IF NOT EXISTS task_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, attempt_no INTEGER NOT NULL, status TEXT NOT NULL, profile_id TEXT, session_id TEXT, worktree_id TEXT, baseline_sha TEXT, baseline_dirty INTEGER, final_sha TEXT, final_dirty INTEGER, changed_paths_json TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT, UNIQUE(task_id, attempt_no))",
        "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)",
        "CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, root TEXT NOT NULL UNIQUE, default_branch TEXT, valid INTEGER NOT NULL DEFAULT 0)",
        "CREATE TABLE IF NOT EXISTS worktree_leases (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, path TEXT NOT NULL UNIQUE, owner_task_id TEXT, owner_run_id TEXT, locked_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS run_verifications (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, evidence_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS idx_tasks_goal_status ON tasks(goal_id, status)",
        "CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, attempt_no DESC)",
        "CREATE INDEX IF NOT EXISTS idx_events_run ON execution_events(run_id, recorded_at)",
    ];
    for statement in statements {
        sqlx::query(statement)
            .execute(pool)
            .await
            .map_err(storage)?;
    }
    sqlx::query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)")
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(storage)?;
    Ok(())
}

fn allowed_transition(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("draft", "ready" | "cancelled")
            | ("ready", "running" | "blocked" | "cancelled")
            | ("blocked", "ready" | "cancelled")
            | ("running", "waiting" | "succeeded" | "failed" | "cancelled")
            | ("waiting", "running" | "cancelled")
            | ("failed", "ready" | "cancelled")
            | ("succeeded", "ready")
            | ("cancelled", "ready")
    )
}

async fn task_status(pool: &SqlitePool, task_id: &str) -> Result<String, String> {
    sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(pool)
        .await
        .map_err(storage)?
        .ok_or_else(|| "not_found: task".into())
}

#[tauri::command(async)]
pub async fn task_goal_upsert(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    input: GoalInput,
) -> Result<Goal, String> {
    let pool = pool(&state, &app).await?;
    let now = now_ms();
    let entity_id = input.id.unwrap_or_else(|| id("goal"));
    let status = input.status.unwrap_or_else(|| "active".into());
    if input.title.trim().is_empty()
        || !matches!(status.as_str(), "active" | "completed" | "cancelled")
    {
        return Err(invalid("goal title/status"));
    }
    let expected = input.expected_version.unwrap_or(0);
    if expected == 0 {
        sqlx::query("INSERT INTO goals(id,title,description,status,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)").bind(&entity_id).bind(input.title.trim()).bind(input.description.unwrap_or_default()).bind(status).bind(now).bind(now).execute(pool).await.map_err(storage)?;
    } else {
        let result = sqlx::query("UPDATE goals SET title=?, description=?, status=?, version=version+1, updated_at=? WHERE id=? AND version=?").bind(input.title.trim()).bind(input.description.unwrap_or_default()).bind(status).bind(now).bind(&entity_id).bind(expected).execute(pool).await.map_err(storage)?;
        if result.rows_affected() != 1 {
            return Err("conflict: goal version changed".into());
        }
    }
    sqlx::query_as::<_, GoalRow>(
        "SELECT id,title,description,status,version,created_at,updated_at FROM goals WHERE id=?",
    )
    .bind(entity_id)
    .fetch_one(pool)
    .await
    .map(goal)
    .map_err(storage)
}

#[tauri::command(async)]
pub async fn task_goal_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
) -> Result<Vec<Goal>, String> {
    let pool = pool(&state, &app).await?;
    sqlx::query_as::<_, GoalRow>("SELECT id,title,description,status,version,created_at,updated_at FROM goals ORDER BY updated_at DESC").fetch_all(pool).await.map(|rows| rows.into_iter().map(goal).collect()).map_err(storage)
}

#[tauri::command(async)]
pub async fn task_milestone_upsert(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    input: MilestoneInput,
) -> Result<Milestone, String> {
    let pool = pool(&state, &app).await?;
    let now = now_ms();
    let entity_id = input.id.unwrap_or_else(|| id("milestone"));
    let status = input.status.unwrap_or_else(|| "active".into());
    if input.title.trim().is_empty() {
        return Err(invalid("milestone title"));
    }
    if input.expected_version.unwrap_or(0) == 0 {
        sqlx::query("INSERT INTO milestones(id,goal_id,title,status,version,created_at,updated_at) VALUES(?,?,?, ?,1,?,?)").bind(&entity_id).bind(&input.goal_id).bind(input.title.trim()).bind(status).bind(now).bind(now).execute(pool).await.map_err(storage)?;
    } else {
        let r=sqlx::query("UPDATE milestones SET title=?, status=?, version=version+1, updated_at=? WHERE id=? AND goal_id=? AND version=?").bind(input.title.trim()).bind(status).bind(now).bind(&entity_id).bind(&input.goal_id).bind(input.expected_version).execute(pool).await.map_err(storage)?;
        if r.rows_affected() != 1 {
            return Err("conflict: milestone version changed".into());
        }
    }
    sqlx::query_as::<_, MilestoneRow>(
        "SELECT id,goal_id,title,status,version,created_at,updated_at FROM milestones WHERE id=?",
    )
    .bind(entity_id)
    .fetch_one(pool)
    .await
    .map(milestone)
    .map_err(storage)
}

#[tauri::command(async)]
pub async fn task_milestone_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    goal_id: Option<String>,
) -> Result<Vec<Milestone>, String> {
    let pool = pool(&state, &app).await?;
    let rows = if let Some(goal_id) = goal_id {
        sqlx::query_as::<_,MilestoneRow>("SELECT id,goal_id,title,status,version,created_at,updated_at FROM milestones WHERE goal_id=? ORDER BY created_at").bind(goal_id).fetch_all(pool).await
    } else {
        sqlx::query_as::<_,MilestoneRow>("SELECT id,goal_id,title,status,version,created_at,updated_at FROM milestones ORDER BY created_at").fetch_all(pool).await
    };
    rows.map(|v| v.into_iter().map(milestone).collect())
        .map_err(storage)
}

#[tauri::command(async)]
pub async fn task_upsert(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    input: TaskInput,
) -> Result<Task, String> {
    let pool = pool(&state, &app).await?;
    let now = now_ms();
    let entity_id = input.id.unwrap_or_else(|| id("task"));
    let status = input.status.unwrap_or_else(|| "draft".into());
    if input.title.trim().is_empty()
        || ![
            "draft",
            "ready",
            "blocked",
            "running",
            "waiting",
            "succeeded",
            "failed",
            "cancelled",
        ]
        .contains(&status.as_str())
    {
        return Err(invalid("task title/status"));
    }
    if let Some(parent) = &input.parent_id {
        if parent == &entity_id {
            return Err(invalid("task cannot parent itself"));
        }
        let mut seen = HashSet::new();
        let mut cursor = Some(parent.clone());
        while let Some(current) = cursor {
            if !seen.insert(current.clone()) {
                return Err(invalid("parent cycle"));
            }
            cursor = sqlx::query_scalar("SELECT parent_id FROM tasks WHERE id=?")
                .bind(current)
                .fetch_optional(pool)
                .await
                .map_err(storage)?;
        }
    }
    let acceptance =
        serde_json::to_string(&input.acceptance.unwrap_or_default()).map_err(|e| e.to_string())?;
    let expected = input.expected_version.unwrap_or(0);
    if expected == 0 {
        sqlx::query("INSERT INTO tasks(id,goal_id,milestone_id,parent_id,title,description,status,priority,acceptance_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)").bind(&entity_id).bind(input.goal_id).bind(input.milestone_id).bind(input.parent_id).bind(input.title.trim()).bind(input.description.unwrap_or_default()).bind(status).bind(input.priority.unwrap_or(0)).bind(acceptance).bind(now).bind(now).execute(pool).await.map_err(storage)?;
    } else {
        let r=sqlx::query("UPDATE tasks SET goal_id=?, milestone_id=?, parent_id=?, title=?, description=?, status=?, priority=?, acceptance_json=?, version=version+1, updated_at=? WHERE id=? AND version=?").bind(input.goal_id).bind(input.milestone_id).bind(input.parent_id).bind(input.title.trim()).bind(input.description.unwrap_or_default()).bind(status).bind(input.priority.unwrap_or(0)).bind(acceptance).bind(now).bind(&entity_id).bind(expected).execute(pool).await.map_err(storage)?;
        if r.rows_affected() != 1 {
            return Err("conflict: task version changed".into());
        }
    }
    sqlx::query_as::<_,TaskRow>("SELECT id,goal_id,milestone_id,parent_id,title,description,status,priority,acceptance_json,version,created_at,updated_at FROM tasks WHERE id=?").bind(entity_id).fetch_one(pool).await.map_err(storage).and_then(task)
}

#[tauri::command(async)]
pub async fn task_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    goal_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<Task>, String> {
    let pool = pool(&state, &app).await?;
    let rows=match (goal_id,status){(Some(g),Some(s))=>sqlx::query_as::<_,TaskRow>("SELECT id,goal_id,milestone_id,parent_id,title,description,status,priority,acceptance_json,version,created_at,updated_at FROM tasks WHERE goal_id=? AND status=? ORDER BY priority DESC,updated_at DESC").bind(g).bind(s).fetch_all(pool).await,(Some(g),None)=>sqlx::query_as::<_,TaskRow>("SELECT id,goal_id,milestone_id,parent_id,title,description,status,priority,acceptance_json,version,created_at,updated_at FROM tasks WHERE goal_id=? ORDER BY priority DESC,updated_at DESC").bind(g).fetch_all(pool).await,(None,Some(s))=>sqlx::query_as::<_,TaskRow>("SELECT id,goal_id,milestone_id,parent_id,title,description,status,priority,acceptance_json,version,created_at,updated_at FROM tasks WHERE status=? ORDER BY priority DESC,updated_at DESC").bind(s).fetch_all(pool).await,(None,None)=>sqlx::query_as::<_,TaskRow>("SELECT id,goal_id,milestone_id,parent_id,title,description,status,priority,acceptance_json,version,created_at,updated_at FROM tasks ORDER BY priority DESC,updated_at DESC").fetch_all(pool).await};
    rows.map_err(storage)?.into_iter().map(task).collect()
}

#[tauri::command(async)]
pub async fn task_transition(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    id: String,
    to: String,
    expected_version: i64,
) -> Result<Task, String> {
    let pool = pool(&state, &app).await?;
    let from = task_status(pool, &id).await?;
    if !allowed_transition(&from, &to) {
        return Err(format!("invalid_transition: task {from} -> {to}"));
    }
    let r = sqlx::query(
        "UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?",
    )
    .bind(&to)
    .bind(now_ms())
    .bind(&id)
    .bind(expected_version)
    .execute(pool)
    .await
    .map_err(storage)?;
    if r.rows_affected() != 1 {
        return Err("conflict: task version changed".into());
    }
    sqlx::query_as::<_,TaskRow>("SELECT id,goal_id,milestone_id,parent_id,title,description,status,priority,acceptance_json,version,created_at,updated_at FROM tasks WHERE id=?").bind(id).fetch_one(pool).await.map_err(storage).and_then(task)
}

#[tauri::command(async)]
pub async fn task_dependency_add(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    task_id: String,
    depends_on_id: String,
) -> Result<(), String> {
    let pool = pool(&state, &app).await?;
    if task_id == depends_on_id {
        return Err(invalid("dependency self-cycle"));
    }
    let nodes = sqlx::query("SELECT task_id,depends_on_id FROM task_dependencies")
        .fetch_all(pool)
        .await
        .map_err(storage)?;
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    for row in nodes {
        edges
            .entry(row.try_get("task_id").map_err(storage)?)
            .or_default()
            .push(row.try_get("depends_on_id").map_err(storage)?);
    }
    edges
        .entry(task_id.clone())
        .or_default()
        .push(depends_on_id.clone());
    // 新边 task -> dependency 只有在 dependency 已经能到达 task 时才成环。
    let mut stack = vec![depends_on_id.clone()];
    let mut visited = HashSet::new();
    while let Some(node) = stack.pop() {
        if node == task_id {
            return Err("invalid_input: dependency cycle".into());
        }
        if visited.insert(node.clone()) {
            if let Some(next) = edges.get(&node) {
                stack.extend(next.iter().cloned());
            }
        }
    }
    sqlx::query("INSERT INTO task_dependencies(task_id,depends_on_id) VALUES(?,?)")
        .bind(task_id)
        .bind(depends_on_id)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| {
            if matches!(e, sqlx::Error::Database(_)) {
                "conflict: dependency already exists".into()
            } else {
                storage(e)
            }
        })
}

#[tauri::command(async)]
pub async fn task_dependency_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    task_id: String,
) -> Result<Vec<String>, String> {
    let pool = pool(&state, &app).await?;
    sqlx::query_scalar(
        "SELECT depends_on_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_id",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await
    .map_err(storage)
}

#[tauri::command(async)]
pub async fn proposal_create(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    input: ProposalInput,
) -> Result<Proposal, String> {
    let pool = pool(&state, &app).await?;
    let entity_id = input.id.unwrap_or_else(|| id("proposal"));
    let r=sqlx::query("INSERT INTO proposals(id,task_id,kind,title,payload_json,source,status,version) VALUES(?,?,?,?,?,?,?,1)").bind(&entity_id).bind(input.task_id).bind(input.kind).bind(input.title).bind(serde_json::to_string(&input.payload).map_err(|e|e.to_string())?).bind(input.source).bind("pending").execute(pool).await.map_err(storage)?;
    if r.rows_affected() != 1 {
        return Err("conflict: proposal exists".into());
    }
    sqlx::query_as::<_,ProposalRow>("SELECT id,task_id,kind,title,payload_json,source,status,decided_by,decided_at,version FROM proposals WHERE id=?").bind(entity_id).fetch_one(pool).await.map_err(storage).and_then(proposal)
}

/// 将原生终端会话转成待审批 Proposal；不把对话直接伪装成正式 Task。
#[tauri::command(async)]
pub async fn proposal_from_session(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    session_id: String,
    title: String,
    excerpt: Option<String>,
) -> Result<Proposal, String> {
    let pool = pool(&state, &app).await?;
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM agent_sessions WHERE id=?")
        .bind(&session_id)
        .fetch_optional(pool)
        .await
        .map_err(storage)?;
    if exists.is_none() {
        return Err("not_found: session".into());
    }
    let proposal_id = id("proposal");
    sqlx::query("INSERT INTO proposals(id,task_id,kind,title,payload_json,source,status,version) VALUES(?,?,?,?,?,?,?,1)")
        .bind(&proposal_id)
        .bind(None::<String>)
        .bind("session_conversion")
        .bind(title)
        .bind(serde_json::to_string(&serde_json::json!({ "sessionId": session_id, "excerpt": excerpt })).map_err(|e| e.to_string())?)
        .bind("native_session")
        .bind("pending")
        .execute(pool)
        .await
        .map_err(storage)?;
    sqlx::query_as::<_, ProposalRow>("SELECT id,task_id,kind,title,payload_json,source,status,decided_by,decided_at,version FROM proposals WHERE id=?")
        .bind(proposal_id)
        .fetch_one(pool)
        .await
        .map_err(storage)
        .and_then(proposal)
}

#[tauri::command(async)]
pub async fn proposal_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    status: Option<String>,
) -> Result<Vec<Proposal>, String> {
    let pool = pool(&state, &app).await?;
    let rows = if let Some(status) = status {
        sqlx::query_as::<_,ProposalRow>("SELECT id,task_id,kind,title,payload_json,source,status,decided_by,decided_at,version FROM proposals WHERE status=? ORDER BY id").bind(status).fetch_all(pool).await
    } else {
        sqlx::query_as::<_,ProposalRow>("SELECT id,task_id,kind,title,payload_json,source,status,decided_by,decided_at,version FROM proposals ORDER BY id").fetch_all(pool).await
    };
    rows.map_err(storage)?.into_iter().map(proposal).collect()
}

#[tauri::command(async)]
pub async fn proposal_decide(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    id: String,
    decision: String,
    decided_by: String,
    expected_version: i64,
) -> Result<Proposal, String> {
    let pool = pool(&state, &app).await?;
    if !["approved", "rejected", "merged"].contains(&decision.as_str()) {
        return Err(invalid("proposal decision"));
    }
    let r=sqlx::query("UPDATE proposals SET status=?,decided_by=?,decided_at=?,version=version+1 WHERE id=? AND status='pending' AND version=?").bind(&decision).bind(decided_by).bind(now_ms()).bind(&id).bind(expected_version).execute(pool).await.map_err(storage)?;
    if r.rows_affected() != 1 {
        return Err("conflict: proposal already decided or version changed".into());
    }
    sqlx::query_as::<_,ProposalRow>("SELECT id,task_id,kind,title,payload_json,source,status,decided_by,decided_at,version FROM proposals WHERE id=?").bind(id).fetch_one(pool).await.map_err(storage).and_then(proposal)
}

#[tauri::command(async)]
pub async fn task_run_start(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    input: RunInput,
) -> Result<TaskRun, String> {
    let pool = pool(&state, &app).await?;
    let status = task_status(pool, &input.task_id).await?;
    if !["ready", "failed", "cancelled"].contains(&status.as_str()) {
        return Err(format!(
            "invalid_transition: task {status} cannot start run"
        ));
    }
    let attempt: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(attempt_no),0)+1 FROM task_runs WHERE task_id=?")
            .bind(&input.task_id)
            .fetch_one(pool)
            .await
            .map_err(storage)?;
    let run_id = id("run");
    sqlx::query("INSERT INTO task_runs(id,task_id,attempt_no,status,profile_id,worktree_id,baseline_sha,baseline_dirty,changed_paths_json,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(&run_id).bind(&input.task_id).bind(attempt).bind("running").bind(input.profile_id).bind(input.worktree_id).bind(input.baseline_sha).bind(input.baseline_dirty.map(|v|if v{1}else{0})).bind("[]").bind(now_ms()).execute(pool).await.map_err(storage)?;
    sqlx::query("UPDATE tasks SET status='running',version=version+1,updated_at=? WHERE id=?")
        .bind(now_ms())
        .bind(&input.task_id)
        .execute(pool)
        .await
        .map_err(storage)?;
    sqlx::query_as::<_,RunRow>("SELECT id,task_id,attempt_no,status,profile_id,session_id,worktree_id,baseline_sha,baseline_dirty,final_sha,final_dirty,changed_paths_json,started_at,finished_at,error FROM task_runs WHERE id=?").bind(run_id).fetch_one(pool).await.map_err(storage).and_then(run)
}

#[tauri::command(async)]
pub async fn task_run_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    task_id: Option<String>,
) -> Result<Vec<TaskRun>, String> {
    let pool = pool(&state, &app).await?;
    let rows = if let Some(task_id) = task_id {
        sqlx::query_as::<_,RunRow>("SELECT id,task_id,attempt_no,status,profile_id,session_id,worktree_id,baseline_sha,baseline_dirty,final_sha,final_dirty,changed_paths_json,started_at,finished_at,error FROM task_runs WHERE task_id=? ORDER BY attempt_no DESC").bind(task_id).fetch_all(pool).await
    } else {
        sqlx::query_as::<_,RunRow>("SELECT id,task_id,attempt_no,status,profile_id,session_id,worktree_id,baseline_sha,baseline_dirty,final_sha,final_dirty,changed_paths_json,started_at,finished_at,error FROM task_runs ORDER BY started_at DESC").fetch_all(pool).await
    };
    rows.map_err(storage)?.into_iter().map(run).collect()
}

#[tauri::command(async)]
pub async fn task_run_finish(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    run_id: String,
    status: String,
    session_id: Option<String>,
    final_sha: Option<String>,
    final_dirty: Option<bool>,
    changed_paths: Vec<String>,
    error: Option<String>,
) -> Result<TaskRun, String> {
    let pool = pool(&state, &app).await?;
    if !["succeeded", "failed", "cancelled", "interrupted"].contains(&status.as_str()) {
        return Err(invalid("run status"));
    }
    let task_id: String = sqlx::query_scalar("SELECT task_id FROM task_runs WHERE id=?")
        .bind(&run_id)
        .fetch_optional(pool)
        .await
        .map_err(storage)?
        .ok_or_else(|| "not_found: run".to_string())?;
    sqlx::query("UPDATE task_runs SET status=?,session_id=?,final_sha=?,final_dirty=?,changed_paths_json=?,finished_at=?,error=? WHERE id=? AND status='running'").bind(&status).bind(session_id).bind(final_sha).bind(final_dirty.map(|v|if v{1}else{0})).bind(serde_json::to_string(&changed_paths).map_err(|e|e.to_string())?).bind(now_ms()).bind(error).bind(&run_id).execute(pool).await.map_err(storage)?;
    let task_status = if status == "succeeded" {
        "succeeded"
    } else {
        "failed"
    };
    sqlx::query(
        "UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=? AND status='running'",
    )
    .bind(task_status)
    .bind(now_ms())
    .bind(task_id)
    .execute(pool)
    .await
    .map_err(storage)?;
    sqlx::query_as::<_,RunRow>("SELECT id,task_id,attempt_no,status,profile_id,session_id,worktree_id,baseline_sha,baseline_dirty,final_sha,final_dirty,changed_paths_json,started_at,finished_at,error FROM task_runs WHERE id=?").bind(run_id).fetch_one(pool).await.map_err(storage).and_then(run)
}

#[tauri::command(async)]
pub async fn verification_record(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    input: VerificationInput,
) -> Result<Verification, String> {
    let pool = pool(&state, &app).await?;
    if !["passed", "failed", "unknown", "accepted", "rejected"].contains(&input.status.as_str()) {
        return Err(invalid("verification status"));
    }
    let verification = Verification {
        id: id("verification"),
        run_id: input.run_id,
        kind: input.kind,
        status: input.status,
        summary: input.summary,
        evidence: input.evidence,
        source: input.source,
        created_at: now_ms(),
    };
    sqlx::query("INSERT INTO run_verifications(id,run_id,kind,status,summary,evidence_json,source,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(&verification.id).bind(&verification.run_id).bind(&verification.kind).bind(&verification.status).bind(&verification.summary).bind(serde_json::to_string(&verification.evidence).map_err(|e|e.to_string())?).bind(&verification.source).bind(verification.created_at).execute(pool).await.map_err(storage)?;
    Ok(verification)
}

#[tauri::command(async)]
pub async fn verification_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    run_id: String,
) -> Result<Vec<Verification>, String> {
    let pool = pool(&state, &app).await?;
    let rows=sqlx::query("SELECT id,run_id,kind,status,summary,evidence_json,source,created_at FROM run_verifications WHERE run_id=? ORDER BY created_at").bind(run_id).fetch_all(pool).await.map_err(storage)?;
    rows.into_iter()
        .map(|row| {
            Ok(Verification {
                id: row.try_get("id").map_err(storage)?,
                run_id: row.try_get("run_id").map_err(storage)?,
                kind: row.try_get("kind").map_err(storage)?,
                status: row.try_get("status").map_err(storage)?,
                summary: row.try_get("summary").map_err(storage)?,
                evidence: parse_json(
                    row.try_get::<String, _>("evidence_json")
                        .map_err(storage)?
                        .as_str(),
                )?,
                source: row.try_get("source").map_err(storage)?,
                created_at: row.try_get("created_at").map_err(storage)?,
            })
        })
        .collect()
}

#[tauri::command(async)]
pub async fn project_upsert(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    project_id: Option<String>,
    name: String,
    description: Option<String>,
) -> Result<Project, String> {
    let pool = pool(&state, &app).await?;
    if name.trim().is_empty() {
        return Err(invalid("project name"));
    }
    let project_id = project_id.unwrap_or_else(|| id("project"));
    sqlx::query("INSERT INTO projects(id,name,description) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,version=version+1").bind(&project_id).bind(name.trim()).bind(description.unwrap_or_default()).execute(pool).await.map_err(storage)?;
    sqlx::query_as::<_, ProjectRow>("SELECT id,name,description,version FROM projects WHERE id=?")
        .bind(project_id)
        .fetch_one(pool)
        .await
        .map(|r| Project {
            id: r.id,
            name: r.name,
            description: r.description,
            version: r.version,
        })
        .map_err(storage)
}

#[derive(Debug, FromRow)]
struct ProjectRow {
    id: String,
    name: String,
    description: String,
    version: i64,
}

#[tauri::command(async)]
pub async fn repository_register(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    project_id: String,
    root: String,
    default_branch: Option<String>,
) -> Result<Repository, String> {
    let pool = pool(&state, &app).await?;
    let path = PathBuf::from(&root);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("invalid_input: repository path: {e}"))?;
    let canonical_text = canonical.to_string_lossy().to_string();
    let valid = Command::new("git")
        .args([
            "-C",
            canonical_text.as_str(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !valid {
        return Err(invalid("path is not a Git repository"));
    }
    let repo_id = id("repo");
    sqlx::query("INSERT INTO repositories(id,project_id,root,default_branch,valid) VALUES(?,?,?,?,1) ON CONFLICT(root) DO UPDATE SET project_id=excluded.project_id,default_branch=excluded.default_branch,valid=1").bind(&repo_id).bind(project_id).bind(&canonical_text).bind(default_branch).execute(pool).await.map_err(storage)?;
    sqlx::query_as::<_, RepositoryRow>(
        "SELECT id,project_id,root,default_branch,valid FROM repositories WHERE root=?",
    )
    .bind(&canonical_text)
    .fetch_one(pool)
    .await
    .map(|r| Repository {
        id: r.id,
        project_id: r.project_id,
        root: r.root,
        default_branch: r.default_branch,
        valid: r.valid != 0,
    })
    .map_err(storage)
}

#[derive(Debug, FromRow)]
struct RepositoryRow {
    id: String,
    project_id: String,
    root: String,
    default_branch: Option<String>,
    valid: i64,
}

#[tauri::command(async)]
pub async fn repository_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    project_id: Option<String>,
) -> Result<Vec<Repository>, String> {
    let pool = pool(&state, &app).await?;
    let rows = if let Some(project) = project_id {
        sqlx::query_as::<_,RepositoryRow>("SELECT id,project_id,root,default_branch,valid FROM repositories WHERE project_id=? ORDER BY root").bind(project).fetch_all(pool).await
    } else {
        sqlx::query_as::<_, RepositoryRow>(
            "SELECT id,project_id,root,default_branch,valid FROM repositories ORDER BY root",
        )
        .fetch_all(pool)
        .await
    };
    rows.map(|v| {
        v.into_iter()
            .map(|r| Repository {
                id: r.id,
                project_id: r.project_id,
                root: r.root,
                default_branch: r.default_branch,
                valid: r.valid != 0,
            })
            .collect()
    })
    .map_err(storage)
}

fn worktree_exists(repo_root: &Path, target: &Path) -> bool {
    Command::new("git")
        .args([
            "-C",
            repo_root.to_string_lossy().as_ref(),
            "worktree",
            "list",
            "--porcelain",
        ])
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout).lines().any(|line| {
                line.strip_prefix("worktree ")
                    .map(|p| Path::new(p).canonicalize().ok() == target.canonicalize().ok())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

#[tauri::command(async)]
pub async fn worktree_lease_acquire(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    repository_id: String,
    path: String,
    owner_task_id: Option<String>,
    owner_run_id: Option<String>,
) -> Result<WorktreeLease, String> {
    let pool = pool(&state, &app).await?;
    let repo_root: String = sqlx::query_scalar("SELECT root FROM repositories WHERE id=?")
        .bind(&repository_id)
        .fetch_optional(pool)
        .await
        .map_err(storage)?
        .ok_or_else(|| "not_found: repository".to_string())?;
    let target = PathBuf::from(&path);
    if !worktree_exists(Path::new(&repo_root), &target) {
        return Err(invalid("path is not a registered Git worktree"));
    }
    let lease = WorktreeLease {
        id: id("lease"),
        repository_id,
        path: target
            .canonicalize()
            .unwrap_or(target)
            .to_string_lossy()
            .to_string(),
        owner_task_id,
        owner_run_id,
        locked_at: now_ms(),
    };
    sqlx::query("INSERT INTO worktree_leases(id,repository_id,path,owner_task_id,owner_run_id,locked_at) VALUES(?,?,?,?,?,?)").bind(&lease.id).bind(&lease.repository_id).bind(&lease.path).bind(&lease.owner_task_id).bind(&lease.owner_run_id).bind(lease.locked_at).execute(pool).await.map(|_|lease).map_err(|e|if matches!(e,sqlx::Error::Database(_)){"conflict: worktree already leased".into()}else{storage(e)})
}

#[tauri::command(async)]
pub async fn worktree_lease_release(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    lease_id: String,
) -> Result<bool, String> {
    let pool = pool(&state, &app).await?;
    Ok(sqlx::query("DELETE FROM worktree_leases WHERE id=?")
        .bind(lease_id)
        .execute(pool)
        .await
        .map_err(storage)?
        .rows_affected()
        == 1)
}

#[tauri::command(async)]
pub async fn worktree_lease_list(
    state: tauri::State<'_, ControlPlaneState>,
    app: AppHandle,
    repository_id: Option<String>,
) -> Result<Vec<WorktreeLease>, String> {
    let pool = pool(&state, &app).await?;
    let rows = if let Some(repo) = repository_id {
        sqlx::query("SELECT id,repository_id,path,owner_task_id,owner_run_id,locked_at FROM worktree_leases WHERE repository_id=? ORDER BY locked_at").bind(repo).fetch_all(pool).await
    } else {
        sqlx::query("SELECT id,repository_id,path,owner_task_id,owner_run_id,locked_at FROM worktree_leases ORDER BY locked_at").fetch_all(pool).await
    };
    rows.map_err(storage)?
        .into_iter()
        .map(|r| {
            Ok(WorktreeLease {
                id: r.try_get("id").map_err(storage)?,
                repository_id: r.try_get("repository_id").map_err(storage)?,
                path: r.try_get("path").map_err(storage)?,
                owner_task_id: r.try_get("owner_task_id").map_err(storage)?,
                owner_run_id: r.try_get("owner_run_id").map_err(storage)?,
                locked_at: r.try_get("locked_at").map_err(storage)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_transitions_reject_invalid_edges() {
        assert!(!allowed_transition("draft", "running"));
        assert!(allowed_transition("ready", "running"));
    }
    #[test]
    fn ids_are_scoped() {
        assert!(id("task").starts_with("task_"));
    }
}
