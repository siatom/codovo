import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { AgentSessionSummary } from "./types";

/** 一个工作区自己的那一份助手会话状态 */
interface WorkspaceSessionState {
  /** 该工作区的会话列表，最近活动在前 */
  sessions: AgentSessionSummary[];
  /** 正在打开的会话 id（响应式，给界面高亮用） */
  currentId: string | null;
  /** 点了某条历史会话，等助手面板就绪后消费 */
  requestedId: string | null;
  /** 确认删除某条历史会话，由助手面板执行并收拾现场 */
  requestedDeleteId: string | null;
  /** 点了「新建对话」，由助手面板在服务就绪后真的建一条 */
  requestedNew: boolean;
  /** 确认重命名某条历史会话，由助手面板调后端改标题 */
  requestedRename: { id: string; title: string } | null;
}

const EMPTY: WorkspaceSessionState = {
  sessions: [],
  currentId: null,
  requestedId: null,
  requestedDeleteId: null,
  requestedNew: false,
  requestedRename: null,
};

/** 绑定好某个工作区之后，对外暴露的那一份 */
export interface AgentSessionValue {
  sessions: AgentSessionSummary[];
  setSessions: (sessions: AgentSessionSummary[]) => void;
  currentId: string | null;
  /** 同上，但走 ref——SSE 处理器只订阅一次，读 state 会拿到挂载那一刻的旧值 */
  currentIdRef: RefObject<string | null>;
  setCurrentId: (id: string | null) => void;
  requestedId: string | null;
  requestSession: (id: string) => void;
  clearRequest: () => void;
  requestedDeleteId: string | null;
  requestDelete: (id: string) => void;
  clearDeleteRequest: () => void;
  requestedNew: boolean;
  requestNew: () => void;
  clearNewRequest: () => void;
  requestedRename: { id: string; title: string } | null;
  requestRename: (id: string, title: string) => void;
  clearRenameRequest: () => void;
}

interface Store {
  byRoot: Record<string, WorkspaceSessionState>;
  /** 按工作区改一份状态 */
  patch: (root: string, next: Partial<WorkspaceSessionState>) => void;
  /** 某个工作区的 currentId ref（SSE 处理器要读最新值） */
  refOf: (root: string) => RefObject<string | null>;
  /** 工作区关掉了，把它的那份状态丢掉，下次打开是干净的 */
  drop: (root: string) => void;
  /** 把某个工作区挂上「打开这条会话」请求（侧栏给还没切过去的工作区点标记时用） */
  openSessionAt: (root: string, id: string) => void;
}

const AgentSessionContext = createContext<Store | null>(null);

/**
 * 应用助手面板的会话状态：会话列表、当前会话这些原先关在 AgentPane 内部，
 * 现在共享出来——抽屉里的历史菜单与侧栏的「在等用户」标记都要读它。
 *
 * **按工作区 root 分片**：一个窗口里会同时开着多个工作区，每个工作区一套会话列表和当前
 * 会话；切工作区时各看各的，不会串。状态一直留在 Provider 里，切走的工作区不丢。
 */
export function AgentSessionProvider({ children }: { children: ReactNode }) {
  const [byRoot, setByRoot] = useState<Record<string, WorkspaceSessionState>>({});
  // ref 版本单独存：SSE 处理器只订阅一次，读 state 会拿到挂载那一刻的旧值
  const refs = useRef(new Map<string, { current: string | null }>());

  const patch = useCallback((root: string, next: Partial<WorkspaceSessionState>) => {
    setByRoot((current) => ({
      ...current,
      [root]: { ...(current[root] ?? EMPTY), ...next },
    }));
  }, []);

  const refOf = useCallback((root: string) => {
    let entry = refs.current.get(root);
    if (!entry) {
      entry = { current: null };
      refs.current.set(root, entry);
    }
    return entry;
  }, []);

  const drop = useCallback((root: string) => {
    setByRoot((current) => {
      if (!(root in current)) return current;
      const next = { ...current };
      delete next[root];
      return next;
    });
    refs.current.delete(root);
  }, []);

  // 打开会话：由该工作区的助手面板消费 requestedId（面板还没挂上就先挂着，就绪后消费）
  const openSessionAt = useCallback(
    (root: string, id: string) => patch(root, { requestedId: id }),
    [patch],
  );

  const store = useMemo(
    () => ({ byRoot, patch, refOf, drop, openSessionAt }),
    [byRoot, patch, refOf, drop, openSessionAt],
  );

  return (
    <AgentSessionContext.Provider value={store}>{children}</AgentSessionContext.Provider>
  );
}

/** 没有工作区时（root 为 null）用一个占位 key，状态本身没人看 */
const NO_ROOT = "";

/** 取某个工作区的那一份会话状态与操作。`root` 变了就自动看新工作区的 */
export function useAgentSession(root: string | null): AgentSessionValue {
  const store = useContext(AgentSessionContext);
  if (!store) throw new Error("useAgentSession 必须在 AgentSessionProvider 内使用");
  const { byRoot, patch, refOf } = store;

  const key = root ?? NO_ROOT;
  const state = byRoot[key] ?? EMPTY;
  const currentIdRef = refOf(key);

  return useMemo(
    () => ({
      sessions: state.sessions,
      setSessions: (sessions: AgentSessionSummary[]) => patch(key, { sessions }),
      currentId: state.currentId,
      currentIdRef,
      setCurrentId: (id: string | null) => {
        currentIdRef.current = id;
        patch(key, { currentId: id });
      },
      requestedId: state.requestedId,
      requestSession: (id: string) => patch(key, { requestedId: id }),
      clearRequest: () => patch(key, { requestedId: null }),
      requestedDeleteId: state.requestedDeleteId,
      requestDelete: (id: string) => patch(key, { requestedDeleteId: id }),
      clearDeleteRequest: () => patch(key, { requestedDeleteId: null }),
      requestedNew: state.requestedNew,
      requestNew: () => patch(key, { requestedNew: true }),
      clearNewRequest: () => patch(key, { requestedNew: false }),
      requestedRename: state.requestedRename,
      requestRename: (id: string, title: string) =>
        patch(key, { requestedRename: { id, title } }),
      clearRenameRequest: () => patch(key, { requestedRename: null }),
    }),
    [key, state, currentIdRef, patch],
  );
}

/** 关闭工作区时清掉它那份会话状态。返回的函数可以直接用 */
export function useDropAgentSession(): (root: string) => void {
  const store = useContext(AgentSessionContext);
  if (!store) throw new Error("useDropAgentSession 必须在 AgentSessionProvider 内使用");
  return store.drop;
}

/**
 * 只拿「打开某条会话」这一个入口。侧栏给还没切过去的工作区点「在等用户」标记时用——
 * 此刻活动根还不是它，够不着 `useAgentSession(activeRoot)`。
 */
export function useOpenSessionAt(): (root: string, id: string) => void {
  const store = useContext(AgentSessionContext);
  if (!store) throw new Error("useOpenSessionAt 必须在 AgentSessionProvider 内使用");
  return store.openSessionAt;
}
