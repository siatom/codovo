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

/// 三库的连接池。分派用；`db_agent`（数据库 Agent 的 MCP 工具）也复用同一套建池与解码。
pub(crate) enum DbPool {
    Mysql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
}

impl DbPool {
    pub(crate) async fn close(&self) {
        match self {
            DbPool::Mysql(pool) => pool.close().await,
            DbPool::Postgres(pool) => pool.close().await,
            DbPool::Sqlite(pool) => pool.close().await,
        }
    }
}

pub(crate) struct DbSession {
    pub(crate) pool: DbPool,
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
/// 也用作数据库 Agent 的目标连接文件（target.json）的读写结构。
#[derive(Serialize, Deserialize)]
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
pub(crate) fn valid_conn_id(conn_id: &str) -> bool {
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

/// `db_test_connection` 的入参。比 `DbConnectRequest` 多一个 `password`：表单里刚敲的密码
/// 还没写进钥匙串，得直接传进来试；留空则回退到钥匙串里已存的那个（编辑连接时常见）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTestRequest {
    pub conn_id: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub file: String,
    #[serde(default)]
    pub password: Option<String>,
}

/// 按类型建池。`db_connect` / `db_test_connection` / 数据库 Agent 的 MCP 工具共用；
/// 密码由调用方给——前者来自钥匙串，后者可能来自表单里刚敲的值。
///
/// `read_only` 为真时给池里每条连接都设上只读（数据库 Agent 专用）：这是语句白名单之外的
/// 第二道兜底。设置语句在个别只读实例 / 老版本上可能报错，所以**失败只忽略、不拦建连**。
// 参数是一组建连字段，打包成结构体反而多一层转发；这里就按原样摊开
#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_pool(
    kind: DbKind,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    file: &str,
    read_only: bool,
) -> Result<DbPool, String> {
    Ok(match kind {
        DbKind::Mysql => {
            if host.is_empty() {
                return Err("请填写主机地址".to_string());
            }
            let options = MySqlConnectOptions::new()
                .host(host)
                .port(port)
                .username(user)
                .password(password)
                .database(database);
            let mut pool_options = MySqlPoolOptions::new()
                .max_connections(MAX_CONNECTIONS)
                .acquire_timeout(CONNECT_TIMEOUT);
            if read_only {
                pool_options = pool_options.after_connect(|conn, _meta| {
                    Box::pin(async move {
                        let _ = sqlx::query("SET SESSION TRANSACTION READ ONLY")
                            .execute(&mut *conn)
                            .await;
                        Ok(())
                    })
                });
            }
            DbPool::Mysql(
                pool_options
                    .connect_with(options)
                    .await
                    .map_err(|e| describe_connect_error(&e.to_string()))?,
            )
        }
        DbKind::Postgres => {
            if host.is_empty() {
                return Err("请填写主机地址".to_string());
            }
            let options = PgConnectOptions::new()
                .host(host)
                .port(port)
                .username(user)
                .password(password)
                .database(database);
            let mut pool_options = PgPoolOptions::new()
                .max_connections(MAX_CONNECTIONS)
                .acquire_timeout(CONNECT_TIMEOUT);
            if read_only {
                pool_options = pool_options.after_connect(|conn, _meta| {
                    Box::pin(async move {
                        let _ = sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                            .execute(&mut *conn)
                            .await;
                        Ok(())
                    })
                });
            }
            DbPool::Postgres(
                pool_options
                    .connect_with(options)
                    .await
                    .map_err(|e| describe_connect_error(&e.to_string()))?,
            )
        }
        DbKind::Sqlite => {
            if file.is_empty() {
                return Err("请选择 SQLite 数据库文件".to_string());
            }
            // create_if_missing(false)：路径打错时直接报错，不会凭空建一个空库
            let options = SqliteConnectOptions::new()
                .filename(file)
                .create_if_missing(false);
            let mut pool_options = SqlitePoolOptions::new()
                .max_connections(MAX_CONNECTIONS)
                .acquire_timeout(CONNECT_TIMEOUT);
            if read_only {
                pool_options = pool_options.after_connect(|conn, _meta| {
                    Box::pin(async move {
                        // query_only 是 SQLite 官方的只读开关：写语句直接报错
                        let _ = sqlx::query("PRAGMA query_only = ON").execute(&mut *conn).await;
                        Ok(())
                    })
                });
            }
            DbPool::Sqlite(
                pool_options
                    .connect_with(options)
                    .await
                    .map_err(|e| describe_connect_error(&e.to_string()))?,
            )
        }
    })
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

    let pool = create_pool(
        request.kind,
        request.host.trim(),
        request.port,
        request.user.trim(),
        &password,
        request.database.trim(),
        request.file.trim(),
        false,
    )
    .await?;

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

/// 试连一次就断开，用来在保存前验证参数。不登记会话，池建完立刻关。
/// 密码优先用表单里刚敲的（还没进钥匙串），没填才回退到钥匙串里已存的。
#[tauri::command]
pub async fn db_test_connection(request: DbTestRequest) -> Result<(), String> {
    let password = match request.password.as_deref() {
        Some(value) if !value.is_empty() => value.to_string(),
        // 没传明文就回退到钥匙串里已存的（编辑连接时常见）；
        // 新建连接还没有 id，没有可回退的条目，直接用空密码试
        _ if valid_conn_id(&request.conn_id) => {
            // 同步阻塞调用，放在第一个 await 之前
            crate::secrets::get(&password_secret_id(&request.conn_id))?.unwrap_or_default()
        }
        _ => String::new(),
    };

    let pool = create_pool(
        request.kind,
        request.host.trim(),
        request.port,
        request.user.trim(),
        &password,
        request.database.trim(),
        request.file.trim(),
        false,
    )
    .await?;
    pool.close().await;
    Ok(())
}

/// `db_tables` 取一个文本列。MySQL 的 information_schema 列带 BINARY 标志、sqlx 的 `String`
/// 解不了（见 `bytes_mysql`），所以补一道字节兜底；PG / SQLite 一般走不到兜底那步。
macro_rules! text_cell {
    ($row:expr, $idx:expr, $bytes:path) => {
        match $row.try_get::<String, _>($idx) {
            Ok(value) => value,
            Err(_) => match $row.try_get::<Vec<u8>, _>($idx) {
                Ok(value) => $bytes(&value),
                Err(_) => String::new(),
            },
        }
    };
}

/// 可切换的「数据库」这一级：MySQL 是库，SQLite 只有 main，PostgreSQL 是实例里的库。
///
/// MySQL / SQLite 是「库 → 表」两级；PG 是「库 → schema → 表」三级，而 PG 一个连接只能连
/// 一个库、不能跨库查询，所以界面上每展开一个 PG 库就单独开一条会话（建会话时按库名覆盖
/// `database`）——列库这一步才用得上当前这条连接里的 `pg_database`。
#[tauri::command]
pub async fn db_databases(
    state: tauri::State<'_, DbState>,
    id: u32,
) -> Result<Vec<String>, String> {
    let session = session_of(&state, id)?;
    databases_of(&session).await
}

pub(crate) async fn databases_of(session: &DbSession) -> Result<Vec<String>, String> {
    match &session.pool {
        DbPool::Mysql(pool) => {
            const SQL: &str = "SELECT schema_name FROM information_schema.schemata \
                 WHERE schema_name NOT IN \
                    ('information_schema', 'mysql', 'performance_schema', 'sys') \
                 ORDER BY schema_name";
            let rows = sqlx::query(SQL)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows.iter().map(|row| text_cell!(row, 0, bytes_mysql)).collect())
        }
        DbPool::Postgres(pool) => {
            // datname 是 name 类型，显式转 text 免得类型解码挑食；
            // datallowconn=false 的库（比如 template0）连不上，别列出来
            const SQL: &str = "SELECT datname::text FROM pg_database \
                 WHERE NOT datistemplate AND datallowconn \
                 ORDER BY datname";
            let rows = sqlx::query(SQL)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows.iter().map(|row| text_cell!(row, 0, format_bytes)).collect())
        }
        DbPool::Sqlite(_) => Ok(vec!["main".to_string()]),
    }
}

