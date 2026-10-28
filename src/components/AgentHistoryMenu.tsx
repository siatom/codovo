import { useState } from "react";
import { formatTime } from "../lib/agent";
import type { AttentionKind } from "../lib/attention";
import type { AgentSessionSummary } from "../lib/types";
import { IconHistory, IconMore, IconPlus } from "./icons";

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg";

const MENU_ITEM =
  "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/**
 * 对话面板标题栏里的「历史对话」入口：一个图标按钮 + 下拉面板（新建 / 会话列表 /
 * 就地改名 / 行内「⋯」菜单）。
 *
 * 终端区智能体和数据库智能体共用一套界面，数据的读写交给调用方——两边的会话分属
 * 不同后端槽位，只是长得一样。
 */
export function AgentHistoryMenu({
  sessions,
  currentId,
  onOpen,
  onNew,
  onRename,
  onDelete,
  waitingKinds,
}: {
  sessions: AgentSessionSummary[];
  /** 当前打开的是哪条，用来高亮 */
  currentId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** 改名：裁过空白、非空才会调 */
  onRename: (id: string, title: string) => void;
  /** 删除：确认框由调用方弹（两个面板各有各的 ConfirmDialog） */
  onDelete: (session: AgentSessionSummary) => void;
  /** 有待用户处理的会话 id -> 原因（在行上点一颗脉冲点，文案按原因出） */
  waitingKinds?: ReadonlyMap<string, AttentionKind>;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [itemMenu, setItemMenu] = useState<{
    session: AgentSessionSummary;
    x: number;
    y: number;
  } | null>(null);

  /** 就地改名收尾：Enter / 点别处都走这儿；空标题当取消 */
  const commitRename = () => {
    const pending = renaming;
    if (!pending) return;
    setRenaming(null);
    const title = pending.value.trim();
    if (title) onRename(pending.id, title);
  };

  const closeAll = () => {
    setOpen(false);
    setItemMenu(null);
  };

  return (
    // 相对定位挂在按钮自己身上：两个面板里这个按钮离右端距离不一样，
    // 挂在工具条上的话下拉会跟着工具条对齐、跑到别的按钮底下
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        title="历史对话"
        className={HEAD_BUTTON}
      >
        <IconHistory className="h-3.5 w-3.5" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={closeAll} />
          <div className="absolute top-full right-0 z-40 mt-1 flex max-h-80 w-64 flex-col overflow-auto rounded-lg border border-line-strong bg-raised p-1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                closeAll();
                onNew();
              }}
              className={MENU_ITEM}
            >
              <IconPlus className="h-3.5 w-3.5" />
              新建对话
            </button>
            <div className="my-1 h-px shrink-0 bg-line" />
            {sessions.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-fg-faint">还没有历史对话</p>
            ) : (
              <ul className="flex flex-col">
                {sessions.map((item) => {
                  const isActive = item.id === currentId;
                  const kind = waitingKinds?.get(item.id);
                  // 只有 done 是「已完成」；permission / question / prompt 都是在等回应
                  const attentionHint =
                    kind === "done"
                      ? "任务完成，等待你的下一步指令"
                      : kind
                        ? "正在等你输入"
                        : null;
                  return (
                    <li
                      key={item.id}
                      className={`group/hist flex items-center rounded-md ${
                        isActive ? "bg-active" : "hover:bg-hover"
                      }`}
                    >
                      {renaming?.id === item.id ? (
                        /* 就地改名：Enter 确认、Esc 取消、点别处也算确认 */
                        <input
                          autoFocus
                          value={renaming.value}
                          onChange={(event) =>
                            setRenaming({ id: item.id, value: event.target.value })
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitRename();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setRenaming(null);
                            }
                          }}
                          onBlur={commitRename}
                          className="my-0.5 mr-1 min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-line-hover"
                        />
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              closeAll();
                              onOpen(item.id);
                            }}
                            title={attentionHint ? `${item.title}（${attentionHint}）` : item.title}
                            className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1 pl-2 text-left text-[12px] ${
                              isActive ? "text-fg" : "text-fg-muted group-hover/hist:text-fg"
                            }`}
                          >
                            {attentionHint && (
                              <span
                                title={attentionHint}
                                className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn animate-pulse"
                              />
                            )}
                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                            {/* 时间只在没悬停时露脸：悬停后右侧让给「⋯」 */}
                            <span className="shrink-0 text-[11px] text-fg-faint group-hover/hist:hidden">
                              {formatTime(item.updated)}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              const rect = event.currentTarget.getBoundingClientRect();
                              setItemMenu({
                                session: item,
                                x: rect.right,
                                y: rect.bottom + 4,
                              });
                            }}
                            title="更多操作"
                            className="pointer-events-none mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/hist:pointer-events-auto group-hover/hist:opacity-100"
                          >
                            <IconMore className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {/* 会话行「⋯」的小菜单。用 fixed 定位：浮层是滚动容器，绝对定位会被裁 */}
      {itemMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setItemMenu(null)} />
          <div
            className="fixed z-40 w-32 rounded-lg border border-line-strong bg-raised p-1 shadow-lg"
            style={{ left: Math.max(8, itemMenu.x - 128), top: itemMenu.y }}
          >
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                setRenaming({ id: itemMenu.session.id, value: itemMenu.session.title });
                setItemMenu(null);
              }}
            >
              重命名
            </button>
            <button
              type="button"
              className={`${MENU_ITEM} text-danger hover:text-danger`}
              onClick={() => {
                onDelete(itemMenu.session);
                setItemMenu(null);
              }}
            >
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}
