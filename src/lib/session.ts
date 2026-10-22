import { pathKey } from "./fs";

/**
 * 按工作区持久化的编辑器会话：打开的普通文件路径、激活标签、标签顺序。
 *
 * 刻意**不存**未命名缓冲区的内容与 Monaco 的 view state：
 * - 未命名缓冲区没有落盘，写进 localStorage 既涉及隐私又可能很大；
 * - Monaco 的滚动 / 选区是可以序列化的普通对象，但存储结构跟着版本变，
 *   为一次性恢复引入兼容负担不划算。标签恢复后滚动位置从文件开头开始。
 */
export interface EditorSession {
  /** 普通文件标签的绝对路径，数组顺序就是标签顺序；去重后保存 */
  paths: string[];
  /** 上次激活的标签路径；不在 `paths` 里时由调用方落到第一个 */
  active: string | null;
}

const KEY_PREFIX = "codovo.editorSession.";
/** 落盘防抖：拖动重排标签会连着触发很多次 */
const SAVE_DELAY_MS = 400;

/** 工作区 id -> 待写入的定时器。clearSession 要能取消它，否则关闭后又写回来 */
const timers = new Map<string, number>();

function keyOf(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

/** 读到的东西可能是旧格式 / 手改的，逐项校验，坏的丢掉 */
export function readSession(workspaceId: string): EditorSession | null {
  try {
    const raw = window.localStorage.getItem(keyOf(workspaceId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    const seen = new Set<string>();
    const paths: string[] = [];
    if (Array.isArray(value.paths)) {
      for (const item of value.paths) {
        if (typeof item !== "string" || item.length === 0) continue;
        const key = pathKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        paths.push(item);
      }
    }
    const active =
      typeof value.active === "string" && seen.has(pathKey(value.active)) ? value.active : null;
    return paths.length > 0 ? { paths, active } : null;
  } catch {
    return null;
  }
}

export function saveSession(workspaceId: string, session: EditorSession): void {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of session.paths) {
    if (!path) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  try {
    // 空会话就没必要留着一条空记录
    if (paths.length === 0) {
      window.localStorage.removeItem(keyOf(workspaceId));
      return;
    }
    const active = session.active && seen.has(pathKey(session.active)) ? session.active : null;
    window.localStorage.setItem(keyOf(workspaceId), JSON.stringify({ paths, active }));
  } catch {
    // 写不进去就只是下次启动恢复不了标签，不影响使用
  }
}

/** 防抖写入。标签打开 / 关闭 / 激活 / 重排都走它 */
export function scheduleSessionSave(workspaceId: string, session: EditorSession): void {
  const pending = timers.get(workspaceId);
  if (pending !== undefined) window.clearTimeout(pending);
  timers.set(
    workspaceId,
    window.setTimeout(() => {
      timers.delete(workspaceId);
      saveSession(workspaceId, session);
    }, SAVE_DELAY_MS),
  );
}

/** 关闭 / 移除工作区时清掉它的会话记录；挂起的写入也要取消，否则关完又写回来 */
export function clearSession(workspaceId: string): void {
  const pending = timers.get(workspaceId);
  if (pending !== undefined) {
    window.clearTimeout(pending);
    timers.delete(workspaceId);
  }
  try {
    window.localStorage.removeItem(keyOf(workspaceId));
  } catch {
    // 同 saveSession
  }
}
