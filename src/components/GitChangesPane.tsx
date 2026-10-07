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
  gitCommitStat,
  gitCreateBranch,
  gitDiscard,
  gitFetch,
  gitFileHunks,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  gitPull,
  gitPush,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitSwitchBranch,
  gitUndoCommit,
  gitUnstage,
  gitUnpushed,
  pathKey,
  toDisplayPath,
} from "../lib/fs";
import {
  isStaged,
  isStashable,
  isUnstaged,
  markOfColumn,
  type GitChange,
  type GitController,
  type GitMark,
  type GitMarkKind,
} from "../lib/git";
import { explainChange, generateCommitMessage, useEffectiveAiConfig } from "../lib/ai";
import { useSettings } from "../lib/settings";
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
} from "../lib/types";
import { graphTextInset, LANE_W, layoutGraph, type GraphRow } from "../lib/gitGraph";
import { GitMarkBadge, GitMarkDot } from "./GitMarkBadge";
import { CommitGraph } from "./GitGraph";
import { CommitTooltip } from "./CommitTooltip";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExplainChangeDialog } from "./ExplainChangeDialog";
import {
  FileTypeIcon,
  IconArrowDownToLine,
  IconArrowUpFromLine,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCloudDownload,
  IconFolder,
  IconList,
  IconMerge,
  IconMinus,
  IconPencil,
  IconPlus,
  IconSparkle,
  IconSync,
  IconTarget,
  IconTrash,
  IconTree,
  IconUndo,
} from "./icons";

interface GitChangesPaneProps {
  /** 这个面板属于哪个工作区：所有 git / ai 命令都带着它，后端按它定位工作区 */
  root: string;
  /**
   * 这个工作区是不是当前显示的。非当前工作区只是 `hidden` 藏着、不卸载，
   * 所以面板还活着——轮询这类后台动作要靠它停掉，否则每个隐藏的工作区都在白跑 git。
   */
  visible: boolean;
  git: GitController;
  /** 点改动项 / 提交里的文件：打开差异视图，source 决定跟谁比 */
  onOpen: (path: string, source: DiffSource) => void;
  /** 点行内的「打开文件」：开文件内容（不是差异），用来跳回去看上下文 */
  onOpenFile: (path: string) => void;
  /**
   * 切分支**之前**调。编辑器里可能有没保存的改动，它只活在内存里、git 看不见：
   * 落盘之后 git 才能正确判断能不能安全切换，也免得切完用户一保存就把旧分支的
   * 内容写进新分支。返回 false = 有文件没存成功，这次切换要中止。
   */
  onBeforeBranchSwitch: () => Promise<boolean>;
  /**
   * 切分支成功之后调一次。工作区整个被换掉，上层那些按旧内容缓存下来的东西
   * （打开的文件、差异视图的基线）都得作废——见 WorkspacePane 的实现。
   */
  onBranchChanged: () => void;
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

/**
 * 过滤提交历史时一次拉多少条。过滤会把结果筛掉一部分，还按普通一页取的话，
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
 * 提交历史的后台重拉间隔。
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

/** 合并中的「中止合并」：这一下会丢掉整次合并尝试，用危险色描边 */
const MERGE_ABORT_BUTTON =
  "shrink-0 rounded-md border border-danger-line px-3 py-1.5 text-[12px] text-danger hover:bg-danger-bg disabled:opacity-40";

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
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "amend"
  | "undo"
  | "branch"
  | "stash"
  | "generate"
  | "fetch"
  | "pull"
  | "push"
  | "merge"
  | "mergeAbort"
  | "mergeContinue";

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

/** 标题栏那几个图标按钮的样式，和刷新按钮同一套 */
const HEADER_ACTION =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

/** 网络操作可能要跑几分钟，光靠按钮变灰看不出在干什么，下面补一行字 */
const SYNC_NOTICE = {
  fetch: "正在获取远程更新…",
  pull: "正在拉取…",
  push: "正在推送…",
  merge: "正在合并…",
  mergeAbort: "正在中止合并…",
  mergeContinue: "正在完成合并…",
} as const;

/** 右键菜单：宽度按最长的一项量，高度按项数算出来，用来贴着窗口边缘收一收 */
const MENU_W = 148;
/** 一项 24px 上下内边距 + 文字，再加上容器自己的 py-1 */
const MENU_ITEM_H = 24;
const MENU_PAD = 8;
const MENU_MAX_ITEMS = 4;
const MENU_H = MENU_ITEM_H * MENU_MAX_ITEMS + MENU_PAD;
const MENU_ITEM = "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

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

