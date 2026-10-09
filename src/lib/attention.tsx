import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { onAgentEvent } from "./agent";
import { pathKey } from "./fs";
import type { AgentEvent } from "./types";

/**
 * 「某个 AI 会话在等用户」的标记状态。
 *
 * 单窗口多工作区下，用户常停在别的工作区或别的标签上，看不到哪个后台实例正等着他。
 * 这里按工作区 root 分片收集「谁在等」，供侧栏工作区行、终端标签栏、对话列表消费；
 * 点击标记能一键回到那个工作区并选中对应的标签 / 会话。
 *
 * 两类来源：
 * - 智能体（opencode）：全局订阅 SSE，按 opencode 自己那套语义判定——`permission.asked` /
 *   `form.created` 置位，`permission.replied` / `form.replied` / `form.cancelled` /
 *   `session.execution.*` 清除（见 opencode.notifications 插件里的同款判断）。
 * - 终端 CLI：由 TerminalSession 对 PTY 输出做启发式判断后上抛（见那边）。
 */

/** 在等用户的原因：要批准某个权限、要回答一个问题，或终端 CLI 停在交互提示上 */
export type AttentionKind = "permission" | "question" | "prompt";

/** 智能体会话的目标键 */
export function agentTarget(sessionId: string): string {
  return `agent:${sessionId}`;
}

/** 终端标签的目标键（标签 id 只在一个工作区的终端区内唯一，和 root 合起来才全局唯一） */
export function terminalTarget(tabId: number): string {
  return `term:${tabId}`;
}

/** 归一化后的 root -> (目标键 -> 原因) */
export type AttentionMap = Record<string, Record<string, AttentionKind>>;

type ByRoot = AttentionMap;

interface Store {
  byRoot: ByRoot;
  set: (root: string, target: string, kind: AttentionKind) => void;
  clear: (root: string, target: string) => void;
  /** 工作区关掉了，把它的那份标记丢掉 */
  drop: (root: string) => void;
}

const AttentionContext = createContext<Store | null>(null);

function payloadOf(event: AgentEvent): Record<string, unknown> {
  return (event.properties ?? event.data ?? {}) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * 从一条 SSE 事件里读出「哪个会话、变成什么状态」。`kind` 为 null 表示清除。
 * 和本功能无关的事件返回 null。会话 id 取不到（载荷形状不认识）时也返回 null，别猜。
 */
function attentionChange(
  event: AgentEvent,
): { id: string; kind: AttentionKind | null } | null {
  const payload = payloadOf(event);
  const form = asRecord(payload.form);
  // form.created 把会话 id 放在 data.form.sessionID 里，其余事件直接放在 data.sessionID
  const id = asString(payload.sessionID) ?? (form ? asString(form.sessionID) : null);

  switch (event.type) {
    case "permission.asked":
      return id ? { id, kind: "permission" } : null;
    case "form.created":
      return id ? { id, kind: "question" } : null;
    // 用户答复 / 撤回了，或者这一轮跑完（含新的一轮开始）——都不再是「在等用户」
    case "permission.replied":
    case "permission.rejected":
    case "form.replied":
    case "form.cancelled":
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.interrupted":
    case "session.execution.failed":
      return id ? { id, kind: null } : null;
    default:
      return null;
  }
}

export function AttentionProvider({ children }: { children: ReactNode }) {
  const [byRoot, setByRoot] = useState<ByRoot>({});

  const set = useCallback((root: string, target: string, kind: AttentionKind) => {
    const key = pathKey(root);
    setByRoot((current) => {
      // 值没变就原样返回，免得每次事件都触发一轮无意义的重渲染
      if (current[key]?.[target] === kind) return current;
      return { ...current, [key]: { ...(current[key] ?? {}), [target]: kind } };
    });
  }, []);

  const clear = useCallback((root: string, target: string) => {
    const key = pathKey(root);
    setByRoot((current) => {
      const entry = current[key];
      if (!entry || !(target in entry)) return current;
      const rest = { ...entry };
      delete rest[target];
      if (Object.keys(rest).length === 0) {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: rest };
    });
  }, []);

  const drop = useCallback((root: string) => {
    const key = pathKey(root);
    setByRoot((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  // 事件流只订阅一次。后端是全量转发的，一条事件里带着它属于哪个工作区，按 root 归位
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void onAgentEvent((root, event) => {
      const change = attentionChange(event);
      if (!change) return;
      if (change.kind) set(root, agentTarget(change.id), change.kind);
      else clear(root, agentTarget(change.id));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [set, clear]);

  const store = useMemo(() => ({ byRoot, set, clear, drop }), [byRoot, set, clear, drop]);

  return <AttentionContext.Provider value={store}>{children}</AttentionContext.Provider>;
}

function useStore(): Store {
  const store = useContext(AttentionContext);
  if (!store) throw new Error("attention 必须在 AttentionProvider 内使用");
  return store;
}

/** 某个工作区自己的那一份标记与读写入口 */
export function useAttention(root: string | null): {
  entries: Record<string, AttentionKind>;
  set: (target: string, kind: AttentionKind) => void;
  clear: (target: string) => void;
} {
  const store = useStore();
  const key = root ? pathKey(root) : "";
  const entries = store.byRoot[key] ?? EMPTY_ENTRIES;

  // root 放 ref 里，set / clear 只依赖 store 那两个稳定函数——它们要传给 TerminalSession
  // 的回调，每次标记变化都换身份的话会牵着 ref 回调重挂
  const rootRef = useRef(root);
  rootRef.current = root;
  const { set: storeSet, clear: storeClear } = store;

  const set = useCallback(
    (target: string, kind: AttentionKind) => {
      const current = rootRef.current;
      if (current) storeSet(current, target, kind);
    },
    [storeSet],
  );
  const clear = useCallback(
    (target: string) => {
      const current = rootRef.current;
      if (current) storeClear(current, target);
    },
    [storeClear],
  );

  return useMemo(() => ({ entries, set, clear }), [entries, set, clear]);
}

/** 全局那一份（侧栏要给所有工作区行做标记，够不着单个 root 的 hook） */
export function useAttentionAll(): ByRoot {
  return useStore().byRoot;
}

/** 关闭工作区时丢掉它那份标记 */
export function useDropAttention(): (root: string) => void {
  return useStore().drop;
}

const EMPTY_ENTRIES: Record<string, AttentionKind> = {};
