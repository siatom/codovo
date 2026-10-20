import { useEffect, useState } from "react";
import { pathKey, toDisplayPath } from "./fs";

/**
 * 最近打开的文件。**全局一份**，不跟工作区走：用户换工作区后仍可能想打开刚才那个文件，
 * 而工作区被移除也不该连带抹掉最近记录。
 *
 * 只存绝对路径、显示名与时间，不存文件内容——最近列表是导航入口，不是缓存。
 */
export interface RecentFile {
  path: string;
  /** 显示名（文件名）。路径改名后旧记录自然会失效，打开时再做存在性校验 */
  name: string;
  /** 打开时间（Unix 毫秒） */
  openedAt: number;
}

const RECENT_KEY = "codedock.recentFiles";
/** 上限：再多就翻不动了，也没必要 */
const LIMIT = 50;
/** 本窗口内写入后通知订阅者；跨窗口走 storage 事件 */
const CHANGED_EVENT = "codedock:recent-files-changed";

/** 路径末级名字，兼容 Windows 的反斜杠 */
function baseName(path: string): string {
  return toDisplayPath(path).split("/").filter(Boolean).pop() ?? path;
}

/** 读到的值不一定干净（手改 / 旧版本），逐项校验并去重、按时间倒序 */
function normalizeList(value: unknown): RecentFile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: RecentFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.path !== "string" || raw.path.length === 0) continue;
    const key = pathKey(raw.path);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      path: raw.path,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : baseName(raw.path),
      openedAt:
        typeof raw.openedAt === "number" && Number.isFinite(raw.openedAt) ? raw.openedAt : 0,
    });
  }
  return list.sort((a, b) => b.openedAt - a.openedAt).slice(0, LIMIT);
}

export function readRecent(): RecentFile[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    return normalizeList(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function writeRecent(list: RecentFile[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // 隐私模式等场景写不进去，忽略即可，只是下次启动不再有记录
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/**
 * 记一次打开。按路径去重（Windows 不区分大小写），新的排最前，超出上限截断。
 *
 * 写前重读一遍：多个窗口共享同一份 localStorage，拿本窗口记的整份覆盖会把别的窗口
 * 刚写进去的记录抹掉。
 */
export function addRecent(path: string) {
  if (!path) return;
  const key = pathKey(path);
  const now = Date.now();
  const latest = readRecent().filter((item) => pathKey(item.path) !== key);
  writeRecent([{ path, name: baseName(path), openedAt: now }, ...latest].slice(0, LIMIT));
}

/** 从最近列表移除（文件已不存在、或用户主动清理） */
export function removeRecent(path: string) {
  const key = pathKey(path);
  const latest = readRecent();
  const next = latest.filter((item) => pathKey(item.path) !== key);
  if (next.length !== latest.length) writeRecent(next);
}

/** 订阅最近文件变化（本窗口 + 其他窗口）。返回取消订阅的函数 */
export function onRecentChanged(handler: () => void): () => void {
  const onLocal = () => handler();
  const onStorage = (event: StorageEvent) => {
    // key 为 null 表示 localStorage.clear()，也当作一次变化
    if (event.key === RECENT_KEY || event.key === null) handler();
  };
  window.addEventListener(CHANGED_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}

/** 组件里的最近文件快照。写入发生在编辑器读盘成功时，这里跟着刷新 */
export function useRecentFiles(): RecentFile[] {
  const [list, setList] = useState<RecentFile[]>(readRecent);
  useEffect(() => onRecentChanged(() => setList(readRecent())), []);
  return list;
}
