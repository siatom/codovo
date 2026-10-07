//! 数据库连接：MySQL / PostgreSQL / SQLite 的连接池、元数据浏览与 SQL 查询。
//!
//! 几个绕不开的设计点：
//!
//! - **三库各持一个池**，用一个 `enum DbPool` 分派。不用 sqlx 的 `Any` 驱动——它的类型映射
//!   和 URL 解析都有各自的坑，而 `*ConnectOptions` 的 builder 反而更干净（不用拼 URL、
//!   也不用管 userinfo / 路径的转义）。
//! - **密码不回前端**。前端只存「有没有」布尔位，正文在后端按 conn_id 从系统钥匙串取
//!   （与 ai.rs / agent.rs / remote.rs 同一套口径）。
//! - **分页在服务端做**。可翻页的查询（SELECT 之类）包一层
//!   `SELECT * FROM (<sql>) AS __codedock_pg LIMIT n OFFSET m`，多取一行来判断有没有下一页。
//!   写语句与 SHOW/EXPLAIN 这类一次性结果不分页。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Executor, Row, Statement, ValueRef};
use uuid::Uuid;

/// 建连超时。交互式会话本身不设闲置超时，但建连这一步不能无限等。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// 单条语句的执行超时。慢查询不该把界面挂死。
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);

/// 每个池的连接数上限。查询工具不需要太多并发。
const MAX_CONNECTIONS: u32 = 4;

/// 单页行数上限与默认值。上限是防止用户把百万行一次拖进 WebView。
const MAX_PAGE_SIZE: u32 = 500;
const DEFAULT_PAGE_SIZE: u32 = 50;

/// 单个单元格的字符上限。长文本（大 JSON / 长文本列）截断，否则整包结果会很大。
const MAX_CELL_CHARS: usize = 4096;

/// 支持的数据库类型。前端传 "mysql" / "postgres" / "sqlite"。
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Mysql,
    Postgres,
    Sqlite,
}

/// 三库的连接池。分派用，不对外暴露。
enum DbPool {
    Mysql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
}

impl DbPool {
    async fn close(&self) {
        match self {
            DbPool::Mysql(pool) => pool.close().await,
            DbPool::Postgres(pool) => pool.close().await,
            DbPool::Sqlite(pool) => pool.close().await,
        }
    }
}

struct DbSession {
    pool: DbPool,
}

struct Inner {
    sessions: Mutex<HashMap<u32, Arc<DbSession>>>,
    next_id: AtomicU32,
}

pub struct DbState {
    inner: Arc<Inner>,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                next_id: AtomicU32::new(1),
            }),
        }
    }

    /// 应用退出时调用：清空会话表，池随之析构（连接由 sqlx 在后台收尾）。
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.inner.sessions.lock() {
            sessions.clear();
        }
    }
}

impl Default for DbState {
    fn default() -> Self {
        Self::new()
    }
}

/// `db_connect` 的入参。参数多，打包成一个对象传，免得命令签名太长。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectRequest {
    pub conn_id: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    /// SQLite 的数据库文件路径；其余类型忽略
    pub file: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectResult {
    pub session_id: u32,
}

/// 一张表或一个视图。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// "table" | "view"
    pub kind: String,
}

/// 一次查询的结果。`rows` 里的单元格统一渲染成字符串，`None` 表示 SQL NULL。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// 写语句影响的行数；查询为 0
    pub affected: u64,
    /// "rows" | "affected"
    pub kind: String,
    /// 后面还有没有下一页（仅可翻页查询有意义）
    pub has_more: bool,
    pub page: u32,
    pub page_size: u32,
    pub elapsed_ms: u64,
}

