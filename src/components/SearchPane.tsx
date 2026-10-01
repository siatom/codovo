import { useEffect, useRef, useState, type ReactNode } from "react";
import { ownerRoot, pathKey, replaceAll, replaceOne, searchContents, toDisplayPath } from "../lib/fs";
import { folderName } from "../lib/workspaces";
import type { SearchFile, SearchMatch, SearchOptions } from "../lib/types";
import {
  IconChevronDown,
  IconChevronRight,
  IconClearResults,
  IconClose,
  IconRefresh,
  IconReplaceAll,
  IconWholeWord,
} from "./icons";

/** 打字停下来多久才真正发请求 */
const SEARCH_DEBOUNCE_MS = 200;

const SWITCHES: { key: keyof SearchOptions; label: ReactNode; title: string }[] = [
  { key: "caseSensitive", label: "Aa", title: "区分大小写" },
  { key: "wholeWord", label: <IconWholeWord className="h-3.5 w-3.5" />, title: "全字匹配" },
  { key: "regex", label: ".*", title: "使用正则表达式" },
];

/**
 * 输入框做成"填充背景 + 无边框"的一块，开关直接塞在框里右端——
 * 单独给每个开关画边框会把这一行切得七零八落。
 * 底色用 active：深色下比面板亮一档、浅色下比面板暗一档，两套主题都看得出是个输入框
 * （raised 太贴近面板底色，浅色主题里等于没填）。
 * ring 不占布局，聚焦时变色不会让内容跳一下。
 */
const FIELD =
  "flex min-w-0 items-center gap-0.5 rounded bg-active px-1.5 py-1 ring-1 ring-transparent focus-within:ring-accent-line";

const FIELD_INPUT =
  "min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-faint disabled:opacity-50";

const FIELD_BUTTON =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg";

/**
 * 选中态用 accent 系的浅底 + 亮字：原来的 bg-selected 和输入框底色（active）
 * 在深色主题下几乎一个色，压不住。
 */
const SWITCH_ON = "bg-accent-line text-accent-soft";

/** 标题栏右侧那两个图标按钮，跟「文件」「变更」模块的头是同一套写法 */
const HEADER_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

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
  /** 是不是当前显示的工作区。隐藏时不发起搜索，切回来会重跑一遍 */
  visible: boolean;
}

export function SearchPane({
  roots,
  visible,
  onOpenMatch,
  onBeforeReplace,
  onAfterReplace,
}: SearchPaneProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
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
  }, [roots, visible, query, options, reloadKey]);

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

  /**
   * 清空这次搜索：关键词、替换内容、结果一起清掉，回到"还没搜过"的样子。
   * 关键词也清，所以下面那两个输入框会一起空。
   */
  const clearSearch = () => {
    setQuery("");
    setReplacement("");
    setResult(null);
    setCollapsed(new Set());
    setMessage(null);
  };

  /** 替换前的公共部分：先落盘、再放行 */
  const prepare = async () => {
    if (!(await onBeforeReplace())) {
      setMessage({ kind: "error", text: "有文件没保存成功，已取消替换" });
      return false;
    }
    return true;
  };

  const runReplaceAll = async () => {
    if (busy || !result || result.groups.length === 0) return;
    const paths = result.groups.flatMap((group) => group.files.map((file) => file.path));
    if (!window.confirm(`将在 ${paths.length} 个文件里替换 ${totalMatches} 处，确定吗？`)) {
      return;
    }

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
    <section className="flex h-full min-h-0 flex-col bg-panel">
      {/* 标题栏：重新搜索 / 清除结果。跟「文件」「变更」两个模块的头对齐 */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim">
          搜索
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          disabled={!query || busy}
          title="重新搜索"
          className={HEADER_BUTTON}
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={clearSearch}
          disabled={!query && !replacement}
          title="清除搜索"
          className={HEADER_BUTTON}
        >
          <IconClearResults className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 展开/收起替换的箭头单独占左侧一列并纵向撑满：展开时它正好落在
          搜索和替换两行中间，收起时就是搜索那一行居中 */}
      <header className="flex shrink-0 items-stretch gap-1 border-b border-line px-2 py-2">
        <button
          type="button"
          onClick={() => setShowReplace((open) => !open)}
          title={showReplace ? "收起替换" : "展开替换"}
          className="flex w-5 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
        >
          {showReplace ? (
            <IconChevronDown className="h-3.5 w-3.5" />
          ) : (
            <IconChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className={FIELD}>
            <input
              type="text"
              value={query}
              spellCheck={false}
              disabled={busy}
              placeholder="搜索"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // 不 stopPropagation 的话，Esc 会继续往上冒，被别处的关闭逻辑接走
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              className={FIELD_INPUT}
            />
            {query && !busy && (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="清空"
                className={FIELD_BUTTON}
              >
                <IconClose className="h-3 w-3" />
              </button>
            )}
            {SWITCHES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() =>
                  setOptions((current) => ({ ...current, [item.key]: !current[item.key] }))
                }
                title={item.title}
                className={`flex h-5 shrink-0 items-center justify-center rounded px-1 text-[11px] leading-none ${
                  options[item.key] ? SWITCH_ON : "text-fg-dim hover:bg-hover hover:text-fg"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {showReplace && (
            <div className="flex items-center gap-1">
              <div className={`${FIELD} flex-1`}>
                <input
                  type="text"
                  value={replacement}
                  spellCheck={false}
                  disabled={busy}
                  placeholder="替换为"
                  onChange={(event) => setReplacement(event.target.value)}
                  className={FIELD_INPUT}
                />
              </div>
              <button
                type="button"
                onClick={() => void runReplaceAll()}
                disabled={busy || totalMatches === 0}
                title="全部替换"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-accent-line text-accent-soft hover:bg-active disabled:opacity-40"
              >
                <IconReplaceAll className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </header>

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

        {!query && <p className="px-3 py-2 text-[11px] text-fg-faint">输入关键词开始搜索</p>}
        {query && loading && !result && (
          <p className="px-3 py-2 text-[11px] text-fg-faint">搜索中…</p>
        )}
        {query && result && result.groups.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-fg-faint">没有匹配</p>
        )}

        {result && result.groups.length > 0 && (
          <>
            <p className="px-3 py-1 text-[11px] text-fg-faint">
              {totalFiles} 个文件 · {totalMatches} 处
              {result.truncated && "（结果已截断）"}
              {result.skippedLarge > 0 && `（跳过 ${result.skippedLarge} 个超过 2MB 的文件）`}
            </p>
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
                                onOpenMatch(file.path, match.line, match.column, match.length)
                              }
                              title={match.text}
                              className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-1 pl-6 text-left hover:bg-hover"
                            >
                              <span className="w-8 shrink-0 text-right text-[11px] text-fg-faint tabular-nums">
                                {match.line}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">
                                {match.text.slice(0, match.column - 1)}
                                <span className="codedock-find-hit">
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
    </section>
  );
}
