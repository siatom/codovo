//! 数据库助手的工具：列库表、看表结构、跑只读 SQL。
//!
//! 只读是硬约束，三层：工具描述与技能引导 → `database::is_read_only` 语句白名单 →
//! 建池时给每条连接设只读（`create_pool` 的 `read_only`）。
//!
//! 以前这些工具跑在 MCP 子进程里，拿不到主进程的连接池，只能自己读 target.json 重建。
//! 现在就在主进程里，仍然自建一份只读池：数据库面板的池是用户可写的连接，
//! 两者语义不同，不能混用。

use std::sync::{Arc, Mutex};

use rig_core::message::ToolName;
use rig_core::tool::{DynamicTool, ToolExecutionError, ToolOutput};
use rig_core::wasm_compat::WasmBoxedFuture;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::database::{self, DbConnectRequest, DbPool, DbSession};

/// 单次查询最多回给模型的行数。再多既占 context 也没人看。
const MAX_AGENT_ROWS: u32 = 200;

/// 当前面向哪个连接。由前端在切换连接时写入（`db_agent_set_target`）。
#[derive(Default)]
pub struct DbTarget {
    target: Mutex<Option<DbConnectRequest>>,
}

impl DbTarget {
    pub fn set(&self, target: DbConnectRequest) -> Result<(), String> {
        let mut slot = self.target.lock().map_err(|e| e.to_string())?;
        *slot = Some(target);
        Ok(())
    }

    fn get(&self) -> Result<DbConnectRequest, String> {
        self.target
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "还没有选择数据库连接，请在数据库面板里选一个".to_string())
    }
}

/// 三个数据库工具 + 它们共用的连接缓存。
pub struct DbTools {
    target: Arc<DbTarget>,
    cache: Mutex<ConnCache>,
}

impl DbTools {
    pub fn new(target: Arc<DbTarget>) -> Arc<Self> {
        Arc::new(Self {
            target,
            cache: Mutex::new(ConnCache::default()),
        })
    }

    /// 按当前目标拿一个只读会话；参数没变就复用上一次的池。
    async fn session(&self) -> Result<Arc<DbSession>, String> {
        let target = self.target.get()?;
        // 锁不能跨 await：先在锁里查缓存，命中就直接用，没命中再拿旧池出去关
        let lookup = {
            let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
            cache.prepare(&target)?
        };
        let stale = match lookup {
            CacheLookup::Hit(session) => return Ok(session),
            CacheLookup::Miss(stale) => stale,
        };
        if let Some(old) = stale {
            old.pool.close().await;
        }

        let password = crate::secrets::get(&database::password_secret_id(&target.conn_id))?
            .unwrap_or_default();
        let pool = database::create_pool(
            target.kind,
            target.host.trim(),
            target.port,
            target.user.trim(),
            &password,
            target.database.trim(),
            target.file.trim(),
            true,
        )
        .await?;

        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        let session = Arc::new(DbSession { pool });
        cache.session = Some(Arc::clone(&session));
        Ok(session)
    }
}

/// 连接缓存：key 是目标的序列化结果，变了就重建。
#[derive(Default)]
struct ConnCache {
    key: String,
    session: Option<Arc<DbSession>>,
}

/// 查缓存的结果。
enum CacheLookup {
    /// 参数没变，池还能用
    Hit(Arc<DbSession>),
    /// 参数变了（或本来就没有），顺带把旧池交出来关掉
    Miss(Option<Arc<DbSession>>),
}

impl ConnCache {
    fn prepare(&mut self, target: &DbConnectRequest) -> Result<CacheLookup, String> {
        let key = serde_json::to_string(target).map_err(|e| e.to_string())?;
        if key == self.key {
            if let Some(session) = &self.session {
                return Ok(CacheLookup::Hit(Arc::clone(session)));
            }
        }
        self.key = key;
        Ok(CacheLookup::Miss(self.session.take()))
    }
}

