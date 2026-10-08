import { invoke } from "@tauri-apps/api/core";
import { secretStatus, setSecret, type SecretStatus } from "./secrets";

/** 支持的数据库类型 */
export type DbKind = "mysql" | "postgres" | "sqlite";

export interface DbConnection {
  id: string;
  name: string;
  kind: DbKind;
  /** 网络库的主机地址；SQLite 忽略 */
  host: string;
  port: number;
  user: string;
  /** 网络库的数据库名；SQLite 忽略 */
  database: string;
  /** SQLite 的数据库文件路径（kind === "sqlite" 时有意义） */
  file: string;
  /** 钥匙串里存没存密码。localStorage 只留布尔位，正文留在后端 */
  hasPassword: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: "table" | "view";
}

export interface QueryResult {
  columns: string[];
  /** 单元格已渲染成字符串；null 表示 SQL NULL */
  rows: (string | null)[][];
  affected: number;
  kind: "rows" | "affected";
  hasMore: boolean;
  page: number;
  pageSize: number;
  elapsedMs: number;
}

/** 一个连接的连接状态，供列表上的状态点与错误提示用 */
export interface DbConnectionState {
  phase: "connecting" | "ready" | "error" | "closed";
  error?: string;
}

export const DB_CONNECTIONS_KEY = "codedock.dbConnections";

/** 连接列表变更时派发的本地事件，让同一窗口里的多个面板同步（跨窗口靠 storage 事件） */
export const DB_CONNECTIONS_EVENT = "codedock:db-connections";

export const DB_KINDS: DbKind[] = ["mysql", "postgres", "sqlite"];

export const DB_KIND_LABELS: Record<DbKind, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
};

export const DEFAULT_PORTS: Record<DbKind, number> = {
  mysql: 3306,
  postgres: 5432,
  sqlite: 0,
};

/**
 * 连接 id 只允许 slug：后端要把它拼进系统钥匙串的条目名（见 database.rs 的 valid_conn_id）。
 * 用时间戳 + 随机后缀，够唯一也够短。
 */
export function newConnectionId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function dbPasswordSecretId(connId: string): string {
  return `db:${connId}:password`;
}

function isKind(value: unknown): value is DbKind {
  return value === "mysql" || value === "postgres" || value === "sqlite";
}

/** 把一条来路不明的记录规整成 DbConnection；缺关键字段就丢掉 */
function asConnection(raw: unknown): DbConnection | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const kind = item.kind;
  if (!id || !isKind(kind)) return null;
  const rawPort =
    typeof item.port === "number" && Number.isFinite(item.port) ? Math.round(item.port) : 0;
  const host = typeof item.host === "string" ? item.host : "";
  const file = typeof item.file === "string" ? item.file : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  return {
    id,
    kind,
    name: name || host || file || DB_KIND_LABELS[kind],
    host,
    port: rawPort >= 1 && rawPort <= 65535 ? rawPort : DEFAULT_PORTS[kind],
    user: typeof item.user === "string" ? item.user : "",
    database: typeof item.database === "string" ? item.database : "",
    file,
    hasPassword: item.hasPassword === true,
  };
}

