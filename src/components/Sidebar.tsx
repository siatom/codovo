import { openPath } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useActivityAll } from "../lib/activity";
import {
  useAttentionAll,
  type AttentionKind,
  type AttentionMap,
} from "../lib/attention";
import { readCliChoice, saveCliChoice } from "../lib/cli-sessions";
import { pathKey, toDisplayPath } from "../lib/fs";
import {
  alignToDevice,
  devicePixelStep,
  easeDock,
} from "../lib/layout-motion";
import type { Workspace } from "../lib/workspaces";
import { useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { CliHistory } from "./CliHistory";
import { FeedbackDialog } from "./FeedbackDialog";
import { SettingsDialog } from "./SettingsDialog";
import {
  IconAlert,
  IconClose,
  IconExternalLink,
  IconFeedback,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconMoon,
  IconMore,
  IconPanelCollapse,
  IconPanelExpand,
  IconPencil,
  IconPin,
  IconSearch,
  IconSettings,
  IconSparkle,
  IconSun,
  IconTrash,
} from "./icons";

interface SidebarProps {
  /** 全部工作区，按存储顺序（新建的插在最前）；列表展示时另行按置顶 + 最近活动排序 */
  workspaces: Workspace[];
  /** 当前工作区的 id；null 表示还没选 */
  currentId: string | null;
  /** 当前工作区的活动根。会话历史 / 设置 / CLI 选择这些还按根记的东西用它 */
  activeRoot: string | null;
  /** 已经打开（挂着工作区实例、后台仍在跑）的工作区 id，用来在列表里点出「已打开」 */
  opened: string[];
  /** 目录已失效（被删 / 换盘）的工作区根，按 `pathKey` 存。命中就在行上标一枚警告 */
  missingRoots: ReadonlySet<string>;
  onSelect: (workspace: Workspace) => void;
  /** 「新建工作区」：新建一个工作区 */
  onCreate: () => void;
  onEdit: (workspace: Workspace) => void;
  /** 只从列表里去掉，不碰磁盘上的目录 */
  onRemove: (workspace: Workspace) => void;
  /** 关掉已打开的工作区：收进程、丢实例，但保留在列表里 */
  onClose: (workspace: Workspace) => void;
  /** 切换置顶：置顶的工作区排在列表最前 */
  onTogglePin: (workspace: Workspace) => void;
  /** 点一条 CLI 会话历史：由 App 转成"新开终端标签跑 resume"，title 作新标签的标题 */
  onResumeSession: (command: string, title: string) => void;
  /** 点「在等用户」的提示：由 App 切到该工作区并选中对应的标签 / 会话 */
  onFocusAttention: (workspace: Workspace, target: string) => void;
  /** 打开「应用助手」：由 App 展开右栏的助手抽屉 */
  onOpenAppAgent: () => void;
  /**
   * 侧边栏是否收起。状态挂在 App 上而不是这里：`app.toggleSidebar`（Ctrl+B）
   * 是在窗口级分发的，够不着这个组件的内部 state。
   */
  collapsed: boolean;
  /** 收起 / 展开侧边栏。落盘（sessionStorage）也由 App 一起做 */
  onSetCollapsed: (collapsed: boolean) => void;
  /** 设置面板是否打开。同样挂在 App 上，好让 `app.settings`（Ctrl+,）能打开它 */
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}

/**
 * 一个工作区里最该先跳过去的目标：优先「要用户回应」的（确认框 / 权限 / 提问），
 * 其次才是「任务完成」的提醒——两件同时存在时，先把卡住的那件处理掉。
 * 同一档里终端标签优先于智能体会话；没有返回 null
 */
function firstWaitingTarget(
  attention: AttentionMap,
  workspace: Workspace,
): { target: string; kind: AttentionKind } | null {
  const found: { target: string; kind: AttentionKind }[] = [];
  for (const root of workspace.roots) {
    const entry = attention[pathKey(root)];
    if (!entry) continue;
    for (const [target, kind] of Object.entries(entry)) found.push({ target, kind });
  }
  const pick = (list: typeof found) =>
    list.find((item) => item.target.startsWith("term:")) ?? list[0] ?? null;
  return pick(found.filter((item) => item.kind !== "done")) ?? pick(found);
}

/** 窗口级偏好，存 sessionStorage：多窗口下各收各的侧边栏 */
const COLLAPSED_KEY = "codedock.sidebarCollapsed";

/** 同上，窗口级：展开态宽度（px），各窗口各拖各的 */
const WIDTH_KEY = "codedock.sidebarWidth";

/** 展开态默认宽度，和原来写死的 w-60 一致 */
const DEFAULT_WIDTH = 240;

/** 再窄工作区名和会话标题就没法看了 */
const MIN_WIDTH = 180;

/** 上限还得看窗口：占掉一半就快没地方给编辑器了 */
const MAX_WIDTH = 560;

/** 读到的值可能来自更宽的窗口，按当前窗口再夹一次 */
function clampWidth(value: number): number {
  const max = Math.min(MAX_WIDTH, Math.round(window.innerWidth / 2));
  return Math.min(max, Math.max(MIN_WIDTH, value));
}

/** 导航行的固定高度：展开态和收起态共用，来回切换时图标不会上下跳 */
const ROW_H = "h-[34px]";

/** 收起态竖条宽度（对应 w-11）。作为收放动画的宽度落点，和右侧图标条同宽 */
const COLLAPSED_WIDTH = 44;

/** 侧栏收放共用的缓动（styles.css 的 --ease-dock）。Tailwind v4 的位移属性是 translate，过渡里要单独写上 */
const SLIDE_EASE = "ease-dock";

/** 一行导航/列表项的统一样式，只靠调用处追加选中态 */
const ROW = `flex w-full ${ROW_H} items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg-muted hover:bg-hover hover:text-fg`;

const FOOTER_BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg";

/** 行内操作按钮：平时藏起来，悬停或键盘聚焦时才出现并接受点击 */
const ROW_ACTION =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100";

/** 工作区行「⋯」弹出来的菜单项 */
const MENU_ITEM = "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 工作区菜单比别处宽：里面要列出工作目录的完整路径 */
const WORKSPACE_MENU_W = 320;

/** 路径末级名字（工作目录名），用于按目录名过滤工作区 */
function baseName(path: string): string {
  return toDisplayPath(path).split("/").filter(Boolean).pop() ?? path;
}

function readCollapsed(): boolean {
  try {
    return window.sessionStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 收起 / 展开侧边栏的落盘。App 那边（全局快捷键切换侧边栏）也要用，所以导出 */
export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    window.sessionStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 记不住就每次启动按展开算，不影响使用
  }
}

/** 上一个会话里侧边栏是不是收起的。初值在 App 里读，见 SidebarProps.collapsed */
export function readSidebarCollapsed(): boolean {
  return readCollapsed();
}

function readWidth(): number {
  try {
    const raw = Number(window.sessionStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw > 0) return alignToDevice(clampWidth(raw));
  } catch {
    // 读不到就用默认宽度
  }
  return alignToDevice(clampWidth(DEFAULT_WIDTH));
}

export function Sidebar({
  workspaces,
  currentId,
  activeRoot,
  opened,
  missingRoots,
  onSelect,
  onCreate,
  onEdit,
  onRemove,
  onClose,
  onTogglePin,
  onResumeSession,
  onFocusAttention,
  onOpenAppAgent,
  collapsed,
  onSetCollapsed,
  settingsOpen,
  onOpenSettings,
  onCloseSettings,
}: SidebarProps) {
  /** 展开态宽度，拖动分隔条改 */
  const [width, setWidth] = useState(readWidth);
  /** 拖动中：记下起点，按像素差算宽度；null 表示没在拖 */
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  /** 侧栏外框：宽度动画直接写 style，避免每帧 setState 把整个列表重渲染一遍 */
  const rootRef = useRef<HTMLDivElement>(null);
  const widthRafRef = useRef<number | null>(null);
  /** 首帧不播动画，直接落到当前状态（含刷新后恢复的收起态） */
  const widthMountedRef = useRef(false);

  /**
   * 宽度自己跑 rAF，不用 CSS transition：中间帧按设备像素对齐（见 lib/layout-motion）。
   *
   * 不对齐的话，终端跟着侧栏每帧移动小数像素，xterm 的 WebGL 渲染器会误判 canvas
   * 尺寸在相邻设备像素之间变化，整块终端每帧重绘（实测 10~25ms/帧），看起来就是
   * 内容在抖。收起 / 展开的落点也提前对齐过，所以动画结束时不会再多抖一下。
   * 拖动分隔条时不走动画，直接跟手。
   */
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const target = collapsed ? COLLAPSED_WIDTH : width;
    const stop = () => {
      if (widthRafRef.current !== null) {
        cancelAnimationFrame(widthRafRef.current);
        widthRafRef.current = null;
      }
    };

    // 首帧、拖动中、或者系统要求减少动态效果：直接落位
    if (
      !widthMountedRef.current ||
      resizing ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      widthMountedRef.current = true;
      stop();
      element.style.width = `${target}px`;
      return;
    }

    const from = element.getBoundingClientRect().width;
    if (Math.abs(from - target) < 0.5) {
      stop();
      element.style.width = `${target}px`;
      return;
    }

    // 收起 / 展开：从当前视觉宽度出发，快速反向切换也不会跳
    stop();
    const step = devicePixelStep();
    const startedAt = performance.now();
    const duration = 300;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const raw = from + (target - from) * easeDock(progress);
      // 最后一帧用精确落点，避免中间帧的取整把展开宽度改掉
      element.style.width = `${progress === 1 ? target : alignToDevice(raw, step)}px`;
      if (progress < 1) {
        widthRafRef.current = requestAnimationFrame(tick);
      } else {
        widthRafRef.current = null;
      }
    };
    widthRafRef.current = requestAnimationFrame(tick);
    return stop;
  }, [collapsed, width, resizing]);
  /** 意见反馈弹窗；和设置一样挂在侧边栏底部按钮上 */
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  /** 工作区名过滤词。纯展示层：只影响渲染哪些行，不动列表的存储顺序 */
  const [wsQuery, setWsQuery] = useState("");
  /** 过滤框是否展开：默认只留一个搜索图标，点开才出现输入框 */
  const [wsSearchOpen, setWsSearchOpen] = useState(false);
  /** 「⋯」菜单开在哪个工作区上，以及贴着按钮的位置 */
  const [menu, setMenu] = useState<{ workspace: Workspace; x: number; y: number } | null>(null);
  /** 底部会话历史里当前选的是哪条命令；按活动根记住 */
  const [cliChoice, setCliChoice] = useState(() => readCliChoice(activeRoot));
  const { theme, toggle } = useTheme();
  const { settings } = useSettings();

  // 「在等用户」的标记（终端 CLI 与助手会话都有）。侧栏要给所有工作区行做标记，
  // 够不着单个 root 的 hook，所以取全局那一份，按各工作区的 root 查
  const attentionByRoot = useAttentionAll();
  // 「最近活动」时间（终端 / 助手用过才算）。工作区行按它排序，取全局那一份
  const activityByRoot = useActivityAll();
  // 空命令是用户在设置里加了还没填的，不进菜单
  const aiCommands = settings.aiCommands
    .map((item) => ({ ...item, name: item.name.trim(), command: item.command.trim() }))
    .filter((item) => item.command);

  // 底部会话历史选中的命令。存的那条可能已经从设置里删掉了，回落第一条
  const activeCliCommand =
    aiCommands.find((item) => item.command === cliChoice)?.command ??
    aiCommands[0]?.command ??
    "";

  // 换工作区要跟着换回这个工作区上次选的 CLI
  useEffect(() => {
    setCliChoice(readCliChoice(activeRoot));
  }, [activeRoot]);

  // 工作区只剩 1 个时过滤入口（图标 / 输入框）会因长度不足被卸载，残留的过滤词会把
  // 列表卡在「没有匹配的工作区」且没有任何清除入口。数量不够就直接复位过滤态。
  useEffect(() => {
    if (workspaces.length <= 1) {
      setWsQuery("");
      setWsSearchOpen(false);
    }
  }, [workspaces.length]);

  // 收起后展开态只是淡出、不卸载，别让「⋯」菜单重新展开时莫名冒出来
  useEffect(() => {
    if (collapsed) setMenu(null);
  }, [collapsed]);

  /** 选 CLI：改状态并按活动根落盘。工作区行的 + 和底部选择器共用它 */
  const pickCli = (command: string) => {
    setCliChoice(command);
    saveCliChoice(activeRoot, command);
  };

  /*
   * 侧边栏宽度走像素、不走 SplitPane 那套百分比：窗口拉宽时侧栏不该跟着涨。
   * 复用 SplitPane 的分隔条手法（pointer capture + body 上的拖动类），
   * 但那个组件的值不受控也不落盘，包进来还得给右栏两处调用点加分支，不划算。
   */
  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { startX: event.clientX, startWidth: width, width };
    setResizing(true);
    document.body.classList.add("codedock-dragging");
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    // 对齐设备像素：拖动时终端也跟着变宽，落点带小数会触发 xterm 整块重绘
    const next = alignToDevice(clampWidth(drag.startWidth + event.clientX - drag.startX));
    drag.width = next;
    setWidth(next);
  };

  const stopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const drag = resizeRef.current;
    if (!drag) return;
    resizeRef.current = null;
    setResizing(false);
    document.body.classList.remove("codedock-dragging");
    // 松手才落盘：拖动中每帧写一次没必要
    try {
      window.sessionStorage.setItem(WIDTH_KEY, String(drag.width));
    } catch {
      // 记不住就每次启动按默认宽度算，不影响使用
    }
  };

  /** 用系统的文件浏览器打开这个目录（Windows 资源管理器 / macOS 访达 / Linux 文件管理器） */
  const openInSystem = (path: string) => {
    setMenu(null);
    void openPath(path).catch(() => {
      // 打不开就算了（目录可能已经被删或改名），列表记录留着不动
    });
  };

  const openMenu = (workspace: Workspace, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setMenu({ workspace, x: rect.right, y: rect.bottom });
  };

  /*
   * 排序：置顶组固定在前，组内按「最近活动」（终端 / 智能体用过才算）倒序。
   * 一个工作区挂多个根时取其中最新的活动时间；没记录过的算 0。活动时间相同时靠
   * sort 的稳定性（ES2019 起）保持列表原有顺序（= 新建插最前）。
   *
   * 显式 `=== true` 归一：新建 / 迁移出来的工作区没有 pinned 字段，直接 Number(undefined)
   * 是 NaN，比较器返回 NaN 会被当 0，新工作区反而不让位、留在置顶项上面。
   *
   * 这里用普通表达式而不是 useMemo：列表也小，排序开销可忽略。
   */
  const activityOf = (workspace: Workspace): number =>
    Math.max(0, ...workspace.roots.map((root) => activityByRoot[pathKey(root)] ?? 0));
  const ordered = [...workspaces].sort((a, b) => {
    const pin = Number(b.pinned === true) - Number(a.pinned === true);
    return pin !== 0 ? pin : activityOf(b) - activityOf(a);
  });

  // 过滤只是渲染层的子集：名字、或任一工作目录的末级目录名命中即可（统一小写比，
  // 与平台的大小写敏感性无关——这里筛的是给人看的名字，不是路径）
  const query = wsQuery.trim().toLowerCase();
  const visible = query
    ? ordered.filter((workspace) =>
        [workspace.name, ...workspace.roots.map((root) => baseName(root))]
          .join("\n")
          .toLowerCase()
          .includes(query),
      )
    : ordered;

  return (
    <div
      ref={rootRef}
      // 宽度由下面的 useLayoutEffect 直接写 style；这里不放 transition，动画自己跑 rAF
      className="relative h-full shrink-0 overflow-hidden bg-panel"
    >
      {/* 展开态：宽度按用户拖出来的像素固定住，外框收窄时被裁切而不是重新排版。
          收起后仍留在场上（inert），这样展开回来搜索词、滚动位置都还在原处。
          只做 opacity 过渡、不碰 translate：这一层里有 fixed 定位的菜单，
          一旦带上位移就会变成它们的包含块，菜单会错位 */}
      <div
        inert={collapsed}
        className={`flex h-full flex-col transition-opacity motion-reduce:transition-none ${SLIDE_EASE} ${
          collapsed
            ? "pointer-events-none opacity-0 duration-150"
            : "opacity-100 duration-200 delay-75"
        }`}
        style={{ width }}
      >
        {/* 品牌与 dev 标记都在窗口标题栏里，这里直接进常用入口 */}
        <nav className="flex shrink-0 flex-col gap-0.5 px-2 pt-2 pb-1">
          <button type="button" onClick={onCreate} className={ROW}>
            <IconFolderPlus />
            <span className="truncate">新建工作区</span>
          </button>
        </nav>

        {/* 工作区标题行：名字多了才给过滤入口，默认收成一个搜索图标，点开才出现输入框 */}
        <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-1">
          <span className="shrink-0 text-[13px] font-semibold tracking-wide text-fg-faint">
            工作区
          </span>
          {workspaces.length > 1 &&
            (wsSearchOpen ? (
              <input
                autoFocus
                value={wsQuery}
                onChange={(event) => setWsQuery(event.target.value)}
                // Esc 清词并收起：这是它唯一的关闭方式，所以顺带把过滤态一起清掉
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setWsQuery("");
                  setWsSearchOpen(false);
                }}
                // 点了别处：没敲东西就收起，敲了东西留着（否则过滤还生效、输入框却不见了）
                onBlur={() => {
                  if (!wsQuery.trim()) setWsSearchOpen(false);
                }}
                placeholder="过滤"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[12px] text-fg placeholder:text-fg-faint focus:border-accent-strong focus:outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setWsSearchOpen(true)}
                title="过滤工作区"
                className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg"
              >
                <IconSearch className="h-3.5 w-3.5" />
              </button>
            ))}
        </div>
        <ul className="min-h-0 flex-1 overflow-auto px-2 py-1">
          {ordered.length === 0 && (
            <li className="px-2 py-1 text-[12px] text-fg-faint">还没有工作区</li>
          )}
          {ordered.length > 0 && visible.length === 0 && (
            <li className="px-2 py-1 text-[12px] text-fg-faint">没有匹配的工作区</li>
          )}
          {visible.map((workspace) => {
            const isCurrent = workspace.id === currentId;
            // 已打开 = 后台挂着实例的工作区，和「只在列表里」区分开
            const isOpen = opened.includes(workspace.id);
            // 任一工作目录失效（被删 / 换盘）就在行上标一枚警告：点开必然失败，先给个预警
            const broken = workspace.roots.some((root) => missingRoots.has(pathKey(root)));
            // 这个工作区里有没有 AI 会话正等着用户（切到后台的也要看得见）
            const waiting = firstWaitingTarget(attentionByRoot, workspace);
            const waitingTitle =
              waiting?.kind === "done"
                ? "有 AI 会话任务已完成，点击跳过去"
                : "有 AI 会话在等你输入，点击跳过去";
            return (
              <li key={workspace.id} data-ws-row className="relative">
                {/* 选中底色罩住整项（含下面的对话历史），不然高亮会在中间断掉 */}
                <div className={`group rounded-lg ${isCurrent ? "bg-selected" : ""}`}>
                  <div className={`${ROW} ${isCurrent ? "text-fg" : ""}`}>
                    <button
                      type="button"
                      onClick={() => onSelect(workspace)}
                      title={workspace.roots.map((root) => toDisplayPath(root)).join("\n")}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      {/* 已打开的工作区（哪怕切到后台）用打开态的文件夹，只在列表里的用闭合态 */}
                      {isOpen ? <IconFolderOpen /> : <IconFolder />}
                      <span className="truncate">{workspace.name}</span>
                      {/* 有 AI 会话在等用户：点它直接跳到那个标签 / 会话（哪怕在别的工作区）。
                          非当前工作区额外挂一枚文字徽章——橙点太小，视线不在侧栏时容易漏看；
                          当前工作区已经能在终端标签上看到脉冲点，不必再加文字 */}
                      {waiting && (
                        <span
                          title={waitingTitle}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onFocusAttention(workspace, waiting.target);
                          }}
                          className="flex shrink-0 cursor-pointer items-center gap-1"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-warn animate-pulse" />
                          {!isCurrent && (
                            <span className="rounded bg-warn-bg px-1 text-[10px] leading-4 whitespace-nowrap text-warn">
                              {waiting.kind === "done" ? "已完成" : "等待输入"}
                            </span>
                          )}
                        </span>
                      )}
                      {/* 目录失效的警告：放在名字后面，一眼看出这条为什么点不开 */}
                      {broken && (
                        <span
                          title="工作目录不存在，点开会失败；可用「⋯」菜单编辑或移除"
                          className="shrink-0 text-warn"
                        >
                          <IconAlert className="h-3.5 w-3.5" />
                        </span>
                      )}
                      {/* 一个工作区挂多个工作目录时，名字后缀一枚数量徽章，不用展开「⋯」菜单也知道它含几个文件夹 */}
                      {workspace.roots.length > 1 && (
                        <span
                          title={`包含 ${workspace.roots.length} 个工作目录`}
                          className="shrink-0 rounded bg-active px-1 text-[10px] leading-4 text-fg-faint"
                        >
                          {workspace.roots.length}
                        </span>
                      )}
                      {/* 置顶的工作区在名字后缀一枚图钉，一眼看得出它为什么排在前面 */}
                      {workspace.pinned && (
                        <span title="已置顶" className="shrink-0 text-fg-faint">
                          <IconPin className="h-3 w-3" />
                        </span>
                      )}
                      {/* 已打开的工作区在名字末尾点一个绿点：切到后台的也在后台跑着，一眼可辨 */}
                      {isOpen && (
                        <span
                          title="工作区已打开"
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok"
                        />
                      )}
                    </button>
                    {/* 行内操作按钮成一组：组内间距比主按钮更小，右侧排得更紧凑 */}
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={(event) => openMenu(workspace, event.currentTarget)}
                        title="更多操作"
                        className={ROW_ACTION}
                      >
                        <IconMore className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {/* 当前 AI CLI 的会话历史。启动 CLI 在中间区顶栏，这里只负责翻历史、点一条 resume */}
        {activeRoot && aiCommands.length > 0 && (
          <CliHistory
            cwd={activeRoot}
            commands={aiCommands}
            value={activeCliCommand}
            onChange={pickCli}
            onResume={onResumeSession}
          />
        )}

        {/* 展开态两个按钮横着排：竖排要吃掉一截高度，白白挤掉下面工作区列表的空间 */}
        <footer className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-2">
          <button
            type="button"
            onClick={toggle}
            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            className={FOOTER_BUTTON}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            title="意见反馈"
            className={FOOTER_BUTTON}
          >
            <IconFeedback />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="设置"
            className={FOOTER_BUTTON}
          >
            <IconSettings />
          </button>
          {/* 应用助手：问答 CodeDock 用法、按指令改设置 / 工作区 / 界面布局 */}
          <button
            type="button"
            onClick={onOpenAppAgent}
            title="应用助手"
            className={FOOTER_BUTTON}
          >
            <IconSparkle />
          </button>
          {/* 收起按钮跟着主题、设置一起沉到底部，头部只留标题 */}
          <button
            type="button"
            onClick={() => onSetCollapsed(true)}
            title="收起侧边栏"
            className={`${FOOTER_BUTTON} ml-auto`}
          >
            <IconPanelCollapse />
          </button>
        </footer>
      </div>

      {/* 收起态竖条：常用入口（新建工作区、主题、反馈、设置、助手、展开）仍然够得着。
          每段留白照展开态来（导航行同高、底部同边距），图标只横向挪位、不上下跳。
          绝对定位压在展开态上面，收起时用它盖住被裁剩的那 44px */}
      <div
        inert={!collapsed}
        className={`absolute inset-y-0 left-0 flex w-11 flex-col bg-panel transition-[opacity,translate] motion-reduce:transition-none ${SLIDE_EASE} ${
          collapsed
            ? "translate-x-0 opacity-100 duration-200 delay-75"
            : "pointer-events-none translate-x-2 opacity-0 duration-150"
        }`}
      >
        {/* 顶部不再摆 logo：品牌已经挪到窗口标题栏，这里直接进常用入口 */}
        <div className="flex shrink-0 flex-col px-2 pt-2 pb-1">
          <button
            type="button"
            onClick={onCreate}
            title="新建工作区"
            className={`flex w-7 ${ROW_H} items-center justify-center rounded-lg text-fg-dim hover:bg-hover hover:text-fg`}
          >
            <IconFolderPlus />
          </button>
        </div>

        <div className="mt-auto flex flex-col items-center gap-1 py-2">
          <button
            type="button"
            onClick={toggle}
            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            className={FOOTER_BUTTON}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            title="意见反馈"
            className={FOOTER_BUTTON}
          >
            <IconFeedback />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="设置"
            className={FOOTER_BUTTON}
          >
            <IconSettings />
          </button>
          {/* 应用助手：问答 CodeDock 用法、按指令改设置 / 工作区 / 界面布局 */}
          <button
            type="button"
            onClick={onOpenAppAgent}
            title="应用助手"
            className={FOOTER_BUTTON}
          >
            <IconSparkle />
          </button>
          <button
            type="button"
            onClick={() => onSetCollapsed(false)}
            title="展开侧边栏"
            className={FOOTER_BUTTON}
          >
            <IconPanelExpand />
          </button>
        </div>
      </div>

      {/* 设置 / 反馈的弹窗放在两个状态之外：收起动画期间它们不该跟着一起被裁掉 */}
      {settingsOpen && <SettingsDialog onClose={onCloseSettings} />}

      {feedbackOpen && (
        <FeedbackDialog onClose={() => setFeedbackOpen(false)} root={activeRoot} />
      )}

      {/* 工作区行的「⋯」菜单：工作区名 + 各工作目录 + 编辑/关闭。用 fixed 定位而不是
          绝对定位：工作区列表是滚动容器，绝对定位的菜单会被 overflow 裁掉，
          靠窗口底部的工作区就看不见菜单了 */}
      {menu && (
        <>
          {/* 铺一层透明遮罩接住外部点击 */}
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: WORKSPACE_MENU_W,
              left: Math.max(4, menu.x - WORKSPACE_MENU_W),
              // 条目数随工作目录数量变，按实际行数折算高度，免得贴底时被顶出可视区
              top: Math.min(
                menu.y + 4,
                window.innerHeight - (menu.workspace.roots.length * 24 + 140),
              ),
            }}
          >
            <div className="flex items-center gap-2 px-3 py-1">
              <IconFolder className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
                {menu.workspace.name}
              </span>
              <button
                type="button"
                onClick={() => openInSystem(menu.workspace.roots[0])}
                title="在文件管理器中打开"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-dim hover:text-fg"
              >
                <IconExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="my-1 border-t border-line" />
            {menu.workspace.roots.map((root) => (
              <div key={root} className="flex items-center gap-2 px-3 py-1">
                <IconFolder className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                <span
                  className="min-w-0 flex-1 truncate text-[12px] text-fg-muted"
                  title={toDisplayPath(root)}
                >
                  {toDisplayPath(root)}
                </span>
              </div>
            ))}
            <div className="my-1 border-t border-line" />
            <button
              type="button"
              onClick={() => {
                const { workspace } = menu;
                setMenu(null);
                onTogglePin(workspace);
              }}
              className={`${MENU_ITEM} flex items-center gap-2`}
            >
              <IconPin className="h-3.5 w-3.5 shrink-0" />
              {menu.workspace.pinned ? "取消置顶" : "置顶"}
            </button>
            <button
              type="button"
              onClick={() => {
                const { workspace } = menu;
                setMenu(null);
                onEdit(workspace);
              }}
              className={`${MENU_ITEM} flex items-center gap-2`}
            >
              <IconPencil className="h-3.5 w-3.5 shrink-0" />
              编辑
            </button>
            {/* 只对已打开的工作区露出「关闭」：关进程、丢实例，但留在列表里，下次点还是它 */}
            {opened.includes(menu.workspace.id) && (
              <button
                type="button"
                onClick={() => {
                  const { workspace } = menu;
                  setMenu(null);
                  onClose(workspace);
                }}
                className={`${MENU_ITEM} flex items-center gap-2`}
              >
                <IconClose className="h-3.5 w-3.5 shrink-0" />
                关闭
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const { workspace } = menu;
                setMenu(null);
                onRemove(workspace);
              }}
              className={`${MENU_ITEM} flex items-center gap-2`}
            >
              <IconTrash className="h-3.5 w-3.5 shrink-0" />
              移除
            </button>
          </div>
        </>
      )}

      {/* 拖宽分隔条：命中区往内挂 4px（外框要裁切宽度动画，不能挂到外面），
          画出来的仍是原本那条 1px 右边框，悬停/拖动才染色。收起态不画，宽度是死的 */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
          className="group absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize"
        >
          <span
            className={`absolute inset-y-0 left-0 w-px ${
              resizing ? "bg-accent-strong" : "group-hover:bg-line-hover"
            }`}
          />
        </div>
      )}
    </div>
  );
}
