import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  createDirectory,
  createFile,
  deleteEntry,
  gitAddToIgnore,
  gitIgnored,
  isPathInside,
  listDir,
  onDirsChanged,
  pathKey,
  renameEntry,
  searchFiles,
  toDisplayPath,
} from "../lib/fs";
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
import { IconClose, IconFolderPlus, IconPlus, IconRefresh, IconSearch } from "./icons";

interface ExplorerPaneProps {
  root: string;
  selected: string | null;
  /** 归一化路径 -> git 标记，行尾那个字母 */
  gitMarks: ReadonlyMap<string, GitMark>;
  /** 工作区是不是 git 仓库。不是的话「加入 .gitignore」没有意义，不给这个菜单项 */
  isRepo: boolean;
  onSelect: (path: string) => void;
  /** 改名前的落盘；返回 false 表示有文件没存成功，改名要中止 */
  onBeforeRename: () => Promise<boolean>;
  /** 改名成功：编辑器里指向旧路径的标签要跟着换 */
  onRenamed: (from: string, to: string) => void;
  /** 删除成功：编辑器里落在它下面的标签要关掉 */
  onDeleted: (path: string) => void;
}

/** 输入停下来多久才去搜，省得每敲一个字都跑一趟目录遍历 */
const SEARCH_DEBOUNCE_MS = 200;

/** 过滤模式下这两个集合没有意义，共用同一份引用免得 useMemo 每次都失效 */
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

const ICON_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg";

/** 右键菜单：宽度和高度按 5 项算出来，用来贴着窗口边缘收一收 */
const MENU_W = 132;
const MENU_H = 143;
const MENU_ITEM = "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 所在目录。改名/删除之后要重新列的就是它 */
function parentOf(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const index = path.lastIndexOf(separator);
  return index > 0 ? path.slice(0, index) : path;
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
  /** 工作区根下要显示的项 */
  rootEntries: FileEntry[];
  /** 目录绝对路径 -> 该目录下要显示的项 */
  children: Map<string, FileEntry[]>;
  /** 所有需要展开的祖先目录 */
  dirs: Set<string>;
}

/**
 * 把命中文件的绝对路径拼回一棵树：只留通往命中项的目录和文件本身。
 * 路径全是后端给的，所以祖先目录直接按路径合成即可，不用再 listDir 一遍。
 */
