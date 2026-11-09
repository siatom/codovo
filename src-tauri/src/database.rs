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
//!   `SELECT * FROM (<sql>) AS __codovo_pg LIMIT n OFFSET m`，多取一行来判断有没有下一页。
//!   写语句与 SHOW/EXPLAIN 这类一次性结果不分页。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use futures::TryStreamExt;
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

/// 导出单次最多写出的行数。导出按「不分页一次取全」执行，行数不设防会把内存和文件撑爆；
/// 超过就按截断处理，结果里带 `truncated` 标记、前端明确告知，比直接报错让用户无从下手要好。
const EXPORT_MAX_ROWS: u64 = 100_000;

/// 导出的执行超时。比交互查询的 30s 宽得多——一次性取十万行本就慢，但也不能无限等。
const EXPORT_TIMEOUT: Duration = Duration::from_secs(300);

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
/// 也用作数据库助手的「当前目标连接」（内存态，见 `agent::tools::db`）。
#[derive(Clone, Serialize, Deserialize)]
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
                // 取表 / 库名这类元数据用不着全量，按截断版渲染（导出走的是另一条链路）
                Ok(value) => $bytes(&value, true),
                Err(_) => String::new(),
            },
        }
    };
}

/// 同 `text_cell!`，但保留 NULL 语义：列值为 NULL 时给 `None`。表结构里默认值 / 注释两列
/// 要区分「没有」和「空串」，`text_cell!` 会把两者都并成空串。MySQL 同样要走字节兜底。
macro_rules! text_cell_opt {
    ($row:expr, $idx:expr, $bytes:path) => {{
        let row = $row;
        let idx = $idx;
        if row.try_get_raw(idx).map(|raw| raw.is_null()).unwrap_or(true) {
            None
        } else {
            match row.try_get::<String, _>(idx) {
                Ok(value) => Some(value),
                // 与 text_cell! 同口径：元数据按截断版渲染（clamp=true）
                Err(_) => row.try_get::<Vec<u8>, _>(idx).ok().map(|value| $bytes(&value, true)),
            }
        }
    }};
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

/// 表结构里的一个列。字段名走 camelCase，前端直接吃。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDetail {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    /// 默认值表达式；没有默认值就是 None
    pub default: Option<String>,
    pub primary_key: bool,
    /// 注释；拿不到就是 None（SQLite 没有原生列注释，不伪造）
    pub comment: Option<String>,
}

/// 表结构里的一个索引。`columns` 保持索引内的列序。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

/// 表结构里的一个外键。复合外键的 `columns` 与 `ref_columns` 一一对应、按序。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// 一张表（或视图）的完整结构。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    /// 建表 DDL：MySQL 走 SHOW CREATE、SQLite 走 sqlite_master、PG 由元数据「尽力拼」
    pub ddl: Option<String>,
    /// DDL 是不是「尽力拼」出来的（目前只有 PG 为 true），UI 上要标注
    pub ddl_approximate: bool,
}

/// 查看一张表（或视图）的结构：列 / 索引 / 外键 / 建表 DDL。
/// `schema` 的口径与 `db_tables` 一致：MySQL 是库名、PG 是 schema 名、SQLite 忽略。
#[tauri::command]
pub async fn db_table_structure(
    state: tauri::State<'_, DbState>,
    id: u32,
    schema: Option<String>,
    table: String,
) -> Result<TableStructure, String> {
    let session = session_of(&state, id)?;
    table_structure_of(&session, schema.as_deref(), &table).await
}

pub(crate) async fn table_structure_of(
    session: &DbSession,
    schema: Option<&str>,
    table: &str,
) -> Result<TableStructure, String> {
    match &session.pool {
        DbPool::Mysql(pool) => mysql_table_structure(pool, schema, table).await,
        DbPool::Postgres(pool) => pg_table_structure(pool, schema, table).await,
        DbPool::Sqlite(pool) => sqlite_table_structure(pool, table).await,
    }
}

/// MySQL：列 / 索引 / 外键都来自 information_schema，DDL 走 SHOW CREATE。
/// information_schema 的文本列带 `utf8mb3_bin` 排序规则（BINARY 标志），一律走 text_cell! / text_cell_opt!。
async fn mysql_table_structure(
    pool: &MySqlPool,
    schema: Option<&str>,
    table: &str,
) -> Result<TableStructure, String> {
    // 建连时没指定默认库的话 DATABASE() 是 NULL，用 COALESCE 兜住
    let schema_arg = schema.unwrap_or("");

    let col_rows = sqlx::query(
        "SELECT column_name, column_type, is_nullable, column_default, column_key, column_comment \
         FROM information_schema.columns \
         WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? \
         ORDER BY ordinal_position",
    )
    .bind(schema_arg)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let columns: Vec<ColumnDetail> = col_rows
        .iter()
        .map(|row| {
            let null_flag: String = text_cell!(row, 2, bytes_mysql);
            let key: String = text_cell!(row, 4, bytes_mysql);
            ColumnDetail {
                name: text_cell!(row, 0, bytes_mysql),
                data_type: text_cell!(row, 1, bytes_mysql),
                nullable: null_flag.eq_ignore_ascii_case("YES"),
                default: text_cell_opt!(row, 3, bytes_mysql),
                primary_key: key.eq_ignore_ascii_case("PRI"),
                // column_comment 非 NULL，空串按「没有注释」处理，和 PG / SQLite 口径一致
                comment: text_cell_opt!(row, 5, bytes_mysql).filter(|text| !text.is_empty()),
            }
        })
        .collect();

    // 索引：statistics 一行一列，按 index_name + seq_in_index 排好后分组
    let idx_rows = sqlx::query(
        "SELECT index_name, non_unique, column_name \
         FROM information_schema.statistics \
         WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? \
         ORDER BY index_name, seq_in_index",
    )
    .bind(schema_arg)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut indexes: Vec<IndexInfo> = Vec::new();
    for row in &idx_rows {
        let name: String = text_cell!(row, 0, bytes_mysql);
        let non_unique: i64 = row.try_get(1).unwrap_or(0);
        let column: String = text_cell!(row, 2, bytes_mysql);
        match indexes.last_mut() {
            Some(last) if last.name == name => last.columns.push(column),
            _ => indexes.push(IndexInfo {
                primary: name == "PRIMARY",
                name,
                columns: vec![column],
                unique: non_unique == 0,
            }),
        }
    }

    // 外键：key_column_usage 里 referenced_table_name 非空的就是外键列
    let fk_rows = sqlx::query(
        "SELECT constraint_name, column_name, referenced_table_name, referenced_column_name \
         FROM information_schema.key_column_usage \
         WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? \
           AND referenced_table_name IS NOT NULL \
         ORDER BY constraint_name, ordinal_position",
    )
    .bind(schema_arg)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    for row in &fk_rows {
        let name: String = text_cell!(row, 0, bytes_mysql);
        let column: String = text_cell!(row, 1, bytes_mysql);
        let ref_table: String = text_cell!(row, 2, bytes_mysql);
        let ref_column: String = text_cell!(row, 3, bytes_mysql);
        match foreign_keys.last_mut() {
            Some(last) if last.name == name => {
                last.columns.push(column);
                last.ref_columns.push(ref_column);
            }
            _ => foreign_keys.push(ForeignKeyInfo {
                name,
                columns: vec![column],
                ref_table,
                ref_columns: vec![ref_column],
            }),
        }
    }

    let ddl = mysql_show_create(pool, schema, table).await;
    Ok(TableStructure {
        columns,
        indexes,
        foreign_keys,
        ddl,
        ddl_approximate: false,
    })
}

