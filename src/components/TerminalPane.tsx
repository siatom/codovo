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
import { AgentPane } from "./AgentPane";
import { IconClose, IconPlus } from "./icons";

export interface TerminalPaneHandle {
  /** 在当前活动的会话里敲一条命令。AI CLI 的入口在侧边栏，执行落在这儿 */
  runAiCommand: (command: string) => void;
  /**
   * 新开一个终端标签并在里面执行命令（resume 会话用）。
   * 不能写进当前活动会话——那儿多半正跑着一个 AI CLI，命令会被当成它的输入。
   */
  runInNewSession: (command: string) => void;
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
  const { settings } = useSettings();

  const attachHandle = useCallback(
    (id: number) => (handle: TerminalSessionHandle | null) => {
      if (handle) handlesRef.current.set(id, handle);
      else handlesRef.current.delete(id);
    },
    [],
  );

  const addSession = () => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setSessions((list) => [...list, id]);
    setActiveId(id);
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

  useImperativeHandle(
    ref,
    () => ({ runAiCommand, runInNewSession }),
    [runAiCommand, runInNewSession],
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
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {sessions.map((id, index) => {
              const isActive = id === activeId;
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
                    className="max-w-[140px] truncate py-0.5 pl-2 text-[11px]"
                  >
                    终端 {index + 1}
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
            <button
              type="button"
              onClick={addSession}
              title="新建终端"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
            >
              <IconPlus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {sessions.map((id) => (
            <TerminalSession
              key={id}
              ref={attachHandle(id)}
              cwd={cwd}
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
        <AgentPane cwd={cwd} active={view === "agent"} />
      </div>
    </section>
  );
}
