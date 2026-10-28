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
 * - 智能体：全局订阅 `agent-event`，一轮跑完 / 跑挂置 `done`，新一轮开始清除。
 *   内置工具都是非交互的（不问权限、不弹表单），所以智能体这边只会有「任务完成」一种标记。
 * - 终端 CLI：由 TerminalSession 对 PTY 输出做启发式判断后上抛（见那边）。
 */

/**
 * 在等用户的原因：要批准某个权限、要回答一个问题、终端 CLI 停在交互提示上，
 * 或一轮任务跑完、等用户下一步指令（`done`）。
 */
export type AttentionKind = "permission" | "question" | "prompt" | "done";

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
  /** 只清掉「恰好是这个原因」的标记（已读不该碰掉还要用户回应的 permission / question） */
  clearIf: (root: string, target: string, kind: AttentionKind) => void;
  /** 工作区关掉了，把它的那份标记丢掉 */
  drop: (root: string) => void;
}

/** 从一份标记里删掉某个目标（连带清掉空掉的 root 条目）；没变化就原样返回 */
function without(current: ByRoot, key: string, target: string): ByRoot {
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
}

const AttentionContext = createContext<Store | null>(null);

/**
 * 从一条助手事件里读出「哪个会话、变成什么状态」。`kind` 为 null 表示清除。
 * 和本功能无关的事件返回 null。
 */
function attentionChange(
  event: AgentEvent,
): { id: string; kind: AttentionKind | null } | null {
  const id = event.sessionId;
  if (!id) return null;

  switch (event.type) {
    // 一轮跑完（成功或失败）都是「任务结束、等用户下一步指令」。失败也要提醒——
    // 用户不来看就不知道它停了
    case "runFinished":
    case "runFailed":
      return { id, kind: "done" };
    // 新的一轮开始了——不再是在等用户。
    // 用户按停止时后端会补发一条 runFinished（被掐断的那一轮没机会收尾），
    // 于是也会落成「已完成」：任务确实结束了，标一下不算错。
    case "runStarted":
      return { id, kind: null };
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
    setByRoot((current) => without(current, key, target));
  }, []);

  const clearIf = useCallback((root: string, target: string, kind: AttentionKind) => {
    const key = pathKey(root);
    setByRoot((current) =>
      current[key]?.[target] === kind ? without(current, key, target) : current,
    );
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

  const store = useMemo(
    () => ({ byRoot, set, clear, clearIf, drop }),
    [byRoot, set, clear, clearIf, drop],
  );

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
  clearIf: (target: string, kind: AttentionKind) => void;
} {
  const store = useStore();
  const key = root ? pathKey(root) : "";
  const entries = store.byRoot[key] ?? EMPTY_ENTRIES;

  // root 放 ref 里，set / clear 只依赖 store 那几个稳定函数——它们要传给 TerminalSession
  // 的回调，每次标记变化都换身份的话会牵着 ref 回调重挂
  const rootRef = useRef(root);
  rootRef.current = root;
  const { set: storeSet, clear: storeClear, clearIf: storeClearIf } = store;

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
  const clearIf = useCallback(
    (target: string, kind: AttentionKind) => {
      const current = rootRef.current;
      if (current) storeClearIf(current, target, kind);
    },
    [storeClearIf],
  );

  return useMemo(
    () => ({ entries, set, clear, clearIf }),
    [entries, set, clear, clearIf],
  );
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
