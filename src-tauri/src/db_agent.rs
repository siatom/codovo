//! 数据库 Agent 的 MCP 工具服务（stdio 传输）。
//!
//! opencode 通过 `opencode.json` 的 `mcp.db` 拉起它（`codedock.exe --mcp-db`），
//! 走标准 MCP stdio 协议（换行分隔的 JSON-RPC 2.0）。它是**独立进程**，拿不到主进程的
//! `DbState`——「当前连接」由主进程写的 target.json 同步（`db_agent_set_target`），
//! 密码仍按 connId 从系统钥匙串取。
//!
//! 只读是硬约束，三层：工具描述与技能引导 → `database::is_read_only` 语句白名单 →
//! 建池时给每条连接设只读（`create_pool` 的 `read_only`）。
//!
//! `initialize` 阶段绝不连库（否则 opencode 默认 5s 的握手超时会把工具判成不可用），
//! 连库只发生在 `tools/call`。

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::Row;
use tauri::Manager;

use crate::database::{self, DbConnectRequest, DbPool, DbSession};

/// 客户端没给 protocolVersion 时的兜底版本。
const DEFAULT_PROTOCOL: &str = "2025-06-18";

/// 单次查询最多回给模型的行数。再多既占 context 也没人看。
const MAX_AGENT_ROWS: u32 = 200;

// ---- target 文件（主进程写、MCP 子进程读）----

/// 数据库 Agent 的目标连接文件路径。刻意放在 opencode 配置目录**之外**：
/// 那个目录在停服务时会被整个 `remove_dir_all` 掉，放里面会被连带删掉。
pub(crate) fn target_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| format!("拿不到配置目录: {e}"))?
        .join("db-agent")
        .join("target.json"))
}

/// 记录数据库 Agent 当前面向哪个连接。前端在切换 / 连接 / 断开时调用。
/// 不含密码（密码只在系统钥匙串里），写文件走「临时文件 + rename」原子替换，
/// 免得 MCP 子进程正好读到半截内容。
#[tauri::command]
pub fn db_agent_set_target(
    app: tauri::AppHandle,
    request: DbConnectRequest,
) -> Result<(), String> {
    let path = target_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let text = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写入失败: {e}"))?;
    Ok(())
}

// ---- MCP stdio server ----

/// MCP server 入口。由 `main()` 在 Tauri 初始化之前调用，返回进程退出码。
pub fn run_stdio() -> i32 {
    let target = std::env::var("CODEDOCK_DB_TARGET")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("db-mcp: 创建运行时失败: {error}");
            return 1;
        }
    };
    runtime.block_on(serve(target))
}

async fn serve(target: Option<PathBuf>) -> i32 {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut conn = ConnCache::new(target);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return 0, // 对端关了 stdin
            Ok(_) => {}
            Err(error) => {
                eprintln!("db-mcp: 读 stdin 失败: {error}");
                return 1;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("db-mcp: 解析请求失败: {error}");
                continue;
            }
        };
        let Some(response) = handle(&mut conn, request).await else {
            continue;
        };
        let text = match serde_json::to_string(&response) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("db-mcp: 序列化响应失败: {error}");
                continue;
            }
        };
        if writeln!(out, "{text}").and_then(|_| out.flush()).is_err() {
            return 1;
        }
    }
}

/// 处理一条 JSON-RPC 请求；通知（没有 id）返回 None（不回响应）。
async fn handle(conn: &mut ConnCache, request: Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");

    match method {
        "initialize" => {
            let protocol = request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL);
            let result = json!({
                "protocolVersion": protocol,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "codedock-db", "version": env!("CARGO_PKG_VERSION") },
            });
            Some(ok_response(id, result))
        }
        "notifications/initialized" => None,
        "ping" => Some(ok_response(id, json!({}))),
        "tools/list" => Some(ok_response(id, json!({ "tools": tool_definitions() }))),
        "tools/call" => {
            let outcome = call_tool(conn, &request).await;
            let result = match outcome {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(message) => json!({
                    "content": [{ "type": "text", "text": format!("错误：{message}") }],
                    "isError": true,
                }),
            };
            Some(ok_response(id, result))
        }
        other => {
            // 未知方法：有 id 就回 error，没有就当通知忽略
            id.map(|id| error_response(id, -32601, &format!("未知方法: {other}")))
        }
    }
}

fn ok_response(id: Option<Value>, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

/// 工具清单。名字在 opencode 侧会带上 server 前缀（`db_`），描述里点明只读。
fn tool_definitions() -> Value {
    json!([
        {
            "name": "list_tables",
            "description": "列出当前数据库连接里的所有表与视图（只读）。不确定表名时先调它。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "name": "describe_table",
            "description": "查看一张表的列（名称、类型、是否可空、是否主键），只读。写 SQL 前用它确认字段。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "table": { "type": "string", "description": "表名" },
                    "schema": { "type": "string", "description": "schema 名，可省略" }
                },
                "required": ["table"],
                "additionalProperties": false
            }
        },
        {
            "name": "run_query",
            "description": "执行一条只读 SQL（SELECT / WITH / SHOW / EXPLAIN 等）并返回结果行。禁止任何写操作与 DDL。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "只读 SQL 语句" }
                },
                "required": ["sql"],
                "additionalProperties": false
            }
        }
    ])
}