/// SHOW CREATE TABLE / VIEW 的 DDL 取第 2 列。视图上 `SHOW CREATE TABLE` 未必认，
/// 退一步试 `SHOW CREATE VIEW`；两次都失败就返回 None（不伪造）。
async fn mysql_show_create(
    pool: &MySqlPool,
    schema: Option<&str>,
    table: &str,
) -> Option<String> {
    // 符号名没法用 bind 传给 SHOW CREATE，得自己拼；反引号按 MySQL 规则转义
    let quote = |name: &str| format!("`{}`", name.replace('`', "``"));
    let qualified = match schema.filter(|name| !name.is_empty()) {
        Some(db) => format!("{}.{}", quote(db), quote(table)),
        None => quote(table),
    };
    for sql in [
        format!("SHOW CREATE TABLE {qualified}"),
        format!("SHOW CREATE VIEW {qualified}"),
    ] {
        if let Ok(rows) = sqlx::query(&sql).fetch_all(pool).await {
            if let Some(row) = rows.first() {
                if row.columns().len() > 1 {
                    let ddl: String = text_cell!(row, 1, bytes_mysql);
                    if !ddl.is_empty() {
                        return Some(ddl);
                    }
                }
            }
        }
    }
    None
}

/// PostgreSQL：列 / 索引 / 外键都走 pg_catalog（information_schema 要反复联表）。
async fn pg_table_structure(
    pool: &PgPool,
    schema: Option<&str>,
    table: &str,
) -> Result<TableStructure, String> {
    let schema_arg = schema.unwrap_or("");

    // 列：格式化类型 / 可空 / 默认值表达式 / 主键 / 注释，一次联出来
    let col_rows = sqlx::query(
        "SELECT a.attname, \
                format_type(a.atttypid, a.atttypmod), \
                NOT a.attnotnull, \
                pg_get_expr(d.adbin, d.adrelid), \
                COALESCE(i.indisprimary, false), \
                col_description(a.attrelid, a.attnum) \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum \
         LEFT JOIN pg_index i \
           ON i.indrelid = c.oid AND a.attnum = ANY(i.indkey) AND i.indisprimary \
         WHERE c.relname = $1 AND n.nspname = COALESCE(NULLIF($2, ''), 'public') \
           AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
    )
    .bind(table)
    .bind(schema_arg)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let columns: Vec<ColumnDetail> = col_rows
        .iter()
        .map(|row| ColumnDetail {
            name: text_cell!(row, 0, format_bytes),
            data_type: text_cell!(row, 1, format_bytes),
            nullable: row.try_get::<bool, _>(2).unwrap_or(true),
            default: text_cell_opt!(row, 3, format_bytes),
            primary_key: row.try_get::<bool, _>(4).unwrap_or(false),
            comment: text_cell_opt!(row, 5, format_bytes).filter(|text| !text.is_empty()),
        })
        .collect();

    // 索引：pg_get_indexdef 逐列取，inline=true 拿到的是列名/表达式、且保序
    let idx_rows = sqlx::query(
        "SELECT i.relname, ix.indisunique, ix.indisprimary, \
                pg_get_indexdef(ix.indexrelid, k.ord::int, true) \
         FROM pg_index ix \
         JOIN pg_class t ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         CROSS JOIN LATERAL generate_series(1, ix.indnkeyatts) AS k(ord) \
         WHERE t.relname = $1 AND n.nspname = COALESCE(NULLIF($2, ''), 'public') \
         ORDER BY i.relname, k.ord",
    )
    .bind(table)
    .bind(schema_arg)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut indexes: Vec<IndexInfo> = Vec::new();
    for row in &idx_rows {
        let name: String = text_cell!(row, 0, format_bytes);
        let unique: bool = row.try_get(1).unwrap_or(false);
        let primary: bool = row.try_get(2).unwrap_or(false);
        let column: String = text_cell!(row, 3, format_bytes);
        match indexes.last_mut() {
            Some(last) if last.name == name => last.columns.push(column),
            _ => indexes.push(IndexInfo {
                name,
                columns: vec![column],
                unique,
                primary,
            }),
        }
    }

    // 外键：pg_constraint contype='f'，conkey 与 confkey 按下标一一对应
    let fk_rows = sqlx::query(
        "SELECT con.conname, att.attname, cl2.relname, att2.attname \
         FROM pg_constraint con \
         JOIN pg_class cl ON cl.oid = con.conrelid \
         JOIN pg_namespace n ON n.oid = cl.relnamespace \
         JOIN pg_class cl2 ON cl2.oid = con.confrelid \
         CROSS JOIN LATERAL generate_subscripts(con.conkey, 1) AS ord(n) \
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[ord.n] \
         JOIN pg_attribute att2 \
           ON att2.attrelid = con.confrelid AND att2.attnum = con.confkey[ord.n] \
         WHERE con.contype = 'f' AND cl.relname = $1 \
           AND n.nspname = COALESCE(NULLIF($2, ''), 'public') \
         ORDER BY con.conname, ord.n",
    )
    .bind(table)
    .bind(schema_arg)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    for row in &fk_rows {
        let name: String = text_cell!(row, 0, format_bytes);
        let column: String = text_cell!(row, 1, format_bytes);
        let ref_table: String = text_cell!(row, 2, format_bytes);
        let ref_column: String = text_cell!(row, 3, format_bytes);
        match foreign_keys.last_mut() {
            Some(last) if last.name == name => {
                last.columns.push(column);
                last.ref_columns.push(ref_column);
            }
            _ => foreign_keys.push(ForeignKeyInfo {
                name,
                columns: vec![column],
                ref_table,
                ref_columns: vec![ref_column],
            }),
        }
    }

    let ddl = pg_build_ddl(pool, schema, table, &columns, &foreign_keys).await;
    Ok(TableStructure {
        columns,
        indexes,
        foreign_keys,
        ddl,
        ddl_approximate: true,
    })
}

