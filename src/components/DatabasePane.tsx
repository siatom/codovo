import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { DatabaseConnectionDialog } from "./DatabaseConnectionDialog";
import { DatabaseQuery } from "./DatabaseQuery";
import { DatabaseTables } from "./DatabaseTables";
import { FullscreenButton } from "./FullscreenButton";
import { useDbConnections } from "../lib/db-connections";
import {
  clearDbSecrets,
  connectDb,
  connectionSummary,
  disconnectDb,
  type DbConnection,
  type DbConnectionState,
} from "../lib/database";
import { IconDatabase, IconMore, IconPlus } from "./icons";

const ACTIVE_KEY = "codedock.dbActiveConnection";
const TAB_KEY = "codedock.dbTab";

type SubTab = "tables" | "query";

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

/** 状态点配色 */
function dotClass(state: DbConnectionState | undefined): string {
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

/**
 * 右栏「数据库」模块：左侧连接列表 + 右侧「表 / 查询」两个子视图。
 *
 * 面板独占编辑器那一列（和浏览器 / 远程连接同款）。连接按需建立：点了才连，连上后
 * 会话留在后端池里，切走不杀。
 */
export function DatabasePane({
  fullscreen,
  onToggleFullscreen,
}: {
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
  const [subTab, setSubTab] = useState<SubTab>(() =>
    readSession(TAB_KEY) === "query" ? "query" : "tables",
  );
  /** 用户这次会话里主动连过的连接 */
  const [connected, setConnected] = useState<string[]>([]);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const [states, setStates] = useState<Record<string, DbConnectionState>>({});
  const [sessionIds, setSessionIds] = useState<Record<string, number>>({});
  const sessionIdsRef = useRef(sessionIds);
  sessionIdsRef.current = sessionIds;
  const [dialog, setDialog] = useState<{ connection: DbConnection | null } | null>(null);
  const [menu, setMenu] = useState<{ connection: DbConnection; x: number; y: number } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<DbConnection | null>(null);

  const activeConnection = useMemo(
    () => connections.find((item) => item.id === activeConnectionId) ?? null,
    [connections, activeConnectionId],
  );
  const activeSessionId = activeConnection ? sessionIds[activeConnection.id] : undefined;
  const activeState = activeConnection ? states[activeConnection.id] : undefined;

  const pickTab = useCallback((next: SubTab) => {
    setSubTab(next);
    writeSession(TAB_KEY, next);
  }, []);

  const connect = useCallback(async (connection: DbConnection) => {
    setStates((current) => ({ ...current, [connection.id]: { phase: "connecting" } }));
    setConnected((list) => (list.includes(connection.id) ? list : [...list, connection.id]));
    try {
      const sessionId = await connectDb(connection);
      setSessionIds((current) => ({ ...current, [connection.id]: sessionId }));
      setStates((current) => ({ ...current, [connection.id]: { phase: "ready" } }));
    } catch (reason) {
      setStates((current) => ({
        ...current,
        [connection.id]: { phase: "error", error: String(reason) },
      }));
      setConnected((list) => list.filter((id) => id !== connection.id));
    }
  }, []);

  const disconnect = useCallback((id: string) => {
    const sessionId = sessionIdsRef.current[id];
    if (sessionId !== undefined) void disconnectDb(sessionId).catch(() => {});
    setConnected((list) => list.filter((item) => item !== id));
    setSessionIds((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setStates((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const openConnection = useCallback(
    (connection: DbConnection) => {
      setActiveConnectionId(connection.id);
      writeSession(ACTIVE_KEY, connection.id);
      if (!connectedRef.current.includes(connection.id)) void connect(connection);
    },
    [connect],
  );

  const saveConnection = useCallback(
    (connection: DbConnection) => {
      const exists = connectionsRef.current.some((item) => item.id === connection.id);
      if (exists) updateConnection(connection);
      else addConnection(connection);
      setDialog(null);
      setActiveConnectionId(connection.id);
      writeSession(ACTIVE_KEY, connection.id);
      // 改过连接参数就重连一次，别让旧会话继续用旧配置
      if (connectedRef.current.includes(connection.id)) {
        disconnect(connection.id);
        void connect(connection);
      }
    },
    [addConnection, updateConnection, connect, disconnect],
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

  const isConnected = activeConnection ? connected.includes(activeConnection.id) : false;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 bg-panel">
      {/* 左窄栏：连接列表 */}
      <div className="flex h-full w-44 shrink-0 flex-col border-r border-line">
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
              const state = states[connection.id];
              const isActive = connection.id === activeConnectionId;
              return (
                <div
                  key={connection.id}
                  onClick={() => openConnection(connection)}
                  className={`group flex cursor-default items-center gap-2 rounded-md px-2 py-1 ${
                    isActive ? "bg-selected" : "hover:bg-hover"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(state)}`}
                    title={state?.error ?? undefined}
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
              );
            })
          )}
        </div>
      </div>

      {/* 右侧：表 / 查询 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
          <IconDatabase className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
            {activeConnection ? activeConnection.name : "未选择连接"}
            {activeConnection && (
              <span className="ml-2 text-[11px] text-fg-faint">
                {connectionSummary(activeConnection)}
              </span>
            )}
          </span>
          <div className="flex items-center gap-0.5 rounded-md border border-line-strong p-0.5">
            <button
              type="button"
              onClick={() => pickTab("tables")}
              className={`${SEGMENT} ${subTab === "tables" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              表
            </button>
            <button
              type="button"
              onClick={() => pickTab("query")}
              className={`${SEGMENT} ${subTab === "query" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              查询
            </button>
          </div>
          <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
        </header>

        {activeConnection && activeState?.phase === "error" && (
          <div className="flex shrink-0 items-start gap-2 border-b border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
            <span className="flex-1 break-all">{activeState.error}</span>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {!activeConnection ? (
            <div className="flex flex-1 items-center justify-center px-6">
              <p className="max-w-[340px] text-center text-[12px] leading-relaxed text-fg-faint">
                从左侧选一个连接，点一下即连接。连上后可以浏览表、看数据，或写 SQL 查询。
              </p>
            </div>
          ) : !isConnected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
              <p className="text-[12px] text-fg-faint">
                {activeState?.phase === "error" ? "连接失败。" : "已选连接，尚未连接。"}
              </p>
              <button
                type="button"
                onClick={() => void connect(activeConnection)}
                className="rounded-md border border-accent px-3 py-1 text-[12px] text-accent hover:bg-selected"
              >
                {activeState?.phase === "error" ? "重试" : "连接"}
              </button>
            </div>
          ) : activeSessionId === undefined ? (
            <div className="flex flex-1 items-center justify-center px-6">
              <p className="text-[12px] text-fg-faint">正在建立连接…</p>
            </div>
          ) : (
            <>
              <div
                className={
                  subTab === "tables" ? "flex min-h-0 min-w-0 flex-1" : "hidden"
                }
              >
                <DatabaseTables sessionId={activeSessionId} kind={activeConnection.kind} />
              </div>
              <div
                className={
                  subTab === "query" ? "flex min-h-0 min-w-0 flex-1" : "hidden"
                }
              >
                <DatabaseQuery sessionId={activeSessionId} />
              </div>
            </>
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
            {connected.includes(menu.connection.id) && (
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
    </section>
  );
}
