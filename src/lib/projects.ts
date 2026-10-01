import { pathKey, samePath } from "./fs";

/**
 * 一个「项目」：有名字、挂一个或多个源文件夹。
 *
 * 旧模型里「项目」就是一串 root 路径，主键即路径；现在路径退化成项目的一个字段，
 * 项目自己有了 id——所以凡是原来拿 root 当键的地方（实例 key、handle 路由、
 * 各种「按项目记」的偏好）都得改用它，否则一个项目挂两个同名目录就撞了。
 */
export interface Project {
  id: string;
  /** 界面上的显示名。默认取主要根的目录名，可改；不改磁盘上的文件夹名 */
  name: string;
  /** 源文件夹，至少一个。`roots[0]` 是「主要」根 */
  roots: string[];
  /** 项目内当前活动根：终端 / 变更 / 智能体这些单根概念跟它走 */
  activeRoot: string;
  /** 置顶：排在项目列表最前。老数据没有这个字段，缺省即不置顶 */
  pinned?: boolean;
}

const PROJECTS_KEY = "codedock.projects";
const LAST_PROJECT_KEY = "codedock.lastProject";

// 旧模型（一个项目 == 一个目录）的三个键。只在首次迁移时读，**迁完不删**——
// 万一迁移有疏漏，用户原来的项目列表还在，不至于凭空消失。
const LEGACY_WORKSPACES_KEY = "codedock.workspaces";
const LEGACY_NAMES_KEY = "codedock.workspaceNames";
const LEGACY_CURRENT_KEY = "codedock.workspace";

/** 取路径最后一段当目录名；盘符根这类取不到就退回原串 */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * 迁移出来的项目 id：由路径派生，同一个根每次算出来都一样。
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

export function newProjectId(): string {
  // WebView2 / 现代浏览器都有；万一没有就退回时间戳 + 随机数，够用了
  return globalThis.crypto?.randomUUID?.() ?? `p${Date.now()}${Math.random()}`;
}

/** 从磁盘/别处读到的值不一定干净，逐字段校验，坏的丢掉而不是让界面炸掉 */
function normalizeProject(value: unknown): Project | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  const roots = Array.isArray(raw.roots)
    ? raw.roots.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (!id || roots.length === 0) return null;
  // 活动根必须落在源文件夹里，旧数据或手改过的值兜回主要根
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

export function readProjects(): Project[] {
  try {
    const raw = window.localStorage.getItem(PROJECTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeProject)
      .filter((item): item is Project => item !== null);
  } catch {
    return [];
  }
}

export function saveProjects(list: Project[]) {
  try {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
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

/**
 * 启动时调一次：有新的项目列表就用它，没有就把旧的单根记录迁过来。
 *
 * 旧的每个目录各自成为一个单根项目——这正是当初的项目形态，用户看到的东西不变。
 */
export function migrateProjects(): Project[] {
  const existing = readProjects();
  if (existing.length > 0) return existing;

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
    saveProjects(list);
    // 上次打开的目录 -> 记成「上次的项目」，下次启动还开它
    const last = readLegacyCurrent();
    const match = last ? list.find((item) => samePath(item.roots[0], last)) : undefined;
    if (match) saveLastProjectId(match.id);
  }
  return list;
}

/**
 * 落盘一个项目（按 id 覆盖，没有就插到最前）。返回写完之后的新列表。
 *
 * 写之前先读一遍最新的：多窗口共享同一份 localStorage，直接拿本窗口记的列表覆盖，
 * 会把别的窗口刚建/刚改的项目抹掉。
 */
export function saveProject(project: Project): Project[] {
  const current = readProjects();
  const index = current.findIndex((item) => item.id === project.id);
  const next = index === -1 ? [project, ...current] : current.map((item, i) => (i === index ? project : item));
  saveProjects(next);
  return next;
}

/** 从列表里去掉一个项目（只动 CodeDock 的记录，不碰磁盘）。返回新列表 */
export function dropProject(id: string): Project[] {
  const next = readProjects().filter((item) => item.id !== id);
  saveProjects(next);
  return next;
}

export function readLastProjectId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function saveLastProjectId(id: string) {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // 同 saveProjects
  }
}

export function clearLastProjectId() {
  try {
    window.localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // 同 saveProjects
  }
}

/**
 * 订阅「项目列表被别的窗口改了」。返回取消订阅的函数。
 * storage 事件只在别的 document 触发，正好用来做跨窗口同步，不会自己回灌自己。
 */
export function onProjectsChanged(handler: (list: Project[]) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PROJECTS_KEY) return;
    handler(readProjects());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