/// 三个工具。
pub fn tools(tools: Arc<DbTools>) -> Vec<DynamicTool> {
    vec![
        DynamicTool::new(
            ToolName::new("list_tables").expect("工具名是常量"),
            "列出当前数据库连接里的所有表与视图（只读）。不确定表名时先调它。",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            {
                let tools = Arc::clone(&tools);
                move |_args: Value| {
                    let tools = Arc::clone(&tools);
                    boxed(async move {
                        let session = tools.session().await.map_err(ToolExecutionError::other)?;
                        let tables = database::tables_of(&session, None).await.map_err(ToolExecutionError::other)?;
                        to_text(&json!({ "tables": tables }))
                    })
                }
            },
        ),
        DynamicTool::new(
            ToolName::new("describe_table").expect("工具名是常量"),
            "查看一张表的列（名称、类型、是否可空、是否主键），只读。写 SQL 前用它确认字段。",
            json!({
                "type": "object",
                "properties": {
                    "table": { "type": "string", "description": "表名" },
                    "schema": { "type": "string", "description": "schema 名，可省略" }
                },
                "required": ["table"],
                "additionalProperties": false
            }),
            {
                let tools = Arc::clone(&tools);
                move |args: Value| {
                    let tools = Arc::clone(&tools);
                    boxed(async move {
                        let table = args
                            .get("table")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if table.is_empty() {
                            return Err(ToolExecutionError::other("缺少 table 参数"));
                        }
                        let schema = args
                            .get("schema")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string();

                        let session = tools.session().await.map_err(ToolExecutionError::other)?;
                        let columns = columns_of(&session, &schema, &table).await?;
                        to_text(&json!({ "table": table, "columns": columns }))
                    })
                }
            },
        ),
        DynamicTool::new(
            ToolName::new("run_query").expect("工具名是常量"),
            "执行一条只读 SQL（SELECT / WITH / SHOW / EXPLAIN 等）并返回结果行。禁止任何写操作与 DDL。",
            json!({
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "只读 SQL 语句" }
                },
                "required": ["sql"],
                "additionalProperties": false
            }),
            {
                let tools = Arc::clone(&tools);
                move |args: Value| {
                    let tools = Arc::clone(&tools);
                    boxed(async move {
                        let sql = args
                            .get("sql")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if sql.is_empty() {
                            return Err(ToolExecutionError::other("缺少 sql 参数"));
                        }
                        if !database::is_read_only(&sql) {
                            return Err(ToolExecutionError::other(
                                "只允许只读查询（SELECT / WITH / SHOW / EXPLAIN 等），不允许写数据或改结构。",
                            ));
                        }

                        let session = tools.session().await.map_err(ToolExecutionError::other)?;
                        let stripped = database::strip_sql(&sql);
                        let class = database::classify_sql(&stripped);
                        let result =
                            database::run_query(&session, &stripped, class, 0, MAX_AGENT_ROWS).await.map_err(ToolExecutionError::other)?;

                        // RowsSingle（SHOW / EXPLAIN 之类）不分页，自己再截一刀
                        let mut rows = result.rows;
                        let truncated = rows.len() > MAX_AGENT_ROWS as usize;
                        if truncated {
                            rows.truncate(MAX_AGENT_ROWS as usize);
                        }
                        to_text(&json!({
                            "columns": result.columns,
                            "rows": rows,
                            "rowCount": rows.len(),
                            "hasMore": result.has_more || truncated,
                        }))
                    })
                }
            },
        ),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ColumnInfo {
    name: String,
    data_type: String,
    nullable: bool,
    primary_key: bool,
}

/// 一张表的列信息。三库各走自己的元数据表。
async fn columns_of(
    session: &DbSession,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, ToolExecutionError> {
    match &session.pool {
        DbPool::Mysql(pool) => {
            // 建连时没指定默认库的话 DATABASE() 是 NULL，用 COALESCE 兜住
            let rows = sqlx::query(
                "SELECT column_name, column_type, is_nullable, column_key \
                 FROM information_schema.columns \
                 WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? \
                 ORDER BY ordinal_position",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(pool)
            .await
            .map_err(|e| ToolExecutionError::other(e.to_string()))?;
            Ok(rows
                .iter()
                .map(|row| {
                    let nullable: String = row.try_get(2).unwrap_or_default();
                    let key: String = row.try_get(3).unwrap_or_default();
                    ColumnInfo {
                        name: row.try_get(0).unwrap_or_default(),
                        data_type: row.try_get(1).unwrap_or_default(),
                        nullable: nullable.eq_ignore_ascii_case("YES"),
                        primary_key: key.eq_ignore_ascii_case("PRI"),
                    }
                })
                .collect())
        }
        DbPool::Postgres(pool) => {
            // 走 pg_catalog：一次就能拿到类型与主键（information_schema 要再联一次约束表）
            let rows = sqlx::query(
                "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                        COALESCE(i.indisprimary, false) \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_index i \
                   ON i.indrelid = c.oid AND a.attnum = ANY(i.indkey) AND i.indisprimary \
                 WHERE c.relname = $1 AND n.nspname = COALESCE(NULLIF($2, ''), 'public') \
                   AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
            )
            .bind(table)
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(|e| ToolExecutionError::other(e.to_string()))?;
            Ok(rows
                .iter()
                .map(|row| ColumnInfo {
                    name: row.try_get(0).unwrap_or_default(),
                    data_type: row.try_get(1).unwrap_or_default(),
                    nullable: row.try_get::<bool, _>(2).unwrap_or(true),
                    primary_key: row.try_get::<bool, _>(3).unwrap_or(false),
                })
                .collect())
        }
        DbPool::Sqlite(pool) => {
            // pragma_table_info 是表值函数，可以绑参数（schema 对 SQLite 没意义，忽略）
            let rows = sqlx::query("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?)")
                .bind(table)
                .fetch_all(pool)
                .await
                .map_err(|e| ToolExecutionError::other(e.to_string()))?;
            Ok(rows
                .iter()
                .map(|row| ColumnInfo {
                    name: row.try_get(0).unwrap_or_default(),
                    data_type: row.try_get(1).unwrap_or_default(),
                    nullable: row.try_get::<i64, _>(2).unwrap_or(0) == 0,
                    primary_key: row.try_get::<i64, _>(3).unwrap_or(0) != 0,
                })
                .collect())
        }
    }
}

fn to_text(value: &Value) -> Result<ToolOutput, ToolExecutionError> {
    Ok(ToolOutput::text(value.to_string()))
}

fn boxed<F>(future: F) -> WasmBoxedFuture<'static, Result<ToolOutput, ToolExecutionError>>
where
    F: std::future::Future<Output = Result<ToolOutput, ToolExecutionError>> + Send + 'static,
{
    Box::pin(future)
}