/// PG 的标识符引号（双引号，内部双写）。
fn pg_quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// PG 没有单条等价的「建表 DDL」语句，只能按已取的元数据拼一个；视图则用 pg_get_viewdef。
/// 拼出来的东西不保证与原定义逐字一致，所以 `ddl_approximate` 记为 true，UI 上要标注。
async fn pg_build_ddl(
    pool: &PgPool,
    schema: Option<&str>,
    table: &str,
    columns: &[ColumnDetail],
    foreign_keys: &[ForeignKeyInfo],
) -> Option<String> {
    let schema_name = schema.filter(|name| !name.is_empty()).unwrap_or("public");

    // 先认关系类型：视图（v / 物化视图 m）没法拼 CREATE TABLE，改贴视图定义
    let relkind: Option<String> = sqlx::query(
        "SELECT c.relkind::text FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relname = $1 AND n.nspname = $2",
    )
    .bind(table)
    .bind(schema_name)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .map(|row| text_cell!(row, 0, format_bytes));

    if matches!(relkind.as_deref(), Some("v" | "m")) {
        let body: String = sqlx::query("SELECT pg_get_viewdef(format('%I.%I', $1, $2)::regclass, true)")
            .bind(schema_name)
            .bind(table)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .map(|row| text_cell!(row, 0, format_bytes))?;
        return Some(format!(
            "-- 由 pg_get_viewdef 得到，头部为尽力拼出\nCREATE VIEW {}.{} AS\n{}",
            pg_quote(schema_name),
            pg_quote(table),
            body
        ));
    }

    let mut lines: Vec<String> = columns
        .iter()
        .map(|column| {
            let mut line = format!("  {} {}", pg_quote(&column.name), column.data_type);
            if !column.nullable {
                line.push_str(" NOT NULL");
            }
            if let Some(default) = &column.default {
                line.push_str(&format!(" DEFAULT {default}"));
            }
            line
        })
        .collect();

    let primary: Vec<String> = columns
        .iter()
        .filter(|column| column.primary_key)
        .map(|column| pg_quote(&column.name))
        .collect();
    if !primary.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", primary.join(", ")));
    }
    for fk in foreign_keys {
        let local = fk.columns.iter().map(|name| pg_quote(name)).collect::<Vec<_>>().join(", ");
        let remote = fk
            .ref_columns
            .iter()
            .map(|name| pg_quote(name))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "  CONSTRAINT {} FOREIGN KEY ({local}) REFERENCES {} ({remote})",
            pg_quote(&fk.name),
            pg_quote(&fk.ref_table),
        ));
    }

    Some(format!(
        "-- 由已取元数据尽力拼出，非数据库原始定义\nCREATE TABLE {}.{} (\n{}\n);",
        pg_quote(schema_name),
        pg_quote(table),
        lines.join(",\n")
    ))
}

