import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../lib/settings";
import { useEffectiveAiConfig } from "../lib/ai";
import { enabledModels, enabledProviders, resolveDefaultModel } from "../lib/providers";
import {
  EMPTY_CONVERSATION,
  abortAgentSession,
  conversationFromHistory,
  createAgentSession,
  deleteAgentSession,
  fetchAgentMessages,
  listAgentSessions,
  onAgentEvent,
  onAgentExit,
  parseSessions,
  reduceAgentEvent,
  renameAgentSession,
  sendAgentMessage,
  startAgent,
} from "../lib/agent";
import type { DbConnection } from "../lib/database";
import {
  DB_AGENT_ROOT,
  dbAgentSetTarget,
  readDbAgentSession,
  writeDbAgentSession,
} from "../lib/db-agent";
import type { AgentConversation, AgentSessionSummary } from "../lib/types";
import { AgentHistoryMenu } from "./AgentHistoryMenu";
import { AgentMessageView } from "./AgentMessageView";
import { ConfirmDialog } from "./ConfirmDialog";
import { ScrollToBottomButton, useStickToBottom } from "./ScrollToBottom";
import { IconBot, IconPlus, IconSend, IconStop } from "./icons";

type Phase = "idle" | "starting" | "ready" | "error";

/** 发送键：和终端区智能体那边同一套样式，两个面板看起来是一套东西 */
const SEND_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-app transition-opacity hover:opacity-90 disabled:opacity-30 disabled:hover:opacity-30";

const STOP_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-active text-fg hover:bg-hover";

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg";

/**
 * 数据库模块的「Agent」子视图：自然语言 → 只读 SQL。
 *
 * 后端是一个**独立的** opencode 进程（哨兵 root，见 src-tauri/src/agent.rs）：它带一组
 * 只读数据库 MCP 工具和一份内置技能，目标库从 `db_agent_set_target` 写下的 target.json 读。
 *
 * 对话历史**所有连接共用一份**：对话本身不绑定库，执行 SQL 时才用当前目标连接，
 * 所以切连接不换会话。会话列表靠 `AgentInfo.cwd` 过滤（opencode 的会话是全局存的）。
 */