/// 连接 id 要拼进钥匙串条目名，secrets.rs 那边有条目名长度与合法性约束，这里先挡一道。
fn valid_conn_id(conn_id: &str) -> bool {
    !conn_id.is_empty()
        && conn_id.len() <= 64
        && conn_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 密码在系统钥匙串里的条目名。前端拿同样的规则去 `secret_set`。
pub(crate) fn password_secret_id(conn_id: &str) -> String {
    format!("db:{conn_id}:password")
}

/// 把建连错误文本翻成能给用户看的话。抽成纯函数是为了能单测——
/// Windows 的 socket 错误是**本地化**的（中文系统给的是「由于目标计算机积极拒绝」），
/// 光认英文 `refused` 认不出来，所以中英 + Winsock 错误码一起认。
///
/// 只用于**建连**：查询报错原文往往已经很具体（语法错、表不存在），乱翻译反而误导。
fn describe_connect_error(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("access denied")
        || lower.contains("password authentication failed")
        || lower.contains("authentication")
        || text.contains("认证失败")
        || text.contains("密码")
    {
        return format!("认证失败：用户名或密码不对（{text}）");
    }
    if lower.contains("refused") || text.contains("拒绝") || text.contains("10061") {
        return format!("连接被拒绝：主机不可达或端口不对（{text}）");
    }
    if lower.contains("timed out")
        || lower.contains("timeout")
        || text.contains("超时")
        || text.contains("10060")
    {
        return format!("连接超时：检查主机、端口和网络（{text}）");
    }
    if lower.contains("no such host")
        || lower.contains("failed to lookup")
        || text.contains("找不到")
        || text.contains("11001")
    {
        return format!("找不到主机：检查地址拼写（{text}）");
    }
    if lower.contains("unknown database")
        || lower.contains("does not exist")
        || lower.contains("unable to open database")
        || lower.contains("no such file")
        || text.contains("不存在")
    {
        return format!("数据库不存在或打不开（{text}）");
    }
    format!("连接失败：{text}")
}

fn session_of(state: &DbState, id: u32) -> Result<Arc<DbSession>, String> {
    state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "数据库连接不存在（可能已断开）".to_string())
}

#[tauri::command]
pub async fn db_connect(
    state: tauri::State<'_, DbState>,
    request: DbConnectRequest,
) -> Result<DbConnectResult, String> {
    if !valid_conn_id(&request.conn_id) {
        return Err("连接 ID 非法".to_string());
    }
    // 钥匙串读取是同步阻塞的系统调用，必须在第一个 await 之前完成（照 ai.rs 的注释）
    let password = crate::secrets::get(&password_secret_id(&request.conn_id))?.unwrap_or_default();

    let pool = match request.kind {
        DbKind::Mysql => {
            if request.host.trim().is_empty() {
                return Err("请填写主机地址".to_string());
            }
            let options = MySqlConnectOptions::new()
                .host(request.host.trim())
                .port(request.port)
                .username(request.user.trim())
                .password(&password)
                .database(request.database.trim());
            DbPool::Mysql(
                MySqlPoolOptions::new()
                    .max_connections(MAX_CONNECTIONS)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect_with(options)
                    .await
                    .map_err(|e| describe_connect_error(&e.to_string()))?,
            )
        }
        DbKind::Postgres => {
            if request.host.trim().is_empty() {
                return Err("请填写主机地址".to_string());
            }
            let options = PgConnectOptions::new()
                .host(request.host.trim())
                .port(request.port)
                .username(request.user.trim())
                .password(&password)
                .database(request.database.trim());
            DbPool::Postgres(
                PgPoolOptions::new()
                    .max_connections(MAX_CONNECTIONS)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect_with(options)
                    .await
                    .map_err(|e| describe_connect_error(&e.to_string()))?,
            )
        }
        DbKind::Sqlite => {
            let path = request.file.trim();
            if path.is_empty() {
                return Err("请选择 SQLite 数据库文件".to_string());
            }
            // create_if_missing(false)：路径打错时直接报错，不会凭空建一个空库
            let options = SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false);
            DbPool::Sqlite(
                SqlitePoolOptions::new()
                    .max_connections(MAX_CONNECTIONS)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect_with(options)
                    .await
                    .map_err(|e| describe_connect_error(&e.to_string()))?,
            )
        }
    };

    let id = state.inner.next_id.fetch_add(1, Ordering::Relaxed);
    let session = Arc::new(DbSession { pool });
    state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);
    Ok(DbConnectResult { session_id: id })
}