/// SQLite：列 / 索引 / 外键走 pragma，DDL 直接取 sqlite_master 里存的原始语句。
async fn sqlite_table_structure(
    pool: &SqlitePool,
    table: &str,
) -> Result<TableStructure, String> {
    // 列：pragma_table_info 是表值函数，可以绑表名。SQLite 没有列注释，comment 一律 None
    let col_rows = sqlx::query("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?)")
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let columns: Vec<ColumnDetail> = col_rows
        .iter()
        .map(|row| ColumnDetail {
            name: text_cell!(row, 0, format_bytes),
            data_type: text_cell!(row, 1, format_bytes),
            nullable: row.try_get::<i64, _>(2).unwrap_or(0) == 0,
            default: text_cell_opt!(row, 3, format_bytes),
            primary_key: row.try_get::<i64, _>(4).unwrap_or(0) != 0,
            comment: None,
        })
        .collect();

    // 索引：pragma_index_list 给名字 / 是否唯一 / 来源（pk 就是主键索引），
    // 再用 pragma_index_info 逐列取（按 seqno 保序；表达式索引的 name 为 NULL，跳过）
    let idx_rows = sqlx::query("SELECT name, \"unique\", origin FROM pragma_index_list(?)")
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut indexes: Vec<IndexInfo> = Vec::new();
    for row in &idx_rows {
        let name: String = text_cell!(row, 0, format_bytes);
        let unique: i64 = row.try_get(1).unwrap_or(0);
        let origin: String = text_cell!(row, 2, format_bytes);
        let col_rows = sqlx::query(
            "SELECT name FROM pragma_index_info(?) WHERE name IS NOT NULL ORDER BY seqno",
        )
        .bind(&name)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        let cols: Vec<String> = col_rows.iter().map(|r| text_cell!(r, 0, format_bytes)).collect();
        indexes.push(IndexInfo {
            name,
            columns: cols,
            unique: unique != 0,
            primary: origin == "pk",
        });
    }

    // 外键：pragma_foreign_key_list 里同一个 id 属于同一约束，seq 保列序。
    // SQLite 的 PRAGMA 不提供约束名，name 只能留空（不伪造）
    let fk_rows = sqlx::query(
        "SELECT id, seq, \"table\", \"from\", \"to\" \
         FROM pragma_foreign_key_list(?) ORDER BY id, seq",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    let mut last_id: Option<i64> = None;
    for row in &fk_rows {
        let id: i64 = row.try_get(0).unwrap_or(0);
        let column: String = text_cell!(row, 3, format_bytes);
        let ref_table: String = text_cell!(row, 2, format_bytes);
        let ref_column: String = text_cell_opt!(row, 4, format_bytes).unwrap_or_default();
        if last_id == Some(id) {
            if let Some(last) = foreign_keys.last_mut() {
                last.columns.push(column);
                last.ref_columns.push(ref_column);
            }
        } else {
            foreign_keys.push(ForeignKeyInfo {
                name: String::new(),
                columns: vec![column],
                ref_table,
                ref_columns: vec![ref_column],
            });
            last_id = Some(id);
        }
    }

    let ddl_rows = sqlx::query(
        "SELECT sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let ddl = ddl_rows.first().and_then(|row| text_cell_opt!(row, 0, format_bytes));

    Ok(TableStructure {
        columns,
        indexes,
        foreign_keys,
        ddl,
        ddl_approximate: false,
    })
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

/// 取 SQL 顶层（括号外）的单词序列（小写）。字符串与注释已被 `strip_noise` 抹平，
/// 所以这里只需要跳过括号、按词边界切词——CTE / 子查询里的关键字不会被误当成顶层。
fn top_level_words(sql: &str) -> Vec<String> {
    let cleaned = strip_noise(sql);
    let bytes = cleaned.as_bytes();
    let mut words: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
            }
            b if b.is_ascii_alphabetic() => {
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                if depth == 0 {
                    words.push(cleaned[start..i].to_ascii_lowercase());
                }
            }
            _ => i += 1,
        }
    }
    words
}

/// SQL 顶层是否自带分页子句（`LIMIT` / `OFFSET` / `FETCH FIRST` / `FOR UPDATE` 等）。
///
/// 这些子句只能出现在语句最末，再往后面接 `LIMIT` 要么语法冲突、要么语义重复，
/// 所以这类语句只能按单页取回（翻页按钮自然停用），不能硬接分页。
fn has_top_level_paging(sql: &str) -> bool {
    let words = top_level_words(sql);
    if words.iter().any(|w| w == "limit" || w == "offset") {
        return true;
    }
    words.windows(2).any(|pair| {
        // `FETCH FIRST/NEXT n ROWS ONLY` 是标准写法；只认 `fetch` 会把名为 fetch 的列误判
        (pair[0] == "fetch" && (pair[1] == "first" || pair[1] == "next"))
            // `FOR UPDATE` / `FOR SHARE` / `FOR NO KEY UPDATE` / `FOR KEY SHARE` 必须收尾，
            // 其后接不了 LIMIT（MySQL/PG 都如此）
            || (pair[0] == "for"
                && (pair[1] == "update" || pair[1] == "share" || pair[1] == "no" || pair[1] == "key"))
    })
}

/// 给可翻页的查询接上 `LIMIT/OFFSET`，多取一行判断有没有下一页。
///
/// **不包派生表**：`SELECT * FROM (<sql>) LIMIT ...` 会让优化器丢掉内层的 ORDER BY
/// （MySQL 明确会丢、PG 也不保证），翻页从第二页起就乱序或重漏；用户 SQL 自带 LIMIT 时
/// 外层再套一层还会直接翻空。所以顶层没有分页子句时，把分页子句直接接到原 SQL 末尾，
/// 让用户的 ORDER BY 仍作用在最终结果上。**换行再加**：末尾若是 `-- 注释` 行注释，
/// 同一行的 `LIMIT` 会被注释掉，换行能把它隔出来。
fn append_paging(sql: &str, page: u32, page_size: u32) -> String {
    let limit = page_size as u64 + 1;
    let offset = page as u64 * page_size as u64;
    format!("{sql}\nLIMIT {limit} OFFSET {offset}")
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

/// 导出格式。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbFormat {
    Csv,
    Xlsx,
}

/// 导出范围。`Page` 按传入页码重跑（与界面所见一致），`All` 不分页一次取全。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbScope {
    Page,
    All,
}

/// `db_export` 的入参。参数多，打包成一个对象传。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbExportRequest {
    pub id: u32,
    pub sql: String,
    pub format: DbFormat,
    /// 目标文件绝对路径（前端用系统保存对话框选定）
    pub path: String,
    pub scope: DbScope,
    pub page: u32,
    pub page_size: u32,
    /// 标题（表名或 "query"）：清洗后作 Excel 工作表名
    #[serde(default)]
    pub title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbExportResult {
    pub path: String,
    pub rows: u64,
    /// 是否因超过行数上限被截断（前端据此提示）
    pub truncated: bool,
}