  return (
    <>
    <div
      className="group flex items-center gap-1.5 rounded px-1 py-[3px] text-[12px] hover:bg-hover"
      style={depth === null ? undefined : { paddingLeft: depth * INDENT + 4 }}
      onContextMenu={(event) => onMenu(change, staged, event)}
    >
      <button
        type="button"
        // 目录项点开差异会去读目录、必报错，所以不响应点击（它只是折叠出来的一行占位）
        onClick={() => {
          if (isDir) return;
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
            <IconFolder className="h-3.5 w-3.5" />
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
      {/* 单链已经合并过，这里可能是 `a\b\c` 这样一整段路径；用反斜杠贴合 Windows 观感 */}
      <span className="min-w-0 flex-1 truncate">{node.name.split("/").join("\\")}</span>
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
  onToggle,
  onOpen,
  onHover,
  onUnhover,
  onStat,
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
  onToggle: () => void;
  onOpen: (path: string, source: DiffSource) => void;
  /** 鼠标进到这一行：报上本行矩形，让列表把浮框换过来 */
  onHover: (rect: DOMRect) => void;
  /** 鼠标离开这一行。可能只是穿 GAP 去浮框，收不收由列表按延迟定 */
  onUnhover: () => void;
  /** 鼠标进到这一行时喊一声，上层按需去拉改动规模 */
  onStat: () => void;
}) {
  return (
    <div
      className="flex"
      // 定位「回到 HEAD」用：按 hash 在滚动容器里找到这一行
      data-commit={commit.hash}
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
          onClick={onToggle}
          className="@container flex h-[22px] w-full items-center gap-1.5 rounded px-1 text-left text-[11px] hover:bg-hover"
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
          <span className="shrink-0 max-w-[40%] truncate text-[10px] text-fg-faint">
            {commit.author}
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
          relative={formatTime(commit.time)}
          stat={stat ?? null}
          anchor={anchor}
        />
      )}
    </div>
  );
}

/**
 * 改动列表 + 提交框 + 提交历史，右栏「变更」模块的整屏内容。
 * 目录不是仓库（或系统里没有 git）时整个不渲染——工具列表那边已经把这行置灰了，
 * 这里的早退只是兜底。
 */