#[tauri::command]
pub async fn db_disconnect(state: tauri::State<'_, DbState>, id: u32) -> Result<(), String> {
    let removed = state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    if let Some(session) = removed {
        session.pool.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn db_tables(state: tauri::State<'_, DbState>, id: u32) -> Result<Vec<TableInfo>, String> {
    let session = session_of(&state, id)?;
    match &session.pool {
        DbPool::Mysql(pool) => {
            const SQL: &str = "SELECT table_schema, table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema = DATABASE() \
                 ORDER BY table_name";
            let rows = sqlx::query(SQL)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows
                .iter()
                .map(|row| {
                    let schema: String = row.try_get(0).unwrap_or_default();
                    let name: String = row.try_get(1).unwrap_or_default();
                    let table_type: String = row.try_get(2).unwrap_or_default();
                    TableInfo {
                        schema,
                        name,
                        kind: table_kind(&table_type),
                    }
                })
                .collect())
        }
        DbPool::Postgres(pool) => {
            const SQL: &str = "SELECT table_schema, table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                 ORDER BY table_schema, table_name";
            let rows = sqlx::query(SQL)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows
                .iter()
                .map(|row| {
                    let schema: String = row.try_get(0).unwrap_or_default();
                    let name: String = row.try_get(1).unwrap_or_default();
                    let table_type: String = row.try_get(2).unwrap_or_default();
                    TableInfo {
                        schema,
                        name,
                        kind: table_kind(&table_type),
                    }
                })
                .collect())
        }
        DbPool::Sqlite(pool) => {
            const SQL: &str = "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name";
            let rows = sqlx::query(SQL)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows
                .iter()
                .map(|row| {
                    let name: String = row.try_get(0).unwrap_or_default();
                    let table_type: String = row.try_get(1).unwrap_or_default();
                    TableInfo {
                        schema: "main".to_string(),
                        name,
                        kind: table_kind(&table_type),
                    }
                })
                .collect())
        }
    }
}

/// information_schema / sqlite_master 里 type 字段的写法五花八门，归一到 "view" | "table"。
fn table_kind(table_type: &str) -> String {
    if table_type.to_lowercase().contains("view") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

/// 语句分三类，决定怎么执行。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SqlClass {
    /// 返回行的查询，可翻页（SELECT / WITH / VALUES / TABLE）
    RowsPaged,
    /// 返回行但没法翻页（SHOW / EXPLAIN / PRAGMA 之类），只取一页
    RowsSingle,
    /// 写语句与 DDL，看影响行数
    Write,
}

/// 去掉首部的注释与空白、尾部的分号——分号留在里面会被包进子查询，直接语法错。
fn strip_sql(sql: &str) -> String {
    let mut rest = sql.trim();
    loop {
        let trimmed = rest.trim_start();
        if let Some(after) = trimmed.strip_prefix("--") {
            match after.find('\n') {
                Some(index) => rest = &after[index + 1..],
                None => return String::new(),
            }
        } else if let Some(after) = trimmed.strip_prefix("/*") {
            match after.find("*/") {
                Some(index) => rest = &after[index + 2..],
                None => return String::new(),
            }
        } else {
            rest = trimmed;
            break;
        }
    }
    rest.trim_end().trim_end_matches(';').trim_end().to_string()
}