/// 导出用的取行 SQL。返回 `(要执行的 SQL, 是否可判定截断)`。
///
/// - 单页语句（SHOW / EXPLAIN…）或自带 LIMIT/OFFSET 的语句：原样取；All 的上限由流式取数
///   在保留用户分页语义的同时执行。
/// - 可翻页且无自带分页的：`All` 接 `LIMIT 上限+1`（多取一行好判超限），`Page` 按页码接
///   `LIMIT page_size OFFSET page*page_size`。换行再加，末尾若是行注释不会被吃掉
///   （与 `append_paging` 同一个理由）。
fn build_export_sql(
    sql: &str,
    class: SqlClass,
    scope: DbScope,
    page: u32,
    page_size: u32,
) -> (String, bool) {
    if class != SqlClass::RowsPaged || has_top_level_paging(sql) {
        return (sql.to_string(), scope == DbScope::All);
    }
    match scope {
        DbScope::All => (format!("{sql}\nLIMIT {}", EXPORT_MAX_ROWS + 1), true),
        DbScope::Page => {
            let size = page_size.max(1) as u64;
            let offset = page as u64 * size;
            (format!("{sql}\nLIMIT {size} OFFSET {offset}"), false)
        }
    }
}

/// 按范围流式取回导出行。单元格**不截断**；All 最多消费上限 + 1 行，以额外一行判定截断。
async fn collect_export_rows(
    session: &DbSession,
    sql: &str,
    scope: DbScope,
    page: u32,
    page_size: u32,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>, bool), String> {
    let trimmed = strip_sql(sql);
    if trimmed.is_empty() {
        return Err("请输入 SQL".to_string());
    }
    let class = classify_sql(&trimmed);
    if class == SqlClass::Write {
        return Err("该语句不产生结果集，无法导出".to_string());
    }
    let (query, truncatable) = build_export_sql(&trimmed, class, scope, page, page_size);
    let collect_limit = if scope == DbScope::All {
        EXPORT_MAX_ROWS as usize + 1
    } else {
        page_size.max(1) as usize
    };
    let (columns, mut rows) = fetch_export_rows(session, &query, collect_limit).await?;
    let truncated = truncatable && rows.len() as u64 > EXPORT_MAX_ROWS;
    if truncated {
        rows.truncate(EXPORT_MAX_ROWS as usize);
    }
    Ok((columns, rows, truncated))
}

