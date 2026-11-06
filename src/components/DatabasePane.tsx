import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { DatabaseAgent } from "./DatabaseAgent";
import { DatabaseConnectionDialog } from "./DatabaseConnectionDialog";
import { DatabaseQuery } from "./DatabaseQuery";
import { FullscreenButton } from "./FullscreenButton";
import { ResultGrid } from "./ResultGrid";
import { TableStructure } from "./TableStructure";
import { useDbConnections } from "../lib/db-connections";
import {
  clearDbSecrets,
  connectDb,
  connectionSummary,
  dbDatabases,
  dbExport,
  dbQuery,
  dbSchemas,
  dbTables,
  defaultExportName,
  disconnectDb,
  selectAllSql,
  type DbConnection,
  type DbExportFormat,
  type DbExportScope,
  type QueryResult,
  type TableInfo,
} from "../lib/database";
import {
  IconChevronDown,
  IconChevronRight,
  IconDatabase,
  IconMore,
  IconPlus,
} from "./icons";

const ACTIVE_KEY = "codovo.dbActiveConnection";
const TAB_KEY = "codovo.dbTab";

const PAGE_SIZE = 50;

type SubTab = "tables" | "query" | "agent";

function readSession(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeSession(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 记不住只影响下次打开时的还原，不影响使用
  }
}

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

const SEGMENT = "rounded px-2 py-0.5 text-[11px]";

const MENU_ITEM =
  "flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

const ROW = "group flex cursor-default items-center gap-1 rounded-md py-[3px] pr-1.5 hover:bg-hover";

/** 每层缩进 16px：连接 → 库 →（PG 才有 schema）→ 表/视图分组 → 表项 */
const INDENT = [6, 22, 38, 54, 70];

const SEP = "\u0000";

const connNode = (connId: string) => `c:${connId}`;
const dbNode = (connId: string, db: string) => `d:${connId}${SEP}${db}`;
const schemaNode = (connId: string, db: string, schema: string) =>
  `s:${connId}${SEP}${db}${SEP}${schema}`;

/**
 * 「表」/「视图」两个分组文件夹。缩进层级比容器节点（库或 schema）深一层，
 * 所以钥匙直接借用容器节点 key 的后半段，只换个前缀——`belongsTo` 靠前缀认连接。
 */
const groupNode = (prefix: "t" | "v", containerKey: string) =>
  `${prefix}:${containerKey.slice(2)}`;

/**
 * PG 一个连接只能连一个库、不能跨库查询，所以树里每展开一个库都要单独一条会话
 * （建会话时按库名覆盖 `database`）；MySQL / SQLite 一条会话够用，库只是查询维度。
 */
function sessionKeyOf(connection: DbConnection, db?: string): string {
  return connection.kind === "postgres" && db ? `${connection.id}${SEP}${db}` : connection.id;
}

/** 某个节点 key（或会话 key）是否属于这个连接——断开时按它整片清掉 */
function belongsTo(key: string, connId: string): boolean {
  const rest = /^[cdstv]:/.test(key) ? key.slice(2) : key;
  return rest === connId || rest.startsWith(`${connId}${SEP}`);
}

function dropConn<T>(map: Record<string, T>, connId: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!belongsTo(key, connId)) next[key] = value;
  }
  return next;
}

/** 会话状态。key 见 `sessionKeyOf` */
interface SessionState {
  id?: number;
  phase: "connecting" | "ready" | "error";
  error?: string;
}

/** 状态点配色 */
function sessionDot(state: SessionState | undefined): string {
  switch (state?.phase) {
    case "connecting":
      return "bg-warn animate-pulse";
    case "ready":
      return "bg-accent";
    case "error":
      return "bg-danger";
    default:
      return "bg-fg-faint";
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-faint">
      {open ? <IconChevronDown className="h-3 w-3" /> : <IconChevronRight className="h-3 w-3" />}
    </span>
  );
}

