import { useCallback, useRef, useState } from "react";
import {
  TerminalSession,
  type TerminalSessionHandle,
} from "./TerminalSession";
import { toDisplayPath } from "../lib/fs";
import { useSettings } from "../lib/settings";
import { IconPanelRight, IconPanelRightOpen } from "./icons";

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
 */
export function TerminalPane({ cwd, rightOpen, onToggleRight }: TerminalPaneProps) {
  const [sessions, setSessions] = useState<number[]>([0]);
  const [activeId, setActiveId] = useState(0);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
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

  // 空行是用户在设置里加了还没填的，不进下拉
  const aiCommands = settings.aiCommands.map((item) => item.trim()).filter(Boolean);

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {sessions.map((id, index) => {
            const isActive = id === activeId;
            return (
              <div
                key={id}
                className={`flex shrink-0 items-center rounded ${
                  isActive
                    ? "bg-active text-fg"
                    : "text-fg-dim hover:bg-hover"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveId(id)}
                  title={cwd ? toDisplayPath(cwd) : ""}
                  className="max-w-[140px] truncate py-0.5 pl-2 text-[11px]"
                >
                  终端 {index + 1}
                </button>
                <button
                  type="button"
                  onClick={() => closeSession(id)}
                  title="关闭这个终端"
                  className="px-1.5 py-0.5 text-[12px] leading-none text-fg-faint hover:text-danger"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addSession}
            title="新建终端"
            className="shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-none text-fg-dim hover:bg-active hover:text-fg"
          >
            +
          </button>
        </div>
        <span
          className="hidden max-w-[200px] min-w-0 truncate text-[11px] text-fg-faint lg:block"
          title={cwd ? toDisplayPath(cwd) : ""}
        >
          {cwd ? toDisplayPath(cwd) : "未选择工作目录"}
        </span>
        {aiCommands.length > 1 ? (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setAiMenuOpen((open) => !open)}
              title="在当前终端中启动 AI CLI（可下拉选择命令）"
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] hover:bg-active hover:text-fg ${
                aiMenuOpen ? "bg-active text-fg" : "text-fg-dim"
              }`}
            >
              AI CLI
              <span className="text-[8px] leading-none">▼</span>
            </button>
            {aiMenuOpen && (
              <>
                {/* 铺一层透明遮罩接住外部点击 */}
                <div className="fixed inset-0 z-30" onClick={() => setAiMenuOpen(false)} />
                <div className="absolute right-0 top-full z-40 mt-1 flex w-44 flex-col rounded border border-line-strong bg-raised py-1 shadow-lg">
                  {aiCommands.map((command) => (
                    <button
                      key={command}
                      type="button"
                      onClick={() => {
                        setAiMenuOpen(false);
                        runAiCommand(command);
                      }}
                      title={command}
                      className="truncate px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
                    >
                      {command}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => runAiCommand(aiCommands[0] ?? "")}
            disabled={aiCommands.length === 0}
            title={
              aiCommands.length === 0
                ? "还没配置 AI CLI 命令，去设置里加一个"
                : `在当前终端中启动 AI CLI（${aiCommands[0]}）`
            }
            className="shrink-0 rounded px-2 py-0.5 text-[11px] text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
          >
            AI CLI
          </button>
        )}
        <button
          type="button"
          onClick={() => handlesRef.current.get(activeId)?.clear()}
          className="shrink-0 rounded px-2 py-0.5 text-[11px] text-fg-dim hover:bg-active hover:text-fg"
        >
          清屏
        </button>
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

      <div className="relative min-h-0 flex-1">
        {sessions.map((id) => (
          <TerminalSession
            key={id}
            ref={attachHandle(id)}
            cwd={cwd}
            active={id === activeId}
          />
        ))}
      </div>
    </section>
  );
}