/// 导出专用的有界流式读取，避免 `fetch_all` 在宽行查询上无界占用内存。
async fn fetch_export_rows(
    session: &DbSession,
    sql: &str,
    limit: usize,
) -> Result<(Vec<String>, Vec<Vec<Option<String>>>), String> {
    match &session.pool {
        DbPool::Mysql(pool) => {
            let mut columns: Vec<String> = pool
                .prepare(sql)
                .await
                .map(|s| s.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let mut stream = sqlx::query(sql).fetch(pool);
            let mut rows = Vec::with_capacity(limit.min(1024));
            while rows.len() < limit {
                match stream.try_next().await.map_err(|e| e.to_string())? {
                    Some(row) => {
                        if columns.is_empty() {
                            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        rows.push(cells_mysql(&row, false));
                    }
                    None => break,
                }
            }
            Ok((columns, rows))
        }
        DbPool::Postgres(pool) => {
            let mut columns: Vec<String> = pool
                .prepare(sql)
                .await
                .map(|s| s.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let mut stream = sqlx::query(sql).fetch(pool);
            let mut rows = Vec::with_capacity(limit.min(1024));
            while rows.len() < limit {
                match stream.try_next().await.map_err(|e| e.to_string())? {
                    Some(row) => {
                        if columns.is_empty() {
                            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        rows.push(cells_pg(&row, false));
                    }
                    None => break,
                }
            }
            Ok((columns, rows))
        }
        DbPool::Sqlite(pool) => {
            let mut columns: Vec<String> = pool
                .prepare(sql)
                .await
                .map(|s| s.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let mut stream = sqlx::query(sql).fetch(pool);
            let mut rows = Vec::with_capacity(limit.min(1024));
            while rows.len() < limit {
                match stream.try_next().await.map_err(|e| e.to_string())? {
                    Some(row) => {
                        if columns.is_empty() {
                            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        rows.push(cells_sqlite(&row, false));
                    }
                    None => break,
                }
            }
            Ok((columns, rows))
        }
    }
}

/// 按 RFC4180 转义一个字段：含逗号 / 引号 / 换行时加双引号，内部引号双写。
fn csv_escape(field: &str) -> String {
    if field.contains(',') || field.contains('"') || field.contains('\n') || field.contains('\r') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// 拼出完整 CSV 文本（含表头）。NULL 输出为空字段，换行统一 CRLF。
/// 开头写 UTF-8 BOM：否则 Windows 版 Excel 打开会把中文按本地编码解、整列乱码。
fn rows_to_csv(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    let mut out = String::new();
    out.push('\u{feff}');
    let header: Vec<String> = columns.iter().map(|c| csv_escape(c)).collect();
    out.push_str(&header.join(","));
    out.push_str("\r\n");
    for row in rows {
        let line: Vec<String> = row
            .iter()
            .map(|cell| cell.as_deref().map(csv_escape).unwrap_or_default())
            .collect();
        out.push_str(&line.join(","));
        out.push_str("\r\n");
    }
    out
}

fn write_csv_file(path: &str, columns: &[String], rows: &[Vec<Option<String>>]) -> Result<(), String> {
    std::fs::write(path, rows_to_csv(columns, rows)).map_err(|e| format!("写入文件失败：{e}"))
}

/// Excel 工作表名：最长 31 字符，且不能含 `[ ] : * ? / \`。清洗后为空就退回一个默认名。
fn sanitize_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "[]:*?/\\".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    let base = if trimmed.is_empty() { "结果" } else { trimmed };
    base.chars().take(31).collect()
}

/// 写第一个工作表：首行表头 = 列名，其余为数据行。NULL 写空单元格（不调 write_*）。
fn write_xlsx_file(
    path: &str,
    title: &str,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    use rust_xlsxwriter::Workbook;
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet
        .set_name(sanitize_sheet_name(title))
        .map_err(|e| format!("工作表名非法：{e}"))?;
    for (index, name) in columns.iter().enumerate() {
        sheet
            .write_string(0, index as u16, name)
            .map_err(|e| format!("写入单元格失败：{e}"))?;
    }
    for (r, row) in rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            if let Some(text) = cell {
                sheet
                    .write_string((r + 1) as u32, c as u16, text)
                    .map_err(|e| format!("写入单元格失败：{e}"))?;
            }
        }
    }
    workbook.save(path).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(())
}

/// 查询结果导出。后端负责取数（绕过单元格截断）并写文件，前端只用系统对话框选个路径。
///
/// 之所以不让前端拼 Blob：Tauri 里没有浏览器那套「下载」语义，且把整包数据搬到 WebView 再
/// 搬回来纯属浪费。写文件是同步阻塞，扔进 blocking 线程池，别占住 async 运行时。
#[tauri::command]
pub async fn db_export(
    state: tauri::State<'_, DbState>,
    request: DbExportRequest,
) -> Result<DbExportResult, String> {
    if request.path.trim().is_empty() {
        return Err("请选择保存位置".to_string());
    }
    let session = session_of(&state, request.id)?;
    let (columns, rows, truncated) = tokio::time::timeout(
        EXPORT_TIMEOUT,
        collect_export_rows(&session, &request.sql, request.scope, request.page, request.page_size),
    )
    .await
    .map_err(|_| format!("导出超时（{} 秒），请缩小范围", EXPORT_TIMEOUT.as_secs()))??;

    let row_count = rows.len() as u64;
    let path = request.path.clone();
    let title = request.title.clone();
    let write = move || match request.format {
        DbFormat::Csv => write_csv_file(&path, &columns, &rows),
        DbFormat::Xlsx => write_xlsx_file(&path, &title, &columns, &rows),
    };
    tokio::task::spawn_blocking(write)
        .await
        .map_err(|e| format!("导出失败：{e}"))??;

    Ok(DbExportResult {
        path: request.path,
        rows: row_count,
        truncated,
    })
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
            // 自带 LIMIT/OFFSET 的语句没法安全翻页，按单页取回（不再外包派生表，免得翻空）
            if has_top_level_paging(sql) {
                return fetch_rows(session, sql, 0, page_size, false, true).await;
            }
            let paged = append_paging(sql, page, page_size);
            fetch_rows(session, &paged, page, page_size, true, true).await
        }
        SqlClass::RowsSingle => fetch_rows(session, sql, 0, page_size, false, true).await,
        SqlClass::Write => execute_write(session, sql).await,
    }
}

/// 取一批行。`clamp=false` 时单元格**不截断**（导出用），其余行为与交互查询一致。
async fn fetch_rows(
    session: &DbSession,
    sql: &str,
    page: u32,
    page_size: u32,
    paged: bool,
    clamp: bool,
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
            Ok(assemble(
                columns,
                rows.iter().map(|row| cells_mysql(row, clamp)).collect(),
                page,
                page_size,
                paged,
            ))
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
            Ok(assemble(
                columns,
                rows.iter().map(|row| cells_pg(row, clamp)).collect(),
                page,
                page_size,
                paged,
            ))
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
            Ok(assemble(
                columns,
                rows.iter().map(|row| cells_sqlite(row, clamp)).collect(),
                page,
                page_size,
                paged,
            ))
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
/// `$bytes` 是「拿到字节数组后怎么渲染」的函数，三库口径不同（见 `bytes_mysql`）。
/// 末尾的 `$clamp` 决定超长文本是否截断：交互查询要截断（免得整包结果太大），导出必须全量。
///
/// 注意这个宏里多处 `return`，所以是**语句位置**用的，不能当表达式拼。
macro_rules! decode_cell {
    ($row:expr, $idx:expr, [$($extra:ty),* $(,)?], $bytes:path, $clamp:expr) => {{
        let row = $row;
        let idx = $idx;
        let clamp = $clamp;
        let raw = match row.try_get_raw(idx) {
            Ok(raw) => raw,
            Err(_) => return Some("<无法显示>".to_string()),
        };
        if raw.is_null() {
            return None;
        }
        if let Ok(value) = row.try_get::<String, _>(idx) {
            return Some(finish_cell(value, clamp));
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
                return Some(finish_cell(value.to_string(), clamp));
            }
        )*
        if let Ok(value) = row.try_get::<Vec<u8>, _>(idx) {
            return Some($bytes(&value, clamp));
        }
        Some("<无法显示>".to_string())
    }};
}

fn cells_mysql(row: &MySqlRow, clamp: bool) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, [BigDecimal, Uuid, serde_json::Value], bytes_mysql, clamp))
        .collect()
}

fn cells_pg(row: &PgRow, clamp: bool) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, [BigDecimal, Uuid, serde_json::Value], format_bytes, clamp))
        .collect()
}

