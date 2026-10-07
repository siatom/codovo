import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DB_CONNECTIONS_EVENT,
  DB_CONNECTIONS_KEY,
  readConnections,
  saveConnections,
  type DbConnection,
} from "./database";

interface DbConnectionsValue {
  connections: DbConnection[];
  addConnection: (connection: DbConnection) => void;
  updateConnection: (connection: DbConnection) => void;
  removeConnection: (id: string) => void;
}

const DbConnectionsContext = createContext<DbConnectionsValue | null>(null);

/**
 * 数据库连接清单是**跨窗口共享**的（一台机器配一次，哪个窗口都能连），所以走 localStorage，
 * 和设置、远程主机同一层。放在 Provider 里是为了同一个窗口的多个面板能共用同一份并同步更新。
 */
export function DbConnectionsProvider({ children }: { children: ReactNode }) {
  const [connections, setConnections] = useState<DbConnection[]>(readConnections);

  // 同窗口别的面板改了列表（自定义事件）或别的窗口改了（storage），重新读一遍。
  // storage 事件只在别的 document 触发，所以两者都要挂，不会自回流。
  useEffect(() => {
    const reload = () => setConnections(readConnections());
    window.addEventListener(DB_CONNECTIONS_EVENT, reload);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === DB_CONNECTIONS_KEY) reload();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DB_CONNECTIONS_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // 列表变更一律「写前读最新 → 改 → 写」：直接覆盖会抹掉别处刚写进去的
  const mutate = useCallback((fn: (list: DbConnection[]) => DbConnection[]) => {
    saveConnections(fn(readConnections()));
  }, []);

  const addConnection = useCallback(
    (connection: DbConnection) => mutate((list) => [...list, connection]),
    [mutate],
  );
  const updateConnection = useCallback(
    (connection: DbConnection) =>
      mutate((list) => list.map((item) => (item.id === connection.id ? connection : item))),
    [mutate],
  );
  const removeConnection = useCallback(
    (id: string) => mutate((list) => list.filter((item) => item.id !== id)),
    [mutate],
  );

  const value = useMemo(
    () => ({ connections, addConnection, updateConnection, removeConnection }),
    [connections, addConnection, updateConnection, removeConnection],
  );

  return (
    <DbConnectionsContext.Provider value={value}>{children}</DbConnectionsContext.Provider>
  );
}

export function useDbConnections(): DbConnectionsValue {
  const value = useContext(DbConnectionsContext);
  if (!value) throw new Error("useDbConnections 必须在 DbConnectionsProvider 内使用");
  return value;
}
