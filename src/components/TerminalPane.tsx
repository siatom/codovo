import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  TerminalSession,
  type TerminalSessionHandle,
} from "./TerminalSession";
import { useSettings } from "../lib/settings";
import { useAgentSession } from "../lib/agent-session";
import { terminalTarget, useAttention } from "../lib/attention";
import { listShells, type ShellInfo } from "../lib/pty";
import { usePaneSizes } from "../lib/use-pane-sizes";
import { useTabReorder } from "../lib/use-tab-reorder";
import type { EditorLocation } from "../lib/types";
import { AgentPane, type AgentPaneHandle } from "./AgentPane";
import { FullscreenButton } from "./FullscreenButton";
import {
  AgentLogo,
  IconBot,
  IconChevronDown,
  IconClose,
  IconLayoutColumns,
  IconLayoutRows,
  IconLayoutSingle,
  IconPlus,
  IconTerminal,
  ShellIcon,
} from "./icons";

/** + 号右侧下拉的宽度；菜单贴到窗口右边时要靠它往回收 */
const SHELL_MENU_W = 200;
const SHELL_MENU_ITEM =
  "truncate px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/**
 * 「路径:起[-止]」——单行只写一个行号，跨行才带结束行号。
 * 路径带空格时整串加引号：不加的话 shell 会把它拆成两个词，引用就废了。
 * 只在这一侧加——智能体那边给的是 API 的纯文本，不经过 shell。
 */
function formatLocation({ path, start, end }: EditorLocation): string {
  const text = `${path}:${start}${end > start ? `-${end}` : ""}`;
  return /\s/.test(path) ? `"${text}"` : text;
}

export interface TerminalPaneHandle {
  /**
   * 新开一个终端标签并在里面执行命令（侧栏的 AI CLI 入口与 CLI 会话 resume 都用它）。
   * 不能写进当前活动会话——那儿可能正跑着别的东西，命令会被当成它的输入。
   * `title` 直接作新标签的标题：AI CLI 传 CLI 名，resume 传被恢复会话的标题。
   */
  runInNewSession: (command: string, title: string) => void;
  /** 把位置引用写进当前活动的终端会话，不带回车（用户自己按回车执行） */
  insertToTerminal: (location: EditorLocation) => void;
  /** 把位置引用送进智能体输入框（插成一个可整体删除的 chip），顺带切到 GUI 模式 */
  insertToAgent: (location: EditorLocation) => void;
  /**
   * 选中某个已存在的终端标签（切到 TUI 并聚焦它）。侧栏的「在等用户」提示点它跳过来用。
   * 标签已经关掉了就什么都不做。
   */
  focusSession: (id: number) => void;
}

interface TerminalPaneProps {
  /** 这个终端区属于哪个工作区（工作区根）。PTY 会话按它归属，关工作区时要能收干净 */
  root: string;
  /** 是不是当前显示的工作区。隐藏时只是不显示，shell 照跑 */
  visible: boolean;
  /** 左侧这一列（终端与智能体）是否已全屏展示 */
  fullscreen: boolean;
  /** 切换左侧全屏。按钮画在下面各 view 自己的标题栏右端 */
  onToggleFullscreen: () => void;
  /** React 19 起 ref 可以直接当普通 prop 传，不必再包 forwardRef */
  ref?: Ref<TerminalPaneHandle>;
}

/**
 * 终端区：管一组会话，标签栏负责新增/关闭/切换。
 * 每个会话各自持有一个 PTY，切走只是隐藏，shell 不会被打断。
 *
 * 开了智能体之后顶栏多出 TUI / GUI 两个入口，各自是一套完整界面（标签栏、状态条各管各的）。
 * 两套内容都挂在 DOM 上只切显隐，切回 TUI 时 shell 和滚动历史都还在。
 */
