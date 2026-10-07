import { openPath } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { formatTime } from "../lib/agent";
import { useAgentSession } from "../lib/agent-session";
import { readCliChoice, saveCliChoice } from "../lib/cli-sessions";
import { toDisplayPath } from "../lib/fs";
import type { Workspace } from "../lib/workspaces";
import { useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import type { AgentSessionSummary } from "../lib/types";
import { CliHistory } from "./CliHistory";
import { ConfirmDialog } from "./ConfirmDialog";
import { FeedbackDialog } from "./FeedbackDialog";
import { SettingsDialog } from "./SettingsDialog";
import {
  AgentLogo,
  IconChevronDown,
  IconChevronRight,
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
  IconPlus,
  IconSearch,
  IconSettings,
  IconSun,
  IconTrash,
} from "./icons";
// 应用图标。直接用 tauri 打包用的那份，省得在前端再存一份重复资源。
// dev 构建用琥珀橙那套（src-tauri/icons/dev/），跟 exe / 托盘图标的区分保持一致
import appLogoRelease from "../../src-tauri/icons/128x128.png";
import appLogoDev from "../../src-tauri/icons/dev/128x128.png";

const appLogo = import.meta.env.DEV ? appLogoDev : appLogoRelease;

interface SidebarProps {
  /** 全部工作区，最近创建/打开的排在最前 */
  workspaces: Workspace[];
  /** 当前工作区的 id；null 表示还没选 */
  currentId: string | null;
  /** 当前工作区的活动根。会话历史 / 设置 / CLI 选择这些还按根记的东西用它 */
  activeRoot: string | null;
  /** 已经打开（挂着工作区实例、后台仍在跑）的工作区 id，用来在列表里点出「已打开」 */
  opened: string[];
  onSelect: (workspace: Workspace) => void;
  /** 工作区行的「+」：新建对话。工作区还没打开时由 App 先把它打开再新建 */
  onNewChat: (workspace: Workspace) => void;
  /** 「新建工作区」：新建一个工作区 */
  onCreate: () => void;
  onEdit: (workspace: Workspace) => void;
  /** 只从列表里去掉，不碰磁盘上的目录 */
  onRemove: (workspace: Workspace) => void;
  /** 关掉已打开的工作区：收进程、丢实例，但保留在列表里 */
  onClose: (workspace: Workspace) => void;
  /** 切换置顶：置顶的工作区排在列表最前 */
  onTogglePin: (workspace: Workspace) => void;
  /** 拖拽重排：整份新顺序（含被拖动项的置顶标记）交给 App 落盘 */
  onReorder: (ordered: Workspace[]) => void;
  /** 启动 AI CLI：由 App 转成「新开一个终端标签跑这条命令」，不注入当前终端。
   *  title 是 CLI 名，作新标签的标题 */
  onRunAiCommand: (command: string, title: string) => void;
  /** 点一条 CLI 会话历史：由 App 转成"新开终端标签跑 resume"，title 作新标签的标题 */
  onResumeSession: (command: string, title: string) => void;
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

/** 一行导航/列表项的统一样式，只靠调用处追加选中态 */
const ROW = `flex w-full ${ROW_H} items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg-muted hover:bg-hover hover:text-fg`;

const FOOTER_BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg";

/** 行内操作按钮：平时藏起来，悬停或键盘聚焦时才出现并接受点击 */
const ROW_ACTION =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100";

/** 工作区行右侧的「+」：和「⋯」一样平时藏着，悬停整行才露出；多一层底色，和主按钮悬停同色 */
const ROW_PLUS = `${ROW_ACTION} hover:bg-active`;

/** 工作区行「⋯」弹出来的菜单项 */
const MENU_ITEM = "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 菜单宽度（px），贴着按钮右边缘往左排时要拿它算 left */
const MENU_W = 112;

/** 工作区菜单比别处宽：里面要列出工作目录的完整路径 */
const WORKSPACE_MENU_W = 320;

/** AI CLI 菜单比别的菜单宽：名字前面多了个 logo，112 会把 codebuddy 这种名字挤断 */
const AI_MENU_W = 150;

/** 工作区行拖动重排：纵向移过这么多像素才算「在拖」，免得手抖把点击变成重排 */
const DRAG_THRESHOLD = 4;

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

function readWidth(): number {
  try {
    const raw = Number(window.sessionStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw > 0) return clampWidth(raw);
  } catch {
    // 读不到就用默认宽度
  }
  return clampWidth(DEFAULT_WIDTH);
}

export function Sidebar({
  workspaces,
  currentId,
  activeRoot,
  opened,
  onSelect,
  onNewChat,
  onCreate,
  onEdit,
  onRemove,
  onClose,
  onTogglePin,
  onReorder,
  onRunAiCommand,
  onResumeSession,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  /** 展开态宽度，拖动分隔条改 */
  const [width, setWidth] = useState(readWidth);
  /** 拖动中：记下起点，按像素差算宽度；null 表示没在拖 */
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  /**
   * 工作区行的拖动重排。会话放 ref：指针每动一下都要更新，不能每帧重建整棵列表。
   * `started` 区分「按下」和「真的在拖」，没越过阈值时一切照旧（点击选中不受影响）。
   */
  const dragRef = useRef<{ id: string; startY: number; started: boolean } | null>(null);
  /** 已按下、还没越过阈值；非空时才往 window 上挂监听 */
  const [dragPending, setDragPending] = useState(false);
  /** 拖动中的落点：插到第几项之前（0..行数），以及拖的是谁 */
  const [dragOver, setDragOver] = useState<{ id: string; index: number } | null>(null);
  /** 落点索引的同步副本：pointerup 时要读最新值，走 state 会拿到上一帧的 */
  const dropIndexRef = useRef<number | null>(null);
  /** 刚拖完要吞掉随后那一次 click（pointerup 之后浏览器还会补一个 click） */
  const swallowClickRef = useRef(false);
  /** 工作区列表容器：按各行的中线算落点 */
  const listRef = useRef<HTMLUListElement>(null);
  /** 当前渲染顺序的副本：拖动监听只挂一次，别每帧重挂 */
  const orderedRef = useRef<Workspace[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 意见反馈弹窗；和设置一样挂在侧边栏底部按钮上 */
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  /** 当前工作区的对话历史是否展开；默认展开 */
  const [historyOpen, setHistoryOpen] = useState(true);
  /** 工作区名过滤词。纯展示层：只影响渲染哪些行，不动列表的存储顺序 */
  const [wsQuery, setWsQuery] = useState("");
  /** 过滤框是否展开：默认只留一个搜索图标，点开才出现输入框 */
  const [wsSearchOpen, setWsSearchOpen] = useState(false);
  /** 等待确认删除的会话；非空时弹确认框 */
  const [pendingDelete, setPendingDelete] = useState<AgentSessionSummary | null>(null);
  /** 「⋯」菜单开在哪个工作区上，以及贴着按钮的位置 */
  const [menu, setMenu] = useState<{ workspace: Workspace; x: number; y: number } | null>(null);
  /** AI CLI 菜单开在哪儿；配了多个命令时才用得上，位置同工作区菜单 */
  const [aiMenu, setAiMenu] = useState<{ x: number; y: number } | null>(null);
  /** 会话行的「⋯」菜单开在哪条会话上，位置同工作区菜单 */
  const [histMenu, setHistMenu] = useState<{
    item: AgentSessionSummary;
    x: number;
    y: number;
  } | null>(null);
  /** 正在就地改名的会话 */
  const [renamingSession, setRenamingSession] = useState<{
    id: string;
    value: string;
  } | null>(null);
  /** 底部会话历史里当前选的是哪条命令；按活动根记住 */
  const [cliChoice, setCliChoice] = useState(() => readCliChoice(activeRoot));
  const { theme, toggle } = useTheme();
  const { settings } = useSettings();

  const {
    mode,
    sessions,
    currentId: sessionId,
    requestSession,
    requestDelete,
    requestRename,
  } = useAgentSession(activeRoot);
  // 对话历史只在终端区停在 GUI 时出现：TUI 下智能体服务多半没起，列出来也没意义
  const guiActive = settings.agentEnabled && mode === "agent";
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

  /** 选 CLI：改状态并按活动根落盘。工作区行的 + 和底部选择器共用它 */
  const pickCli = (command: string) => {
    setCliChoice(command);
    saveCliChoice(activeRoot, command);
  };

  const setCollapsedPersisted = (next: boolean) => {
    setCollapsed(next);
    try {
      window.sessionStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // 记不住就每次启动按展开算，不影响使用
    }
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
    const next = clampWidth(drag.startWidth + event.clientX - drag.startX);
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

  /** 按各行的中线算落点：返回「插到第几项之前」，范围 0..行数 */
  const dropIndexAt = (clientY: number): number => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-ws-row]");
    if (!rows || rows.length === 0) return 0;
    for (let index = 0; index < rows.length; index += 1) {
      const rect = rows[index].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return rows.length;
  };

  /** 工作区行按下：只记起点，「到底在不在拖」交给 window 上的 pointermove 判 */
  const onRowDown = (event: ReactPointerEvent<HTMLDivElement>, workspace: Workspace) => {
    // 只认鼠标左键：触摸的纵向拖动要留给列表滚动，笔同理
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    // 就地改名的输入框不参与拖动，否则选词会变成拖行
    if ((event.target as HTMLElement).closest("input")) return;
    // 过滤态下屏幕上的行只是子集，按它算落点会把隐藏项的顺序写坏，干脆不拖
    if (wsQuery.trim()) return;
    swallowClickRef.current = false;
    dragRef.current = { id: workspace.id, startY: event.clientY, started: false };
    setDragPending(true);
  };

  /*
   * 拖动重排。pointermove / pointerup 挂 window 而不是行自己：指针一移出行外，行上的
   * onPointerMove 就断了。行也刻意不 setPointerCapture——捕获会把 click 重定向到行容器，
   * 行内「⋯」「+」这些按钮就都点不动了（分隔条那种不吃点击的地方才能这么用）。
   */
  useEffect(() => {
    if (!dragPending) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.started) {
        if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
        drag.started = true;
        // 按下到越界这几像素里可能已经选上了文本，清掉
        window.getSelection()?.removeAllRanges();
        document.body.classList.add("codedock-dragging-list");
      }
      const index = dropIndexAt(event.clientY);
      dropIndexRef.current = index;
      setDragOver({ id: drag.id, index });
    };
    const finish = (commit: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragPending(false);
      setDragOver(null);
      document.body.classList.remove("codedock-dragging-list");
      const index = dropIndexRef.current;
      dropIndexRef.current = null;
      // 按下了但没动过，那就是普通点击，什么都不用做
      if (!drag?.started) return;
      // 拖完浏览器还会补一次 click，吞掉它，别顺手把工作区又切一遍
      swallowClickRef.current = true;
      if (!commit || index === null) return;

      const list = orderedRef.current;
      const from = list.findIndex((item) => item.id === drag.id);
      const rest = list.filter((item) => item.id !== drag.id);
      // 只有一个工作区时拖动没有意义，顺带免得把它的置顶标记抹掉
      if (from < 0 || rest.length === 0) return;

      // 置顶组排在最前，所以「插进置顶组」就置顶、插到普通区就取消。全列表都是置顶项时
      // 拖到哪都还在组内（末尾也算）；否则拖过最后一个置顶项的中线就算出组
      const insertAt = index > from ? index - 1 : index;
      const pinnedCount = rest.filter((item) => item.pinned === true).length;
      const pinned = pinnedCount === rest.length || insertAt < pinnedCount;
      const moved = { ...list[from], pinned };
      const next = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
      // 落点和原位一样就是没动过，不必落盘（pinned 缺省是 undefined，比之前先归一）
      const unchanged = next.every(
        (item, i) =>
          item.id === list[i].id && (item.pinned === true) === (list[i].pinned === true),
      );
      if (unchanged) return;
      onReorder(next);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [dragPending, onReorder]);

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

  const openHistMenu = (item: AgentSessionSummary, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setHistMenu({ item, x: rect.right, y: rect.bottom });
  };

  /** 点工作区行右侧的「+」：只有一个命令就直接跑，配了多个才出菜单挑 */
  const launchAi = (target: HTMLElement) => {
    if (aiCommands.length === 1) {
      // 顺便把底部会话历史的选择器切过去，两边始终看同一家
      pickCli(aiCommands[0].command);
      onRunAiCommand(aiCommands[0].command, aiCommands[0].name || "未命名 AI CLI");
      return;
    }
    const rect = target.getBoundingClientRect();
    setAiMenu({ x: rect.right, y: rect.bottom });
  };

  /**
   * 会话改名：空标题当取消（后端也拒），没改动就不打后端。
   * 真正的 PATCH 由 AgentPane 做——它拿着刷新列表的入口，改完侧边栏自然换字。
   */
  const renameSession = (id: string, value: string) => {
    setRenamingSession(null);
    const title = value.trim();
    if (!title) return;
    if (sessions.find((item) => item.id === id)?.title === title) return;
    requestRename(id, title);
  };

  // 收起后留一个图标宽的竖条：常用入口（新建工作区、主题）仍然够得着，
  // 顶上那个按钮负责展开。
  // 每段的上下留白都照展开态来（头部同高、导航行同高、底部同边距），
  // 这样来回切换时图标只横向挪位，不会上下跳。
  if (collapsed) {
    return (
      <div
        className="flex h-full w-11 shrink-0 flex-col border-r border-line bg-panel"
      >
        {/* 收起后这里只剩个空挡太素，摆上应用 logo。高度仍与展开态头部一致，
            这样来回切换时下面的图标只横向挪位、不上下跳 */}
        <div className="flex h-11 shrink-0 items-center justify-center">
          <img src={appLogo} alt="CodeDock" className="h-6 w-6" />
        </div>

        <div className="flex shrink-0 flex-col px-2 pb-1">
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
            onClick={() => setSettingsOpen(true)}
            title="设置"
            className={FOOTER_BUTTON}
          >
            <IconSettings />
          </button>
          <button
            type="button"
            onClick={() => setCollapsedPersisted(false)}
            title="展开侧边栏"
            className={FOOTER_BUTTON}
          >
            <IconPanelExpand />
          </button>
        </div>

        {settingsOpen && (
          <SettingsDialog onClose={() => setSettingsOpen(false)} cwd={activeRoot} />
        )}
        {feedbackOpen && (
          <FeedbackDialog onClose={() => setFeedbackOpen(false)} root={activeRoot} />
        )}
      </div>
    );
  }

  // 置顶的工作区排最前；置顶组与普通组内部各自维持原有顺序（sort 自 ES2019 起稳定）。
  // 显式 `=== true` 归一：新建 / 迁移出来的工作区没有 pinned 字段，直接 Number(undefined)
  // 是 NaN，比较器返回 NaN 会被当 0，新工作区反而不让位、留在置顶项上面。
  const ordered = [...workspaces].sort(
    (a, b) => Number(b.pinned === true) - Number(a.pinned === true),
  );
  // 拖动的 window 监听只挂一次，所以顺序走 ref 传给它
  orderedRef.current = ordered;

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
      className="relative flex h-full shrink-0 flex-col border-r border-line bg-panel"
      style={{ width }}
    >
      {/* 标题栏只放 CodeDock，顶部高度与右侧保持一致 */}
      <header className="flex h-11 shrink-0 items-center px-2">
        <span className="shrink-0 px-2 text-[16px] font-semibold text-fg">
          CodeDock
          {/* dev 构建挂一枚 dev 上标（内联元素靠相对位移浮到右上角）：和装好的正式版
              同时开着时，不用翻设置也一眼分得清 */}
          {import.meta.env.DEV && (
            <span className="relative -top-2 ml-1 rounded border border-warn-line-strong px-1 text-[9px] font-medium leading-[13px] text-warn">
              dev
            </span>
          )}
        </span>
      </header>

      <nav className="flex shrink-0 flex-col gap-0.5 px-2 pb-1">
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
      {/* 顶部留一点内边距：「拖到最前」的落点线画在第一行上方，没有它会被 overflow 裁掉，
          用户就只看得见「插到第二项之前」那条线、以为最多只能拖到第 2 位 */}
      <ul ref={listRef} className="min-h-0 flex-1 overflow-auto px-2 pt-1 pb-2">
        {ordered.length === 0 && (
          <li className="px-2 py-1 text-[12px] text-fg-faint">还没有工作区</li>
        )}
        {ordered.length > 0 && visible.length === 0 && (
          <li className="px-2 py-1 text-[12px] text-fg-faint">没有匹配的工作区</li>
        )}
        {visible.map((workspace, index) => {
          const isCurrent = workspace.id === currentId;
          // 已打开 = 后台挂着实例的工作区，和「只在列表里」区分开
          const isOpen = opened.includes(workspace.id);
          const dragging = dragOver?.id === workspace.id;
          // 落点线：插在第一项之前画在这行上面，插在最后一项之后画在最后一行下面
          const dropBefore = dragOver?.index === index;
          const dropAfter = dragOver?.index === visible.length && index === visible.length - 1;
          return (
            <li key={workspace.id} data-ws-row className="relative">
              {(dropBefore || dropAfter) && (
                <span
                  className={`pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded bg-accent-strong ${
                    dropBefore ? "-top-0.5" : "-bottom-0.5"
                  }`}
                />
              )}
              {/* 选中底色罩住整项（含下面的对话历史），不然高亮会在中间断掉 */}
              <div
                className={`group rounded-lg ${isCurrent ? "bg-selected" : ""}`}
                // 拖完紧跟着的那次 click 在这里拦掉：行内主按钮、⋯、+ 都在这一层里
                onClickCapture={(event) => {
                  if (!swallowClickRef.current) return;
                  swallowClickRef.current = false;
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <div
                  className={`${ROW} ${isCurrent ? "text-fg" : ""} ${
                    dragging ? "opacity-40" : ""
                  }`}
                  onPointerDown={(event) => onRowDown(event, workspace)}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(workspace)}
                    title={workspace.roots.map((root) => toDisplayPath(root)).join("\n")}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    {/* 已打开的工作区（哪怕切到后台）用打开态的文件夹，只在列表里的用闭合态 */}
                    {isOpen ? <IconFolderOpen /> : <IconFolder />}
                    <span className="truncate">{workspace.name}</span>
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
                    {/* 新建对话：当前工作区停在 GUI 时给；别的工作区（含还没打开的）也给——点了
                        会先把它打开并切到 GUI，等价于「添加对话即打开工作区」。当前工作区停在 TUI
                        时不出现，那个位置留给下面启动 AI CLI 的 + */}
                    {(guiActive || (!isCurrent && settings.agentEnabled)) && (
                      <button
                        type="button"
                        onClick={() => onNewChat(workspace)}
                        title="新建对话"
                        className={ROW_PLUS}
                      >
                        <IconPlus className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {/* 折叠按钮只对当前工作区且停在 GUI 时有意义（对话历史就挂它下面） */}
                    {isCurrent && guiActive && (
                      <button
                        type="button"
                        onClick={() => setHistoryOpen((open) => !open)}
                        title={historyOpen ? "收起对话历史" : "展开对话历史"}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg"
                      >
                        {historyOpen ? (
                          <IconChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <IconChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                    {/* TUI 下同一个位置放 AI CLI 的入口：新开一个终端标签启动它。
                        配了多个命令时点「+」出菜单挑，只有一个就直接执行 */}
                    {isCurrent && !guiActive && (
                      <button
                        type="button"
                        onClick={(event) => launchAi(event.currentTarget)}
                        disabled={aiCommands.length === 0}
                        title={
                          aiCommands.length === 0
                            ? "还没配置 AI CLI 命令，去设置里加一个"
                            : "新开终端标签启动 AI CLI"
                        }
                        className={`${ROW_PLUS} disabled:cursor-not-allowed disabled:hover:bg-transparent`}
                      >
                        <IconPlus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* 对话历史挂当前工作区下，由工作区行右侧的折叠按钮控制；点一条切到 GUI 并打开它 */}
                {isCurrent &&
                  guiActive &&
                  historyOpen &&
                  (sessions.length === 0 ? (
                    <p className="pr-2 pb-1 pl-[34px] text-[11px] text-fg-faint">还没有对话</p>
                  ) : (
                    <ul className="flex flex-col pb-1">
                      {sessions.map((item) => {
                        const isActive = item.id === sessionId;
                        return (
                          <li
                            key={item.id}
                            className={`group/hist flex items-center rounded-md ${
                              isActive ? "bg-active" : "hover:bg-hover"
                            }`}
                          >
                            {renamingSession?.id === item.id ? (
                              /* 就地改名：Enter 确认、Esc 取消、点别处也算确认 */
                              <input
                                autoFocus
                                value={renamingSession.value}
                                onChange={(event) =>
                                  setRenamingSession({ id: item.id, value: event.target.value })
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    renameSession(item.id, renamingSession.value);
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    setRenamingSession(null);
                                  }
                                }}
                                onBlur={() => renameSession(item.id, renamingSession.value)}
                                className="my-0.5 mr-2 ml-[34px] min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-line-hover"
                              />
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => requestSession(item.id)}
                                  title={item.title}
                                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1 pl-[34px] text-left text-[12px] ${
                                    isActive
                                      ? "text-fg"
                                      : "text-fg-muted group-hover/hist:text-fg"
                                  }`}
                                >
                                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                  {/* 时间只在没悬停时露脸：悬停后右侧让给「⋯」，两个都留会把标题挤没 */}
                                  <span className="shrink-0 text-[11px] text-fg-faint group-hover/hist:hidden">
                                    {formatTime(item.updated)}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => openHistMenu(item, event.currentTarget)}
                                  title="更多操作"
                                  className="pointer-events-none mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/hist:pointer-events-auto group-hover/hist:opacity-100"
                                >
                                  <IconMore className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>

      {/* 当前 AI CLI 的会话历史。只在 TUI 下出现：GUI 那边工作区行下面已经有
          opencode 自己的对话历史了，两套同时出现会打架 */}
      {activeRoot && !guiActive && aiCommands.length > 0 && (
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
          onClick={() => setSettingsOpen(true)}
          title="设置"
          className={FOOTER_BUTTON}
        >
          <IconSettings />
        </button>
        {/* 收起按钮跟着主题、设置一起沉到底部，头部只留标题 */}
        <button
          type="button"
          onClick={() => setCollapsedPersisted(true)}
          title="收起侧边栏"
          className={`${FOOTER_BUTTON} ml-auto`}
        >
          <IconPanelCollapse />
        </button>
      </footer>

      {settingsOpen && (
          <SettingsDialog onClose={() => setSettingsOpen(false)} cwd={activeRoot} />
        )}

      {feedbackOpen && (
        <FeedbackDialog onClose={() => setFeedbackOpen(false)} root={activeRoot} />
      )}

      {/* 删除会话不可撤销，走自研确认框（三端一致，见 ConfirmDialog 的说明） */}
      {pendingDelete && (
        <ConfirmDialog
          message={`删除会话「${pendingDelete.title}」？这条对话的消息会一起删掉，不可撤销。`}
          confirmLabel="删除"
          onConfirm={() => {
            requestDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
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

      {/* 会话行的「⋯」菜单。同样 fixed 定位，理由见上面工作区菜单 */}
      {histMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setHistMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: MENU_W,
              left: histMenu.x - MENU_W,
              top: Math.min(histMenu.y + 4, window.innerHeight - 72),
            }}
          >
            <button
              type="button"
              onClick={() => {
                const { item } = histMenu;
                setHistMenu(null);
                setRenamingSession({ id: item.id, value: item.title });
              }}
              className={MENU_ITEM}
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => {
                const { item } = histMenu;
                setHistMenu(null);
                setPendingDelete(item);
              }}
              className={MENU_ITEM}
            >
              删除对话
            </button>
          </div>
        </>
      )}

      {/* AI CLI 菜单。同样 fixed 定位，理由见上面工作区菜单 */}
      {aiMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setAiMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: AI_MENU_W,
              left: aiMenu.x - AI_MENU_W,
              // 条数不定，按实际行数折算高度，免得贴底时被顶出可视区
              top: Math.min(aiMenu.y + 4, window.innerHeight - (aiCommands.length * 26 + 20)),
            }}
          >
            {aiCommands.map((item, index) => (
              <button
                key={`${item.name}-${item.command}-${index}`}
                type="button"
                onClick={() => {
                  setAiMenu(null);
                  pickCli(item.command);
                  onRunAiCommand(item.command, item.name || "未命名 AI CLI");
                }}
                title={item.name || "未命名 AI CLI"}
                className={`${MENU_ITEM} flex items-center gap-2`}
              >
                <AgentLogo name={item.name} command={item.command} />
                <span className="truncate">{item.name || "未命名 AI CLI"}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* 拖宽分隔条：命中区往外挂 4px，压住右边工作区的左沿一点点（和 SplitPane 一个路子）；
          画出来的仍是原本那条 1px 右边框，悬停/拖动才染色。收起态不画，宽度是死的 */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        className="group absolute inset-y-0 -right-px z-10 w-1 cursor-col-resize"
      >
        <span
          className={`absolute inset-y-0 left-0 w-px ${
            resizing ? "bg-accent-strong" : "group-hover:bg-line-hover"
          }`}
        />
      </div>
    </div>
  );
}
