import { useCallback, useRef, useState, type ReactNode } from "react";
import type { GitMark } from "../lib/git";
import type { SearchOptions } from "../lib/types";
import type { MovePair } from "../lib/fs";
import { toDisplayPath } from "../lib/fs";
import { ExplorerPane, type ExplorerPaneHandle } from "./ExplorerPane";
import { SearchPane } from "./SearchPane";
import {
  IconChevronDown,
  IconChevronRight,
  IconClearResults,
  IconClose,
  IconFilter,
  IconFolderPlus,
  IconPlus,
  IconRefresh,
  IconReplaceAll,
  IconSearch,
  IconWholeWord,
} from "./icons";

/** 文件模块里的两种搜索：按文件名过滤文件树 / 按内容搜结果 */
type SearchMode = "name" | "content";

/** 只有布尔开关能进这一排；include / exclude 是文本框，单独排 */
type SearchSwitch = "caseSensitive" | "wholeWord" | "regex";

const SWITCHES: { key: SearchSwitch; label: ReactNode; title: string }[] = [
  { key: "caseSensitive", label: "Aa", title: "区分大小写" },
  { key: "wholeWord", label: <IconWholeWord className="h-3.5 w-3.5" />, title: "全字匹配" },
  { key: "regex", label: ".*", title: "使用正则表达式" },
];

/**
 * 输入框做成"填充背景 + 无边框"的一块，模式切换与开关直接塞在框内右端——
 * 单独给每个按钮画边框会把这一行切得七零八落。
 * 底色用 active：深色下比面板亮一档、浅色下比面板暗一档，两套主题都看得出是个输入框。
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

/** 标题栏那几个图标按钮，和其他模块的头是同一套写法 */
const HEADER_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

interface FilesPaneProps {
  /** 工作区的全部工作目录：树并列显示，搜索挨个根搜 */
  roots: string[];
  /**
   * 这个工作区是不是当前显示的（且右栏正停在「文件」模块）。
   * 隐藏时不做任何后端交互；切回来会补重列 / 重搜
   */
  visible: boolean;
  /** 当前打开的文件，文件树里要高亮 */
  selected: string | null;
  /** 各根合并后的 git 标记，供文件树查 */
  gitMarks: ReadonlyMap<string, GitMark>;
  /** 任意一根是 git 仓库。文件树据此决定给不给 git 相关的右键菜单 */
  gitReady: boolean;
  /** 文件树里点一个文件：打开文件内容 */
  onSelectFile: (path: string) => void;
  /** 文件树里右键网页文件：在右栏的内置浏览器里打开它 */
  onOpenInBrowser: (path: string) => void;
  /** 内容搜索结果里点一条：打开文件并定位到那一行那一列 */
  onOpenMatch: (path: string, line: number, column: number, length: number) => void;
  /** 改名 / 移动前的落盘；返回 false 表示有文件没存成功，操作要中止 */
  onBeforeRename: () => Promise<boolean>;
  /** 文件树里改名 / 移动成功：编辑器标签要跟着换路径（可能一次一批） */
  onEntryRenamed: (moves: MovePair[]) => void;
  /** 文件树里删除成功：编辑器标签要关掉（可能一次一批） */
  onEntryDeleted: (paths: string[]) => void;
  /** 替换前的落盘；返回 false 表示有文件没存成功，替换要中止 */
  onBeforeReplace: () => Promise<boolean>;
  /** 替换后让编辑器重新从磁盘加载这些文件 */
  onAfterReplace: (paths: string[]) => void;
}

/**
 * 右栏的「文件」模块：文件树和内容搜索合成一个模块。
 *
 * 上面是模块标题栏（新建 / 刷新 / 重新搜索），下面是统一的搜索栏：
 * 一个关键词输入框，右侧切换「名称 / 内容」——
 *   - 名称：按文件名过滤下面的文件树（沿用原来的文件名搜索）；
 *   - 内容：在整个工作区里搜文件内容，支持大小写 / 全字 / 正则、包含排除与替换。
 * 两个模式共用同一个关键词，来回切不用重敲；两套结果都常挂载、只切可见性，
 * 树的展开态、搜索结果与替换输入框在切换时都留得住。
 */