export function readConnections(): DbConnection[] {
  try {
    const raw = window.localStorage.getItem(DB_CONNECTIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(asConnection)
      .filter((conn): conn is DbConnection => conn !== null);
  } catch {
    return [];
  }
}

export function saveConnections(connections: DbConnection[]) {
  try {
    window.localStorage.setItem(DB_CONNECTIONS_KEY, JSON.stringify(connections));
  } catch {
    // 写不进去只影响下次启动，本次会话照常
  }
  // 同一窗口里的其它面板要立刻看到（storage 事件只在别的 document 触发）
  window.dispatchEvent(new Event(DB_CONNECTIONS_EVENT));
}

/** 建连（后端按 connId 从钥匙串取密码，前端不碰明文），返回会话 id */
export async function connectDb(connection: DbConnection): Promise<number> {
  const result = await invoke<{ sessionId: number }>("db_connect", {
    request: {
      connId: connection.id,
      kind: connection.kind,
      host: connection.host,
      port: connection.port,
      user: connection.user,
      database: connection.database,
      file: connection.file,
    },
  });
  return result.sessionId;
}

export function disconnectDb(id: number): Promise<void> {
  return invoke<void>("db_disconnect", { id });
}

/**
 * 试连一次就断开（不登记会话），用来在保存前验证参数。
 * `password` 传表单里刚敲的明文；留空则后端回退到钥匙串里已存的密码。
 */
export function testDbConnection(
  connId: string,
  fields: Pick<DbConnection, "kind" | "host" | "port" | "user" | "database" | "file">,
  password: string,
): Promise<void> {
  return invoke<void>("db_test_connection", {
    request: {
      connId,
      kind: fields.kind,
      host: fields.host,
      port: fields.port,
      user: fields.user,
      database: fields.database,
      file: fields.file,
      password: password || null,
    },
  });
}

/**
 * 「数据库」这一级：MySQL 是库，SQLite 只有 main，PostgreSQL 是实例里的库。
 * 界面在「连接」和「表」之间插这一层，免得连上就把一堆库的表全铺出来。
 */
export function dbDatabases(id: number): Promise<string[]> {
  return invoke<string[]>("db_databases", { id });
}

/** PG 专用：当前库里的 schema 列表（三级结构的中间那层）。其余库返回空数组 */
export function dbSchemas(id: number): Promise<string[]> {
  return invoke<string[]>("db_schemas", { id });
}

/** 某个命名空间（MySQL 是库名 / PG 是 schema 名）下的表 / 视图；省略则退回全部 */
export function dbTables(id: number, schema?: string): Promise<TableInfo[]> {
  return invoke<TableInfo[]>("db_tables", { id, schema: schema ?? null });
}

export function dbQuery(
  id: number,
  sql: string,
  page: number,
  pageSize: number,
): Promise<QueryResult> {
  return invoke<QueryResult>("db_query", { id, sql, page, pageSize });
}

/** 导出格式 */
export type DbExportFormat = "csv" | "xlsx";
/** 导出范围：当前页 / 全部（整条语句的所有行） */
export type DbExportScope = "page" | "all";

export interface DbExportResult {
  /** 实际写出的文件路径 */
  path: string;
  /** 写出的数据行数（不含表头） */
  rows: number;
  /** 是否因超过行数上限被截断 */
  truncated: boolean;
}

/**
 * 把查询结果导出成文件。取数与写盘都在后端完成（前端只用系统对话框选路径），
 * 且导出**不做单元格截断**——见 database.rs 的 db_export。
 */
export function dbExport(request: {
  id: number;
  sql: string;
  format: DbExportFormat;
  path: string;
  scope: DbExportScope;
  page: number;
  pageSize: number;
  /** 标题（表名 / "query"）：后端拿它当 Excel 工作表名 */
  title: string;
}): Promise<DbExportResult> {
  return invoke<DbExportResult>("db_export", { request });
}

/** 默认文件名用：清掉路径分隔符与各平台非法字符、去掉开头的点，空则给兜底名 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "export";
}

/** `yyyyMMdd-HHmmss`：给默认文件名加上，避免重复导出时同名覆盖 */
export function fileTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 保存对话框的默认文件名：标题 + 时间戳 + 扩展名 */
export function defaultExportName(title: string, format: DbExportFormat): string {
  return `${sanitizeFileName(title)}-${fileTimestamp()}.${format}`;
}

/** 写密码进系统钥匙串。空串按删除处理（清空输入框 = 不想留了） */
export function setDbPassword(connId: string, password: string): Promise<void> {
  return setSecret(dbPasswordSecretId(connId), password);
}

/** 删连接时把它的凭据一起清掉，否则条目会一直留在系统里没人认领 */
export function clearDbSecrets(connId: string): Promise<unknown> {
  return setDbPassword(connId, "");
}

/**
 * 查这个连接在钥匙串里到底存没存密码。localStorage 里的布尔位可能过期
 * （用户可能在系统设置里把条目删了），以这边为准。
 */
export async function dbSecretPresence(
  connId: string,
): Promise<{ hasPassword: boolean; storeError: string }> {
  const id = dbPasswordSecretId(connId);
  const status: SecretStatus = await secretStatus([id]);
  return { hasPassword: status.available.includes(id), storeError: status.storeError };
}

/** 按库的规则给标识符加引号：MySQL 用反引号，PG / SQLite 用双引号 */
export function quoteIdent(kind: DbKind, name: string): string {
  if (kind === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 限定 schema 的表名。SQLite 的 main 不必写出来 */
export function quoteQualified(kind: DbKind, schema: string, name: string): string {
  if (kind === "sqlite" || !schema || schema === "main") return quoteIdent(kind, name);
  return `${quoteIdent(kind, schema)}.${quoteIdent(kind, name)}`;
}

/** 点某个表时的预览语句，翻页交给后端包一层 */
export function selectAllSql(kind: DbKind, table: TableInfo): string {
  return `SELECT * FROM ${quoteQualified(kind, table.schema, table.name)}`;
}

/** 连接列表里的副标题 */
export function connectionSummary(connection: DbConnection): string {
  if (connection.kind === "sqlite") {
    const parts = connection.file.split(/[\\/]/);
    return parts[parts.length - 1] || connection.file;
  }
  const db = connection.database ? `/${connection.database}` : "";
  return `${connection.user ? `${connection.user}@` : ""}${connection.host}:${connection.port}${db}`;
}
