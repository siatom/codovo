import { pathKey, samePath } from "./fs";

/**
 * 一个「工作区」：有名字、挂一个或多个工作目录。
 *
 * 更早的模型里「工作区」就是一串 root 路径，主键即路径；后来路径退化成工作区的一个字段，
 * 工作区自己有了 id——所以凡是原来拿 root 当键的地方（实例 key、handle 路由、
 * 各种「按工作区记」的偏好）都得改用它，否则一个工作区挂两个同名目录就撞了。
 */
export interface Workspace {
  id: string;
  /** 界面上的显示名。默认取主要根的目录名，可改；不改磁盘上的文件夹名 */
  name: string;
  /** 工作目录，至少一个。`roots[0]` 是「主要」根 */
  roots: string[];
  /** 工作区内当前活动根：终端 / 变更 / 智能体这些单根概念跟它走 */
  activeRoot: string;
  /** 置顶：排在工作区列表最前。老数据没有这个字段，缺省即不置顶 */
  pinned?: boolean;
}

const WORKSPACES_KEY = "codedock.workspaceList";
const LAST_WORKSPACE_KEY = "codedock.lastWorkspace";

// 上一版（项目模型）的两个键。只在首次迁移时读，**迁完不删**——
// 万一迁移有疏漏，用户原来的工作区列表还在，不至于凭空消失。
const LEGACY_PROJECTS_KEY = "codedock.projects";
const LEGACY_LAST_KEY = "codedock.lastProject";

// 更早的单根模型（一个工作区 == 一个目录）的三个键，同样只读不删。
const LEGACY_WORKSPACES_KEY = "codedock.workspaces";
const LEGACY_NAMES_KEY = "codedock.workspaceNames";
const LEGACY_CURRENT_KEY = "codedock.workspace";

/** 取路径最后一段当目录名；盘符根这类取不到就退回原串 */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * 迁移出来的工作区 id：由路径派生，同一个根每次算出来都一样。
 *
 * 不能用随机 id——迁移结果可能写不进 localStorage（隐私模式等），那样每次读都算一个
 * 新 id，React 的 key 和 handle 路由会跟着跳，界面实例被反复重建。
 */
function migratedId(root: string): string {
  let hash = 5381;
  const text = pathKey(root);
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return `p${hash.toString(16)}`;
}

export function newWorkspaceId(): string {
  // WebView2 / 现代浏览器都有；万一没有就退回时间戳 + 随机数，够用了
  return globalThis.crypto?.randomUUID?.() ?? `p${Date.now()}${Math.random()}`;
}

/** 从磁盘/别处读到的值不一定干净，逐字段校验，坏的丢掉而不是让界面炸掉 */
function normalizeWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  const roots = Array.isArray(raw.roots)
    ? raw.roots.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (!id || roots.length === 0) return null;
  // 活动根必须落在工作目录里，旧数据或手改过的值兜回主要根
  const active =
    typeof raw.activeRoot === "string" &&
    roots.some((root) => samePath(root, raw.activeRoot as string))
      ? (raw.activeRoot as string)
      : roots[0];
  return {
    id,
    name: name.trim() || folderName(roots[0]),
    roots,
    activeRoot: active,
    // 只有明确的 true 才算置顶，坏值一律当没置顶
    pinned: raw.pinned === true,
  };
}

export function readWorkspaces(): Workspace[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeWorkspace)
      .filter((item): item is Workspace => item !== null);
  } catch {
    return [];
  }
}

/** 整份写回工作区列表。只在本模块内部用，外部一律走 saveWorkspace / dropWorkspace */
function saveWorkspaceList(list: Workspace[]) {
  try {
    window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list));
  } catch {
    // 隐私模式等场景写不进去，忽略即可，只是下次启动不会自动打开
  }
}