export function TerminalPane({
  root,
  visible,
  fullscreen,
  onToggleFullscreen,
  ref,
}: TerminalPaneProps) {
  const [sessions, setSessions] = useState<number[]>([0]);
  const [activeId, setActiveId] = useState(0);
  const [layout, setLayout] = useState<"tabs" | "horizontal" | "vertical">("tabs");
  /**
   * 新建标签时要自动敲进去的命令，按会话 id 记。和 sessions 在同一次事件里更新，
   * 新会话第一次渲染就带着它——不存在"先挂载、后补命令"的时间窗。
   */
  const [launchFor, setLaunchFor] = useState<{ id: number; command: string } | null>(null);
  // TUI/GUI 的选择提到了 AgentSessionContext：侧边栏要在 GUI 模式下才列对话历史。
  // 按工作区取——一个窗口里同时开着多个工作区，各有各的模式和会话列表
  const { mode, setMode } = useAgentSession(root);
  // 终端标签的「在等用户」标记：TerminalSession 启发式判出来上抛，这里写进全局 store，
  // 侧栏工作区行、标签栏据此提示（非当前工作区的也要看得见）
  const {
    entries: attention,
    set: setAttention,
    clear: clearAttention,
  } = useAttention(root);
  const nextIdRef = useRef(1);
  const handlesRef = useRef(new Map<number, TerminalSessionHandle>());
  /** 智能体面板的句柄：编辑器浮窗要把文本塞进它的输入框 */
  const agentRef = useRef<AgentPaneHandle>(null);
  /** 每个会话被创建时在下拉里选的 shell id；没记的走设置里的默认 */
  const shellByIdRef = useRef(new Map<number, string>());
  /**
   * 普通 shell 会话的标签序号：它用的 shell 是第几次被开出来的。**创建时定死**，
   * 不按「当前还剩几个同名」算——关掉别的标签不会让剩下的跳号（pwsh 3 → pwsh 2）。
   */
  const shellSeqByIdRef = useRef(new Map<number, number>());
  /** 每个 shell 已开出过几个会话，给上面那份序号计数 */
  const shellCountRef = useRef(new Map<string, number>());
  /** AI CLI / resume 会话的标签标题；有值的会话不再按 shell 命名 */
  const customTitleByIdRef = useRef(new Map<number, string>());
  /** 标签的 hover 提示：AI CLI / resume 记启动命令，普通会话回落到 shell 全名 */
  const hintByIdRef = useRef(new Map<number, string>());
  const addButtonRef = useRef<HTMLDivElement>(null);
  /** 并列布局的容器：拖分隔条时按它的尺寸换算比例 */
  const splitRef = useRef<HTMLDivElement>(null);
  const {
    sizes: paneSizes,
    onHandleDown,
    onHandleMove,
    onHandleUp,
  } = usePaneSizes(sessions.length, layout === "horizontal" ? "row" : "column", splitRef);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [shellOptions, setShellOptions] = useState<ShellInfo[]>([]);
  const [shellMenuPos, setShellMenuPos] = useState<{ left: number; top: number } | null>(
    null,
  );
  const { settings } = useSettings();

  // 标签页要显示每个会话的 shell 图标和名字，所以候选一挂载就拉，不用等到点开菜单
  useEffect(() => {
    listShells()
      .then(setShellOptions)
      .catch(() => setShellOptions([{ id: "", label: "自动", name: "终端", kind: "shell" }]));
  }, []);

  /** 会话实际归属的 shell id：创建时选过就用选的，否则跟随设置里的默认 */
  const shellKeyOf = (id: number) => shellByIdRef.current.get(id) ?? settings.terminalShell;

  /** 会话在标签栏要显示的 shell（名字 / 图标 / 全名）；列表还没拉回来就回落到首项 */
  const shellForSession = (id: number) => {
    const key = shellKeyOf(id);
    return shellOptions.find((item) => item.id === key) ?? shellOptions[0];
  };

  /**
   * 给一个普通 shell 会话排固定序号。分配过的直接跳过——这样初始化那个 effect
   * 在 StrictMode 下跑两遍也只算一次，计数不会被多扣。
   */
  const assignShellSeq = (id: number) => {
    if (shellSeqByIdRef.current.has(id)) return;
    const key = shellKeyOf(id);
    const seq = (shellCountRef.current.get(key) ?? 0) + 1;
    shellCountRef.current.set(key, seq);
    shellSeqByIdRef.current.set(id, seq);
  };

  // 初始会话（sessions 的 [0]）不走 addSession，序号在这儿补。它必然是第一个，
  // 序号 1 不显示后缀，所以补分配不需要触发重渲染。上面已分配的直接跳过
  useEffect(() => {
    for (const id of sessions) {
      if (customTitleByIdRef.current.has(id)) continue;
      assignShellSeq(id);
    }
  }, [sessions]);

  const attachHandle = useCallback(
    (id: number) => (handle: TerminalSessionHandle | null) => {
      if (handle) handlesRef.current.set(id, handle);
      else handlesRef.current.delete(id);
    },
    [],
  );

  // shell 不传 = 用设置里的默认；传空串 = 明确点的是「自动」（后端自己挑）。
  // 两者必须分开：用户在菜单里点「自动」时不该被设置里的具体 shell 顶掉。
  const addSession = (shell?: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    if (shell !== undefined) shellByIdRef.current.set(id, shell);
    assignShellSeq(id);
    setSessions((list) => [...list, id]);
    setActiveId(id);
  };

  /**
   * 切到并列布局。只有一个会话时先补一个再切——不然「左右/上下并列」摆出来只有一栏，
   * 和单终端没有区别，用户还得自己去点「+」。
   */
  const setSplitLayout = (next: "horizontal" | "vertical") => {
    if (sessions.length === 1) addSession();
    setLayout(next);
  };

  const toggleShellMenu = () => {
    if (shellMenuOpen) {
      setShellMenuOpen(false);
      return;
    }
    const rect = addButtonRef.current?.getBoundingClientRect();
    if (rect) setShellMenuPos({ left: rect.left, top: rect.bottom + 4 });
    setShellMenuOpen(true);
  };

  const closeSession = (id: number) => {
    // 标签没了，它的「在等用户」标记也一并撤掉（TerminalSession 的 cleanup 也会撤，双保险）
    clearAttention(terminalTarget(id));
    // 关掉最后一个就换一个新的顶上，终端区不留空白
    if (sessions.length === 1) {
      const fresh = nextIdRef.current;
      nextIdRef.current += 1;
      assignShellSeq(fresh);
      setSessions([fresh]);
      setActiveId(fresh);
      return;
    }

    const index = sessions.indexOf(id);
    const rest = sessions.filter((item) => item !== id);
    setSessions(rest);
    // 关掉的是当前会话时，焦点落到它右边那个（没有就往左退一格）
    if (activeId === id) {
      setActiveId(rest[Math.min(index, rest.length - 1)]);
    }
  };

  /**
   * 拖动重排标签：只换 sessions 的顺序，会话 id 不动——TerminalSession 按 id 做 key，
   * 重排不会重建实例，正在跑的 shell 和滚动历史都不受影响。
   */
  const reorderSessions = useCallback((from: number, to: number) => {
    setSessions((current) => {
      if (from < 0 || from >= current.length || from === to) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const { scrollerRef: tabsScrollRef, dragFrom, dropIndex, onTabDown, onClickCapture } =
    useTabReorder(reorderSessions);

  /**
   * 新开标签跑一条命令。命令不在这儿写——新会话的 PTY 还在异步 spawn，
   * 现在写必然被丢掉。交给 initialCommand，由 TerminalSession 在 shell
   * 就绪后自己敲。
   *
   * 一律新开标签，不写进当前活动会话：那儿可能正跑着别的东西（shell、别的 AI CLI），
   * 命令会被当成它的输入。
   */
  const runInNewSession = useCallback((command: string, title: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    // 标题与提示创建时就定死，之后不随别的标签增删改动
    customTitleByIdRef.current.set(id, title);
    hintByIdRef.current.set(id, command);
    setLaunchFor({ id, command });
    setSessions((list) => [...list, id]);
    setActiveId(id);
  }, []);

  // 编辑器浮窗送来的位置引用：终端只认文本，在这儿拼成「路径:起[-止]」再写进活动会话。
  // 末尾补一个空格，和用户接着敲的内容隔开。不带 \r——左侧终端常跑着 AI CLI，
  // 写完让它读文件，什么时候回车由用户决定
  const insertToTerminal = useCallback(
    (location: EditorLocation) => {
      const handle = handlesRef.current.get(activeId);
      handle?.write(`${formatLocation(location)} `);
      handle?.focus();
    },
    [activeId],
  );

  // 智能体那侧同理：先切到 GUI，再把位置交给输入框（那边会插成一个 chip）。
  // 面板可能还没就绪（刚切过来还在 starting），由它自己的 pending 兜住
  const insertToAgent = useCallback(
    (location: EditorLocation) => {
      setMode("agent");
      agentRef.current?.insertRef(location);
    },
    [setMode],
  );

  // 侧栏点了「在等用户」提示：切回 TUI 并选中那个标签。标签可能已经被关掉了，那就不动
  const focusSession = useCallback(
    (id: number) => {
      if (!sessions.includes(id)) return;
      setMode("terminal");
      setActiveId(id);
      const handle = handlesRef.current.get(id);
      // 「切过去即已读」：要切的标签本来就是当前这个时 setActiveId 是空操作，
      // 不会有 active 变化，没法靠会话自己的 effect 清掉 done 标记，直接走 handle
      handle?.markSeen();
      handle?.focus();
    },
    [sessions, setMode],
  );

  useImperativeHandle(
    ref,
    () => ({ runInNewSession, insertToTerminal, insertToAgent, focusSession }),
    [runInNewSession, insertToTerminal, insertToAgent, focusSession],
  );

  // 开关是在设置里随时能关的，而 mode 是共享状态：关掉之后分段控件不画了，
  // 要是还认 mode 就会把人锁在智能体面板里出不去，还白白起一个 opencode。
  const view = settings.agentEnabled ? mode : "terminal";

  // 同时把 mode 也归零，不然重新打开开关会突然跳回智能体面板，看着像自己乱切
  useEffect(() => {
    if (!settings.agentEnabled) setMode("terminal");
  }, [settings.agentEnabled, setMode]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface">
      {/* 顶栏只剩居中的 TUI / GUI 入口，收放右边栏的按钮在图标条底部。
          关掉智能体后整条栏都不渲染——否则会留一条 36px 高、带下边框的空白栏。 */}
      {settings.agentEnabled && (
        <header className="flex h-9 shrink-0 items-center justify-center border-b border-line px-2">
          <div className="flex items-center gap-0.5 rounded-full bg-app p-0.5">
            <button
              type="button"
              onClick={() => setMode("terminal")}
              title="终端（TUI）"
              className={`flex h-6 items-center justify-center gap-1 rounded-full px-4 text-[12px] ${
                view === "terminal"
                  ? "bg-selected text-fg shadow-sm"
                  : "text-fg-dim hover:text-fg"
              }`}
            >
              <IconTerminal className="h-3.5 w-3.5" />
              终端
            </button>
            <button
              type="button"
              onClick={() => setMode("agent")}
              title="智能体（GUI）"
              className={`flex h-6 items-center justify-center gap-1 rounded-full px-4 text-[12px] ${
                view === "agent"
                  ? "bg-selected text-fg shadow-sm"
                  : "text-fg-dim hover:text-fg"
              }`}
            >
              <IconBot className="h-3.5 w-3.5" />
              智能体
            </button>
          </div>
        </header>
      )}

      {/* TUI 界面：标签栏和终端本体都归这一套自己管，不和其他界面共用一行 */}
      <div className={view === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        {/* 高度和上面 AgentPane 的状态条对齐（都是 h-8），TUI / GUI 来回切时下面内容不跳 */}
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
          <div
            ref={tabsScrollRef}
            onClickCapture={onClickCapture}
            className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          >
            {sessions.map((id, index) => {
              const isActive = id === activeId;
              // 会话自己在下拉里选过就用它，否则跟着设置走，都没有就是「自动」
              const shell = shellForSession(id);
              // AI CLI / resume 会话用创建时传来的标题；普通 shell 会话按 shell 名，
              // 同名的从第二个起带固定序号（见 assignShellSeq）
              const custom = customTitleByIdRef.current.get(id);
              // AI CLI / resume 会话的启动命令：有值说明这个标签是 AI CLI，图标用它的 logo
              const launchCommand = hintByIdRef.current.get(id);
              const seq = shellSeqByIdRef.current.get(id) ?? 1;
              const shellName = shell?.name ?? `终端 ${index + 1}`;
              const title = custom ?? (seq > 1 ? `${shellName} ${seq}` : shellName);
              // 悬停提示：启动过的会话报命令，普通会话报 shell 全名
              const hint = launchCommand ?? shell?.label ?? shellName;
              // 这个标签有没有「在等用户」的标记：等回应（prompt）或任务完成（done）
              const kind = attention[terminalTarget(id)];
              const attentionHint =
                kind === "done" ? "任务完成，等待你的下一步指令" : kind ? "正在等待你的输入" : null;
              const dropBefore = dropIndex === index;
              const dropAfter = dropIndex === sessions.length && index === sessions.length - 1;
              return (
                <div
                  key={id}
                  data-tab-item
                  onPointerDown={onTabDown(index)}
                  className={`relative flex shrink-0 items-center rounded ${
                    isActive ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
                  } ${dragFrom === index ? "opacity-40" : ""}`}
                >
                  {/* 落点线：插在某个标签之前画在它左缘，插在末尾画在最后一个标签右缘 */}
                  {(dropBefore || dropAfter) && (
                    <span
                      className={`pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 rounded bg-accent-strong ${
                        dropBefore ? "-left-0.5" : "-right-0.5"
                      }`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveId(id)}
                    title={attentionHint ? `${hint}（${attentionHint}）` : hint}
                    className="flex max-w-[140px] items-center gap-1 py-0.5 pl-2 text-[11px]"
                  >
                    {launchCommand ? (
                      <AgentLogo
                        name={custom ?? ""}
                        command={launchCommand}
                        className="h-3 w-3"
                      />
                    ) : (
                      <ShellIcon kind={shell?.kind ?? "shell"} className="h-3 w-3" />
                    )}
                    {/* 在等用户时标题也一起变色（同脉冲点的 warn 色），标签多时更好认 */}
                    <span className={`truncate ${kind ? "text-warn" : ""}`}>{title}</span>
                    {/* 有标记就点一颗脉冲点，切到别的工作区也看得见；等回应 / 已完成靠 title 区分 */}
                    {attentionHint && (
                      <span
                        title={attentionHint}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn animate-pulse"
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    data-tab-close
                    onClick={() => closeSession(id)}
                    title="关闭这个终端"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:text-danger"
                  >
                    <IconClose className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            <div ref={addButtonRef} className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => addSession()}
                title="新建终端"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
              >
                <IconPlus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={toggleShellMenu}
                title="选择终端程序"
                className="flex h-5 w-4 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
              >
                <IconChevronDown className="h-3 w-3" />
              </button>
            </div>
          </div>
          {/* 三个布局按钮 + 全屏按钮同一排，gap 一致——之前布局按钮裹了一圈边框，
              和外面全屏按钮间距对不上，去掉边框后四个按钮等距 */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setLayout("tabs")}
              title="单终端"
              aria-label="单终端"
              className={`flex h-6 w-6 items-center justify-center rounded ${
                layout === "tabs" ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
              }`}
            >
              <IconLayoutSingle className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setSplitLayout("horizontal")}
              title="左右并列"
              aria-label="左右并列"
              className={`flex h-6 w-6 items-center justify-center rounded ${
                layout === "horizontal" ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
              }`}
            >
              <IconLayoutColumns className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setSplitLayout("vertical")}
              title="上下并列"
              aria-label="上下并列"
              className={`flex h-6 w-6 items-center justify-center rounded ${
                layout === "vertical" ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
              }`}
            >
              <IconLayoutRows className="h-3.5 w-3.5" />
            </button>
            {/* 全屏开关放最右，且在标签滚动区之外：标签横向滚动时它不跟着滑走 */}
            <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
          </div>
        </div>

        {/* 容器元素始终是同一种标签，只换 className：切布局时各会话的包裹层按 key 复用，
            不重建 TerminalSession（重建会杀掉 shell） */}
        <div
          ref={splitRef}
          className={
            layout === "tabs"
              ? "relative min-h-0 flex-1"
              : `flex min-h-0 flex-1 ${layout === "horizontal" ? "flex-row" : "flex-col"}`
          }
        >
          {sessions.flatMap((id, index) => {
            const cell = (
              <div
                key={id}
                className={
                  layout === "tabs"
                    ? id === activeId
                      ? "absolute inset-0"
                      : "hidden"
                    : "relative min-h-0 min-w-0 overflow-hidden"
                }
                // 并列模式按拖出来的比例分配：basis 0 + grow 之比 = 尺寸之比
                style={
                  layout === "tabs"
                    ? undefined
                    : { flexBasis: 0, flexGrow: paneSizes[index] ?? 1, flexShrink: 1 }
                }
                onMouseDown={() => setActiveId(id)}
              >
                <TerminalSession
                  ref={attachHandle(id)}
                  root={root}
                  // undefined = 跟随设置里的默认；只有在下拉里明确选过 shell 的会话才有值
                  shell={shellByIdRef.current.get(id)}
                  // Ctrl/Cmd+W 关的是「当前这个」标签；只剩一个时会换新会话顶上，
                  // 和标签上的关闭按钮同一套语义
                  onRequestClose={() => closeSession(id)}
                  // Ctrl/Cmd+T 新建一个标签，和标签栏那个「+」同一个动作（默认 shell）
                  onRequestNew={() => addSession()}
                  // 只有从历史里 resume 出来的那个新会话带命令，其余一律 undefined
                  initialCommand={launchFor?.id === id ? launchFor.command : undefined}
                  // 启发式判出「在等用户」（等回应 / 任务完成）时上抛，写进全局 store
                  onAttentionChange={(next) => {
                    const target = terminalTarget(id);
                    if (next) setAttention(target, next);
                    else clearAttention(target);
                  }}
                  // 并列模式显示全部会话；标签模式只显示当前会话。active 仍只负责焦点和补尺寸。
                  visible={visible && view === "terminal" && (layout !== "tabs" || id === activeId)}
                  active={visible && view === "terminal" && id === activeId}
                />
              </div>
            );
            // 第一个 pane 前面没有分隔条；其余每个前面插一条，拖动改它和左边/上面那个的比例
            if (layout === "tabs" || index === 0) return [cell];
            return [
              <div
                key={`sep-${id}`}
                role="separator"
                aria-orientation={layout === "horizontal" ? "vertical" : "horizontal"}
                aria-label="拖动调整终端大小"
                onPointerDown={(event) => onHandleDown(index - 1, event)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                className={`relative z-10 shrink-0 bg-line-strong transition-colors hover:bg-line-hover ${
                  layout === "horizontal"
                    ? "w-px cursor-col-resize"
                    : "h-px cursor-row-resize"
                }`}
              >
                {/* 加宽命中区，视觉上仍是一条细线 */}
                <span
                  className={
                    layout === "horizontal"
                      ? "absolute inset-y-0 -left-1 -right-1"
                      : "absolute inset-x-0 -top-1 -bottom-1"
                  }
                />
              </div>,
              cell,
            ];
          })}
        </div>
      </div>

      <div className={view === "agent" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <AgentPane
          ref={agentRef}
          root={root}
          active={visible && view === "agent"}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
      </div>

      {/* 新建终端旁的下拉。用 fixed 定位：标签栏是横向滚动容器，
          绝对定位的菜单会被 overflow 裁掉 */}
      {shellMenuOpen && shellMenuPos && (
        <>
          {/* 铺一层透明遮罩接住外部点击 */}
          <div className="fixed inset-0 z-30" onClick={() => setShellMenuOpen(false)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: SHELL_MENU_W,
              // 贴到窗口右边就往回收，别把菜单顶出可视区
              left: Math.min(shellMenuPos.left, window.innerWidth - SHELL_MENU_W - 4),
              top: shellMenuPos.top,
            }}
          >
            {shellOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.label}
                onClick={() => {
                  setShellMenuOpen(false);
                  addSession(item.id);
                }}
                className={SHELL_MENU_ITEM}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
