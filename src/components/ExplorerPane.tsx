import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { explainChange, useEffectiveAiConfig } from "../lib/ai";
import {
  copyEntry,
  createDirectory,
  createFile,
  deleteEntry,
  gitAddToIgnore,
  gitIgnored,
  isPathInside,
  listDir,
  moveEntry,
  onDirsChanged,
  ownerRoot,
  pathKey,
  renameEntry,
  searchFiles,
  toDisplayPath,
  type MovePair,
} from "../lib/fs";
import { matchesShortcut } from "../lib/shortcuts";
import { useSettings } from "../lib/settings";
import type { GitMark } from "../lib/git";
import type { FileEntry } from "../lib/types";
import {
  FileTreeNode,
  type CreateKind,
  type CreatingState,
  type RenamingState,
  type TreeController,
} from "./FileTreeNode";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExplainChangeDialog } from "./ExplainChangeDialog";
import {
  IconChevronDown,
  IconChevronRight,
  IconClipboard,
  IconCopy,
  IconExternalLink,
  IconEyeOff,
  IconFile,
  IconFolderOpen,
  IconFolderPlus,
  IconGlobe,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconScissors,
  IconSparkle,
  IconTrash,
  IconTree,
} from "./icons";

/** 文件模块标题栏通过 ref 指挥树做两件事：新建与重列。树自己不知道标题栏长什么样 */
export interface ExplorerPaneHandle {
  /** 新建文件 / 文件夹：落在当前选中的目录里（文件则落在它旁边），都没选就建在主要根 */
  create: (kind: CreateKind) => void;
  /** 重新列所有已展开的目录（含各个工作目录） */
  refresh: () => void;
}

interface ExplorerPaneProps {
  /** 工作区的全部工作目录：每一根在树里各成一棵子树，并列显示 */
  roots: string[];
  /**
   * 这个工作区是不是当前显示的。由隐藏切回可见时要补一次重列：目录监听只跟当前
   * 工作区（切走时后端整体换掉），后台期间这个根上的结构变化一条事件都收不到。
   */
  visible: boolean;
  selected: string | null;
  /** 归一化路径 -> git 标记，行尾那个字母 */
  gitMarks: ReadonlyMap<string, GitMark>;
  /** 工作区是不是 git 仓库。不是的话「加入 .gitignore」没有意义，不给这个菜单项 */
  isRepo: boolean;
  onSelect: (path: string) => void;
  /** 右键网页文件（html / htm / svg）→ 在右栏的内置浏览器里打开它 */
  onOpenInBrowser: (path: string) => void;
  /** 改名前的落盘；返回 false 表示有文件没存成功，改名要中止 */
  onBeforeRename: () => Promise<boolean>;
  /** 改名 / 移动成功：编辑器里落在旧路径下的标签要跟着换到新路径 */
  onRenamed: (moves: MovePair[]) => void;
  /** 删除成功：编辑器里落在这些路径下的标签要关掉（批量一次性提交） */
  onDeleted: (paths: string[]) => void;
  /**
   * 文件名过滤关键词，由文件模块统一的搜索框控制。非空时树只显示命中的文件
   * （空串 = 正常树）。搜内容和搜文件名共用这一个关键词，切模式时不用重敲
   */
  query: string;
  /** 清掉过滤关键词（改名 / 删除 / 移动后过滤结果里的路径已经失效） */
  onClearQuery: () => void;
  /** 模块标题栏要指挥树新建 / 重列；React 19 起 ref 可以直接当普通 prop 传 */
  ref?: Ref<ExplorerPaneHandle>;
}

/** 输入停下来多久才去搜，省得每敲一个字都跑一趟目录遍历 */
const SEARCH_DEBOUNCE_MS = 200;

/** 过滤模式下这两个集合没有意义，共用同一份引用免得 useMemo 每次都失效 */
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

/**
 * 右键菜单宽度：按最长的「在文件管理器中显示」估出来（图标 + 间距 + 8 个中文字 +
 * 左右内边距），贴着窗口边缘时用它往回收。窄了这一行就会折成两行。
 */
const MENU_W = 168;
// 菜单最多 12 项（含几处按条件出现的项）+ 最多 5 条分组分隔线；按每项 ~24px、
// 每条分隔线 ~9px 估。宁可估大，估小了贴底的菜单会被窗口下沿裁掉
// （这个值只用于把菜单顶回可视区）。
const MENU_H = 380;
/**
 * 根菜单（树里空白处 / 工作目录标题行）的高度：最多 6 项 + 2 条分隔线，按上面的估法
 * 约 170px。同样宁可估大，贴底右键时把菜单顶回可视区。
 */
const ROOT_MENU_H = 208;
/** 菜单项统一「图标 + 文字」两段；nowrap 免得长文案折行 */
const MENU_ITEM =
  "flex items-center gap-2 whitespace-nowrap px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";
/** 分组之间的一条细线 */
const MENU_DIVIDER = "my-1 h-px shrink-0 bg-line";

/** 所在目录。改名/删除之后要重新列的就是它 */
function parentOf(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const index = path.lastIndexOf(separator);
  return index > 0 ? path.slice(0, index) : path;
}

/** 末级目录名，取不到就退回整个路径 */
function folderName(path: string): string {
  return toDisplayPath(path).split("/").filter(Boolean).pop() ?? path;
}

/** 路径末级名字（文件或目录都行）。合成只用于展示的条目时用。 */
function baseName(path: string): string {
  return toDisplayPath(path).split("/").filter(Boolean).pop() ?? path;
}

/**
 * 能不能丢进内置浏览器预览：网页文档和浏览器能直接渲染的矢量图。
 * 和编辑器那边的图片预览是两回事（`svg` 在编辑器里是当文本打开的）。
 */
function isWebFile(path: string): boolean {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot + 1);
  return ext === "html" || ext === "htm" || ext === "svg";
}

/** 去掉被同一批里另一个路径包含的项：移动 / 删除父项已经连带处理了子项 */
function pruneNested(paths: string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && isPathInside(path, other)));
}

/** 批量删除确认框的文案 */
function deleteMessage(items: FileEntry[]): string {
  if (items.length === 1) {
    const entry = items[0];
    return entry.isDir
      ? `删除文件夹「${entry.name}」及其中全部内容？此操作不可撤销。`
      : `删除文件「${entry.name}」？此操作不可撤销。`;
  }
  return `删除选中的 ${items.length} 项？此操作不可撤销。`;
}

/** roots 数组每次渲染都是新引用，effect 的依赖得靠这个字符串来判断「换没换」 */
function rootsKeyOf(roots: string[]): string {
  return roots.map((root) => pathKey(root)).join("\u0000");
}

/**
 * 写系统剪贴板。走 Tauri 的 clipboard 插件而不是 `navigator.clipboard`：
 * WebView 那套要文档有焦点、WebView2 还会弹一个系统授权框（实测点一次
 * 「复制路径」就跳出去），插件是从 Rust 侧直接写系统剪贴板，三端都不问人。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface FilterTree {
  /** 每个工作目录下要显示的项，按根分组 */
  rootEntries: Map<string, FileEntry[]>;
  /** 目录绝对路径 -> 该目录下要显示的项 */
  children: Map<string, FileEntry[]>;
  /** 所有需要展开的祖先目录 */
  dirs: Set<string>;
}

/**
 * 把命中文件的绝对路径拼回一棵树：只留通往命中项的目录和文件本身。
 * 路径全是后端给的，所以祖先目录直接按路径合成即可，不用再 listDir 一遍。
 * 多根时每条命中项按它所属的根分组，免得两条来自不同工作目录的路径拼到一根上。
 */
