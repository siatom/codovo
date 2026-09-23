import { useCallback, useEffect, useMemo, useState } from "react";
import { listDir, pathKey, searchFiles, toDisplayPath } from "../lib/fs";
import type { GitMark } from "../lib/git";
import type { FileEntry } from "../lib/types";
import { FileTreeNode, type TreeController } from "./FileTreeNode";
import { FullscreenButton } from "./FullscreenButton";
import { IconClose, IconRefresh, IconSearch } from "./icons";

interface ExplorerPaneProps {
  root: string;
  selected: string | null;
  /** 归一化路径 -> git 标记，行尾那个字母 */
  gitMarks: ReadonlyMap<string, GitMark>;
  onSelect: (path: string) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
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

export function ExplorerPane({
  root,
  selected,
  gitMarks,
  onSelect,
  fullscreen,
  onToggleFullscreen,
}: ExplorerPaneProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [rootError, setRootError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 搜索：输入框开着 + 有关键词才进入过滤模式
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  /** null = 还没拿到结果 */
  const [hits, setHits] = useState<string[] | null>(null);
  /** 过滤模式下被用户单独收起的目录 */
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(new Set());

  const activeQuery = query.trim();
  const filtering = searching && activeQuery.length > 0;

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

  /** 过滤模式下点目录只是收起/展开，不用去加载——子项已经在手里了 */
  const toggleFilter = useCallback((entry: FileEntry) => {
    if (!entry.isDir) return;
    setFilterCollapsed((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }, []);

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
        selected,
        gitMarks,
        toggle: toggleFilter,
        select: (entry: FileEntry) => onSelect(entry.path),
      };
    }
    return {
      expanded,
      loading,
      errors,
      children,
      selected,
      gitMarks,
      toggle,
      select: (entry: FileEntry) => onSelect(entry.path),
    };
  }, [
    filtered,
    filterExpanded,
    toggleFilter,
    expanded,
    loading,
    errors,
    children,
    selected,
    gitMarks,
    toggle,
    onSelect,
  ]);

  const folderName = toDisplayPath(root).split("/").filter(Boolean).pop() ?? root;
  // 搜索期间只画命中结果，免得旧树和新结果混在一起看不清
  const visibleEntries = filtering ? (filtered?.rootEntries ?? []) : entries;

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-3">
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
        {/* 搜索模式下也在，不然切个模式图标就没了 */}
        <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
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
          {visibleEntries.map((entry) => (
            <FileTreeNode key={entry.path} entry={entry} depth={0} tree={tree} />
          ))}
        </ul>
      </div>
    </section>
  );
}