function readLegacyList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function readLegacyNames(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(LEGACY_NAMES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const names: Record<string, string> = {};
    for (const [path, name] of Object.entries(parsed)) {
      if (typeof name === "string" && name.trim()) names[path] = name;
    }
    return names;
  } catch {
    return {};
  }
}

function readLegacyCurrent(): string | null {
  try {
    return window.localStorage.getItem(LEGACY_CURRENT_KEY);
  } catch {
    return null;
  }
}

/** 上一版（项目模型）的列表：结构一样，逐字段校验后直接拿来当工作区用 */
function readLegacyProjects(): Workspace[] {
  try {
    const raw = window.localStorage.getItem(LEGACY_PROJECTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeWorkspace)
      .filter((item): item is Workspace => item !== null);
  } catch {
    return [];
  }
}

/**
 * 启动时调一次：读新的工作区列表；没有就依次往前迁。
 *
 * 迁移顺序：上一版项目模型（`codedock.projects`）优先，其次才是更早的单根模型。
 * 单根的每个目录各自成为一个单根工作区——这正是当初的形态，用户看到的东西不变。
 */
export function migrateWorkspaces(): Workspace[] {
  const existing = readWorkspaces();
  if (existing.length > 0) return existing;

  const previous = readLegacyProjects();
  if (previous.length > 0) {
    saveWorkspaceList(previous);
    return previous;
  }

  const names = readLegacyNames();
  const list = readLegacyList(LEGACY_WORKSPACES_KEY).map((root) => {
    const alias = Object.keys(names).find((path) => samePath(path, root));
    return {
      id: migratedId(root),
      name: alias ? names[alias] : folderName(root),
      roots: [root],
      activeRoot: root,
    };
  });

  if (list.length > 0) {
    saveWorkspaceList(list);
    // 上次打开的目录 -> 记成「上次的工作区」，下次启动还开它
    const last = readLegacyCurrent();
    const match = last ? list.find((item) => samePath(item.roots[0], last)) : undefined;
    if (match) saveLastWorkspaceId(match.id);
  }
  return list;
}

/**
 * 落盘一个工作区（按 id 覆盖，没有就插到最前）。返回写完之后的新列表。
 *
 * 写之前先读一遍最新的：多窗口共享同一份 localStorage，直接拿本窗口记的列表覆盖，
 * 会把别的窗口刚建/刚改的工作区抹掉。
 */
export function saveWorkspace(workspace: Workspace): Workspace[] {
  const current = readWorkspaces();
  const index = current.findIndex((item) => item.id === workspace.id);
  const next =
    index === -1 ? [workspace, ...current] : current.map((item, i) => (i === index ? workspace : item));
  saveWorkspaceList(next);
  return next;
}

/** 从列表里去掉一个工作区（只动 CodeDock 的记录，不碰磁盘）。返回新列表 */
export function dropWorkspace(id: string): Workspace[] {
  const next = readWorkspaces().filter((item) => item.id !== id);
  saveWorkspaceList(next);
  return next;
}

export function readLastWorkspaceId(): string | null {
  try {
    // 上一版记在 codedock.lastProject 里，还没搬过就回落读它
    return (
      window.localStorage.getItem(LAST_WORKSPACE_KEY) ??
      window.localStorage.getItem(LEGACY_LAST_KEY)
    );
  } catch {
    return null;
  }
}

export function saveLastWorkspaceId(id: string) {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    // 同 saveWorkspaceList
  }
}

export function clearLastWorkspaceId() {
  try {
    window.localStorage.removeItem(LAST_WORKSPACE_KEY);
  } catch {
    // 同 saveWorkspaceList
  }
}

/**
 * 订阅「工作区列表被别的窗口改了」。返回取消订阅的函数。
 * storage 事件只在别的 document 触发，正好用来做跨窗口同步，不会自己回灌自己。
 */
export function onWorkspacesChanged(handler: (list: Workspace[]) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== WORKSPACES_KEY) return;
    handler(readWorkspaces());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
