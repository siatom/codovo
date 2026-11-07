import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import {
  gitAddToIgnore,
  gitAmend,
  gitApplyLines,
  gitApplyPatch,
  gitBranches,
  gitCommit,
  gitCommitFiles,
  gitCommitGroups,
  gitCommitStat,
  gitCompareFiles,
  gitCreateTag,
  gitDeleteTag,
  gitDiscard,
  gitFetch,
  gitFileHunks,
  gitInit,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  gitPull,
  gitPush,
  gitResolveConflict,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitUndoCommit,
  gitUnstage,
  gitUnpushed,
  gitWorktreeList,
  gitWorktreePrune,
  gitWorktreeStatus,
  pathKey,
  toDisplayPath,
} from "../lib/fs";
import {
  isConflict,
  isStaged,
  isStashable,
  isUnstaged,
  markOfColumn,
  type GitChange,
  type GitController,
  type GitMark,
  type GitMarkKind,
} from "../lib/git";
import {
  explainChange,
  generateCommitPlan,
  useEffectiveAiConfig,
  type CommitPlanItem,
} from "../lib/ai";
import { useSettings } from "../lib/settings";
import { folderName } from "../lib/workspaces";
import { formatShortcut, matchesShortcut } from "../lib/shortcuts";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { DiffSource } from "../lib/tabs";
import type {
  CommitRef,
  CommitStat,
  DiscardSource,
  FileHunks,
  GitBranch,
  GitCommit,
  GitCommitFile,
  GitStash,
  GitStatusPayload,
  HunkAction,
  WorktreeInfo,
  WorktreeStatus,
} from "../lib/types";
import { graphTextInset, LANE_W, layoutGraph, type GraphRow } from "../lib/gitGraph";
import { GitMarkBadge, GitMarkDot } from "./GitMarkBadge";
import { CommitGraph } from "./GitGraph";
import { CommitTooltip } from "./CommitTooltip";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExplainChangeDialog } from "./ExplainChangeDialog";
import { FileTypeIcon, FolderTypeIcon } from "./fileIcons";
import {
  IconArrowDownToLine,
  IconArrowLeftToLine,
  IconArrowRightToLine,
  IconArrowUpFromLine,
  IconArrowsLeftRight,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCloudDownload,
  IconEyeOff,
  IconFile,
  IconFilter,
  IconList,
  IconMerge,
  IconMinus,
  IconMore,
  IconPencil,
  IconPlus,
  IconSparkle,
  IconSync,
  IconTarget,
  IconTrash,
  IconTree,
  IconUndo,
  IconWorktree,
} from "./icons";
import { ICON_SM, IconButton } from "./ui";

interface GitChangesPaneProps {
  /** 这个面板属于哪个工作区：所有 git / ai 命令都带着它，后端按它定位工作区 */
  root: string;
  /**
   * 这个面板所属的**工作区根**（未切工作树时的那个根）。worktree 列表从它拉：
   * 面板的 `root` 可能被切到一个不是 git 仓库的工作树，只有工作区根始终是正常仓库。
   */
  workspaceRoot: string;
  /**
   * 这个工作区是不是当前显示的。非当前工作区只是 `hidden` 藏着、不卸载，
   * 所以面板还活着——轮询这类后台动作要靠它停掉，否则每个隐藏的工作区都在白跑 git。
   */
  visible: boolean;
  /**
   * 这个面板所在的模块是不是真的露在用户眼前：右栏展开、且当前看的正是「变更」。
   * 收起右栏 / 停在「文件 / 搜索」等别的模块时，外层只是把它 `hidden` 藏着、组件还活着，
   * 所以轮询这类后台动作除了看 `visible` 也得看它，否则模块不可见时仍在白跑 git。
   */
  moduleVisible: boolean;
  /**
   * 标题栏「刷新」传来的重载信号：值一变就把这个面板重载一遍（状态 / 历史 /
   * worktree / 储藏）。初值只是哨兵，首次挂载不触发——各 effect 挂载时本就会自己拉一次。
   */
  reloadSignal: number;
  git: GitController;
  /** 点改动项 / 提交里的文件：打开差异视图，source 决定跟谁比 */
  onOpen: (path: string, source: DiffSource) => void;
  /** 点行内的「打开文件」：开文件内容（不是差异），用来跳回去看上下文 */
  onOpenFile: (path: string) => void;
  /**
   * 换了 worktree：把这个面板的数据源切到目标工作树。传回工作区自己的根
   * （`worktrees` 里那条 `current`）表示恢复默认。只有一个 worktree 时不会调。
   */
  onSelectWorktree: (target: string) => void;
}

/** 待确认的放弃修改。确认框弹出前先把要放弃的东西记在这里 */
interface PendingDiscard {
  paths: string[];
  source: DiscardSource;
  /** 展示用：文件名，或者"N 个文件" */
  what: string;
}

/** 时间线一次拉多少条，「加载更多」再叠加 */
const LOG_PAGE = 50;

/**
 * 过滤时间线时一次拉多少条。过滤会把结果筛掉一部分，还按普通一页取的话，
 * 前面一段没命中就看着像「没有」。顶到后端的上限（git.rs 的 LOG_MAX = 500），
 * 让过滤在尽量长的历史里找。
 */
const LOG_FILTER_LIMIT = 500;

/** 过滤输入框的防抖：每敲一个字就去拉一次 git 太浪费，静一下再查 */
const LOG_FILTER_DEBOUNCE_MS = 250;

/**
 * 提交行里最多平铺几个引用 chip，多出来的收成「+N」。
 * chip 是 `shrink-0` 的，不封顶的话 HEAD 那条（main / origin/main / origin/HEAD）
 * 会把 `flex-1` 的提交主题挤成 0 宽，整行就只剩标签、看不到主题了。
 */
const MAX_REF_CHIPS = 2;

/**
 * 时间线的后台重拉间隔。
 * 只盯 HEAD 的话，终端里 `fetch` / `tag` 这类不改 HEAD 的操作会漏掉——远程分支、
 * 标签这些行内装饰就一直是旧的。挂个比 status（2 秒）慢的轮询兜底。
 */
const LOG_POLL_MS = 5000;

/**
 * 鼠标离开提交行后，浮框再留多久才收。
 * 浮框和提交行之间隔了 GAP，鼠标穿过去时会先离开这一行——留这点时间让鼠标能移进浮框
 * 去点「复制提交号」。**这是「离开」的宽限，不是「进入」的延迟**：进新行要立刻换过去。
 */
const HOVER_HIDE_MS = 180;

/** 提交框最多长到几行，再高就改成滚动。默认只有一行，内容折行后自己长 */
const MESSAGE_MAX_ROWS = 5;

/** 提交框 ↑ / ↓ 回填的会话历史上限：只留最近这么多条，够用又不至于把数组撑大 */
const MESSAGE_HISTORY_MAX = 50;

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

// 时间线这摊都是窗口级偏好，存 sessionStorage：多窗口下各收各的、各拖各的
const LOG_COLLAPSED_KEY = "codovo.commitLogCollapsed.";
const LOG_RATIO_KEY = "codovo.commitLogRatio.";

/** 时间线那块能拖到多高/多矮 */
const MIN_LOG_HEIGHT = 80;
const MAX_LOG_HEIGHT = 600;

/** 默认占面板高度的四成：面板变高变矮时时间线跟着走，不必再拖一次 */
const DEFAULT_LOG_RATIO = 0.4;

/** 比例的合法区间。只用来挡住坏掉的存储值，像素级的上限在派生高度那里管 */
const MIN_LOG_RATIO = 0.1;
const MAX_LOG_RATIO = 0.8;

/** 面板高度还没量到（首帧）时的兜底像素高度，别让时间线先跳成最矮 */
const DEFAULT_LOG_HEIGHT = 224;

/** 上面至少要留出来的高度：工具条 + 提交框 + 两三行改动列表 */
const RESERVED_ABOVE = 200;

/** 拖动条上按方向键每次调整的像素步长（提交框 / 时间线两条共用） */
const KEY_RESIZE_STEP = 16;

function readLogCollapsed(root: string): boolean {
  try {
    return window.sessionStorage.getItem(LOG_COLLAPSED_KEY + root) === "1";
  } catch {
    return false;
  }
}

function readLogRatio(root: string): number {
  try {
    const saved = Number(window.sessionStorage.getItem(LOG_RATIO_KEY + root));
    if (Number.isFinite(saved) && saved >= MIN_LOG_RATIO && saved <= MAX_LOG_RATIO) {
      return saved;
    }
  } catch {
    // 读不到就用默认比例
  }
  return DEFAULT_LOG_RATIO;
}

/**
 * 目标像素高度换成比例，顺手夹进合法区间。
 * 像素级的上限（面板高度 - RESERVED_ABOVE）不在这儿算，派生高度那处统一管。
 */
function ratioForHeight(px: number, panelHeight: number): number {
  if (panelHeight <= 0) return DEFAULT_LOG_RATIO;
  return Math.min(MAX_LOG_RATIO, Math.max(MIN_LOG_RATIO, px / panelHeight));
}

/**
 * 工作树概览的折叠状态，同样按 root 存 sessionStorage。默认展开——多工作树仓库里它是
 * 这块面板的主导航，收起来才需要用户主动点。
 */
const WT_COLLAPSED_KEY = "codovo.worktreeOverviewCollapsed.";

/**
 * 工作树概览的后台重拉间隔。
 *
 * 明显慢于 status 轮询（2 秒）：这个命令要**逐棵**跑一次 git status，成本随工作树数翻倍，
 * 跟着 2 秒跑等于把每个工作树都按主工作区的频率轮询。10 秒足够让「别的 worktree 有没有
 * 新改动」跟得上，又不会把 CPU 白烧在后台。
 */
const WT_POLL_MS = 10000;

function readWtCollapsed(root: string): boolean {
  try {
    return window.sessionStorage.getItem(WT_COLLAPSED_KEY + root) === "1";
  } catch {
    // 读不到就用默认（展开），不影响使用
    return false;
  }
}

const VIEW_KEY = "codovo.gitChangesView.";

/** 改动列表的两种排法：平铺，或按目录层级收起来 */
type ChangeView = "list" | "tree";

/**
 * 两边改动加起来到这个数才显示筛选框。
 *
 * 少了它，一两条改动的面板上会多出一个几乎总用不上的输入框，把提交框和列表挤开；
 * 而真到了几十条、找起来费劲的时候它才出现。
 */
const FILTER_MIN_CHANGES = 10;

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
  return compactDirs(root.children);
}

/**
 * 把只有单条子目录的链条并成一个节点（`a` → `a/b/c`），照 VS Code 的改动树：
 * 逐级展开一串没有分叉的目录纯属浪费层级，也不好看。合并后 `path` 取最深那级，
 * 当作折叠状态的 key——旧 key 自然失效、默认展开，无妨。
 */
function compactDirs(nodes: ChangeTreeNode[]): ChangeTreeNode[] {
  return nodes.map((node) => {
    if (!node.children) return node;
    let current: DirNode = { ...node, children: compactDirs(node.children) };
    while (current.children.length === 1 && current.children[0].children) {
      const only = current.children[0] as DirNode;
      current = {
        name: `${current.name}/${only.name}`,
        path: only.path,
        children: only.children,
      };
    }
    return current;
  });
}

/**
 * 目录节点右侧那个状态点：把整棵子树里最"重"的状态挑出来。轻重按合并冲突 >
 * 删除 > 修改 > 新增 > 未跟踪排——一个目录里混着几种改动时，先让人看到最该
 * 处理的那种。同一组的文件看同一列（暂存组看 index、未暂存组看 worktree）。
 */
const MARK_RANK: Record<GitMarkKind, number> = {
  conflict: 5,
  deleted: 4,
  modified: 3,
  added: 2,
  untracked: 1,
};