function buildFilter(root: string, hits: string[]): FilterTree {
  const rootEntries: FileEntry[] = [];
  const children = new Map<string, FileEntry[]>();
  const dirs = new Set<string>();
  const seen = new Set<string>();

  const push = (parent: string, entry: FileEntry) => {
    const key = `${pathKey(parent)}\u0000${pathKey(entry.path)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (parent === root) {
      rootEntries.push(entry);
      return;
    }
    const found = children.get(parent);
    if (found) found.push(entry);
    else children.set(parent, [entry]);
  };

  for (const hit of hits) {
    // 后端给的路径一定是 root + 分隔符 + 相对路径，分隔符直接读那一位，不用猜
    const sep = hit.charAt(root.length);
    if (sep !== "/" && sep !== "\\") continue;
    const parts = hit.slice(root.length + 1).split(sep);

    let parent = root;
    let prefix = root;
    for (let i = 0; i < parts.length; i += 1) {
      prefix = `${prefix}${sep}${parts[i]}`;
      const isLast = i === parts.length - 1;
      push(parent, { name: parts[i], path: prefix, isDir: !isLast });
      if (!isLast) dirs.add(prefix);
      parent = prefix;
    }
  }

  return { rootEntries, children, dirs };
}

export function ExplorerPane({
  root,
  selected,
  gitMarks,
  isRepo,
  onSelect,
  onBeforeRename,
  onRenamed,
  onDeleted,
}: ExplorerPaneProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
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

  // 右键菜单：开在哪一行、贴光标多远处。位置用 fixed 定位，所以要的是视口坐标
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  /** 等着确认删除的那一项；非空时弹确认框 */
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null);
  /** 改名 / 删除正在跑，期间不再接第二次 */
  const [busy, setBusy] = useState(false);
  /** 改名 / 删除失败的原因，挂在树顶上 */
  const [actionError, setActionError] = useState<string | null>(null);

  // 搜索：输入框开着 + 有关键词才进入过滤模式
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  /** null = 还没拿到结果 */
  const [hits, setHits] = useState<string[] | null>(null);
  /** 过滤模式下被用户单独收起的目录 */
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(new Set());

  const activeQuery = query.trim();
  const filtering = searching && activeQuery.length > 0;

  // 打开/切换文件时把焦点带回那一行。只在 selected 变化时同步，
  // 所以点目录选中的那一行不会被这条 effect 反复抢走
  useEffect(() => {
    setActiveRow(selected);
  }, [selected]);

  const focusRow = activeRow ?? selected;

  // 工作区一变，整棵树的展开状态就作废了
  useEffect(() => {
    setExpanded(new Set());
    setChildren(new Map());
    setLoading(new Set());
    setErrors(new Map());
    setRootError(null);
    setIgnored(new Set());
    // 搜索命中的是上一个工作区的路径，一并清掉
    setQuery("");
    setHits(null);
    setFilterCollapsed(new Set());
    // 就地改名/菜单里的那一行也属于旧工作区
    setRenaming(null);
    setRenameError(null);
    setMenu(null);
    setPendingDelete(null);
    setActionError(null);

    // 上一个工作区的请求可能还在飞，它回来时已经属于旧工作区了，必须丢掉：
    // 否则后端会按新工作区校验旧路径，把"路径越界"盖到刚加载好的新目录上
    let cancelled = false;
    void listDir(root, root)
      .then((listed) => {
        if (cancelled) return;
        setEntries(listed);
      })
      .catch((reason) => {
        if (cancelled) return;
        setEntries([]);
        setRootError(String(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [root, reloadKey]);

  // 搜索：防抖 + 丢弃过期结果（查询一变，上一趟回来时已经被取消）
  useEffect(() => {
    if (!filtering) {
      setHits(null);
      return;
    }
    setFilterCollapsed(new Set());

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchFiles(root, activeQuery)
        .then((found) => {
          if (!cancelled) setHits(found);
        })
        .catch((reason) => {
          if (cancelled) return;
          setHits([]);
          console.warn("搜索失败：", reason);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filtering, activeQuery, root]);

  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery("");
    setHits(null);
    setFilterCollapsed(new Set());
  }, []);

  const toggle = useCallback(
    async (entry: FileEntry) => {
      if (!entry.isDir) return;
      const { path } = entry;

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
        const listed = await listDir(root, path);
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
    [expanded, children],
  );

  /**
   * 重新列一个目录。只认已经在树里的目录：没展开过的目录没人看，
   * 展开时自然会去读最新的。
   */
  const refreshDir = useCallback(
    async (dir: string) => {
      try {
        const listed = await listDir(root, dir);
        if (pathKey(dir) === pathKey(root)) {
          setEntries(listed);
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
    [root],
  );

  /** 工作区内的相对路径，一律用 `/` 分隔——粘到代码、终端、文档里都能直接用 */
  const relativePath = useCallback(
    (path: string) => {
      const full = toDisplayPath(path);
      const base = toDisplayPath(root).replace(/\/+$/, "");
      return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
    },
    [root],
  );

  /** 右键一行：先把它选中（跟 VS Code 一样，右键同时改变选中项），再开菜单 */
  const openMenu = useCallback((entry: FileEntry, event: MouseEvent) => {
    event.preventDefault();
    setActiveRow(entry.path);
    setActionError(null);
    setMenu({ entry, x: event.clientX, y: event.clientY });
  }, []);

  const copyPath = useCallback(async (text: string) => {
    setMenu(null);
    if (!(await copyText(text))) setActionError("复制失败：系统剪贴板不可用");
  }, []);

  /** 把这一行加进工作区根的 .gitignore，然后重列根目录让置灰立刻生效 */
  const addToIgnore = useCallback(
    async (entry: FileEntry) => {
      setMenu(null);
      setActionError(null);
      try {
        await gitAddToIgnore(root, entry.path);
        // 后端的 watcher 也会报 .gitignore 的改动，但得等 300ms 防抖；这里直接
        // 重列一次：重列会换掉 entries 的引用，忽略状态那个 effect 跟着重算
        await refreshDir(root);
      } catch (reason) {
        setActionError(String(reason));
      }
    },
    [root, refreshDir],
  );

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
    setBusy(true);
    setRenameError(null);
    try {
      // 先落盘：下面编辑器会丢掉旧 model、按新路径重读，没存下来的改动会跟着一起没
      if (!(await onBeforeRename())) {
        setRenameError("有文件没保存成功，已取消重命名");
        return;
      }
      const next = await renameEntry(root, path, name);
      setRenaming(null);
      setActiveRow(next);
      onRenamed(path, next);
      await refreshDir(parentOf(path));
      // 过滤模式下的结果是按旧路径拼的，改完名字就作废了
      if (filtering) closeSearch();
    } catch (reason) {
      setRenameError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [renaming, busy, onBeforeRename, onRenamed, refreshDir, filtering, closeSearch]);

  const confirmDelete = useCallback(async () => {
    const entry = pendingDelete;
    if (!entry || busy) return;
    setPendingDelete(null);
    setBusy(true);
    setActionError(null);
    try {
      await deleteEntry(root, entry.path);
      // 删掉的正好是当前那一行，锚点退回它所在的目录
      if (activeRow && isPathInside(activeRow, entry.path)) setActiveRow(parentOf(entry.path));
      onDeleted(entry.path);
      await refreshDir(parentOf(entry.path));
      if (filtering) closeSearch();
    } catch (reason) {
      setActionError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [pendingDelete, busy, activeRow, onDeleted, refreshDir, filtering, closeSearch]);

  /** 当前已经在树里、值得跟着磁盘刷新的目录（含工作区根） */
  const loadedDirs = useMemo(() => {
    const keys = new Set<string>([pathKey(root)]);
    for (const dir of children.keys()) keys.add(pathKey(dir));
    return keys;
  }, [root, children]);

  // 磁盘上的目录结构变了就跟着刷新。订阅只建一次：回调通过 ref 拿最新的
  // 目录快照，否则每展开一个目录都要重新 listen 一遍
  const loadedDirsRef = useRef(loadedDirs);
  const refreshDirRef = useRef(refreshDir);
  // 必须排在下面那个订阅 effect 前面：挂载时它先跑，ref 里才是当前工作区的版本
  useEffect(() => {
    loadedDirsRef.current = loadedDirs;
    refreshDirRef.current = refreshDir;
  }, [loadedDirs, refreshDir]);

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
    const all = [...entries];
    for (const listed of children.values()) all.push(...listed);
    return all;
  }, [entries, children]);

  /**
   * 哪些条目被 .gitignore 忽略了。判定交给 git（后端 `check-ignore`），前端不解析规则。
   *
   * 拿的是**全部已加载条目**而不是刚列出来的那个目录：这样整体替换、不用做增量合并，
   * 也不会有残留的旧状态。`loadedEntries` 每次列目录都会换新对象，所以展开目录、
   * `fs-changed` 重列、改了 .gitignore（watcher 会把它的父目录报上来）都会自动重算。
   */
  useEffect(() => {
    if (loadedEntries.length === 0) {
      setIgnored(new Set());
      return;
    }
    let cancelled = false;
    void gitIgnored(
      root,
      loadedEntries.map((entry) => entry.path),
    )
      .then((paths) => {
        if (!cancelled) setIgnored(new Set(paths.map(pathKey)));
      })
      .catch(() => {
        // 算不出来就当都没被忽略：这是锦上添花的显示效果，不该把树搞出错误
        if (!cancelled) setIgnored(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [loadedEntries]);

  const beginCreate = useCallback(
    async (kind: CreateKind) => {
      if (filtering || creatingBusy) return;
      // 目标 = 选中的那一行：目录就建在里面，文件就建在它旁边，没选中就建在工作区根
      const target = focusRow
        ? loadedEntries.find((entry) => pathKey(entry.path) === pathKey(focusRow))
        : undefined;
      let parent = root;
      if (target?.isDir) parent = target.path;
      else if (target) {
        const separator = target.path.includes("\\") ? "\\" : "/";
        const index = target.path.lastIndexOf(separator);
        if (index > 0) parent = target.path.slice(0, index);
      }
      setCreateError(null);
      setCreating({ kind, parent, value: "" });
      if (pathKey(parent) === pathKey(root)) return;
      // 输入框挂在目标目录的子层里，所以那个目录必须是展开的——哪怕用户刚把它点收起
      setExpanded((current) => new Set(current).add(parent));
      if (children.has(parent)) return;
      setLoading((current) => new Set(current).add(parent));
      try {
        const listed = await listDir(root, parent);
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
    [children, creatingBusy, filtering, focusRow, loadedEntries, root],
  );

  const submitCreate = useCallback(async () => {
    if (!creating || creatingBusy) return;
    const name = creating.value.trim();
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      setCreateError("名称无效");
      return;
    }
    const separator = creating.parent.includes("\\") ? "\\" : "/";
    const path = `${creating.parent}${separator}${name}`;
    setCreatingBusy(true);
    setCreateError(null);
    try {
      if (creating.kind === "file") await createFile(root, path);
      else await createDirectory(root, path);
      const listed = await listDir(root, creating.parent);
      if (pathKey(creating.parent) === pathKey(root)) {
        setEntries(listed);
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
  }, [creating, creatingBusy, root]);

  const filtered = useMemo(
    () => (filtering && hits ? buildFilter(root, hits) : null),
    [filtering, hits, root],
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

  const tree = useMemo<TreeController>(() => {
    if (filtered) {
      return {
        expanded: filterExpanded,
        loading: EMPTY_SET,
        errors: EMPTY_MAP,
        children: filtered.children,
        selected: focusRow,
        gitMarks,
        ignored,
        toggle: toggleFilter,
        select: (entry: FileEntry) => onSelect(entry.path),
        creating: null,
        createError: null,
        onCreateChange: () => {},
        onCreateSubmit: () => {},
        onCreateCancel: () => {},
        openMenu,
        renaming,
        renameError,
        onRenameChange: changeRename,
        onRenameSubmit: submitRename,
        onRenameCancel: cancelRename,
      };
    }
    return {
      expanded,
      loading,
      errors,
      children,
      selected: focusRow,
      gitMarks,
      ignored,
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
      openMenu,
      renaming,
      renameError,
      onRenameChange: changeRename,
      onRenameSubmit: submitRename,
      onRenameCancel: cancelRename,
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

  const folderName = toDisplayPath(root).split("/").filter(Boolean).pop() ?? root;
  // 搜索期间只画命中结果，免得旧树和新结果混在一起看不清
  const visibleEntries = filtering ? (filtered?.rootEntries ?? []) : entries;

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel">
      {/* 右上角并排 4 个图标按钮，间距压到 2px：24px 的按钮本身已经留了 5px 内边距，
          gap 再给 4px 就散开了 */}
      <header className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-3">
        {searching ? (
          <>
            <IconSearch className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // 别让 Esc 冒到窗口上：那里接着「退出全屏」，搜索时按一下不该退出全屏
                  event.stopPropagation();
                  closeSearch();
                }
              }}
              placeholder="按文件名搜索"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-faint"
            />
            <button type="button" onClick={closeSearch} title="关闭搜索" className={ICON_BUTTON}>
              <IconClose className="h-3 w-3" />
            </button>
          </>
        ) : (
          <>
            <span
              className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim"
              title={toDisplayPath(root)}
            >
              {folderName}
            </span>
            <button
              type="button"
              onClick={() => void beginCreate("file")}
              title="新建文件"
              disabled={creatingBusy}
              className={ICON_BUTTON}
            >
              <IconPlus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void beginCreate("directory")}
              title="新建文件夹"
              disabled={creatingBusy}
              className={ICON_BUTTON}
            >
              <IconFolderPlus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setSearching(true)}
              title="搜索文件"
              className={ICON_BUTTON}
            >
              <IconSearch className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              title="刷新"
              className={ICON_BUTTON}
            >
              <IconRefresh className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </header>

      <div
        className="min-h-0 flex-1 overflow-auto px-1 py-1"
        onClick={(event) => {
          // 点空白处把锚点收回工作区根：焦点行没了高亮，之后新建也落在根目录下。
          // 点到行按钮或新建输入框的点击会冒泡到这，不算空白
          if ((event.target as HTMLElement).closest("button, input")) return;
          setActiveRow(root);
        }}
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
        {!filtering && !rootError && entries.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-fg-faint">空目录</p>
        )}
        <ul>
          {!filtering && creating?.parent === root && (
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
          {visibleEntries.map((entry) => (
            <FileTreeNode key={entry.path} entry={entry} depth={0} tree={tree} />
          ))}
        </ul>
      </div>

      {/* 删除不可撤销，走自研确认框（三端一致，见 ConfirmDialog 的说明） */}
      {pendingDelete && (
        <ConfirmDialog
          message={
            pendingDelete.isDir
              ? `删除文件夹「${pendingDelete.name}」及其中全部内容？此操作不可撤销。`
              : `删除文件「${pendingDelete.name}」？此操作不可撤销。`
          }
          confirmLabel="删除"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
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
            <button
              type="button"
              onClick={() => void copyPath(menu.entry.path)}
              className={MENU_ITEM}
            >
              复制路径
            </button>
            <button
              type="button"
              onClick={() => void copyPath(relativePath(menu.entry.path))}
              className={MENU_ITEM}
            >
              复制相对路径
            </button>
            {/* 已经被忽略的行不给这一项：再写一条同样的规则没有意义 */}
            {isRepo && !ignored.has(pathKey(menu.entry.path)) && (
              <button
                type="button"
                onClick={() => void addToIgnore(menu.entry)}
                className={MENU_ITEM}
              >
                加入 .gitignore
              </button>
            )}
            <button
              type="button"
              onClick={() => startRename(menu.entry)}
              className={MENU_ITEM}
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingDelete(menu.entry);
                setMenu(null);
              }}
              className={MENU_ITEM}
            >
              删除
            </button>
          </div>
        </>
      )}
    </section>
  );
}