export function DatabaseAgent({
  connection,
  active,
}: {
  /** 当前选中的连接；null 表示还没选 */
  connection: DbConnection | null;
  /** 这个子视图是不是正被展示（第一次为真时才去拉服务） */
  active: boolean;
}) {
  const { settings } = useSettings();
  const { agentCommand, agentPort } = settings;
  const { config: aiConfig, ready: aiReady } = useEffectiveAiConfig();

  const [phase, setPhase] = useState<Phase>("idle");
  const [fatal, setFatal] = useState<string | null>(null);
  const [conversation, setConversation] = useState<AgentConversation>(EMPTY_CONVERSATION);
  const [draft, setDraft] = useState("");
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [currentId, setCurrentIdState] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentSessionSummary | null>(null);

  const startedRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 对话流贴底跟随（上滚暂停、回到底部恢复），和终端区智能体共用同一套逻辑
  const {
    ref: scrollRef,
    atBottom,
    onScroll,
    jumpToBottom,
    reset: resetScroll,
  } = useStickToBottom(conversation);
  /** SSE 处理器只订阅一次，读 state 会拿到挂载那刻的旧值，所以会话 id 走 ref */
  const sessionIdRef = useRef<string | null>(null);
  /** 这个实例的工作目录，列表按它过滤；startAgent 之后才有值 */
  const cwdRef = useRef("");
  /** 记上一帧的流式状态，好在这一轮结束时刷新列表（标题是 opencode 自动总结的） */
  const wasStreamingRef = useRef(false);

  /** 喂给 opencode 的提供商，和终端区智能体共用「设置 → 智能体」那一份 */
  const providers = useMemo(
    () =>
      enabledProviders(settings).map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl.trim(),
        hasKey: provider.apiKeySet,
        models: enabledModels(provider).map((model) => model.id),
      })),
    [settings],
  );

  // 开发调试版可能只在 src-tauri/.env 里配了模型，后端会合成一个 id 为 codovo 的提供商
  const fallbackRef = aiConfig.model ? `codovo/${aiConfig.model}` : "";
  const modelRef = resolveDefaultModel(settings)?.ref ?? fallbackRef;

  const setCurrentId = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setCurrentIdState(id);
  }, []);

  /** 拉一次该实例的历史会话。失败不抛，保持上一次的样子 */
  const refreshSessions = useCallback(async (): Promise<AgentSessionSummary[]> => {
    const cwd = cwdRef.current;
    if (!cwd) return [];
    try {
      const list = parseSessions(await listAgentSessions(DB_AGENT_ROOT), cwd);
      setSessions(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  /** 打开某个会话：拉历史灌进来并记成当前会话 */
  const openSession = useCallback(
    async (id: string) => {
      try {
        const history = await fetchAgentMessages(DB_AGENT_ROOT, id);
        setCurrentId(id);
        writeDbAgentSession(id);
        setConversation(conversationFromHistory(history));
        // 换了一段对话，跟随状态一起复位，别带着上一条的「已上滚」
        resetScroll();
      } catch (reason) {
        setConversation((current) => ({ ...current, error: String(reason) }));
      }
    },
    [setCurrentId, resetScroll],
  );

  /** 拉服务 + 注入只读数据库工具。配置变化不重启，第一次切到本视图时跑一次即可 */
  const boot = useCallback(async () => {
    if (!aiReady) {
      setFatal(
        "请先在「设置 → 智能体 → 模型提供商」里加一个提供商，并把它下面的模型设为默认",
      );
      setPhase("error");
      return;
    }
    setPhase("starting");
    setFatal(null);
    try {
      const info = await startAgent(DB_AGENT_ROOT, {
        command: agentCommand,
        port: agentPort,
        providers,
        defaultModel: modelRef,
        rules: "",
        memory: "",
        skills: [],
        agents: [],
        primary: "",
        database: true,
      });
      cwdRef.current = info.cwd;
    } catch (reason) {
      setFatal(String(reason));
      setPhase("error");
      return;
    }

    // 列表才是真相：本地存的那个 id 可能已经被删了。先问列表——本地那条还在就接着它，
    // 否则退一步接最近的一条；一条都没有就停在空态，等第一句再建
    const list = await refreshSessions();
    const saved = readDbAgentSession();
    const target = list.find((item) => item.id === saved) ?? list[0];
    if (target) {
      await openSession(target.id);
    } else {
      setCurrentId(null);
      setConversation(EMPTY_CONVERSATION);
    }
    setPhase("ready");
  }, [
    aiReady,
    agentCommand,
    agentPort,
    providers,
    modelRef,
    refreshSessions,
    openSession,
    setCurrentId,
  ]);

  // 没选连接就不用起服务；真的切到本视图且有连接时拉一次
  useEffect(() => {
    if (!active || !connection || startedRef.current) return;
    startedRef.current = true;
    void boot();
  }, [active, connection, boot]);

  // 事件流只订阅一次；后端是全量转发的，只认自己这条哨兵 root
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void onAgentEvent((root, event) => {
      if (root !== DB_AGENT_ROOT) return;
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      setConversation((current) => reduceAgentEvent(current, event, sessionId));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void onAgentExit((root) => {
      if (root !== DB_AGENT_ROOT) return;
      setFatal("智能体服务已退出，可能是被系统回收或端口被占");
      setPhase("error");
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 切连接：只把目标同步给后端，对话和历史都不动（历史是所有连接共用的）
  useEffect(() => {
    void dbAgentSetTarget(connection).catch(() => {});
  }, [connection?.id]);

  // 这一轮跑完（opencode 会自动总结会话标题）就刷一次列表，让标题及时更新
  useEffect(() => {
    if (wasStreamingRef.current && !conversation.streaming) void refreshSessions();
    wasStreamingRef.current = conversation.streaming;
  }, [conversation.streaming, refreshSessions]);

  // 新内容进来就贴到底部（由 useStickToBottom 统一处理：上滚后暂停、回底恢复）

  // 输入框跟着内容长高，超过上限就内部滚动
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
  }, [draft]);

  /** 新对话：只把面板清成「等第一句」，会话等发送时再建，免得留下一串空记录 */
  const newSession = useCallback(() => {
    setCurrentId(null);
    setConversation(EMPTY_CONVERSATION);
    resetScroll();
  }, [setCurrentId, resetScroll]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || conversation.streaming || !connection) return;
    setDraft("");
    // 用户消息不本地插，等 SSE 的 message.updated 回来，省得和真实消息对不上
    setConversation((current) => ({ ...current, streaming: true, error: null }));

    let sessionId = sessionIdRef.current;
    if (!sessionId) {
      try {
        // 标题留给 opencode 按首句自动总结：传连接名的话每条历史都同名，分不出来
        const session = await createAgentSession(DB_AGENT_ROOT);
        sessionId = session.id;
        setCurrentId(sessionId);
        writeDbAgentSession(sessionId);
        void refreshSessions();
      } catch (reason) {
        setConversation((current) => ({
          ...current,
          streaming: false,
          error: String(reason),
        }));
        return;
      }
    }

    // primary agent 由后端在 database 模式下强制成内置的 database，这里不传
    void sendAgentMessage(DB_AGENT_ROOT, sessionId, text, modelRef).catch((reason) => {
      setConversation((current) => ({
        ...current,
        streaming: false,
        error: String(reason),
      }));
    });
  }, [draft, conversation.streaming, connection, modelRef, setCurrentId, refreshSessions]);

  const stop = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    void abortAgentSession(DB_AGENT_ROOT, sessionId).catch(() => {
      // 停不下来也无所谓：这一轮跑完自然会给 session.idle
    });
  }, []);

  /** 删一条历史：删的正好是当前这条就退到最近的一条，一条不剩就回空态 */
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await deleteAgentSession(DB_AGENT_ROOT, id);
      } catch (reason) {
        setConversation((current) => ({ ...current, error: String(reason) }));
        return;
      }
      const list = await refreshSessions();
      if (id !== sessionIdRef.current) return;
      if (list[0]) {
        setConversation(EMPTY_CONVERSATION);
        void openSession(list[0].id);
      } else {
        newSession();
      }
    },
    [refreshSessions, openSession, newSession],
  );

  /** 就地改名：裁剪与判空交给 AgentHistoryMenu，这里只管改 */
  const renameSession = useCallback(
    async (id: string, title: string) => {
      try {
        await renameAgentSession(DB_AGENT_ROOT, id, title);
        await refreshSessions();
      } catch (reason) {
        setConversation((current) => ({ ...current, error: String(reason) }));
      }
    },
    [refreshSessions],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    // 输入法组合中的回车是在选字，不能当发送
    if (event.nativeEvent.isComposing) return;
    if (event.shiftKey) return; // 交给 textarea 自己换行
    event.preventDefault();
    void send();
  };

  const messages = useMemo(
    () => conversation.order.map((id) => conversation.byId[id]).filter(Boolean),
    [conversation],
  );

  // 只有最后一条助手消息算「还在写」，其余按完成态渲染 markdown
  const streamingId = useMemo(() => {
    if (!conversation.streaming) return null;
    for (let index = conversation.order.length - 1; index >= 0; index -= 1) {
      const message = conversation.byId[conversation.order[index]];
      if (message?.role === "assistant") return message.id;
    }
    return null;
  }, [conversation]);

  const currentTitle =
    sessions.find((item) => item.id === currentId)?.title ?? (currentId ? "对话" : "新对话");

  if (phase === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded border border-line bg-app p-4 text-center">
          <div className="text-[12px] leading-relaxed text-fg-muted">{fatal}</div>
          <button
            type="button"
            onClick={() => void boot()}
            className="mt-3 rounded border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!connection) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="max-w-[340px] text-center text-[12px] leading-relaxed text-fg-faint">
          从左侧选一个连接，再用对话让智能体生成并执行只读 SQL。
        </p>
      </div>
    );
  }

  if (phase !== "ready") {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-fg-faint">
        正在启动智能体…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：左侧常驻当前会话标题，右侧历史与新建 */}
      <div className="relative flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={currentTitle}>
          {currentTitle}
        </span>
        <AgentHistoryMenu
          sessions={sessions}
          currentId={currentId}
          onOpen={(id) => void openSession(id)}
          onNew={newSession}
          onRename={(id, title) => void renameSession(id, title)}
          onDelete={setPendingDelete}
        />
        <button type="button" onClick={newSession} title="新建对话" className={HEAD_BUTTON}>
          <IconPlus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 外层 relative 只用来给「回到底部」按钮定位；滚动仍在内层容器上 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-raised text-fg-dim">
                <IconBot className="h-5 w-5" />
              </span>
              <div className="text-[13px] font-medium text-fg-muted">
                用一句话描述你想查什么
              </div>
              <div className="text-[12px] leading-relaxed text-fg-faint">
                智能体会先看表结构，再生成只读 SQL 并执行。写操作一律被拒绝。
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <AgentMessageView
                key={message.id}
                message={message}
                streaming={message.id === streamingId}
              />
            ))
          )}
          {conversation.error && (
            <div className="my-2 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
              {conversation.error}
            </div>
          )}
        </div>
        {/* 只有用户上滚、不再贴底时才露出；点一下回到底部并恢复跟随 */}
        {!atBottom && <ScrollToBottomButton onClick={jumpToBottom} />}
      </div>

      <div className="shrink-0 px-3 pt-1 pb-3">
        <div className="rounded-2xl border border-line bg-app px-3 pt-3 pb-2 transition-colors focus-within:border-line-hover">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={`在「${connection.name}」上查点什么…`}
            className="min-h-6 max-h-36 w-full resize-none bg-transparent text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-faint"
          />
          <div className="mt-1 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
              Enter 发送 · Shift+Enter 换行 · 仅查询
            </span>
            {conversation.streaming ? (
              <button type="button" onClick={stop} title="停止" className={STOP_BUTTON}>
                <IconStop className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim()}
                title="发送"
                className={SEND_BUTTON}
              >
                <IconSend className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 删除会话不可撤销，走自研确认框（三端一致，见 ConfirmDialog 的说明） */}
      {pendingDelete && (
        <ConfirmDialog
          message={`删除会话「${pendingDelete.title}」？这条对话的消息会一起删掉，不可撤销。`}
          confirmLabel="删除"
          onConfirm={() => {
            void deleteSession(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