// SQLite 是动态类型，值大多落在文本 / 整数 / 浮点 / 二进制上，通用那几档就够；
// BigDecimal / Uuid / JSON 在 sqlx-sqlite 里没有 Decode 实现，传了反而编不过。
fn cells_sqlite(row: &SqliteRow, clamp: bool) -> Vec<Option<String>> {
    (0..row.columns().len())
        .map(|idx| decode_cell!(row, idx, [], format_bytes, clamp))
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

/// 按「是否截断」收尾一个文本单元格。抽出来是为了让解码链路（含 `bytes_mysql`）共用同一个开关。
fn finish_cell(value: String, clamp: bool) -> String {
    if clamp {
        clamp_cell(value)
    } else {
        value
    }
}

/// 二进制列渲染成十六进制；太长就只报字节数。`clamp` 只为与其它渲染函数同签名的占位——
/// 十六进制串最多也就几十字符，不需要截断。
fn format_bytes(bytes: &[u8], _clamp: bool) -> String {
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
fn bytes_mysql(bytes: &[u8], clamp: bool) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) if !text.chars().any(|c| c.is_control() && c != '\t' && c != '\n' && c != '\r') => {
            finish_cell(text.to_string(), clamp)
        }
        _ => format_bytes(bytes, clamp),
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
    fn appends_paging_without_derived_table() {
        let paged = append_paging("SELECT * FROM t ORDER BY id", 2, 50);
        // 不再包派生表：用户的 ORDER BY 必须留在最终结果上，否则 MySQL/PG 会丢排序
        assert!(!paged.contains("__codovo_pg"));
        assert!(paged.ends_with("LIMIT 51 OFFSET 100")); // 多取一行判断 has_more
        // 末尾是行注释时靠换行把 LIMIT 隔出来，不能被注释吃掉
        assert!(append_paging("SELECT 1 -- 说明", 0, 10).ends_with("\nLIMIT 11 OFFSET 0"));
    }

    #[test]
    fn detects_top_level_paging() {
        assert!(has_top_level_paging("SELECT * FROM t LIMIT 10"));
        assert!(has_top_level_paging("SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 20"));
        assert!(has_top_level_paging("SELECT * FROM t OFFSET 5"));
        assert!(has_top_level_paging("SELECT * FROM t FETCH FIRST 10 ROWS ONLY"));
        assert!(has_top_level_paging("SELECT * FROM t FOR UPDATE"));
        // 括号内 / 字符串里的不算顶层
        assert!(!has_top_level_paging("SELECT * FROM (SELECT * FROM t LIMIT 5) x"));
        assert!(!has_top_level_paging("SELECT 'limit 10' FROM t"));
        assert!(!has_top_level_paging("SELECT fetch FROM t"));
        assert!(!has_top_level_paging("SELECT * FROM t ORDER BY id"));
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
        assert_eq!(bytes_mysql(b"air_db", true), "air_db");
        assert_eq!(bytes_mysql("中文库".as_bytes(), true), "中文库");
        // 带控制字符 → 当成真二进制
        assert_eq!(bytes_mysql(&[0x01, 0x02, 0x03, 0x04], true), "0x01020304");
        // 非 UTF-8 → 十六进制
        assert_eq!(bytes_mysql(&[0xff, 0xfe], true), "0xfffe");
        // 换行 / 制表符不算控制字符，文本里带着也得照样显示
        assert_eq!(bytes_mysql(b"a\tb\nc", true), "a\tb\nc");
    }

    #[tokio::test]
    async fn sqlite_roundtrip_pages_and_writes() {
        let path = std::env::temp_dir().join(format!("codovo-db-test-{}.db", std::process::id()));
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

    #[test]
    fn csv_escapes_rfc4180() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_escape("a\nb"), "\"a\nb\"");
        assert_eq!(csv_escape("a\rb"), "\"a\rb\"");
    }

    #[test]
    fn csv_has_bom_crlf_and_empty_null() {
        let columns = vec!["a".to_string(), "b".to_string()];
        let rows = vec![
            vec![Some("1".to_string()), None],
            vec![Some("x,y".to_string()), Some("q\"q".to_string())],
        ];
        let csv = rows_to_csv(&columns, &rows);
        // BOM + 表头 + CRLF + NULL 空字段 + 引号双写
        assert_eq!(csv, "\u{feff}a,b\r\n1,\r\n\"x,y\",\"q\"\"q\"\r\n");
    }

    #[test]
    fn writes_csv_file_with_utf8_bom() {
        let path = std::env::temp_dir().join(format!("codovo-csv-test-{}.csv", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let columns = vec!["名称".to_string()];
        let rows = vec![vec![Some("值".to_string())]];
        write_csv_file(path.to_str().unwrap(), &columns, &rows).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        // 头三字节是 UTF-8 BOM，否则 Windows Excel 打开中文乱码
        assert_eq!(&bytes[..3], &[0xef, 0xbb, 0xbf]);
        assert_eq!(String::from_utf8_lossy(&bytes), "\u{feff}名称\r\n值\r\n");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sanitizes_sheet_names() {
        assert_eq!(sanitize_sheet_name("a/b:c*d?e[f]g\\h"), "a_b_c_d_e_f_g_h");
        assert_eq!(sanitize_sheet_name("   "), "结果");
        assert_eq!(sanitize_sheet_name(""), "结果");
        // 超过 31 字符按字符截断
        assert_eq!(sanitize_sheet_name(&"x".repeat(40)).chars().count(), 31);
    }

    #[test]
    fn writes_xlsx_file() {
        let path = std::env::temp_dir().join(format!("codovo-xlsx-test-{}.xlsx", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let columns = vec!["id".to_string(), "name".to_string()];
        let rows = vec![
            vec![Some("1".to_string()), Some("中文".to_string())],
            vec![Some("2".to_string()), None],
        ];
        write_xlsx_file(path.to_str().unwrap(), "t/表", &columns, &rows).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        // xlsx 本质是个 zip，头四字节固定；能大于几百字节说明内容真的写进去了
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        assert!(bytes.len() > 500);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn builds_export_sql_by_scope_and_class() {
        // 可翻页 + 无自带分页：All 接「上限+1」判超限；Page 按页码取
        let (all, truncatable) =
            build_export_sql("SELECT * FROM t", SqlClass::RowsPaged, DbScope::All, 0, 50);
        assert_eq!(all, format!("SELECT * FROM t\nLIMIT {}", EXPORT_MAX_ROWS + 1));
        assert!(truncatable);

        let (page, truncatable) =
            build_export_sql("SELECT * FROM t", SqlClass::RowsPaged, DbScope::Page, 2, 50);
        assert_eq!(page, "SELECT * FROM t\nLIMIT 50 OFFSET 100");
        assert!(!truncatable);

        // 自带 LIMIT 保持原样，但 All 仍由流式读取检查上限
        let (kept, truncatable) =
            build_export_sql("SELECT * FROM t LIMIT 5", SqlClass::RowsPaged, DbScope::All, 0, 50);
        assert_eq!(kept, "SELECT * FROM t LIMIT 5");
        assert!(truncatable);

        let (single, _) = build_export_sql("SHOW TABLES", SqlClass::RowsSingle, DbScope::All, 0, 50);
        assert_eq!(single, "SHOW TABLES");
    }

    #[tokio::test]
    async fn export_bypasses_cell_clamp_and_honors_scope() {
        let path = std::env::temp_dir().join(format!("codovo-export-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(options).await.unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        let long = "a".repeat(5000);
        sqlx::query("INSERT INTO t (name) VALUES (?)")
            .bind(&long)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO t (name) VALUES ('b'), ('c'), ('d')")
            .execute(&pool)
            .await
            .unwrap();
        let session = DbSession {
            pool: DbPool::Sqlite(pool),
        };

        // 导出全量：单元格不截断
        let (cols, rows, truncated) =
            collect_export_rows(&session, "SELECT * FROM t ORDER BY id", DbScope::All, 0, 50)
                .await
                .unwrap();
        assert_eq!(cols, vec!["id", "name"]);
        assert_eq!(rows.len(), 4);
        assert!(!truncated);
        assert_eq!(rows[0][1].as_deref().unwrap().chars().count(), 5000);

        // 对照：交互查询那条链路照旧截断到 4096 + 省略号
        let interactive =
            run_query(&session, "SELECT * FROM t ORDER BY id", SqlClass::RowsPaged, 0, 50)
                .await
                .unwrap();
        assert_eq!(
            interactive.rows[0][1].as_deref().unwrap().chars().count(),
            MAX_CELL_CHARS + 1
        );

        // 当前页范围：第 2 页（0 基）两条，正好是 id 3 / 4
        let (_, page_rows, _) =
            collect_export_rows(&session, "SELECT * FROM t ORDER BY id", DbScope::Page, 1, 2)
                .await
                .unwrap();
        assert_eq!(page_rows.len(), 2);
        assert_eq!(page_rows[0][0].as_deref(), Some("3"));

        // 用户自带的大 LIMIT 也在取数层截断，且原查询的排序 / OFFSET 语义保留。
        let large = "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<150000) SELECT i FROM n ORDER BY i";
        for sql in [large, &format!("{large} LIMIT 150000")] {
            let (_, rows, truncated) =
                collect_export_rows(&session, sql, DbScope::All, 0, 50).await.unwrap();
            assert_eq!(rows.len(), EXPORT_MAX_ROWS as usize);
            assert!(truncated);
            assert_eq!(rows.first().unwrap()[0].as_deref(), Some("1"));
            assert_eq!(rows.last().unwrap()[0].as_deref(), Some("100000"));
        }
        let (_, limited_rows, limited_truncated) = collect_export_rows(
            &session,
            "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20) SELECT i FROM n ORDER BY i LIMIT 5 OFFSET 7",
            DbScope::All,
            0,
            50,
        )
        .await
        .unwrap();
        assert_eq!(limited_rows.len(), 5);
        assert_eq!(limited_rows[0][0].as_deref(), Some("8"));
        assert!(!limited_truncated);

        // 写语句没有结果集，不给导出
        assert!(collect_export_rows(&session, "UPDATE t SET name='x'", DbScope::All, 0, 50)
            .await
            .is_err());
        let _ = std::fs::remove_file(&path);
    }

    /// 结构查询走真库：造一张带复合主键 / 唯一索引 / 复合外键 / 默认值的表，逐块断言。
    #[tokio::test]
    async fn sqlite_table_structure_reports_columns_indexes_and_fk() {
        let path =
            std::env::temp_dir().join(format!("codovo-db-struct-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(options).await.unwrap();
        sqlx::query("CREATE TABLE parent (id INTEGER PRIMARY KEY, code TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE child (\
                 a INTEGER NOT NULL, \
                 b TEXT DEFAULT 'x', \
                 c INTEGER, \
                 PRIMARY KEY (a, c), \
                 FOREIGN KEY (a, c) REFERENCES parent (id, id)\
             )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE UNIQUE INDEX idx_child_b ON child (b)")
            .execute(&pool)
            .await
            .unwrap();

        let session = DbSession {
            pool: DbPool::Sqlite(pool),
        };
        let structure = table_structure_of(&session, Some("main"), "child").await.unwrap();

        // 列：保序、可空、默认值、主键
        let names: Vec<&str> = structure.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
        assert!(!structure.columns[0].nullable);
        assert!(structure.columns[1].nullable);
        assert_eq!(structure.columns[1].default.as_deref(), Some("'x'"));
        assert!(structure.columns[0].primary_key);
        assert!(structure.columns[2].primary_key);
        assert!(!structure.columns[1].primary_key);
        // SQLite 没有列注释，一律 None（不伪造）
        assert!(structure.columns.iter().all(|c| c.comment.is_none()));

        // 索引：唯一索引 + 主键索引，列序保留
        assert!(structure.indexes.iter().any(|i| i.name == "idx_child_b"
            && i.unique
            && !i.primary
            && i.columns == vec!["b"]));
        assert!(structure.indexes.iter().any(|i| i.primary && i.columns == vec!["a", "c"]));

        // 外键：复合外键成组、列序一致
        assert_eq!(structure.foreign_keys.len(), 1);
        let fk = &structure.foreign_keys[0];
        assert_eq!(fk.columns, vec!["a", "c"]);
        assert_eq!(fk.ref_table, "parent");
        assert_eq!(fk.ref_columns, vec!["id", "id"]);

        // DDL 来自 sqlite_master，是原始语句、不是拼的
        assert!(!structure.ddl_approximate);
        let ddl = structure.ddl.unwrap();
        assert!(ddl.contains("CREATE TABLE child"));

        let _ = std::fs::remove_file(&path);
    }
}
