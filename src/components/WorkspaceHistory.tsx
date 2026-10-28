import { useEffect, useRef, useState } from "react";
import { formatTime } from "../lib/agent";
import {
  listWorkspaceHistory,
  readSessionTitles,
  saveSessionTitle,
  sessionTitleKey,
  type CliHistoryEntry,
} from "../lib/cli-sessions";
import type { AiCommand } from "../lib/settings";
import { AgentLogo, IconPencil } from "./icons";

interface WorkspaceHistoryProps {
  /** 这个工作区的全部根。每个根单独查，最后按时间合并 */
  roots: string[];
  /** settings.aiCommands 过滤后的列表，用来定 resume 走哪条命令 */
  commands: AiCommand[];
  /** 点一条对话：参数是拼好的 resume 命令和标题（作新终端标签的标题） */
  onResume: (command: string, title: string) => void;
}

/** 自动刷新间隔。记录由 CLI 自己写盘，界面不知道它什么时候变 */
const POLL_MS = 20000;

const HINT = "px-2 py-1 text-[11px] text-fg-faint";

/** 行内改名按钮：平时藏起来，悬停这条才出现并接受点击 */
const RENAME_ACTION =
  "pointer-events-none mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/item:pointer-events-auto group-hover/item:opacity-100";

/**
 * 工作区行下面展开的对话历史：这个工作区里各家 AI CLI 的会话，按最后活动时间
 * 合并成一条列表，显示标题、CLI 和时间，点一条就在新终端标签里 resume。
 *
 * 不放在侧栏底部单独占一块：历史天然属于某个工作区，挂在行下既能一次看几个
 * 工作区的状态，也不用为它单独管高度。
 */
export function WorkspaceHistory({ roots, commands, onResume }: WorkspaceHistoryProps) {
  /** null = 还没读到第一份结果，显示加载态 */
  const [items, setItems] = useState<CliHistoryEntry[] | null>(null);
  /** 手动 / 定时刷新用：加一就重跑下面的 effect */
  const [nonce, setNonce] = useState(0);
  /** 本次刷新是不是自动触发的；是的话不闪加载态 */
  const pollRef = useRef(false);
  /** 本地改过的名字。改名不动 CLI 的记录，只影响侧栏和 resume 出来的标签标题 */
  const [titles, setTitles] = useState(readSessionTitles);
  /** 正在改名的那条（sessionTitleKey）；null 表示没有在改 */
  const [editing, setEditing] = useState<string | null>(null);
  /** 改名输入框里的草稿 */
  const [draft, setDraft] = useState("");
  /** Esc 取消：blur 时据此决定提交还是丢弃 */
  const cancelRef = useRef(false);

  // 两个入参每次渲染都是父组件现算的新数组，按内容拍成一个字符串当依赖，
  // 否则侧栏每重渲染一次就重读一遍磁盘
  const signature = `${roots.join("\u0000")}\u0001${commands
    .map((item) => `${item.name}\u0000${item.command}`)
    .join("\u0001")}`;

  useEffect(() => {
    let cancelled = false;
    const silent = pollRef.current;
    pollRef.current = false;
    if (!silent) setItems(null);
    void listWorkspaceHistory(roots, commands).then((list) => {
      // 丢掉作废请求的迟到结果（换工作区 / 收起再展开时旧的慢请求可能后回来）
      if (!cancelled) setItems(list);
    });
    return () => {
      cancelled = true;
    };
    // signature 已经覆盖了 roots / commands 的内容
  }, [signature, nonce]);

  /**
   * 定时刷新。只在窗口可见时拉；切回窗口时立刻拉一次（用户多半刚在别处跑完 CLI）。
   * 历史是展开着的组件，收起就整个卸载，自然也就不刷了。
   */
  useEffect(() => {
    const pull = () => {
      pollRef.current = true;
      setNonce((value) => value + 1);
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") pull();
    }, POLL_MS);
    window.addEventListener("focus", pull);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", pull);
    };
  }, []);

  /** 显示名：本地改过就用改过的，没改过（或改回空）就用 CLI 自己起的标题 */
  const titleOf = (item: CliHistoryEntry) =>
    titles[sessionTitleKey(item.provider, item.id)] || item.title;

  const startRename = (item: CliHistoryEntry) => {
    setEditing(sessionTitleKey(item.provider, item.id));
    setDraft(titleOf(item));
    cancelRef.current = false;
  };

  const finishRename = (item: CliHistoryEntry) => {
    setTitles(saveSessionTitle(item.provider, item.id, draft));
    setEditing(null);
  };

  if (items === null) {
    return <p className={HINT}>正在读取对话…</p>;
  }

  if (items.length === 0) {
    return <p className={HINT}>还没有对话记录</p>;
  }

  return (
    <ul className="flex flex-col pb-1">
      {items.map((item) => {
        const key = sessionTitleKey(item.provider, item.id);
        const title = titleOf(item);
        const name = title || "未命名对话";
        // 时间抠不出来时（opencode 老版本没给 updated）只留 CLI 名，别挂个空的分隔符
        const meta = [item.label, formatTime(item.updated)].filter(Boolean).join(" · ");

        if (editing === key) {
          return (
            <li key={key}>
              <div className="flex items-start gap-2 py-1 pr-1 pl-2">
                <AgentLogo
                  name={item.label}
                  command={item.provider}
                  className="mt-[3px] h-3.5 w-3.5 shrink-0"
                />
                <input
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  // 回车 / 点别处提交，Esc 丢弃。两条路径都走 blur，只在这里落一次盘
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRef.current = true;
                      event.currentTarget.blur();
                    }
                  }}
                  onBlur={() => {
                    if (cancelRef.current) {
                      cancelRef.current = false;
                      setEditing(null);
                      return;
                    }
                    finishRename(item);
                  }}
                  placeholder="对话名称，留空恢复原名"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded border border-accent-strong bg-surface px-1.5 py-0.5 text-[12px] text-fg placeholder:text-fg-faint focus:outline-none"
                />
              </div>
            </li>
          );
        }

        return (
          <li key={key}>
            <div className="group/item flex items-start rounded-md pr-1 hover:bg-hover">
              <button
                type="button"
                onClick={() => onResume(item.resume, name)}
                title={`${name}\n${item.label} · ${item.id}`}
                className="flex min-w-0 flex-1 items-start gap-2 py-1 pl-2 text-left"
              >
                <AgentLogo
                  name={item.label}
                  command={item.provider}
                  className="mt-[3px] h-3.5 w-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] leading-4 text-fg-muted group-hover/item:text-fg">
                    {name}
                  </span>
                  <span className="block truncate text-[10px] leading-4 text-fg-faint">
                    {meta}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => startRename(item)}
                title="重命名对话"
                className={RENAME_ACTION}
              >
                <IconPencil className="h-3 w-3" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