/// 取语句的第一个关键字（小写）。`strip_sql` 已经去掉了前导注释。
fn first_keyword(sql: &str) -> String {
    sql.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn classify_sql(sql: &str) -> SqlClass {
    match first_keyword(sql).as_str() {
        "select" | "with" | "values" | "table" => SqlClass::RowsPaged,
        "insert" | "update" | "delete" | "replace" | "merge" | "create" | "drop" | "alter"
        | "truncate" | "grant" | "revoke" | "vacuum" | "attach" | "detach" | "reindex"
        | "comment" | "call" | "do" | "load" | "begin" | "commit" | "rollback" | "savepoint"
        | "release" | "start" => SqlClass::Write,
        _ => SqlClass::RowsSingle,
    }
}

/// 给可翻页的查询套一层子查询，多取一行判断有没有下一页。
/// 三库都支持 `FROM (子查询) LIMIT ... OFFSET ...`，MySQL 的派生表别名不能省。
fn wrap_paged(sql: &str, page: u32, page_size: u32) -> String {
    let limit = page_size as u64 + 1;
    let offset = page as u64 * page_size as u64;
    format!("SELECT * FROM (\n{sql}\n) AS __codedock_pg LIMIT {limit} OFFSET {offset}")
}

#[tauri::command]
pub async fn db_query(
    state: tauri::State<'_, DbState>,
    id: u32,
    sql: String,
    page: u32,
    page_size: u32,
) -> Result<QueryResult, String> {
    let session = session_of(&state, id)?;
    let page_size = if page_size == 0 {
        DEFAULT_PAGE_SIZE
    } else {
        page_size.min(MAX_PAGE_SIZE)
    };
    let trimmed = strip_sql(&sql);
    if trimmed.is_empty() {
        return Err("请输入 SQL".to_string());
    }
    let class = classify_sql(&trimmed);

    let started = Instant::now();
    let mut result = tokio::time::timeout(
        QUERY_TIMEOUT,
        run_query(&session, &trimmed, class, page, page_size),
    )
    .await
    .map_err(|_| format!("查询超时（{} 秒）", QUERY_TIMEOUT.as_secs()))??;
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

async fn run_query(
    session: &DbSession,
    sql: &str,
    class: SqlClass,
    page: u32,
    page_size: u32,
) -> Result<QueryResult, String> {
    match class {
        SqlClass::RowsPaged => {
            let wrapped = wrap_paged(sql, page, page_size);
            fetch_rows(session, &wrapped, page, page_size, true).await
        }
        SqlClass::RowsSingle => fetch_rows(session, sql, 0, page_size, false).await,
        SqlClass::Write => execute_write(session, sql).await,
    }
}

async fn fetch_rows(
    session: &DbSession,
    sql: &str,
    page: u32,
    page_size: u32,
    paged: bool,
) -> Result<QueryResult, String> {
    match &session.pool {
        DbPool::Mysql(pool) => {
            // 先 prepare 一次拿列名：结果集为空（比如空表）时也有表头可显示
            let mut columns: Vec<String> = match pool.prepare(sql).await {
                Ok(statement) => statement
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect(),
                Err(_) => Vec::new(),
            };
            let rows = sqlx::query(sql)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            if columns.is_empty() {
                if let Some(first) = rows.first() {
                    columns = first.columns().iter().map(|c| c.name().to_string()).collect();
                }
            }
            Ok(assemble(columns, rows.iter().map(cells_mysql).collect(), page, page_size, paged))
        }
        DbPool::Postgres(pool) => {
            let mut columns: Vec<String> = match pool.prepare(sql).await {
                Ok(statement) => statement
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect(),
                Err(_) => Vec::new(),
            };
            let rows = sqlx::query(sql)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            if columns.is_empty() {
                if let Some(first) = rows.first() {
                    columns = first.columns().iter().map(|c| c.name().to_string()).collect();
                }
            }
            Ok(assemble(columns, rows.iter().map(cells_pg).collect(), page, page_size, paged))
        }
        DbPool::Sqlite(pool) => {
            let mut columns: Vec<String> = match pool.prepare(sql).await {
                Ok(statement) => statement
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect(),
                Err(_) => Vec::new(),
            };
            let rows = sqlx::query(sql)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            if columns.is_empty() {
                if let Some(first) = rows.first() {
                    columns = first.columns().iter().map(|c| c.name().to_string()).collect();
                }
            }
            Ok(assemble(columns, rows.iter().map(cells_sqlite).collect(), page, page_size, paged))
        }
    }
}

async fn execute_write(session: &DbSession, sql: &str) -> Result<QueryResult, String> {
    // 三个分支的结果类型各不相同，各自先归一到 rows_affected，再合并
    let affected = match &session.pool {
        DbPool::Mysql(pool) => sqlx::query(sql).execute(pool).await.map(|r| r.rows_affected()),
        DbPool::Postgres(pool) => sqlx::query(sql).execute(pool).await.map(|r| r.rows_affected()),
        DbPool::Sqlite(pool) => sqlx::query(sql).execute(pool).await.map(|r| r.rows_affected()),
    }
    .map_err(|e| e.to_string())?;
    Ok(QueryResult {
        columns: Vec::new(),
        rows: Vec::new(),
        affected,
        kind: "affected".to_string(),
        has_more: false,
        page: 0,
        page_size: 0,
        elapsed_ms: 0,
    })
}

/// 把「已解码的行」拼成结果：可翻页时多出来的那行只用来置 has_more，不进结果。
fn assemble(
    columns: Vec<String>,
    mut rows: Vec<Vec<Option<String>>>,
    page: u32,
    page_size: u32,
    paged: bool,
) -> QueryResult {
    let has_more = paged && rows.len() > page_size as usize;
    if has_more {
        rows.truncate(page_size as usize);
    }
    QueryResult {
        columns,
        rows,
        affected: 0,
        kind: "rows".to_string(),
        has_more,
        page,
        page_size,
        elapsed_ms: 0,
    }
}

/// 单元格 → 字符串。sqlx 的类型很严格（`String` 解不了 INT），所以按「最可能到最不可能」
/// 的顺序依次试；全试不出来才落到「无法显示」。NULL 单独走 `None`。
///
/// 后面 `[$($extra),*]` 是「只在某些库上有实现」的类型（BigDecimal / Uuid / JSON 在 SQLite
/// 上没有 Decode 实现，硬塞进去整个宏都编不过），按库传。要求都实现 `Display`。
macro_rules! decode_cell {
    ($row:expr, $idx:expr, [$($extra:ty),* $(,)?]) => {{
        let row = $row;
        let idx = $idx;
        let raw = match row.try_get_raw(idx) {
            Ok(raw) => raw,
            Err(_) => return Some("<无法显示>".to_string()),
        };
        if raw.is_null() {
            return None;
        }
        if let Ok(value) = row.try_get::<String, _>(idx) {
            return Some(clamp_cell(value));
        }
        if let Ok(value) = row.try_get::<i64, _>(idx) {
            return Some(value.to_string());
        }
        if let Ok(value) = row.try_get::<f64, _>(idx) {
            return Some(value.to_string());
        }
        if let Ok(value) = row.try_get::<bool, _>(idx) {
            return Some(value.to_string());
        }
        if let Ok(value) = row.try_get::<NaiveDateTime, _>(idx) {
            return Some(value.to_string());
        }
        if let Ok(value) = row.try_get::<DateTime<Utc>, _>(idx) {
            return Some(value.to_string());
        }
        if let Ok(value) = row.try_get::<NaiveDate, _>(idx) {
            return Some(value.to_string());
        }
        if let Ok(value) = row.try_get::<NaiveTime, _>(idx) {
            return Some(value.to_string());
        }
        $(
            if let Ok(value) = row.try_get::<$extra, _>(idx) {
                return Some(clamp_cell(value.to_string()));
            }
        )*
        if let Ok(value) = row.try_get::<Vec<u8>, _>(idx) {
            return Some(format_bytes(&value));
        }
        Some("<无法显示>".to_string())
    }};
}

fn cells_mysql(row: &MySqlRow) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, [BigDecimal, Uuid, serde_json::Value]))
        .collect()
}

