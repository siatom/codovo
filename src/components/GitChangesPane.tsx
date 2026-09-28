import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  gitCommit,
  gitCommitFiles,
  gitDiscard,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitStage,
  gitUnstage,
  pathKey,
  toDisplayPath,
} from "../lib/fs";
import {
  isStaged,
  isUnstaged,
  markOfColumn,
  type GitChange,
  type GitController,
  type GitMark,
} from "../lib/git";
import { explainChange, generateCommitMessage, useEffectiveAiConfig } from "../lib/ai";
import type { DiffSource } from "../lib/tabs";
import type { GitCommit, GitCommitFile, GitStatusPayload, DiscardSource } from "../lib/types";
import { GitMarkBadge } from "./GitMarkBadge";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExplainChangeDialog } from "./ExplainChangeDialog";
import {
  FileTypeIcon,
  IconArrowDownToLine,
  IconArrowUpFromLine,
  IconBranch,
  IconChevronDown,
  IconChevronRight,
  IconCloudDownload,
  IconFolder,
  IconList,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSparkle,
  IconSync,
  IconTree,
  IconUndo,
} from "./icons";

interface GitChangesPaneProps {
  /** 这个面板属于哪个项目：所有 git / ai 命令都带着它，后端按它定位工作区 */
  root: string;
  git: GitController;
  /** 点改动项 / 提交里的文件：打开差异视图，source 决定跟谁比 */
  onOpen: (path: string, source: DiffSource) => void;
}

/** 待确认的放弃修改。确认框弹出前先把要放弃的东西记在这里 */
interface PendingDiscard {
  paths: string[];
  source: DiscardSource;
  /** 展示用：文件名，或者"N 个文件" */
  what: string;
}

/** 提交历史一次拉多少条，「加载更多」再叠加 */
const LOG_PAGE = 50;

/** 提交框最多长到几行，再高就改成滚动。默认只有一行，内容折行后自己长 */
const MESSAGE_MAX_ROWS = 5;

/** 手动拖高时，下面至少要留出来的空间：按钮行 + 报错位 + 两三行改动列表 */
const MESSAGE_RESERVED_BELOW = 160;

/**
 * 提交框的行高 / 内边距 / 边框。把"几行"和像素互相换算要用它。
 * 行高必须先定死（textarea 上有 `leading-4`）：不写死的话 getComputedStyle
 * 会返回 "normal"，算不出"几行"是多少像素。
 */
function messageMetrics(el: HTMLTextAreaElement) {
  const styles = window.getComputedStyle(el);
  const line = Number.parseFloat(styles.lineHeight);
  const border =
    Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
  const padding =
    Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  return { line, border, padding, oneRow: line + padding + border };
}

// 提交历史这摊都是窗口级偏好，存 sessionStorage：多窗口下各收各的、各拖各的
const LOG_COLLAPSED_KEY = "codedock.commitLogCollapsed.";
const LOG_HEIGHT_KEY = "codedock.commitLogHeight.";

/** 提交历史那块能拖到多高/多矮 */
const MIN_LOG_HEIGHT = 80;
const MAX_LOG_HEIGHT = 600;
const DEFAULT_LOG_HEIGHT = 224;

/** 上面至少要留出来的高度：工具条 + 提交框 + 两三行改动列表 */
const RESERVED_ABOVE = 200;

function readLogCollapsed(root: string): boolean {
  try {
    return window.sessionStorage.getItem(LOG_COLLAPSED_KEY + root) === "1";
  } catch {
    return false;
  }
}

function readLogHeight(root: string): number {
  try {
    const saved = Number(window.sessionStorage.getItem(LOG_HEIGHT_KEY + root));
    if (Number.isFinite(saved) && saved >= MIN_LOG_HEIGHT && saved <= MAX_LOG_HEIGHT) {
      return saved;
    }
  } catch {
    // 读不到就用默认值
  }
  return DEFAULT_LOG_HEIGHT;
}

const VIEW_KEY = "codedock.gitChangesView.";

/** 改动列表的两种排法：平铺，或按目录层级收起来 */
type ChangeView = "list" | "tree";

/** 树视图每一层缩进多少像素。和 FileTreeNode 用同一个值，两处观感一致 */
const INDENT = 12;

