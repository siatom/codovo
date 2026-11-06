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
  /**
   * 分区名：侧栏按它把工作区分成若干段，分区名作为一级标题展示。
   * 空 / 未设置即「未分区」，与有分区的工作区一起排在最后一段。
   */
  group?: string;
}

const WORKSPACES_KEY = "codovo.workspaceList";
const LAST_WORKSPACE_KEY = "codovo.lastWorkspace";
/** 分区的手动排序：只存名字数组，渲染时再和现有分区对齐（新分区追加在后面） */
const GROUP_ORDER_KEY = "codovo.workspaceGroupOrder";

// 上一版（项目模型）的两个键。只在首次迁移时读，**迁完不删**——
// 万一迁移有疏漏，用户原来的工作区列表还在，不至于凭空消失。
const LEGACY_PROJECTS_KEY = "codovo.projects";
const LEGACY_LAST_KEY = "codovo.lastProject";

// 更早的单根模型（一个工作区 == 一个目录）的三个键，同样只读不删。
const LEGACY_WORKSPACES_KEY = "codovo.workspaces";
const LEGACY_NAMES_KEY = "codovo.workspaceNames";
const LEGACY_CURRENT_KEY = "codovo.workspace";

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
    // 分区名只保留非空字符串；空串等价于未分区，不写进记录
    group: typeof raw.group === "string" && raw.group.trim() ? raw.group.trim() : undefined,
  };
}

/** 列表里出现过的分区名，去重后按显示顺序排好，供新建 / 编辑工作区时提示 */
export function workspaceGroupNames(list: Workspace[]): string[] {
  const names = new Set<string>();
  for (const workspace of list) {
    if (workspace.group) names.add(workspace.group);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
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
 * 迁移顺序：上一版项目模型（`codovo.projects`）优先，其次才是更早的单根模型。
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

/** 从列表里去掉一个工作区（只动 Codovo 的记录，不碰磁盘）。返回新列表 */
export function dropWorkspace(id: string): Workspace[] {
  const next = readWorkspaces().filter((item) => item.id !== id);
  saveWorkspaceList(next);
  return next;
}

/**
 * 重命名分区：属于该分区的工作区一起改到新名字（包括置顶、当前列表里看不到的）。
 * 目标名已存在时两段自然合并。返回写完之后的新列表。
 */
export function renameWorkspaceGroup(from: string, to: string): Workspace[] {
  const name = to.trim();
  const current = readWorkspaces();
  if (!name || name === from) return current;
  const next = current.map((workspace) =>
    workspace.group === from ? { ...workspace, group: name } : workspace,
  );
  saveWorkspaceList(next);
  return next;
}

/** 删除分区：只把其中的工作区移回「未分区」，工作区本身保留。返回新列表 */
export function clearWorkspaceGroup(name: string): Workspace[] {
  const next = readWorkspaces().map((workspace) =>
    workspace.group === name ? { ...workspace, group: undefined } : workspace,
  );
  saveWorkspaceList(next);
  return next;
}

/** 手动排出来的分区顺序。读到的坏值一律丢掉，名字去重 */
export function readWorkspaceGroupOrder(): string[] {
  try {
    const raw = window.localStorage.getItem(GROUP_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((item): item is string => typeof item === "string" && item.length > 0),
      ),
    ];
  } catch {
    return [];
  }
}

export function saveWorkspaceGroupOrder(names: string[]): void {
  try {
    window.localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify([...new Set(names)]));
  } catch {
    // 记不住就按活动顺序排，不影响使用
  }
}

export function readLastWorkspaceId(): string | null {
  try {
    // 上一版记在 codovo.lastProject 里，还没搬过就回落读它
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
    // 旧键必须一并清：readLastWorkspaceId 会回落到它，只清新键的话「关到空」这个状态
    // 根本留不住——下次启动照样从旧键里把工作区捞回来。旧键只是「上次开的是哪个」，
    // 不是工作区列表（列表在 codovo.projects / workspaceList 里，都不动），清掉不丢东西。
    window.localStorage.removeItem(LEGACY_LAST_KEY);
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
