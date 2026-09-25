import { useCallback, useEffect, useRef, useState } from "react";
import {
  TerminalSession,
  type TerminalSessionHandle,
} from "./TerminalSession";
import { useSettings } from "../lib/settings";
import { useAgentSession } from "../lib/agent-session";
import { AgentPane } from "./AgentPane";
import {
  IconBot,
  IconChevronDown,
  IconClose,
  IconPanelRight,
  IconPanelRightOpen,
  IconPlus,
  IconTerminal,
} from "./icons";

interface TerminalPaneProps {
  /** 当前工作目录；null 表示用户还没选工作区，shell 落在用户主目录 */
  cwd: string | null;
  /** 右边栏（文件/变更 + 编辑器）是否展开 */
  rightOpen: boolean;
  /** 不传就不显示切换按钮——还没选工作区时右边栏是「选择文件夹」提示，收不起来 */
  onToggleRight?: () => void;
}

/**
 * 终端区：管一组会话，标签栏负责新增/关闭/切换。
 * 每个会话各自持有一个 PTY，切走只是隐藏，shell 不会被打断。
 *
 * 开了智能体之后顶栏多出 TUI / GUI 两个入口，各自是一套完整界面（标签栏、状态条各管各的）。
 * 两套内容都挂在 DOM 上只切显隐，切回 TUI 时 shell 和滚动历史都还在。
 */
export function TerminalPane({ cwd, rightOpen, onToggleRight }: TerminalPaneProps) {
  const [sessions, setSessions] = useState<number[]>([0]);
  const [activeId, setActiveId] = useState(0);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
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

  const runAiCommand = (command: string) => {
    const handle = handlesRef.current.get(activeId);
    handle?.write(`${command}\r`);
    handle?.focus();
  };

  // 空命令是用户在设置里加了还没填的，不进下拉
  const aiCommands = settings.aiCommands
    .map((item) => ({
      ...item,
      name: item.name.trim(),
      command: item.command.trim(),
    }))
    .filter((item) => item.command);

  // 开关是在设置里随时能关的，而 mode 是共享状态：关掉之后分段控件不画了，
  // 要是还认 mode 就会把人锁在智能体面板里出不去，还白白起一个 opencode。
  const view = settings.agentEnabled ? mode : "terminal";

  // 同时把 mode 也归零，不然重新打开开关会突然跳回智能体面板，看着像自己乱切
  useEffect(() => {
    if (!settings.agentEnabled) setMode("terminal");
  }, [settings.agentEnabled, setMode]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface">
      {/* 绝对居中而不是靠 flex 排：右边还挂着右栏开关，走 flex 的话会跟着偏 */}
      <header className="relative flex h-9 shrink-0 items-center border-b border-line px-2">
        {/* 关掉智能体后这组按钮整个不出，终端区的行为和以前一模一样 */}
        {settings.agentEnabled && (
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded bg-app p-0.5">
            <button
              type="button"
              onClick={() => setMode("terminal")}
              title="终端（TUI）"
              className={`flex h-6 items-center gap-1.5 rounded px-3 text-[12px] ${
                view === "terminal" ? "bg-active text-fg" : "text-fg-dim hover:text-fg"
              }`}
            >
              <IconTerminal className="h-3.5 w-3.5" />
              TUI
            </button>
            <button
              type="button"
              onClick={() => setMode("agent")}
              title="智能体（GUI）"
              className={`flex h-6 items-center gap-1.5 rounded px-3 text-[12px] ${
                view === "agent" ? "bg-active text-fg" : "text-fg-dim hover:text-fg"
              }`}
            >
              <IconBot className="h-3.5 w-3.5" />
              GUI
            </button>
          </div>
        )}

        <div className="min-w-0 flex-1" />

        {onToggleRight && (
          <button
            type="button"
            onClick={onToggleRight}
            title={rightOpen ? "收起右边栏" : "展开右边栏"}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-active hover:text-fg ${
              rightOpen ? "text-fg" : "text-fg-dim"
            }`}
          >
            {rightOpen ? (
              <IconPanelRightOpen className="h-3.5 w-3.5" />
            ) : (
              <IconPanelRight className="h-3.5 w-3.5" />
            )}
          </button>
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
          {aiCommands.length > 1 ? (
            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setAiMenuOpen((open) => !open)}
                title="在当前终端中启动 AI CLI（可下拉选择命令）"
                className={`flex h-6 shrink-0 items-center gap-0.5 rounded px-1 hover:bg-active hover:text-fg ${
                  aiMenuOpen ? "bg-active text-fg" : "text-fg-dim"
                }`}
              >
                <IconBot className="h-3.5 w-3.5" />
                <IconChevronDown className="h-3 w-3" />
              </button>
              {aiMenuOpen && (
                <>
                  {/* 铺一层透明遮罩接住外部点击 */}
                  <div className="fixed inset-0 z-30" onClick={() => setAiMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-40 mt-1 flex w-44 flex-col rounded border border-line-strong bg-raised py-1 shadow-lg">
                    {aiCommands.map((item, index) => (
                      <button
                        key={`${item.name}-${item.command}-${index}`}
                        type="button"
                        onClick={() => {
                          setAiMenuOpen(false);
                          runAiCommand(item.command);
                        }}
                        title={item.name || "未命名 AI CLI"}
                        className="truncate px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
                      >
                        {item.name || "未命名 AI CLI"}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => runAiCommand(aiCommands[0]?.command ?? "")}
              disabled={aiCommands.length === 0}
              title={
                aiCommands.length === 0
                  ? "还没配置 AI CLI 命令，去设置里加一个"
                  : `在当前终端中启动 ${aiCommands[0].name || "未命名 AI CLI"}`
              }
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <IconBot className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="relative min-h-0 flex-1">
          {sessions.map((id) => (
            <TerminalSession
              key={id}
              ref={attachHandle(id)}
              cwd={cwd}
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
