import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  createDirectory,
  createFile,
  listDir,
  onDirsChanged,
  pathKey,
  searchFiles,
  toDisplayPath,
} from "../lib/fs";
import type { GitMark } from "../lib/git";
import type { FileEntry } from "../lib/types";
import {
  FileTreeNode,
  type CreateKind,
  type CreatingState,
  type TreeController,
} from "./FileTreeNode";
import { IconClose, IconFolderPlus, IconPlus, IconRefresh, IconSearch } from "./icons";

interface ExplorerPaneProps {
  root: string;
  selected: string | null;
  /** 归一化路径 -> git 标记，行尾那个字母 */
  gitMarks: ReadonlyMap<string, GitMark>;
  onSelect: (path: string) => void;
}

/** 输入停下来多久才去搜，省得每敲一个字都跑一趟目录遍历 */
const SEARCH_DEBOUNCE_MS = 200;

/** 过滤模式下这两个集合没有意义，共用同一份引用免得 useMemo 每次都失效 */
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

const ICON_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg";

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

export function ExplorerPane({ root, selected, gitMarks, onSelect }: ExplorerPaneProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [rootError, setRootError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);
  /**
   * 树里当前"选中的那一行"。编辑器切标签时跟着走（外面传进来的 `selected`），
   * 点目录则落在目录上——新建就建在选中的那一行里，目录也不例外。
   */
  const [activeRow, setActiveRow] = useState<string | null>(null);

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
    // 搜索命中的是上一个工作区的路径，一并清掉
    setQuery("");
    setHits(null);
    setFilterCollapsed(new Set());

    // 上一个工作区的请求可能还在飞，它回来时已经属于旧工作区了，必须丢掉：
    // 否则后端会按新工作区校验旧路径，把"路径越界"盖到刚加载好的新目录上
    let cancelled = false;
    void listDir(root)
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
      void searchFiles(activeQuery)
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
        const listed = await listDir(path);
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
        const listed = await listDir(dir);
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
        const listed = await listDir(parent);
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
      if (creating.kind === "file") await createFile(path);
      else await createDirectory(path);
      const listed = await listDir(creating.parent);
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
      expanded,
      loading,
      errors,
      children,
      selected: focusRow,
      gitMarks,
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
    gitMarks,
    toggle,
    creating,
    createError,
    submitCreate,
    onSelect,
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
    </section>
  );
}
