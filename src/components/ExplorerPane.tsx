import { useCallback, useEffect, useMemo, useState } from "react";
import { listDir, toDisplayPath } from "../lib/fs";
import type { GitMark } from "../lib/git";
import type { FileEntry } from "../lib/types";
import { FileTreeNode, type TreeController } from "./FileTreeNode";
import { IconRefresh } from "./icons";

interface ExplorerPaneProps {
  root: string;
  selected: string | null;
  /** 归一化路径 -> git 标记，来自 App 的轮询结果 */
  gitMarks: ReadonlyMap<string, GitMark>;
  onSelect: (path: string) => void;
}

export function ExplorerPane({ root, selected, gitMarks, onSelect }: ExplorerPaneProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [rootError, setRootError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 工作区一变，整棵树的展开状态就作废了
  useEffect(() => {
    setExpanded(new Set());
    setChildren(new Map());
    setLoading(new Set());
    setErrors(new Map());
    setRootError(null);

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

  const tree = useMemo<TreeController>(
    () => ({
      expanded,
      loading,
      errors,
      children,
      selected,
      gitMarks,
      toggle,
      select: (entry: FileEntry) => onSelect(entry.path),
    }),
    [expanded, loading, errors, children, selected, gitMarks, toggle, onSelect],
  );

  const folderName = toDisplayPath(root).split("/").filter(Boolean).pop() ?? root;

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-3">
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim"
          title={toDisplayPath(root)}
        >
          {folderName}
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          title="刷新"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {rootError && (
          <p className="mx-1 my-1 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
            {rootError}
          </p>
        )}
        {!rootError && entries.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-fg-faint">空目录</p>
        )}
        <ul>
          {entries.map((entry) => (
            <FileTreeNode key={entry.path} entry={entry} depth={0} tree={tree} />
          ))}
        </ul>
      </div>
    </section>
  );
}