export function FilesPane({
  roots,
  visible,
  selected,
  gitMarks,
  gitReady,
  onSelectFile,
  onOpenInBrowser,
  onOpenMatch,
  onBeforeRename,
  onEntryRenamed,
  onEntryDeleted,
  onBeforeReplace,
  onAfterReplace,
}: FilesPaneProps) {
  const [mode, setMode] = useState<SearchMode>("name");
  const [query, setQuery] = useState("");
  /** 内容搜索的选项：两个模式共用关键词，但这些开关只在内容模式有意义 */
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    include: "",
    exclude: "",
  });
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  /** include / exclude 两行 glob 输入先收起，点漏斗图标才展开 */
  const [showFilters, setShowFilters] = useState(false);
  /** 「重新搜索」信号：每次 +1 让内容搜索重跑（文件名过滤有自己的防抖） */
  const [contentReloadKey, setContentReloadKey] = useState(0);
  /** 文件树的新建 / 刷新按钮长在标题栏里，通过 ref 打回树上 */
  const explorerRef = useRef<ExplorerPaneHandle>(null);

  const activeQuery = query.trim();
  /** 树和内容搜索各自只在对应模式下接关键词，另一个模式不跑后端 */
  const treeQuery = mode === "name" ? query : "";

  /** 清空关键词与替换内容，回到「还没搜过」的样子 */
  const clearSearch = useCallback(() => {
    setQuery("");
    setReplacement("");
  }, []);

  /** 树里的改名 / 删除 / 移动之后过滤结果已失效，请它把关键词清掉 */
  const clearQuery = useCallback(() => {
    setQuery("");
  }, []);

  const refresh = () => {
    if (mode === "name") explorerRef.current?.refresh();
    else setContentReloadKey((key) => key + 1);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-content">
      {/* 标题栏：名称模式管文件树（新建 / 刷新），内容模式只有重新搜索 */}
      <header className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-3">
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim"
          title={roots.map((root) => toDisplayPath(root)).join("\n")}
        >
          {roots.length > 1 ? `文件 · ${roots.length} 个工作目录` : "文件"}
        </span>
        {mode === "name" ? (
          <>
            <button
              type="button"
              onClick={() => explorerRef.current?.create("file")}
              title={activeQuery ? "先清空搜索再新建" : "新建文件"}
              disabled={activeQuery.length > 0}
              className={HEADER_BUTTON}
            >
              <IconPlus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => explorerRef.current?.create("directory")}
              title={activeQuery ? "先清空搜索再新建" : "新建文件夹"}
              disabled={activeQuery.length > 0}
              className={HEADER_BUTTON}
            >
              <IconFolderPlus className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={refresh}
          disabled={mode === "content" && !activeQuery}
          title={mode === "name" ? "刷新文件树" : "重新搜索"}
          className={`${HEADER_BUTTON} disabled:opacity-40`}
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* 统一搜索栏：关键词 + 模式，内容模式再多一排选项 */}
      <div className="shrink-0 border-b border-line px-2 py-1.5">
        <div className={FIELD}>
          <IconSearch className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
          <input
            type="text"
            value={query}
            spellCheck={false}
            placeholder={mode === "name" ? "搜索文件" : "搜索文件内容"}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // 不 stopPropagation 的话，Esc 会继续往上冒，被别处的关闭逻辑接走
              if (event.key === "Escape") {
                event.stopPropagation();
                clearSearch();
              }
            }}
            className={FIELD_INPUT}
          />
          {query && (
            <button type="button" onClick={clearSearch} title="清空" className={FIELD_BUTTON}>
              <IconClose className="h-3 w-3" />
            </button>
          )}
          {/* 模式切换：两颗按钮贴在一起，当前模式亮起来。放在框内右端，不额外占一行 */}
          <div className="flex shrink-0 items-center rounded bg-content p-0.5">
            {(
              [
                ["name", "名称", "按文件名过滤文件树"],
                ["content", "内容", "在整个工作区里搜索文件内容"],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                title={hint}
                className={`h-5 rounded px-1.5 text-[11px] leading-none ${
                  mode === value ? SWITCH_ON : "text-fg-dim hover:bg-hover hover:text-fg"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {mode === "content" && (
          <>
            <div className="mt-1 flex flex-wrap items-center gap-0.5">
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
              <button
                type="button"
                onClick={() => setShowFilters((open) => !open)}
                title="文件过滤（包含 / 排除）"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
                  showFilters || options.include || options.exclude
                    ? SWITCH_ON
                    : "text-fg-dim hover:bg-hover hover:text-fg"
                }`}
              >
                <IconFilter className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setShowReplace((open) => !open)}
                title={showReplace ? "收起替换" : "展开替换"}
                className={`flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-[11px] leading-none ${
                  showReplace ? SWITCH_ON : "text-fg-dim hover:bg-hover hover:text-fg"
                }`}
              >
                {showReplace ? (
                  <IconChevronDown className="h-3 w-3" />
                ) : (
                  <IconChevronRight className="h-3 w-3" />
                )}
                <IconReplaceAll className="h-3.5 w-3.5" />
                替换
              </button>
              <button
                type="button"
                onClick={clearSearch}
                disabled={!query && !replacement}
                title="清空搜索"
                className={`${FIELD_BUTTON} ml-auto disabled:opacity-40`}
              >
                <IconClearResults className="h-3.5 w-3.5" />
              </button>
            </div>

            {showReplace && (
              <div className={`${FIELD} mt-1`}>
                <input
                  type="text"
                  value={replacement}
                  spellCheck={false}
                  placeholder="替换为"
                  onChange={(event) => setReplacement(event.target.value)}
                  className={FIELD_INPUT}
                />
              </div>
            )}

            {showFilters && (
              <div className="mt-1 flex flex-col gap-1">
                {(
                  [
                    ["include", "包含", "文件 glob，逗号分隔，例如 *.ts, src/**"],
                    ["exclude", "排除", "文件 glob，逗号分隔，例如 *.min.js, dist/**"],
                  ] as const
                ).map(([key, label, placeholder]) => (
                  <div key={key} className={FIELD}>
                    <span className="shrink-0 pl-0.5 pr-0.5 text-[11px] text-fg-faint">
                      {label}
                    </span>
                    <input
                      type="text"
                      value={options[key]}
                      spellCheck={false}
                      placeholder={placeholder}
                      onChange={(event) =>
                        setOptions((current) => ({ ...current, [key]: event.target.value }))
                      }
                      className={FIELD_INPUT}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 两个模式都常挂载，只切可见性：树的展开态、搜索结果与替换输入都留得住 */}
      <div className={mode === "name" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <ExplorerPane
          ref={explorerRef}
          roots={roots}
          visible={visible}
          selected={selected}
          gitMarks={gitMarks}
          isRepo={gitReady}
          onSelect={onSelectFile}
          onOpenInBrowser={onOpenInBrowser}
          onBeforeRename={onBeforeRename}
          onRenamed={onEntryRenamed}
          onDeleted={onEntryDeleted}
          query={treeQuery}
          onClearQuery={clearQuery}
        />
      </div>
      <div className={mode === "content" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <SearchPane
          roots={roots}
          visible={visible && mode === "content"}
          query={query}
          options={options}
          replacement={replacement}
          showReplace={showReplace}
          reloadSignal={contentReloadKey}
          onOpenMatch={onOpenMatch}
          onBeforeReplace={onBeforeReplace}
          onAfterReplace={onAfterReplace}
        />
      </div>
    </section>
  );
}
