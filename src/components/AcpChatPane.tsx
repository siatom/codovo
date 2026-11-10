import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Dispatch, type Ref, type SetStateAction } from "react";
import {
  cancelAcpChat,
  chatFromStored,
  emptyAcpChat,
  getAcpStatus,
  loadStoredSlot,
  MAX_CHATS,
  newChatId,
  onAcpEvent,
  reduceAcpEvent,
  respondAcpPermission,
  saveStoredSlot,
  sendAcpMessage,
  setAcpMode,
  startAcpChat,
  stopAcpChat,
  type AcpBlock,
  type AcpChat,
  type AcpContentBlock,
  type AcpEnvVar,
  type AcpPlanEntry,
  type AcpStatus,
  type AcpToolCall,
  type AcpToolContent,
} from "../lib/acp";
import { resolveLanguage, useHighlightedCode, useHighlightedMarkdown } from "../lib/highlight";
import { languageOf } from "../lib/languages";
import { useMermaidBlocks } from "../lib/mermaid";
import { ScrollToBottomButton, useStickToBottom } from "./ScrollToBottom";
import {
  AgentLogo,
  IconAlert,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconSend,
  IconStop,
} from "./icons";

/** TerminalPane 顶栏认出来的一条可对话 CLI */
export interface AcpCliOption {
  key: string;
  label: string;
  command: string;
  env: AcpEnvVar[];
}

export interface AcpChatTaskTab {
  chatId: string;
  command: string;
  title: string;
  busy: boolean;
  needsPermission: boolean;
  active: boolean;
}

export interface AcpChatPaneHandle {
  createChat: (command: string) => string | null;
  selectChat: (command: string, chatId: string) => void;
  closeChat: (command: string, chatId: string) => void;
}

interface AcpChatPaneProps {
  /** 活动工作区根，也是 ACP session 的 cwd */
  root: string;
  /** 工作区全部根：除 cwd 外都作为 additionalDirectories 注入 */
  roots: string[];
  /** 当前选中的 CLI；为空时给个空状态 */
  cli: AcpCliOption | null;
  /** 同一工作区内的所有 ACP 会话，映射到工作区超级 Tab */
  onChatsChange: (chats: AcpChatTaskTab[]) => void;
  /** 超级 Tab 当前选中的 ACP 会话 */
  selectedChat: { command: string; chatId: string } | null;
  /** 当前工作区可用的 ACP CLI，用于恢复各 CLI 的存档会话 */
  agents: AcpCliOption[];
  ref?: Ref<AcpChatPaneHandle>;
}

/** 发送键和 AgentPane 同一套：实心圆钮是这一屏唯一的主操作 */
const SEND_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-app transition-opacity hover:opacity-90 disabled:opacity-30 disabled:hover:opacity-30";

const STOP_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-active text-fg hover:bg-hover";