function readChangeView(root: string): ChangeView {
  try {
    // 只有明确存过 "tree" 才认，读坏了、存了怪值都回落列表
    return window.sessionStorage.getItem(VIEW_KEY + root) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

/** 提交里的状态字母映射到徽标配色（`R`/`C` 沿用改动的黄色） */
function statusMark(status: string): GitMark {
  switch (status) {
    case "A":
      return { label: "A", kind: "added" };
    case "D":
      return { label: "D", kind: "deleted" };
    case "R":
      return { label: "R", kind: "modified" };
    case "C":
      return { label: "C", kind: "modified" };
    default:
      return { label: "M", kind: "modified" };
  }
}

/** 相对时间，够用就行——提交列表里不需要精确到分秒 */
function formatTime(seconds: number): string {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function baseName(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash === -1 ? relative : relative.slice(slash + 1);
}

function dirOf(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash === -1 ? "" : relative.slice(0, slash);
}

/**
 * 树视图的一个节点。目录带 `children`，文件是叶子、带一条改动。
 * `path` 一律是工作区相对路径（正斜杠）——目录节点拿它当折叠状态的 key。
 */
interface ChangeTreeNode {
  /** 目录名，或者文件名 */
  name: string;
  path: string;
  children?: ChangeTreeNode[];
  change?: GitChange;
}

/** 目录节点：`children` 一定在的时候用，省得每处都判一次 */
type DirNode = ChangeTreeNode & { children: ChangeTreeNode[] };

/**
 * 把改动列表按目录层级拼成一棵树。
 *
 * `change.relative` 已经是工作区相对路径、正斜杠，直接 split 就行。
 * 同一路径不会重复（后端去重过），所以插进去就是唯一的。
 */
function buildChangeTree(changes: readonly GitChange[]): ChangeTreeNode[] {
  // 根节点只用来挂第一层，不进最终结果
  const root: DirNode = { name: "", path: "", children: [] };
  for (const change of changes) {
    const segments = change.relative.split("/");
    let node: DirNode = root;
    // 最后一段是文件名，前面每一段都是一个目录
    for (let i = 0; i < segments.length - 1; i += 1) {
      const path = segments.slice(0, i + 1).join("/");
      let next = node.children.find(
        (child): child is DirNode => child.children !== undefined && child.name === segments[i],
      );
      if (!next) {
        next = { name: segments[i], path, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    node.children.push({
      name: segments[segments.length - 1],
      path: change.relative,
      change,
    });
  }
  sortChangeTree(root.children);
  return root.children;
}

/** 目录排在文件前面，同类按名字排——和文件树那边的顺序观感一致 */
function sortChangeTree(nodes: ChangeTreeNode[]): void {
  nodes.sort((a, b) => {
    const aDir = a.children !== undefined;
    const bDir = b.children !== undefined;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children) sortChangeTree(node.children);
  }
}

const TEXT_INPUT =
  "w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent";

/**
 * 主操作（提交 / 推送变更）：面板里同一位置的按钮会在这两个动作间切换，
 * 所以样式共用一套——实心整宽，和右栏其它主按钮一致。
 */
const PRIMARY_BUTTON =
  "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40";

/** AI 生成：塞进提交框内部的纯图标按钮，居中对齐、平时淡、悬停才亮 */
const GENERATE_ICON =
  "absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

const GROUP_ACTION =
  "shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";

/** 分组标题右侧的批量操作：做成纯图标，和行内那组图标按钮同一套观感 */
const GROUP_ICON =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-faint";

/** 批量放弃是破坏性操作：平时同上，悬停时才转成危险色 */
const GROUP_ICON_DANGER =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-danger disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-faint";

/** 行内操作按钮：平时藏起来，悬停或键盘聚焦时才出现并接受点击 */
const ROW_ACTION =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:opacity-0";

/** 行内的放弃修改：同样是悬停才出现，悬停转危险色 */
const ROW_DANGER =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-danger focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:opacity-0";

/** 同一时刻只允许一个写操作在跑，否则会和自己的 index.lock 撞上。
 *  generate 不是写操作，但同样在跑的时候得把按钮禁掉，免得连点发好几次请求。
 *  fetch/pull/push 是网络操作，跑起来可能要几分钟，更不能叠着发。 */
type Busy =
  | null
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "generate"
  | "fetch"
  | "pull"
  | "push";

/**
 * 能不能「放弃修改」。
 *
 * 新文件放弃等于把文件删掉（HEAD 里没有这个路径，还原过去就是删），
 * 和"未跟踪文件不给按钮"是同一条理由：不做会删文件的破坏性操作。
 * 未跟踪的 `?`、暂存区里新增的 `A` 都排除掉。空仓库里所有暂存文件都是 `A`，
 * 所以空仓库天然不支持放弃暂存改动。
 */
function canDiscard(change: GitChange, staged: boolean): boolean {
  return staged ? change.index !== "A" : change.worktree !== "?";
}

/** 标题栏那几个图标按钮的样式，和刷新按钮同一套 */
const HEADER_ACTION =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

/** 网络操作可能要跑几分钟，光靠按钮变灰看不出在干什么，下面补一行字 */
const SYNC_NOTICE = {
  fetch: "正在获取远程更新…",
  pull: "正在拉取…",
  push: "正在推送…",
} as const;

/** 右键菜单：只有一项，宽高按文案量出来，用来贴着窗口边缘收一收 */
const MENU_W = 132;
const MENU_H = 34;
const MENU_ITEM = "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

function ChangeRow({
  change,
  staged,
  busy,
  depth,
  onOpen,
  onToggle,
  onDiscard,
  onMenu,
}: {
  change: GitChange;
  /** true = 在"暂存的改动"组里，行内按钮是取消暂存 */
  staged: boolean;
  busy: boolean;
  /** 树视图里的层级；null = 列表视图（不缩进、不画文件图标、名字后面补目录） */
  depth: number | null;
  onOpen: (path: string, source: DiffSource) => void;
  onToggle: (path: string) => void;
  onDiscard: (change: GitChange) => void;
  onMenu: (change: GitChange, staged: boolean, event: ReactMouseEvent) => void;
}) {
  const slash = change.relative.lastIndexOf("/");
  const name = slash === -1 ? change.relative : change.relative.slice(slash + 1);
  const dir = slash === -1 ? "" : change.relative.slice(0, slash);
  // 暂存组看 X 列，未暂存组看 Y 列：`AM` 在两组里该显示成不同的字母
  const mark = markOfColumn(staged ? change.index : change.worktree);

  return (
    <div
      className="group flex items-center gap-1.5 rounded px-1 py-[3px] text-[12px] hover:bg-hover"
      style={depth === null ? undefined : { paddingLeft: depth * INDENT + 4 }}
      onContextMenu={(event) => onMenu(change, staged, event)}
    >
      <button
        type="button"
        onClick={() =>
          onOpen(change.path, staged ? { mode: "staged" } : { mode: "unstaged" })
        }
        title={toDisplayPath(change.path)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {depth !== null && (
          <>
            {/* 空出目录行折叠箭头的宽度，这样文件名和同层目录名左边缘对齐 */}
            <span className="w-3 shrink-0" />
            <span className="flex shrink-0 items-center text-fg-icon">
              <FileTypeIcon name={name} className="h-3.5 w-3.5" />
            </span>
          </>
        )}
        <span className="min-w-0 truncate text-fg-muted">{name}</span>
        {/* 树视图里层级已经说明了在哪个目录，再补一遍目录反而啰嗦 */}
        {depth === null && dir && (
          <span className="min-w-0 truncate text-[11px] text-fg-faint">{dir}</span>
        )}
      </button>
      {/* 右侧这一串（操作图标 + 状态徽标）单独成组：行上的 gap-1.5 对它们太松，
          组内压到 gap-0.5 更紧凑；命中区仍是 20px，不为了紧凑牺牲点击。
          徽标压在最后（最右）：它每行都在、按钮是悬停才显形，这样同一列的
          徽标在每行都对齐，扫下来不用左右找 */}
      <div className="flex shrink-0 items-center gap-0.5">
        {/* 放弃修改排在暂存按钮左边（和 VS Code 一致）。它带确认，误点还能取消 */}
        {canDiscard(change, staged) && (
          <button
            type="button"
            onClick={() => onDiscard(change)}
            disabled={busy}
            title={staged ? "放弃修改（还原到 HEAD）" : "放弃修改（还原到暂存区）"}
            className={ROW_DANGER}
          >
            <IconUndo className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onToggle(change.path)}
          disabled={busy}
          title={staged ? "取消暂存" : "暂存"}
          className={ROW_ACTION}
        >
          {staged ? <IconMinus className="h-3 w-3" /> : <IconPlus className="h-3 w-3" />}
        </button>
        <GitMarkBadge mark={mark} className="text-[10px]" />
      </div>
    </div>
  );
}

/** 树视图里的目录行：点一下收起或展开它下面的东西 */
function ChangeDirRow({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: ChangeTreeNode;
  depth: number;
  collapsed: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(node.path)}
      title={node.path}
      className="flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
      style={{ paddingLeft: depth * INDENT + 4 }}
    >
      <span className="flex w-3 shrink-0 justify-center text-fg-icon">
        {collapsed ? (
          <IconChevronRight className="h-3 w-3" />
        ) : (
          <IconChevronDown className="h-3 w-3" />
        )}
      </span>
      <span className="flex shrink-0 items-center text-fg-icon">
        <IconFolder className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
    </button>
  );
}

/** 一组改动共用的行内操作，从分组一路传到每个文件行 */
interface ChangeRowActions {
  staged: boolean;
  busy: boolean;
  onOpen: (path: string, source: DiffSource) => void;
  onToggle: (path: string) => void;
  onDiscard: (change: GitChange) => void;
  onMenu: (change: GitChange, staged: boolean, event: ReactMouseEvent) => void;
}

interface ChangeTreeActions extends ChangeRowActions {
  /** 收起来的目录（工作区相对路径）。空集合 = 全展开 */
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
}

/** 递归渲染一棵改动树：目录行 + 缩进的子层，文件行复用 ChangeRow */
function ChangeTree({
  nodes,
  depth,
  collapsedDirs,
  onToggleDir,
  ...rowActions
}: ChangeTreeActions & { nodes: readonly ChangeTreeNode[]; depth: number }) {
  return (
    <ul>
      {nodes.map((node) =>
        node.children ? (
          <li key={node.path}>
            <ChangeDirRow
              node={node}
              depth={depth}
              collapsed={collapsedDirs.has(node.path)}
              onToggle={onToggleDir}
            />
            {!collapsedDirs.has(node.path) && (
              <ChangeTree
                nodes={node.children}
                depth={depth + 1}
                collapsedDirs={collapsedDirs}
                onToggleDir={onToggleDir}
                {...rowActions}
              />
            )}
          </li>
        ) : node.change ? (
          <li key={node.path}>
            <ChangeRow change={node.change} depth={depth} {...rowActions} />
          </li>
        ) : null,
      )}
    </ul>
  );
}

/**
 * 改动列表。两种视图只是排法不同，行本身和行内操作完全一样：
 * 列表视图平铺，树视图按目录层级收起来（默认全展开，点目录才收）。
 */
function ChangeList({
  changes,
  tree,
  view,
  collapsedDirs,
  onToggleDir,
  ...rowActions
}: ChangeTreeActions & {
  changes: readonly GitChange[];
  tree: readonly ChangeTreeNode[];
  view: ChangeView;
}) {
  if (view === "list") {
    return (
      <>
        {changes.map((change) => (
          <ChangeRow key={pathKey(change.path)} change={change} depth={null} {...rowActions} />
        ))}
      </>
    );
  }
  return (
    <ChangeTree
      nodes={tree}
      depth={0}
      collapsedDirs={collapsedDirs}
      onToggleDir={onToggleDir}
      {...rowActions}
    />
  );
}

/**
 * 一条提交：点一下就地展开它改了哪些文件，再点收起。
 * 展开的文件点进去看的是「这个提交 vs 它的父提交」的差异。
 */
function CommitRow({
  commit,
  expanded,
  files,
  onToggle,
  onOpen,
}: {
  commit: GitCommit;
  expanded: boolean;
  /** undefined = 还没拉到 */
  files: GitCommitFile[] | undefined;
  onToggle: () => void;
  onOpen: (path: string, source: DiffSource) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        title={`${commit.subject}\n${commit.author} · ${formatTime(commit.time)}\n${commit.hash}`}
        className="flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[11px] hover:bg-hover"
      >
        {expanded ? (
          <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
        ) : (
          <IconChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
        )}
        <span className="shrink-0 font-mono text-fg-faint">{commit.short}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{commit.subject}</span>
      </button>

      {expanded && files === undefined && (
        <p className="py-[3px] pl-6 text-[11px] text-fg-faint">加载中…</p>
      )}
      {expanded && files?.length === 0 && (
        <p className="py-[3px] pl-6 text-[11px] text-fg-faint">这个提交没有文件更改</p>
      )}
      {expanded && files && files.length > 0 && (
        <ul>
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onOpen(file.path, { mode: "commit", rev: commit.hash })}
                title={file.relative}
                className="flex w-full items-center gap-1.5 rounded py-[3px] pr-1 pl-6 text-left text-[11px] hover:bg-hover"
              >
                <span className="min-w-0 truncate text-fg-muted">{baseName(file.relative)}</span>
                {dirOf(file.relative) && (
                  <span className="min-w-0 truncate text-[10px] text-fg-faint">
                    {dirOf(file.relative)}
                  </span>
                )}
                <GitMarkBadge mark={statusMark(file.status)} className="text-[10px]" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 改动列表 + 提交框 + 提交历史，右栏「变更」模块的整屏内容。
 * 目录不是仓库（或系统里没有 git）时整个不渲染——工具列表那边已经把这行置灰了，
 * 这里的早退只是兜底。
 */
export function GitChangesPane({ root, git, onOpen }: GitChangesPaneProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  /**
   * null = 随内容长高（也就是默认的一行）；拖过之后是固定高度（px），内容多了自己滚动。
   * 高度不落盘：每次进应用都从一行起步，省得某次拖高之后再也回不到默认。
   */
  const [messageHeight, setMessageHeight] = useState<number | null>(null);
  const [draggingMessage, setDraggingMessage] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  /** 提交框拖动的起点，null 表示没在拖 */
  const messageDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // 提交历史
  const [logCollapsed, setLogCollapsed] = useState(() => readLogCollapsed(root));
  const [logHeight, setLogHeight] = useState(() => readLogHeight(root));
  const [draggingLog, setDraggingLog] = useState(false);
  /** 拖动起点，null 表示没在拖 */
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  /** null = 还没拉到 */
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  /** 展开的那条提交 */
  const [openCommit, setOpenCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<ReadonlyMap<string, GitCommitFile[]>>(new Map());
  /** 提交完 / 手动刷新时 +1，用来重拉历史 */
  const [logRevision, setLogRevision] = useState(0);

  /** 改动列表怎么排：平铺还是按目录收起来。选择落盘，下次进应用照旧 */
  const [view, setView] = useState<ChangeView>(() => readChangeView(root));
  /** 树视图里收起来的目录。空集合就是全展开，正好是默认要的样子 */
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set());

  /** 右键的那一行。staged 决定解读时跟谁比（暂存看 HEAD、未暂存看 index） */
  const [menu, setMenu] = useState<{
    change: GitChange;
    staged: boolean;
    x: number;
    y: number;
  } | null>(null);
  /** AI 解读弹窗；null = 没开着。text 为 null 表示还在等大模型 */
  const [explain, setExplain] = useState<{
    title: string;
    text: string | null;
    error: string | null;
  } | null>(null);
  /**
   * 解读请求的序号。关掉弹窗、或者又右键了另一个文件之后，先发出去的那次回来
   * 时已经不算数了——不丢掉的话会把旧文件的解读盖到新弹窗上。
   */
  const explainSeq = useRef(0);

  const { snapshot, refresh, applyStatus } = git;
  const { config: aiConfig, ready: aiReady } = useEffectiveAiConfig();
  const { changes } = snapshot;

  const staged = useMemo(() => changes.filter(isStaged), [changes]);
  const unstaged = useMemo(() => changes.filter(isUnstaged), [changes]);
  // 两棵树只在树视图里用得上，但提前算好——改动列表通常就几十条，不值当再懒一层
  const stagedTree = useMemo(() => buildChangeTree(staged), [staged]);
  const unstagedTree = useMemo(() => buildChangeTree(unstaged), [unstaged]);
  // 「全部放弃」只覆盖能放弃的那些，新文件不在内（见 canDiscard）
  const stagedDiscardable = useMemo(
    () => staged.filter((change) => canDiscard(change, true)),
    [staged],
  );
  const unstagedDiscardable = useMemo(
    () => unstaged.filter((change) => canDiscard(change, false)),
    [unstaged],
  );

  /** 写操作统一走这里：全程禁用其它写按钮，失败就把 git 的报错摆出来 */
  const run = useCallback(
    async (kind: Exclude<Busy, null>, task: () => Promise<GitStatusPayload | void>) => {
      setBusy(kind);
      setError(null);
      try {
        // 写命令已经把新状态带回来了，直接落地，不用等下一个轮询周期；
        // 生成只填提交框、不动 git，返回空值时就跳过状态更新
        const payload = await task();
        if (payload) applyStatus(payload);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(null);
      }
    },
    [applyStatus],
  );

  const commit = useCallback(() => {
    if (!message.trim()) return;
    void run("commit", async () => {
      const payload = await gitCommit(root, message);
      setMessage(""); // 只有真提交成功才清空
      setLogRevision((revision) => revision + 1); // 刚多了一条提交
      return payload;
    });
  }, [message, run]);

  /**
   * 让 AI 生成提交信息填进框里由用户自己确认，不自动提交。
   *
   * 暂存区空着、但工作区有改动时，先把改动全部暂存再生成——否则 `diff --cached`
   * 是空的，什么也生成不出来。只要有暂存（哪怕只是部分），就只按暂存区生成，
   * 不擅自把剩下那些没暂存的改动也带上。
   */
  const generate = useCallback(() => {
    // 配置齐不齐由 useEffectiveAiConfig 判（.env 覆盖也算数），文案和原来一致
    if (!aiReady) {
      setError("请先在「设置 → AI」里填写接口地址、模型和密钥");
      return;
    }
    const stageAllFirst = staged.length === 0 && unstaged.length > 0;
    void run("generate", async () => {
      // 暂存返回新状态，跟着一起落地，免得按钮还停在"未暂存"的旧状态上
      const payload = stageAllFirst ? await gitStage(root) : undefined;
      setMessage(await generateCommitMessage(root, aiConfig));
      return payload;
    });
  }, [aiConfig, aiReady, run, staged.length, unstaged.length]);

  /** 右键一个改动行：开菜单。菜单由这里统一画（它才知道该贴哪、点完怎么解读） */
  const openMenu = useCallback((change: GitChange, staged: boolean, event: ReactMouseEvent) => {
    event.preventDefault();
    setMenu({ change, staged, x: event.clientX, y: event.clientY });
  }, []);

  /**
   * 让大模型解释这一行改了什么，结果摆在弹窗里。只读：不动仓库里的任何东西。
   *
   * 配置不全时不发请求，直接把设置页的提示放进弹窗——和生成提交信息那边一个口径。
   */
  const startExplain = useCallback(
    (change: GitChange, stagedRow: boolean) => {
      setMenu(null);
      const title = change.relative;
      if (!aiReady) {
        setExplain({
          title,
          text: null,
          error: "请先在「设置 → AI」里填写接口地址、模型和密钥",
        });
        return;
      }

      const seq = (explainSeq.current += 1);
      setExplain({ title, text: null, error: null });
      void explainChange(
        root,
        aiConfig,
        change.path,
        stagedRow ? { mode: "staged" } : { mode: "unstaged" },
      )
        .then((text) => {
          if (explainSeq.current === seq) setExplain({ title, text, error: null });
        })
        .catch((reason) => {
          if (explainSeq.current === seq) setExplain({ title, text: null, error: String(reason) });
        });
    },
    [aiConfig, aiReady],
  );

  const closeExplain = useCallback(() => {
    // 序号先推进：请求这时才回来的话，不要再把弹窗弹回来
    explainSeq.current += 1;
    setExplain(null);
  }, []);

  /** 手动刷新：状态和历史一起重拉，省得再放一个按钮 */
  const reloadAll = useCallback(() => {
    refresh();
    setLogRevision((revision) => revision + 1);
  }, [refresh]);

  /** 只取回引用，不动工作区，所以提交历史不用重拉 */
  const fetch = useCallback(() => {
    void run("fetch", () => gitFetch(root));
  }, [run]);

  const pull = useCallback(() => {
    void run("pull", async () => {
      const payload = await gitPull(root);
      setLogRevision((revision) => revision + 1); // 快进之后历史多了一段
      return payload;
    });
  }, [run]);

  /** 推送不动本地历史，只变了 ahead/behind，状态由 run() 落地 */
  const push = useCallback(() => {
    void run("push", () => gitPush(root));
  }, [run]);

  /**
   * 放弃修改不可撤销，落手前先记下来弹确认框，用户点了才真跑。
   * `what` 是"哪个文件"或者"N 个文件"。
   * 新文件不会走到这里——它们根本没有按钮（见 canDiscard）。
   */
  const discard = useCallback((paths: string[], source: DiscardSource, what: string) => {
    setPendingDiscard({ paths, source, what });
  }, []);

  const confirmDiscard = useCallback(() => {
    const pending = pendingDiscard;
    if (!pending) return;
    setPendingDiscard(null);
    void run("discard", () => gitDiscard(root, pending.paths, pending.source));
  }, [pendingDiscard, run]);

  const discardAllStaged = useCallback(() => {
    discard(
      stagedDiscardable.map((change) => change.path),
      { mode: "staged" },
      `${stagedDiscardable.length} 个文件`,
    );
  }, [discard, stagedDiscardable]);

  const discardAllUnstaged = useCallback(() => {
    discard(
      unstagedDiscardable.map((change) => change.path),
      { mode: "unstaged" },
      `${unstagedDiscardable.length} 个文件`,
    );
  }, [discard, unstagedDiscardable]);

  const setLogCollapsedPersisted = (next: boolean) => {
    setLogCollapsed(next);
    try {
      window.sessionStorage.setItem(LOG_COLLAPSED_KEY + root, next ? "1" : "0");
    } catch {
      // 记不住就按展开算，不影响使用
    }
  };

  const setViewPersisted = (next: ChangeView) => {
    setView(next);
    try {
      window.sessionStorage.setItem(VIEW_KEY + root, next);
    } catch {
      // 记不住就下次回到列表，不影响使用
    }
  };

  /** 收起 / 展开一个目录。这个不落盘：属于"这次看的时候顺手收起"的临时状态 */
  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /**
   * 拖动提交历史的上边缘改高度。
   * 走指针捕获而不是监听 window：指针移出这个 1px 的细条后照样收得到事件。
   */
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startHeight: logHeight };
    setDraggingLog(true);
    document.body.classList.add("codedock-dragging-row");
  };

  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 上限还要看面板本身有多高，否则能把上面那块挤没
    const room = (panelRef.current?.clientHeight ?? 0) - RESERVED_ABOVE;
    const limit = Math.max(MIN_LOG_HEIGHT, Math.min(MAX_LOG_HEIGHT, room));
    const next = drag.startHeight - (event.clientY - drag.startY);
    setLogHeight(Math.min(limit, Math.max(MIN_LOG_HEIGHT, next)));
  };

  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDraggingLog(false);
    document.body.classList.remove("codedock-dragging-row");
    try {
      // 用 state 里最新的值：拖动过程中它一直在变
      window.sessionStorage.setItem(LOG_HEIGHT_KEY + root, String(logHeight));
    } catch {
      // 记不住就下次还是默认高度
    }
  };

  /**
   * 拖动提交框的下边缘改高度，和上面拖历史那条是同一套写法。
   *
   * 从当前实际高度起拖：没拖过时框是随内容长高的，高度不是 state，
   * 得从 DOM 现量，否则一按下去就会跳成上次存的像素值。
   */
  const onMessageHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const height = messageRef.current?.getBoundingClientRect().height ?? 0;
    messageDragRef.current = { startY: event.clientY, startHeight: height };
    setDraggingMessage(true);
    document.body.classList.add("codedock-dragging-row");
  };

  const onMessageHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = messageDragRef.current;
    const el = messageRef.current;
    if (!drag || !el) return;
    // 下限一行，上限看面板本身有多高——不然能把下面的改动列表挤没
    const { oneRow } = messageMetrics(el);
    const room = (panelRef.current?.clientHeight ?? 0) - MESSAGE_RESERVED_BELOW;
    const limit = Math.max(oneRow, room);
    const next = drag.startHeight + (event.clientY - drag.startY);
    setMessageHeight(Math.min(limit, Math.max(oneRow, next)));
  };

  const onMessageHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!messageDragRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    messageDragRef.current = null;
    setDraggingMessage(false);
    document.body.classList.remove("codedock-dragging-row");
  };

  // 拉提交历史。收起时完全不请求——这个面板收起是常态，别白跑 git。
  // 还要盯住 HEAD：在终端里 commit / amend / reset 之后，改动列表靠 2 秒轮询
  // 能自己变好，历史不会，只有 HEAD 动了才说明提交列表该重拉。
  useEffect(() => {
    if (logCollapsed || !snapshot.isRepo) return;
    let cancelled = false;
    void gitLog(root, logLimit)
      .then((list) => {
        if (cancelled) return;
        setCommits(list);
        setLogError(null);
      })
      .catch((reason) => {
        if (cancelled) return;
        setCommits([]);
        setLogError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [logCollapsed, logLimit, logRevision, snapshot.isRepo, snapshot.head]);

  // 展开某条提交时才去拉它的文件列表，拉过就留着
  useEffect(() => {
    if (!openCommit || commitFiles.has(openCommit)) return;
    let cancelled = false;
    void gitCommitFiles(root, openCommit)
      .then((list) => {
        if (!cancelled) setCommitFiles((current) => new Map(current).set(openCommit, list));
      })
      .catch(() => {
        // 拿不到就当空列表，展开的那行会显示"没有文件改动"
        if (!cancelled) setCommitFiles((current) => new Map(current).set(openCommit, []));
      });
    return () => {
      cancelled = true;
    };
  }, [openCommit, commitFiles]);

  const toggleCommit = useCallback((hash: string) => {
    setOpenCommit((current) => (current === hash ? null : hash));
  }, []);

  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 留给换行（提交信息常常是多行），提交用 Ctrl/Cmd+Enter
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  /**
   * 提交框跟着内容长高，长到 MESSAGE_MAX_ROWS 行封顶，再多就滚动。
   *
   * 用 scrollHeight 量而不是数换行符：一行文字放不下时会自动折行，
   * 数 \n 得不出真实行数。`leading-4` 是量高度的前提——行高不定死的话
   * getComputedStyle 会返回 "normal"，算不出"几行"是多少像素。
   */
  const resizeMessage = useCallback(() => {
    // 手动拖过高度之后就不再随内容长高了：否则一打字就把用户调好的高度顶回去
    if (messageHeight !== null) return;
    const el = messageRef.current;
    if (!el) return;
    const styles = window.getComputedStyle(el);
    const line = Number.parseFloat(styles.lineHeight);
    const border =
      Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
    const max =
      line * MESSAGE_MAX_ROWS +
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom) +
      border;
    // box-sizing 是 border-box，指定高度含边框；scrollHeight 只量到 padding 为止
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + border, max)}px`;
  }, [messageHeight]);

  useEffect(resizeMessage, [message, resizeMessage]);

  // 面板被拖宽/拖窄时折行位置会变，得重新量一次。监听面板而不是 textarea 自己：
  // 我们改的正是 textarea 的高度，监听它会自己触发自己
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(resizeMessage);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [resizeMessage]);

  if (!snapshot.isRepo) return null;

  const canCommit = staged.length > 0 && message.trim().length > 0 && busy === null;
  // 有暂存就按暂存生成；只有未暂存的改动也能生成（点下去会先全部暂存）
  const canGenerate = (staged.length > 0 || unstaged.length > 0) && busy === null;
  // 改动全都提交完了、本地还领先上游：主按钮从「提交」切成「推送变更」
  const showSync = staged.length === 0 && unstaged.length === 0 && snapshot.ahead > 0;
  const notice =
    busy === "fetch" || busy === "pull" || busy === "push" ? SYNC_NOTICE[busy] : null;

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <IconBranch className="h-3 w-3 text-fg-dim" />
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-fg-dim"
          title={snapshot.branch ?? "游离 HEAD"}
        >
          {snapshot.branch ?? "游离 HEAD"}
        </span>

        {/* 领先/落后上游的提交数：只在非零时出现（没有上游时天然是 0），
            紧挨着拉取/推送按钮，一眼能看出该点哪个 */}
        {snapshot.ahead > 0 && (
          <span className="shrink-0 text-[11px] text-fg-faint" title="领先上游的提交数">
            ↑{snapshot.ahead}
          </span>
        )}
        {snapshot.behind > 0 && (
          <span className="shrink-0 text-[11px] text-fg-faint" title="落后上游的提交数">
            ↓{snapshot.behind}
          </span>
        )}

        {/* 四个图标按钮单独成组：header 的 gap-1.5 对它们太松，
            组内压到 gap-0.5 更像一组操作；命中区仍是 24px，不为了紧凑牺牲点击 */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={fetch}
            disabled={busy !== null}
            title="获取远程更新"
            className={HEADER_ACTION}
          >
            <IconCloudDownload
              className={`h-3.5 w-3.5 ${busy === "fetch" ? "animate-pulse" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={pull}
            disabled={busy !== null}
            title="拉取（只允许快进）"
            className={HEADER_ACTION}
          >
            <IconArrowDownToLine
              className={`h-3.5 w-3.5 ${busy === "pull" ? "animate-pulse" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={push}
            disabled={busy !== null}
            title="推送"
            className={HEADER_ACTION}
          >
            <IconArrowUpFromLine
              className={`h-3.5 w-3.5 ${busy === "push" ? "animate-pulse" : ""}`}
            />
          </button>

          {/* 改动列表的排法切换：图标画的是**当前**模式，点一下换成另一种 */}
          <button
            type="button"
            onClick={() => setViewPersisted(view === "list" ? "tree" : "list")}
            title={view === "list" ? "切换为树形显示" : "切换为列表显示"}
            className={HEADER_ACTION}
          >
            {view === "list" ? (
              <IconList className="h-3.5 w-3.5" />
            ) : (
              <IconTree className="h-3.5 w-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={reloadAll}
            title="刷新"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
          >
            <IconRefresh className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2 py-2">
        {/* 生成按钮放进输入框内部右侧，外面那排整条让给主操作（提交 / 同步） */}
        <div className="relative shrink-0">
          <textarea
            ref={messageRef}
            rows={1}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={onMessageKeyDown}
            placeholder="消息（Ctrl+Enter）"
            style={messageHeight === null ? undefined : { height: messageHeight }}
            className={`${TEXT_INPUT} block resize-none pr-8 leading-4`}
          />
          <button
            type="button"
            onClick={generate}
            disabled={!canGenerate}
            title="用 AI 生成提交信息（没有暂存时会先全部暂存）"
            className={GENERATE_ICON}
          >
            <IconSparkle
              className={`h-3.5 w-3.5 ${busy === "generate" ? "animate-pulse" : ""}`}
            />
          </button>
        </div>

        {/* 拖动条改提交框高度：拖过之后高度定死，内容多了框内自己滚动。
            手柄做成本身就有 6px 高、再用负边距把上下 gap-1.5 抵消掉，
            这样命中区够大又不多占地方；不额外铺透明层——那会盖住文本框底边收不到点击 */}
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onMessageHandleDown}
          onPointerMove={onMessageHandleMove}
          onPointerUp={onMessageHandleUp}
          onPointerCancel={onMessageHandleUp}
          title="拖动调整提交框的高度"
          className={`-my-1.5 h-1.5 shrink-0 cursor-row-resize rounded-full transition-colors ${
            draggingMessage ? "bg-accent-strong" : "hover:bg-line-hover"
          }`}
        />

        <div className="flex shrink-0 items-center">
          {staged.length > 0 ? (
            <button type="button" onClick={commit} disabled={!canCommit} className={PRIMARY_BUTTON}>
              {busy === "commit" ? "提交中…" : "提交"}
            </button>
          ) : showSync ? (
            // 改动都提交完了、本地还领先上游：主操作顺势变成把提交推上去
            <button
              type="button"
              onClick={push}
              disabled={busy !== null}
              className={PRIMARY_BUTTON}
            >
              <IconSync className={`h-3.5 w-3.5 ${busy === "push" ? "animate-spin" : ""}`} />
              {busy === "push" ? "推送中…" : `推送变更 ${snapshot.ahead} 个`}
            </button>
          ) : (
            <button type="button" disabled className={PRIMARY_BUTTON}>
              提交
            </button>
          )}
        </div>

        {notice && (
          <p className="shrink-0 px-1 text-[11px] text-fg-faint">{notice}</p>
        )}

        {error && (
          <p className="shrink-0 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] whitespace-pre-wrap text-danger">
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {staged.length === 0 && unstaged.length === 0 && (
            <p className="px-1 py-1 text-[11px] text-fg-faint">没有未提交的更改</p>
          )}

          {staged.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  暂存的更改 ({staged.length})
                </span>
                {stagedDiscardable.length > 0 && (
                  <button
                    type="button"
                    onClick={discardAllStaged}
                    disabled={busy !== null}
                    title="放弃这个分组里所有文件的更改"
                    className={GROUP_ICON_DANGER}
                  >
                    <IconUndo className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void run("unstage", () => gitUnstage(root))}
                  disabled={busy !== null}
                  title="全部取消暂存"
                  className={GROUP_ICON}
                >
                  <IconMinus className="h-3 w-3" />
                </button>
              </div>
              <ChangeList
                changes={staged}
                tree={stagedTree}
                view={view}
                staged
                busy={busy !== null}
                collapsedDirs={collapsedDirs}
                onToggleDir={toggleDir}
                onOpen={onOpen}
                onToggle={(path) => void run("unstage", () => gitUnstage(root, [path]))}
                onDiscard={(change) =>
                  discard([change.path], { mode: "staged" }, change.relative)
                }
                onMenu={openMenu}
              />
            </>
          )}

          {unstaged.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1.5 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  更改 ({unstaged.length})
                </span>
                {unstagedDiscardable.length > 0 && (
                  <button
                    type="button"
                    onClick={discardAllUnstaged}
                    disabled={busy !== null}
                    title="放弃这个分组里所有文件的更改"
                    className={GROUP_ICON_DANGER}
                  >
                    <IconUndo className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void run("stage", () => gitStage(root))}
                  disabled={busy !== null}
                  title="全部暂存"
                  className={GROUP_ICON}
                >
                  <IconPlus className="h-3 w-3" />
                </button>
              </div>
              <ChangeList
                changes={unstaged}
                tree={unstagedTree}
                view={view}
                staged={false}
                busy={busy !== null}
                collapsedDirs={collapsedDirs}
                onToggleDir={toggleDir}
                onOpen={onOpen}
                onToggle={(path) => void run("stage", () => gitStage(root, [path]))}
                onDiscard={(change) =>
                  discard([change.path], { mode: "unstaged" }, change.relative)
                }
                onMenu={openMenu}
              />
            </>
          )}
        </div>
      </div>

      {/* 拖动条把提交历史的上边缘变成可拖的：往下拖历史变高。
          收起时不画——没有东西可调 */}
      {!logCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          title="拖动调整提交历史的高度"
          className={`relative h-px shrink-0 cursor-row-resize bg-line-strong transition-colors ${
            draggingLog ? "bg-accent-strong" : "hover:bg-line-hover"
          }`}
        >
          {/* 加宽命中区，视觉上仍是一条细线 */}
          <span className="absolute inset-x-0 -top-1 -bottom-1" />
        </div>
      )}

      {/* 提交历史。改完的东西在上一区，翻过的旧账在下面，别再挤同一块滚动区 */}
      <div
        className="flex min-h-0 shrink-0 flex-col"
        style={logCollapsed ? undefined : { height: logHeight }}
      >
        <button
          type="button"
          onClick={() => setLogCollapsedPersisted(!logCollapsed)}
          title={logCollapsed ? "展开提交历史" : "收起提交历史"}
          className="flex h-7 w-full shrink-0 items-center gap-1 px-2 text-left text-[11px] font-medium tracking-wide text-fg-dim hover:text-fg"
        >
          {logCollapsed ? (
            <IconChevronRight className="h-3 w-3" />
          ) : (
            <IconChevronDown className="h-3 w-3" />
          )}
          <span>提交历史</span>
          {commits && commits.length > 0 && (
            <span className="text-fg-faint">{commits.length}</span>
          )}
        </button>

        {!logCollapsed && (
          <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
            {logError && <p className="px-1 py-1 text-[11px] text-danger">{logError}</p>}
            {commits === null && !logError && (
              <p className="px-1 py-1 text-[11px] text-fg-faint">加载中…</p>
            )}
            {commits?.length === 0 && !logError && (
              <p className="px-1 py-1 text-[11px] text-fg-faint">还没有提交</p>
            )}

            {commits?.map((commit) => (
              <CommitRow
                key={commit.hash}
                commit={commit}
                expanded={openCommit === commit.hash}
                files={commitFiles.get(commit.hash)}
                onToggle={() => toggleCommit(commit.hash)}
                onOpen={onOpen}
              />
            ))}

            {commits && commits.length >= logLimit && (
              <button
                type="button"
                onClick={() => setLogLimit((limit) => limit + LOG_PAGE)}
                className={`${GROUP_ACTION} mt-1 ml-1`}
              >
                加载更多
              </button>
            )}
          </div>
        )}
      </div>

      {/* 弹框用 fixed 定位，挂在这儿不会挤到面板布局（祖先里没有 transform） */}
      {pendingDiscard && (
        <ConfirmDialog
          message={`放弃 ${pendingDiscard.what} 的更改？将还原到${
            pendingDiscard.source.mode === "staged" ? "上次提交（HEAD）" : "暂存区"
          }的版本，无法撤销。`}
          confirmLabel="放弃"
          onConfirm={confirmDiscard}
          onCancel={() => setPendingDiscard(null)}
        />
      )}

      {/* 右键菜单。和文件树那边同一套画法：透明遮罩接住外部点击，fixed 定位
          免得被面板的滚动容器裁掉 */}
      {menu && (
        <>
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
              onClick={() => startExplain(menu.change, menu.staged)}
              className={MENU_ITEM}
            >
              AI 变更解读
            </button>
          </div>
        </>
      )}

      {explain && (
        <ExplainChangeDialog
          title={explain.title}
          text={explain.text}
          error={explain.error}
          onClose={closeExplain}
        />
      )}
    </div>
  );
}
