import { useEffect, useRef, useState } from "react";
import { ownerRoot, pathKey, replaceAll, replaceOne, searchContents, toDisplayPath } from "../lib/fs";
import { folderName } from "../lib/workspaces";
import type { SearchFile, SearchMatch, SearchOptions } from "../lib/types";
import { IconChevronDown, IconChevronRight, IconReplaceAll } from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";

/** 打字停下来多久才真正发请求 */
const SEARCH_DEBOUNCE_MS = 200;

/** 结果汇总行右侧的「全部替换」按钮 */
const HEADER_BUTTON =
  "flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

/**
 * 一次搜索的结果，**按工作目录分组**：一个工作区可能挂着多个根，每根各搜一趟，
 * 回来按组分开展示——不然两个根里的同名文件只能靠路径前缀猜，跟文件树也对不上。
 */
interface SearchGroups {
  /** 只留有命中文件的根 */
  groups: { root: string; files: SearchFile[] }[];
  truncated: boolean;
  skippedLarge: number;
}

interface SearchPaneProps {
  /** 点一条结果：打开文件并跳到那一行那一列 */
  onOpenMatch: (path: string, line: number, column: number, length: number) => void;
  /**
   * 替换前的落盘。返回 false 表示有文件没存成功——这时必须中止替换，
   * 否则磁盘上和编辑器里的内容会分叉。
   */
  onBeforeReplace: () => Promise<boolean>;
  /** 替换完让编辑器重新从磁盘加载这些文件 */
  onAfterReplace: (paths: string[]) => void;
  /**
   * 搜哪些工作目录。一个工作区可以挂多个根，每根各搜一趟再合并——
   * 后端的 `fs_search_content` 一次只认一个沙箱根
   */
  roots: string[];
  /**
   * 结果面板是不是露在用户眼前（文件模块可见、且搜索模式是「内容」）。
   * 隐藏时不发起搜索，切回来会按当前关键词重跑一遍
   */
  visible: boolean;
  /**
   * 关键词。和「文件」模块里「按名称搜索」共用同一个输入框，切模式时不用重敲；
   * 空串表示还没开始搜
   */
  query: string;
  /** 大小写 / 全字 / 正则 / 包含 / 排除 */
  options: SearchOptions;
  /** 「替换为」的内容；只在 showReplace 时有意义 */
  replacement: string;
  /** 替换输入框是否展开：展开时每条结果上出现「替换」 */
  showReplace: boolean;
  /** 「重新搜索」信号：+1 就重跑一次 */
  reloadSignal: number;
}

/**
 * 文件内容的搜索结果面板。输入框、模式切换和各种开关都在文件模块（FilesPane）的
 * 统一搜索栏里，这里只负责「按当前条件搜」和「看结果 / 替换」。
 *
 * 常挂载、只切可见性（外面用 hidden 藏），所以搜索条件、结果、展开态在来回切模式时都留得住。
 */