export function GitChangesPane({
  root,
  visible,
  git,
  onOpen,
  onOpenFile,
  onBeforeBranchSwitch,
  onBranchChanged,
}: GitChangesPaneProps) {
  const { settings } = useSettings();
  const [message, setMessage] = useState("");
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
  /** 提交历史的过滤词（输入框原文）。临时状态，不落盘 */
  const [logFilter, setLogFilter] = useState("");
  /** 过滤按什么匹配：false = 主题 / 作者 / 正文，true = 改动过的路径 */
  const [logFilterPath, setLogFilterPath] = useState(false);
  /** 过滤词的防抖值：真正拿去查历史的是它，不是每敲一下都变 */
  const [logNeedle, setLogNeedle] = useState("");
  /** 历史滚动容器，「回到 HEAD」要让它滚过去 */
  const logScrollRef = useRef<HTMLDivElement>(null);

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
   * 改动列表的路径筛选。不落盘：属于「这次看的时候顺手找一下」的临时状态，
   * 下次进应用还得重新收一遍反而碍事（同 collapsedDirs）。
   */
  const [filter, setFilter] = useState("");

  // 分支下拉：null = 没开着。列表每次打开都重拉，切完分支/新建完都会自动重拉
  const [branchMenu, setBranchMenu] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  /** 新建分支的输入框：null = 没在输入 */
  const [newBranch, setNewBranch] = useState<string | null>(null);

  // stash：null = 还没拉到
  const [stashes, setStashes] = useState<GitStash[] | null>(null);
  const [stashCollapsed, setStashCollapsed] = useState(false);
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
  /** 筛完之后两边都没东西了（但改动本身还在），值得单独说一句 */
  const filteredOut =
    needle.length > 0 &&
    (staged.length > 0 || unstaged.length > 0) &&
    stagedShown.length === 0 &&
    unstagedShown.length === 0;
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
      } catch (reason) {
        setError(String(reason));
      } finally {
        busyRef.current = false;
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
      setMessage("");
      setLogRevision((revision) => revision + 1);
      return payload;
    });
  }, [message, run, root]);

  /** 撤销上一次提交：改动回到暂存区，提交框里的信息也跟着填回去，方便改完重提 */
  const undoCommit = useCallback(() => {
    void run("undo", async () => {
      const payload = await gitUndoCommit(root);
      setLogRevision((revision) => revision + 1);
      return payload;
    });
  }, [run, root]);

  /**
   * 打开分支下拉时现拉一次列表。
   *
   * 不用轮询：分支列表只在面板上摆一会儿，切分支/新建分支之后这个函数会被再调一次。
   * 失败就当空列表，把原因摆在菜单里——不值得弹全局错误。
   */
  const loadBranches = useCallback(() => {
    setBranchError(null);
    setNewBranch(null);
    void gitBranches(root)
      .then(setBranches)
      .catch((reason) => {
        setBranches([]);
        setBranchError(String(reason));
      });
  }, [root]);

  const openBranchMenu = useCallback(() => {
    loadBranches();
    setBranchMenu(true);
  }, [loadBranches]);

  /**
   * 切分支。切之前先把编辑器里没保存的改动落盘（理由见 onBeforeBranchSwitch），
   * 切完工作区整个换掉，得让上层清掉那些「按旧内容缓存下来」的东西（见 onBranchChanged）。
   */
  const switchTo = useCallback(
    (name: string) => {
      setBranchMenu(false);
      void run("branch", async () => {
        if (!(await onBeforeBranchSwitch())) {
          throw new Error("有文件没保存成功，已取消切换分支");
        }
        const payload = await gitSwitchBranch(root, name);
        setLogRevision((revision) => revision + 1); // 历史整个换了
        onBranchChanged();
        return payload;
      });
    },
    [run, root, onBranchChanged, onBeforeBranchSwitch],
  );

  const createBranchAndSwitch = useCallback(() => {
    const name = (newBranch ?? "").trim();
    if (!name) return;
    setBranchMenu(false);
    void run("branch", async () => {
      if (!(await onBeforeBranchSwitch())) {
        throw new Error("有文件没保存成功，已取消新建分支");
      }
      const payload = await gitCreateBranch(root, name);
      setLogRevision((revision) => revision + 1);
      onBranchChanged();
      return payload;
    });
  }, [newBranch, run, root, onBranchChanged, onBeforeBranchSwitch]);

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

  /** 收起 / 展开某个分组里的一个目录。不落盘：属于"这次看的时候顺手收起"的临时状态 */
  const toggleDir = useCallback((group: ChangeGroup, path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current[group]);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...current, [group]: next };
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

  /** 输入框里静一下之后才真去查，避免每敲一个字拉一次 git */
  useEffect(() => {
    const timer = window.setTimeout(() => setLogNeedle(logFilter.trim()), LOG_FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [logFilter]);

  /** 有没有在过滤。过滤时泳道图、翻页、自动加载都得让位（见下） */
  const filteringLog = logNeedle.length > 0;

  // 拉提交历史。收起时完全不请求——这个面板收起是常态，别白跑 git。
  // 还要盯住 HEAD：在终端里 commit / amend / reset 之后，改动列表靠 2 秒轮询
  // 能自己变好，历史不会，只有 HEAD 动了才说明提交列表该重拉。
  // 非当前工作区（visible=false）同理不请求：面板只是被 hidden 藏着，还活着。
  useEffect(() => {
    if (logCollapsed || !visible || !snapshot.isRepo) return;
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
    if (logCollapsed || !visible || !snapshot.isRepo) return;
    const timer = window.setInterval(() => setLogRevision((revision) => revision + 1), LOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, [logCollapsed, visible, snapshot.isRepo]);

  /**
   * 未推送清单单独拉一份，不和 gitLog 挤在同一个 effect 里：它只跟 ahead 有关，
   * 合进去会让每次 HEAD 变化都多带一个无关请求，反过来 ahead 归零（推送完）时
   * 又会白重拉一遍提交列表——那份内容这时其实没变。
   *
   * 失败就当空集合：没有上游时后端本来就回空列表，真出错（git 挂了）也只是少几个标记，
   * 不该让提交历史跟着变成错误态。
   */
  useEffect(() => {
    if (logCollapsed || !visible || !snapshot.isRepo) return;
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
  }, [logCollapsed, visible, logRevision, snapshot.isRepo, snapshot.head, snapshot.ahead]);

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
   * 提交历史滚到底就自动加载下一页。过滤时不再往下翻——后端已经一次顶到上限。
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

  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
    busy === "merge" ||
    busy === "mergeAbort" ||
    busy === "mergeContinue"
      ? SYNC_NOTICE[busy]
      : null;
  /**
   * 「提交」灰着时的原因。按钮是 disabled，WebView 不会给 disabled 控件发鼠标事件，
   * 所以 title 那套悬停提示在这儿不可靠——直接写成一行字摆出来。
   * 只有「有暂存、但还没写消息」这一种要解释：别的禁用原因（没有暂存）旁边那条
   * 空列表提示已经说清了。
   */
  const commitHint =
    staged.length > 0 && busy === null && !message.trim() ? "填好提交信息就能提交" : null;

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-0.5 border-b border-line px-3 py-1">
        {/* 头部拆两行：第一行只留分支选择，第二行放领先/落后与远程/视图按钮——
            全挤一行按钮太密，分开后每行都有呼吸空间 */}
        {/* 分支名点开是分支菜单：切分支 / 建新分支。下拉的写法照 SettingsDialog 的
            ThemePicker：锚在按钮上，另铺一层透明遮罩接住外部点击 */}
        <div className="relative flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => (branchMenu ? setBranchMenu(false) : openBranchMenu())}
            disabled={busy !== null}
            title={`当前分支：${snapshot.branch ?? "游离 HEAD"}（点击切换）`}
            className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40"
          >
            <IconBranch className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{snapshot.branch ?? "游离 HEAD"}</span>
            <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
          </button>

          {branchMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setBranchMenu(false)} />
              <div
                className="absolute top-full left-0 z-40 mt-1 flex max-h-72 w-64 flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg"
              >
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
                    onClick={() => switchTo(item.name)}
                    disabled={item.current || busy !== null}
                    title={
                      item.gone
                        ? `上游 ${item.upstream} 已经不存在了`
                        : item.upstream
                          ? `上游 ${item.upstream}`
                          : "还没有上游分支"
                    }
                    className="flex items-center gap-1.5 px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    <span className="flex w-3 shrink-0 justify-center">
                      {item.current && <IconCheck className="h-3 w-3 text-ok" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.gone ? (
                      <span className="shrink-0 text-[10px] text-danger">已删除</span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-fg-faint">
                        {item.ahead > 0 && <span>↑{item.ahead}</span>}
                        {item.behind > 0 && <span>↓{item.behind}</span>}
                      </span>
                    )}
                  </button>
                ))}

                {/* 新建分支：点开输入框，回车或点 ✓ 建出来并切过去。
                    不用 window.prompt（WKWebView 不支持），和重命名那套一致 */}
                <div className="mt-1 border-t border-line pt-1">
                  {newBranch === null ? (
                    <button
                      type="button"
                      onClick={() => setNewBranch("")}
                      className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
                    >
                      <IconPlus className="h-3 w-3 shrink-0" />
                      新建分支
                    </button>
                  ) : (
                    <div className="flex items-center gap-1 px-2 py-0.5">
                      <input
                        autoFocus
                        value={newBranch}
                        onChange={(event) => setNewBranch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") createBranchAndSwitch();
                          if (event.key === "Escape") setNewBranch(null);
                        }}
                        placeholder="新分支名"
                        className={`${TEXT_INPUT} min-w-0 flex-1`}
                      />
                      <button
                        type="button"
                        onClick={createBranchAndSwitch}
                        disabled={!newBranch.trim() || busy !== null}
                        title="新建并切换"
                        className={HEADER_ACTION}
                      >
                        <IconCheck className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* 第二行：左边领先/落后，右边远程/视图按钮 */}
        <div className="flex items-center gap-1.5">
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
          <button
            type="button"
            onClick={fetch}
            disabled={busy !== null || snapshot.merging}
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
            disabled={busy !== null || snapshot.merging}
            title="拉取（只允许快进）"
            className={HEADER_ACTION}
          >
            <IconArrowDownToLine
              className={`h-3.5 w-3.5 ${busy === "pull" ? "animate-pulse" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={merge}
            disabled={!canMerge}
            title="合并远程分支（先获取再合并，分叉时产生合并提交）"
            className={HEADER_ACTION}
          >
            <IconMerge className={`h-3.5 w-3.5 ${busy === "merge" ? "animate-pulse" : ""}`} />
          </button>
          <button
            type="button"
            onClick={push}
            disabled={busy !== null || snapshot.merging}
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
        </div>
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
            placeholder={`消息（${formatShortcut(settings.shortcuts["git.commit"])}）`}
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

        <div className="flex shrink-0 items-center gap-1.5">
          {snapshot.merging ? (
            // 合并中：主操作只有"收尾"两件事。冲突没清完时「完成合并」禁用，
            // 按钮上直接写着还剩几个，省得用户去列表里数
            <>
              <button
                type="button"
                onClick={mergeContinue}
                disabled={busy !== null || snapshot.conflicts > 0}
                className={PRIMARY_BUTTON}
              >
                {busy === "mergeContinue"
                  ? "完成合并中…"
                  : snapshot.conflicts > 0
                    ? `还有 ${snapshot.conflicts} 个冲突`
                    : "完成合并"}
              </button>
              <button
                type="button"
                onClick={() => setPendingMergeAbort(true)}
                disabled={busy !== null}
                className={MERGE_ABORT_BUTTON}
              >
                {busy === "mergeAbort" ? "中止中…" : "中止合并"}
              </button>
            </>
          ) : staged.length > 0 ? (
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
            <button type="button" disabled className={PRIMARY_BUTTON} title="还没有暂存的更改">
              提交
            </button>
          )}

          {/* 修正 / 撤销上一次提交。两个都改写历史，所以只有「有 HEAD」时才给；
              合并期间藏起来——那会儿该先收尾，动 HEAD 会让合并状态更乱 */}
          {snapshot.head && !snapshot.merging && (
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => setPendingAmend(true)}
                disabled={busy !== null}
                title="修正上一次提交（把已暂存的改动并进去，提交框里有信息就顺便改掉）"
                className={HEADER_ACTION}
              >
                <IconPencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={undoCommit}
                disabled={busy !== null}
                title="撤销上一次提交（改动回到暂存区，再提交一次就是重提）"
                className={HEADER_ACTION}
              >
                <IconUndo className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        {commitHint && (
          <p className="shrink-0 px-1 text-[11px] text-fg-faint">{commitHint}</p>
        )}

        {snapshot.merging && (
          <p className="shrink-0 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
            正在合并：
            {snapshot.conflicts > 0
              ? `还有 ${snapshot.conflicts} 个冲突未解决，改完文件后暂存，再点「完成合并」`
              : "冲突已解决，点「完成合并」生成合并提交"}
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

        {/* stash：把手上这摊改动先收起来去做别的事。
            门禁用 changes.length 而不是 stashable.length：只有未跟踪的新文件时
            也要把这块画出来，好在那句说明里告诉用户为什么收不了——按 stashable
            判的话这种情形整块都不渲染，提示就没地方放了 */}
        {(stashes === null || stashes.length > 0 || changes.length > 0) && (
          <div className="shrink-0">
            <div className="flex items-center gap-1 px-1">
              <button
                type="button"
                onClick={() => setStashCollapsed((value) => !value)}
                className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] text-fg-faint hover:text-fg"
              >
                {stashCollapsed ? (
                  <IconChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <IconChevronDown className="h-3 w-3 shrink-0" />
                )}
                <span>储藏</span>
                {stashes && stashes.length > 0 && <span>{stashes.length}</span>}
              </button>
              {/* 有可收的改动时才给按钮。判据用 stashable 而不是改动总数：
                  未跟踪的新文件收不走，只按总数判会给出一个点了没反应的按钮 */}
              {stashable.length > 0 && (
                <button
                  type="button"
                  onClick={stash}
                  disabled={busy !== null}
                  title={`把当前 ${stashable.length} 处改动收进 stash（未跟踪的新文件不在此列）`}
                  className={GROUP_ACTION}
                >
                  储藏改动
                </button>
              )}
            </div>

            {!stashCollapsed && (
              <div className="mt-0.5 flex flex-col gap-0.5">
                {/* 说明留空就让 git 自己生成 WIP on <branch>: ... */}
                {stashable.length > 0 && (
                  <input
                    value={stashMessage}
                    onChange={(event) => setStashMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") stash();
                    }}
                    disabled={busy !== null}
                    placeholder="说明（可留空）"
                    className={`${TEXT_INPUT} mx-1 w-auto`}
                  />
                )}
                {stashes?.map((entry) => (
                  <div
                    key={entry.index}
                    className="group flex items-center gap-1 rounded px-1 py-[3px] text-[11px] hover:bg-hover"
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
                        onClick={() => stashBack(entry)}
                        disabled={busy !== null}
                        title="恢复并删掉这条记录"
                        className={ROW_ACTION}
                      >
                        <IconArrowDownToLine className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => applyStash(entry)}
                        disabled={busy !== null}
                        title="恢复，但保留记录（可以再应用到别的分支）"
                        className={ROW_ACTION}
                      >
                        <IconCheck className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingStashDrop(entry)}
                        disabled={busy !== null}
                        title="丢掉这条储藏（不动工作区）"
                        className={ROW_DANGER}
                      >
                        <IconTrash className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
                {stashes?.length === 0 && stashable.length === 0 && (
                  <p className="px-2 py-0.5 text-[11px] text-fg-faint">
                    {/* 有改动但都收不走时把原因说出来，别让人对着空的储藏区发愣 */}
                    {staged.length + unstaged.length > 0
                      ? "当前只有未跟踪的新文件，储藏收不走它们"
                      : "没有储藏"}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* 路径筛选。放在列表正上方而不是塞进 header：它只作用在这块列表上，
            贴着列表才不会被误认成整个面板的搜索框。
            改动不多时（两边加起来不到 10 条）不显示，省得占地方 */}
        {staged.length + unstaged.length >= FILTER_MIN_CHANGES && (
          <div className="relative shrink-0">
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
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
          {staged.length === 0 && unstaged.length === 0 && (
            <p className="px-1 py-1 text-[11px] text-fg-faint">没有未提交的更改</p>
          )}

          {filteredOut && (
            <p className="px-1 py-1 text-[11px] text-fg-faint">
              没有匹配「{filter.trim()}」的更改
            </p>
          )}

          {/* 筛掉的分组整个不画：只留一个空标题行反而让人以为里面没东西 */}
          {stagedShown.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  暂存的更改 ({stagedShown.length}
                  {stagedShown.length === staged.length ? "" : `/${staged.length}`})
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
        {/* 历史标题栏：左边收起 / 展开，右边「回到 HEAD」。
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
            <button
              type="button"
              onClick={jumpToHead}
              title="回到当前提交（HEAD）"
              className={HEADER_ACTION}
            >
              <IconTarget className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* 过滤行：历史太短时不摆——和改动列表的筛选框同一个门槛（见 FILTER_MIN_CHANGES），
            已经筛出结果时（可能只剩几条）则保持可见，免得一打字就把输入框弄没了 */}
        {!logCollapsed && ((commits?.length ?? 0) >= FILTER_MIN_CHANGES || filteringLog) && (
          // 一个输入框 + 一个模式开关。主题 / 作者走后端后置匹配、路径交给 git 的
          // pathspec，模式开关让用户明说是哪一种，省得靠「有没有斜杠」去猜
          <div className="flex shrink-0 items-center gap-1 px-1 pb-1">
            <div className="relative min-w-0 flex-1">
              <input
                type="text"
                value={logFilter}
                onChange={(event) => setLogFilter(event.target.value)}
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
                onToggle={() => toggleCommit(commit.hash)}
                onOpen={onOpen}
                onHover={(rect) => {
                  cancelHoverHide();
                  setHoverCommit({ hash: commit.hash, rect });
                }}
                onUnhover={hideHover}
                onStat={() => ensureStat(commit.hash)}
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
            {/* 目录不是文件：解读会去读目录而报错，这一项不给（和文件树里的口径一致） */}
            {!menu.change.isDir && (
              <button
                type="button"
                onClick={() => startExplain(menu.change, menu.staged)}
                className={MENU_ITEM}
              >
                AI 变更解读
              </button>
            )}
            <button
              type="button"
              onClick={() => void copyPath(menu.change.path)}
              className={MENU_ITEM}
            >
              复制路径
            </button>
            <button
              type="button"
              onClick={() => void copyPath(menu.change.relative)}
              className={MENU_ITEM}
            >
              复制相对路径
            </button>
            {/* 已经跟踪的文件加 .gitignore 不生效（规则只管未跟踪的），不给这一项 */}
            {markOfColumn(menu.staged ? menu.change.index : menu.change.worktree).kind ===
              "untracked" && (
              <button
                type="button"
                onClick={() => void addToIgnore(menu.change)}
                className={MENU_ITEM}
              >
                加入 .gitignore
              </button>
            )}
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