fn cells_pg(row: &PgRow) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, [BigDecimal, Uuid, serde_json::Value]))
        .collect()
}

// SQLite 是动态类型，值大多落在文本 / 整数 / 浮点 / 二进制上，通用那几档就够；
// BigDecimal / Uuid / JSON 在 sqlx-sqlite 里没有 Decode 实现，传了反而编不过。
fn cells_sqlite(row: &SqliteRow) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, []))
        .collect()
}

/// 超长的单元格截断，末尾加省略号。按字符数算，别把多字节字符切一半。
fn clamp_cell(value: String) -> String {
    if value.chars().count() <= MAX_CELL_CHARS {
        return value;
    }
    let head: String = value.chars().take(MAX_CELL_CHARS).collect();
    format!("{head}…")
}

/// 二进制列渲染成十六进制；太长就只报字节数。
fn format_bytes(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    if bytes.len() > 32 {
        return format!("<二进制 {} 字节>", bytes.len());
    }
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conn_id_only_allows_slug() {
        assert!(valid_conn_id("c1_ab-2"));
        assert!(!valid_conn_id(""));
        assert!(!valid_conn_id("has space"));
        assert!(!valid_conn_id("斜杠/"));
        assert!(!valid_conn_id(&"x".repeat(65)));
        assert!(valid_conn_id(&"x".repeat(64)));
    }

    #[test]
    fn strips_comments_and_trailing_semicolon() {
        assert_eq!(strip_sql("  SELECT 1 ;  "), "SELECT 1");
        assert_eq!(strip_sql("-- 注释\nSELECT 1;"), "SELECT 1");
        assert_eq!(strip_sql("/* 块注释 */ SELECT 1"), "SELECT 1");
        assert_eq!(strip_sql("-- 只有注释"), "");
    }

    #[test]
    fn classifies_statements() {
        assert_eq!(classify_sql("SELECT * FROM t"), SqlClass::RowsPaged);
        assert_eq!(classify_sql("with x as (select 1) select * from x"), SqlClass::RowsPaged);
        assert_eq!(classify_sql("INSERT INTO t VALUES (1)"), SqlClass::Write);
        assert_eq!(classify_sql("update t set a=1"), SqlClass::Write);
        assert_eq!(classify_sql("SHOW TABLES"), SqlClass::RowsSingle);
        assert_eq!(classify_sql("explain select 1"), SqlClass::RowsSingle);
    }

    #[test]
    fn wraps_paged_query() {
        let wrapped = wrap_paged("SELECT * FROM t", 2, 50);
        assert!(wrapped.contains("AS __codedock_pg"));
        assert!(wrapped.contains("LIMIT 51")); // 多取一行判断 has_more
        assert!(wrapped.contains("OFFSET 100"));
    }

    #[test]
    fn describes_connect_errors() {
        assert!(describe_connect_error("Connection refused (os error 10061)").contains("连接被拒绝"));
        assert!(describe_connect_error("由于目标计算机积极拒绝").contains("连接被拒绝"));
        assert!(describe_connect_error("Access denied for user 'root'").contains("认证失败"));
        assert!(describe_connect_error("password authentication failed for user").contains("认证失败"));
        assert!(describe_connect_error("connection timed out").contains("连接超时"));
    }

    #[test]
    fn table_kind_normalizes() {
        assert_eq!(table_kind("BASE TABLE"), "table");
        assert_eq!(table_kind("VIEW"), "view");
        assert_eq!(table_kind("view"), "view");
    }

    #[tokio::test]
    async fn sqlite_roundtrip_pages_and_writes() {
        let path = std::env::temp_dir().join(format!("codedock-db-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(options).await.unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t (name) VALUES ('a'), ('b'), ('c')")
            .execute(&pool)
            .await
            .unwrap();

        let session = DbSession {
            pool: DbPool::Sqlite(pool),
        };

        let first = run_query(&session, "SELECT * FROM t ORDER BY id", SqlClass::RowsPaged, 0, 2)
            .await
            .unwrap();
        assert_eq!(first.columns, vec!["id", "name"]);
        assert_eq!(first.rows.len(), 2);
        assert!(first.has_more);
        assert_eq!(first.rows[0][1].as_deref(), Some("a"));

        let second = run_query(&session, "SELECT * FROM t ORDER BY id", SqlClass::RowsPaged, 1, 2)
            .await
            .unwrap();
        assert_eq!(second.rows.len(), 1);
        assert!(!second.has_more);

        let written = run_query(&session, "UPDATE t SET name='x' WHERE id=1", SqlClass::Write, 0, 50)
            .await
            .unwrap();
        assert_eq!(written.affected, 1);
        assert_eq!(written.kind, "affected");

        // 空结果也要有表头（走 prepare 那条路）
        let empty = run_query(&session, "SELECT * FROM t WHERE id=999", SqlClass::RowsPaged, 0, 50)
            .await
            .unwrap();
        assert_eq!(empty.columns, vec!["id", "name"]);
        assert!(empty.rows.is_empty());

        let _ = std::fs::remove_file(&path);
    }
}