function MarkdownText({
  text,
  streaming,
  className = "text-[14px]",
  bodyClass = "agent-text",
}: {
  text: string;
  streaming: boolean;
  /** 流式与 markdown 两条分支共用的字号：切换排版时不能跳一下 */
  className?: string;
  /** markdown 分支的排版变体：正文 agent-text，思考过程 thought-text */
  bodyClass?: string;
}) {
  // 流式期间不跑 markdown：半截 ``` 会来回跳，等这一轮结束再上排版
  const html = useHighlightedMarkdown(text, !streaming);
  const bodyRef = useRef<HTMLDivElement>(null);
  useMermaidBlocks(bodyRef, html);
  if (streaming) {
    return <div className={`${className} leading-[1.75] whitespace-pre-wrap`}>{text}</div>;
  }
  return (
    <div
      ref={bodyRef}
      className={`markdown-body ${bodyClass} ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function statusTone(status: string | undefined): string {
  switch (status) {
    case "completed":
      return "text-ok";
    case "failed":
      return "text-danger";
    case "in_progress":
      return "text-accent-strong";
    default:
      return "text-fg-faint";
  }
}

/** 工具正文 / diff 的高亮块：语言认不出、或者高亮还没算好时按纯文本渲染 */
function CodeText({
  text,
  language,
  className,
}: {
  text: string;
  language: string | null;
  className: string;
}) {
  const html = useHighlightedCode(text, language);
  if (html === null) return <pre className={className}>{text}</pre>;
  return <pre className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * 猜工具正文该按什么语言上色：执行类工具的输出按 shell，读 / 写文件的正文看
 * locations 里的路径，diff 看它自己的路径。认不出就返回 null（纯文本）。
 */
function toolContentLanguage(call: AcpToolCall, path?: string): string | null {
  if (call.kind === "execute") return "shell";
  const file = path ?? call.locations?.[0]?.path;
  return file ? resolveLanguage(languageOf(file)) : null;
}

function ToolContent({ content, call }: { content: AcpToolContent; call: AcpToolCall }) {
  if (content.type === "content") {
    const block = (content as { content?: AcpContentBlock }).content;
    if (block && block.type === "text" && typeof block.text === "string") {
      return (
        <CodeText
          text={block.text}
          language={toolContentLanguage(call)}
          className="mt-1 max-h-48 overflow-auto rounded bg-surface px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted"
        />
      );
    }
    return null;
  }
  if (content.type === "diff") {
    const diff = content as { path?: string; newText?: string };
    const text = typeof diff.newText === "string" ? diff.newText : "";
    return (
      <div className="mt-1 overflow-hidden rounded border border-line">
        <div className="border-b border-line bg-surface px-2 py-1 font-mono text-[10px] text-fg-faint">
          {diff.path ?? ""}
        </div>
        <CodeText
          text={text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text}
          language={toolContentLanguage(call, diff.path)}
          className="max-h-56 overflow-auto bg-surface px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg-muted"
        />
      </div>
    );
  }
  return null;
}

function ToolBlock({ call }: { call: AcpToolCall }) {
  const status = call.status ?? "pending";
  const title = call.title || call.name || "工具调用";
  return (
    <div className="my-2 rounded-lg border border-line bg-raised/50 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusTone(status)} bg-current`} />
        <span className="min-w-0 flex-1 truncate font-medium text-fg-muted">{title}</span>
        {call.kind && (
          <span className="shrink-0 rounded bg-active px-1.5 py-0.5 text-[10px] text-fg-faint">
            {call.kind}
          </span>
        )}
        <span className={`shrink-0 text-[10px] ${statusTone(status)}`}>{status}</span>
      </div>
      {call.locations && call.locations.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {call.locations.slice(0, 6).map((location, index) => (
            <div key={`${location.path}-${index}`} className="truncate font-mono text-[10px] text-fg-faint">
              {location.path}
              {location.line ? `:${location.line}` : ""}
            </div>
          ))}
        </div>
      )}
      {call.content?.map((content, index) => <ToolContent key={index} content={content} call={call} />)}
    </div>
  );
}

