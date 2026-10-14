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

/**
 * 工作区的「最近活动」时间。
 *
 * 侧栏的工作区列表按它排序：最近用过终端或智能体对话的排前面。信号源天然是 root
 * （智能体事件带 root、终端会话按 root），所以这里按 `pathKey(root)` 存 Unix 毫秒，
 * 一个工作区挂多个根时由消费方取最大值。
 *
 * 「用到才算」的边界由上游把关：终端只在用户真的敲过输入、或该会话已在跑命令时才上报
 * （见 TerminalSession 的 engaged），单纯打开 / 切换工作区不产生活动。
 */

const ACTIVITY_KEY = "codedock.workspaceActivity";

/**
 * 同一 root 两次上报的最小间隔。终端高频输出（spinner 每秒重绘多次）会持续触达这里，
 * 不节流的话每来一块输出都要重渲染整棵侧栏、还顺带写一次 localStorage。
 * 表现为顺序最多滞后这么多，够用。
 */
const THROTTLE_MS = 5000;

type ByRoot = Record<string, number>;

interface Store {
  byRoot: ByRoot;
  touch: (root: string) => void;
  /** 工作区从列表里移除了，把它那份活动记录丢掉 */
  drop: (root: string) => void;
}

/** 从磁盘/别处读到的值不一定干净，逐字段校验，坏的丢掉而不是让界面炸掉 */
function readActivity(): ByRoot {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: ByRoot = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) next[key] = value;
    }
    return next;
  } catch {
    return {};
  }
}

function writeActivity(map: ByRoot) {
  try {
    window.localStorage.setItem(ACTIVITY_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式等场景写不进去，忽略即可，只是重启后顺序回到无记录
  }
}

const ActivityContext = createContext<Store | null>(null);

/**
 * 活动时间的收集与分发。放在 Provider 里（而不是各工作区实例里），因为侧栏要给
 * **所有**工作区排序，够不着单个工作区的终端 / 智能体实例。
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [byRoot, setByRoot] = useState<ByRoot>(readActivity);
  /** 节流用的上次上报时刻，只在内存里，不落盘 */
  const lastTouchRef = useRef<ByRoot>({});

  const touch = useCallback((root: string) => {
    const key = pathKey(root);
    const now = Date.now();
    if (now - (lastTouchRef.current[key] ?? 0) < THROTTLE_MS) return;
    lastTouchRef.current[key] = now;
    // 值没变就原样返回，免得每次上报都触发一轮无意义的重渲染
    setByRoot((current) => (current[key] >= now ? current : { ...current, [key]: now }));
    // 写前读最新：多窗口共享同一份 localStorage，直接拿本窗口记的整份覆盖，
    // 会把别的窗口刚上报的活动抹掉。取较大值合并，只增不减。
    const latest = readActivity();
    if ((latest[key] ?? 0) < now) {
      latest[key] = now;
      writeActivity(latest);
    }
  }, []);

  const drop = useCallback((root: string) => {
    const key = pathKey(root);
    delete lastTouchRef.current[key];
    setByRoot((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    const latest = readActivity();
    if (key in latest) {
      delete latest[key];
      writeActivity(latest);
    }
  }, []);

  // 智能体事件流只订阅一次。后端是全量转发的，一条事件里带着它属于哪个工作区，
  // 任何事件（含 v1/v2 的工具增量）都算「这个工作区有活动」，由节流兜住频率
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void onAgentEvent((root) => touch(root)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [touch]);

  const store = useMemo(() => ({ byRoot, touch, drop }), [byRoot, touch, drop]);

  return <ActivityContext.Provider value={store}>{children}</ActivityContext.Provider>;
}

function useStore(): Store {
  const store = useContext(ActivityContext);
  if (!store) throw new Error("activity 必须在 ActivityProvider 内使用");
  return store;
}

/** 全局那一份（侧栏要给所有工作区排序） */
export function useActivityAll(): ByRoot {
  return useStore().byRoot;
}

/**
 * 上报一次活动。返回的函数身份稳定（依赖为空），可以直接塞进终端会话的 ref 回调。
 */
export function useTouchActivity(): (root: string) => void {
  return useStore().touch;
}

/** 工作区从列表里移除时丢掉它那份记录 */
export function useDropActivity(): (root: string) => void {
  return useStore().drop;
}
