import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { GitController, GitMark } from "../lib/git";
import type { DiffSource } from "../lib/tabs";
import { pathKey, toDisplayPath, type MovePair } from "../lib/fs";
import { folderName } from "../lib/workspaces";
import { useSettings } from "../lib/settings";
import { matchesShortcut } from "../lib/shortcuts";
import { ExplorerPane } from "./ExplorerPane";
import { GitChangesPane } from "./GitChangesPane";
import { SearchPane } from "./SearchPane";
import { IconChevronDown, IconChevronRight, IconRefresh } from "./icons";

/** 右栏的工具模块。浏览器 / 远程连接 / 数据库不在这里渲染内容（它们独占编辑器那一列），但入口在同一个图标条上 */
export type ToolId = "files" | "changes" | "search" | "browser" | "remote" | "database";

const TOOL_KEY = "codedock.rightTool.";

const TOOLS: ToolId[] = ["files", "changes", "search", "browser", "remote", "database"];

/** 标题栏图标按钮的样式，和「文件」模块标题栏那几个按钮一致 */
const ICON_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg";

/**
 * 记住上次看的是哪个模块。面板本身每次启动都是收起的（跟左侧栏一个道理，
 * 不给终端让位就白搭），所以这里只存模块名，不存展开状态。
 *
 * key 里带上工作区 root：一个窗口里同时开着多个工作区，各看各的模块才不会串。
 * 用 sessionStorage 存，重启后回到「文件」，够用了。
 */
export function readTool(root: string): ToolId {
  try {
    const saved = window.sessionStorage.getItem(TOOL_KEY + root);
    return TOOLS.find((tool) => tool === saved) ?? "files";
  } catch {
    return "files";
  }
}

export function saveTool(root: string, tool: ToolId) {
  try {
    window.sessionStorage.setItem(TOOL_KEY + root, tool);
  } catch {
    // 记不住就每次启动回到「文件」，不影响使用
  }
}

interface ToolPaneProps {
  tool: ToolId;
  /** 工作区的全部工作目录：文件树并列显示，变更面板按根分组，搜索挨个根搜 */
  roots: string[];
  /** 这个工作区是不是当前显示的。隐藏时不做任何后端交互 */
  visible: boolean;
  /**
   * 「变更」模块是不是真的露在用户眼前（右栏展开、且当前看的正是它）。
   * 收起右栏 / 停在别的模块时，下面的变更块只是被 `hidden` 藏着、组件还活着，
   * 得靠它把变更面板里那几个轮询 effect 短路掉，否则不可见时仍在白跑 git。
   */
  changesVisible: boolean;
  /** 当前打开的文件，文件树里要高亮 */
  selected: string | null;
  /** 每根各一套 git 控制器：变更面板每个根挂一个完整的 */
  gitByRoot: Record<string, GitController>;
  /**
   * 工作区根 -> 「变更」面板实际看的 git 目标（被选中的 worktree 路径）。
   * 没选过的根不在这里，取它自己。只影响变更面板，别的模块还用 `roots`。
   */
  gitTargets: Record<string, string>;
  /** 各根合并后的标记，供文件树查 */
  gitMarks: ReadonlyMap<string, GitMark>;
  /** 任意一根是 git 仓库。文件树据此决定给不给 git 相关的右键菜单 */
  gitReady: boolean;
  /** 文件树里点一个文件：打开文件内容 */
  onSelectFile: (path: string) => void;
  /** 文件树里右键网页文件：在右栏的内置浏览器里打开它 */
  onOpenInBrowser: (path: string) => void;
  /** 改动列表 / 时间线里点一个文件：打开差异视图 */
  onOpenDiff: (path: string, source: DiffSource) => void;
  /**
   * 变更面板里切了分支：工作区整个换了，打开着的文件和差异视图的基线都得作废。
   * 编辑器那边有 watcher 兜底（改动过的文件会重读），但被删除的文件收不到事件，
   * 所以要在这一层显式清一次。
   */
  onBranchChanged: () => void;
  /**
   * 变更面板里换了 worktree：把这个根的面板数据源换成目标 worktree。
   * 传回原根（选中它自己）表示恢复默认。
   */
  onPickWorktree: (root: string, target: string) => void;
  /** 切分支前的落盘；返回 false 表示有文件没存成功，切换要中止 */
  onBeforeBranchSwitch: () => Promise<boolean>;
  /** 搜索结果里点一条：打开文件并定位到那一行那一列 */
  onOpenMatch: (path: string, line: number, column: number, length: number) => void;
  /** 替换前的落盘；返回 false 表示有文件没存成功，替换要中止 */
  onBeforeReplace: () => Promise<boolean>;
  /** 替换后让编辑器重新从磁盘加载这些文件 */
  onAfterReplace: (paths: string[]) => void;
  /** 文件树里改名前的落盘；返回 false 表示有文件没存成功，改名要中止 */
  onBeforeRename: () => Promise<boolean>;
  /** 文件树里改名 / 移动成功：编辑器标签要跟着换路径（可能一次一批） */
  onEntryRenamed: (moves: MovePair[]) => void;
  /** 文件树里删除成功：编辑器标签要关掉（可能一次一批） */
  onEntryDeleted: (paths: string[]) => void;
  /**
   * 焦点在这一栏（文件树 / 变更）里时按「关闭标签页」——关掉编辑器里当前那个标签
   * （含从「变更」打开的差异标签）。编辑器自己那份处理管的是焦点在编辑器区内的情形。
   */
  onRequestCloseTab: () => void;
}