export function SearchPane({
  roots,
  visible,
  query,
  options,
  replacement,
  showReplace,
  reloadSignal,
  onOpenMatch,
  onBeforeReplace,
  onAfterReplace,
}: SearchPaneProps) {
  const [result, setResult] = useState<SearchGroups | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "note"; text: string } | null>(null);
  /** 结果里被整块收起的工作目录分组（归一化路径） */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  /** 收起单个文件自己的匹配行 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** 替换完 +1，用来触发一次重搜（行列会变，结果得跟着刷新） */
  const [reloadKey, setReloadKey] = useState(0);
  /** 每次搜索递增；回来的结果对不上号就丢掉，连续打字时不会被先发的慢请求盖掉 */
  const requestRef = useRef(0);
  /** 「全部替换」的待确认信息。null 表示不显示确认框 */
  const [confirmReplaceAll, setConfirmReplaceAll] = useState<{
    files: number;
    matches: number;
  } | null>(null);

  useEffect(() => {
    if (!visible) return;
    if (!query) {
      requestRef.current += 1;
      setResult(null);
      setLoading(false);
      setMessage(null);
      return;
    }

    const id = (requestRef.current += 1);
    setLoading(true);
    const targets = roots;
    const timer = window.setTimeout(() => {
      // 每个根各搜一趟再分组：后端一次只认一个根
      void Promise.all(targets.map((root) => searchContents(root, query, options)))
        .then((found) => {
          if (requestRef.current !== id) return;
          setResult({
            // 没有命中的根不占位置，省得一堆空标题
            groups: targets
              .map((root, index) => ({ root, files: found[index].files }))
              .filter((group) => group.files.length > 0),
            truncated: found.some((one) => one.truncated),
            skippedLarge: found.reduce((sum, one) => sum + one.skippedLarge, 0),
          });
          setMessage(null);
        })
        .catch((reason) => {
          if (requestRef.current !== id) return;
          setResult(null);
          setMessage({ kind: "error", text: String(reason) });
        })
        .finally(() => {
          if (requestRef.current !== id) return;
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [roots, visible, query, options, reloadSignal, reloadKey]);

  const totalMatches = result
    ? result.groups.reduce(
        (sum, group) => sum + group.files.reduce((one, file) => one + file.matches.length, 0),
        0,
      )
    : 0;
  const totalFiles = result ? result.groups.reduce((sum, group) => sum + group.files.length, 0) : 0;

  /** 收起 / 展开一个工作目录的整组结果 */
  const toggleGroup = (root: string) => {
    const key = pathKey(root);
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleCollapse = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** 替换前的公共部分：先落盘、再放行 */
  const prepare = async () => {
    if (!(await onBeforeReplace())) {
      setMessage({ kind: "error", text: "有文件没保存成功，已取消替换" });
      return false;
    }
    return true;
  };

  /** 「全部替换」按钮：先弹自研确认框——WKWebView（macOS）不支持 `window.confirm`，
   *  调了会静默返回、直接跳过确认。确认后再交给 performReplaceAll 真正动手 */
  const runReplaceAll = () => {
    if (busy || !result || result.groups.length === 0) return;
    setConfirmReplaceAll({ files: totalFiles, matches: totalMatches });
  };

  /** 真的开始替换。走到这里说明用户已经在确认框里点过替换了 */
  const performReplaceAll = async () => {
    if (busy || !result || result.groups.length === 0) return;
    const paths = result.groups.flatMap((group) => group.files.map((file) => file.path));

    setBusy(true);
    setMessage(null);
    try {
      if (!(await prepare())) return;
      // 按所属根分组：一次 fs_replace_all 只认一个沙箱根，跨根的文件得拆开跑
      const groups = new Map<string, string[]>();
      for (const path of paths) {
        const owner = ownerRoot(roots, path);
        if (!owner) continue;
        const list = groups.get(owner);
        if (list) list.push(path);
        else groups.set(owner, [path]);
      }
      const outcomes = await Promise.all(
        [...groups].map(([owner, group]) =>
          replaceAll({ root: owner, paths: group, query, options, replacement }),
        ),
      );
      const changedFiles = outcomes.flatMap((outcome) => outcome.files);
      const failures = outcomes.flatMap((outcome) => outcome.errors);
      const totalReplaced = outcomes.reduce((sum, outcome) => sum + outcome.totalReplaced, 0);
      onAfterReplace(changedFiles.map((file) => file.path));
      // 行列都变了，重搜一次让结果跟上
      setReloadKey((key) => key + 1);

      const changed = changedFiles.length;
      if (failures.length > 0) {
        setMessage({
          kind: "error",
          text: `改了 ${changed} 个文件，${failures.length} 个失败：${failures[0].message}`,
        });
      } else if (changed > 0) {
        setMessage({ kind: "note", text: `已在 ${changed} 个文件里替换 ${totalReplaced} 处` });
      } else {
        setMessage({ kind: "note", text: "没有需要替换的内容" });
      }
    } catch (reason) {
      setMessage({ kind: "error", text: String(reason) });
    } finally {
      setBusy(false);
    }
  };

  const runReplaceOne = async (file: SearchFile, match: SearchMatch) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (!(await prepare())) return;
      const owner = ownerRoot(roots, file.path);
      if (!owner) {
        setMessage({ kind: "error", text: "这个文件不在任何工作目录里" });
        return;
      }
      await replaceOne({
        root: owner,
        path: file.path,
        position: { line: match.line, column: match.column, length: match.length },
        query,
        options,
        replacement,
      });
      onAfterReplace([file.path]);
      setReloadKey((key) => key + 1);
    } catch (reason) {
      setMessage({ kind: "error", text: String(reason) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-content">
      <div className="min-h-0 flex-1 overflow-auto">
        {message && (
          <p
            className={`mx-2 my-1 rounded border px-2 py-1 text-[11px] ${
              message.kind === "error"
                ? "border-danger-line bg-danger-bg text-danger"
                : "border-line bg-raised text-fg-muted"
            }`}
          >
            {message.text}
          </p>
        )}

        {!query && <p className="px-3 py-2 text-[11px] text-fg-faint">输入关键词开始搜索文件内容</p>}
        {query && loading && !result && (
          <p className="px-3 py-2 text-[11px] text-fg-faint">搜索中…</p>
        )}
        {query && result && result.groups.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-fg-faint">没有匹配</p>
        )}

        {result && result.groups.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-fg-faint">
              <span className="min-w-0 flex-1 truncate">
                {totalFiles} 个文件 · {totalMatches} 处
                {result.truncated && "（结果已截断）"}
                {result.skippedLarge > 0 && `（跳过 ${result.skippedLarge} 个超过 2MB 的文件）`}
              </span>
              {showReplace && (
                <button
                  type="button"
                  onClick={runReplaceAll}
                  disabled={busy || totalMatches === 0}
                  title="全部替换"
                  className={HEADER_BUTTON}
                >
                  <IconReplaceAll className="h-3.5 w-3.5" />
                  全部替换
                </button>
              )}
            </div>
            <ul>
              {result.groups.map((group) => {
                const groupCollapsed = collapsedGroups.has(pathKey(group.root));
                const groupMatches = group.files.reduce(
                  (sum, file) => sum + file.matches.length,
                  0,
                );
                return (
                  <li key={group.root}>
                    {/* 工作区挂了多个工作目录就给标题（哪怕只有一组命中，也得让人知道
                        这批结果出自哪个根）；单根下它就是多余的一行 */}
                    {roots.length > 1 && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.root)}
                        title={toDisplayPath(group.root)}
                        className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-medium tracking-wide text-fg-dim hover:bg-hover hover:text-fg"
                      >
                        {groupCollapsed ? (
                          <IconChevronRight className="h-3 w-3 shrink-0" />
                        ) : (
                          <IconChevronDown className="h-3 w-3 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{folderName(group.root)}</span>
                        <span className="shrink-0 text-fg-faint tabular-nums">
                          {group.files.length} 个文件 · {groupMatches} 处
                        </span>
                      </button>
                    )}
                    {!groupCollapsed && (
                      /* 多根时整组往右缩一级，跟分组标题拉开层级（单根没有标题，缩了白缩） */
                      <ul className={roots.length > 1 ? "pl-3" : undefined}>
                        {group.files.map((file) => {
                          const isCollapsed = collapsed.has(file.path);
                          return (
                            <li key={file.path}>
                              <button
                                type="button"
                                onClick={() => toggleCollapse(file.path)}
                                title={file.path}
                                className="flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-hover"
                              >
                                {isCollapsed ? (
                                  <IconChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
                                ) : (
                                  <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
                                )}
                                <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                                  {file.relative}
                                </span>
                                <span className="shrink-0 text-[11px] text-fg-faint tabular-nums">
                                  {file.matches.length}
                                </span>
                              </button>

                              {!isCollapsed && (
                                <ul>
                                  {file.matches.map((match, index) => (
                                    <li key={index} className="group flex items-center">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onOpenMatch(
                                            file.path,
                                            match.line,
                                            match.column,
                                            match.length,
                                          )
                                        }
                                        title={match.text}
                                        className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-1 pl-6 text-left hover:bg-hover"
                                      >
                                        <span className="w-8 shrink-0 text-right text-[11px] text-fg-faint tabular-nums">
                                          {match.line}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">
                                          {match.text.slice(0, match.column - 1)}
                                          <span className="codovo-find-hit">
                                            {match.text.slice(
                                              match.column - 1,
                                              match.column - 1 + match.length,
                                            )}
                                          </span>
                                          {match.text.slice(match.column - 1 + match.length)}
                                        </span>
                                      </button>
                                      {showReplace && (
                                        <button
                                          type="button"
                                          onClick={() => void runReplaceOne(file, match)}
                                          disabled={busy}
                                          title="只替换这一处"
                                          className="mr-2 shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-faint opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100 disabled:opacity-30"
                                        >
                                          替换
                                        </button>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* 全部替换一次改写多个文件、不可撤销，走自研确认框（三端一致，见 ConfirmDialog 的说明） */}
      {confirmReplaceAll && (
        <ConfirmDialog
          message={`将在 ${confirmReplaceAll.files} 个文件里替换 ${confirmReplaceAll.matches} 处，确定吗？`}
          confirmLabel="替换"
          onConfirm={() => {
            setConfirmReplaceAll(null);
            void performReplaceAll();
          }}
          onCancel={() => setConfirmReplaceAll(null)}
        />
      )}
    </section>
  );
}
