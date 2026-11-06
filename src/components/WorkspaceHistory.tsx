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
import { AgentLogo, IconMore, IconPencil, IconPlay } from "./icons";

interface WorkspaceHistoryProps {
  /** 这个工作区的全部根。每个根单独查，最后按时间合并 */
  roots: string[];
  /** settings.aiCommands 过滤后的列表，用来定 resume 走哪条命令 */
  commands: AiCommand[];
  /** 切换工作区时重置分页，重新回来仍从最近十条看起 */
  active: boolean;
  /** 点一条对话：参数是拼好的 resume 命令和标题（作新终端标签的标题） */
  onResume: (command: string, title: string) => void;
}

/** 自动刷新间隔。记录由 CLI 自己写盘，界面不知道它什么时候变 */
const POLL_MS = 20000;
const HISTORY_PAGE = 10;

const HINT = "px-2 py-1 text-[11px] text-fg-faint";

/** 行尾的「⋯」：平时藏起来，悬停这条才出现并接受点击 */
const MENU_ACTION =
  "pointer-events-none mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/item:pointer-events-auto group-hover/item:opacity-100";

/** 会话菜单的宽度（px） */
const MENU_W = 144;

/**
 * 工作区行下面展开的对话历史：这个工作区里各家 AI CLI 的会话，按最后活动时间
 * 合并成一条列表，显示标题、CLI 和时间，通过行尾菜单恢复对话或重命名。
 *
 * 不放在侧栏底部单独占一块：历史天然属于某个工作区，挂在行下既能一次看几个
 * 工作区的状态，也不用为它单独管高度。
 */
export function WorkspaceHistory({ roots, commands, active, onResume }: WorkspaceHistoryProps) {
  /** null = 还没读到第一份结果，显示加载态 */
  const [items, setItems] = useState<CliHistoryEntry[] | null>(null);
  const [limit, setLimit] = useState(HISTORY_PAGE);
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
  /** 「⋯」菜单开在哪一条上，以及贴着按钮的位置（fixed 定位） */
  const [menu, setMenu] = useState<{ item: CliHistoryEntry; x: number; y: number } | null>(null);

  // 两个入参每次渲染都是父组件现算的新数组，按内容拍成一个字符串当依赖，
  // 否则侧栏每重渲染一次就重读一遍磁盘
  const signature = `${roots.join("\u0000")}\u0001${commands
    .map((item) => `${item.name}\u0000${item.command}`)
    .join("\u0001")}`;

  useEffect(() => {
    setLimit(HISTORY_PAGE);
    // 分页重置后，原先打开菜单或改名的记录可能已不在可见范围内。
    setMenu(null);
    setEditing(null);
  }, [signature, active]);

  useEffect(() => {
    let cancelled = false;
    const silent = pollRef.current;
    pollRef.current = false;
    if (!silent) setItems(null);
    void listWorkspaceHistory(roots, commands, (partial) => {
      // 谁先回来先画谁：等 opencode 那种要起子进程的一家，整块列表会被拖住
      if (!cancelled && partial.length > 0) setItems(partial);
    }).then((list) => {
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

  const openMenu = (item: CliHistoryEntry, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setMenu({ item, x: rect.right, y: rect.bottom });
  };

  if (items === null) {
    return <p className={HINT}>正在读取对话…</p>;
  }

  if (items.length === 0) {
    return <p className={HINT}>还没有对话记录</p>;
  }

  return (
    <>
      <ul className="flex flex-col pb-1">
        {items.slice(0, limit).map((item) => {
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
                <div
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
                </div>
                <button
                  type="button"
                  onClick={(event) => openMenu(item, event.currentTarget)}
                  title="更多操作"
                  className={`${MENU_ACTION} ${
                    // 菜单开着的时候鼠标已经离开这一行了，按钮得自己亮着
                    menu && sessionTitleKey(menu.item.provider, menu.item.id) === key
                      ? "pointer-events-auto opacity-100"
                      : ""
                  }`}
                >
                  <IconMore className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          );
        })}
        {items.length > limit && (
          <li>
            <button
              type="button"
              onClick={() => setLimit((value) => value + HISTORY_PAGE)}
              className={`${HINT} w-full rounded text-left hover:bg-hover hover:text-fg`}
            >
              加载更多（还有 {items.length - limit} 条）
            </button>
          </li>
        )}
      </ul>

      {/* 「⋯」菜单：fixed 定位，免得被侧栏的滚动容器裁掉。以后加别的会话操作直接往这里添 */}
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: MENU_W,
              // 菜单贴按钮右缘展开，再夹住视口，免得贴近窗口边缘时跑出去
              left: Math.max(4, menu.x - MENU_W),
              top: Math.min(menu.y + 4, window.innerHeight - 76),
            }}
          >
            <button
              type="button"
              onClick={() => {
                const { item } = menu;
                setMenu(null);
                onResume(item.resume, titleOf(item) || "未命名对话");
              }}
              className="flex items-center gap-2 px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              <IconPlay className="h-3.5 w-3.5 shrink-0" />
              恢复对话
            </button>
            <button
              type="button"
              onClick={() => {
                const { item } = menu;
                setMenu(null);
                startRename(item);
              }}
              className="flex items-center gap-2 px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              <IconPencil className="h-3.5 w-3.5 shrink-0" />
              重命名
            </button>
          </div>
        </>
      )}
    </>
  );
}
