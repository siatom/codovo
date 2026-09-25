import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { AgentSessionSummary } from "./types";

/** 终端区停在哪一侧：TUI（终端）还是 GUI（智能体对话） */
export type AgentView = "terminal" | "agent";

interface AgentSessionValue {
  /** 终端区当前显示哪一侧。设置里关掉智能体后，消费方要自己当 "terminal" 处理 */
  mode: AgentView;
  setMode: (mode: AgentView) => void;
  /** 当前工作区的会话列表，最近活动在前 */
  sessions: AgentSessionSummary[];
  setSessions: (sessions: AgentSessionSummary[]) => void;
  /** 正在打开的会话 id（响应式，给界面高亮用） */
  currentId: string | null;
  /** 同上，但走 ref——SSE 处理器只订阅一次，读 state 会拿到挂载那一刻的旧值 */
  currentIdRef: RefObject<string | null>;
  setCurrentId: (id: string | null) => void;
  /** 侧边栏点了某条历史会话，等 AgentPane 就绪后消费 */
  requestedId: string | null;
  requestSession: (id: string) => void;
  clearRequest: () => void;
  /** 侧边栏确认删除某条历史会话，由 AgentPane 执行并收拾现场 */
  requestedDeleteId: string | null;
  requestDelete: (id: string) => void;
  clearDeleteRequest: () => void;
  /** 侧边栏点了「新建对话」，由 AgentPane 在服务就绪后真的建一条 */
  requestedNew: boolean;
  requestNew: () => void;
  clearNewRequest: () => void;
  /** 侧边栏确认重命名某条历史会话，由 AgentPane 调后端改标题 */
  requestedRename: { id: string; title: string } | null;
  requestRename: (id: string, title: string) => void;
  clearRenameRequest: () => void;
}

const AgentSessionContext = createContext<AgentSessionValue | null>(null);

/**
 * 终端区的 TUI/GUI 模式、会话列表、当前会话这些状态原先都关在 TerminalPane / AgentPane 内部，
 * 侧边栏要展示当前项目的对话历史就得共享出来，所以提到这一层。
 */
export function AgentSessionProvider({
  cwd,
  children,
}: {
  cwd: string | null;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<AgentView>("terminal");
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [requestedDeleteId, setRequestedDeleteId] = useState<string | null>(null);
  const [requestedNew, setRequestedNew] = useState(false);
  const [requestedRename, setRequestedRename] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const currentIdRef = useRef<string | null>(null);
  const [currentId, setCurrentIdState] = useState<string | null>(null);
  const setCurrentId = useCallback((id: string | null) => {
    currentIdRef.current = id;
    setCurrentIdState(id);
  }, []);

  // 换工作区要一起归零：终端区本来靠 key 重建、mode 是它自己的 state，
  // 搬到这一层后不重置的话，会拿旧目录的会话列表去配新目录的项目行。
  useEffect(() => {
    setMode("terminal");
    setSessions([]);
    setRequestedId(null);
    setRequestedDeleteId(null);
    setRequestedNew(false);
    setRequestedRename(null);
    setCurrentId(null);
  }, [cwd, setCurrentId]);

  const requestSession = useCallback((id: string) => {
    // 点历史必然是从 GUI 侧点的，这里再兜一次：请求打开就等于切到 GUI
    setMode("agent");
    setRequestedId(id);
  }, []);

  const clearRequest = useCallback(() => setRequestedId(null), []);

  const requestDelete = useCallback((id: string) => setRequestedDeleteId(id), []);
  const clearDeleteRequest = useCallback(() => setRequestedDeleteId(null), []);

  const requestNew = useCallback(() => setRequestedNew(true), []);
  const clearNewRequest = useCallback(() => setRequestedNew(false), []);

  const requestRename = useCallback(
    (id: string, title: string) => setRequestedRename({ id, title }),
    [],
  );
  const clearRenameRequest = useCallback(() => setRequestedRename(null), []);

  const value = useMemo(
    () => ({
      mode,
      setMode,
      sessions,
      setSessions,
      currentId,
      currentIdRef,
      setCurrentId,
      requestedId,
      requestSession,
      clearRequest,
      requestedDeleteId,
      requestDelete,
      clearDeleteRequest,
      requestedNew,
      requestNew,
      clearNewRequest,
      requestedRename,
      requestRename,
      clearRenameRequest,
    }),
    [
      mode,
      sessions,
      currentId,
      requestedId,
      requestedDeleteId,
      requestedNew,
      requestedRename,
      setCurrentId,
      requestSession,
      clearRequest,
      requestDelete,
      clearDeleteRequest,
      requestNew,
      clearNewRequest,
      requestRename,
      clearRenameRequest,
    ],
  );

  return (
    <AgentSessionContext.Provider value={value}>{children}</AgentSessionContext.Provider>
  );
}

export function useAgentSession(): AgentSessionValue {
  const value = useContext(AgentSessionContext);
  if (!value) throw new Error("useAgentSession 必须在 AgentSessionProvider 内使用");
  return value;
}