async fn call_tool(conn: &mut ConnCache, request: &Value) -> Result<String, String> {
    let name = request
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = request
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    match name {
        "list_tables" => list_tables(conn).await,
        "describe_table" => describe_table(conn, &args).await,
        "run_query" => run_query(conn, &args).await,
        other => Err(format!("未知工具: {other}")),
    }
}

async fn list_tables(conn: &mut ConnCache) -> Result<String, String> {
    let session = conn.session().await?;
    // database 传 None：列出该连接可见的全部表，让模型自己挑
    let tables = database::tables_of(&session, None).await?;
    serde_json::to_string(&json!({ "tables": tables })).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ColumnInfo {
    name: String,
    data_type: String,
    nullable: bool,
    primary_key: bool,
}

async fn describe_table(conn: &mut ConnCache, args: &Value) -> Result<String, String> {
    let table = args
        .get("table")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if table.is_empty() {
        return Err("缺少 table 参数".to_string());
    }
    let schema = args
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();

    let session = conn.session().await?;
    let columns = columns_of(&session, schema, table).await?;
    serde_json::to_string(&json!({ "table": table, "columns": columns })).map_err(|e| e.to_string())
}

async fn columns_of(
    session: &DbSession,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
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
            .map_err(|e| e.to_string())?;
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
            .map_err(|e| e.to_string())?;
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
                .map_err(|e| e.to_string())?;
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

async fn run_query(conn: &mut ConnCache, args: &Value) -> Result<String, String> {
    let sql = args
        .get("sql")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if sql.is_empty() {
        return Err("缺少 sql 参数".to_string());
    }
    if !database::is_read_only(sql) {
        return Err(
            "只允许只读查询（SELECT / WITH / SHOW / EXPLAIN 等），不允许写数据或改结构。".to_string(),
        );
    }

    let session = conn.session().await?;
    let stripped = database::strip_sql(sql);
    let class = database::classify_sql(&stripped);
    let result = database::run_query(&session, &stripped, class, 0, MAX_AGENT_ROWS).await?;

    // RowsSingle（SHOW / EXPLAIN 之类）不分页，自己再截一刀
    let mut rows = result.rows;
    let truncated = rows.len() > MAX_AGENT_ROWS as usize;
    if truncated {
        rows.truncate(MAX_AGENT_ROWS as usize);
    }

    serde_json::to_string(&json!({
        "columns": result.columns,
        "rows": rows,
        "rowCount": rows.len(),
        "hasMore": result.has_more || truncated,
    }))
    .map_err(|e| e.to_string())
}

// ---- 连接缓存 ----

/// 按 target.json 里的连接参数建只读池；参数没变就复用上一次的池，
/// 免得每次工具调用都重连（远程库建连一次要几百毫秒）。
struct ConnCache {
    target_path: Option<PathBuf>,
    /// 上一次建池用的 target 序列化结果；变了就重建
    key: String,
    session: Option<Arc<DbSession>>,
}

impl ConnCache {
    fn new(target_path: Option<PathBuf>) -> Self {
        Self {
            target_path,
            key: String::new(),
            session: None,
        }
    }

    async fn session(&mut self) -> Result<Arc<DbSession>, String> {
        let path = self
            .target_path
            .as_ref()
            .ok_or("没有配置数据库目标连接")?;
        let text = std::fs::read_to_string(path)
            .map_err(|_| "还没有选择数据库连接，请在数据库面板里选一个".to_string())?;
        let target: DbConnectRequest =
            serde_json::from_str(&text).map_err(|e| format!("读取目标连接失败: {e}"))?;

        let key = serde_json::to_string(&target).map_err(|e| e.to_string())?;
        if key == self.key {
            if let Some(session) = &self.session {
                return Ok(Arc::clone(session));
            }
        }

        // 换库了：先收掉旧池
        if let Some(old) = self.session.take() {
            old.pool.close().await;
        }

        // 钥匙串读取是同步阻塞调用，别让它跨 await
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

        let session = Arc::new(DbSession { pool });
        self.key = key;
        self.session = Some(Arc::clone(&session));
        Ok(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_are_read_only_shaped() {
        let tools = tool_definitions();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["list_tables", "describe_table", "run_query"]);
        // run_query 必须要求 sql 参数
        let run = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "run_query")
            .unwrap();
        assert_eq!(run["inputSchema"]["required"][0], "sql");
    }

    #[test]
    fn responses_carry_the_right_envelope() {
        let ok = ok_response(Some(json!(1)), json!({ "a": 1 }));
        assert_eq!(ok["jsonrpc"], "2.0");
        assert_eq!(ok["id"], 1);
        assert_eq!(ok["result"]["a"], 1);

        let err = error_response(json!(2), -32601, "nope");
        assert_eq!(err["id"], 2);
        assert_eq!(err["error"]["code"], -32601);
    }
}
