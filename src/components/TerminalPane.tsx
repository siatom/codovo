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
import { listShells, type ShellInfo } from "../lib/pty";
import type { EditorLocation } from "../lib/types";
import { AgentPane, type AgentPaneHandle } from "./AgentPane";
import { IconChevronDown, IconClose, IconPlus, ShellIcon } from "./icons";

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
  /** 在当前活动的会话里敲一条命令。AI CLI 的入口在侧边栏，执行落在这儿 */
  runAiCommand: (command: string) => void;
  /**
   * 新开一个终端标签并在里面执行命令（resume 会话用）。
   * 不能写进当前活动会话——那儿多半正跑着一个 AI CLI，命令会被当成它的输入。
   */
  runInNewSession: (command: string) => void;
  /** 把位置引用写进当前活动的终端会话，不带回车（用户自己按回车执行） */
  insertToTerminal: (location: EditorLocation) => void;
  /** 把位置引用送进智能体输入框（插成一个可整体删除的 chip），顺带切到 GUI 模式 */
  insertToAgent: (location: EditorLocation) => void;
}

interface TerminalPaneProps {
  /** 当前工作目录；null 表示用户还没选工作区，shell 落在用户主目录 */
  cwd: string | null;
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
export function TerminalPane({ cwd, ref }: TerminalPaneProps) {
  const [sessions, setSessions] = useState<number[]>([0]);
  const [activeId, setActiveId] = useState(0);
  /**
   * 新建标签时要自动敲进去的命令，按会话 id 记。和 sessions 在同一次事件里更新，
   * 新会话第一次渲染就带着它——不存在"先挂载、后补命令"的时间窗。
   */
  const [launchFor, setLaunchFor] = useState<{ id: number; command: string } | null>(null);
  // TUI/GUI 的选择提到了 AgentSessionContext：侧边栏要在 GUI 模式下才列对话历史
  const { mode, setMode } = useAgentSession();
  const nextIdRef = useRef(1);
  const handlesRef = useRef(new Map<number, TerminalSessionHandle>());
  /** 智能体面板的句柄：编辑器浮窗要把文本塞进它的输入框 */
  const agentRef = useRef<AgentPaneHandle>(null);
  /** 每个会话被创建时在下拉里选的 shell id；没记的走设置里的默认 */
  const shellByIdRef = useRef(new Map<number, string>());
  const addButtonRef = useRef<HTMLDivElement>(null);
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
    setSessions((list) => [...list, id]);
    setActiveId(id);
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
    // 关掉最后一个就换一个新的顶上，终端区不留空白
    if (sessions.length === 1) {
      const fresh = nextIdRef.current;
      nextIdRef.current += 1;
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

  // 入口在侧边栏的项目行上，这里只把「往活动会话写命令」这个动作交出去
  const runAiCommand = useCallback(
    (command: string) => {
      const handle = handlesRef.current.get(activeId);
      handle?.write(`${command}\r`);
      handle?.focus();
    },
    [activeId],
  );

  /**
   * 新开标签跑一条命令。命令不在这儿写——新会话的 PTY 还在异步 spawn，
   * 现在写必然被丢掉。交给 initialCommand，由 TerminalSession 在 shell
   * 就绪后自己敲。
   */
  const runInNewSession = useCallback((command: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
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

  useImperativeHandle(
    ref,
    () => ({ runAiCommand, runInNewSession, insertToTerminal, insertToAgent }),
    [runAiCommand, runInNewSession, insertToTerminal, insertToAgent],
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
      {/* 顶栏只剩居中的 TUI / GUI 入口，收放右边栏的按钮在图标条底部 */}
      <header className="flex h-9 shrink-0 items-center justify-center border-b border-line px-2">
        {/* 关掉智能体后这组按钮整个不出，终端区的行为和以前一模一样 */}
        {settings.agentEnabled && (
          <div className="flex items-center gap-0.5 rounded-full bg-app p-0.5">
            <button
              type="button"
              onClick={() => setMode("terminal")}
              title="终端（TUI）"
              className={`flex h-6 items-center justify-center rounded-full px-4 text-[12px] ${
                view === "terminal"
                  ? "bg-selected text-fg shadow-sm"
                  : "text-fg-dim hover:text-fg"
              }`}
            >
              终端
            </button>
            <button
              type="button"
              onClick={() => setMode("agent")}
              title="智能体（GUI）"
              className={`flex h-6 items-center justify-center rounded-full px-4 text-[12px] ${
                view === "agent"
                  ? "bg-selected text-fg shadow-sm"
                  : "text-fg-dim hover:text-fg"
              }`}
            >
              智能体
            </button>
          </div>
        )}
      </header>

      {/* TUI 界面：标签栏和终端本体都归这一套自己管，不和其他界面共用一行 */}
      <div className={view === "terminal" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        {/* 高度和上面 AgentPane 的状态条对齐（都是 h-8），TUI / GUI 来回切时下面内容不跳 */}
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {sessions.map((id, index) => {
              const isActive = id === activeId;
              // 会话自己在下拉里选过就用它，否则跟着设置走，都没有就是「自动」
              const chosen = shellByIdRef.current.get(id);
              const shell =
                shellOptions.find(
                  (item) =>
                    item.id === (chosen !== undefined ? chosen : settings.terminalShell),
                ) ?? shellOptions[0];
              return (
                <div
                  key={id}
                  className={`flex shrink-0 items-center rounded ${
                    isActive ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(id)}
                    title={shell?.label ?? `终端 ${index + 1}`}
                    className="flex max-w-[140px] items-center gap-1 py-0.5 pl-2 text-[11px]"
                  >
                    <ShellIcon kind={shell?.kind ?? "shell"} className="h-3 w-3" />
                    <span className="truncate">{shell?.name ?? `终端 ${index + 1}`}</span>
                  </button>
                  <button
                    type="button"
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
        </div>

        <div className="relative min-h-0 flex-1">
          {sessions.map((id) => (
            <TerminalSession
              key={id}
              ref={attachHandle(id)}
              cwd={cwd}
              // undefined = 跟随设置里的默认；只有在下拉里明确选过 shell 的会话才有值
              shell={shellByIdRef.current.get(id)}
              // 只有从历史里 resume 出来的那个新会话带命令，其余一律 undefined
              initialCommand={launchFor?.id === id ? launchFor.command : undefined}
              // 和 view 挂钩：切回终端时 TerminalSession 的 active effect 会补一次
              // fit + resize + focus，藏起来量不到尺寸的问题就自然解决了
              active={view === "terminal" && id === activeId}
            />
          ))}
        </div>
      </div>

      <div className={view === "agent" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <AgentPane ref={agentRef} cwd={cwd} active={view === "agent"} />
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
