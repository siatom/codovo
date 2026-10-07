import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { HOSTS_EVENT, readHosts, REMOTE_HOSTS_KEY, saveHosts, type RemoteHost } from "./remote";

interface RemoteHostsValue {
  hosts: RemoteHost[];
  addHost: (host: RemoteHost) => void;
  updateHost: (host: RemoteHost) => void;
  removeHost: (id: string) => void;
}

const RemoteHostsContext = createContext<RemoteHostsValue | null>(null);

/**
 * 远程主机清单是**跨窗口共享**的（一台机器配一次，哪个窗口都能连），所以走 localStorage，
 * 和设置同一层。放在 Provider 里是为了同一个窗口的多个面板能共用同一份并同步更新。
 */
export function RemoteHostsProvider({ children }: { children: ReactNode }) {
  const [hosts, setHosts] = useState<RemoteHost[]>(readHosts);

  // 同窗口别的面板改了列表（自定义事件）或别的窗口改了（storage），重新读一遍。
  // storage 事件只在别的 document 触发，所以两者都要挂，不会自回流。
  useEffect(() => {
    const reload = () => setHosts(readHosts());
    window.addEventListener(HOSTS_EVENT, reload);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === REMOTE_HOSTS_KEY) reload();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(HOSTS_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // 列表变更一律「写前读最新 → 改 → 写」：直接覆盖会抹掉别处刚写进去的
  const mutate = useCallback((fn: (list: RemoteHost[]) => RemoteHost[]) => {
    saveHosts(fn(readHosts()));
  }, []);

  const addHost = useCallback(
    (host: RemoteHost) => mutate((list) => [...list, host]),
    [mutate],
  );
  const updateHost = useCallback(
    (host: RemoteHost) =>
      mutate((list) => list.map((item) => (item.id === host.id ? host : item))),
    [mutate],
  );
  const removeHost = useCallback(
    (id: string) => mutate((list) => list.filter((item) => item.id !== id)),
    [mutate],
  );

  const value = useMemo(
    () => ({ hosts, addHost, updateHost, removeHost }),
    [hosts, addHost, updateHost, removeHost],
  );

  return <RemoteHostsContext.Provider value={value}>{children}</RemoteHostsContext.Provider>;
}

export function useRemoteHosts(): RemoteHostsValue {
  const value = useContext(RemoteHostsContext);
  if (!value) throw new Error("useRemoteHosts 必须在 RemoteHostsProvider 内使用");
  return value;
}