function buildFilter(roots: string[], hits: string[]): FilterTree {
  const rootEntries = new Map<string, FileEntry[]>();
  const children = new Map<string, FileEntry[]>();
  const dirs = new Set<string>();
  const seen = new Set<string>();

  const push = (parent: string, entry: FileEntry) => {
    const key = `${pathKey(parent)}\u0000${pathKey(entry.path)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (roots.some((root) => pathKey(root) === pathKey(parent))) {
      const list = rootEntries.get(parent);
      if (list) list.push(entry);
      else rootEntries.set(parent, [entry]);
      return;
    }
    const found = children.get(parent);
    if (found) found.push(entry);
    else children.set(parent, [entry]);
  };

  for (const hit of hits) {
    const root = ownerRoot(roots, hit);
    if (!root) continue;
    // 后端给的路径一定是 root + 分隔符 + 相对路径，分隔符直接读那一位，不用猜
    const sep = hit.charAt(root.length);
    if (sep !== "/" && sep !== "\\") continue;
    const parts = hit.slice(root.length + 1).split(sep);

    let parent = root;
    let prefix = root;
    for (let i = 0; i < parts.length; i += 1) {
      prefix = `${prefix}${sep}${parts[i]}`;
      const isLast = i === parts.length - 1;
      // 搜索结果是从命令行拿的，没有 stat：modified 给 0，悬停时显示「未知」
      push(parent, { name: parts[i], path: prefix, isDir: !isLast, modified: 0 });
      if (!isLast) dirs.add(prefix);
      parent = prefix;
    }
  }

  return { rootEntries, children, dirs };
}

export function ExplorerPane({
  roots,
  visible,
  selected,
  gitMarks,
  isRepo,
  onSelect,
  onOpenInBrowser,
  onBeforeRename,
  onRenamed,
  onDeleted,
  query,
  onClearQuery,
  ref,
}: ExplorerPaneProps) {
  /** 每个工作目录的顶层条目，按根分组 */
  const [entries, setEntries] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [rootError, setRootError] = useState<string | null>(null);
  /** 归一化路径 -> 被 .gitignore 忽略了。按它把行置灰 */
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);
  /**
   * 树里当前"选中的那一行"。编辑器切标签时跟着走（外面传进来的 `selected`），
   * 点目录则落在目录上——新建就建在选中的那一行里，目录也不例外。
   */
  const [activeRow, setActiveRow] = useState<string | null>(null);

  /** 多选集合：归一化路径 -> 条目。存条目对象，收起的目录里的选中项也留得住 */
  const [selection, setSelection] = useState<Map<string, FileEntry>>(new Map());
  /** Shift 连选的锚点（归一化路径） */
  const anchorRef = useRef<string | null>(null);
  /** 正在拖的路径（绝对路径，已去掉被父项包含的项）；非空即处于拖拽中 */
  const [dragging, setDragging] = useState<string[]>([]);
  /** 当前悬停到的可投放目录（归一化路径），画高亮 */
  const [dropDir, setDropDir] = useState<string | null>(null);
  /** 树滚动容器的 ref：键盘移动焦点时按 data-row-key 找行 */
  const scrollRef = useRef<HTMLDivElement>(null);

  // 右键菜单：开在哪一行、贴光标多远处。位置用 fixed 定位，所以要的是视口坐标
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  /** 等着确认删除的那一批；非空时弹确认框 */
  const [pendingDelete, setPendingDelete] = useState<FileEntry[] | null>(null);

  /**
   * 应用内的文件剪贴板：复制 / 剪切的是路径列表，`cut` 为 true 表示粘贴时要移动。
   * 刻意不用系统剪贴板——剪贴板插件只能写文本，表达不了"一批文件"和"剪切"标记。
   * 每个工作区一个 ExplorerPane 实例，所以剪贴板天然按工作区分开、切走也留得住。
   */
  const [clipboard, setClipboard] = useState<{ paths: string[]; cut: boolean } | null>(null);
  /** 粘贴时目标目录已有同名项，等用户确认覆盖。非空时弹确认框 */
  const [pendingPaste, setPendingPaste] = useState<{ targetDir: string; conflicts: string[] } | null>(
    null,
  );
  /** 根相关的右键菜单（只放「粘贴」）：工作目录标题行与树里的空白处都开它，
   *  好让空目录 / 没有行可右键的地方也能粘进去 */
  const [rootMenu, setRootMenu] = useState<{ root: string; x: number; y: number } | null>(null);
  /** 改名 / 删除正在跑，期间不再接第二次 */
  const [busy, setBusy] = useState(false);
  /** 改名 / 删除失败的原因，挂在树顶上 */
  const [actionError, setActionError] = useState<string | null>(null);

  /** AI 文件解析的结果弹窗；null = 没开 */
  const [explain, setExplain] = useState<{
    title: string;
    text: string | null;
    error: string | null;
  } | null>(null);
  /** 关掉弹窗后迟到的响应不该把它弹回来，用序号丢弃（同 GitChangesPane） */
  const explainSeq = useRef(0);

  const { settings } = useSettings();
  const { config: aiConfig, ready: aiReady } = useEffectiveAiConfig();

  // 文件名过滤：关键词由文件模块的搜索框给，非空即进入过滤模式
  /** null = 还没拿到结果 */
  const [hits, setHits] = useState<string[] | null>(null);
  /** 过滤模式下被用户单独收起的目录 */
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(new Set());
  /** 多根并列时被整块收起的工作目录（归一化路径）。收起后只留根名那一行 */
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());

  const activeQuery = query.trim();
  const filtering = activeQuery.length > 0;

  const rootsKey = rootsKeyOf(roots);
  /** 上一次渲染的工作目录键：用来区分「换了工作目录」和「点了刷新」 */
  const lastRootsKey = useRef(rootsKey);
  /** 主要根：点空白、没选题时新建都落在这里 */
  const primaryRoot = roots[0] ?? "";

  // 打开/切换文件时把焦点带回那一行。只在 selected 变化时同步，
  // 所以点目录选中的那一行不会被这条 effect 反复抢走。
  // 选中集合也一并收敛到这一个文件——编辑器切标签就等于树里单选了它。
  useEffect(() => {
    setActiveRow(selected);
    if (selected) {
      const key = pathKey(selected);
      anchorRef.current = key;
      setSelection(new Map([[key, { name: baseName(selected), path: selected, isDir: false, modified: 0 }]]));
    }
  }, [selected]);

  const focusRow = activeRow ?? selected;

  /** 这个路径是不是某一个工作目录本身 */
  const isRootPath = useCallback(
    (path: string) => roots.some((root) => pathKey(root) === pathKey(path)),
    [roots],
  );

  /** 收起 / 展开一个工作目录的整棵子树 */
  const toggleRoot = useCallback((root: string) => {
    const key = pathKey(root);
    setCollapsedRoots((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 工作目录一变（换了工作区、或改了它的工作目录），整棵树的展开状态就作废了
  useEffect(() => {
    setExpanded(new Set());
    setChildren(new Map());
    setLoading(new Set());
    setErrors(new Map());
    setRootError(null);
    setIgnored(new Set());
    // 换了工作目录时，搜索命中的是上一个工作区的路径，关键词一并清掉；
    // 只是点「刷新」（reloadKey 变）时保留关键词，别让过滤状态莫名退出
    if (lastRootsKey.current !== rootsKey) {
      lastRootsKey.current = rootsKey;
      onClearQuery();
    }
    setHits(null);
    setFilterCollapsed(new Set());
    // 工作目录可能整个换掉了，收起的键跟着作废；默认只展开第一个根，其余收起
    setCollapsedRoots(new Set(roots.slice(1).map(pathKey)));
    // 就地改名/菜单里的那一行也属于旧工作区
    setRenaming(null);
    setRenameError(null);
    setMenu(null);
    setRootMenu(null);
    setPendingDelete(null);
    setPendingPaste(null);
    setActionError(null);
    // 剪贴板里存的是上一个工作区的路径，换工作目录就作废，别拿失效路径去粘
    setClipboard(null);
    // 多选与拖拽状态同样按工作区作废
    setSelection(new Map());
    anchorRef.current = null;
    setDragging([]);
    setDropDir(null);
    // 解析弹窗里是上一个工作区的内容，序号推进掉在途的请求
    explainSeq.current += 1;
    setExplain(null);

    // 上一个工作区的请求可能还在飞，它回来时已经属于旧工作区了，必须丢掉：
    // 否则后端会按新工作区校验旧路径，把"路径越界"盖到刚加载好的新目录上
    let cancelled = false;
    void Promise.all(
      roots.map((root) =>
        listDir(root, root).then(
          (listed) => ({ root, listed, error: null as string | null }),
          (reason) => ({ root, listed: [] as FileEntry[], error: String(reason) }),
        ),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<string, FileEntry[]>();
      const problems: string[] = [];
      for (const item of results) {
        next.set(item.root, item.listed);
        // 一个根本来不了（被删了/换盘了）不该让整棵树空着，标出是哪个
        if (item.error) problems.push(`${folderName(item.root)}：${item.error}`);
      }
      setEntries(next);
      setRootError(problems.length > 0 ? problems.join("\n") : null);
    });

    return () => {
      cancelled = true;
    };
  }, [rootsKey, reloadKey, onClearQuery]);

  // 搜索：防抖 + 丢弃过期结果（查询一变，上一趟回来时已经被取消）
  useEffect(() => {
    if (!filtering) {
      setHits(null);
      return;
    }
    setFilterCollapsed(new Set());

    let cancelled = false;
    const timer = window.setTimeout(() => {
      // 多根就每根各搜一趟再合并——后端一次只认一个根
      void Promise.all(
        roots.map((root) => searchFiles(root, activeQuery).catch(() => [] as string[])),
      )
        .then((lists) => {
          if (!cancelled) setHits(lists.flat());
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filtering, activeQuery, rootsKey]);

  /** 过滤结果失效时清掉关键词（关键词归文件模块的搜索框管，这里只能请求它清空） */
  const dropFilter = useCallback(() => {
    onClearQuery();
    setHits(null);
    setFilterCollapsed(new Set());
  }, [onClearQuery]);

  const toggle = useCallback(
    async (entry: FileEntry) => {
      if (!entry.isDir) return;
      const { path } = entry;
      const owner = ownerRoot(roots, path);
      if (!owner) return;

      // 展开状态一律读渲染时的快照，不能靠 setState 的 updater 里赋值：
      // React 只在更新队列干净时才顺手跑一次 updater，否则要等到渲染阶段，
      // 那时这里的判断早就执行完了——结果就是图标变成了展开态却从没发起加载。
      // 点目录也算选中它：新建会落在这个目录里
      setActiveRow(path);

      if (expanded.has(path)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
        return;
      }

      setExpanded((current) => new Set(current).add(path));
      if (children.has(path)) return;

      setLoading((current) => new Set(current).add(path));
      try {
        const listed = await listDir(owner, path);
        setChildren((current) => new Map(current).set(path, listed));
        setErrors((current) => {
          if (!current.has(path)) return current;
          const next = new Map(current);
          next.delete(path);
          return next;
        });
      } catch (reason) {
        setErrors((current) => new Map(current).set(path, String(reason)));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    },
    [expanded, children, roots],
  );

  /**
   * 重新列一个目录。只认已经在树里的目录：没展开过的目录没人看，
   * 展开时自然会去读最新的。
   */
  const refreshDir = useCallback(
    async (dir: string) => {
      const owner = ownerRoot(roots, dir);
      if (!owner) return;
      try {
        const listed = await listDir(owner, dir);
        if (isRootPath(dir)) {
          // 顶层条目按根存，别把 A 根的列表写到 B 根上
          setEntries((current) => new Map(current).set(owner, listed));
          return;
        }
        setChildren((current) =>
          // 这一轮里目录可能已经被收起（缓存丢掉）了，那就别把它塞回来
          current.has(dir) ? new Map(current).set(dir, listed) : current,
        );
      } catch {
        // 目录可能刚好在同一次批量里被删掉，忽略；父目录的刷新会把它从树里摘掉
      }
    },
    [roots, isRootPath],
  );

  /** 工作区内的相对路径，一律用 `/` 分隔——粘到代码、终端、文档里都能直接用 */
  const relativePath = useCallback(
    (path: string) => {
      const full = toDisplayPath(path);
      const owner = ownerRoot(roots, path);
      if (!owner) return full;
      const base = toDisplayPath(owner).replace(/\/+$/, "");
      return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
    },
    [roots],
  );

  /** 右键一行：先把它选中（跟 VS Code 一样，右键同时改变选中项），再开菜单 */
  const openMenu = useCallback(
    (entry: FileEntry, event: MouseEvent) => {
      event.preventDefault();
      const key = pathKey(entry.path);
      // 右键已在选中集合里的行时保留整批（菜单里的删除会对整批生效）
      if (!selection.has(key)) {
        setSelection(new Map([[key, entry]]));
        anchorRef.current = key;
      }
      setActiveRow(entry.path);
      setActionError(null);
      setMenu({ entry, x: event.clientX, y: event.clientY });
    },
    [selection],
  );

  const copyPath = useCallback(async (text: string) => {
    setMenu(null);
    setRootMenu(null);
    if (!(await copyText(text))) setActionError("复制失败：系统剪贴板不可用");
  }, []);

  /**
   * 交给系统处理这一行：在文件管理器里定位它、或用默认关联程序打开它。
   * 两件事失败都只是「打不开」（路径可能已被删或改名），不保留菜单、就地提示。
   */
  const revealInSystem = useCallback(async (path: string) => {
    setMenu(null);
    setRootMenu(null);
    setActionError(null);
    try {
      await revealItemInDir(path);
    } catch (reason) {
      setActionError(`无法在文件管理器中显示：${String(reason)}`);
    }
  }, []);

  const openWithSystem = useCallback(async (entry: FileEntry) => {
    setMenu(null);
    setActionError(null);
    try {
      await openPath(entry.path);
    } catch (reason) {
      setActionError(`无法打开：${String(reason)}`);
    }
  }, []);

  /**
   * 把这一行丢给右栏的内置浏览器预览。切到哪个模块、面板怎么展开由外层决定，
   * 这里只管发起——文件树不该知道右栏的事。
   */
  const openInBrowser = useCallback(
    (entry: FileEntry) => {
      setMenu(null);
      setActionError(null);
      onOpenInBrowser(entry.path);
    },
    [onOpenInBrowser],
  );

  /** 把这一行加进它所属根的 .gitignore，然后重列那个根让置灰立刻生效 */
  const addToIgnore = useCallback(
    async (entry: FileEntry) => {
      setMenu(null);
      setActionError(null);
      const owner = ownerRoot(roots, entry.path);
      if (!owner) return;
      try {
        await gitAddToIgnore(owner, entry.path);
        // 后端的 watcher 也会报 .gitignore 的改动，但得等 300ms 防抖；这里直接
        // 重列一次：重列会换掉 entries 的引用，忽略状态那个 effect 跟着重算
        await refreshDir(owner);
      } catch (reason) {
        setActionError(String(reason));
      }
    },
    [roots, refreshDir],
  );

  /**
   * 让 AI 说明这个文件的职责与实现逻辑，结果摆在弹窗里。只读：不动文件内容。
   *
   * 配置不全时不发请求，直接把设置页的提示放进弹窗——和「变更解读」那边一个口径。
   */
  const startExplainFile = useCallback(
    (entry: FileEntry) => {
      setMenu(null);
      const title = relativePath(entry.path);
      if (!aiReady) {
        setExplain({
          title,
          text: null,
          error: "请先在「设置 → AI」里填写接口地址、模型和密钥",
        });
        return;
      }
      const owner = ownerRoot(roots, entry.path);
      if (!owner) {
        setExplain({ title, text: null, error: "这个路径不在任何工作目录里" });
        return;
      }

      const seq = (explainSeq.current += 1);
      setExplain({ title, text: null, error: null });
      // source 传 null：解读整个文件，而不是某次改动
      void explainChange(owner, aiConfig, entry.path, null)
        .then((text) => {
          if (explainSeq.current === seq) setExplain({ title, text, error: null });
        })
        .catch((reason) => {
          if (explainSeq.current === seq) setExplain({ title, text: null, error: String(reason) });
        });
    },
    [aiConfig, aiReady, relativePath, roots],
  );

  const closeExplain = useCallback(() => {
    // 序号先推进：请求这时才回来的话，不要再把弹窗弹回来
    explainSeq.current += 1;
    setExplain(null);
  }, []);

  const startRename = useCallback((entry: FileEntry) => {
    setMenu(null);
    setActionError(null);
    setRenameError(null);
    setRenaming({ path: entry.path, original: entry.name, value: entry.name });
  }, []);

  const submitRename = useCallback(async () => {
    if (!renaming || busy) return;
    const name = renaming.value.trim();
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      setRenameError("名称无效");
      return;
    }
    // 名字没动就别白跑一趟后端，也免得下面把编辑器里的 model 丢掉重读
    if (name === renaming.original) {
      setRenaming(null);
      return;
    }

    const { path } = renaming;
    const owner = ownerRoot(roots, path);
    if (!owner) {
      setRenameError("这个路径不在任何工作目录里");
      return;
    }
    setBusy(true);
    setRenameError(null);
    try {
      // 先落盘：下面编辑器会丢掉旧 model、按新路径重读，没存下来的改动会跟着一起没
      if (!(await onBeforeRename())) {
        setRenameError("有文件没保存成功，已取消重命名");
        return;
      }
      const next = await renameEntry(owner, path, name);
      setRenaming(null);
      setActiveRow(next);
      // 改名等价于把这一项移到同目录下的新名字，走同一条标签重定向
      onRenamed([{ from: path, to: next }]);
      // 选中集合指向旧路径的也换过来
      setSelection((current) => {
        if (!current.has(pathKey(path))) return current;
        const entry = current.get(pathKey(path));
        if (!entry) return current;
        const map = new Map(current);
        map.delete(pathKey(path));
        map.set(pathKey(next), { ...entry, name: baseName(next), path: next });
        return map;
      });
      await refreshDir(parentOf(path));
      // 过滤模式下的结果是按旧路径拼的，改完名字就作废了
      if (filtering) dropFilter();
    } catch (reason) {
      setRenameError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [renaming, busy, roots, onBeforeRename, onRenamed, refreshDir, filtering, dropFilter]);

  /** 请求删除：这一行在选中集合里就删整批（VS Code 语义），否则只删它自己 */
  const requestDelete = useCallback(
    (entry: FileEntry) => {
      setMenu(null);
      const items = selection.has(pathKey(entry.path))
        ? [...selection.values()]
        : [entry];
      if (items.length > 0) setPendingDelete(items);
    },
    [selection],
  );

  const confirmDelete = useCallback(async () => {
    const items = pendingDelete;
    if (!items || items.length === 0 || busy) return;
    setPendingDelete(null);
    setBusy(true);
    setActionError(null);
    // 父项和子项同批时只删父项，避免"删完父项再删已经不存在的子项"报错
    const paths = pruneNested(items.map((entry) => entry.path));
    const removed: string[] = [];
    const failures: string[] = [];
    for (const path of paths) {
      const owner = ownerRoot(roots, path);
      if (!owner) {
        failures.push(`这个路径不在任何工作目录里: ${path}`);
        continue;
      }
      try {
        await deleteEntry(owner, path);
        removed.push(path);
      } catch (reason) {
        failures.push(String(reason));
      }
    }

    if (removed.length > 0) {
      // 锚点若落在被删项里，退回它所在的目录
      if (activeRow && removed.some((path) => isPathInside(activeRow, path))) {
        setActiveRow(parentOf(removed[0]));
      }
      // 一次批量关标签：逐个调用会各算各的旧 openTabs，只剩最后一个生效
      onDeleted(removed);
      setSelection(new Map());
      anchorRef.current = null;
      for (const dir of new Set(removed.map(parentOf))) await refreshDir(dir);
      if (filtering) dropFilter();
    }
    if (failures.length > 0) setActionError(failures.join("\n"));
    setBusy(false);
  }, [pendingDelete, busy, activeRow, roots, onDeleted, refreshDir, filtering, dropFilter]);

  /** 这批操作要处理哪些路径：点在选中集合里的行就取整批（VS Code 语义），否则只它自己 */
  const collectPaths = useCallback(
    (entry: FileEntry) =>
      pruneNested(
        selection.has(pathKey(entry.path))
          ? [...selection.values()].map((item) => item.path)
          : [entry.path],
      ),
    [selection],
  );

  /** 复制到应用内剪贴板，源不动 */
  const doCopy = useCallback(
    (entry: FileEntry) => {
      setMenu(null);
      setRootMenu(null);
      setActionError(null);
      setClipboard({ paths: collectPaths(entry), cut: false });
    },
    [collectPaths],
  );

  /** 剪切：粘贴时走移动。工作区根不参与（后端也会拒） */
  const doCut = useCallback(
    (entry: FileEntry) => {
      setMenu(null);
      setRootMenu(null);
      setActionError(null);
      const paths = collectPaths(entry).filter((path) => !isRootPath(path));
      if (paths.length === 0) return;
      setClipboard({ paths, cut: true });
    },
    [collectPaths, isRootPath],
  );

  /** 真正执行粘贴。`overwrite` 只在目标已有同名项、且用户确认覆盖后为 true */
  const runPaste = useCallback(
    async (targetDir: string, overwrite: boolean) => {
      const clip = clipboard;
      if (!clip || clip.paths.length === 0 || busy) return;
      const toOwner = ownerRoot(roots, targetDir);
      if (!toOwner) {
        setActionError(`目标不在任何工作目录里: ${targetDir}`);
        return;
      }
      setBusy(true);
      setActionError(null);
      try {
        // 剪切是移动，会丢掉旧 model，未保存的改动跟着一起没——先落盘
        if (clip.cut && !(await onBeforeRename())) {
          setActionError("有文件没保存成功，已取消粘贴");
          return;
        }
        const moves: MovePair[] = [];
        const done: string[] = [];
        const failures: string[] = [];
        for (const path of clip.paths) {
          const fromOwner = ownerRoot(roots, path);
          if (!fromOwner) {
            failures.push(`这个路径不在任何工作目录里: ${path}`);
            continue;
          }
          try {
            if (clip.cut) {
              const to = await moveEntry({
                fromRoot: fromOwner,
                path,
                toRoot: toOwner,
                targetDir,
                overwrite,
              });
              moves.push({ from: path, to });
            } else {
              await copyEntry({ fromRoot: fromOwner, path, toRoot: toOwner, targetDir, overwrite });
            }
            done.push(path);
          } catch (reason) {
            failures.push(String(reason));
          }
        }

        if (moves.length > 0) {
          // 编辑器里落在旧路径下的标签一次重定向到新路径
          onRenamed(moves);
          setActiveRow(moves[0].to);
          // 选中集合跟着挪到新路径，移动后仍高亮
          setSelection((current) => {
            if (current.size === 0) return current;
            const next = new Map<string, FileEntry>();
            for (const item of current.values()) {
              const move = moves.find((candidate) => pathKey(candidate.from) === pathKey(item.path));
              const path = move ? move.to : item.path;
              next.set(pathKey(path), move ? { ...item, path, name: baseName(path) } : item);
            }
            return next;
          });
        }

        if (done.length > 0) {
          // 目标目录，以及各个源所在目录（剪切时那边少了一项）都要重列
          for (const dir of new Set<string>([targetDir, ...done.map(parentOf)])) {
            await refreshDir(dir);
          }
          if (filtering) dropFilter();
        }

        // 剪切后成功的项要从剪贴板摘掉，失败的留着——否则下次粘贴会重放已经搬走的源。
        // 复制则整份保留，可以反复粘贴
        if (clip.cut) {
          const remaining = clip.paths.filter((path) => !done.includes(path));
          setClipboard(remaining.length > 0 ? { paths: remaining, cut: true } : null);
        }

        if (failures.length > 0) setActionError(failures.join("\n"));
      } finally {
        setBusy(false);
      }
    },
    [clipboard, busy, roots, onBeforeRename, onRenamed, refreshDir, filtering, dropFilter],
  );

  /**
   * 粘贴前的探测：只判断会不会撞名，不落盘。
   *
   * 「先跑一遍，撞了再确认覆盖后重试」是错的——剪切场景下第一趟已经把源搬走了，
   * 重试时源早不在原处。所以必须先在内存里把冲突找齐、用户确认之后才一次性执行。
   */
  const doPaste = useCallback(
    async (targetDir: string) => {
      const clip = clipboard;
      if (!clip || clip.paths.length === 0 || busy) return;
      const toOwner = ownerRoot(roots, targetDir);
      if (!toOwner) {
        setActionError(`目标不在任何工作目录里: ${targetDir}`);
        return;
      }
      const separator = targetDir.includes("\\") ? "\\" : "/";

      let existing: Set<string>;
      try {
        const listed = await listDir(toOwner, targetDir);
        existing = new Set(listed.map((item) => pathKey(`${targetDir}${separator}${item.name}`)));
      } catch (reason) {
        setActionError(String(reason));
        return;
      }

      const conflicts: string[] = [];
      const seen = new Set<string>();
      for (const path of clip.paths) {
        const target = `${targetDir}${separator}${baseName(path)}`;
        // 目标就是源自己（同目录粘贴）：交给后端报「不能粘贴到原位置」，不算覆盖冲突
        if (pathKey(target) === pathKey(path)) continue;
        // 批内同名：好几个源要落成同一个目标，放不进来
        if (seen.has(pathKey(target))) {
          setActionError("选中的项里有同名文件，无法放到同一个目录");
          return;
        }
        seen.add(pathKey(target));
        if (existing.has(pathKey(target))) conflicts.push(baseName(path));
      }

      if (conflicts.length > 0) {
        setPendingPaste({ targetDir, conflicts });
        return;
      }
      await runPaste(targetDir, false);
    },
    [clipboard, busy, roots, runPaste],
  );

  /** 右键项的粘贴目标：目录就粘进它，文件就粘进它所在目录（照 VS Code） */
  const requestPaste = useCallback(
    (entry: FileEntry) => {
      setMenu(null);
      setRootMenu(null);
      void doPaste(entry.isDir ? entry.path : parentOf(entry.path));
    },
    [doPaste],
  );

  /** 当前已经在树里、值得跟着磁盘刷新的目录（含全部工作目录） */
  const loadedDirs = useMemo(() => {
    const keys = new Set<string>(roots.map((root) => pathKey(root)));
    for (const dir of children.keys()) keys.add(pathKey(dir));
    return keys;
  }, [rootsKey, children]);

  /** 同上，但要的是真实路径——`loadedDirs` 存的是归一化 key，不能直接喂给后端 */
  const loadedDirPaths = useMemo(() => {
    const list = new Set<string>(roots);
    for (const dir of children.keys()) list.add(dir);
    return [...list];
  }, [rootsKey, children]);

  // 磁盘上的目录结构变了就跟着刷新。订阅只建一次：回调通过 ref 拿最新的
  // 目录快照，否则每展开一个目录都要重新 listen 一遍
  const loadedDirsRef = useRef(loadedDirs);
  const loadedDirPathsRef = useRef(loadedDirPaths);
  const refreshDirRef = useRef(refreshDir);
  // 必须排在下面那个订阅 effect 前面：挂载时它先跑，ref 里才是当前工作区的版本
  useEffect(() => {
    loadedDirsRef.current = loadedDirs;
    loadedDirPathsRef.current = loadedDirPaths;
    refreshDirRef.current = refreshDir;
  }, [loadedDirs, loadedDirPaths, refreshDir]);

  /**
   * 工作区从隐藏切回可见时补一次重列。目录监听只跟当前工作区，后台期间这个根上的
   * 结构变化（终端跑构建、git checkout 生成/删掉文件）全错过了，回到前台时后端才
   * 恢复监听、事件早发完了，不补就得手动点刷新。只重列已经在树里的目录，展开态不丢。
   */
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      for (const dir of loadedDirPathsRef.current) void refreshDirRef.current(dir);
    }
    wasVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void onDirsChanged((dirs) => {
      for (const dir of dirs) {
        if (loadedDirsRef.current.has(pathKey(dir))) void refreshDirRef.current(dir);
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /** 过滤模式下点目录只是收起/展开，不用去加载——子项已经在手里了 */
  const toggleFilter = useCallback((entry: FileEntry) => {
    if (!entry.isDir) return;
    setActiveRow(entry.path);
    setFilterCollapsed((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }, []);

  const loadedEntries = useMemo(() => {
    const all: FileEntry[] = [];
    for (const listed of entries.values()) all.push(...listed);
    for (const listed of children.values()) all.push(...listed);
    return all;
  }, [entries, children]);

  /**
   * 哪些条目被 .gitignore 忽略了。判定交给 git（后端 `check-ignore`），前端不解析规则。
   *
   * 拿的是**全部已加载条目**而不是刚列出来的那个目录：这样整体替换、不用做增量合并，
   * 也不会有残留的旧状态。`loadedEntries` 每次列目录都会换新对象，所以展开目录、
   * `fs-changed` 重列、改了 .gitignore（watcher 会把它的父目录报上来）都会自动重算。
   * 多根时按所属根分组问，一次 `git_ignored` 只认一个根。
   */
  useEffect(() => {
    if (loadedEntries.length === 0) {
      setIgnored(new Set());
      return;
    }
    const byRoot = new Map<string, string[]>();
    for (const entry of loadedEntries) {
      const owner = ownerRoot(roots, entry.path);
      if (!owner) continue;
      const list = byRoot.get(owner);
      if (list) list.push(entry.path);
      else byRoot.set(owner, [entry.path]);
    }
    if (byRoot.size === 0) {
      setIgnored(new Set());
      return;
    }
    let cancelled = false;
    void Promise.all(
      [...byRoot].map(([owner, paths]) => gitIgnored(owner, paths).catch(() => [] as string[])),
    ).then((lists) => {
      if (!cancelled) setIgnored(new Set(lists.flat().map(pathKey)));
    });
    return () => {
      cancelled = true;
    };
  }, [loadedEntries, rootsKey]);

  const beginCreate = useCallback(
    async (kind: CreateKind, atDir?: string) => {
      if (filtering || creatingBusy) return;
      // 目标目录：空白处 / 根行右键时由调用方指定（一定是根目录），否则看选中的那一行
      // ——目录就建在里面，文件就建在它旁边，没选中就建在主要根
      let parent = atDir ?? primaryRoot;
      if (!atDir) {
        const target = focusRow
          ? loadedEntries.find((entry) => pathKey(entry.path) === pathKey(focusRow))
          : undefined;
        if (target?.isDir) parent = target.path;
        else if (target) parent = parentOf(target.path);
      }
      const owner = ownerRoot(roots, parent);
      if (!owner) return;
      setCreateError(null);
      setCreating({ kind, parent, value: "" });
      if (isRootPath(parent)) return;
      // 输入框挂在目标目录的子层里，所以那个目录必须是展开的——哪怕用户刚把它点收起
      setExpanded((current) => new Set(current).add(parent));
      if (children.has(parent)) return;
      setLoading((current) => new Set(current).add(parent));
      try {
        const listed = await listDir(owner, parent);
        setChildren((current) => new Map(current).set(parent, listed));
      } catch (reason) {
        setCreateError(String(reason));
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(parent);
          return next;
        });
      }
    },
    [children, creatingBusy, filtering, focusRow, loadedEntries, roots, isRootPath, primaryRoot],
  );

  /**
   * 空白处 / 根行右键里的新建：目标固定是那个根目录。
   * 根被整块收起时先展开——输入框挂在根的子层里，收起状态下面根本不渲染。
   */
  const startCreateAtRoot = useCallback(
    (kind: CreateKind, root: string) => {
      setRootMenu(null);
      setCollapsedRoots((current) => {
        const key = pathKey(root);
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      void beginCreate(kind, root);
    },
    [beginCreate],
  );

  const submitCreate = useCallback(async () => {
    if (!creating || creatingBusy) return;
    const name = creating.value.trim();
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      setCreateError("名称无效");
      return;
    }
    const owner = ownerRoot(roots, creating.parent);
    if (!owner) {
      setCreateError("这个路径不在任何工作目录里");
      return;
    }
    const separator = creating.parent.includes("\\") ? "\\" : "/";
    const path = `${creating.parent}${separator}${name}`;
    setCreatingBusy(true);
    setCreateError(null);
    try {
      if (creating.kind === "file") await createFile(owner, path);
      else await createDirectory(owner, path);
      const listed = await listDir(owner, creating.parent);
      if (isRootPath(creating.parent)) {
        setEntries((current) => new Map(current).set(owner, listed));
      } else {
        setChildren((current) => new Map(current).set(creating.parent, listed));
        setExpanded((current) => new Set(current).add(creating.parent));
      }
      setCreating(null);
    } catch (reason) {
      setCreateError(String(reason));
    } finally {
      setCreatingBusy(false);
    }
  }, [creating, creatingBusy, roots, isRootPath]);

  /**
   * 标题栏在文件模块（FilesPane）里，新建 / 刷新按钮通过 ref 打回树上。
   * 新建沿用 BeginCreate 那套落点规则；刷新就是让上面那个 effect 重列所有根。
   */
  useImperativeHandle(
    ref,
    () => ({
      create: (kind) => void beginCreate(kind),
      refresh: () => setReloadKey((key) => key + 1),
    }),
    [beginCreate],
  );

  const filtered = useMemo(
    () => (filtering && hits ? buildFilter(roots, hits) : null),
    [filtering, hits, rootsKey],
  );

  const changeRename = useCallback((value: string) => {
    setRenaming((current) => (current ? { ...current, value } : current));
    setRenameError(null);
  }, []);

  const cancelRename = useCallback(() => {
    setRenaming(null);
    setRenameError(null);
  }, []);

  /** 过滤模式下祖先目录默认全展开 */
  const filterExpanded = useMemo(() => {
    if (!filtered) return EMPTY_SET;
    const next = new Set<string>();
    for (const dir of filtered.dirs) {
      if (!filterCollapsed.has(dir)) next.add(dir);
    }
    return next;
  }, [filtered, filterCollapsed]);

  /** 当前模式下的「展开集合」与「展开/收起动作」——正常树与过滤树各有一套 */
  const treeExpanded = filtering ? filterExpanded : expanded;
  const activateDir = filtering ? toggleFilter : toggle;

  /**
   * 当前可见的行，按渲染顺序排好（深度优先）。方向键上下移动、Shift 连选都按这个序列，
   * 所以它必须跟界面上看到的顺序一致（根的顺序 + 展开态 + 目录内条目顺序）。
   */
  const flatEntries = useMemo(() => {
    const out: FileEntry[] = [];
    const childOf = (dir: string): FileEntry[] =>
      (filtering ? filtered?.children.get(dir) : children.get(dir)) ?? [];
    const openDir = (dir: string) => (filtering ? filterExpanded.has(dir) : expanded.has(dir));
    const walk = (items: FileEntry[]) => {
      for (const item of items) {
        out.push(item);
        if (item.isDir && openDir(item.path)) walk(childOf(item.path));
      }
    };
    if (filtering) {
      for (const items of filtered?.rootEntries.values() ?? []) walk(items);
    } else {
      for (const root of roots) {
        // 整块收起的工作目录不参与：键盘移动 / Shift 连选只能落在看得见的行上
        if (collapsedRoots.has(pathKey(root))) continue;
        walk(entries.get(root) ?? []);
      }
    }
    return out;
  }, [filtering, filtered, filterExpanded, expanded, children, entries, rootsKey, collapsedRoots]);

  const selectionKeys = useMemo(() => new Set(selection.keys()), [selection]);
  const draggingKeys = useMemo(() => new Set(dragging.map(pathKey)), [dragging]);
  // 被剪切、正等着粘贴的行：淡化（照 dragging 的写法，过滤模式下同样有效）
  const cutKeys = useMemo(
    () => (clipboard?.cut ? new Set(clipboard.paths.map(pathKey)) : EMPTY_SET),
    [clipboard],
  );

  /** 按 data-row-key 找到那一行并聚焦（避免属性选择器转义问题，直接遍历比对） */
  const focusRowByKey = useCallback((path: string) => {
    requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      const key = pathKey(path);
      for (const row of container.querySelectorAll<HTMLElement>("[data-row-key]")) {
        if (row.dataset.rowKey === key) {
          row.focus();
          return;
        }
      }
    });
  }, []);

  /** 一行被点击：Shift 连选、Ctrl 切换、普通点击单选并打开（照 VS Code） */
  const handleRowClick = useCallback(
    (entry: FileEntry, event: MouseEvent) => {
      const key = pathKey(entry.path);
      if (event.shiftKey && anchorRef.current) {
        const anchorIndex = flatEntries.findIndex((item) => pathKey(item.path) === anchorRef.current);
        const targetIndex = flatEntries.findIndex((item) => pathKey(item.path) === key);
        if (anchorIndex >= 0 && targetIndex >= 0) {
          const [from, to] =
            anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
          const next = new Map<string, FileEntry>();
          for (let i = from; i <= to; i += 1) {
            next.set(pathKey(flatEntries[i].path), flatEntries[i]);
          }
          setSelection(next);
          setActiveRow(entry.path);
          return; // Shift 只扩选，不打开
        }
      }
      if (event.ctrlKey || event.metaKey) {
        setSelection((current) => {
          const next = new Map(current);
          if (next.has(key)) next.delete(key);
          else next.set(key, entry);
          return next;
        });
        anchorRef.current = key;
        setActiveRow(entry.path);
        return;
      }
      setSelection(new Map([[key, entry]]));
      anchorRef.current = key;
      setActiveRow(entry.path);
      if (entry.isDir) activateDir(entry);
      else onSelect(entry.path);
    },
    [flatEntries, activateDir, onSelect],
  );

  /** 一行的键盘操作：方向键在树内移动焦点，左右展开/收起，Enter 打开，F2 改名，Delete 删除 */
  const handleRowKeyDown = useCallback(
    (entry: FileEntry, event: KeyboardEvent) => {
      const { key } = event;
      // 复制 / 剪切 / 粘贴（key 是小写的 c/x/v）：必须放在下面那段白名单 return 之前，
      // 否则永远进不来。事件走行自己的 keydown，终端那边是兄弟子树，不会串
      if (matchesShortcut(event, settings.shortcuts["explorer.copy"])) {
        event.preventDefault();
        doCopy(entry);
        return;
      }
      if (matchesShortcut(event, settings.shortcuts["explorer.cut"])) {
        event.preventDefault();
        doCut(entry);
        return;
      }
      if (matchesShortcut(event, settings.shortcuts["explorer.paste"])) {
        event.preventDefault();
        requestPaste(entry);
        return;
      }
      if (
        key !== "ArrowDown" &&
        key !== "ArrowUp" &&
        key !== "ArrowLeft" &&
        key !== "ArrowRight" &&
        key !== "Enter" &&
        key !== "F2" &&
        key !== "Delete"
      ) {
        return;
      }
      const index = flatEntries.findIndex((item) => pathKey(item.path) === pathKey(entry.path));
      const focusSingle = (target: FileEntry) => {
        setSelection(new Map([[pathKey(target.path), target]]));
        anchorRef.current = pathKey(target.path);
        setActiveRow(target.path);
        focusRowByKey(target.path);
      };
      switch (key) {
        case "ArrowDown": {
          const next = flatEntries[index + 1];
          if (next) {
            event.preventDefault();
            focusSingle(next);
          }
          break;
        }
        case "ArrowUp": {
          const prev = flatEntries[index - 1];
          if (prev) {
            event.preventDefault();
            focusSingle(prev);
          }
          break;
        }
        case "ArrowRight": {
          event.preventDefault();
          if (!entry.isDir) break;
          if (!treeExpanded.has(entry.path)) activateDir(entry);
          else {
            const child = flatEntries[index + 1];
            if (child && pathKey(child.path) !== pathKey(entry.path) && isPathInside(child.path, entry.path)) {
              focusSingle(child);
            }
          }
          break;
        }
        case "ArrowLeft": {
          event.preventDefault();
          if (entry.isDir && treeExpanded.has(entry.path)) {
            activateDir(entry);
            break;
          }
          const parent = parentOf(entry.path);
          if (!isRootPath(parent) && pathKey(parent) !== pathKey(entry.path)) {
            const parentEntry = flatEntries.find((item) => pathKey(item.path) === pathKey(parent));
            if (parentEntry) focusSingle(parentEntry);
          }
          break;
        }
        case "Enter": {
          event.preventDefault();
          focusSingle(entry);
          if (entry.isDir) activateDir(entry);
          else onSelect(entry.path);
          break;
        }
        case "F2": {
          event.preventDefault();
          startRename(entry);
          break;
        }
        case "Delete": {
          event.preventDefault();
          requestDelete(entry);
          break;
        }
      }
    },
    [
      flatEntries,
      treeExpanded,
      activateDir,
      onSelect,
      isRootPath,
      startRename,
      requestDelete,
      focusRowByKey,
      doCopy,
      doCut,
      requestPaste,
      settings.shortcuts,
    ],
  );

  /**
   * 目标目录能不能投放这批拖拽项。
   * 跨工作目录的拖拽直接禁止：后端虽有跨根能力，但跨卷 rename 会失败，
   * 与其半途报错不如在界面上就不让放。
   */
  const canDropOn = useCallback(
    (destDir: string) => {
      if (dragging.length === 0) return false;
      const key = pathKey(destDir);
      const destOwner = ownerRoot(roots, destDir);
      if (!destOwner) return false;
      // 全部项本来就在这个目录里 → 没有可移动的
      if (dragging.every((path) => pathKey(parentOf(path)) === key)) return false;
      for (const path of dragging) {
        if (isPathInside(destDir, path)) return false; // 拖到自己或自己的子孙里
        if (pathKey(ownerRoot(roots, path) ?? "") !== pathKey(destOwner)) return false; // 跨根
      }
      return true;
    },
    [dragging, roots],
  );

  const handleDragStart = useCallback(
    (entry: FileEntry, event: DragEvent) => {
      const key = pathKey(entry.path);
      const paths = selection.has(key)
        ? [...selection.values()].map((item) => item.path)
        : [entry.path];
      const pruned = pruneNested(paths);
      setDragging(pruned);
      setDropDir(null);
      event.dataTransfer.effectAllowed = "move";
      // 必须写点数据，否则部分环境不认这次拖拽（内容本身从 dragging 状态读）
      event.dataTransfer.setData("text/plain", pruned.join("\n"));
    },
    [selection],
  );

  const handleDragOver = useCallback(
    (entry: FileEntry, event: DragEvent) => {
      if (!entry.isDir || !canDropOn(entry.path)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropDir(pathKey(entry.path));
    },
    [canDropOn],
  );

  const handleDragLeave = useCallback((entry: FileEntry) => {
    const key = pathKey(entry.path);
    setDropDir((current) => (current === key ? null : current));
  }, []);

  /** 把当前拖拽项移动到 `destDir`。所有落点（目录行 / 根行 / 空白区）最终都汇到这里 */
  const handleDrop = useCallback(
    async (destDir: string, event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const paths = dragging;
      setDropDir(null);
      setDragging([]);
      if (paths.length === 0 || !canDropOn(destDir)) return;
      const toOwner = ownerRoot(roots, destDir);
      if (!toOwner) return;

      setBusy(true);
      setActionError(null);
      try {
        // 移动会丢掉旧 model，未保存的改动跟着一起没——先落盘
        if (!(await onBeforeRename())) {
          setActionError("有文件没保存成功，已取消移动");
          return;
        }
        const moves: MovePair[] = [];
        for (const path of paths) {
          const fromOwner = ownerRoot(roots, path);
          if (!fromOwner) continue;
          const to = await moveEntry({
            fromRoot: fromOwner,
            path,
            toRoot: toOwner,
            targetDir: destDir,
          });
          moves.push({ from: path, to });
        }
        if (moves.length === 0) return;
        // 编辑器里落在旧路径下的标签一次重定向到新路径
        onRenamed(moves);
        setActiveRow(moves[0].to);
        // 选中集合跟着挪到新路径，移动后仍高亮
        setSelection((current) => {
          if (current.size === 0) return current;
          const next = new Map<string, FileEntry>();
          for (const item of current.values()) {
            const move = moves.find((candidate) => pathKey(candidate.from) === pathKey(item.path));
            const path = move ? move.to : item.path;
            next.set(pathKey(path), move ? { ...item, path, name: baseName(path) } : item);
          }
          return next;
        });
        // 源目录与目标目录都要重列
        for (const dir of new Set<string>([destDir, ...paths.map(parentOf)])) {
          await refreshDir(dir);
        }
        if (filtering) dropFilter();
      } catch (reason) {
        setActionError(String(reason));
      } finally {
        setBusy(false);
      }
    },
    [dragging, canDropOn, roots, onBeforeRename, onRenamed, refreshDir, filtering, dropFilter],
  );

  /** 拖到某一行上：目录行就是它，文件行落到它所在目录（照 VS Code） */
  const handleRowDrop = useCallback(
    (entry: FileEntry, event: DragEvent) => {
      event.stopPropagation();
      const destDir = entry.isDir ? entry.path : parentOf(entry.path);
      void handleDrop(destDir, event);
    },
    [handleDrop],
  );

  const handleDragEnd = useCallback(() => {
    setDragging([]);
    setDropDir(null);
  }, []);

  const tree = useMemo<TreeController>(() => {
    const common = {
      selection: selectionKeys,
      focusedKey: focusRow ? pathKey(focusRow) : null,
      firstKey: flatEntries.length > 0 ? pathKey(flatEntries[0].path) : null,
      gitMarks,
      ignored,
      dragging: draggingKeys,
      cutKeys,
      dropDir,
      onRowClick: handleRowClick,
      onRowKeyDown: handleRowKeyDown,
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleRowDrop,
      onDragEnd: handleDragEnd,
      openMenu,
      renaming,
      renameError,
      onRenameChange: changeRename,
      onRenameSubmit: submitRename,
      onRenameCancel: cancelRename,
    };
    if (filtered) {
      return {
        ...common,
        expanded: filterExpanded,
        loading: EMPTY_SET,
        errors: EMPTY_MAP,
        children: filtered.children,
        toggle: toggleFilter,
        select: (entry: FileEntry) => onSelect(entry.path),
        creating: null,
        createError: null,
        onCreateChange: () => {},
        onCreateSubmit: () => {},
        onCreateCancel: () => {},
      };
    }
    return {
      ...common,
      expanded,
      loading,
      errors,
      children,
      toggle,
      select: (entry: FileEntry) => onSelect(entry.path),
      creating,
      createError,
      onCreateChange: (value: string) => {
        setCreating((current) => (current ? { ...current, value } : current));
        setCreateError(null);
      },
      onCreateSubmit: submitCreate,
      onCreateCancel: () => {
        setCreating(null);
        setCreateError(null);
      },
    };
  }, [
    filtered,
    filterExpanded,
    toggleFilter,
    expanded,
    loading,
    errors,
    children,
    focusRow,
    selectionKeys,
    draggingKeys,
    cutKeys,
    dropDir,
    flatEntries,
    handleRowClick,
    handleRowKeyDown,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleRowDrop,
    handleDragEnd,
    gitMarks,
    ignored,
    toggle,
    creating,
    createError,
    submitCreate,
    onSelect,
    openMenu,
    renaming,
    renameError,
    changeRename,
    submitRename,
    cancelRename,
  ]);

  // 搜索期间只画命中结果，免得旧树和新结果混在一起看不清
  const groups = useMemo(() => {
    if (filtering) {
      return filtered ? [...filtered.rootEntries].map(([root, items]) => ({ root, items })) : [];
    }
    return roots.map((root) => ({ root, items: entries.get(root) ?? [] }));
  }, [filtering, filtered, roots, entries]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-content">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto px-1 py-1"
        onClick={(event) => {
          // 点空白处把锚点收回主要根：焦点行没了高亮，之后新建也落在那儿。
          // 点到行按钮或新建输入框的点击会冒泡到这，不算空白
          if ((event.target as HTMLElement).closest("button, input")) return;
          setActiveRow(primaryRoot);
          setSelection(new Map());
          anchorRef.current = null;
        }}
        // 空白处右键：对主要根开菜单（新建文件/文件夹、粘贴、刷新…），跟点空白收敛锚点、
        // 新建落点同一个口径。行是 button、目录标题也是 button，命中它们就让给各自的右键
        // 菜单，别抢——判断口径同上面的 onClick；它们自己会 preventDefault，所以这里直接
        // return 也不会冒出原生菜单
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("button, input")) return;
          event.preventDefault();
          if (!primaryRoot) return;
          setMenu(null);
          setActionError(null);
          setRootMenu({ root: primaryRoot, x: event.clientX, y: event.clientY });
        }}
        // 拖到树里的空白处 = 移动到主要根目录
        onDragOver={(event) => {
          if (!canDropOn(primaryRoot)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropDir(pathKey(primaryRoot));
        }}
        onDragLeave={() => {
          setDropDir((current) => (current === pathKey(primaryRoot) ? null : current));
        }}
        onDrop={(event) => void handleDrop(primaryRoot, event)}
      >
        {filtering && (
          <p className="px-2 py-1 text-[11px] text-fg-faint">
            {hits === null
              ? "搜索中…"
              : hits.length === 0
                ? "没有匹配的文件"
                : `${hits.length} 个匹配`}
          </p>
        )}
        {actionError && (
          <p className="mx-1 my-1 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
            {actionError}
          </p>
        )}
        {!filtering && rootError && (
          <p className="mx-1 my-1 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
            {rootError}
          </p>
        )}
        {/* 每个工作目录各一棵子树，并列显示；只有多根时才加一行根名做分隔 */}
        {groups.map((group) => {
          // 搜索时一律展开：命中的根被收起就白搜了
          const collapsed = !filtering && collapsedRoots.has(pathKey(group.root));
          const empty = !filtering && group.items.length === 0;
          const showCreate = !filtering && creating !== null && isRootPath(creating.parent) &&
            pathKey(creating.parent) === pathKey(group.root);
          return (
            <div key={group.root}>
              {/* 每个工作目录一行，点一下整块收起——收起只留这一行，下面连空目录提示都不画。
                  这一行也是投放目标：拖到根名上 = 移到这个根目录 */}
              <button
                type="button"
                onClick={() => toggleRoot(group.root)}
                title={toDisplayPath(group.root)}
                onDragOver={(event) => {
                  if (!canDropOn(group.root)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  setDropDir(pathKey(group.root));
                }}
                onDragLeave={() => {
                  setDropDir((current) => (current === pathKey(group.root) ? null : current));
                }}
                onDrop={(event) => void handleDrop(group.root, event)}
                // 根行也能右键：开的是同一份根菜单，好让空目录（没有子行可右键）也能新建、粘贴
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu(null);
                  setActionError(null);
                  setRootMenu({ root: group.root, x: event.clientX, y: event.clientY });
                }}
                className={`flex w-full items-center gap-1 rounded px-1 pt-1.5 pb-0.5 text-left text-[11px] font-medium tracking-wide text-fg-dim hover:bg-hover hover:text-fg${
                  dropDir === pathKey(group.root) ? " ring-1 ring-inset ring-accent" : ""
                }`}
              >
                {collapsed ? (
                  <IconChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <IconChevronDown className="h-3 w-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{folderName(group.root)}</span>
              </button>
              {!collapsed && (
                <>
                  {empty && (
                    <p className="px-2 py-1 text-[11px] text-fg-faint">空目录</p>
                  )}
                  {/* 整棵子树往右缩一级：树行自身是 depth*INDENT+4，根标题行只有 4px，
                      不额外给左内边距两者就齐平了，看不出谁在谁里面 */}
                  <ul className="pl-3">
                {showCreate && (
                  <li>
                    {/* 缩进和行高都照普通树行来（行高 24px 含边框，左缩进 4px），
                        否则新建时会冒出一个跟树对不齐的浮框 */}
                    <div style={{ paddingLeft: 4 }}>
                      <input
                        autoFocus
                        value={creating.value}
                        onChange={(event) => {
                          setCreating((current) => (current ? { ...current, value: event.target.value } : current));
                          setCreateError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void submitCreate();
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            setCreating(null);
                            setCreateError(null);
                          }
                        }}
                        placeholder={creating.kind === "file" ? "文件名" : "文件夹名"}
                        aria-label={creating.kind === "file" ? "新建文件名" : "新建文件夹名"}
                        className="h-6 w-full rounded border border-accent bg-surface px-1.5 text-[12px] text-fg outline-none"
                      />
                    </div>
                    {createError && <p className="px-2 py-[2px] text-[11px] text-danger">{createError}</p>}
                  </li>
                )}
                    {group.items.map((entry) => (
                      <FileTreeNode key={entry.path} entry={entry} depth={0} tree={tree} />
                    ))}
                  </ul>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* 删除不可撤销，走自研确认框（三端一致，见 ConfirmDialog 的说明） */}
      {pendingDelete && (
        <ConfirmDialog
          message={deleteMessage(pendingDelete)}
          confirmLabel="删除"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* 粘贴撞上同名项：覆盖是破坏性的（目标目录会被整个删掉再换源），必须问清楚 */}
      {pendingPaste && (
        <ConfirmDialog
          message={`目标位置已有同名的 ${pendingPaste.conflicts.length} 项：${pendingPaste.conflicts.join(
            "、",
          )}。继续将用源替换它们，其中的文件夹会被整个删除且无法恢复。`}
          confirmLabel="覆盖"
          onConfirm={() => {
            const pending = pendingPaste;
            setPendingPaste(null);
            if (pending) void runPaste(pending.targetDir, true);
          }}
          onCancel={() => setPendingPaste(null)}
        />
      )}

      {/* AI 解读结果，和「变更解读」共用同一个弹窗外壳 */}
      {explain && (
        <ExplainChangeDialog
          title={explain.title}
          text={explain.text}
          error={explain.error}
          onClose={closeExplain}
          titlePrefix="文件解读"
          loadingText="正在解读这个文件…"
        />
      )}

      {/* 右键菜单。用 fixed 定位而不是绝对定位：树本身是滚动容器，
          绝对定位的菜单会被 overflow 裁掉，靠底部的行就看不到菜单了 */}
      {menu && (
        <>
          {/* 铺一层透明遮罩接住外部点击；在别处再右键一次也当关掉 */}
          <div
            className="fixed inset-0 z-30"
            onClick={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: MENU_W,
              // 贴到窗口右边/下边时往回收，别把菜单顶出可视区
              left: Math.min(menu.x, window.innerWidth - MENU_W - 4),
              top: Math.min(menu.y, window.innerHeight - MENU_H - 4),
            }}
          >
            {/* 一、AI：解读要读文件全文，目录没有内容可解读，只给文件 */}
            {!menu.entry.isDir && (
              <>
                <button
                  type="button"
                  onClick={() => startExplainFile(menu.entry)}
                  className={MENU_ITEM}
                >
                  <IconSparkle className="h-3.5 w-3.5" />
                  AI 解读文件
                </button>
                <div className={MENU_DIVIDER} />
              </>
            )}
            {/* 二、剪贴板。粘贴只在剪贴板有东西时给 */}
            <button type="button" onClick={() => doCopy(menu.entry)} className={MENU_ITEM}>
              <IconCopy className="h-3.5 w-3.5" />
              复制
            </button>
            <button type="button" onClick={() => doCut(menu.entry)} className={MENU_ITEM}>
              <IconScissors className="h-3.5 w-3.5" />
              剪切
            </button>
            {clipboard && (
              <button type="button" onClick={() => requestPaste(menu.entry)} className={MENU_ITEM}>
                <IconClipboard className="h-3.5 w-3.5" />
                粘贴
              </button>
            )}
            <div className={MENU_DIVIDER} />
            {/* 三、路径 */}
            <button
              type="button"
              onClick={() => void copyPath(menu.entry.path)}
              className={MENU_ITEM}
            >
              <IconFile className="h-3.5 w-3.5" />
              复制路径
            </button>
            <button
              type="button"
              onClick={() => void copyPath(relativePath(menu.entry.path))}
              className={MENU_ITEM}
            >
              <IconTree className="h-3.5 w-3.5" />
              复制相对路径
            </button>
            <div className={MENU_DIVIDER} />
            {/* 四、打开方式：内置浏览器 / 文件管理器 / 关联程序。
                浏览器那一项只对网页文件出现，且右栏「浏览器」模块被设置关掉时不出现
                （模块没开，点了也没地方显示） */}
            {!menu.entry.isDir && isWebFile(menu.entry.path) && settings.rightBrowserVisible && (
              <button
                type="button"
                onClick={() => openInBrowser(menu.entry)}
                className={MENU_ITEM}
              >
                <IconGlobe className="h-3.5 w-3.5" />
                在内置浏览器中打开
              </button>
            )}
            <button
              type="button"
              onClick={() => void revealInSystem(menu.entry.path)}
              className={MENU_ITEM}
            >
              <IconFolderOpen className="h-3.5 w-3.5" />
              在文件管理器中显示
            </button>
            <button
              type="button"
              onClick={() => void openWithSystem(menu.entry)}
              className={MENU_ITEM}
            >
              <IconExternalLink className="h-3.5 w-3.5" />
              用默认程序打开
            </button>
            {/* 五、git：已经被忽略的行不给这一项，再写一条同样的规则没有意义。
                整组连分隔线一起藏在条件里，否则它不出现时会多出一条孤线 */}
            {isRepo && !ignored.has(pathKey(menu.entry.path)) && (
              <>
                <div className={MENU_DIVIDER} />
                <button
                  type="button"
                  onClick={() => void addToIgnore(menu.entry)}
                  className={MENU_ITEM}
                >
                  <IconEyeOff className="h-3.5 w-3.5" />
                  加入 .gitignore
                </button>
              </>
            )}
            <div className={MENU_DIVIDER} />
            {/* 六、修改 */}
            <button
              type="button"
              onClick={() => startRename(menu.entry)}
              className={MENU_ITEM}
            >
              <IconPencil className="h-3.5 w-3.5" />
              重命名
            </button>
            <button
              type="button"
              onClick={() => requestDelete(menu.entry)}
              className={MENU_ITEM}
            >
              <IconTrash className="h-3.5 w-3.5" />
              删除
            </button>
          </div>
        </>
      )}

      {/* 工作目录标题行 / 树里空白处的右键菜单：对「根目录」的常用操作。空目录没有子行可
          右键，从这里也能新建、粘贴 */}
      {rootMenu && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setRootMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setRootMenu(null);
            }}
          />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: MENU_W,
              left: Math.min(rootMenu.x, window.innerWidth - MENU_W - 4),
              top: Math.min(rootMenu.y, window.innerHeight - ROOT_MENU_H - 4),
            }}
          >
            {/* 一、新建与粘贴。粘贴只在剪贴板有东西时给 */}
            <button
              type="button"
              onClick={() => startCreateAtRoot("file", rootMenu.root)}
              className={MENU_ITEM}
            >
              <IconPlus className="h-3.5 w-3.5" />
              新建文件
            </button>
            <button
              type="button"
              onClick={() => startCreateAtRoot("directory", rootMenu.root)}
              className={MENU_ITEM}
            >
              <IconFolderPlus className="h-3.5 w-3.5" />
              新建文件夹
            </button>
            {clipboard && (
              <button
                type="button"
                onClick={() => {
                  const root = rootMenu.root;
                  setRootMenu(null);
                  void doPaste(root);
                }}
                className={MENU_ITEM}
              >
                <IconClipboard className="h-3.5 w-3.5" />
                粘贴
              </button>
            )}
            <div className={MENU_DIVIDER} />
            {/* 二、刷新整棵树（目录监听漏掉的、或手动改完磁盘后的兜底） */}
            <button
              type="button"
              onClick={() => {
                setRootMenu(null);
                setReloadKey((key) => key + 1);
              }}
              className={MENU_ITEM}
            >
              <IconRefresh className="h-3.5 w-3.5" />
              刷新
            </button>
            <div className={MENU_DIVIDER} />
            {/* 三、路径 */}
            <button type="button" onClick={() => void copyPath(rootMenu.root)} className={MENU_ITEM}>
              <IconFile className="h-3.5 w-3.5" />
              复制路径
            </button>
            <button
              type="button"
              onClick={() => void revealInSystem(rootMenu.root)}
              className={MENU_ITEM}
            >
              <IconFolderOpen className="h-3.5 w-3.5" />
              在文件管理器中显示
            </button>
          </div>
        </>
      )}
    </section>
  );
}