function PlanBlock({ entries }: { entries: AcpPlanEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="my-2 rounded-lg border border-line bg-raised/40 px-2.5 py-2">
      <div className="mb-1 text-[10px] font-medium tracking-wide text-fg-faint">执行计划</div>
      <div className="space-y-1">
        {entries.map((entry, index) => {
          const done = entry.status === "completed";
          const active = entry.status === "in_progress";
          return (
            <div key={index} className="flex items-start gap-1.5 text-[12px] leading-snug">
              <span
                className={`mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center rounded-full border ${
                  done
                    ? "border-ok bg-ok text-app"
                    : active
                      ? "border-accent-strong text-accent-strong"
                      : "border-line-strong text-transparent"
                }`}
              >
                {done ? <IconCheck className="h-2 w-2" /> : active ? <span className="h-1 w-1 rounded-full bg-current" /> : null}
              </span>
              <span className={`min-w-0 ${done ? "text-fg-faint line-through" : active ? "text-fg" : "text-fg-muted"}`}>
                {entry.content ?? ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 思考过程：流式时展开，思考结束后自动收起成一行摘要。
 *
 * 用户点过之后就以用户的选择为准（`open` 不为 null），没点过才跟着 streaming 走——
 * 否则每轮结束都会把用户手动展开的内容再收回去。
 */
function ThoughtBlock({ block }: { block: Extract<AcpBlock, { kind: "thought" }> }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? block.streaming;
  const text = block.text.trim();
  // 收起时留一句开头，扫一眼就知道这段在琢磨什么；顺手去掉行首的 markdown 标记
  const preview = (text.split("\n")[0] ?? "").replace(/^[#>*\-\s]+/, "").trim();
  return (
    <div className="my-2 rounded-lg bg-raised text-[12px] leading-relaxed text-fg-dim">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        title={expanded ? "收起思考过程" : "展开思考过程"}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
      >
        {expanded ? (
          <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
        ) : (
          <IconChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
        )}
        <span
          className={`shrink-0 text-[10px] font-medium ${
            block.streaming ? "text-accent-strong" : "text-fg-dim"
          }`}
        >
          {block.streaming ? "思考中…" : "思考过程"}
        </span>
        {!expanded &&
          (preview ? (
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">{preview}</span>
          ) : (
            <span className="flex-1" />
          ))}
        {!expanded && (
          <span className="shrink-0 text-[10px] tabular-nums text-fg-faint">{text.length} 字</span>
        )}
      </button>
      {expanded && (
        <div className="px-2.5 pb-2">
          <MarkdownText
            text={block.text}
            streaming={block.streaming}
            className="text-[12px]"
            bodyClass="thought-text"
          />
        </div>
      )}
    </div>
  );
}

function BlockView({ block }: { block: AcpBlock }) {
  switch (block.kind) {
    case "user": {
      // 用户粘进来的代码块也走高亮；普通指令仍按纯文本，别把换行和缩进重排掉
      const withCode = block.text.includes("```");
      return (
        <div className="my-3 flex justify-end">
          <div
            className={`max-w-[85%] rounded-2xl bg-selected px-3.5 py-2 text-[14px] leading-relaxed text-fg ${
              withCode ? "" : "whitespace-pre-wrap"
            }`}
          >
            {withCode ? (
              <MarkdownText text={block.text} streaming={Boolean(block.streaming)} />
            ) : (
              block.text
            )}
          </div>
        </div>
      );
    }
    case "assistant":
      return (
        <div className="my-3 text-fg">
          <MarkdownText text={block.text} streaming={block.streaming} />
        </div>
      );
    case "thought":
      return <ThoughtBlock block={block} />;
    case "tool":
      return <ToolBlock call={block.call} />;
    case "plan":
      return <PlanBlock entries={block.entries} />;
    case "notice":
      return (
        <div
          className={`my-2 flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed ${
            block.tone === "error" ? "bg-danger/10 text-danger" : "bg-raised text-fg-dim"
          }`}
        >
          <IconAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="whitespace-pre-wrap">{block.text}</span>
        </div>
      );
    default:
      return null;
  }
}

function PermissionCard({
  chat,
  onDecide,
}: {
  chat: AcpChat;
  onDecide: (optionId: string | null) => void;
}) {
  const permission = chat.permission;
  if (!permission) return null;
  const title = permission.toolCall.title || permission.toolCall.name || "需要你的授权";
  return (
    <div className="mb-2 rounded-xl border border-warn/40 bg-warn/5 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-fg">{title}</div>
          <div className="mt-0.5 text-[11px] text-fg-dim">
            Agent 想执行上面这个操作，确认后才继续。
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        {permission.options.map((option) => {
          const allow = option.kind.startsWith("allow");
          return (
            <button
              key={option.optionId}
              type="button"
              onClick={() => onDecide(option.optionId)}
              className={`rounded-md px-2.5 py-1 text-[11px] ${
                allow
                  ? "bg-accent text-app hover:opacity-90"
                  : "border border-line-strong text-fg-dim hover:bg-hover hover:text-fg"
              }`}
            >
              {option.name}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onDecide(null)}
          className="rounded-md px-2.5 py-1 text-[11px] text-fg-faint hover:bg-hover hover:text-danger"
        >
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * 对话面板：把一家支持 ACP 的 CLI 当子进程接进来。
 *
 * 每个 CLI 各留一份会话状态（按 provider key 归档）；具体会话由工作区超级 Tab 选择。
 * 后端会话一直活着，直到用户关闭对应的超级 Tab 或退出应用。
 */
export function AcpChatPane({ root, roots, cli, onChatsChange, selectedChat, agents, ref }: AcpChatPaneProps) {
  const [slots, setSlots] = useState<Record<string, ChatSlot>>({});
  const [storageWarning, setStorageWarning] = useState(false);
  const slotsRef = useRef(slots);
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /** 发送是异步的：React 状态还没刷新时挡住第二次回车 / 连点 */
  const sendingRef = useRef(false);
  /** 面板挂载时探后端的那次请求；发送前要等它，免得重复启动还活着的会话 */
  const attachRef = useRef<{ key: string; chatId: string; promise: Promise<AcpStatus | null> } | null>(
    null,
  );
  // 同一个工作区可以切活动根；对话按 root + 配置里的整条命令分开存，切回来还能接上
  const key = `${root}\u0000${cli?.command ?? ""}`;
  const command = cli?.command ?? "";
  const slot = slots[key];
  const chat = useMemo(() => activeChatOf(slot), [slot]);
  const blocks = useMemo(() => chat?.blocks ?? [], [chat]);
  const { ref: scrollRef, atBottom, onScroll, jumpToBottom, reset } = useStickToBottom(blocks);

  // 事件按 root + chatId 过滤：后端会广播所有工作区的事件。
  // 同一个槽位里可能开着多条对话，按 chatId 找，不要求它是当前激活的那条。
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void onAcpEvent((eventRoot, chatId, event) => {
      if (eventRoot !== root) return;
      setSlots((prev) => {
        for (const slotKey of Object.keys(prev)) {
          const current = prev[slotKey];
          const index = current.chats.findIndex((item) => item.chatId === chatId);
          if (index < 0) continue;
          const chats = [...current.chats];
          chats[index] = reduceAcpEvent(chats[index], event);
          return { ...prev, [slotKey]: { ...current, chats } };
        }
        return prev;
      });
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [root]);

  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  // 面板重新挂载（切走工作区再切回来 / 重启应用）时把上次的对话摆回来。
  // 存档里有 session id，下一条消息可以直接恢复旧会话。
  useEffect(() => {
    setSlots((prev) => {
      let next = prev;
      for (const agent of agents) {
        const slotKey = `${root}\u0000${agent.command}`;
        if (next[slotKey]) continue;
        const stored = loadStoredSlot(root, agent.command);
        if (!stored) continue;
        if (next === prev) next = { ...prev };
        const chats = stored.chats.map(chatFromStored);
        next[slotKey] = { chats, active: stored.activeId };
      }
      return next;
    });
  }, [agents, root]);

  useEffect(() => {
    const rootPrefix = `${root}\u0000`;
    const tabs = Object.entries(slots).flatMap(([slotKey, current]) => {
      if (!slotKey.startsWith(rootPrefix)) return [];
      const commandForSlot = slotKey.slice(slotKey.indexOf("\u0000") + 1);
      return current.chats.map((item) => ({
        chatId: item.chatId,
        command: commandForSlot,
        title: chatTitle(item),
        busy: item.busy,
        needsPermission: Boolean(item.permission && !item.busy),
        active: item.chatId === current.active,
      }));
    });
    onChatsChange(tabs);
  }, [onChatsChange, root, slots]);

  useEffect(() => {
    if (!selectedChat) return;
    const slotKey = `${root}\u0000${selectedChat.command}`;
    const current = slots[slotKey];
    if (!current || !current.chats.some((item) => item.chatId === selectedChat.chatId) || current.active === selectedChat.chatId) return;
    setSlots((prev) => prev[slotKey] ? { ...prev, [slotKey]: { ...prev[slotKey], active: selectedChat.chatId } } : prev);
  }, [root, selectedChat, slots]);

  // 激活的对话如果是「存档恢复出来但进程没起」，问一下后端还在不在。
  // 还在就接上去（会话不用重启），不在就等下一条消息再启动。
  useEffect(() => {
    if (!command || !chat || chat.phase !== "idle" || !chat.sessionId) return;
    const chatId = chat.chatId;
    const promise = getAcpStatus(root, chatId).then((status) => {
      if (!status.running) return null;
      patchChat(setSlots, key, chatId, (current) => ({
        ...current,
        phase: "ready",
        info: status.info,
        sessionId: status.info?.sessionId ?? current.sessionId,
        busy: status.busy,
      }));
      return status;
    });
    attachRef.current = { key, chatId, promise: promise.catch(() => null) };
  }, [chat, command, key, root]);

  // 没有对话在跑时落盘。流式期间不写：每个 chunk 都序列化一次太浪费。
  useEffect(() => {
    if (!command || !slot) return;
    if (slot.chats.some((item) => item.busy || item.phase === "starting")) return;
    setStorageWarning(!saveStoredSlot(root, command, slot.chats, slot.active));
  }, [slot, command, root]);

  // 发完清空后把 textarea 的自适应高度收回去
  useEffect(() => {
    if (draft === "" && composerRef.current) composerRef.current.style.height = "";
  }, [draft]);

  // 切 CLI / 切工作区 / 切对话时把「已上滚」复位，别把上一条对话的位置带过去
  useEffect(() => {
    reset();
  }, [key, root, slot?.active, reset]);

  const appendUser = useCallback((chatId: string, text: string) => {
    patchChat(setSlots, key, chatId, (current) => ({
      ...current,
      blocks: [
        ...current.blocks,
        {
          id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          kind: "user",
          text,
          // local：恢复历史重放时只保留这条，旧记录由 Agent 重新给
          local: true,
        },
      ],
    }));
  }, [key]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !cli || sendingRef.current) return;
    let current = activeChatOf(slotsRef.current[key]);
    if (!current) return;

    // 刚挂载时可能还在探后端；等结果，别把还活着的会话再启一个
    const attach = attachRef.current;
    if (attach?.key === key && attach.chatId === current.chatId) {
      const status = await attach.promise;
      if (status?.running) {
        current = {
          ...current,
          phase: "ready",
          info: status.info,
          sessionId: status.info?.sessionId ?? current.sessionId,
        };
      }
    }
    if (current.busy || current.phase === "starting") return;

    const chatId = current.chatId;
    sendingRef.current = true;
    setDraft("");
    appendUser(chatId, text);

    // 有 session id 就试着恢复；后端按 Agent 能力选 load / resume，都不支持就新开
    const resumeSessionId = current.sessionId;
    const needsStart = current.phase !== "ready";
    try {
      if (needsStart) {
        patchChat(setSlots, key, chatId, (latest) => ({
          ...latest,
          phase: "starting",
          busy: true,
          error: undefined,
          permission: undefined,
        }));
        const info = await startAcpChat({
          root,
          chatId,
          provider: cli.key,
          command: cli.command,
          roots,
          env: cli.env,
          resumeSessionId,
        });
        patchChat(setSlots, key, chatId, (latest) => {
          // 想恢复但这版 Agent 恢复不了：旧记录对不上新会话，清掉并说明
          const fallback = Boolean(resumeSessionId) && !info.resumed;
          const blocks = fallback
            ? [
                ...latest.blocks.filter((block) => block.kind === "user" && block.local),
                {
                  id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  kind: "notice" as const,
                  text: "没能恢复上次的会话，已经从新对话开始。",
                  tone: "info" as const,
                },
              ]
            : latest.blocks;
          return {
            ...latest,
            phase: "ready",
            info,
            sessionId: info.sessionId,
            busy: true,
            blocks,
          };
        });
      } else {
        patchChat(setSlots, key, chatId, (latest) => ({ ...latest, busy: true }));
      }
      await sendAcpMessage(root, chatId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchChat(setSlots, key, chatId, (latest) => ({
        ...latest,
        phase: "error",
        busy: false,
        error: message,
        blocks: [
          ...latest.blocks,
          {
            id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            kind: "notice",
            text: message,
            tone: "error",
          },
        ],
      }));
    } finally {
      sendingRef.current = false;
    }
  }, [appendUser, cli, draft, key, root, roots]);

  const stop = useCallback(async () => {
    const current = activeChatOf(slotsRef.current[key]);
    if (!current?.chatId) return;
    if (current.permission) {
      void respondAcpPermission(root, current.chatId, current.permission.requestId, null).catch(() => {});
    }
    await cancelAcpChat(root, current.chatId).catch(() => {});
  }, [key, root]);

  const decide = useCallback(
    async (optionId: string | null) => {
      const current = activeChatOf(slotsRef.current[key]);
      const permission = current?.permission;
      if (!current?.chatId || !permission) return;
      const chatId = current.chatId;
      patchChat(setSlots, key, chatId, (latest) =>
        latest.permission?.requestId === permission.requestId
          ? { ...latest, permission: { ...latest.permission, resolved: optionId } }
          : latest,
      );
      await respondAcpPermission(root, chatId, permission.requestId, optionId).catch(() => {});
      patchChat(setSlots, key, chatId, (latest) =>
        latest.permission?.requestId === permission.requestId
          ? { ...latest, permission: undefined }
          : latest,
      );
    },
    [key, root],
  );

  const selectChat = useCallback((chatCommand: string, chatId: string) => {
    const slotKey = `${root}\u0000${chatCommand}`;
    setSlots((prev) => {
      const current = prev[slotKey];
      if (!current || current.active === chatId || !current.chats.some((item) => item.chatId === chatId)) return prev;
      return { ...prev, [slotKey]: { ...current, active: chatId } };
    });
    setDraft("");
  }, [root]);

  const createChat = useCallback((chatCommand: string): string | null => {
    const slotKey = `${root}\u0000${chatCommand}`;
    const current = slotsRef.current[slotKey];
    let base = current;
    if (!base) {
      const stored = loadStoredSlot(root, chatCommand);
      const chats = stored?.chats.map(chatFromStored) ?? [];
      base = { chats, active: stored?.activeId ?? "" };
    }
    if (base.chats.length >= MAX_CHATS) return null;
    const active = activeChatOf(base);
    if (active && !active.sessionId && active.blocks.length === 0) return active.chatId;
    const fresh = emptyAcpChat(newChatId("acp"));
    const nextSlot: ChatSlot = { chats: [...base.chats, fresh], active: fresh.chatId };
    const next = { ...slotsRef.current, [slotKey]: nextSlot };
    slotsRef.current = next;
    setSlots(next);
    setDraft("");
    return fresh.chatId;
  }, [root]);

  const closeChat = useCallback(async (chatCommand: string, chatId: string) => {
    const slotKey = `${root}\u0000${chatCommand}`;
    const currentSlot = slotsRef.current[slotKey];
    const current = currentSlot?.chats.find((item) => item.chatId === chatId);
    if (!currentSlot || !current) return;
    if (current.sessionId) await stopAcpChat(root, current.chatId).catch(() => {});
    const chats = currentSlot.chats.filter((item) => item.chatId !== chatId);
    if (chats.length === 0) {
      const next = { ...slotsRef.current };
      delete next[slotKey];
      slotsRef.current = next;
      setSlots(next);
      setStorageWarning(!saveStoredSlot(root, chatCommand, [], ""));
    } else {
      const active = currentSlot.active === chatId ? chats[0].chatId : currentSlot.active;
      const next = { ...slotsRef.current, [slotKey]: { ...currentSlot, chats, active } };
      slotsRef.current = next;
      setSlots(next);
      setStorageWarning(!saveStoredSlot(root, chatCommand, chats, active));
    }
    if (key === slotKey && currentSlot.active === chatId) setDraft("");
  }, [key, root]);

  useImperativeHandle(ref, () => ({
    createChat,
    selectChat,
    closeChat: (chatCommand, chatId) => { void closeChat(chatCommand, chatId); },
  }), [closeChat, createChat, selectChat]);

  /** 切换模式：先乐观更新，Agent 的 current_mode_update 再对齐一次；失败回滚 */
  const changeMode = useCallback(
    async (modeId: string) => {
      const current = activeChatOf(slotsRef.current[key]);
      if (!current?.chatId) return;
      const before = current.mode;
      const chatId = current.chatId;
      patchChat(setSlots, key, chatId, (item) => ({ ...item, mode: modeId }));
      try {
        await setAcpMode(root, chatId, modeId);
      } catch {
        patchChat(setSlots, key, chatId, (item) => ({ ...item, mode: before }));
      }
    },
    [key, root],
  );

  if (!cli) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface px-8 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-raised text-fg-dim">
          <IconBot className="h-5 w-5" />
        </span>
        <div className="text-[13px] font-medium text-fg-muted">还没有可对话的 CLI</div>
        <div className="max-w-[360px] text-[12px] leading-relaxed text-fg-faint">
          当前配置里没有接入 ACP 的 CLI。opencode、CodeBuddy、Gemini CLI、GitHub Copilot、
          Codex、Claude Code 可以在对话里用；其余 CLI 继续在终端里跑。
        </div>
      </div>
    );
  }

  const phase = chat?.phase ?? "idle";
  const busy = chat?.busy ?? false;
  const started = phase === "ready" || phase === "closed" || phase === "error";
  /** 有旧记录但进程还没起：下一条消息会先恢复会话 */
  const restored = !started && !busy && blocks.length > 0;
  const placeholder = busy
    ? "Agent 正在处理，可以点停止"
    : started
      ? `继续和 ${cli.label} 对话，Enter 发送，Shift+Enter 换行`
      : restored
        ? `继续和 ${cli.label} 对话（会恢复上次会话），Enter 发送`
        : `用 ${cli.label} 开始，Enter 发送，Shift+Enter 换行`;

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2.5">
        <AgentLogo name={cli.label} command={cli.command} className="h-4 w-4" />
        <span className="truncate text-[12px] font-medium text-fg">{cli.label}</span>
        {chat?.info?.agentName && (
          <span className="truncate text-[11px] text-fg-faint">
            {chat.info.agentName}
            {chat.info.agentVersion ? ` ${chat.info.agentVersion}` : ""}
          </span>
        )}
        {chat?.info?.resumed && (
          <span className="shrink-0 rounded bg-active px-1.5 py-0.5 text-[10px] text-fg-dim">已恢复</span>
        )}
        {chat?.info?.modes && chat.info.modes.length > 0 ? (
          /* 模式由 Agent 声明（Claude Code 有 default / acceptEdits / plan）。
             选 default 时工具调用会发权限请求，acceptEdits 之类会自动放行。 */
          <select
            value={chat.mode ?? chat.info.currentModeId ?? ""}
            onChange={(event) => void changeMode(event.target.value)}
            disabled={phase !== "ready"}
            title={
              chat.info.modes.find((mode) => mode.id === chat.mode)?.description ?? "会话模式"
            }
            className="shrink-0 cursor-pointer rounded bg-active px-1.5 py-0.5 text-[10px] text-fg-dim outline-none disabled:cursor-default disabled:opacity-50"
          >
            {chat.info.modes.map((mode) => (
              <option key={mode.id} value={mode.id} title={mode.description}>
                {mode.name}
              </option>
            ))}
          </select>
        ) : chat?.mode ? (
          <span className="shrink-0 rounded bg-active px-1.5 py-0.5 text-[10px] text-fg-dim">
            {chat.mode}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {chat?.usage?.size ? (
          <span className="shrink-0 text-[10px] text-fg-faint tabular-nums">
            {chat.usage.used ?? 0}/{chat.usage.size}
          </span>
        ) : null}
        {busy && <span className="shrink-0 animate-pulse text-[10px] text-warn">进行中</span>}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
        >
          {blocks.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-raised text-fg-dim">
                <IconBot className="h-5 w-5" />
              </span>
              <div className="text-[13px] font-medium text-fg-muted">和 {cli.label} 对话</div>
              <div className="max-w-[320px] text-[12px] leading-relaxed text-fg-faint">
                GUI 对话和终端里的 {cli.label} 是同一个 CLI，只是多一条界面通道。
                工作区目录会作为会话根注入，工具操作仍由 CLI 自己执行。
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[800px]">
              {blocks.map((block) => <BlockView key={block.id} block={block} />)}
            </div>
          )}
          {phase === "starting" && (
            <div className="mx-auto my-3 w-full max-w-[800px] animate-pulse text-[12px] text-fg-faint">正在启动 {cli.label}…</div>
          )}
        </div>
        {!atBottom && <ScrollToBottomButton onClick={jumpToBottom} />}
      </div>

      <div className="shrink-0 px-5 pt-2 pb-4">
        <div className="mx-auto w-full max-w-[800px]">
          {storageWarning && (
            <div role="status" className="mb-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
              存储空间不足，当前对话无法跨重启恢复；对话仍可继续。
            </div>
          )}
          {chat?.permission && <PermissionCard chat={chat} onDecide={(id) => void decide(id)} />}
          <div className="rounded-2xl border border-line bg-app px-3 pt-3 pb-2 shadow-sm transition-colors focus-within:border-line-hover">
            <div className="flex items-end gap-2">
              <textarea
                ref={composerRef}
                value={draft}
                rows={1}
                onChange={(event) => setDraft(event.target.value)}
                onInput={(event) => {
                  const element = event.currentTarget;
                  element.style.height = "auto";
                  element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  // 输入法组字时的回车是选词，不该发出去
                  if (event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void send();
                }}
                placeholder={placeholder}
                className="max-h-40 min-h-[30px] w-full resize-none bg-transparent px-1 py-1.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-faint"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => void stop()}
                  disabled={phase === "starting"}
                  title={phase === "starting" ? "正在启动，稍等一下" : "停止这一轮"}
                  className={`${STOP_BUTTON} disabled:opacity-40`}
                >
                  <IconStop className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!draft.trim() || phase === "starting"}
                  title="发送"
                  className={SEND_BUTTON}
                >
                  <IconSend className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="mt-1 px-1 text-[10px] text-fg-faint">Enter 发送 · Shift+Enter 换行</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 一个「工作区 + 命令」槽位：可以并行开着几条对话，active 是当前展示的那条 */
interface ChatSlot {
  chats: AcpChat[];
  active: string;
}

function activeChatOf(slot: ChatSlot | undefined): AcpChat | undefined {
  return slot?.chats.find((chat) => chat.chatId === slot.active);
}

/** 标签页标题：取第一条用户消息，没有就用「新对话」 */
function chatTitle(chat: AcpChat): string {
  const generatedTitle = chat.title?.trim();
  if (generatedTitle) return generatedTitle;
  const first = chat.blocks.find((block) => block.kind === "user" && block.text.trim() !== "");
  const text = first && first.kind === "user" ? first.text.trim().replace(/\s+/g, " ") : "";
  if (!text) return "新对话";
  return text.length > 18 ? `${text.slice(0, 18)}…` : text;
}

/** 给槽位里指定 chatId 打补丁；对话已经被移除时原样返回 */
function patchChat(
  setSlots: Dispatch<SetStateAction<Record<string, ChatSlot>>>,
  key: string,
  chatId: string,
  patch: (chat: AcpChat) => AcpChat,
) {
  setSlots((prev) => {
    const slot = prev[key];
    if (!slot) return prev;
    const index = slot.chats.findIndex((chat) => chat.chatId === chatId);
    if (index < 0) return prev;
    const chats = [...slot.chats];
    chats[index] = patch(chats[index]);
    return { ...prev, [key]: { ...slot, chats } };
  });
}