function aggregateMark(node: ChangeTreeNode, staged: boolean): GitMark | null {
  let best: GitMark | null = null;
  let bestRank = -1;
  const walk = (current: ChangeTreeNode) => {
    if (current.change) {
      const mark = markOfColumn(staged ? current.change.index : current.change.worktree);
      const rank = MARK_RANK[mark.kind] ?? 0;
      if (rank > bestRank) {
        bestRank = rank;
        best = mark;
      }
    }
    current.children?.forEach(walk);
  };
  walk(node);
  return best;
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

/**
 * 「提交」分裂按钮（照 VS Code）：左边提交，右边一个小箭头拉出其它提交方式。
 * 两块压在同一个主色块上、中间一条半透明分隔线，看着是一个按钮、两个点击区。
 */
const SPLIT_MAIN =
  "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-accent px-3 py-1.5 text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40";
const SPLIT_CARET =
  "flex shrink-0 items-center justify-center rounded-r-md border-l border-app/30 bg-accent px-1.5 text-app hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40";

/** 合并中的「中止合并」：这一下会丢掉整次合并尝试，用危险色描边 */
const MERGE_ABORT_BUTTON =
  "shrink-0 rounded-md border border-danger-line px-3 py-1.5 text-[12px] text-danger hover:bg-danger-bg disabled:opacity-40";

/**
 * 进行中的四种多步操作：中文名 + "继续"时用的动词。
 *
 * merge 收尾是生成合并提交，说"完成合并"；变基 / 拣选 / 还原都是 `--continue`，
 * 说"继续××"。四种现在都能在面板里收尾，文案按类型分开，不再指回终端。
 */
const ONGOING: Record<string, { name: string; verb: string }> = {
  merge: { name: "合并", verb: "完成" },
  rebase: { name: "变基", verb: "继续" },
  cherryPick: { name: "拣选", verb: "继续" },
  revert: { name: "还原", verb: "继续" },
};

/** 认不出的类型（理论上不会发生）也给个能读的兜底，别把 undefined 拼进文案里 */
function ongoingLabels(kind: GitStatusPayload["mergeKind"]): { name: string; verb: string } {
  return (kind && ONGOING[kind]) || { name: "操作", verb: "继续" };
}

/** "进行中"提示条的整句文案：还剩几个冲突 + 点哪个按钮收尾 */
function ongoingText(kind: GitStatusPayload["mergeKind"], conflicts: number): string {
  const { name, verb } = ongoingLabels(kind);
  return conflicts > 0
    ? `正在进行${name}：还有 ${conflicts} 个冲突未解决，解决后点「${verb}${name}」`
    : `正在进行${name}：点「${verb}${name}」完成，或「中止${name}」放弃`;
}

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

/**
 * 行尾的「逐块操作」展开箭头。和其它行内按钮不同，它**常驻可见**：
 * 展开是这一行的状态，箭头藏起来就看不出哪一行开着。压在最右端是因为
 * 悬停时那一串按钮会显形把左边的东西挤动，这里跟着动会看着在跳。
 */
const ROW_HUNK_TOGGLE =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg";

/**
 * 展开区里的逐块按钮。同样常驻：展开这一块本来就是为了点它们，
 * 再藏到悬停里等于白展开一次。
 */
const HUNK_ACTION =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-30";
const HUNK_DANGER =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-danger disabled:opacity-30";

/**
 * 同一时刻只允许一个写操作在跑，否则会和自己的 index.lock 撞上。
 *  generate 不是写操作，但同样在跑的时候得把按钮禁掉，免得连点发好几次请求。
 *  fetch/pull/push/merge 是网络操作，跑起来可能要几分钟，更不能叠着发。
 *  amend/undo/branch 都改写 HEAD，和 commit 归同一类。
 */
type Busy =
  | null
  | "init"
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "commitPush"
  | "commitSync"
  | "amend"
  | "undo"
  | "branch"
  | "tag"
  | "stash"
  | "generate"
  | "fetch"
  | "pull"
  | "push"
  | "merge"
  | "mergeAbort"
  | "mergeContinue"
  | "prune"
  | "resolve";

/**
 * 能不能「放弃修改」。
 *
 * 新文件放弃等于把文件删掉（HEAD 里没有这个路径，还原过去就是删），
 * 和"未跟踪文件不给按钮"是同一条理由：不做会删文件的破坏性操作。
 * 未跟踪的 `?`、暂存区里新增的 `A` 都排除掉。空仓库里所有暂存文件都是 `A`，
 * 所以空仓库天然不支持放弃暂存改动。
 *
 * 重命名（`R`）也排除：放弃命令的 pathspec 只带**新路径**，而还原目标里只有旧路径
 * （暂存组还原到 HEAD、未暂存组还原到 index），git 会报 "pathspec did not match"。
 * 要支持得同时给旧路径 + 新路径两条 pathspec（新路径要先从 porcelain 记录里留下来），
 * 这里不做。两种情况各看一列：暂存组看 X、未暂存组看 Y。
 */
function canDiscard(change: GitChange, staged: boolean): boolean {
  return staged
    ? change.index !== "A" && change.index !== "R"
    : change.worktree !== "?" && change.worktree !== "R";
}

/**
 * 未暂存组能不能逐块 / 逐行操作：补丁从「index ↔ 工作区」的 diff 生成，
 * 两个方向（`--cached` 暂存、`--reverse` 放弃）都落在这份 diff 上。
 *
 * 排除新增 / 删除 / 冲突：新增（未跟踪的 `?`）在 index 里没有基线，删除
 * （`D`）在工作区里没有文件，两边都生成不出能 apply 的补丁；冲突（`U`）
 * 的 diff 是三方合并的产物，交给 `git apply` 只会失败。这些一律回退到整文件操作。
 */
function canHunk(change: GitChange): boolean {
  const { index, worktree } = change;
  return worktree !== "?" && worktree !== "U" && worktree !== "D" && index !== "U";
}

/**
 * 暂存组能不能逐块 / 逐行操作：补丁从「HEAD ↔ index」的 diff 生成，
 * `--cached --reverse` 应用就是「取消暂存这些改动」。
 *
 * 同理排除 index 侧的新增（`A`，HEAD 里没有基线）、删除（`D`，index 里没有文件）
 * 与冲突（`U`）。
 */
function canHunkStaged(change: GitChange): boolean {
  const { index, worktree } = change;
  return index !== "A" && index !== "D" && index !== "U" && worktree !== "U";
}

/** 网络操作可能要跑几分钟，光靠按钮变灰看不出在干什么，下面补一行字 */
const SYNC_NOTICE = {
  fetch: "正在获取远程更新…",
  pull: "正在拉取…",
  push: "正在推送…",
  commitPush: "正在提交并推送…",
  commitSync: "正在提交并同步…",
  merge: "正在合并…",
  mergeAbort: "正在中止当前操作…",
  mergeContinue: "正在完成当前操作…",
} as const;

/** 右键菜单：宽度按最长的一项量，高度按项数算出来，用来贴着窗口边缘收一收 */
const MENU_W = 148;
/** 一项 24px 上下内边距 + 文字，再加上容器自己的 py-1 */
const MENU_ITEM_H = 24;
const MENU_PAD = 8;
const MENU_MAX_ITEMS = 4;
/** 分组分隔线：my-1 上下各 4px + 1px 线；最多三组（AI / 路径 / git） */
const MENU_DIVIDER_H = 9;
const MENU_MAX_DIVIDERS = 3;
const MENU_H = MENU_ITEM_H * MENU_MAX_ITEMS + MENU_DIVIDER_H * MENU_MAX_DIVIDERS + MENU_PAD;
/**
 * 冲突行的解决菜单项更多（四条解决方式 + AI + 两条路径），文案也更长
 * （「接受当前更改」+ `checkout --ours`），148px 装不下，单独宽一档、高度也重算。
 */
const CONFLICT_MENU_W = 220;
const CONFLICT_MENU_H = MENU_ITEM_H * 8 + MENU_DIVIDER_H * 3 + MENU_PAD;
/** 菜单项统一「图标 + 文字」两段；nowrap 免得长文案折行 */
const MENU_ITEM =
  "flex items-center gap-2 whitespace-nowrap px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";
/** 分组之间的一条细线 */
const MENU_DIVIDER = "my-1 h-px shrink-0 bg-line";

/**
 * 提交行的右键菜单（打标签 / 删标签）比改动行那份宽：项文案更长（「在此提交打标签…」
 * 8 个中文字，删标签还要带上标签名），右边还要跟一个 git 命令提示（tag / tag -d）。
 * 菜单项自己 `whitespace-nowrap`，所以宽度得够，标签名再长由行内 span 截断。
 */
const COMMIT_MENU_W = 200;

/** 菜单项右侧的 git 命令提示：小一号、灰色，和左边的中文说明拉开一眼能分 */
const MENU_CMD = "ml-auto shrink-0 pl-3 text-[10px] text-fg-faint";

/** 打标签对话框里的按钮，照 ConfirmDialog 那一套 */
const DIALOG_CANCEL =
  "rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg";
const DIALOG_CONFIRM =
  "rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40";

/** 写系统剪贴板。走插件而不是 navigator.clipboard：WebView2 会弹系统授权框 */
async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 行尾的 `+N -M`。两侧都没有数字时什么都不画（二进制、未跟踪文件统计不出来，
 * 显示「+0 -0」会让人误以为没改动）。
 *
 * 两个数字各自固定占位（`min-w-[3ch]` + 右对齐）：不然 `+9` 和 `+12` 会让整列的
 * 删除数左右错开，扫下来很乱。
 */
function LineCounts({
  added,
  removed,
}: {
  added: number | null;
  removed: number | null;
}) {
  if (added === null && removed === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
      {added !== null && added > 0 && (
        <span className="min-w-[3ch] text-right text-ok">+{added}</span>
      )}
      {removed !== null && removed > 0 && (
        <span className="min-w-[3ch] text-right text-danger">-{removed}</span>
      )}
    </span>
  );
}

/** diff 正文里一行的着色：加行绿、删行红、上下文默认、`\ No newline` 最淡 */
function hunkLineClass(line: string): string {
  if (line.startsWith("+")) return "text-ok";
  if (line.startsWith("-")) return "text-danger";
  if (line.startsWith("\\")) return "text-fg-faint";
  return "text-fg-muted";
}

/**
 * 一个文件的逐块 / 逐行操作。两组各传一份——同一个路径可能同时出现在两组里
 * （`MM`），所以除了 path 还要带上它属于哪一组，否则同一行会在两组里一起展开。
 */
interface HunkSection {
  /** 展开着的那个文件（绝对路径）；null = 一个都没展开 */
  open: string | null;
  /** 展开的文件属于哪一组 */
  staged: boolean;
  /** 展开文件的 hunk 列表；null = 还没拉到 */
  data: FileHunks | null;
  loading: boolean;
  /** 每个 hunk 里选中的正文行下标（key 是 hunk 序号）；空集 = 没选，按钮作用于整块 */
  selection: ReadonlyMap<number, ReadonlySet<number>>;
  onToggle: (path: string, staged: boolean) => void;
  /** 点某一行：切换它的选中状态；`shift` 时从上次点的位置连选一段 */
  onLineClick: (hunkIndex: number, bodyIndex: number, changeLine: boolean, shift: boolean) => void;
  onStage: (patch: string, lines: number[]) => void;
  onUnstage: (patch: string, lines: number[]) => void;
  /** 放弃不可撤销，这里只记下来弹确认框，用户点了才真跑 */
  onDiscard: (patch: string, lines: number[], what: string) => void;
}

/**
 * 展开出来的逐块列表：一块一个头（`@@` 行 + 增删数 + 操作按钮）加它的 diff 正文。
 *
 * 交给后端的补丁是「文件级头 + 这一块的原文」拼出来的，中间的每个字节都原样保留——
 * 补丁要和 `git diff` 的输出完全一致才 apply 得上。
 *
 * 正文里的改动行（`+` / `-`）可以点选：选中若干行后，头部的按钮只作用于这些行
 * （后端把没选中的改动还原回基线）；没选中时按钮作用于整块，和原来一样。
 */
function HunkList({
  file,
  loading,
  busy,
  indent,
  staged,
  selection,
  onLineClick,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: FileHunks | null;
  loading: boolean;
  busy: boolean;
  /** 和文件行左边缘对齐（树视图里有层级） */
  indent: number;
  staged: boolean;
  selection: ReadonlyMap<number, ReadonlySet<number>>;
  onLineClick: (hunkIndex: number, bodyIndex: number, changeLine: boolean, shift: boolean) => void;
  onStage: (patch: string, lines: number[]) => void;
  onUnstage: (patch: string, lines: number[]) => void;
  onDiscard: (patch: string, lines: number[], what: string) => void;
}) {
  const notice = (text: string) => (
    <p className="py-1 text-[11px] text-fg-faint" style={{ paddingLeft: indent }}>
      {text}
    </p>
  );

  if (!file) return notice(loading ? "加载中…" : "读不到这个文件的改动");
  if (file.hunks.length === 0) {
    return notice(
      staged
        ? "这个文件只能整文件取消暂存（新增、删除或二进制）"
        : "这个文件只能整文件暂存 / 放弃（新增、删除或二进制）",
    );
  }

  return (
    <div
      className="mb-1 overflow-hidden rounded border border-line"
      style={{ marginLeft: indent, marginRight: 4 }}
    >
      {file.hunks.map((hunk, index) => {
        const patch = file.header + hunk.text;
        const lines = hunk.text.split("\n");
        // 原文以换行结尾，split 会多出一个空串；首行是 `@@`，正文从第二行起
        if (lines[lines.length - 1] === "") lines.pop();
        const body = lines.slice(1);
        // 选中的行下标排好序传回后端（顺序无所谓，排一下好读）
        const selected = selection.get(index);
        const picked = selected ? [...selected].sort((a, b) => a - b) : [];
        const scope = picked.length > 0 ? `选中的 ${picked.length} 行` : "这块改动";
        return (
          <div key={index} className="border-b border-line last:border-b-0">
            <div className="flex items-center gap-1.5 bg-surface px-2 py-0.5 font-mono text-[11px]">
              <span className="min-w-0 flex-1 truncate text-fg-dim" title={hunk.header}>
                {hunk.header}
              </span>
              {picked.length > 0 && (
                <span className="shrink-0 text-accent" title="按钮只作用于选中的行">
                  已选 {picked.length} 行
                </span>
              )}
              {hunk.added > 0 && <span className="shrink-0 text-ok">+{hunk.added}</span>}
              {hunk.removed > 0 && <span className="shrink-0 text-danger">-{hunk.removed}</span>}
              {staged ? (
                <button
                  type="button"
                  onClick={() => onUnstage(patch, picked)}
                  disabled={busy}
                  title={`取消暂存${scope}`}
                  className={HUNK_ACTION}
                >
                  <IconMinus className="h-3 w-3" />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onDiscard(patch, picked, scope)}
                    disabled={busy}
                    title={`放弃${scope}（还原到暂存区）`}
                    className={HUNK_DANGER}
                  >
                    <IconUndo className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onStage(patch, picked)}
                    disabled={busy}
                    title={`暂存${scope}`}
                    className={HUNK_ACTION}
                  >
                    <IconPlus className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
            <div className="overflow-x-auto py-1 font-mono text-[11px] leading-[1.55] select-none">
              {body.map((line, lineIndex) => {
                // 只有改动行可选：上下文行选它没有意义（后端也不看）
                const change = line.startsWith("+") || line.startsWith("-");
                const on = selected?.has(lineIndex) ?? false;
                return (
                  <div
                    key={lineIndex}
                    onClick={(event) => {
                      if (!change) return;
                      onLineClick(index, lineIndex, change, event.shiftKey);
                    }}
                    title={change ? "点击选中这一行（Shift 点击连选一段）" : undefined}
                    className={`whitespace-pre px-2 ${hunkLineClass(line)} ${
                      change ? "cursor-pointer hover:bg-hover" : ""
                    } ${on ? "bg-accent/15" : ""}`}
                  >
                    {line === "" ? " " : line}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChangeRow({
  change,
  staged,
  busy,
  depth,
  hunks,
  onOpen,
  onOpenFile,
  onToggle,
  onDiscard,
  onMenu,
  selected,
  onSelect,
}: {
  change: GitChange;
  /** true = 在"暂存的改动"组里，行内按钮是取消暂存 */
  staged: boolean;
  busy: boolean;
  /** 树视图里的层级；null = 列表视图（不缩进、不画文件图标、名字后面补目录） */
  depth: number | null;
  /** 逐块 / 逐行操作；两组都传，具体给哪些按钮由 staged 决定（见 HunkSection） */
  hunks?: HunkSection;
  onOpen: (path: string, source: DiffSource) => void;
  onOpenFile: (path: string) => void;
  onToggle: (path: string) => void;
  onDiscard: (change: GitChange) => void;
  onMenu: (change: GitChange, staged: boolean, event: ReactMouseEvent) => void;
  selected: (change: GitChange) => boolean;
  onSelect: (change: GitChange, event: ReactMouseEvent) => void;
}) {
  const slash = change.relative.lastIndexOf("/");
  const name = slash === -1 ? change.relative : change.relative.slice(slash + 1);
  const dir = slash === -1 ? "" : change.relative.slice(0, slash);
  // 暂存组看 X 列，未暂存组看 Y 列：`AM` 在两组里该显示成不同的字母
  const mark = markOfColumn(staged ? change.index : change.worktree);
  // 未跟踪目录只是整条折叠出来的一个占位项，不是文件：点开差异等于去读目录，
  // 后端会报 "Is a directory"。这一行既不给差异、也不给「打开文件」。
  const isDir = change.isDir;
  // 文件已经被删了就没什么可打开的——点「打开文件」会读到一个不存在的路径
  const exists = mark.kind !== "deleted" && !isDir;
  // 行数也按分组取：同一个 `MM` 文件在两个组里改动的量本来就不一样
  const added = staged ? change.stagedAdded : change.unstagedAdded;
  const removed = staged ? change.stagedRemoved : change.unstagedRemoved;
  /** 这一行能不能逐块操作。整行（含箭头占位）都跟着它走。两组判据不同，见 canHunk* */
  const hunkable = hunks !== undefined && (staged ? canHunkStaged(change) : canHunk(change));
  // 多带一次 `hunks !== undefined`：JSX 里靠它把类型收窄，才能取 hunks.data。
  // 还要对上是哪一组：同一路径可能同时在两组里，不判的话会在两组里一起展开
  const hunkOpen =
    hunkable && hunks !== undefined && hunks.open === change.path && hunks.staged === staged;
  // 展开区缩进到和文件名对齐：树视图里层级已经占了前导空白
  const hunkIndent = depth === null ? 4 : depth * INDENT + 4;
  // 选中行用整行底色：和文件树选中同一套语义色，深浅主题下都对照得上
  const isSelected = selected(change);

  return (
    <>
    <div
      // 选中行不挂 hover 底色，否则鼠标划过去会把选中色盖掉、看不出还选着哪些
      className={`group flex items-center gap-1.5 rounded px-1 py-[3px] text-[12px] ${
        isSelected ? "bg-selected" : "hover:bg-hover"
      }`}
      style={depth === null ? undefined : { paddingLeft: depth * INDENT + 4 }}
      onContextMenu={(event) => onMenu(change, staged, event)}
    >
      <button
        type="button"
        // 目录项点开差异会去读目录、必报错，所以不响应点击（它只是折叠出来的一行占位）。
        // 带 Ctrl/⌘ 或 Shift 的点击是「选中」而不是「打开」——这两种修饰键只改选中集。
        onClick={(event) => {
          if (isDir) return;
          if (event.ctrlKey || event.metaKey || event.shiftKey) {
            onSelect(change, event);
            return;
          }
          onOpen(change.path, staged ? { mode: "staged" } : { mode: "unstaged" });
        }}
        title={isDir ? `${toDisplayPath(change.path)}（目录）` : toDisplayPath(change.path)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {/* 树视图里空出目录行折叠箭头的宽度，文件名和同层目录名左边缘对齐；
            列表视图没有目录行，直接顶到最左 */}
        {depth !== null && <span className="w-3 shrink-0" />}
        <span className="flex shrink-0 items-center text-fg-icon">
          {isDir ? (
            // 列表视图里的目录行（树视图的目录行是 ChangeDirRow），没有展开态，用闭合图标
            <FolderTypeIcon name={name} className="h-3.5 w-3.5" />
          ) : (
            <FileTypeIcon name={name} className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="min-w-0 truncate text-fg-muted">{name}</span>
        {/* 树视图里层级已经说明了在哪个目录，再补一遍目录反而啰嗦。
            目录的收缩权重拉满：空间不够时先让目录消失、把宽度全留给文件名——
            文件名才是扫列表时要认的东西，目录看不全无所谓 */}
        {depth === null && dir && (
          <span className="min-w-0 shrink-[999] truncate text-[11px] text-fg-faint">{dir}</span>
        )}
      </button>
      {/* 右侧这一串（操作图标 + 状态徽标）单独成组：行上的 gap-1.5 对它们太松，
          组内压到 gap-0.5 更紧凑；命中区仍是 20px，不为了紧凑牺牲点击。
          徽标压在最后（最右）：它每行都在、按钮是悬停才显形，这样同一列的
          徽标在每行都对齐，扫下来不用左右找 */}
      <div className="flex shrink-0 items-center gap-0.5">
        {/* 行内操作 + 行数：平时收成 0 宽、藏起来，悬停或键盘聚焦到行内才撑开。
            这样文件名能占满整行；状态字母放在这一组外面，始终对齐、不跟着动 */}
        <div className="pointer-events-none flex w-0 shrink-0 items-center gap-0.5 overflow-hidden opacity-0 group-hover:pointer-events-auto group-hover:w-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:w-auto group-focus-within:opacity-100">
          {/* 打开文件排在更右边、放弃修改在左边，中间留给暂存/取消暂存，
              和行内既有的一串操作连起来读就是「放弃 → 暂存 → 打开」 */}
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
          {exists && (
            <button
              type="button"
              onClick={() => onOpenFile(change.path)}
              title="打开文件（看完整内容，不开差异）"
              className={ROW_ACTION}
            >
              <IconPencil className="h-3 w-3" />
            </button>
          )}
          <LineCounts added={added} removed={removed} />
          {/* 没展开时，逐块操作入口也藏进这一组，跟其它按钮一起悬停才出现 */}
          {!hunkOpen && hunks !== undefined && hunkable && (
            <button
              type="button"
              onClick={() => hunks.onToggle(change.path, staged)}
              title={staged ? "展开逐块操作（逐块 / 逐行取消暂存）" : "展开逐块操作（逐块 / 逐行暂存 / 放弃）"}
              className={ROW_HUNK_TOGGLE}
            >
              <IconChevronRight className="h-3 w-3" />
            </button>
          )}
        </div>
        {/* 展开着的行给箭头常驻位置：展开是这一行的状态，藏起来就看不出哪行开着。
            压在状态字母左边，不影响字母那一列的对齐 */}
        {hunkOpen && hunks !== undefined && (
          <button
            type="button"
            onClick={() => hunks.onToggle(change.path, staged)}
            title="收起逐块操作"
            className={ROW_HUNK_TOGGLE}
          >
            <IconChevronDown className="h-3 w-3" />
          </button>
        )}
        <GitMarkBadge mark={mark} className="text-[10px]" />
      </div>
    </div>
    {hunkOpen && hunks !== undefined && (
      <HunkList
        file={hunks.data}
        loading={hunks.loading}
        busy={busy}
        indent={hunkIndent}
        staged={staged}
        selection={hunks.selection}
        onLineClick={hunks.onLineClick}
        onStage={hunks.onStage}
        onUnstage={hunks.onUnstage}
        onDiscard={(patch, lines, scope) =>
          hunks.onDiscard(patch, lines, `${change.relative}：${scope}`)
        }
      />
    )}
    </>
  );
}

/**
 * 目录名里的分隔符按平台显示：Windows 用反斜杠，其余平台保持正斜杠。
 * 和 lib/keys.ts 判主修饰键同一套办法（只看 UA）——判错顶多是观感差异，不涉及系统能力。
 */
const DIR_SEP = /windows/i.test(navigator.userAgent) ? "\\" : "/";

/** 树视图里的目录行：点一下收起或展开它下面的东西 */
function ChangeDirRow({
  node,
  depth,
  collapsed,
  onToggle,
  mark,
}: {
  node: ChangeTreeNode;
  depth: number;
  collapsed: boolean;
  onToggle: (path: string) => void;
  /** 整棵子树里最重的状态；null = 底下没有任何改动 */
  mark: GitMark | null;
}) {
  // 单链目录行显示的是 `a/b/c` 这样一整段，图标按最后一段（也就是真正的目录名）挑
  const name = node.name.split("/").pop() ?? node.name;
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
        <FolderTypeIcon name={name} isOpen={!collapsed} className="h-3.5 w-3.5" />
      </span>
      {/* 单链已经合并过，这里可能是 `a/b/c` 这样一整段路径；分隔符按平台显示（见 DIR_SEP） */}
      <span className="min-w-0 flex-1 truncate">{node.name.split("/").join(DIR_SEP)}</span>
      {mark && <GitMarkDot mark={mark} className="h-1.5 w-1.5" />}
    </button>
  );
}

/** 一组改动共用的行内操作，从分组一路传到每个文件行 */
interface ChangeRowActions {
  staged: boolean;
  busy: boolean;
  /** 逐块 / 逐行操作；两组都传 */
  hunks?: HunkSection;
  onOpen: (path: string, source: DiffSource) => void;
  /** 行内「打开文件」：开文件内容而不是差异 */
  onOpenFile: (path: string) => void;
  onToggle: (path: string) => void;
  onDiscard: (change: GitChange) => void;
  onMenu: (change: GitChange, staged: boolean, event: ReactMouseEvent) => void;
  /** 这一行是不是批量操作的目标（选中态）。按组闭包好，签名里不用再带 staged */
  selected: (change: GitChange) => boolean;
  /** 按住 Ctrl/⌘ 或 Shift 点行时的选中逻辑；普通点击仍走 onOpen */
  onSelect: (change: GitChange, event: ReactMouseEvent) => void;
}

interface ChangeTreeActions extends ChangeRowActions {
  /** 收起来的目录（工作区相对路径）。空集合 = 全展开 */
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
}

/**
 * 改动列表的两个分组。
 *
 * 折叠状态按组各存一份：同一批文件里的 `MM` 会同时出现在两组，但两组的排序、
 * 层级、操作都不一样，共用一个集合会出现「在暂存组收起 src/，未暂存组里同名目录
 * 也跟着塌掉」——那边的目录下有什么用户根本没看见。
 */
type ChangeGroup = "staged" | "unstaged";

/** 每组一份的折叠状态。空集合 = 全展开，正好是默认要的样子 */
type CollapsedDirs = Record<ChangeGroup, ReadonlySet<string>>;

/**
 * 选中集的 key：连分组一起算。同一个路径可能同时在两组里（`MM`），只按路径存的话
 * 在暂存组点亮一行、未暂存组那一行也会跟着亮，批量操作还会把两组都算进去。
 */
function selectKey(staged: boolean, path: string): string {
  return `${staged ? "s" : "u"}:${pathKey(path)}`;
}

/**
 * 树视图里按渲染顺序摊平出一串文件行（目录行不参与选择）。
 * 收起来的目录整棵跳过——那些行没画在屏幕上，Shift 连选不该把它们也算进来。
 */
function flattenTreePaths(
  nodes: readonly ChangeTreeNode[],
  collapsedDirs: ReadonlySet<string>,
): string[] {
  const paths: string[] = [];
  const walk = (list: readonly ChangeTreeNode[]) => {
    for (const node of list) {
      if (node.children) {
        if (!collapsedDirs.has(node.path)) walk(node.children);
      } else if (node.change) {
        paths.push(node.change.path);
      }
    }
  };
  walk(nodes);
  return paths;
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
              mark={aggregateMark(node, rowActions.staged)}
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
 *
 * `group` 决定用哪一份折叠状态，也决定收放时该改哪一份（见 ChangeGroup）。
 */
function ChangeList({
  group,
  changes,
  tree,
  view,
  collapsedDirs,
  onToggleDir,
  ...rowActions
}: ChangeRowActions & {
  group: ChangeGroup;
  changes: readonly GitChange[];
  tree: readonly ChangeTreeNode[];
  view: ChangeView;
  /** 两组的折叠状态，按 group 取自己那份 */
  collapsedDirs: CollapsedDirs;
  onToggleDir: (group: ChangeGroup, path: string) => void;
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
      collapsedDirs={collapsedDirs[group]}
      onToggleDir={(path) => onToggleDir(group, path)}
      {...rowActions}
    />
  );
}

/**
 * 「合并冲突」组里的一行：文件名 + 状态徽标 + 一个常驻的「解决」按钮。
 *
 * 冲突行不给暂存 / 放弃那套——它们对未合并文件没有正确的语义。点行打开文件
 * （让用户看冲突标记、必要时手改），点解决按钮（或右键）开解决菜单。
 *
 * 解决按钮**常驻可见**：冲突组本来就短，藏进悬停反而看不出这一行能干什么。
 */
function ConflictRow({
  change,
  busy,
  onOpenFile,
  onMenu,
}: {
  change: GitChange;
  busy: boolean;
  onOpenFile: (path: string) => void;
  /** 开「解决冲突」菜单（固定定位，画在面板底部那一层） */
  onMenu: (change: GitChange, staged: boolean, event: ReactMouseEvent) => void;
}) {
  const slash = change.relative.lastIndexOf("/");
  const name = slash === -1 ? change.relative : change.relative.slice(slash + 1);
  const dir = slash === -1 ? "" : change.relative.slice(0, slash);
  return (
    <div
      className="group flex items-center gap-1.5 rounded px-1 py-[3px] text-[12px] hover:bg-hover"
      onContextMenu={(event) => onMenu(change, false, event)}
    >
      <button
        type="button"
        onClick={() => onOpenFile(change.path)}
        title={`${toDisplayPath(change.path)}（冲突）`}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className="flex shrink-0 items-center text-fg-icon">
          <FileTypeIcon name={name} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 truncate text-fg-muted">{name}</span>
        {dir && (
          <span className="min-w-0 shrink-[999] truncate text-[11px] text-fg-faint">{dir}</span>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={(event) => onMenu(change, false, event)}
          disabled={busy}
          title="解决冲突（接受当前 / 接受传入 / 保留两者）"
          className={ROW_HUNK_TOGGLE}
        >
          <IconMerge className="h-3 w-3" />
        </button>
        {/* 冲突统一显示 C，和文件树 / 标签页那份 markOfXY 的徽标一致 */}
        <GitMarkBadge mark={{ label: "C", kind: "conflict" }} className="text-[10px]" />
      </div>
    </div>
  );
}

/** 引用 chip 的 kind -> 中文说明，只用在 title 上 */
const REF_KIND_LABEL: Record<CommitRef["kind"], string> = {
  head: "当前分支",
  branch: "分支",
  remote: "远程分支",
  tag: "标签",
};

/** 提交行里的引用标签：当前分支填色、标签用警示色，其余描边，和 VS Code 的语汇一致 */
function RefChip({ reference }: { reference: CommitRef }) {
  const tone =
    reference.kind === "head"
      ? "bg-accent-strong text-app"
      : reference.kind === "tag"
        ? "border border-warn-line text-warn"
        : reference.kind === "remote"
          ? "border border-line text-fg-faint"
          : "border border-line-strong text-fg-muted";
  return (
    <span
      title={`${REF_KIND_LABEL[reference.kind]}：${reference.name}`}
      className={`shrink-0 max-w-[9rem] truncate rounded px-1 text-[10px] leading-4 ${tone}`}
    >
      {reference.name}
    </span>
  );
}

/**
 * 一条提交：左侧是泳道图，点一下就地展开它改了哪些文件，再点收起。
 * 展开的文件点进去看的是「这个提交 vs 它的父提交」的差异。
 */
function CommitRow({
  commit,
  graph,
  graphWidth,
  expanded,
  files,
  stat,
  unpushed,
  anchor,
  selected,
  onToggle,
  onSelect,
  onOpen,
  onHover,
  onUnhover,
  onStat,
  onMenu,
}: {
  commit: GitCommit;
  /** 泳道图那一格；null = 不画图（过滤后只剩一部分提交，泳道接不上，干脆让位给文字） */
  graph: GraphRow | null;
  /** 图列的统一宽度，各行一致，后面的文字才左对齐 */
  graphWidth: number;
  expanded: boolean;
  /** undefined = 还没拉到 */
  files: GitCommitFile[] | undefined;
  /** undefined = 还没拉到。悬停浮框上的改动规模 */
  stat: CommitStat | undefined;
  /** 还没推送到上游。标一下，省得用户去数 ahead 有几个 */
  unpushed: boolean;
  /**
   * 悬停浮框贴着的矩形；null = 这一行没开着浮框。
   * 状态由整份列表统一持有（见 GitChangesPane 里的 hoverCommit），行本身不存。
   */
  anchor: DOMRect | null;
  /** 这一行是不是「比较」集合里选中的提交，选中行铺底色 */
  selected: boolean;
  onToggle: () => void;
  /** Ctrl/⌘ 或 Shift 点：切换这一行的「比较」选中态，不展开 */
  onSelect: () => void;
  onOpen: (path: string, source: DiffSource) => void;
  /** 鼠标进到这一行：报上本行矩形，让列表把浮框换过来 */
  onHover: (rect: DOMRect) => void;
  /** 鼠标离开这一行。可能只是穿 GAP 去浮框，收不收由列表按延迟定 */
  onUnhover: () => void;
  /** 鼠标进到这一行时喊一声，上层按需去拉改动规模 */
  onStat: () => void;
  /** 右键这一行：开「打标签 / 删标签」菜单 */
  onMenu: (event: ReactMouseEvent) => void;
}) {
  const relativeTime = formatTime(commit.time);

  return (
    <div
      className="flex"
      // 定位「回到 HEAD」用：按 hash 在滚动容器里找到这一行
      data-commit={commit.hash}
      onContextMenu={onMenu}
      onMouseEnter={(event) => {
        onHover(event.currentTarget.getBoundingClientRect());
        onStat();
      }}
      onMouseLeave={onUnhover}
      // 滚动时行会跑掉、浮框留在原地，干脆收起来
      onWheel={onUnhover}
    >
      {graph && <CommitGraph row={graph} width={graphWidth} local={unpushed} />}
      {/* 负 margin：文字贴住本行圆圈，图列右边没线的那截让它盖上去 */}
      <div
        className="min-w-0 flex-1"
        style={{ marginLeft: graph ? graphTextInset(graph, graphWidth) : 0 }}
      >
        <button
          type="button"
          onClick={(event) => {
            // Ctrl/⌘ 或 Shift 点是「选进比较」而不是展开/收起——和改动列表那边多选一致
            if (event.ctrlKey || event.metaKey || event.shiftKey) onSelect();
            else onToggle();
          }}
          className={`@container flex h-[22px] w-full items-center gap-1.5 rounded px-1 text-left text-[11px] ${
            selected ? "bg-selected" : "hover:bg-hover"
          }`}
        >
          {/* 引用标签按行宽显隐：窄了整组收起来，把宽度让给提交主题，别把主题挤成 0 宽 */}
          {commit.refs.length > 0 && (
            <span className="hidden min-w-0 items-center gap-1.5 @min-[18rem]:flex">
              {commit.refs.slice(0, MAX_REF_CHIPS).map((reference) => (
                <RefChip key={`${reference.kind}:${reference.name}`} reference={reference} />
              ))}
              {commit.refs.length > MAX_REF_CHIPS && (
                <span
                  title={commit.refs
                    .slice(MAX_REF_CHIPS)
                    .map((reference) => `${REF_KIND_LABEL[reference.kind]}：${reference.name}`)
                    .join("\n")}
                  className="shrink-0 rounded border border-line px-1 text-[10px] leading-4 text-fg-faint"
                >
                  +{commit.refs.length - MAX_REF_CHIPS}
                </span>
              )}
            </span>
          )}
          {/* 未推送的用强调色：本地领先上游的那一段一眼就能圈出来，不用去数 ↑ 有几个 */}
          <span className={`min-w-0 flex-1 truncate ${unpushed ? "text-accent" : "text-fg-muted"}`}>
            {commit.subject}
          </span>
          <span className="w-20 max-w-[40%] shrink-0 truncate text-right text-[10px] text-fg-faint">
            {relativeTime}
          </span>
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

      {/* 挂在本行里（fixed 定位，不受列表滚动容器裁剪）：鼠标能移进来点复制 */}
      {anchor && (
        <CommitTooltip
          commit={commit}
          relative={relativeTime}
          stat={stat ?? null}
          anchor={anchor}
        />
      )}
    </div>
  );
}

/**
 * 「在此提交打标签」的小对话框：标签名必填，勾了「附注标签」才带说明。
 *
 * 不用 `window.prompt`——WKWebView 不支持，调用会静默失效（同 ConfirmDialog 的理由）。
 * 外壳照 ConfirmDialog 那一套（遮罩 + 圆角卡片），点遮罩或按 Esc 都取消。
 */
function TagDialog({
  commit,
  onConfirm,
  onCancel,
}: {
  commit: GitCommit;
  /** message 为 undefined 表示建轻量标签；给了（含空串）就是附注标签 */
  onConfirm: (name: string, message?: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [annotated, setAnnotated] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    // 这里的 KeyboardEvent 是 DOM 的那个（文件顶部 import 的 React KeyboardEvent 会遮蔽全局名）
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // 勾了附注就把说明原样带上（哪怕空串，git 也会建出空说明的附注标签）
    onConfirm(trimmed, annotated ? message : undefined);
  };

  return (
    <div
      className="codovo-modal-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // 认「按下点就在遮罩上」而不是 click：从卡片内按下、拖到遮罩上松开会被误判成点外部
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[380px] max-w-full rounded-xl border border-line-strong bg-raised p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-[12px] text-fg">
          在提交 <span className="font-mono text-fg-muted">{commit.short}</span> 上新建标签
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="标签名（如 v1.0.0）"
            className={TEXT_INPUT}
          />
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted">
            <input
              type="checkbox"
              checked={annotated}
              onChange={(event) => setAnnotated(event.target.checked)}
              className="accent-accent"
            />
            附注标签
          </label>
          {annotated && (
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="说明（可留空）"
              rows={3}
              className={`${TEXT_INPUT} resize-none`}
            />
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={DIALOG_CANCEL}>
            取消
          </button>
          <button type="button" onClick={submit} disabled={!name.trim()} className={DIALOG_CONFIRM}>
            创建标签
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 工作树概览里的一行：工作树名 + 它检出的分支 + 状态。
 *
 * 两行排布而不是挤一行：右栏通常只有两三百像素宽，工作树名、分支、状态三样塞一行会
 * 各自被截得很短，反而看不出哪个脏、在哪个分支上。名称那一行右侧只放**要立刻看到**
 * 的状态（变更数 / 合并中 / 失效），分支与领先落后放第二行的淡色小字。
 */
function WorktreeRow({
  worktree,
  status,
  onPick,
}: {
  worktree: WorktreeInfo;
  /** 这棵工作树的动态状态；null = 还没拉到（或这棵算不出状态） */
  status: WorktreeStatus | null;
  onPick: (target: WorktreeInfo) => void;
}) {
  const broken = worktree.prunable || !worktree.exists;
  const branch = worktree.bare
    ? "bare"
    : worktree.detached
      ? "游离 HEAD"
      : (worktree.branch ?? "游离 HEAD");
  const changed = status?.changed ?? null;
  const merging = status?.merging ?? false;
  return (
    <button
      type="button"
      onClick={() => onPick(worktree)}
      // 失效记录切不过去（目录都没了），点了只会白跑一次命令
      disabled={broken}
      title={toDisplayPath(worktree.path)}
      className={`flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left ${
        worktree.current ? "bg-selected" : "hover:bg-hover"
      } disabled:opacity-60 disabled:hover:bg-transparent`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {/* 当前这棵用一个实心点标出来：底色之外再给个不依赖颜色的记号 */}
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            worktree.current ? "bg-accent" : "bg-line-strong"
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">{worktree.name}</span>
        {broken ? (
          <span className="shrink-0 text-[10px] text-danger">已失效</span>
        ) : merging ? (
          <span className="shrink-0 text-[10px] text-warn">合并中</span>
        ) : changed !== null && changed > 0 ? (
          <span className="shrink-0 text-[10px] text-fg-muted">{changed} 变更</span>
        ) : changed === 0 ? (
          <span className="shrink-0 text-[10px] text-fg-faint">干净</span>
        ) : null}
        {worktree.locked && <span className="shrink-0 text-[10px] text-warn">已锁定</span>}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-3 text-[10px] text-fg-faint">
        <span className="min-w-0 truncate">{branch}</span>
        {/* 领先 / 落后上游：和头部那对 ↑↓ 一个口径，方便一眼找出「有未推送提交」的工作树 */}
        {status && status.ahead > 0 && <span className="shrink-0 text-accent">↑{status.ahead}</span>}
        {status && status.behind > 0 && <span className="shrink-0">↓{status.behind}</span>}
      </span>
    </button>
  );
}

/**
 * 「工作树概览」：变更面板顶部的一段常驻导航。
 *
 * 以**工作树为工作空间**：一眼看清仓库有哪几个并行任务（每个工作树一棵）、各自检出在
 * 哪个分支、有没有未提交 / 未推送的改动、哪棵失效了。点一行就把面板切过去看那棵——只换
 * 变更面板的数据源，终端 / 编辑器 / 文件树都不动（见 WorkspacePane 的 wtMap）。
 *
 * 只在有多个工作树（或面板切到了别的、需要切回来）时才渲染，单工作树仓库完全不占位置。
 */
function WorktreeOverview({
  worktrees,
  statuses,
  currentName,
  busy,
  collapsed,
  onToggleCollapsed,
  onPick,
  onPrune,
}: {
  worktrees: readonly WorktreeInfo[];
  statuses: ReadonlyMap<string, WorktreeStatus> | null;
  /** 当前面板所在工作树的名字；收起时也要看得见自己在哪 */
  currentName: string | null;
  busy: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onPick: (target: WorktreeInfo) => void;
  onPrune: () => void;
}) {
  const hasPrunable = worktrees.some((item) => item.prunable || !item.exists);
  return (
    <div className="flex shrink-0 flex-col border-b border-line">
      {/* 标题行：左边收起 / 展开，右边清理失效记录（照时间线标题栏那一套）。
          不能再整行做成一个 button——里面套 button 是非法的 */}
      <div className="flex h-7 w-full shrink-0 items-center gap-1 px-3 text-[11px] font-medium tracking-wide text-fg-dim">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? "展开工作树概览" : "收起工作树概览"}
          className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-fg"
        >
          {collapsed ? (
            <IconChevronRight className="h-3 w-3 shrink-0" />
          ) : (
            <IconChevronDown className="h-3 w-3 shrink-0" />
          )}
          <span className="shrink-0 whitespace-nowrap">工作树</span>
          <span className="shrink-0 text-fg-faint">{worktrees.length}</span>
          {/* 收起时把当前工作树名带出来，否则收起后就不知道自己在哪棵树上了 */}
          {collapsed && currentName && (
            <span className="min-w-0 truncate text-fg-faint">· {currentName}</span>
          )}
        </button>
        {hasPrunable && (
          <button
            type="button"
            onClick={onPrune}
            disabled={busy}
            title="清理目录已不存在的 worktree 记录（git worktree prune）"
            className={GROUP_ICON}
          >
            <IconTrash className="h-3 w-3" />
          </button>
        )}
      </div>
      {!collapsed && (
        // 限高 + 自己滚动：工作树多的时候别把下面的提交框 / 更改列表挤没
        <ul className="flex max-h-72 flex-col gap-0.5 overflow-auto px-1 pb-1">
          {worktrees.map((item) => (
            <li key={item.path}>
              <WorktreeRow
                worktree={item}
                status={statuses?.get(pathKey(item.path)) ?? null}
                onPick={onPick}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 改动列表 + 提交框 + 时间线，右栏「变更」模块的整屏内容。
 * 目录不是仓库时渲染空状态 + 「初始化 Git 仓库」按钮（见下面 `!snapshot.isRepo` 那段），
 * 不再整个不渲染——工具列表那边也不把这行置灰了。
 */
export function GitChangesPane({
  root,
  workspaceRoot,
  visible,
  moduleVisible,
  reloadSignal,
  git,
  onOpen,
  onOpenFile,
  onSelectWorktree,
}: GitChangesPaneProps) {
  const { settings } = useSettings();
  const [message, setMessage] = useState("");
  /**
   * AI 给的「分条提交」方案；null = 没在预览。
   * 只围绕一个主题时不用它（直接填进 message 走原来的单条提交），横跨多个主题才摆出预览面板。
   */
  const [plan, setPlan] = useState<CommitPlanItem[] | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  /** 中止合并会丢掉整次合并尝试，和放弃修改一样先过确认框 */
  const [pendingMergeAbort, setPendingMergeAbort] = useState(false);
  /** amend 会改写历史（已推送的话本地就和远程分叉了），落手前先确认 */
  const [pendingAmend, setPendingAmend] = useState(false);
  /** 放弃 stash：只删记录，但丢了就找不回来，照样确认一下 */
  const [pendingStashDrop, setPendingStashDrop] = useState<GitStash | null>(null);
  /**
   * 展开逐块操作的那个文件：绝对路径 + 它属于哪一组。同一个路径可能同时出现在
   * 暂存 / 未暂存两组里（`MM`），所以要连组一起记，只有对上那个组的行才展开。
   */
  const [hunkOpen, setHunkOpen] = useState<{ path: string; staged: boolean } | null>(null);
  /** 展开文件的 hunk 列表；null = 还没拉到（或者拉失败了） */
  const [hunkData, setHunkData] = useState<FileHunks | null>(null);
  const [hunkLoading, setHunkLoading] = useState(false);
  /** 每次应用完一块 +1：apply 只回新的状态快照，不带块列表，得自己重拉 */
  const [hunkRevision, setHunkRevision] = useState(0);
  /** 每个 hunk 里选中的正文行下标（key 是 hunk 序号）。选中若干行后按钮只作用于这些行 */
  const [lineSelection, setLineSelection] = useState<ReadonlyMap<number, ReadonlySet<number>>>(
    () => new Map(),
  );
  /** Shift 连选的锚点：上一次点的那一行（hunk 之间互不影响） */
  const lineAnchor = useRef<{ hunk: number; line: number } | null>(null);
  /** 待确认的「放弃这一块 / 这些行」。补丁和选中行先记这儿，用户点了才真跑 */
  const [pendingHunkDiscard, setPendingHunkDiscard] = useState<{
    patch: string;
    lines: number[];
    what: string;
  } | null>(null);
  /**
   * null = 随内容长高（也就是默认的一行）；拖过之后是固定高度（px），内容多了自己滚动。
   * 高度不落盘：每次进应用都从一行起步，省得某次拖高之后再也回不到默认。
   */
  const [messageHeight, setMessageHeight] = useState<number | null>(null);
  const [draggingMessage, setDraggingMessage] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  /** 提交框拖动的起点，null 表示没在拖 */
  const messageDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  /**
   * 本次会话真正提交过的信息（按提交先后排列，最老的在前），供提交框按 ↑ / ↓ 回填。
   * 只活在内存里、不落盘：「这次开着应用时提交过什么」的临时便利，重启即散。
   */
  const messageHistoryRef = useRef<string[]>([]);
  /** 回填游标：null = 没在翻历史（停在用户草稿上），否则是 `messageHistoryRef` 的下标 */
  const historyIndexRef = useRef<number | null>(null);
  /** 翻历史前框里的草稿，↓ 越过最新一条时回到它 */
  const historyDraftRef = useRef("");
  /** 回填后是否要把光标移到末尾（受控组件得等这一拍渲染完再设选区） */
  const recallCursorRef = useRef(false);

  // 时间线
  const [logCollapsed, setLogCollapsed] = useState(() => readLogCollapsed(root));
  /** 时间线占面板高度的比例（不是像素）：面板变高变矮时时间线仍保持这个占比 */
  const [logRatio, setLogRatio] = useState(() => readLogRatio(root));
  /** 面板实测高度，0 表示还没量到（首帧） */
  const [panelHeight, setPanelHeight] = useState(0);
  const [draggingLog, setDraggingLog] = useState(false);
  /** 拖动起点，null 表示没在拖。startHeight 是像素，位移要除以面板高度才换得成比例 */
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const latestLogRatioRef = useRef(logRatio);
  latestLogRatioRef.current = logRatio;
  const stopLogDragRef = useRef<(() => void) | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => stopLogDragRef.current?.(), []);

  /**
   * 时间线的实际像素高度，由比例和面板高度现算。
   * 上下限只在这一处夹：MIN/MAX 管绝对范围，面板高度减 RESERVED_ABOVE 保证上面那块不被挤没。
   */
  const logHeight =
    panelHeight > 0
      ? Math.max(
          MIN_LOG_HEIGHT,
          Math.min(
            Math.min(MAX_LOG_HEIGHT, panelHeight - RESERVED_ABOVE),
            Math.round(panelHeight * logRatio),
          ),
        )
      : DEFAULT_LOG_HEIGHT;
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  /** null = 还没拉到 */
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  /**
   * 展开的那些提交。**可以同时展开多条**：比对两条提交改了同一批文件里的哪些，
   * 是这儿的常见动作，一次只许展开一条就得来回点、记住上一屏的内容。
   */
  const [openCommits, setOpenCommits] = useState<ReadonlySet<string>>(new Set());
  const [commitFiles, setCommitFiles] = useState<ReadonlyMap<string, GitCommitFile[]>>(new Map());
  /**
   * 各提交的改动规模，悬停浮框上用。和 commitFiles 一样是「拉到就留着」的懒加载缓存——
   * 悬停很频繁，不缓存的话鼠标划过去就是一片 git 进程。
   */
  const [commitStats, setCommitStats] = useState<ReadonlyMap<string, CommitStat>>(new Map());
  /** 已经在飞的 hash，别重复拉（失败会从这里删掉，允许再试） */
  const statRequests = useRef(new Set<string>());
  /** 还没推送到上游的提交号（完整 hash）。和提交列表一起拉，一起换 */
  const [unpushed, setUnpushed] = useState<ReadonlySet<string>>(new Set());
  /** 提交完 / 手动刷新时 +1，用来重拉历史 */
  const [logRevision, setLogRevision] = useState(0);
  /** 时间线的过滤词（输入框原文）。临时状态，不落盘 */
  const [logFilter, setLogFilter] = useState("");
  /** 过滤框是否展开：默认只留标题栏右边一个漏斗图标，点开才出现输入框 */
  const [logFilterOpen, setLogFilterOpen] = useState(false);
  /** 过滤按什么匹配：false = 主题 / 作者 / 正文，true = 改动过的路径 */
  const [logFilterPath, setLogFilterPath] = useState(false);
  /** 过滤词的防抖值：真正拿去查历史的是它，不是每敲一下都变 */
  const [logNeedle, setLogNeedle] = useState("");
  /** 历史滚动容器，「回到 HEAD」要让它滚过去 */
  const logScrollRef = useRef<HTMLDivElement>(null);

  /**
   * 时间线里为「比较两个提交」选中的提交号（最多 2 个，按点选先后）。
   * Ctrl/⌘ 或 Shift 点提交行切换；满 2 个后再选第三个时丢掉最早选的那个。
   */
  const [compareSel, setCompareSel] = useState<string[]>([]);
  /**
   * 正在看的两个 ref 之间的比较；null = 没在比较视图里。
   * `branch` 有值时是「从分支下拉进来的查看分支」：只读对比、不检出，顶部要标出查看态。
   */
  const [compare, setCompare] = useState<{
    from: string;
    to: string;
    label: string;
    branch?: string;
  } | null>(null);
  /** 比较视图的文件列表；null = 还没拉到 */
  const [compareFiles, setCompareFiles] = useState<GitCommitFile[] | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  /**
   * 右键「与分支比较…」要跟哪条提交比、分支菜单贴在哪儿；null = 菜单没开着。
   * 和 commitMenu 分开：那条菜单关掉之后这个还得留着画分支列表。
   */
  const [compareBranchMenu, setCompareBranchMenu] = useState<{
    commit: GitCommit;
    x: number;
    y: number;
  } | null>(null);
  /**
   * 比较请求的序号：退出 / 换成另一组对比后，先发出去的那次回来时已经不算数了，
   * 不丢掉会把旧结果盖到新视图上（同 explainSeq 的理由）。
   */
  const compareSeq = useRef(0);

  /**
   * 悬停浮框挂在哪个提交上、贴着哪个矩形；null = 没开着。
   *
   * **整份列表共用一个**：之前是每行各存各的 anchor，从一行划到相邻行时，上一行
   * HOVER_HIDE_MS 的延迟收起还没到点、下一行的浮框已经冒出来了，两个浮框叠在一起
   * （行距只有 22px，看着就是「迟滞」）。收起定时器也只有一份，进新行时一并取消。
   */
  const [hoverCommit, setHoverCommit] = useState<{ hash: string; rect: DOMRect } | null>(null);
  const hoverHideTimer = useRef<number | null>(null);
  const cancelHoverHide = () => {
    if (hoverHideTimer.current === null) return;
    window.clearTimeout(hoverHideTimer.current);
    hoverHideTimer.current = null;
  };
  const hideHover = () => {
    cancelHoverHide();
    hoverHideTimer.current = window.setTimeout(() => setHoverCommit(null), HOVER_HIDE_MS);
  };
  useEffect(() => cancelHoverHide, []);

  /** 改动列表怎么排：平铺还是按目录收起来。选择落盘，下次进应用照旧 */
  const [view, setView] = useState<ChangeView>(() => readChangeView(root));
  /** 树视图里各分组收起来的目录，按组各一份（见 ChangeGroup） */
  const [collapsedDirs, setCollapsedDirs] = useState<CollapsedDirs>(() => ({
    staged: new Set<string>(),
    unstaged: new Set<string>(),
  }));
  /**
   * 改动列表里选中的行（批量操作的目标）。key 见 selectKey，连分组一起算；
   * 和逐块操作的 lineSelection 各管各的——那是同一个文件内部的行选择。
   */
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  /** Shift 连选的锚点：上一次点的那一行（key 同 selection）；null = 还没有锚点 */
  const lastClickedRef = useRef<string | null>(null);
  /**
   * 改动列表的路径筛选。不落盘：属于「这次看的时候顺手找一下」的临时状态，
   * 下次进应用还得重新收一遍反而碍事（同 collapsedDirs）。
   */
  const [filter, setFilter] = useState("");
  /** 路径筛选框是否展开：默认只留工具行右边一个漏斗图标，点开才出现输入框 */
  const [filterOpen, setFilterOpen] = useState(false);

  // 分支下拉：null = 没开着。列表每次打开都重拉，让外部改动（fetch / 别处建分支）也能反映进来
  const [branchMenu, setBranchMenu] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);

  // worktree 概览：null = 还没拉到。列表只在仓库有多个工作树（或面板切到了别的
  // 工作树、需要切回来）时才有意义
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null);
  /**
   * 概览的折叠状态，按**工作区根**存 sessionStorage（不是面板当前看的 root）。概览列的是
   * 整个仓库的工作树，切换被查看的那棵不该跟着换折叠偏好——否则切到某棵曾在收起状态的
   * 工作树时，概览会莫名其妙地收起来。
   */
  const [wtCollapsed, setWtCollapsed] = useState(() => readWtCollapsed(workspaceRoot));
  /**
   * 各工作树的轻量动态状态（脏 / 领先落后 / 进行中），按 pathKey 对齐。null = 还没拉到
   * 或拉失败了。
   *
   * 和 `worktrees`（结构）分开：这份要逐棵跑 git status，成本高、拉得慢，用它自己的
   * 慢节奏独立于 2 秒的状态轮询。
   */
  const [wtStatuses, setWtStatuses] = useState<ReadonlyMap<string, WorktreeStatus> | null>(null);
  /** 每次动完 worktree（prune / 手动刷新）+1，用来重拉上面那份动态状态 */
  const [worktreeRevision, setWorktreeRevision] = useState(0);

  /** 「更多」下拉：装不常用的改写历史 / 储藏操作，默认收成工具行末尾一个图标按钮 */
  const [moreMenu, setMoreMenu] = useState(false);

  /** 「提交」右侧的分裂下拉：提交 / 提交（修改）/ 提交并推送 / 提交并同步。
      不复用 commitMenu——那个是提交行的右键菜单，两者互不相干 */
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);

  // stash：null = 还没拉到
  const [stashes, setStashes] = useState<GitStash[] | null>(null);
  /** 收 stash 时的说明，留空就让 git 自己生成 WIP on <branch>: ... */
  const [stashMessage, setStashMessage] = useState("");
  /** 每次动完 stash +1，用来重拉列表（不靠 payload，它只带 git 状态不带 stash 清单） */
  const [stashRevision, setStashRevision] = useState(0);

  /** 右键的那一行。staged 决定解读时跟谁比（暂存看 HEAD、未暂存看 index） */
  const [menu, setMenu] = useState<{
    change: GitChange;
    staged: boolean;
    x: number;
    y: number;
  } | null>(null);
  /**
   * 右键的那条提交（打标签 / 删标签）。和改动行的 menu 分开存：两者菜单项完全不同，
   * 合成一份状态反而要到处判「是行还是提交」。
   */
  const [commitMenu, setCommitMenu] = useState<{
    commit: GitCommit;
    x: number;
    y: number;
  } | null>(null);
  /** 「在此提交打标签」对话框：null = 没开着 */
  const [tagDialog, setTagDialog] = useState<GitCommit | null>(null);
  /** 待确认删除的标签（提交 + 标签名）。删标签不可撤销，先过确认框 */
  const [pendingTagDelete, setPendingTagDelete] = useState<{
    commit: GitCommit;
    name: string;
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

  // 冲突（U / AA / DD）单独成组，并从暂存 / 未暂存两组里排除——否则一个 `UU`
  // 会同时落进两组，行内那些整文件操作（暂存 / 放弃）对冲突文件也不适用
  const conflicts = useMemo(() => changes.filter(isConflict), [changes]);
  const staged = useMemo(
    () => changes.filter((change) => isStaged(change) && !isConflict(change)),
    [changes],
  );
  const unstaged = useMemo(
    () => changes.filter((change) => isUnstaged(change) && !isConflict(change)),
    [changes],
  );

  /** 筛选词归一化一次，供两条列表和「有没有筛掉东西」的判断共用 */
  const needle = filter.trim().toLowerCase();
  /**
   * 只按路径过滤。**不影响任何写操作**：下面「全部暂存 / 全部放弃」照旧作用于整个
   * 分组，筛选纯粹是「先在屏幕上找出来」，不承担选择语义——不然批量按钮的含义会
   * 随着筛选框里打了什么字而变，太容易误伤。
   */
  const stagedShown = useMemo(
    () => (needle ? staged.filter((item) => item.relative.toLowerCase().includes(needle)) : staged),
    [staged, needle],
  );
  const unstagedShown = useMemo(
    () =>
      needle ? unstaged.filter((item) => item.relative.toLowerCase().includes(needle)) : unstaged,
    [unstaged, needle],
  );
  const conflictsShown = useMemo(
    () =>
      needle ? conflicts.filter((item) => item.relative.toLowerCase().includes(needle)) : conflicts,
    [conflicts, needle],
  );

  // 两棵树只在树视图里用得上，但提前算好——改动列表通常就几十条，不值当再懒一层。
  // 用筛过的那份建树：树视图里同样只留命中的行
  const stagedTree = useMemo(() => buildChangeTree(stagedShown), [stagedShown]);
  const unstagedTree = useMemo(() => buildChangeTree(unstagedShown), [unstagedShown]);
  // 「全部放弃」只覆盖能放弃的那些，新文件不在内（见 canDiscard）
  const stagedDiscardable = useMemo(
    () => staged.filter((change) => canDiscard(change, true)),
    [staged],
  );
  const unstagedDiscardable = useMemo(
    () => unstaged.filter((change) => canDiscard(change, false)),
    [unstaged],
  );

  /**
   * 当前选中的行，按组各算（key 见 selectKey）。批量按钮和分组标题的「已选 N」都用它。
   * 用筛过的那份（Shown）：选中本来就是从屏幕上勾出来的，被筛选藏掉的行不该被算进去。
   */
  const stagedSelected = useMemo(
    () => stagedShown.filter((change) => selection.has(selectKey(true, change.path))),
    [stagedShown, selection],
  );
  const unstagedSelected = useMemo(
    () => unstagedShown.filter((change) => selection.has(selectKey(false, change.path))),
    [unstagedShown, selection],
  );
  /**
   * 本组「当前渲染顺序」下的选中 key，Shift 连选靠它算区间。
   * 不能直接用改动列表的原始顺序：树视图里目录会改行序，收起来的目录里的行也不该算进来。
   */
  const stagedOrder = useMemo(
    () =>
      (view === "list"
        ? stagedShown.map((change) => change.path)
        : flattenTreePaths(stagedTree, collapsedDirs.staged)
      ).map((path) => selectKey(true, path)),
    [view, stagedShown, stagedTree, collapsedDirs.staged],
  );
  const unstagedOrder = useMemo(
    () =>
      (view === "list"
        ? unstagedShown.map((change) => change.path)
        : flattenTreePaths(unstagedTree, collapsedDirs.unstaged)
      ).map((path) => selectKey(false, path)),
    [view, unstagedShown, unstagedTree, collapsedDirs.unstaged],
  );

  /**
   * 带修饰键点改动行的选中逻辑。
   * Ctrl/⌘：切换这一行的选中，并把锚点挪到它；Shift：从锚点连选到这一行（锚点不动）。
   */
  const selectChange = useCallback(
    (staged: boolean, order: readonly string[], change: GitChange, event: ReactMouseEvent) => {
      const key = selectKey(staged, change.path);
      const anchor = lastClickedRef.current;
      setSelection((current) => {
        const next = new Set(current);
        // 锚点必须还在本组当前顺序里，否则区间无从算起，退回单点切换
        if (event.shiftKey && anchor !== null && order.includes(anchor) && order.includes(key)) {
          const from = order.indexOf(anchor);
          const to = order.indexOf(key);
          const lo = Math.min(from, to);
          const hi = Math.max(from, to);
          for (let index = lo; index <= hi; index += 1) next.add(order[index]);
          return next;
        }
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      // 连选沿用原锚点；单点（Ctrl/⌘）才把锚点挪到这一行
      if (!event.shiftKey) lastClickedRef.current = key;
    },
    [],
  );

  /** 按组把选中逻辑闭包好，透给对应那组 ChangeRow（行本身不用再区分是哪一组） */
  const onSelectStaged = useCallback(
    (change: GitChange, event: ReactMouseEvent) => selectChange(true, stagedOrder, change, event),
    [selectChange, stagedOrder],
  );
  const onSelectUnstaged = useCallback(
    (change: GitChange, event: ReactMouseEvent) =>
      selectChange(false, unstagedOrder, change, event),
    [selectChange, unstagedOrder],
  );
  const isStagedSelected = useCallback(
    (change: GitChange) => selection.has(selectKey(true, change.path)),
    [selection],
  );
  const isUnstagedSelected = useCallback(
    (change: GitChange) => selection.has(selectKey(false, change.path)),
    [selection],
  );
  /** 筛完之后三组都没东西了（但改动本身还在），值得单独说一句 */
  const filteredOut =
    needle.length > 0 &&
    (staged.length > 0 || unstaged.length > 0 || conflicts.length > 0) &&
    stagedShown.length === 0 &&
    unstagedShown.length === 0 &&
    conflictsShown.length === 0;
  /**
   * 真正能被 `git stash push` 收走的那些改动。
   *
   * 不能用 `staged.length + unstaged.length` 代替：未跟踪的新文件也算在 unstaged 里，
   * 但它们不在 stash 的默认范围内。只有未跟踪文件时 git 会「成功退出但什么也没存」，
   * 界面就表现成一个点了没反应的按钮。
   */
  const stashable = useMemo(() => changes.filter(isStashable), [changes]);

  /**
   * 写操作统一走这里：全程禁用其它写按钮，失败就把 git 的报错摆出来。
   *
   * 再上一层重入保护：按钮都带 `disabled={busy !== null}`，但**不是所有入口都过按钮**
   * （比如储藏说明框上回车直接调 stash），一律放过会两个写命令叠着发、撞上自己的
   * index.lock。`busy` 是 state，在 useCallback 闭包里会读到旧值，所以另用 ref 兜住。
   */
  const busyRef = useRef(false);
  const run = useCallback(
    async (kind: Exclude<Busy, null>, task: () => Promise<GitStatusPayload | void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(kind);
      setError(null);
      try {
        // 写命令已经把新状态带回来了，直接落地，不用等下一个轮询周期；
        // 生成只填提交框、不动 git，返回空值时就跳过状态更新
        const payload = await task();
        if (payload) applyStatus(payload);
        // 写操作会让改动列表重排 / 行消失（暂存后行换组、放弃后行没了），
        // 之前的选中可能指向对不上的行，成功后一并清掉，免得残留
        setSelection(new Set());
        lastClickedRef.current = null;
      } catch (reason) {
        setError(String(reason));
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [applyStatus],
  );

  /**
   * 目录还不是仓库时把它初始化成一个（默认分支 main）。
   *
   * `git init` 对已有仓库是幂等的，所以不用先探一次；返回的新状态直接落地，
   * 下一次渲染就走正常内容了（历史那几个轮询 effect 也会因为 isRepo 变 true 自己起来）。
   */
  const initRepo = useCallback(() => {
    void run("init", () => gitInit(root));
  }, [run, root]);

  /**
   * 把这次真正提交出去的信息记进会话历史（在清空提交框之前调）。
   * 连续的重复项不再记（amend / 重提速同一句很常见）；只保留最近 MESSAGE_HISTORY_MAX 条。
   * 顺带把回填游标复位——刚要清空，下次按 ↑ 从这时最新的一条重新开始。
   */
  const rememberCommitMessage = useCallback((value: string) => {
    historyIndexRef.current = null;
    const text = value.trim();
    if (!text) return;
    const history = messageHistoryRef.current;
    if (history[history.length - 1] === text) return;
    history.push(text);
    if (history.length > MESSAGE_HISTORY_MAX) {
      history.splice(0, history.length - MESSAGE_HISTORY_MAX);
    }
  }, []);

  const commit = useCallback(() => {
    // 和提交按钮的 canCommit 同一判据：没暂存内容、或已有写操作在跑（busy）时直接返回。
    // 快捷键入口不过按钮的 disabled，光判 message 会发出一条必然失败（没东西可提交）
    // 或撞 index.lock 的 git commit。
    if (!message.trim() || busy !== null || staged.length === 0) return;
    void run("commit", async () => {
      const payload = await gitCommit(root, message);
      rememberCommitMessage(message); // 清空前记进历史
      setMessage(""); // 只有真提交成功才清空
      setLogRevision((revision) => revision + 1); // 刚多了一条提交
      return payload;
    });
  }, [message, busy, staged, run, rememberCommitMessage]);

  /**
   * 提交并推送：一次 run 里先提交再推。合成一个写操作是为了绕开忙碌互斥——
   * 分两次调 commit() / push()，第二次会被 busyRef 挡掉。提交成功才继续推，
   * 提交失败直接抛出去，不会留下半截状态。
   */
  const commitAndPush = useCallback(() => {
    if (!message.trim() || busy !== null || staged.length === 0) return;
    void run("commitPush", async () => {
      await gitCommit(root, message);
      rememberCommitMessage(message);
      setMessage("");
      setLogRevision((revision) => revision + 1);
      return await gitPush(root);
    });
  }, [message, busy, staged, run, root, rememberCommitMessage]);

  /**
   * 提交并同步：提交之后先「拉取（只允许快进）」把远程的带下来，再推上去。
   * 和「拉取」按钮同一套语义——本地远程分叉时分不清该快进还是合并，快进拉取会直接报错。
   */
  const commitAndSync = useCallback(() => {
    if (!message.trim() || busy !== null || staged.length === 0) return;
    void run("commitSync", async () => {
      await gitCommit(root, message);
      rememberCommitMessage(message);
      setMessage("");
      setLogRevision((revision) => revision + 1);
      await gitPull(root);
      setLogRevision((revision) => revision + 1);
      return await gitPush(root);
    });
  }, [message, busy, staged, run, root, rememberCommitMessage]);

  /**
   * 确认分条方案：后端一次性「清空暂存 → 逐组暂存 + 提交」，走和单条提交同一套链路。
   * 成功后才收起面板、清空输入框——失败了方案留着，用户可以直接重试。
   */
  const commitPlan = useCallback(() => {
    if (!plan || busy !== null) return;
    void run("commit", async () => {
      const payload = await gitCommitGroups(root, plan);
      setPlan(null);
      rememberCommitMessage(message);
      setMessage("");
      setLogRevision((revision) => revision + 1); // 一次多了好几条提交
      return payload;
    });
  }, [plan, busy, run, root, message, rememberCommitMessage]);

  /**
   * 修正上一次提交。提交框里写了信息就用它当新的提交信息，没写就沿用原来的。
   *
   * 只暂存了内容、没改信息时，走 `--no-edit`（而不是把空串当信息传下去）。
   * 提交完清空提交框、重拉历史（提交号变了）。
   */
  const confirmAmend = useCallback(() => {
    setPendingAmend(false);
    const next = message.trim() ? message : undefined;
    void run("amend", async () => {
      const payload = await gitAmend(root, next);
      rememberCommitMessage(message);
      setMessage("");
      setLogRevision((revision) => revision + 1);
      return payload;
    });
  }, [message, run, root, rememberCommitMessage]);

  /** 撤销上一次提交：改动回到暂存区，提交框里的信息也跟着填回去，方便改完重提 */
  const undoCommit = useCallback(() => {
    // 撤销前的 HEAD 主题得在 setLogRevision 触发重拉之前取到——重拉会把 commits 换掉。
    // 按 hash 匹配而不是取第一条：过滤生效时 HEAD 不一定排在列表最前。
    // 列表还没加载（null）或没匹配到就跳过回填，不影响撤销本身。
    const head = commits?.find((item) => item.hash === snapshot.head)?.subject;
    void run("undo", async () => {
      const payload = await gitUndoCommit(root);
      if (head) setMessage(head);
      historyIndexRef.current = null; // 回填的是撤销出来的主题，不是历史浏览，游标要复位
      setLogRevision((revision) => revision + 1);
      return payload;
    });
  }, [run, root, commits, snapshot.head]);

  /**
   * 拉分支列表**数据本身**，不碰菜单里的临时状态（新建输入框 / 被占用提示）：
   * 后台轮询也走它，否则每轮轮询都会把用户正在敲的分支名清掉。
   *
   * 失败当空列表，把原因摆在菜单里——不值得弹全局错误。
   */
  const loadBranches = useCallback(() => {
    void gitBranches(root)
      .then(setBranches)
      .catch((reason) => {
        setBranches([]);
        setBranchError(String(reason));
      });
  }, [root]);

  /**
   * 分支下拉打开期间跟着 status 轮询（2 秒）重拉列表。
   *
   * 依赖整个 `snapshot` 是故意的：每轮 status 轮询它都会换成新对象，菜单开着时就等于
   * 每 2 秒刷一次——终端里切换 / 新建分支、fetch 出远程分支之后，不用关掉菜单再开一次
   * 就能看到。只盯 head / branch 的话，那些不动 HEAD 的变化（新建分支、fetch）会漏掉。
   * 藏起来时（切走工作区 / 右栏收起 / 看别的模块）不起——菜单不可见，白拉列表没意义。
   */
  useEffect(() => {
    if (!branchMenu || !visible || !moduleVisible) return;
    loadBranches();
  }, [branchMenu, visible, moduleVisible, snapshot, loadBranches]);

  /**
   * 打开分支下拉：清掉上回的残留（报错），免得切走再回来还挂着上一次的提示。
   * 列表数据交给上面的 effect 拉——打开即拉，之后随轮询刷新。
   */
  const openBranchMenu = useCallback(() => {
    setBranchError(null);
    setBranchMenu(true);
  }, []);

  // ---- worktree ----

  /**
   * 标题栏「刷新」：把整个面板重载一遍。
   *
   * 状态用 `refresh()` 立刻重拉（否则要等 2 秒轮询）；历史 / 储藏各自 +1，触发
   * 它们下面的 effect 重拉；worktree 列表把它加进依赖里、动态状态靠 worktreeRevision
   * 重拉。用 ref 跳过首次挂载——各 effect 挂载时本就会自己拉一次，不必重复。
   */
  const lastReload = useRef(reloadSignal);
  useEffect(() => {
    if (lastReload.current === reloadSignal) return;
    lastReload.current = reloadSignal;
    refresh();
    setLogRevision((revision) => revision + 1);
    setStashRevision((revision) => revision + 1);
    setWorktreeRevision((revision) => revision + 1);
  }, [reloadSignal, refresh]);

  /**
   * 切回工作区根用的回调。`onSelectWorktree` 是上层的内联箭头、每次渲染都是新的，
   * 放进 effect 依赖会让它每帧重跑，所以用 ref 转一手。
   */
  const selectWorktreeRef = useRef(onSelectWorktree);
  useEffect(() => {
    selectWorktreeRef.current = onSelectWorktree;
  }, [onSelectWorktree]);

  /**
   * 拉这个仓库的 worktree 列表。
   *
   * **从工作区根拉，而不是面板自己的 `root`**：面板可能被切到某个不是 git 仓库的
   * 工作树（`.git` 被删 / 损坏），拿它当 root 时后端只会返回空列表，工作树入口随之
   * 消失、用户再也切不回来。工作区根始终是正常仓库，从这里拉才拿得到完整列表。
   *
   * 只在面板可见（当前工作区 + 模块露在眼前）时拉。失败当空列表
   * ——拿不到就把入口藏起来，不值得弹全局错误。后端顺带把存在的工作树登记进白名单，
   * 所以返回的 path 之后能直接当 root 用。
   * 面板可见期间跟着 status 轮询（2 秒）重拉：终端里 `git worktree add/remove`、
   * 在别的工作树里切分支之后，列表和各条检出的分支能自己跟上，不必手动刷新。
   * 依赖整个 `snapshot` 是故意的（理由同分支列表那个 effect：每轮轮询换新对象）。
   */
  useEffect(() => {
    if (!visible || !moduleVisible) return;
    let cancelled = false;
    void gitWorktreeList(workspaceRoot)
      .then((list) => {
        if (cancelled) return;
        setWorktrees(list);
        // 兜底：面板看的那个 worktree 已经不在了（外部 rm -rf / git worktree remove），
        // 自动切回工作区根——否则面板会一直卡在「不是 Git 仓库」的空状态。整条记录消失、
        // 或只剩目录已不存在的 prunable 记录，都算「不在了」。
        if (pathKey(root) !== pathKey(workspaceRoot)) {
          const found = list.find((item) => pathKey(item.path) === pathKey(root));
          if (!found || !found.exists) selectWorktreeRef.current(workspaceRoot);
        }
      })
      .catch(() => {
        if (!cancelled) setWorktrees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, root, visible, moduleVisible, reloadSignal, snapshot]);

  /**
   * 拉各工作树的轻量动态状态（脏 / 领先落后 / 进行中）。
   *
   * 只在概览真的露在眼前、且仓库确实有多个工作树时才拉：这个命令要**逐棵**跑一次
   * git status，成本随工作树数翻倍，比单根轮询重得多。节奏也慢（见 WT_POLL_MS），且
   * **不依赖整个 `snapshot`**——它每 2 秒换对象，跟着跑就等于把每个工作树都按 2 秒
   * 轮询一遍。这里只跟工作树数量、概览折叠、手动刷新和 prune 走。
   *
   * 失败当没有（`null`）：概览退化成只有结构信息（分支 / 失效），不弹全局错误。
   */
  const wtCount = worktrees?.length ?? 0;
  useEffect(() => {
    if (!visible || !moduleVisible || wtCollapsed || wtCount <= 1) return;
    let cancelled = false;
    const load = () => {
      void gitWorktreeStatus(workspaceRoot)
        .then((list) => {
          if (cancelled) return;
          setWtStatuses(new Map(list.map((item) => [pathKey(item.path), item])));
        })
        .catch(() => {
          if (!cancelled) setWtStatuses(null);
        });
    };
    load();
    const timer = window.setInterval(load, WT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible, moduleVisible, wtCollapsed, wtCount, workspaceRoot, reloadSignal, worktreeRevision]);

  /** 切到某个工作树。选当前这条等于恢复默认（也兜住列表里 current 被标错的情形） */
  const pickWorktree = useCallback(
    (target: WorktreeInfo) => {
      // 比较面板实际看的 root，而不是列表里那个 current：被外部删掉的 worktree 会因
      // 词法前缀被标成 current，拿它判断会直接 return、反而切不回去
      if (pathKey(target.path) === pathKey(root)) return;
      onSelectWorktree(target.path);
    },
    [onSelectWorktree, root],
  );

  /**
   * 清理失效的 worktree 记录（`git worktree prune`）。
   *
   * 目录被外部删掉又没 prune 时，那条记录会一直占着它检出的分支，主工作树和别的
   * worktree 都切不过去。prune 跑完把新列表落地，顺带重拉分支（占用信息跟着更新）
   * 和工作树动态状态（失效那棵从概览里消失）。
   */
  const pruneWorktrees = useCallback(() => {
    void run("prune", async () => {
      const list = await gitWorktreePrune(workspaceRoot);
      setWorktrees(list);
      loadBranches();
      setWorktreeRevision((revision) => revision + 1);
    });
  }, [run, workspaceRoot, loadBranches]);

  // ---- stash ----

  /**
   * 拉 stash 列表。
   *
   * 依赖里**不能放 `stashes` 自己**：每次 `.then(setStashes)` 都会给一个新数组，
   * 自引用会让 effect 无限重跑、把 git 子进程刷爆（实测会一直起进程）。要重拉就动
   * `stashRevision`。
   */
  useEffect(() => {
    if (!snapshot.isRepo) return;
    let cancelled = false;
    void gitStashList(root)
      .then((list) => {
        if (!cancelled) setStashes(list);
      })
      .catch(() => {
        // 拉不到就当没有：stash 区块本来就不是主路径，不值得让它变成错误态
        if (!cancelled) setStashes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [root, stashRevision, snapshot.isRepo]);

  /**
   * 把列表里那条 stash 换算成它**此刻**的下标。
   *
   * `stash@{n}` 的 n 是「当前列表里的位置」而不是稳定身份：终端里再 stash 一条、
   * 或者 drop 掉一条，留在面板上的旧下标就会指向别人（实测拿旧下标 pop 会 pop 出
   * 另一条改动）。所以执行前按 hash 重新定位一次；找不到就说明它已经不在了。
   */
  const resolveStash = useCallback(
    async (entry: GitStash): Promise<number> => {
      const list = await gitStashList(root);
      setStashes(list);
      const found = list.find((item) => item.hash === entry.hash);
      if (!found) {
        throw new Error("这条储藏已经不存在了（可能被别的操作删掉了）");
      }
      return found.index;
    },
    [root],
  );

  const stash = useCallback(() => {
    void run("stash", async () => {
      const text = stashMessage.trim();
      const payload = await gitStashPush(root, text || undefined);
      setStashMessage("");
      setStashRevision((revision) => revision + 1);
      return payload;
    });
  }, [run, root, stashMessage]);

  /** 恢复并删掉那条。先按 hash 换算出此刻的下标，免得拿旧下标 pop 到别人 */
  const stashBack = useCallback(
    (entry: GitStash) => {
      void run("stash", async () => {
        const index = await resolveStash(entry);
        const payload = await gitStashPop(root, index);
        setStashRevision((revision) => revision + 1);
        return payload;
      });
    },
    [run, root, resolveStash],
  );

  const applyStash = useCallback(
    (entry: GitStash) => {
      void run("stash", async () => {
        const index = await resolveStash(entry);
        const payload = await gitStashApply(root, index);
        setStashRevision((revision) => revision + 1);
        return payload;
      });
    },
    [run, root, resolveStash],
  );

  const confirmStashDrop = useCallback(() => {
    const entry = pendingStashDrop;
    if (!entry) return;
    setPendingStashDrop(null);
    void run("stash", async () => {
      const index = await resolveStash(entry);
      const payload = await gitStashDrop(root, index);
      setStashRevision((revision) => revision + 1);
      return payload;
    });
  }, [pendingStashDrop, run, root, resolveStash]);

  /**
   * 让 AI 依据当前所有未提交的改动给一份提交方案。
   *
   * 只围绕一个主题时它返回一条：填进框里由用户自己确认，不自动提交；暂存区空着、
   * 但工作区有改动时先把改动全部暂存（否则界面停在「未暂存」、用户点不了提交）。
   * 横跨多个主题时返回多条：摆出预览面板，等用户确认后逐条提交（见 commitPlan），
   * 这时**不动**暂存区——生成是只读的，重排留到确认那一刻。
   */
  const generate = useCallback(() => {
    // 配置齐不齐由 useEffectiveAiConfig 判（.env 覆盖也算数），文案和原来一致
    if (!aiReady) {
      setError("请先在「设置 → AI」里填写接口地址、模型和密钥");
      return;
    }
    const stageAllFirst = staged.length === 0 && unstaged.length > 0;
    void run("generate", async () => {
      const plans = await generateCommitPlan(root, aiConfig);
      if (plans.length <= 1) {
        // 单条：沿用老行为，必要时先全部暂存，让用户能立刻点提交
        const payload = stageAllFirst ? await gitStage(root) : undefined;
        setMessage(plans[0]?.message ?? "");
        return payload;
      }
      // 多条：只摆预览，暂存区一个字都不动
      setPlan(plans);
    });
  }, [aiConfig, aiReady, run, root, staged.length, unstaged.length]);

  /** 右键一个改动行：开菜单。菜单由这里统一画（它才知道该贴哪、点完怎么解读） */
  const openMenu = useCallback((change: GitChange, staged: boolean, event: ReactMouseEvent) => {
    event.preventDefault();
    setMenu({ change, staged, x: event.clientX, y: event.clientY });
  }, []);

  /** 右键一条提交：开「打标签 / 删标签」菜单（菜单本身画在下面的 fixed 层里） */
  const openCommitMenu = useCallback((commit: GitCommit, event: ReactMouseEvent) => {
    event.preventDefault();
    setCommitMenu({ commit, x: event.clientX, y: event.clientY });
  }, []);

  /**
   * 在某个提交上建标签。标签变了要重拉时间线——行内的标签 chip 是从
   * `git log` 的装饰里来的，不重拉就看不到新标签。
   */
  const createTag = useCallback(
    (commit: GitCommit, name: string, message?: string) => {
      setTagDialog(null);
      void run("tag", async () => {
        await gitCreateTag(root, name, message, commit.hash);
        setLogRevision((revision) => revision + 1);
      });
    },
    [run, root],
  );

  /** 删标签，同样要重拉历史让 chip 消失 */
  const confirmTagDelete = useCallback(() => {
    const pending = pendingTagDelete;
    setPendingTagDelete(null);
    if (!pending) return;
    void run("tag", async () => {
      await gitDeleteTag(root, pending.name);
      setLogRevision((revision) => revision + 1);
    });
  }, [pendingTagDelete, run, root]);

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

  /** 复制失败就借已有的错误条说一声——剪贴板不可用是环境问题，不值得单开一个提示位 */
  const copyPath = useCallback(async (text: string) => {
    setMenu(null);
    setError(null);
    if (!(await copyText(text))) setError("复制失败：系统剪贴板不可用");
  }, []);

  /**
   * 把这一行加进工作区根的 .gitignore。
   *
   * 只对未跟踪（`?`）的文件给这一项：已经跟踪的文件加规则不生效（git 的语义如此），
   * 列出来只会让人以为点了没反应。
   *
   * 加完要 refresh 一次而不是等轮询：状态里那条已经该消失了，让用户盯着它多待 2 秒
   * 会以为没生效。
   */
  const addToIgnore = useCallback(
    async (change: GitChange) => {
      setMenu(null);
      setError(null);
      try {
        await gitAddToIgnore(root, change.path);
        refresh();
      } catch (reason) {
        setError(String(reason));
      }
    },
    [refresh, root],
  );

  /** 只取回引用，不动工作区，所以时间线不用重拉 */
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

  /** 合并要么快进、要么产生一个合并提交，两条路都动了历史 */
  const merge = useCallback(() => {
    void run("merge", async () => {
      const payload = await gitMerge(root);
      setLogRevision((revision) => revision + 1);
      return payload;
    });
  }, [run, root]);

  /** 冲突解决完、暂存好之后再点：用 MERGE_MSG 生成合并提交 */
  const mergeContinue = useCallback(() => {
    void run("mergeContinue", async () => {
      const payload = await gitMergeContinue(root);
      setLogRevision((revision) => revision + 1); // 多了一条合并提交
      return payload;
    });
  }, [run, root]);

  const confirmMergeAbort = useCallback(() => {
    setPendingMergeAbort(false);
    // 中止丢掉一次合并尝试：本来就没产生提交，不用重拉历史
    void run("mergeAbort", () => gitMergeAbort(root));
  }, [run, root]);

  /** 冲突行：接受某一侧 / 保留两者，后端把结果写回工作区并标记为已解决 */
  const resolveConflict = useCallback(
    (path: string, choice: "ours" | "theirs" | "both") => {
      setMenu(null);
      void run("resolve", () => gitResolveConflict(root, path, choice));
    },
    [run, root],
  );

  /** 冲突行：不选边，直接把工作区当前内容标记为已解决（等价于 `git add`） */
  const markResolved = useCallback(
    (path: string) => {
      setMenu(null);
      void run("resolve", () => gitStage(root, [path]));
    },
    [run, root],
  );

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

  /**
   * 展开 / 收起某个文件的逐块操作。点同一个文件的另一组会切过去，不是收起。
   *
   * 展开时**不去自动拉取**：拉取放在下面的 effect 里，入口有「点展开」和「应用完
   * 重拉」两处，写在按钮里会让重拉漏掉。
   */
  const toggleHunks = useCallback((path: string, staged: boolean) => {
    setHunkOpen((current) =>
      current && current.path === path && current.staged === staged ? null : { path, staged },
    );
  }, []);

  /**
   * 拉展开文件的 hunk 列表。
   *
   * 依赖里没有 status：轮询本身不该带着它重拉（每 2 秒一次太浪费）。代价是
   * 在终端里改了文件之后这里的块会过期，apply 时报错、重拉一次就对上——比每次都拉划算。
   */
  useEffect(() => {
    if (!hunkOpen) {
      setHunkData(null);
      return;
    }
    let alive = true;
    setHunkLoading(true);
    gitFileHunks(root, hunkOpen.path, hunkOpen.staged)
      .then((data) => {
        if (alive) setHunkData(data);
      })
      .catch((reason) => {
        if (!alive) return;
        setHunkData(null);
        setError(String(reason));
      })
      .finally(() => {
        if (alive) setHunkLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [root, hunkOpen, hunkRevision]);

  /** 换了展开目标 / 应用过改动之后清空行选择：行号对不上了，留着会误伤 */
  useEffect(() => {
    setLineSelection(new Map());
    lineAnchor.current = null;
  }, [hunkOpen, hunkRevision]);

  /** 展开的文件不在它那一组里了（暂存完、放弃完、或者被提交掉了）就收起 */
  useEffect(() => {
    if (!hunkOpen) return;
    const list = hunkOpen.staged ? staged : unstaged;
    if (!list.some((item) => item.path === hunkOpen.path)) {
      setHunkOpen(null);
    }
  }, [hunkOpen, staged, unstaged]);

  /**
   * 点 diff 里的某一行：切换选中，或（按住 Shift）从锚点连选到这一行。
   *
   * 只认改动行（`+` / `-`）：上下文行选它没有意义，后端也不看。范围里夹着的
   * 上下文行会一并标上（看着连贯），对生成补丁没有影响。
   */
  const clickLine = useCallback(
    (hunkIndex: number, bodyIndex: number, changeLine: boolean, shift: boolean) => {
      if (!changeLine) return;
      setLineSelection((current) => {
        const next = new Map(current);
        const anchor = lineAnchor.current;
        if (shift && anchor && anchor.hunk === hunkIndex) {
          const from = Math.min(anchor.line, bodyIndex);
          const to = Math.max(anchor.line, bodyIndex);
          const range = new Set<number>();
          for (let index = from; index <= to; index += 1) range.add(index);
          next.set(hunkIndex, range);
          return next;
        }
        const set = new Set(current.get(hunkIndex) ?? []);
        if (set.has(bodyIndex)) set.delete(bodyIndex);
        else set.add(bodyIndex);
        if (set.size === 0) next.delete(hunkIndex);
        else next.set(hunkIndex, set);
        lineAnchor.current = { hunk: hunkIndex, line: bodyIndex };
        return next;
      });
    },
    [],
  );

  /**
   * 应用一块 / 几行：`lines` 为空时作用于整块（原来的行为），否则只对选中的行。
   * 两处都落在后端同一套 apply 上（行级只是先把补丁裁剪成只含选中行）。
   */
  const applyHunk = useCallback(
    (action: HunkAction, patch: string, lines: number[]): Promise<GitStatusPayload> =>
      lines.length === 0
        ? gitApplyPatch(root, patch, action)
        : gitApplyLines(root, patch, lines, action),
    [root],
  );

  /** 暂存选中的一块 / 几行：补丁进 index，工作区不动 */
  const stageHunk = useCallback(
    (patch: string, lines: number[]) => {
      void run("stage", async () => {
        const payload = await applyHunk({ mode: "stage" }, patch, lines);
        setHunkRevision((revision) => revision + 1);
        return payload;
      });
    },
    [applyHunk, run],
  );

  /** 取消暂存选中的一块 / 几行：`--cached --reverse`，工作区不动 */
  const unstageHunk = useCallback(
    (patch: string, lines: number[]) => {
      void run("unstage", async () => {
        const payload = await applyHunk({ mode: "unstage" }, patch, lines);
        setHunkRevision((revision) => revision + 1);
        return payload;
      });
    },
    [applyHunk, run],
  );

  const confirmHunkDiscard = useCallback(() => {
    const pending = pendingHunkDiscard;
    if (!pending) return;
    setPendingHunkDiscard(null);
    void run("discard", async () => {
      const payload = await applyHunk({ mode: "discard" }, pending.patch, pending.lines);
      setHunkRevision((revision) => revision + 1);
      return payload;
    });
  }, [applyHunk, pendingHunkDiscard, run]);

  /** 逐块 / 逐行操作那一组，暂存和未暂存两组共用一份（靠 onToggle 的目标区分） */
  const hunkSection = useMemo<HunkSection>(
    () => ({
      open: hunkOpen?.path ?? null,
      staged: hunkOpen?.staged ?? false,
      data: hunkData,
      loading: hunkLoading,
      selection: lineSelection,
      onToggle: toggleHunks,
      onLineClick: clickLine,
      onStage: stageHunk,
      onUnstage: unstageHunk,
      onDiscard: (patch, lines, what) => setPendingHunkDiscard({ patch, lines, what }),
    }),
    [hunkOpen, hunkData, hunkLoading, lineSelection, toggleHunks, clickLine, stageHunk, unstageHunk],
  );

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

  /** 暂存选中的那些行：paths 只给选中集合，绝不波及没勾的行 */
  const stageSelectedRows = useCallback(() => {
    const paths = unstagedSelected.map((change) => change.path);
    if (paths.length === 0) return;
    void run("stage", () => gitStage(root, paths));
  }, [run, root, unstagedSelected]);

  /** 取消暂存选中的那些行 */
  const unstageSelectedRows = useCallback(() => {
    const paths = stagedSelected.map((change) => change.path);
    if (paths.length === 0) return;
    void run("unstage", () => gitUnstage(root, paths));
  }, [run, root, stagedSelected]);

  /**
   * 放弃选中的行。只收拾能放弃的（新文件 / 重命名排除，见 canDiscard），
   * 免得多勾一个新文件就整批失败——和「放弃整组」一个口径；
   * 同样先过 discard() 的确认框再落手。
   */
  const discardSelectedRows = useCallback(
    (staged: boolean) => {
      const list = staged ? stagedSelected : unstagedSelected;
      const paths = list
        .filter((change) => canDiscard(change, staged))
        .map((change) => change.path);
      if (paths.length === 0) return;
      discard(paths, { mode: staged ? "staged" : "unstaged" }, `${paths.length} 个文件`);
    },
    [discard, stagedSelected, unstagedSelected],
  );

  const setLogCollapsedPersisted = (next: boolean) => {
    setLogCollapsed(next);
    try {
      window.sessionStorage.setItem(LOG_COLLAPSED_KEY + root, next ? "1" : "0");
    } catch {
      // 记不住就按展开算，不影响使用
    }
  };

  const setWtCollapsedPersisted = (next: boolean) => {
    setWtCollapsed(next);
    try {
      window.sessionStorage.setItem(WT_COLLAPSED_KEY + workspaceRoot, next ? "1" : "0");
    } catch {
      // 记不住就按展开算，不影响使用
    }
  };

  const setViewPersisted = (next: ChangeView) => {
    setView(next);
    // 列表↔树的行序完全不同，留着旧选中会指向对不上的行，直接清空
    setSelection(new Set());
    lastClickedRef.current = null;
    try {
      window.sessionStorage.setItem(VIEW_KEY + root, next);
    } catch {
      // 记不住就下次回到列表，不影响使用
    }
  };

  /** 收起 / 展开某个分组里的一个目录。不落盘：属于"这次看的时候顺手收起"的临时状态 */
  const toggleDir = useCallback((group: ChangeGroup, path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current[group]);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...current, [group]: next };
    });
  }, []);

  /** 拖动时间线的上边缘改高度。 */
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    stopLogDragRef.current?.();
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: logHeight };
    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || moveEvent.pointerId !== drag.pointerId) return;
      const height = panelRef.current?.clientHeight ?? 0;
      const next = ratioForHeight(
        drag.startHeight - (moveEvent.clientY - drag.startY),
        height,
      );
      latestLogRatioRef.current = next;
      setLogRatio(next);
    };
    const onUp = (upEvent?: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || (upEvent && upEvent.pointerId !== drag.pointerId)) return;
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopLogDragRef.current = null;
      setDraggingLog(false);
      document.body.classList.remove("codovo-dragging-row");
      try {
        window.sessionStorage.setItem(LOG_RATIO_KEY + root, String(latestLogRatioRef.current));
      } catch {
        // 记不住就下次还是默认高度
      }
    };
    stopLogDragRef.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    setDraggingLog(true);
    document.body.classList.add("codovo-dragging-row");
  };

  /**
   * 方向键调时间线高度：上下限和拖动那条路径完全一致（MIN/MAX 再受面板高度约束），
   * 只是把指针位移换成固定步长。这条在上，分隔条上移就是历史变高，所以 ArrowUp 加、ArrowDown 减。
   */
  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowUp" ? KEY_RESIZE_STEP : event.key === "ArrowDown" ? -KEY_RESIZE_STEP : 0;
    if (delta === 0) return;
    event.preventDefault();
    // 从当前像素高度加一个步长，再换回比例；上下限同样交给派生高度那处
    const next = ratioForHeight(logHeight + delta, panelRef.current?.clientHeight ?? 0);
    setLogRatio(next);
    try {
      // 和 pointerup 一样落盘：键盘调完也得记住（这里直接用算出来的 next，setState 是异步的）
      window.sessionStorage.setItem(LOG_RATIO_KEY + root, String(next));
    } catch {
      // 记不住就下次还是默认高度
    }
  };

  // 面板高度变了（窗口缩放、右栏宽度变化）就得重算时间线的像素高度，比例本身不动
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => setPanelHeight(panel.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

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
    document.body.classList.add("codovo-dragging-row");
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
    document.body.classList.remove("codovo-dragging-row");
  };

  /**
   * 方向键调提交框高度：这条在下，分隔条上移就是提交框变矮，所以 ArrowUp 减、ArrowDown 加。
   * 上下限与拖动那条路径一致；没拖过时高度是内容撑的、不在 state 里，得先现量一个起点。
   * 提交框高度不落盘（拖动路径也没存），键盘调节同样不存。
   */
  const onMessageHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowUp" ? -KEY_RESIZE_STEP : event.key === "ArrowDown" ? KEY_RESIZE_STEP : 0;
    if (delta === 0) return;
    const el = messageRef.current;
    if (!el) return;
    event.preventDefault();
    const base = messageHeight ?? el.getBoundingClientRect().height;
    const { oneRow } = messageMetrics(el);
    const room = (panelRef.current?.clientHeight ?? 0) - MESSAGE_RESERVED_BELOW;
    const limit = Math.max(oneRow, room);
    setMessageHeight(Math.min(limit, Math.max(oneRow, base + delta)));
  };

  /** 输入框里静一下之后才真去查，避免每敲一个字拉一次 git */
  useEffect(() => {
    const timer = window.setTimeout(() => setLogNeedle(logFilter.trim()), LOG_FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [logFilter]);

  /** 有没有在过滤。过滤时泳道图、翻页、自动加载都得让位（见下） */
  const filteringLog = logNeedle.length > 0;

  /**
   * 标题栏右侧的过滤入口要不要摆。门槛和原先的常驻过滤行一致：历史太短时没东西可筛，
   * 就不占这个位置；但框已经开着、或正筛着（可能只剩几条）时保持可见，免得一打字入口就没了。
   */
  const showLogFilter =
    (commits?.length ?? 0) >= FILTER_MIN_CHANGES || filteringLog || logFilterOpen;

  /**
   * 工具行右侧的路径筛选入口要不要摆。门槛和原先的常驻输入框一致：改动太少时没东西可筛，
   * 就不占位置；但框已经开着、或正筛着时保持可见，免得一打字入口就没了。
   */
  const showPathFilter =
    staged.length + unstaged.length >= FILTER_MIN_CHANGES || filter.length > 0 || filterOpen;

  // 拉时间线。收起时完全不请求——这个面板收起是常态，别白跑 git。
  // 还要盯住 HEAD：在终端里 commit / amend / reset 之后，改动列表靠 2 秒轮询
  // 能自己变好，历史不会，只有 HEAD 动了才说明提交列表该重拉。
  // 非当前工作区（visible=false）、或右栏收起 / 停在别的模块（moduleVisible=false）同理
  // 不请求：面板只是被 hidden 藏着，还活着。
  useEffect(() => {
    if (logCollapsed || !visible || !moduleVisible || !snapshot.isRepo) return;
    let cancelled = false;
    // 过滤时顶到上限并把条件交给后端：主题 / 作者走后端后置匹配，路径交给 git 的 pathspec
    const filter = filteringLog && !logFilterPath ? logNeedle : undefined;
    const path = filteringLog && logFilterPath ? logNeedle : undefined;
    void gitLog(root, filteringLog ? LOG_FILTER_LIMIT : logLimit, filter, path)
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
  }, [
    logCollapsed,
    visible,
    moduleVisible,
    logLimit,
    logRevision,
    snapshot.isRepo,
    snapshot.head,
    filteringLog,
    logFilterPath,
    logNeedle,
  ]);

  // 后台自动重拉：见 LOG_POLL_MS 的说明。收起时不起定时器，和上面那个 effect 一致
  useEffect(() => {
    if (logCollapsed || !visible || !moduleVisible || !snapshot.isRepo) return;
    const timer = window.setInterval(() => setLogRevision((revision) => revision + 1), LOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, [logCollapsed, visible, moduleVisible, snapshot.isRepo]);

  /**
   * 未推送清单单独拉一份，不和 gitLog 挤在同一个 effect 里：它只跟 ahead 有关，
   * 合进去会让每次 HEAD 变化都多带一个无关请求，反过来 ahead 归零（推送完）时
   * 又会白重拉一遍提交列表——那份内容这时其实没变。
   *
   * 失败就当空集合：没有上游时后端本来就回空列表，真出错（git 挂了）也只是少几个标记，
   * 不该让时间线跟着变成错误态。
   */
  useEffect(() => {
    if (logCollapsed || !visible || !moduleVisible || !snapshot.isRepo) return;
    let cancelled = false;
    void gitUnpushed(root)
      .then((list) => {
        if (!cancelled) setUnpushed(new Set(list));
      })
      .catch(() => {
        if (!cancelled) setUnpushed(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [logCollapsed, visible, moduleVisible, logRevision, snapshot.isRepo, snapshot.head, snapshot.ahead]);

  // 展开某条提交时才去拉它的文件列表，拉过就留着。
  // 展开是多选，所以一次可能有好几条要拉——已经拉到的不再请求，只补缺的那些
  useEffect(() => {
    const missing = [...openCommits].filter((hash) => !commitFiles.has(hash));
    if (missing.length === 0) return;
    let cancelled = false;
    for (const hash of missing) {
      void gitCommitFiles(root, hash)
        .then((list) => {
          if (!cancelled) setCommitFiles((current) => new Map(current).set(hash, list));
        })
        .catch(() => {
          // 拿不到就当空列表，展开的那行会显示"没有文件改动"
          if (!cancelled) setCommitFiles((current) => new Map(current).set(hash, []));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [openCommits, commitFiles, root]);

  /**
   * 悬停某条提交时才去拉它的改动规模。不走 effect：这是「鼠标划过」触发的，
   * 挂在状态上会多一层没必要的同步。失败就不缓存，下次悬停再试。
   */
  const ensureStat = useCallback(
    (hash: string) => {
      if (commitStats.has(hash) || statRequests.current.has(hash)) return;
      statRequests.current.add(hash);
      void gitCommitStat(root, hash)
        .then((stat) => setCommitStats((current) => new Map(current).set(hash, stat)))
        .catch(() => statRequests.current.delete(hash));
    },
    [commitStats, root],
  );

  const toggleCommit = useCallback((hash: string) => {
    setOpenCommits((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }, []);

  // ---- 比较任意两个提交 / 与分支比较 ----

  /** Ctrl/⌘ 或 Shift 点提交行：切换它是否入选「比较」集合（最多两个） */
  const toggleCompareSel = useCallback((hash: string) => {
    setCompareSel((current) => {
      if (current.includes(hash)) return current.filter((item) => item !== hash);
      const next = [...current, hash];
      // 只留最近选的两个：再点第三个时把最早选的那个挤掉
      return next.length > 2 ? next.slice(next.length - 2) : next;
    });
  }, []);

  /**
   * 进入比较视图：拉两个 ref 之间改动过的文件列表。
   *
   * from 与 to 字面相同（选了同一个 ref）时后端其实会返回空列表，这里先拦一道，
   * 省得白跑一次 git，也让提示更贴切。
   *
   * `branch` 只在「从分支下拉查看分支」时传：标出这是只读的查看态，顶部要给出口。
   */
  const startCompare = useCallback(
    (from: string, to: string, label: string, branch?: string) => {
      const seq = ++compareSeq.current;
      setCompare({ from, to, label, branch });
      setCompareFiles(null);
      setCompareError(null);
      setCompareSel([]);
      setCompareBranchMenu(null);
      if (from.trim() === to.trim()) {
        setCompareFiles([]);
        setCompareBusy(false);
        return;
      }
      setCompareBusy(true);
      void gitCompareFiles(root, from, to)
        .then((files) => {
          if (compareSeq.current !== seq) return;
          setCompareFiles(files);
          setCompareBusy(false);
        })
        .catch((reason) => {
          if (compareSeq.current !== seq) return;
          setCompareError(String(reason));
          setCompareBusy(false);
        });
    },
    [root],
  );

  /** 退出比较视图，顺带把在飞的那次结果作废、清掉时间线里的选中 */
  const exitCompare = useCallback(() => {
    compareSeq.current += 1;
    setCompare(null);
    setCompareFiles(null);
    setCompareError(null);
    setCompareBusy(false);
    setCompareSel([]);
  }, []);

  /**
   * 分支下拉里点一条：只切**面板在看哪条分支**，不检出、不动工作区。
   *
   * 选中非当前分支 → 面板内容换成「HEAD ↔ 该分支」的只读差异（复用上面这套比较视图）；
   * 点当前分支 → 退出查看，回到跟着 HEAD 走的改动列表。
   */
  const previewBranch = useCallback(
    (item: GitBranch) => {
      setBranchMenu(false);
      if (item.current) {
        exitCompare();
        return;
      }
      // 用字面 HEAD 而不是分支名：游离 HEAD 下也能比，且比出来的方向固定是「当前 ↔ 目标」
      startCompare("HEAD", item.name, `${snapshot.branch ?? "HEAD"} ↔ ${item.name}`, item.name);
    },
    [snapshot.branch, exitCompare, startCompare],
  );

  /**
   * 选中两个提交时，算出「从哪个到哪个」。时间线上更靠下（更旧）的那个当 from，
   * 这样比较出来是一个正向补丁；下标找不到（提交被过滤掉了）就退回点选顺序。
   */
  const comparePair = useMemo(() => {
    if (compareSel.length !== 2 || !commits) return null;
    const first = commits.findIndex((item) => item.hash === compareSel[0]);
    const second = commits.findIndex((item) => item.hash === compareSel[1]);
    const [from, to] =
      first >= 0 && second >= 0 && first < second
        ? [compareSel[1], compareSel[0]]
        : [compareSel[0], compareSel[1]];
    const shortOf = (hash: string) =>
      commits.find((item) => item.hash === hash)?.short ?? hash.slice(0, 7);
    return { from, to, label: `${shortOf(from)} ↔ ${shortOf(to)}` };
  }, [compareSel, commits]);

  /**
   * 泳道布局。列表一变就整段重排——每翻一页也是从头算，图不会跳变。
   * `rows[i]` 和 `commits[i]` 一一对应，取行直接用下标即可。
   *
   * **过滤时不画图**：泳道要靠完整的一串父子关系才接得上，过滤掉一部分之后
   * 剩下的行之间连线必然断开，画出来反而像坏了。这时把图列收起来，让位给文字。
   */
  const graph = useMemo(
    () => (filteringLog ? null : layoutGraph(commits ?? [])),
    [commits, filteringLog],
  );
  const graphWidth = graph ? graph.laneCount * LANE_W : 0;

  /**
   * 回到 HEAD：把当前提交那一行滚到视野里。
   *
   * 不用 scrollIntoView——它会连带滚动外层容器；改成算出这一行相对滚动容器的
   * 偏移、直接调 scrollTop。找不到 HEAD 行（过滤掉了）就退回顶部。
   */
  const jumpToHead = useCallback(() => {
    const container = logScrollRef.current;
    if (!container) return;
    const row = snapshot.head
      ? container.querySelector<HTMLElement>(`[data-commit="${snapshot.head}"]`)
      : null;
    if (!row) {
      container.scrollTo({ top: 0 });
      return;
    }
    const delta = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += delta;
  }, [snapshot.head]);

  /**
   * 时间线滚到底就自动加载下一页。过滤时不再往下翻——后端已经一次顶到上限。
   *
   * 只在真有滚动事件时触发：内容本来就不够高、滚不动时不会自己一直往下加载
   * （那样会把 500 条上限一口气拉满）。滚不动的情形留给「加载更多」按钮。
   */
  const onLogScroll = (event: ReactUIEvent<HTMLDivElement>) => {
    if (filteringLog) return;
    if (commits === null || commits.length < logLimit) return;
    const el = event.currentTarget;
    // 留 48px 余量：真正贴到底之前就开始拉，滚动手感上不会断
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 48) return;
    setLogLimit((limit) => limit + LOG_PAGE);
  };

  /** 回填内容；光标落到末尾的动作交给下一帧的 effect（受控组件同帧设选区会被抹掉） */
  const recallValue = (value: string) => {
    setMessage(value);
    recallCursorRef.current = true;
  };

  /**
   * 提交框里按 ↑ / ↓ 在本会话提交过的历史信息之间回填。返回 true 表示这次按键已被接管。
   *
   * 只在「没有选区」且光标处于首行（↑）/ 末行（↓）时才动作：多行编辑时光标夹在中间，
   * ↑ / ↓ 必须是正常的移动光标，不能被回填抢走（单行时天然满足首 / 末行）。
   */
  const recallMessage = (el: HTMLTextAreaElement, key: "ArrowUp" | "ArrowDown"): boolean => {
    if (el.selectionStart !== el.selectionEnd) return false;
    const history = messageHistoryRef.current;
    if (key === "ArrowUp") {
      if (history.length === 0) return false;
      // 光标上方还有换行 → 交回浏览器正常上移光标
      if (el.value.slice(0, el.selectionStart).includes("\n")) return false;
      const index = historyIndexRef.current;
      let next: number;
      if (index === null) {
        // 第一次按 ↑：先记下进入历史前的草稿，↓ 越过最新一条时回到它
        historyDraftRef.current = el.value;
        next = history.length - 1;
      } else {
        next = Math.max(index - 1, 0); // 已经在最老一条就停住
      }
      historyIndexRef.current = next;
      recallValue(history[next]);
      return true;
    }
    // ↓：只有正在浏览历史时才接管，否则保持默认（下移光标）
    if (historyIndexRef.current === null) return false;
    // 光标下方还有换行 → 交回浏览器正常下移光标
    if (el.value.slice(el.selectionEnd).includes("\n")) return false;
    const next = historyIndexRef.current + 1;
    if (next >= history.length) {
      historyIndexRef.current = null; // 越过最新一条 → 回到进入前的草稿
      recallValue(historyDraftRef.current);
    } else {
      historyIndexRef.current = next;
      recallValue(history[next]);
    }
    return true;
  };

  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 提交框里的 ↑ / ↓ 回填历史提交信息；带修饰键时一律让路（Ctrl/Shift 方向键另有含义）
    const arrow =
      event.key === "ArrowUp" || event.key === "ArrowDown" ? event.key : null;
    if (
      arrow &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      recallMessage(event.currentTarget, arrow)
    ) {
      event.preventDefault();
      return;
    }
    // Enter 留给换行（提交信息常常是多行），提交走可配置的快捷键（默认 Ctrl/Cmd+Enter）
    if (!matchesShortcut(event, settings.shortcuts["git.commit"])) return;
    event.preventDefault();
    commit();
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

  // ↑ / ↓ 回填后把光标移到文本末尾。受控组件里改 value 的同一帧就设选区会被 React 的
  // 受控更新抹掉，所以挂个标志位、等这次渲染落地后再设一次
  useEffect(() => {
    if (!recallCursorRef.current) return;
    recallCursorRef.current = false;
    const el = messageRef.current;
    if (!el) return;
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [message]);

  // 面板被拖宽/拖窄时折行位置会变，得重新量一次。监听面板而不是 textarea 自己：
  // 我们改的正是 textarea 的高度，监听它会自己触发自己
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(resizeMessage);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [resizeMessage]);

  /**
   * worktree 列表。列表从**工作区根**拉（见上面的 effect），这里把「当前」按面板实际看的
   * 目标 `root` 重算一遍——后端是按传进去的 root 标的，而我们要标的是这个面板选中的那条。
   *
   * 只有多个工作树、或面板切到了别的 worktree 时才给列表：前者是正常的切换入口，
   * 后者是「切回工作区根」的出口——被外部删掉的 worktree 会让列表只剩工作区根一条，
   * 那时若还按「长度 > 1」卡住，用户就再也切不回来了。
   *
   * 切到 worktree 后「当前」按整条路径等值判：原先的词法前缀会把**嵌在仓库里的**
   * worktree 误判成它父目录那条工作区根，工作区根被标成 current 后就禁掉了、出口反而
   * 没了。没切（看的就是工作区根）时沿用后端按 toplevel 算的那条，兼容「工作区根本身
   * 是仓库子目录」的情形。
   */
  const here = pathKey(root);
  const offWorkspaceRoot = here !== pathKey(workspaceRoot);
  const wtList =
    worktrees && (worktrees.length > 1 || offWorkspaceRoot)
      ? worktrees.map((item) => ({
          ...item,
          current: offWorkspaceRoot ? pathKey(item.path) === here : item.current,
        }))
      : null;
  /** 当前面板所在的那个工作树（上面重算过 current 的那条） */
  const currentWt = wtList?.find((item) => item.current) ?? null;
  /** 列表里有没有失效记录（目录已不存在），决定要不要给「清理失效记录」入口 */
  const hasPrunable = (worktrees ?? []).some((item) => item.prunable || !item.exists);

  // 目录还不是仓库：给一句说明 + 一键初始化，点进来看到的就是这里。
  // 放在所有 hooks 之后，条件返回不影响 hooks 顺序
  if (!snapshot.isRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <IconBranch className="h-6 w-6 text-fg-faint" />
        <p className="text-[12px] text-fg-dim">当前目录还不是 Git 仓库</p>
        {/* 面板切到了某个 worktree 时，「初始化」是在那个（多半已不存在的）目录里跑
            git init，纯属死路；改成给「切回工作区根」的出口 */}
        {offWorkspaceRoot ? (
          <button
            type="button"
            onClick={() => onSelectWorktree(workspaceRoot)}
            className="rounded-md bg-accent px-4 py-1.5 text-[12px] font-medium text-app hover:opacity-90"
          >
            切回 {folderName(workspaceRoot)}
          </button>
        ) : (
          <button
            type="button"
            onClick={initRepo}
            disabled={busy !== null}
            className="rounded-md bg-accent px-4 py-1.5 text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40"
          >
            {busy === "init" ? "正在初始化…" : "初始化 Git 仓库"}
          </button>
        )}
        {error && (
          <p className="text-[11px] break-words whitespace-pre-wrap text-danger">{error}</p>
        )}
        {/* 选中的工作树不是仓库时，这里就是唯一的出口：给一份工作树列表，让用户能切回
            主工作树（再在主工作树里切分支）。面板切到了别的 worktree 时即便只剩根一条
            也要显示——那正是切回去的出口 */}
        {wtList && (
          <div className="mt-1 flex w-full max-w-[260px] flex-col rounded border border-line-strong bg-raised py-1 text-left">
            <p className="px-3 py-1 text-[11px] text-fg-faint">切换到其他工作树</p>
            {wtList.map((item) => (
              <button
                key={item.path}
                type="button"
                onClick={() => pickWorktree(item)}
                disabled={item.current || !item.exists}
                title={toDisplayPath(item.path)}
                className="flex items-center gap-1.5 px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <span className="flex w-3 shrink-0 justify-center">
                  {item.current && <IconCheck className="h-3 w-3 text-ok" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 truncate text-[10px] text-fg-faint">
                  {item.prunable || !item.exists ? "已失效" : (item.branch ?? "游离 HEAD")}
                </span>
              </button>
            ))}
          </div>
        )}
        {/* 有失效记录就给清理入口：清掉后它占用的分支才能在主工作树切过去 */}
        {hasPrunable && (
          <button
            type="button"
            onClick={pruneWorktrees}
            disabled={busy !== null}
            className="text-[11px] text-fg-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-40"
          >
            {busy === "prune" ? "正在清理…" : "清理失效记录"}
          </button>
        )}
      </div>
    );
  }

  const canCommit = staged.length > 0 && message.trim().length > 0 && busy === null;
  // 有暂存就按暂存生成；只有未暂存的改动也能生成（点下去会先全部暂存）
  const canGenerate = (staged.length > 0 || unstaged.length > 0) && busy === null;
  // 改动全都提交完了、本地还领先上游：主按钮从「提交」切成「推送变更」。
  // 合并中不做这个切换——那会儿的主操作是「完成合并 / 中止合并」
  const showSync =
    staged.length === 0 && unstaged.length === 0 && snapshot.ahead > 0 && !snapshot.merging;
  // 两边各有自己的提交，快进的「拉取」推不动了，才轮到「合并」。
  // 只落后不领先时「拉取」能覆盖，不必再亮一个语义重叠的按钮；
  // behind 陈旧（还没 fetch 过）的那段窗口期靠 fetch 或拉取失败后的轮询自愈
  const canMerge =
    snapshot.ahead > 0 && snapshot.behind > 0 && !snapshot.merging && busy === null;
  const notice =
    busy === "fetch" ||
    busy === "pull" ||
    busy === "push" ||
    busy === "commitPush" ||
    busy === "commitSync" ||
    busy === "merge" ||
    busy === "mergeAbort" ||
    busy === "mergeContinue"
      ? SYNC_NOTICE[busy]
      : null;
  /** 三个提交类动作共用一个「提交中…」的按钮态 */
  const commitBusy = busy === "commit" || busy === "commitPush" || busy === "commitSync";
  /**
   * 「提交」灰着时的原因。按钮是 disabled，WebView 不会给 disabled 控件发鼠标事件，
   * 所以 title 那套悬停提示在这儿不可靠——直接写成一行字摆出来。
   * 只有「有暂存、但还没写消息」这一种要解释：别的禁用原因（没有暂存）旁边那条
   * 空列表提示已经说清了。
   */
  const commitHint =
    staged.length > 0 && busy === null && !message.trim() ? "填好提交信息就能提交" : null;

  /**
   * 提交框拖动条的无障碍数值（像素）。提交框没拖过时高度是内容撑的、不在 state 里，
   * 只能现量一次；面板还没挂载时量不到，就先不报（React 会把 undefined 的属性省掉）。
   */
  const messageHandle = messageRef.current
    ? (() => {
        const el = messageRef.current;
        const { oneRow } = messageMetrics(el);
        const room = (panelRef.current?.clientHeight ?? 0) - MESSAGE_RESERVED_BELOW;
        return {
          now: Math.round(messageHeight ?? el.getBoundingClientRect().height),
          min: Math.round(oneRow),
          max: Math.round(Math.max(oneRow, room)),
        };
      })()
    : null;

  /** 提交右键菜单里要删的标签（只挑标签类引用）；和菜单高度一起用来贴窗口边缘收一收 */
  const commitMenuTags = commitMenu
    ? commitMenu.commit.refs.filter((reference) => reference.kind === "tag")
    : [];
  // 菜单项：打标签 1 项 + 「与 HEAD / 与分支比较」2 项 + 若干删标签项。
  // 分隔线：比较组前一条，删标签组前一条（没有标签就省掉）
  const commitMenuH =
    MENU_ITEM_H * (3 + commitMenuTags.length) +
    MENU_DIVIDER_H * (1 + (commitMenuTags.length > 0 ? 1 : 0)) +
    MENU_PAD;

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-0.5 border-b border-line px-3 py-1">
        {/* 头部拆两行：第一行只留分支选择，第二行放领先/落后与远程/视图按钮——
            全挤一行按钮太密，分开后每行都有呼吸空间 */}
        {/* 分支名点开是分支列表：**只查看，不检出**。选中一条把面板内容换成「当前 HEAD
            ↔ 该分支」的只读差异，工作区不动。下拉写法照 SettingsDialog 的 ThemePicker：
            锚在按钮上，另铺一层透明遮罩接住外部点击 */}
        <div className="relative flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => (branchMenu ? setBranchMenu(false) : openBranchMenu())}
            disabled={busy !== null}
            title={`当前分支：${snapshot.branch ?? "游离 HEAD"}（点击查看其它分支）`}
            className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40"
          >
            <IconBranch className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{snapshot.branch ?? "游离 HEAD"}</span>
            <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
          </button>

          {/* 查看态：顶部常驻一条，说明现在看的是哪条分支、点 × 回到当前分支。
              放在分支按钮旁边（同一行），列表滚到哪都能看见 */}
          {compare?.branch && (
            <span
              className="flex min-w-0 items-center gap-1 rounded border border-accent-line bg-selected px-1 py-0.5 text-[11px] text-accent"
              title={`正在查看分支 ${compare.branch}，只读对比，不会检出`}
            >
              <IconArrowsLeftRight className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">正在查看 {compare.branch}</span>
              <button
                type="button"
                onClick={exitCompare}
                title="回到当前分支"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-active"
              >
                <IconClose className="h-3 w-3" />
              </button>
            </span>
          )}

          {branchMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setBranchMenu(false)} />
              <div
                className="absolute top-full left-0 z-40 mt-1 flex max-h-72 w-64 max-w-full flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg"
              >
                {branchError && (
                  <p className="px-3 py-1 text-[11px] whitespace-pre-wrap text-danger">
                    {branchError}
                  </p>
                )}
                {branches.length === 0 && !branchError && (
                  <p className="px-3 py-1 text-[11px] text-fg-faint">没有本地分支</p>
                )}
                {branches.map((item) => {
                  // 正在查看的那条：左侧用对比图标标出，再点一次就退出查看
                  const viewing = compare?.branch === item.name;
                  // 被别的 worktree 占用的分支照常能「查看」——只看差异、不检出，不受占用限制；
                  // 保留「已检出」角标只是告知它此刻在别处的工作树里
                  const occupied = item.worktree !== null && !item.current;
                  return (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => previewBranch(item)}
                      disabled={busy !== null}
                      title={
                        occupied && item.worktree
                          ? `已在工作树 ${toDisplayPath(item.worktree)} 中检出（这里只看差异，不会切过去）`
                          : item.gone
                            ? `上游 ${item.upstream} 已经不存在了`
                            : item.upstream
                              ? `上游 ${item.upstream}`
                              : "还没有上游分支"
                      }
                      className="flex items-center gap-1.5 px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-60 disabled:hover:bg-transparent"
                    >
                      <span className="flex w-3 shrink-0 justify-center">
                        {viewing ? (
                          <IconArrowsLeftRight className="h-3 w-3 text-accent" />
                        ) : (
                          item.current && <IconCheck className="h-3 w-3 text-ok" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      {occupied ? (
                        <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-warn">
                          <IconWorktree className="h-3 w-3" />
                          已检出
                        </span>
                      ) : item.gone ? (
                        <span className="shrink-0 text-[10px] text-danger">已删除</span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-fg-faint">
                          {item.ahead > 0 && <span>↑{item.ahead}</span>}
                          {item.behind > 0 && <span>↓{item.behind}</span>}
                        </span>
                      )}
                      <span className={MENU_CMD}>{viewing ? "关闭" : "view"}</span>
                    </button>
                  );
                })}

                {/* 菜单底部一句说明：这套下拉只做查看，不做检出，免得人误以为点了就切过去了 */}
                <p className="mt-1 border-t border-line px-3 pt-1 text-[10px] leading-relaxed text-fg-faint">
                  选中分支只查看差异，不会检出
                </p>
              </div>
            </>
          )}
        </div>

        {/* 第二行：左边领先/落后，右边远程/视图按钮。
            relative 放在这一整行上（而不是那组按钮上）：下拉菜单按整行宽度收，面板窄时也不会溢出被裁 */}
        <div className="relative flex items-center gap-1.5">
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

        {/* 远程/视图这几个图标按钮单独成组：组内压到 gap-0.5 更像一组操作；
            命中区仍是 24px，不为了紧凑牺牲点击。ml-auto 让它贴行尾对齐。
            合并期间远程操作语义未定（push 会推合并前的 HEAD），一律禁掉，
            只留下面主按钮区的「完成合并 / 中止合并」 */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            label="获取远程更新"
            onClick={fetch}
            disabled={busy !== null || snapshot.merging}
          >
            <IconCloudDownload
              className={`${ICON_SM}${busy === "fetch" ? " animate-pulse" : ""}`}
            />
          </IconButton>
          <IconButton
            label="拉取（只允许快进）"
            onClick={pull}
            disabled={busy !== null || snapshot.merging}
          >
            <IconArrowDownToLine className={`${ICON_SM}${busy === "pull" ? " animate-pulse" : ""}`} />
          </IconButton>
          <IconButton
            label="合并远程分支"
            title="合并远程分支（先获取再合并，分叉时产生合并提交）"
            onClick={merge}
            disabled={!canMerge}
          >
            <IconMerge className={`${ICON_SM}${busy === "merge" ? " animate-pulse" : ""}`} />
          </IconButton>
          <IconButton
            label="推送"
            onClick={push}
            disabled={busy !== null || snapshot.merging}
          >
            <IconArrowUpFromLine className={`${ICON_SM}${busy === "push" ? " animate-pulse" : ""}`} />
          </IconButton>

          {/* 改动列表的排法切换：图标画的是**当前**模式，点一下换成另一种 */}
          <IconButton
            label={view === "list" ? "切换为树形显示" : "切换为列表显示"}
            onClick={() => setViewPersisted(view === "list" ? "tree" : "list")}
          >
            {view === "list" ? (
              <IconList className={ICON_SM} />
            ) : (
              <IconTree className={ICON_SM} />
            )}
          </IconButton>

          {/* 路径筛选收成这个漏斗按钮：默认不占地方，点开才在改动列表上方出现输入框 */}
          {showPathFilter && (
            <IconButton
              label={filterOpen ? "关闭路径筛选" : "按路径筛选"}
              active={filterOpen}
              onClick={() => setFilterOpen((open) => !open)}
              // 按下别让输入框失焦：否则「失焦收起」和这次 toggle 会打架
              onMouseDown={(event) => event.preventDefault()}
            >
              <IconFilter className={ICON_SM} />
            </IconButton>
          )}

          {/* 不常用的写历史 / 储藏操作收进这个「更多」按钮：默认只占一个图标，
              点开才展开菜单。定位照分支下拉：absolute 锚在这组按钮上 + 透明遮罩接外部点击 */}
          <IconButton
            label="更多 Git 操作"
            active={moreMenu}
            onClick={() => setMoreMenu((open) => !open)}
            disabled={busy !== null}
          >
            <IconMore className={ICON_SM} />
          </IconButton>

          {moreMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMoreMenu(false)} />
              <div className="absolute top-full right-0 z-40 mt-1 flex max-h-80 w-64 max-w-full flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg">
                {/* 改写历史：修正 / 撤销上一次提交。都动 HEAD，只在有 HEAD 且不在合并时给 */}
                {snapshot.head && !snapshot.merging && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreMenu(false);
                        setPendingAmend(true);
                      }}
                      disabled={busy !== null}
                      title="修正上一次提交（把已暂存的改动并进去，提交框里有信息就顺便改掉）"
                      className={`${MENU_ITEM} disabled:opacity-60 disabled:hover:bg-transparent`}
                    >
                      <IconPencil className="h-3.5 w-3.5 shrink-0" />
                      修正上一次提交
                      <span className={MENU_CMD}>amend</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreMenu(false);
                        undoCommit();
                      }}
                      disabled={busy !== null}
                      title="撤销上一次提交（改动回到暂存区，再提交一次就是重提）"
                      className={`${MENU_ITEM} disabled:opacity-60 disabled:hover:bg-transparent`}
                    >
                      <IconUndo className="h-3.5 w-3.5 shrink-0" />
                      撤销上一次提交
                      <span className={MENU_CMD}>reset</span>
                    </button>
                  </>
                )}

                {/* 有改动但都收不走（只有未跟踪的新文件）：说一句，别让人以为漏了入口 */}
                {changes.length > 0 && stashable.length === 0 && (
                  <p className="px-3 py-1 text-[11px] text-fg-faint">
                    只有未跟踪的新文件，储藏收不走
                  </p>
                )}

                {/* 储藏：把手上这摊改动收起来去做别的事。有可收的改动时才给——
                    未跟踪的新文件收不走，按 stashable 判免得给出一个点了没反应的按钮 */}
                {stashable.length > 0 && (
                  <>
                    {snapshot.head && !snapshot.merging && <div className={MENU_DIVIDER} />}
                    <button
                      type="button"
                      onClick={() => {
                        setMoreMenu(false);
                        stash();
                      }}
                      disabled={busy !== null}
                      title={`把当前 ${stashable.length} 处改动收进 stash（未跟踪的新文件不在此列）`}
                      className={`${MENU_ITEM} disabled:opacity-60 disabled:hover:bg-transparent`}
                    >
                      <IconArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
                      储藏改动
                      <span className={MENU_CMD}>stash</span>
                    </button>
                    {/* 说明留空就让 git 自己生成 WIP on <branch>: ... */}
                    <div className="px-2 pb-1">
                      <input
                        value={stashMessage}
                        onChange={(event) => setStashMessage(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          setMoreMenu(false);
                          stash();
                        }}
                        disabled={busy !== null}
                        placeholder="说明（可留空）"
                        className={`${TEXT_INPUT} w-full`}
                      />
                    </div>
                  </>
                )}

                {/* 已存的储藏：每条带恢复 / 应用 / 丢弃 */}
                {stashes && stashes.length > 0 && (
                  <>
                    <div className={MENU_DIVIDER} />
                    <p className="px-3 py-1 text-[10px] text-fg-faint">储藏</p>
                    {stashes.map((entry) => (
                      <div
                        key={entry.index}
                        className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-hover"
                      >
                        <span className="min-w-0 flex-1 truncate text-fg-muted" title={entry.message}>
                          {entry.message}
                        </span>
                        <span className="shrink-0 text-[10px] text-fg-faint">
                          {formatTime(entry.time)}
                        </span>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setMoreMenu(false);
                              stashBack(entry);
                            }}
                            disabled={busy !== null}
                            title="恢复并删掉这条记录（stash pop）"
                            className={ROW_ACTION}
                          >
                            <IconArrowDownToLine className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMoreMenu(false);
                              applyStash(entry);
                            }}
                            disabled={busy !== null}
                            title="恢复，但保留记录（stash apply，可以再应用到别的分支）"
                            className={ROW_ACTION}
                          >
                            <IconCheck className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMoreMenu(false);
                              setPendingStashDrop(entry);
                            }}
                            disabled={busy !== null}
                            title="丢掉这条储藏（stash drop，不动工作区）"
                            className={ROW_DANGER}
                          >
                            <IconTrash className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* 什么都没得做：给一句空态，别弹出一个空壳 */}
                {!(snapshot.head && !snapshot.merging) &&
                  stashable.length === 0 &&
                  changes.length === 0 &&
                  !(stashes && stashes.length > 0) && (
                    <p className="px-3 py-1 text-[11px] text-fg-faint">没有更多操作</p>
                  )}
              </div>
            </>
          )}
        </div>
        </div>
      </header>

      {/* 工作树概览：变更面板顶部的常驻导航（工作树 = 工作空间）。只在多工作树仓库、
          或面板切到了别的工作树时出现，单工作树仓库完全不占位置 */}
      {wtList && (
        <WorktreeOverview
          worktrees={wtList}
          statuses={wtStatuses}
          currentName={currentWt?.name ?? null}
          busy={busy !== null}
          collapsed={wtCollapsed}
          onToggleCollapsed={() => setWtCollapsedPersisted(!wtCollapsed)}
          onPick={pickWorktree}
          onPrune={pruneWorktrees}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2 py-2">
        {/* 生成按钮放进输入框内部右侧，外面那排整条让给主操作（提交 / 同步）。
            有分条方案时这一块和下面的拖动条、主操作按钮一起藏起来，让位给方案预览 */}
        <div className={`relative shrink-0 ${plan ? "hidden" : ""}`}>
          <textarea
            ref={messageRef}
            rows={1}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              historyIndexRef.current = null; // 手动改过内容就退出历史浏览
              if (error) setError(null);
            }}
            onKeyDown={onMessageKeyDown}
            placeholder={`消息（${formatShortcut(settings.shortcuts["git.commit"])}）`}
            style={messageHeight === null ? undefined : { height: messageHeight }}
            className={`${TEXT_INPUT} block resize-none pr-8 leading-4`}
          />
          <button
            type="button"
            onClick={generate}
            disabled={!canGenerate}
            title="用 AI 生成提交信息（没暂存时会先全部暂存；改动跨主题时给出分条方案）"
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
          tabIndex={0}
          aria-valuenow={messageHandle?.now}
          aria-valuemin={messageHandle?.min}
          aria-valuemax={messageHandle?.max}
          onPointerDown={onMessageHandleDown}
          onPointerMove={onMessageHandleMove}
          onPointerUp={onMessageHandleUp}
          onPointerCancel={onMessageHandleUp}
          onKeyDown={onMessageHandleKeyDown}
          title="拖动调整提交框的高度"
          className={`-my-1.5 h-1.5 shrink-0 cursor-row-resize rounded-full transition-colors focus-visible:bg-accent-strong focus-visible:outline-none ${
            plan ? "hidden" : draggingMessage ? "bg-accent-strong" : "hover:bg-line-hover"
          }`}
        />

        <div className={`flex shrink-0 items-center gap-1.5 ${plan ? "hidden" : ""}`}>
          {snapshot.merging ? (
            // 四种进行中操作（合并 / 变基 / 拣选 / 还原）都能在面板里收尾：
            // 主操作是"继续"，冲突没清完时禁用（按钮上直接写着还剩几个，省得去列表里数），
            // 旁边是"中止"。文案按类型区分（完成合并 / 继续变基 / …）
            (() => {
              const { name, verb } = ongoingLabels(snapshot.mergeKind);
              return (
                <>
                  <button
                    type="button"
                    onClick={mergeContinue}
                    disabled={busy !== null || snapshot.conflicts > 0}
                    className={PRIMARY_BUTTON}
                  >
                    {busy === "mergeContinue"
                      ? "处理中…"
                      : snapshot.conflicts > 0
                        ? `还有 ${snapshot.conflicts} 个冲突`
                        : `${verb}${name}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingMergeAbort(true)}
                    disabled={busy !== null}
                    className={MERGE_ABORT_BUTTON}
                  >
                    {busy === "mergeAbort" ? "中止中…" : `中止${name}`}
                  </button>
                </>
              );
            })()
          ) : staged.length > 0 ? (
            // 分裂按钮：左边提交，右边箭头拉出其它提交方式（照 VS Code）
            <div className="relative flex min-w-0 flex-1 items-stretch">
              <button type="button" onClick={commit} disabled={!canCommit} className={SPLIT_MAIN}>
                {commitBusy ? "提交中…" : "提交"}
              </button>
              <button
                type="button"
                onClick={() => setCommitMenuOpen((open) => !open)}
                disabled={busy !== null}
                title="更多提交方式"
                className={SPLIT_CARET}
              >
                <IconChevronDown className="h-3.5 w-3.5" />
              </button>

              {commitMenuOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setCommitMenuOpen(false)} />
                  <div className="absolute top-full left-0 z-40 mt-1 flex w-64 max-w-full flex-col rounded border border-line-strong bg-raised py-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        setCommitMenuOpen(false);
                        commit();
                      }}
                      disabled={!canCommit}
                      className={`${MENU_ITEM} disabled:opacity-60 disabled:hover:bg-transparent`}
                    >
                      <IconCheck className="h-3.5 w-3.5 shrink-0" />
                      提交
                      <span className={MENU_CMD}>commit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCommitMenuOpen(false);
                        setPendingAmend(true);
                      }}
                      disabled={busy !== null || staged.length === 0}
                      className={`${MENU_ITEM} disabled:opacity-60 disabled:hover:bg-transparent`}
                    >
                      <IconPencil className="h-3.5 w-3.5 shrink-0" />
                      提交（修改）
                      <span className={MENU_CMD}>amend</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCommitMenuOpen(false);
                        commitAndPush();
                      }}
                      disabled={!canCommit}
                      className={`${MENU_ITEM} disabled:opacity-60 disabled:hover:bg-transparent`}
                    >
                      <IconArrowUpFromLine className="h-3.5 w-3.5 shrink-0" />
                      提交并推送
                      <span className={MENU_CMD}>commit + push</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCommitMenuOpen(false);
                        commitAndSync();
                      }}
                      disabled={!canCommit}
                      className={`${MENU_ITEM} disabled:opacity-60 disabled:hover:bg-transparent`}
                    >
                      <IconSync className="h-3.5 w-3.5 shrink-0" />
                      提交并同步
                      <span className={MENU_CMD}>commit + sync</span>
                    </button>
                  </div>
                </>
              )}
            </div>
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
            <button type="button" disabled className={PRIMARY_BUTTON} title="还没有暂存的更改">
              提交
            </button>
          )}
        </div>

        {/* 分条方案预览：AI 判定横跨多个主题时才出现。逐条列出「信息 + 归属文件」，
            确认后走 commitPlan 一次性提交；确认前暂存区一个字都不动 */}
        {plan && (
          <div className="flex max-h-[50%] min-h-0 shrink-0 flex-col overflow-hidden rounded-md border border-line bg-raised">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-2 py-1.5">
              <span className="text-[11px] font-medium text-fg">
                分条提交方案（{plan.length} 条）
              </span>
              <span className="text-[10px] text-fg-faint">按主题自动拆分</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              <ol className="flex flex-col gap-1.5">
                {plan.map((item, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-1.5 rounded border border-line bg-surface px-2 py-1.5"
                  >
                    <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-active text-[10px] text-fg-dim">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <pre className="font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-fg">
                        {item.message}
                      </pre>
                      <p className="mt-1 text-[10px] break-words text-fg-faint">
                        {item.files.join("  ")}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-line px-2 py-1.5">
              <button
                type="button"
                onClick={() => setPlan(null)}
                disabled={busy !== null}
                className={DIALOG_CANCEL}
              >
                取消
              </button>
              <button
                type="button"
                onClick={commitPlan}
                disabled={busy !== null}
                className={DIALOG_CONFIRM}
              >
                {busy === "commit" ? "提交中…" : `提交 ${plan.length} 条`}
              </button>
            </div>
          </div>
        )}

        {commitHint && (
          <p className="shrink-0 px-1 text-[11px] text-fg-faint">{commitHint}</p>
        )}

        {snapshot.merging && (
          <p className="shrink-0 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
            {ongoingText(snapshot.mergeKind, snapshot.conflicts)}
          </p>
        )}

        {notice && (
          <p className="shrink-0 px-1 text-[11px] text-fg-faint">{notice}</p>
        )}

        {error && (
          <p className="shrink-0 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] whitespace-pre-wrap text-danger">
            {error}
          </p>
        )}

        {/* 路径筛选行：由工具行右边的漏斗按钮唤出，改动太少时连入口都不给。
            输入框仍贴在列表正上方——它只作用在这块列表上，不会被误认成整个面板的搜索框 */}
        {filterOpen && (
          <div
            className="relative shrink-0"
            // 焦点还在这一行里（去点清空按钮）就不收；点到外面且没敲东西才收起
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              if (!filter.trim()) setFilterOpen(false);
            }}
          >
            <input
              type="text"
              autoFocus
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                // 别让 Esc 冒到窗口上（那里接着「退出全屏」），顺带清词并收起
                event.stopPropagation();
                setFilter("");
                setFilterOpen(false);
              }}
              placeholder="按路径筛选"
              className={`${TEXT_INPUT} pr-7`}
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter("")}
                title="清空筛选"
                className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
              >
                <IconClose className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {compare ? (
            /* 比较视图：把改动列表整块换成「两个 ref 之间的差异文件」。顶部一行标题 +
               退出按钮，下面按提交展开那套行渲染文件；点文件开 range 差异 */
            <>
              <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
                <IconArrowsLeftRight className="h-3 w-3 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  {compare.branch ? `只读对比 ${compare.label}` : `对比 ${compare.label}`}
                </span>
                <button type="button" onClick={exitCompare} className={GROUP_ACTION}>
                  {compare.branch ? "回到当前分支" : "退出对比"}
                </button>
              </div>
              {compareBusy && (
                <p className="px-1 py-1 text-[11px] text-fg-faint">加载中…</p>
              )}
              {compareError && (
                <p className="px-1 py-1 text-[11px] whitespace-pre-wrap text-danger">
                  {compareError}
                </p>
              )}
              {!compareBusy && !compareError && compareFiles?.length === 0 && (
                <p className="px-1 py-1 text-[11px] text-fg-faint">
                  {compare.from.trim() === compare.to.trim()
                    ? "同一个提交，无需比较"
                    : "两者之间没有差异"}
                </p>
              )}
              {!compareBusy && compareFiles && compareFiles.length > 0 && (
                <ul>
                  {compareFiles.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        onClick={() =>
                          onOpen(file.path, {
                            mode: "range",
                            from: compare.from,
                            to: compare.to,
                          })
                        }
                        title={file.relative}
                        className="flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[11px] hover:bg-hover"
                      >
                        <span className="min-w-0 truncate text-fg-muted">
                          {baseName(file.relative)}
                        </span>
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
            </>
          ) : (
            <>
          {staged.length === 0 && unstaged.length === 0 && conflicts.length === 0 && (
            <p className="px-1 py-1 text-[11px] text-fg-faint">没有未提交的更改</p>
          )}

          {filteredOut && (
            <p className="px-1 py-1 text-[11px] text-fg-faint">
              没有匹配「{filter.trim()}」的更改
            </p>
          )}

          {/* 「合并冲突」组排在最上面：它就是最该先处理的东西。筛空了整个不画 */}
          {conflictsShown.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-danger">
                  合并冲突 ({conflictsShown.length}
                  {conflictsShown.length === conflicts.length ? "" : `/${conflicts.length}`})
                </span>
              </div>
              {conflictsShown.map((change) => (
                <ConflictRow
                  key={pathKey(change.path)}
                  change={change}
                  busy={busy !== null}
                  onOpenFile={onOpenFile}
                  onMenu={openMenu}
                />
              ))}
            </>
          )}

          {/* 筛掉的分组整个不画：只留一个空标题行反而让人以为里面没东西 */}
          {stagedShown.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  暂存的更改 ({stagedShown.length}
                  {stagedShown.length === staged.length ? "" : `/${staged.length}`})
                </span>
                {/* 有选中项时，整组操作换成针对选中项的那几个（语义从"整组"收窄到"这一批"） */}
                {stagedSelected.length > 0 ? (
                  <>
                    <span className="shrink-0 text-[11px] text-accent">
                      已选 {stagedSelected.length}
                    </span>
                    {stagedSelected.some((change) => canDiscard(change, true)) && (
                      <button
                        type="button"
                        onClick={() => discardSelectedRows(true)}
                        disabled={busy !== null}
                        title={`放弃选中的 ${stagedSelected.length} 个文件`}
                        className={GROUP_ICON_DANGER}
                      >
                        <IconUndo className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={unstageSelectedRows}
                      disabled={busy !== null}
                      title={`取消暂存选中的 ${stagedSelected.length} 个文件`}
                      className={GROUP_ICON}
                    >
                      <IconMinus className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
              <ChangeList
                group="staged"
                changes={stagedShown}
                tree={stagedTree}
                view={view}
                staged
                busy={busy !== null}
                hunks={hunkSection}
                collapsedDirs={collapsedDirs}
                onToggleDir={toggleDir}
                onOpen={onOpen}
                onOpenFile={onOpenFile}
                onToggle={(path) => void run("unstage", () => gitUnstage(root, [path]))}
                onDiscard={(change) =>
                  discard([change.path], { mode: "staged" }, change.relative)
                }
                onMenu={openMenu}
                selected={isStagedSelected}
                onSelect={onSelectStaged}
              />
            </>
          )}

          {unstagedShown.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1.5 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  更改 ({unstagedShown.length}
                  {unstagedShown.length === unstaged.length ? "" : `/${unstaged.length}`})
                </span>
                {/* 同暂存组：有选中项就换成针对选中项的操作 */}
                {unstagedSelected.length > 0 ? (
                  <>
                    <span className="shrink-0 text-[11px] text-accent">
                      已选 {unstagedSelected.length}
                    </span>
                    {unstagedSelected.some((change) => canDiscard(change, false)) && (
                      <button
                        type="button"
                        onClick={() => discardSelectedRows(false)}
                        disabled={busy !== null}
                        title={`放弃选中的 ${unstagedSelected.length} 个文件`}
                        className={GROUP_ICON_DANGER}
                      >
                        <IconUndo className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={stageSelectedRows}
                      disabled={busy !== null}
                      title={`暂存选中的 ${unstagedSelected.length} 个文件`}
                      className={GROUP_ICON}
                    >
                      <IconPlus className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
              <ChangeList
                group="unstaged"
                changes={unstagedShown}
                tree={unstagedTree}
                view={view}
                staged={false}
                busy={busy !== null}
                hunks={hunkSection}
                collapsedDirs={collapsedDirs}
                onToggleDir={toggleDir}
                onOpen={onOpen}
                onOpenFile={onOpenFile}
                onToggle={(path) => void run("stage", () => gitStage(root, [path]))}
                onDiscard={(change) =>
                  discard([change.path], { mode: "unstaged" }, change.relative)
                }
                onMenu={openMenu}
                selected={isUnstagedSelected}
                onSelect={onSelectUnstaged}
              />
            </>
          )}
            </>
          )}
        </div>
      </div>

      {/* 选中两个提交后冒出来的小条：点「比较」进入两提交之间的差异视图。
          放在时间线上方——它服务的是下面那段时间线 */}
      {compareSel.length === 2 && comparePair && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-2 py-1">
          <IconArrowsLeftRight className="h-3 w-3 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg">已选 2 个提交</span>
          <button
            type="button"
            onClick={() => startCompare(comparePair.from, comparePair.to, comparePair.label)}
            className={GROUP_ACTION}
          >
            比较
          </button>
          <button type="button" onClick={() => setCompareSel([])} className={GROUP_ACTION}>
            清除
          </button>
        </div>
      )}

      {/* 拖动条把时间线的上边缘变成可拖的：往下拖历史变高。
          收起时不画——没有东西可调 */}
      {!logCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          tabIndex={0}
          aria-valuenow={logHeight}
          aria-valuemin={MIN_LOG_HEIGHT}
          aria-valuemax={MAX_LOG_HEIGHT}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKeyDown}
          title="拖动调整提交历史的高度"
          className={`relative h-px shrink-0 cursor-row-resize bg-line-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong ${
            draggingLog ? "bg-accent-strong" : "hover:bg-line-hover"
          }`}
        >
          {/* 加宽命中区，视觉上仍是一条细线 */}
          <span className="absolute inset-x-0 -top-1 -bottom-1" />
        </div>
      )}

      {/* 时间线。改完的东西在上一区，翻过的旧账在下面，别再挤同一块滚动区 */}
      <div
        className="flex min-h-0 shrink-0 flex-col"
        style={logCollapsed ? undefined : { height: logHeight }}
      >
        {/* 时间线标题栏：左边收起 / 展开，右边「回到 HEAD」与过滤入口。
            不能再整行做成一个 button——里面套 button 是非法的 */}
        <div className="flex h-7 w-full shrink-0 items-center gap-1 px-2 text-[11px] font-medium tracking-wide text-fg-dim">
          <button
            type="button"
            onClick={() => setLogCollapsedPersisted(!logCollapsed)}
            title={logCollapsed ? "展开提交历史" : "收起提交历史"}
            className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-fg"
          >
            {logCollapsed ? (
              <IconChevronRight className="h-3 w-3 shrink-0" />
            ) : (
              <IconChevronDown className="h-3 w-3 shrink-0" />
            )}
            <span>提交历史</span>
            {commits && commits.length > 0 && (
              <span className="text-fg-faint">{commits.length}</span>
            )}
          </button>
          {!logCollapsed && snapshot.head && (
            <IconButton label="回到当前提交（HEAD）" onClick={jumpToHead}>
              <IconTarget className={ICON_SM} />
            </IconButton>
          )}
          {!logCollapsed && showLogFilter && (
            <IconButton
              label={logFilterOpen ? "关闭过滤" : "过滤提交"}
              active={logFilterOpen}
              onClick={() => setLogFilterOpen((open) => !open)}
              // 按下别让输入框失焦：否则「失焦收起」和这次 toggle 会打架，
              // 空词时点一下收起又被 toggle 打开
              onMouseDown={(event) => event.preventDefault()}
            >
              <IconFilter className={ICON_SM} />
            </IconButton>
          )}
        </div>

        {/* 过滤行：由标题栏右边的漏斗按钮唤出，历史太短时连入口都不给。
            一个输入框 + 一个模式开关——主题 / 作者走后端后置匹配、路径交给 git 的
            pathspec，模式开关让用户明说是哪一种，省得靠「有没有斜杠」去猜 */}
        {!logCollapsed && logFilterOpen && (
          <div
            className="flex shrink-0 items-center gap-1 px-1 pb-1"
            // 焦点还在这一行里（去点「路径」开关、清空按钮）就不收；
            // 点到外面且没敲东西才收起（有词就留着，否则过滤还生效、输入框却不见了）
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              if (!logFilter.trim()) setLogFilterOpen(false);
            }}
          >
            <div className="relative min-w-0 flex-1">
              <input
                type="text"
                autoFocus
                value={logFilter}
                onChange={(event) => setLogFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  // 别让 Esc 冒到窗口上（那里接着「退出全屏」），顺带清词并收起
                  event.stopPropagation();
                  setLogFilter("");
                  setLogFilterOpen(false);
                }}
                placeholder={logFilterPath ? "按改动过的路径过滤" : "按主题 / 作者过滤"}
                className={`${TEXT_INPUT} pr-7`}
              />
              {logFilter && (
                <button
                  type="button"
                  onClick={() => setLogFilter("")}
                  title="清空过滤"
                  className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
                >
                  <IconClose className="h-3 w-3" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setLogFilterPath((value) => !value)}
              title={
                logFilterPath
                  ? "当前按路径过滤，点击改为按主题 / 作者"
                  : "当前按主题 / 作者过滤，点击改为按路径"
              }
              className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                logFilterPath ? "bg-accent-strong text-app" : "text-fg-faint hover:bg-hover hover:text-fg"
              }`}
            >
              路径
            </button>
          </div>
        )}

        {!logCollapsed && (
          <div
            ref={logScrollRef}
            className="min-h-0 flex-1 overflow-auto px-1 pb-2"
            onScroll={onLogScroll}
          >
            {logError && <p className="px-1 py-1 text-[11px] text-danger">{logError}</p>}
            {commits === null && !logError && (
              <p className="px-1 py-1 text-[11px] text-fg-faint">加载中…</p>
            )}
            {commits?.length === 0 && !logError && (
              <p className="px-1 py-1 text-[11px] text-fg-faint">
                {filteringLog ? `没有匹配「${logNeedle}」的提交` : "还没有提交"}
              </p>
            )}

            {commits?.map((commit, index) => (
              <CommitRow
                key={commit.hash}
                commit={commit}
                graph={graph ? graph.rows[index] : null}
                graphWidth={graphWidth}
                expanded={openCommits.has(commit.hash)}
                files={commitFiles.get(commit.hash)}
                stat={commitStats.get(commit.hash)}
                unpushed={unpushed.has(commit.hash)}
                anchor={hoverCommit?.hash === commit.hash ? hoverCommit.rect : null}
                selected={compareSel.includes(commit.hash)}
                onToggle={() => toggleCommit(commit.hash)}
                onSelect={() => toggleCompareSel(commit.hash)}
                onOpen={onOpen}
                onHover={(rect) => {
                  cancelHoverHide();
                  setHoverCommit({ hash: commit.hash, rect });
                }}
                onUnhover={hideHover}
                onStat={() => ensureStat(commit.hash)}
                onMenu={(event) => openCommitMenu(commit, event)}
              />
            ))}

            {/* 滚到底会自动加载；这个按钮留给「内容不够高、滚不动」的情形。
                过滤时后端已经一次顶到上限，不再分页 */}
            {commits && !filteringLog && commits.length >= logLimit && (
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

      {pendingHunkDiscard && (
        <ConfirmDialog
          message={`放弃 ${pendingHunkDiscard.what}？将还原到暂存区里的版本，无法撤销。`}
          confirmLabel="放弃"
          onConfirm={confirmHunkDiscard}
          onCancel={() => setPendingHunkDiscard(null)}
        />
      )}

      {pendingMergeAbort && (
        <ConfirmDialog
          message="中止合并？将丢弃这次合并尝试，工作区与暂存区回到合并前的状态，无法撤销。"
          confirmLabel="中止合并"
          onConfirm={confirmMergeAbort}
          onCancel={() => setPendingMergeAbort(false)}
        />
      )}

      {pendingAmend && (
        <ConfirmDialog
          message={`修正上一次提交？${
            message.trim() ? "提交信息会换成输入框里的内容，" : "提交信息保持不变，"
          }已暂存的改动会并进那条提交。提交号会变——如果它已经推送到远程，本地就和远程分叉了。`}
          confirmLabel="修正提交"
          onConfirm={confirmAmend}
          onCancel={() => setPendingAmend(false)}
        />
      )}

      {pendingStashDrop && (
        <ConfirmDialog
          message={`丢掉这条储藏记录？「${pendingStashDrop.message}」里的改动将无法恢复（工作区不受影响）。`}
          confirmLabel="丢掉"
          onConfirm={confirmStashDrop}
          onCancel={() => setPendingStashDrop(null)}
        />
      )}

      {pendingTagDelete && (
        <ConfirmDialog
          message={`删除标签「${pendingTagDelete.name}」？只删掉这个标签，提交本身不受影响。`}
          confirmLabel="删除标签"
          onConfirm={confirmTagDelete}
          onCancel={() => setPendingTagDelete(null)}
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
              // 冲突行的菜单多一组"解决冲突"，并带 git 命令提示，宽度和估算高度都要大一号
              width: isConflict(menu.change) ? CONFLICT_MENU_W : MENU_W,
              // 贴到窗口右边/下边时往回收，别把菜单顶出可视区
              left: Math.min(
                menu.x,
                window.innerWidth - (isConflict(menu.change) ? CONFLICT_MENU_W : MENU_W) - 4,
              ),
              top: Math.min(
                menu.y,
                window.innerHeight - (isConflict(menu.change) ? CONFLICT_MENU_H : MENU_H) - 4,
              ),
            }}
          >
            {/* 零、冲突：未合并的文件优先给解决入口，置顶于其它项 */}
            {isConflict(menu.change) && (
              <>
                <button
                  type="button"
                  onClick={() => resolveConflict(menu.change.path, "ours")}
                  className={MENU_ITEM}
                  disabled={busy !== null}
                >
                  <IconArrowLeftToLine className="h-3.5 w-3.5 shrink-0" />
                  接受当前更改
                  <span className={MENU_CMD}>checkout --ours</span>
                </button>
                <button
                  type="button"
                  onClick={() => resolveConflict(menu.change.path, "theirs")}
                  className={MENU_ITEM}
                  disabled={busy !== null}
                >
                  <IconArrowRightToLine className="h-3.5 w-3.5 shrink-0" />
                  接受传入更改
                  <span className={MENU_CMD}>checkout --theirs</span>
                </button>
                <button
                  type="button"
                  onClick={() => resolveConflict(menu.change.path, "both")}
                  className={MENU_ITEM}
                  disabled={busy !== null}
                >
                  <IconMerge className="h-3.5 w-3.5 shrink-0" />
                  保留两者
                  <span className={MENU_CMD}>both</span>
                </button>
                <button
                  type="button"
                  onClick={() => markResolved(menu.change.path)}
                  className={MENU_ITEM}
                  disabled={busy !== null}
                >
                  <IconCheck className="h-3.5 w-3.5 shrink-0" />
                  标记为已解决
                  <span className={MENU_CMD}>add</span>
                </button>
                <div className={MENU_DIVIDER} />
              </>
            )}
            {/* 一、AI：目录不是文件，解读会去读目录而报错，这一项不给（和文件树里的口径一致） */}
            {!menu.change.isDir && (
              <>
                <button
                  type="button"
                  onClick={() => startExplain(menu.change, menu.staged)}
                  className={MENU_ITEM}
                >
                  <IconSparkle className="h-3.5 w-3.5" />
                  AI 变更解读
                </button>
                <div className={MENU_DIVIDER} />
              </>
            )}
            {/* 二、路径 */}
            <button
              type="button"
              onClick={() => void copyPath(menu.change.path)}
              className={MENU_ITEM}
            >
              <IconFile className="h-3.5 w-3.5" />
              复制路径
            </button>
            <button
              type="button"
              onClick={() => void copyPath(menu.change.relative)}
              className={MENU_ITEM}
            >
              <IconTree className="h-3.5 w-3.5" />
              复制相对路径
            </button>
            {/* 三、git：已经跟踪的文件加 .gitignore 不生效（规则只管未跟踪的），不给这一项。
                整组连分隔线一起藏在条件里，否则它不出现时会多出一条孤线 */}
            {markOfColumn(menu.staged ? menu.change.index : menu.change.worktree).kind ===
              "untracked" && (
              <>
                <div className={MENU_DIVIDER} />
                <button
                  type="button"
                  onClick={() => void addToIgnore(menu.change)}
                  className={MENU_ITEM}
                >
                  <IconEyeOff className="h-3.5 w-3.5" />
                  加入 .gitignore
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* 提交行的右键菜单：打标签 / 删这条提交上已有的标签。和改动行那份同一套画法
          （透明遮罩接住外部点击 + fixed 定位），只是项不同 */}
      {commitMenu && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setCommitMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setCommitMenu(null);
            }}
          />
          <div
            className="fixed z-40 flex max-h-[60vh] flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: COMMIT_MENU_W,
              // 贴到窗口右边/下边时往回收，别把菜单顶出可视区。标签很多时估算高度会
              // 超过 60vh，再用 max 兜一下上边，别算出负数把菜单顶到屏幕外
              left: Math.min(commitMenu.x, window.innerWidth - COMMIT_MENU_W - 4),
              top: Math.max(4, Math.min(commitMenu.y, window.innerHeight - commitMenuH - 4)),
            }}
          >
            <button
              type="button"
              onClick={() => {
                setTagDialog(commitMenu.commit);
                setCommitMenu(null);
              }}
              className={MENU_ITEM}
            >
              <IconTarget className="h-3.5 w-3.5 shrink-0" />
              在此提交打标签…
              <span className={MENU_CMD}>tag</span>
            </button>
            {/* 比较组：与 HEAD 直接进比较视图；与分支比较先弹一个分支列表 */}
            <div className={MENU_DIVIDER} />
            <button
              type="button"
              onClick={() => {
                const commit = commitMenu.commit;
                setCommitMenu(null);
                startCompare(commit.hash, "HEAD", `${commit.short} ↔ HEAD`);
              }}
              className={MENU_ITEM}
            >
              <IconArrowsLeftRight className="h-3.5 w-3.5 shrink-0" />
              与 HEAD 比较
              <span className={MENU_CMD}>diff</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const { commit, x, y } = commitMenu;
                setCommitMenu(null);
                loadBranches();
                setCompareBranchMenu({ commit, x, y });
              }}
              className={MENU_ITEM}
            >
              <IconBranch className="h-3.5 w-3.5 shrink-0" />
              与分支比较…
            </button>
            {/* 这个提交上已经带的标签，逐条给一个删除入口。整组连分隔线一起藏在条件里，
                否则没有标签时会多出一条孤线 */}
            {commitMenuTags.length > 0 && (
              <>
                <div className={MENU_DIVIDER} />
                {commitMenuTags.map((reference) => (
                  <button
                    key={reference.name}
                    type="button"
                    onClick={() => {
                      setPendingTagDelete({ commit: commitMenu.commit, name: reference.name });
                      setCommitMenu(null);
                    }}
                    className={MENU_ITEM}
                  >
                    <IconTrash className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">删除标签 {reference.name}</span>
                    <span className={MENU_CMD}>tag -d</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {/* 「与分支比较…」的分支列表：复用分支下拉那份 branches / loadBranches，
          点一条就把「该提交 ↔ 这条分支」送进比较视图 */}
      {compareBranchMenu && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setCompareBranchMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setCompareBranchMenu(null);
            }}
          />
          <div
            className="fixed z-40 flex max-h-72 flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: COMMIT_MENU_W,
              left: Math.min(compareBranchMenu.x, window.innerWidth - COMMIT_MENU_W - 4),
              top: Math.max(4, Math.min(compareBranchMenu.y, window.innerHeight - 300)),
            }}
          >
            <p className="px-3 py-1 text-[10px] text-fg-faint">与分支比较</p>
            {branchError && (
              <p className="px-3 py-1 text-[11px] whitespace-pre-wrap text-danger">
                {branchError}
              </p>
            )}
            {branches.length === 0 && !branchError && (
              <p className="px-3 py-1 text-[11px] text-fg-faint">没有本地分支</p>
            )}
            {branches.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() =>
                  startCompare(
                    compareBranchMenu.commit.hash,
                    item.name,
                    `${compareBranchMenu.commit.short} ↔ ${item.name}`,
                  )
                }
                className={MENU_ITEM}
              >
                <IconBranch className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">{item.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {tagDialog && (
        <TagDialog
          commit={tagDialog}
          onConfirm={(name, message) => createTag(tagDialog, name, message)}
          onCancel={() => setTagDialog(null)}
        />
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