/// PG 专用：当前库里的 schema 列表（界面的第三级）。其余库没有这一层，返回空。
#[tauri::command]
pub async fn db_schemas(
    state: tauri::State<'_, DbState>,
    id: u32,
) -> Result<Vec<String>, String> {
    let session = session_of(&state, id)?;
    schemas_of(&session).await
}

pub(crate) async fn schemas_of(session: &DbSession) -> Result<Vec<String>, String> {
    match &session.pool {
        DbPool::Postgres(pool) => {
            // pg_ 前缀是 PG 自己的内部 schema（pg_toast / pg_temp_N 之类），别摆给用户看
            const SQL: &str = "SELECT schema_name FROM information_schema.schemata \
                 WHERE schema_name NOT IN ('pg_catalog', 'information_schema') \
                   AND schema_name NOT LIKE 'pg\\_%' \
                 ORDER BY schema_name";
            let rows = sqlx::query(SQL)
                .fetch_all(pool)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows.iter().map(|row| text_cell!(row, 0, format_bytes)).collect())
        }
        _ => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn db_tables(
    state: tauri::State<'_, DbState>,
    id: u32,
    schema: Option<String>,
) -> Result<Vec<TableInfo>, String> {
    let session = session_of(&state, id)?;
    tables_of(&session, schema.as_deref()).await
}

/// 列出某个命名空间下的表与视图。`schema` 是「表挂在哪」那一层的名字：
/// MySQL 是库名、PG 是 schema 名、SQLite 忽略。传 None 时退回「所有非系统命名空间」。
pub(crate) async fn tables_of(
    session: &DbSession,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    match &session.pool {
        DbPool::Mysql(pool) => {
            // 指定了库就按库过滤；没指定时退回原来的行为（DATABASE() 为 NULL 则列出所有
            // 非系统库）——建连时没填库名的话 DATABASE() 是 NULL，只按它过滤会一条都查不到。
            const SQL_ONE: &str = "SELECT table_schema, table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema = ? \
                 ORDER BY table_name";
            const SQL_ALL: &str = "SELECT table_schema, table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema = DATABASE() \
                    OR (DATABASE() IS NULL AND table_schema NOT IN \
                        ('information_schema', 'mysql', 'performance_schema', 'sys')) \
                 ORDER BY table_schema, table_name";
            let rows = match schema {
                Some(name) => sqlx::query(SQL_ONE).bind(name).fetch_all(pool).await,
                None => sqlx::query(SQL_ALL).fetch_all(pool).await,
            }
            .map_err(|e| e.to_string())?;
            Ok(rows
                .iter()
                .map(|row| {
                    let schema: String = text_cell!(row, 0, bytes_mysql);
                    let name: String = text_cell!(row, 1, bytes_mysql);
                    let table_type: String = text_cell!(row, 2, bytes_mysql);
                    TableInfo {
                        schema,
                        name,
                        kind: table_kind(&table_type),
                    }
                })
                .collect())
        }
        DbPool::Postgres(pool) => {
            const SQL_ONE: &str = "SELECT table_schema, table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema = $1 \
                 ORDER BY table_name";
            const SQL_ALL: &str = "SELECT table_schema, table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                 ORDER BY table_schema, table_name";
            let rows = match schema {
                Some(name) => sqlx::query(SQL_ONE).bind(name).fetch_all(pool).await,
                None => sqlx::query(SQL_ALL).fetch_all(pool).await,
            }
            .map_err(|e| e.to_string())?;
            Ok(rows
                .iter()
                .map(|row| {
                    let schema: String = text_cell!(row, 0, format_bytes);
                    let name: String = text_cell!(row, 1, format_bytes);
                    let table_type: String = text_cell!(row, 2, format_bytes);
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
                    let name: String = text_cell!(row, 0, format_bytes);
                    let table_type: String = text_cell!(row, 1, format_bytes);
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
pub(crate) enum SqlClass {
    /// 返回行的查询，可翻页（SELECT / WITH / VALUES / TABLE）
    RowsPaged,
    /// 返回行但没法翻页（SHOW / EXPLAIN / PRAGMA 之类），只取一页
    RowsSingle,
    /// 写语句与 DDL，看影响行数
    Write,
}

/// 去掉首部的注释与空白、尾部的分号——分号留在里面会被包进子查询，直接语法错。
pub(crate) fn strip_sql(sql: &str) -> String {
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

pub(crate) fn classify_sql(sql: &str) -> SqlClass {
    match first_keyword(sql).as_str() {
        "select" | "with" | "values" | "table" => SqlClass::RowsPaged,
        "insert" | "update" | "delete" | "replace" | "merge" | "create" | "drop" | "alter"
        | "truncate" | "grant" | "revoke" | "vacuum" | "attach" | "detach" | "reindex"
        | "comment" | "call" | "do" | "load" | "begin" | "commit" | "rollback" | "savepoint"
        | "release" | "start" => SqlClass::Write,
        _ => SqlClass::RowsSingle,
    }
}

/// 只读判定（数据库 Agent 的 `run_query` 专用）。比 `classify_sql` 严：后者只看第一个关键字，
/// `WITH x AS (...) INSERT ...` 会被当成可翻页查询放过去。
///
/// 规则：先剥掉注释与字符串/反引号字面量（它们不是 SQL 语义的一部分，留着会让关键字扫描
/// 误判，比如 `SELECT 'drop table'`），再要求首个有效关键字在白名单里；对可能藏写操作的
/// 几类（select / with / values / table / explain）再扫一遍写动词；内嵌分号（多语句）一律拒绝。
pub(crate) fn is_read_only(sql: &str) -> bool {
    let stripped = strip_sql(sql);
    if stripped.is_empty() {
        return false;
    }
    let cleaned = strip_noise(&stripped);
    // 内嵌分号 = 多条语句。`strip_sql` 已经去掉尾部分号，这里再遇到就说明是拼接
    if cleaned.contains(';') {
        return false;
    }
    let keyword = first_keyword(&cleaned);
    // 这几类的正文里可能藏写操作，要再扫一遍动词
    let scanned = matches!(
        keyword.as_str(),
        "select" | "with" | "values" | "table" | "explain"
    );
    // show / describe / desc 语法固定、只读；pragma 刻意不放行（`PRAGMA query_only = OFF`
    // 能关掉下面的池级只读兜底，看表结构请走 describe_table 工具）
    let allowed = scanned || matches!(keyword.as_str(), "show" | "describe" | "desc");
    if !allowed {
        return false;
    }
    if scanned && contains_write_verb(&cleaned) {
        return false;
    }
    true
}

/// 把注释与字符串/反引号字面量替换成空格，只留下关键字与标点。
///
/// 逐字节扫描（注释 / 引号的边界都是 ASCII），但输出走 `Vec<u8>`——直接按字节 push 到
/// `String` 会把多字节 UTF-8 字符拆坏，中文标识符就没了。
fn strip_noise(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        // `--` 行注释
        if b == b'-' && bytes.get(i + 1) == Some(&b'-') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // MySQL 的 `#` 行注释
        if b == b'#' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // `/* */` 块注释
        if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            out.push(b' ');
            continue;
        }
        // 单引号 / 双引号 / 反引号字面量（含反斜杠转义与双写转义）
        if b == b'\'' || b == b'"' || b == b'`' {
            let quote = b;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                    continue;
                }
                if bytes[i] == quote {
                    if bytes.get(i + 1) == Some(&quote) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push(b' ');
            continue;
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 扫描写动词，按词边界匹配（`updated_at`、`deleted_at` 这类标识符不该命中）。
fn contains_write_verb(sql: &str) -> bool {
    const WRITE_VERBS: &[&str] = &[
        "insert", "update", "delete", "merge", "replace", "upsert", "create", "drop", "alter",
        "truncate", "grant", "revoke", "into", "set", "reset", "copy", "call", "do", "load",
        "vacuum", "attach", "detach", "reindex", "begin", "commit", "rollback", "savepoint",
        "release", "lock", "analyze", "refresh", "comment",
    ];
    let lower = sql.to_lowercase();
    let bytes = lower.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    for verb in WRITE_VERBS {
        for (start, _) in lower.match_indices(verb) {
            let end = start + verb.len();
            let before_ok = start == 0 || !is_word(bytes[start - 1]);
            let after_ok = end >= bytes.len() || !is_word(bytes[end]);
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
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

pub(crate) async fn run_query(
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
/// 末尾的 `$bytes` 是「拿到字节数组后怎么渲染」的函数，三库口径不同（见 `bytes_mysql`）。
macro_rules! decode_cell {
    ($row:expr, $idx:expr, [$($extra:ty),* $(,)?], $bytes:path) => {{
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
            return Some($bytes(&value));
        }
        Some("<无法显示>".to_string())
    }};
}

fn cells_mysql(row: &MySqlRow) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, [BigDecimal, Uuid, serde_json::Value], bytes_mysql))
        .collect()
}

fn cells_pg(row: &PgRow) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, [BigDecimal, Uuid, serde_json::Value], format_bytes))
        .collect()
}

// SQLite 是动态类型，值大多落在文本 / 整数 / 浮点 / 二进制上，通用那几档就够；
// BigDecimal / Uuid / JSON 在 sqlx-sqlite 里没有 Decode 实现，传了反而编不过。
fn cells_sqlite(row: &SqliteRow) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, [], format_bytes))
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

/// MySQL 专用：`utf8mb3_bin` 这类 `_bin` 排序规则的**文本**列会带上 BINARY 标志，
/// sqlx 因此拒收 `String`、只肯按字节数组给（information_schema 和 SHOW 的结果列全是这种）。
/// 直接当二进制渲染就是一串 `0x...`——表名、库名全成了乱码。这里补一道 UTF-8 解码，
/// 只有真解不出来（或带控制字符，那就是真的二进制）才退回十六进制。
fn bytes_mysql(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) if !text.chars().any(|c| c.is_control() && c != '\t' && c != '\n' && c != '\r') => {
            clamp_cell(text.to_string())
        }
        _ => format_bytes(bytes),
    }
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
    fn only_read_only_statements_pass() {
        // 放行
        assert!(is_read_only("SELECT * FROM t"));
        assert!(is_read_only("  select 1 ; "));
        assert!(is_read_only("with x as (select 1) select * from x"));
        assert!(is_read_only("SHOW TABLES"));
        assert!(is_read_only("SHOW CREATE TABLE t"));
        assert!(is_read_only("EXPLAIN SELECT 1"));
        assert!(is_read_only("-- 注释\nSELECT 1"));
        // 注释 / 字符串里的关键字不算数
        assert!(is_read_only("SELECT * FROM t WHERE name = 'drop table'"));
        assert!(is_read_only("SELECT deleted_at, updated_at FROM t"));

        // 写语句一律拒
        assert!(!is_read_only("INSERT INTO t VALUES (1)"));
        assert!(!is_read_only("UPDATE t SET a=1"));
        assert!(!is_read_only("DELETE FROM t"));
        assert!(!is_read_only("DROP TABLE t"));
        assert!(!is_read_only("CREATE TABLE t (id int)"));
        assert!(!is_read_only(""));
        // 绕过手法
        assert!(!is_read_only("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"));
        assert!(!is_read_only("SELECT 1; DROP TABLE t"));
        assert!(!is_read_only("SELECT * FROM t INTO OUTFILE '/tmp/x'"));
        assert!(!is_read_only("EXPLAIN ANALYZE INSERT INTO t VALUES (1)"));
        // PRAGMA 能关掉池级只读，刻意不放行
        assert!(!is_read_only("PRAGMA query_only = OFF"));
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

    #[test]
    fn mysql_bytes_prefers_text_but_keeps_binary_as_hex() {
        // information_schema / SHOW 的文本列（utf8mb3_bin）走这条
        assert_eq!(bytes_mysql(b"air_db"), "air_db");
        assert_eq!(bytes_mysql("中文库".as_bytes()), "中文库");
        // 带控制字符 → 当成真二进制
        assert_eq!(bytes_mysql(&[0x01, 0x02, 0x03, 0x04]), "0x01020304");
        // 非 UTF-8 → 十六进制
        assert_eq!(bytes_mysql(&[0xff, 0xfe]), "0xfffe");
        // 换行 / 制表符不算控制字符，文本里带着也得照样显示
        assert_eq!(bytes_mysql(b"a\tb\nc"), "a\tb\nc");
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

        // SQLite 只有 main 一个库、没有 schema 这一层
        assert_eq!(databases_of(&session).await.unwrap(), vec!["main"]);
        assert!(schemas_of(&session).await.unwrap().is_empty());
        let tables = tables_of(&session, Some("main")).await.unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "t");
        assert_eq!(tables[0].kind, "table");

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