/**
 * 各模块的内容。全都常挂载、只切可见性，这样文件树的展开态、提交草稿、
 * 上次的搜索结果在来回切换以及面板收起时都留得住。
 */
export function ToolPane({
  tool,
  roots,
  visible,
  changesVisible,
  selected,
  gitByRoot,
  gitTargets,
  gitMarks,
  gitReady,
  onSelectFile,
  onOpenInBrowser,
  onOpenDiff,
  onOpenMatch,
  onBranchChanged,
  onPickWorktree,
  onBeforeBranchSwitch,
  onBeforeReplace,
  onAfterReplace,
  onBeforeRename,
  onEntryRenamed,
  onEntryDeleted,
  onRequestCloseTab,
}: ToolPaneProps) {
  const { settings } = useSettings();
  const filesHidden =
    tool === "changes" || tool === "search" || tool === "remote" || tool === "database";
  /**
   * 变更面板里被整块收起的工作目录（归一化路径）。收起只留根名那一行。
   * 初始只展开第一个根、其余收起：多根时几份改动加时间线全铺开，一屏根本看不完。
   */
  const [collapsedRoots, setCollapsedRoots] = useState<ReadonlySet<string>>(
    () => new Set(roots.slice(1).map(pathKey)),
  );
  /**
   * 「变更」标题栏的刷新信号：点一次 +1，传给每个根的面板，让它把状态 / 历史 /
   * worktree / 储藏全重拉一遍。多根时一次刷新重载这一模块下的所有面板。
   */
  const [reloadKey, setReloadKey] = useState(0);

  const toggleRoot = (root: string) => {
    const key = pathKey(root);
    setCollapsedRoots((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * 「关闭标签页」在这一栏里也生效：焦点在文件树 / 变更里时关掉编辑器当前那个标签
   * （含从「变更」打开的差异标签）。文本输入框（重命名、搜索、提交信息）里不抢键，
   * 否则会误伤输入。
   */
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!matchesShortcut(event, settings.shortcuts["closeTab"])) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (
      target?.isContentEditable ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT"
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onRequestCloseTab();
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-panel"
      onKeyDownCapture={onPanelKeyDown}
    >
      <div className={filesHidden ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <ExplorerPane
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
        />
      </div>
      {/* 变更：每个工作目录一块，各挂一个完整的变更面板。多根时每块能整块收起、只留
          根名那一行——两个仓库的改动加时间线全铺开，一屏根本看不完。
          面板本身是 h-full 的整高布局（内部自己滚），所以展开的块按份数分高度、
          开了折叠就只占一行，块多了整体滚 */}
      <div className={tool === "changes" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        {/* 模块自己的标题行，和「文件」「搜索」两个模块的头对齐（同为 h-8 + 下边框）。
            右侧「刷新」重载这一模块下所有根的面板（状态 / 历史 / worktree / 储藏） */}
        <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-3">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim">
            变更
          </span>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            title="刷新"
            className={ICON_BUTTON}
          >
            <IconRefresh className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {roots.map((item) => {
          const collapsed = collapsedRoots.has(pathKey(item));
          // 这一根的面板实际看的 git 目标：默认是它自己，选了别的 worktree 时是那个路径
          const target = gitTargets[item] ?? item;
          // 这一根的改动数。各根相加正好是图标条上「变更」的角标（同一个来源）
          const changed = gitByRoot[target]?.snapshot.changed ?? 0;
          return (
            <div
              key={item}
              // 展开的块各占满可视高度、块之间靠外层滚动切换。不用 flex-1 均分——
              // 几个根各分一小条，改动列表和时间线全挤在一屏里没法看。
              // overflow-hidden 不只是裁内容：它把 flex item 的 min-height:auto 变成 0，
              // 否则 GitChangesPane 里长长的时间线会把这一块撑开，把后面的根挤出可视区
              className={
                collapsed
                  ? "flex shrink-0 flex-col"
                  : "flex h-full min-h-[300px] shrink-0 flex-col overflow-hidden"
              }
            >
              {/* 单根时不加标题：面板自己的 header 已经在最上面了，没必要多一行 */}
              {roots.length > 1 && (
                <button
                  type="button"
                  onClick={() => toggleRoot(item)}
                  title={toDisplayPath(item)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-medium tracking-wide text-fg-dim hover:bg-hover hover:text-fg"
                >
                  {collapsed ? (
                    <IconChevronRight className="h-3 w-3 shrink-0" />
                  ) : (
                    <IconChevronDown className="h-3 w-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{folderName(item)}</span>
                  {/* 有改动才给角标：和图标条那个同一套实心样式，0 不显示，免得像加载失败 */}
                  {changed > 0 && (
                    <span className="shrink-0 min-w-[14px] rounded-full bg-accent px-1 text-center text-[9px] leading-[14px] font-medium text-app tabular-nums">
                      {changed}
                    </span>
                  )}
                </button>
              )}
              {/* 收起是藏起来、不是卸载：提交草稿、历史加载到第几页、拖过的高度都还在 */}
              <div className={collapsed ? "hidden" : "min-h-0 flex-1"}>
                {/* key 用 target 而不是 item：换了 worktree 要按新目标重挂，草稿、
                    worktree 下拉、按 root 落的偏好都从头来，免得带着上一个的残留 */}
                <GitChangesPane
                  key={target}
                  root={target}
                  workspaceRoot={item}
                  visible={visible}
                  moduleVisible={changesVisible}
                  reloadSignal={reloadKey}
                  git={gitByRoot[target]}
                  onOpen={onOpenDiff}
                  onOpenFile={onSelectFile}
                  onBeforeBranchSwitch={onBeforeBranchSwitch}
                  onBranchChanged={onBranchChanged}
                  onSelectWorktree={(next) => onPickWorktree(item, next)}
                />
              </div>
            </div>
          );
        })}
        </div>
      </div>
      <div className={tool === "search" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <SearchPane
          roots={roots}
          visible={visible}
          onOpenMatch={onOpenMatch}
          onBeforeReplace={onBeforeReplace}
          onAfterReplace={onAfterReplace}
        />
      </div>
    </section>
  );
}