function NodeHint({ text, danger }: { text: string; danger?: boolean }) {
  return (
    <p
      className={`px-3 py-1 text-[10px] leading-relaxed ${danger ? "text-danger" : "text-fg-faint"}`}
    >
      {text}
    </p>
  );
}

/**
 * 右栏「数据库」模块：左栏是一棵「连接 → 数据库 →（PG 才有 schema）→ 表/视图分组 → 条目」的树，
 * 右侧是选中表的数据 / SQL 查询 / 数据库 Agent 三个子视图。
 *
 * 面板独占编辑器那一列（和浏览器 / 远程连接同款）。会话按需建立：展开哪个节点连哪个，
 * 连上后留在后端池里，切走不杀。
 */
export function DatabasePane({
  fullscreen,
  onToggleFullscreen,
  sidebarTarget,
  onOpenContent,
}: {
  sidebarTarget?: HTMLElement | null;
  onOpenContent: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { connections, addConnection, updateConnection, removeConnection } = useDbConnections();
  // 回调里要读最新的列表 / 会话（连接成功回报时），用 ref 免得闭包读到旧值
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const [activeConnectionId, setActiveConnectionId] = useState<string>(() =>
    readSession(ACTIVE_KEY),
  );
  const [subTab, setSubTab] = useState<SubTab>(() => {
    const saved = readSession(TAB_KEY);
    return saved === "query" || saved === "agent" ? saved : "tables";
  });

  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  /** connId → 库列表 */
  const [databases, setDatabases] = useState<Record<string, string[]>>({});
  const databasesRef = useRef(databases);
  databasesRef.current = databases;
  /** 库节点 key → schema 列表（仅 PG） */
  const [schemas, setSchemas] = useState<Record<string, string[]>>({});
  const schemasRef = useRef(schemas);
  schemasRef.current = schemas;
  /** 库 / schema 节点 key → 表列表 */
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  /** 节点 key → 正在加载 */
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  /** 节点 key → 错误 */
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});

  const [selected, setSelected] = useState<{
    sessionKey: string;
    connectionId: string;
    table: TableInfo;
  } | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [queryError, setQueryError] = useState("");
  /** 「表格」子视图内的数据 / 结构切换。默认落在数据，不改变原来的点表看数据行为 */
  const [tableView, setTableView] = useState<"data" | "structure">("data");

  const [dialog, setDialog] = useState<{ connection: DbConnection | null } | null>(null);
  const [menu, setMenu] = useState<{ connection: DbConnection; x: number; y: number } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<DbConnection | null>(null);
  /** 表节点右键菜单：位置 + 目标表（按整表导出） */
  const [tableMenu, setTableMenu] = useState<{
    sessionKey: string;
    connectionId: string;
    table: TableInfo;
    x: number;
    y: number;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  /** 导出结果提示（成功行数 / 失败原因） */
  const [exportNotice, setExportNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const activeConnection = useMemo(
    () => connections.find((item) => item.id === activeConnectionId) ?? null,
    [connections, activeConnectionId],
  );
  const activeSessionId = activeConnection ? sessions[activeConnection.id]?.id : undefined;
  const activeState = activeConnection ? sessions[activeConnection.id] : undefined;

  const pickTab = useCallback((next: SubTab) => {
    setSubTab(next);
    writeSession(TAB_KEY, next);
  }, []);

  /** 拿到一条可用会话；没有就现建。`db` 只对 PG 有意义（按库名另开一条） */
  const ensureSession = useCallback(
    async (key: string, connection: DbConnection, db?: string): Promise<number | null> => {
      const existing = sessionsRef.current[key];
      if (existing?.phase === "ready" && existing.id !== undefined) return existing.id;
      if (existing?.phase === "connecting") return null;
      setSessions((current) => ({ ...current, [key]: { phase: "connecting" } }));
      try {
        const id = await connectDb(db ? { ...connection, database: db } : connection);
        setSessions((current) => ({ ...current, [key]: { id, phase: "ready" } }));
        return id;
      } catch (reason) {
        setSessions((current) => ({
          ...current,
          [key]: { phase: "error", error: String(reason) },
        }));
        return null;
      }
    },
    [],
  );

  const toggleSchema = useCallback(
    async (connection: DbConnection, db: string, schema: string) => {
      const key = schemaNode(connection.id, db, schema);
      if (expandedRef.current[key]) {
        setExpanded((current) => ({ ...current, [key]: false }));
        return;
      }
      setExpanded((current) => ({ ...current, [key]: true }));
      if (tablesRef.current[key]) return;

      setBusy((current) => ({ ...current, [key]: true }));
      const id = await ensureSession(sessionKeyOf(connection, db), connection, db);
      if (id === null) {
        setBusy((current) => ({ ...current, [key]: false }));
        return;
      }
      try {
        const list = await dbTables(id, schema);
        setTables((current) => ({ ...current, [key]: list }));
      } catch (reason) {
        setNodeErrors((current) => ({ ...current, [key]: String(reason) }));
      } finally {
        setBusy((current) => ({ ...current, [key]: false }));
      }
    },
    [ensureSession],
  );

  const toggleDatabase = useCallback(
    async (connection: DbConnection, db: string) => {
      const key = dbNode(connection.id, db);
      if (expandedRef.current[key]) {
        setExpanded((current) => ({ ...current, [key]: false }));
        return;
      }
      setExpanded((current) => ({ ...current, [key]: true }));
      if (schemasRef.current[key] || tablesRef.current[key]) return;

      setBusy((current) => ({ ...current, [key]: true }));
      const id = await ensureSession(sessionKeyOf(connection, db), connection, db);
      if (id === null) {
        setBusy((current) => ({ ...current, [key]: false }));
        return;
      }
      try {
        if (connection.kind === "postgres") {
          const list = await dbSchemas(id);
          setSchemas((current) => ({ ...current, [key]: list }));
        } else {
          const list = await dbTables(id, db);
          setTables((current) => ({ ...current, [key]: list }));
        }
      } catch (reason) {
        setNodeErrors((current) => ({ ...current, [key]: String(reason) }));
      } finally {
        setBusy((current) => ({ ...current, [key]: false }));
      }
    },
    [ensureSession],
  );

  const toggleConnection = useCallback(
    async (connection: DbConnection) => {
      const key = connNode(connection.id);
      setActiveConnectionId(connection.id);
      writeSession(ACTIVE_KEY, connection.id);
      if (expandedRef.current[key]) {
        setExpanded((current) => ({ ...current, [key]: false }));
        return;
      }
      setExpanded((current) => ({ ...current, [key]: true }));
      if (databasesRef.current[connection.id]) return;

      setBusy((current) => ({ ...current, [key]: true }));
      const id = await ensureSession(connection.id, connection);
      if (id === null) {
        setBusy((current) => ({ ...current, [key]: false }));
        return;
      }
      try {
        const list = await dbDatabases(id);
        setDatabases((current) => ({ ...current, [connection.id]: list }));
        // 建连时填过库名就直接展开它，省一次点击
        if (connection.database && list.includes(connection.database)) {
          void toggleDatabase(connection, connection.database);
        }
      } catch (reason) {
        setNodeErrors((current) => ({ ...current, [key]: String(reason) }));
      } finally {
        setBusy((current) => ({ ...current, [key]: false }));
      }
    },
    [ensureSession, toggleDatabase],
  );

  const loadRows = useCallback(
    async (sessionKey: string, connectionId: string, table: TableInfo, page: number) => {
      const connection = connectionsRef.current.find((item) => item.id === connectionId);
      const id = sessionsRef.current[sessionKey]?.id;
      if (!connection || id === undefined) return;
      setLoadingRows(true);
      setQueryError("");
      try {
        setResult(await dbQuery(id, selectAllSql(connection.kind, table), page, PAGE_SIZE));
      } catch (reason) {
        setQueryError(String(reason));
        setResult(null);
      } finally {
        setLoadingRows(false);
      }
    },
    [],
  );

  const openTable = useCallback(
    (sessionKey: string, connectionId: string, table: TableInfo) => {
      onOpenContent();
      setSelected({ sessionKey, connectionId, table });
      setExportNotice(null);
      pickTab("tables");
      // 点表仍旧先看数据（和改动前一致）；要看结构再切
      setTableView("data");
      void loadRows(sessionKey, connectionId, table, 0);
    },
    [loadRows, onOpenContent, pickTab],
  );

  /**
   * 导出：系统保存对话框选路径 → 后端取数并写盘。两个入口（结果区、表节点右键）共用。
   * `page`/`pageSize` 只在范围是「当前页」时有意义，整表导出固定传 scope=all。
   */
  const runExport = useCallback(
    async (
      sessionId: number,
      sql: string,
      title: string,
      format: DbExportFormat,
      scope: DbExportScope,
      page: number,
      pageSize: number,
    ) => {
      setExporting(true);
      setExportNotice(null);
      try {
        const path = await save({
          title: "导出数据",
          defaultPath: defaultExportName(title, format),
          filters: [{ name: format === "csv" ? "CSV 文件" : "Excel 工作簿", extensions: [format] }],
        });
        if (!path) return; // 用户取消
        const out = await dbExport({ id: sessionId, sql, format, path, scope, page, pageSize, title });
        setExportNotice({
          ok: true,
          text: `已导出 ${out.rows} 行${out.truncated ? "（超过上限，已截断）" : ""}`,
        });
      } catch (reason) {
        setExportNotice({ ok: false, text: String(reason) });
      } finally {
        setExporting(false);
      }
    },
    [],
  );

  /** 表节点右键选「导出为 CSV / Excel」：整表导出（范围固定为全部） */
  const exportTableNode = useCallback(
    (format: DbExportFormat) => {
      if (!tableMenu) return;
      const { sessionKey, connectionId, table } = tableMenu;
      setTableMenu(null);
      const id = sessionsRef.current[sessionKey]?.id;
      const connection = connectionsRef.current.find((item) => item.id === connectionId);
      if (id === undefined || !connection) {
        setExportNotice({ ok: false, text: "连接已断开，无法导出" });
        return;
      }
      void runExport(id, selectAllSql(connection.kind, table), table.name, format, "all", 0, PAGE_SIZE);
    },
    [tableMenu, runExport],
  );

  /** 断开一条连接：把它名下的会话（PG 每个库一条）、树数据、展开态一起清掉 */
  const disconnect = useCallback((connectionId: string) => {
    const keys = Object.keys(sessionsRef.current).filter((key) => belongsTo(key, connectionId));
    for (const key of keys) {
      const id = sessionsRef.current[key]?.id;
      if (id !== undefined) void disconnectDb(id).catch(() => {});
    }
    setSessions((current) => dropConn(current, connectionId));
    setDatabases((current) => dropConn(current, connectionId));
    setSchemas((current) => dropConn(current, connectionId));
    setTables((current) => dropConn(current, connectionId));
    setBusy((current) => dropConn(current, connectionId));
    setNodeErrors((current) => dropConn(current, connectionId));
    setExpanded((current) => dropConn(current, connectionId));
    setSelected(null);
    setResult(null);
    setQueryError("");
  }, []);

  const saveConnection = useCallback(
    (connection: DbConnection) => {
      const exists = connectionsRef.current.some((item) => item.id === connection.id);
      if (exists) updateConnection(connection);
      else addConnection(connection);
      setDialog(null);
      setActiveConnectionId(connection.id);
      writeSession(ACTIVE_KEY, connection.id);
      // 改过连接参数就重连一次，别让旧会话继续用旧配置
      if (sessionsRef.current[connection.id]) {
        disconnect(connection.id);
        void toggleConnection(connection);
      }
    },
    [addConnection, updateConnection, toggleConnection, disconnect],
  );

  const deleteConnection = useCallback(
    (connection: DbConnection) => {
      disconnect(connection.id);
      removeConnection(connection.id);
      setMenu(null);
      setActiveConnectionId((current) => (current === connection.id ? "" : current));
      // 清钥匙串是顺带做的，失败也不该把连接留在列表里（大不了留个孤儿条目）
      void clearDbSecrets(connection.id).catch(() => {});
    },
    [disconnect, removeConnection],
  );

  const openMenu = (event: ReactMouseEvent, connection: DbConnection) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ connection, x: rect.right, y: rect.bottom + 4 });
  };

  const isOpen = (key: string) => expanded[key] === true;

  const toggleGroup = (key: string) => {
    setExpanded((current) => ({ ...current, [key]: !current[key] }));
  };

  const tableRow = (
    sessionKey: string,
    connectionId: string,
    table: TableInfo,
    indent: number,
  ) => {
    const active =
      selected?.sessionKey === sessionKey &&
      selected?.table.name === table.name &&
      selected?.table.schema === table.schema;
    return (
      <div
        key={`${sessionKey}${SEP}${table.schema}${SEP}${table.name}`}
        onClick={() => openTable(sessionKey, connectionId, table)}
        onContextMenu={(event) => {
          // 应用全局屏蔽了原生右键菜单，这里自己声明一个（见 main.tsx）
          event.preventDefault();
          setTableMenu({ sessionKey, connectionId, table, x: event.clientX, y: event.clientY });
        }}
        className={`${ROW} ${active ? "bg-selected" : ""}`}
        style={{ paddingLeft: indent }}
        title={table.name}
      >
        <span className="w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{table.name}</span>
      </div>
    );
  };

  /**
   * 一个容器节点（库或 schema）下的「表」「视图」两个分组文件夹。
   * 视图跟表分开放，各自可折叠，点开才是具体条目。
   */
  const groupFolders = (
    containerKey: string,
    sessionKey: string,
    connectionId: string,
    groupIndent: number,
    itemIndent: number,
  ) => {
    const list = tables[containerKey] ?? [];
    const groups = [
      { prefix: "t" as const, label: "表", kind: "table" as const },
      { prefix: "v" as const, label: "视图", kind: "view" as const },
    ];
    return groups.map(({ prefix, label, kind }) => {
      const key = groupNode(prefix, containerKey);
      const open = isOpen(key);
      const items = list.filter((item) => item.kind === kind);
      return (
        <div key={key}>
          <div
            onClick={() => toggleGroup(key)}
            className={ROW}
            style={{ paddingLeft: groupIndent }}
            title={label}
          >
            <Chevron open={open} />
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{label}</span>
            <span className="shrink-0 text-[10px] text-fg-faint">{items.length}</span>
          </div>
          {open && items.map((item) => tableRow(sessionKey, connectionId, item, itemIndent))}
        </div>
      );
    });
  };

  const connectionTree = (
      <div className="flex h-full w-full min-w-0 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim">
            数据库
          </span>
          <button
            type="button"
            onClick={() => setDialog({ connection: null })}
            title="新增连接"
            className={HEAD_BUTTON}
          >
            <IconPlus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {connections.length === 0 ? (
            <p className="px-3 py-2 text-[11px] leading-relaxed text-fg-faint">
              还没有连接。点右上角 + 添加一个。
            </p>
          ) : (
            connections.map((connection) => {
              const ck = connNode(connection.id);
              const open = isOpen(ck);
              const session = sessions[connection.id];
              const list = databases[connection.id];
              return (
                <div key={connection.id}>
                  <div
                    onClick={() => void toggleConnection(connection)}
                    className={`${ROW} ${connection.id === activeConnectionId ? "bg-selected" : ""}`}
                    style={{ paddingLeft: INDENT[0] }}
                  >
                    <Chevron open={open} />
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionDot(session)}`}
                      title={session?.error}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-fg">{connection.name}</span>
                      <span className="block truncate text-[10px] text-fg-faint">
                        {connectionSummary(connection)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={(event) => openMenu(event, connection)}
                      title="更多"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100"
                    >
                      <IconMore className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {open && (
                    <>
                      {busy[ck] && <NodeHint text="连接中…" />}
                      {nodeErrors[ck] && <NodeHint text={nodeErrors[ck]} danger />}
                      {list?.map((db) => {
                        const dk = dbNode(connection.id, db);
                        const dbOpen = isOpen(dk);
                        return (
                          <div key={dk}>
                            <div
                              onClick={() => void toggleDatabase(connection, db)}
                              className={ROW}
                              style={{ paddingLeft: INDENT[1] }}
                              title={db}
                            >
                              <Chevron open={dbOpen} />
                              <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                                {db}
                              </span>
                            </div>
                            {dbOpen && (
                              <>
                                {busy[dk] && <NodeHint text="加载中…" />}
                                {nodeErrors[dk] && <NodeHint text={nodeErrors[dk]} danger />}
                                {connection.kind === "postgres"
                                  ? schemas[dk]?.map((schema) => {
                                      const sk = schemaNode(connection.id, db, schema);
                                      const schemaOpen = isOpen(sk);
                                      return (
                                        <div key={sk}>
                                          <div
                                            onClick={() =>
                                              void toggleSchema(connection, db, schema)
                                            }
                                            className={ROW}
                                            style={{ paddingLeft: INDENT[2] }}
                                            title={schema}
                                          >
                                            <Chevron open={schemaOpen} />
                                            <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                                              {schema}
                                            </span>
                                          </div>
                                          {schemaOpen && (
                                            <>
                                              {busy[sk] && <NodeHint text="加载中…" />}
                                              {nodeErrors[sk] && (
                                                <NodeHint text={nodeErrors[sk]} danger />
                                              )}
                                              {tables[sk]
                                                ? groupFolders(
                                                    sk,
                                                    `${connection.id}${SEP}${db}`,
                                                    connection.id,
                                                    INDENT[3],
                                                    INDENT[4],
                                                  )
                                                : null}
                                            </>
                                          )}
                                        </div>
                                      );
                                    })
                                  : tables[dk]
                                    ? groupFolders(
                                        dk,
                                        connection.id,
                                        connection.id,
                                        INDENT[2],
                                        INDENT[3],
                                      )
                                    : null}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 bg-content">
      {/* 左栏：连接 → 数据库 →（PG 才有 schema）→ 表/视图分组 → 条目 */}
      {sidebarTarget !== undefined
        ? sidebarTarget
          ? createPortal(connectionTree, sidebarTarget)
          : null
        : connectionTree}

      {/* 右侧：数据 / 查询 / Agent */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
          <IconDatabase className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
            {selected
              ? `${selected.table.schema}.${selected.table.name}`
              : activeConnection
                ? activeConnection.name
                : "未选择连接"}
          </span>
          <div className="flex items-center gap-0.5 rounded-md border border-line-strong p-0.5">
            <button
              type="button"
              onClick={() => pickTab("tables")}
              className={`${SEGMENT} ${subTab === "tables" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              表格
            </button>
            <button
              type="button"
              onClick={() => pickTab("query")}
              className={`${SEGMENT} ${subTab === "query" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              查询
            </button>
            <button
              type="button"
              onClick={() => pickTab("agent")}
              className={`${SEGMENT} ${subTab === "agent" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              Agent
            </button>
          </div>
          <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
        </header>

        {activeConnection && activeState?.phase === "error" && (
          <div className="flex shrink-0 items-start gap-2 border-b border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
            <span className="flex-1 break-all">{activeState.error}</span>
          </div>
        )}

        {exportNotice && (
          <div
            className={`flex shrink-0 items-start gap-2 border-b px-2 py-1 text-[11px] ${
              exportNotice.ok
                ? "border-line bg-panel text-fg-muted"
                : "border-danger-line bg-danger-bg text-danger"
            }`}
          >
            <span className="flex-1 break-all">{exportNotice.text}</span>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <div className={subTab === "tables" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
            {/* 「数据 / 结构」切换只在选中表后出现；没选中就维持原来的提示 */}
            {selected && (
              <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2">
                <button
                  type="button"
                  onClick={() => setTableView("data")}
                  className={`${SEGMENT} ${tableView === "data" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
                >
                  数据
                </button>
                <button
                  type="button"
                  onClick={() => setTableView("structure")}
                  className={`${SEGMENT} ${tableView === "structure" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
                >
                  结构
                </button>
              </div>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {tableView === "structure" ? (
                <TableStructure
                  sessionId={selected ? (sessions[selected.sessionKey]?.id ?? null) : null}
                  table={selected?.table ?? null}
                />
              ) : (
                <ResultGrid
                  result={result}
                  loading={loadingRows}
                  error={queryError}
                  onPage={(page) =>
                    selected &&
                    void loadRows(selected.sessionKey, selected.connectionId, selected.table, page)
                  }
                  hint="从左侧逐级展开：连接 → 数据库 → 表，点一张表看数据。"
                  onExport={
                    selected && result?.kind === "rows"
                      ? (format, scope) => {
                          const id = sessions[selected.sessionKey]?.id;
                          const connection = connectionsRef.current.find(
                            (item) => item.id === selected.connectionId,
                          );
                          if (id === undefined || !connection) return;
                          void runExport(
                            id,
                            selectAllSql(connection.kind, selected.table),
                            selected.table.name,
                            format,
                            scope,
                            result.page,
                            result.pageSize,
                          );
                        }
                      : undefined
                  }
                  exportBusy={exporting}
                />
              )}
            </div>
          </div>

          {activeConnection && activeSessionId !== undefined && (
            <>
              <div className={subTab === "query" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
                <DatabaseQuery sessionId={activeSessionId} kind={activeConnection.kind} />
              </div>
              {/* Agent：对话式生成并执行只读 SQL。和其它子视图一样 hidden 挂着不卸载，
                  切走再回来对话历史还在 */}
              <div className={subTab === "agent" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
                <DatabaseAgent connection={activeConnection} active={subTab === "agent"} />
              </div>
            </>
          )}

          {subTab !== "tables" && !activeSessionId && (
            <div className="flex flex-1 items-center justify-center px-6">
              <p className="max-w-[340px] text-center text-[12px] leading-relaxed text-fg-faint">
                从左侧展开一个连接后可用。
              </p>
            </div>
          )}
        </div>
      </div>

      {dialog && (
        <DatabaseConnectionDialog
          connection={dialog.connection}
          onSave={saveConnection}
          onClose={() => setDialog(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          message={`删除连接「${pendingDelete.name}」？已保存的密码也会一并清除。`}
          confirmLabel="删除"
          onConfirm={() => {
            deleteConnection(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 w-40 rounded-lg border border-line-strong bg-raised p-1 shadow-lg"
            style={{ left: Math.max(8, menu.x - 160), top: menu.y }}
          >
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                setDialog({ connection: menu.connection });
                setMenu(null);
              }}
            >
              编辑
            </button>
            {sessions[menu.connection.id] && (
              <button
                type="button"
                className={MENU_ITEM}
                onClick={() => {
                  disconnect(menu.connection.id);
                  setMenu(null);
                }}
              >
                断开连接
              </button>
            )}
            <button
              type="button"
              className={`${MENU_ITEM} text-danger hover:text-danger`}
              onClick={() => {
                setPendingDelete(menu.connection);
                setMenu(null);
              }}
            >
              删除
            </button>
          </div>
        </>
      )}

      {/* 表节点右键：整表导出。fixed 定位，树在 overflow-auto 里，绝对定位会被裁掉 */}
      {tableMenu && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setTableMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setTableMenu(null);
            }}
          />
          <div
            className="fixed z-40 w-40 rounded-lg border border-line-strong bg-raised p-1 shadow-lg"
            style={{
              left: Math.min(tableMenu.x, window.innerWidth - 168),
              top: Math.min(tableMenu.y, window.innerHeight - 72),
            }}
          >
            <button type="button" className={MENU_ITEM} onClick={() => exportTableNode("csv")}>
              导出为 CSV
            </button>
            <button type="button" className={MENU_ITEM} onClick={() => exportTableNode("xlsx")}>
              导出为 Excel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
