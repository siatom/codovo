import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentConversation,
  AgentEvent,
  AgentInfo,
  AgentMessage,
  AgentPart,
  AgentSessionSummary,
  AgentStatus,
  AgentToolState,
} from "./types";
import type { AgentProfile, AgentSkill } from "./settings";

/** 后端推事件用的事件名，和 src-tauri/src/agent/mod.rs 的常量对齐 */
const EVENT_NAME = "agent-event";

/** 一家提供商喂给后端的形状：只给模型 id 和一个「有没有密钥」的标记 */
export interface AgentProviderConfig {
  /** 提供商的 id，也是 `provider/model` 引用的前缀 */
  id: string;
  name: string;
  baseUrl: string;
  /** 有没有配密钥。前端不传密钥正文，后端按 id 去系统钥匙串取 */
  hasKey: boolean;
  models: string[];
}

/** 启动助手需要的全部配置 */
export interface AgentLaunchConfig {
  /** 只传启用的提供商；空的话后端直接拒绝启动 */
  providers: AgentProviderConfig[];
  /** 全局默认模型，形如 `provider/model`；空则后端取第一个可用项 */
  defaultModel: string;
  /** 生效的规则 / 记忆正文（全局 + 工作区已合并），见 lib/agent-profiles.ts */
  rules: string;
  memory: string;
  skills: AgentSkill[];
  agents: AgentProfile[];
  /** 数据库助手：只读数据库工具 */
  database?: boolean;
  /** 预览助手：预览工具 */
  preview?: boolean;
  /** 预览助手要操作的工作区根目录（`root` 传的是哨兵，真正操作哪个项目以它为准） */
  workspaceRoot?: string;
}

/** 事件都带着工作区 root：一个窗口里可能同时开着几个工作区 */
interface Tagged<T> {
  root: string;
  event: T;
}

/** 启动助手。幂等：同一个工作区已经在跑就直接复用。 */
export function startAgent(root: string, config: AgentLaunchConfig): Promise<AgentInfo> {
  return invoke<AgentInfo>("agent_start", { root, config });
}

export function agentStatus(root: string): Promise<AgentStatus> {
  return invoke<AgentStatus>("agent_status", { root });
}

/** 停掉某个工作区的助手。关闭工作区、退出前都要调。 */
export function stopAgent(root: string): Promise<void> {
  return invoke<void>("agent_stop", { root });
}

export function createAgentSession(root: string, title?: string): Promise<{ id: string }> {
  return invoke<{ id: string }>("agent_create_session", { root, title: title ?? null });
}

/** 拉某个会话的历史消息，打开会话时灌一次，之后靠事件增量 */
export function fetchAgentMessages(root: string, sessionId: string): Promise<unknown> {
  return invoke<unknown>("agent_messages", { root, sessionId });
}

/** 列出这个工作区的会话，最近的在前 */
export function listAgentSessions(root: string): Promise<unknown> {
  return invoke<unknown>("agent_list_sessions", { root });
}

/**
 * 发一条消息。立刻返回，正文靠事件流推回来。
 * `model` 是 `provider/model` 引用；不传就用后端配置的默认模型。
 */
export function sendAgentMessage(
  root: string,
  sessionId: string,
  text: string,
  model?: string,
): Promise<void> {
  return invoke<void>("agent_send", {
    root,
    sessionId,
    text,
    model: model ?? null,
  });
}

export function abortAgentSession(root: string, sessionId: string): Promise<void> {
  return invoke<void>("agent_abort", { root, sessionId });
}

/** 删掉一个会话（连同消息）。不可撤销。 */
export function deleteAgentSession(root: string, sessionId: string): Promise<void> {
  return invoke<void>("agent_delete_session", { root, sessionId });
}

/** 改会话标题。只动标题、不动消息。 */
export function renameAgentSession(
  root: string,
  sessionId: string,
  title: string,
): Promise<void> {
  return invoke<void>("agent_rename_session", { root, sessionId, title });
}

/** 订阅助手事件；别的工作区的事件由调用方按 root 过滤 */
export function onAgentEvent(
  handler: (root: string, event: AgentEvent) => void,
): Promise<UnlistenFn> {
  return listen<Tagged<AgentEvent>>(EVENT_NAME, (e) => handler(e.payload.root, e.payload.event));
}

// ---- 事件归并 ----

export const EMPTY_CONVERSATION: AgentConversation = {
  order: [],
  byId: {},
  streaming: false,
  error: null,
};

function upsertMessage(
  state: AgentConversation,
  id: string,
  role: "user" | "assistant",
): AgentConversation {
  const existing = state.byId[id];
  if (existing) {
    return existing.role === role
      ? state
      : { ...state, byId: { ...state.byId, [id]: { ...existing, role } } };
  }
  const message: AgentMessage = { id, role, parts: [] };
  return {
    ...state,
    order: [...state.order, id],
    byId: { ...state.byId, [id]: message },
  };
}

function upsertPart(state: AgentConversation, part: AgentPart): AgentConversation {
  const message = state.byId[part.messageID];
  // 片段一定跟在它所属消息后面到；真丢了就等下次拉历史补，不凭空造消息
  if (!message) return state;
  const index = message.parts.findIndex((item) => item.id === part.id);
  const parts =
    index >= 0
      ? message.parts.map((item, at) => (at === index ? part : item))
      : [...message.parts, part];
  return { ...state, byId: { ...state.byId, [message.id]: { ...message, parts } } };
}

/** 追加文本 / 推理片段。同一条消息里只留一个对应片段，后续 delta 都叠在它上面 */
function appendText(
  state: AgentConversation,
  messageID: string,
  kind: "text" | "reasoning",
  delta: string,
): AgentConversation {
  const message = state.byId[messageID];
  if (!message) return state;
  const id = `${messageID}:${kind}`;
  const existing = message.parts.find((item) => item.id === id);
  const text = existing && existing.type === kind ? existing.text : "";
  return upsertPart(state, { id, messageID, type: kind, text: text + delta });
}

/**
 * 归并一条事件。
 *
 * 事件是我们自己的形状（见 src-tauri/src/agent/mod.rs 的 emit 调用），
 * 所以这里只是把 delta / 工具卡拼成消息。
 */
export function reduceAgentEvent(
  state: AgentConversation,
  event: AgentEvent,
): AgentConversation {
  switch (event.type) {
    case "runStarted": {
      // 用户消息与助手消息一起建出来：后端不再单独推用户消息
      const userId = `${event.messageId}:user`;
      const withUser = upsertMessage(state, userId, "user");
      const userMessage = withUser.byId[userId];
      const withText =
        event.text && userMessage && userMessage.parts.length === 0
          ? upsertPart(withUser, {
              id: `${userId}:0`,
              messageID: userId,
              type: "text",
              text: event.text,
            })
          : withUser;
      return {
        ...upsertMessage(withText, event.messageId, "assistant"),
        streaming: true,
        error: null,
      };
    }

    case "textDelta":
      return appendText(state, event.messageId, "text", event.delta);

    case "reasoningDelta":
      return appendText(state, event.messageId, "reasoning", event.delta);

    case "toolCall":
      return upsertPart(state, {
        id: `${event.messageId}:tool:${event.callId}`,
        messageID: event.messageId,
        type: "tool",
        callID: event.callId,
        tool: event.tool,
        state: { status: "running", input: event.input },
      });

    case "toolResult":
      return fillToolResult(state, event.callId, event.ok, event.output);

    case "runFinished":
      return state.streaming ? { ...state, streaming: false } : state;

    case "runFailed":
      return { ...state, streaming: false, error: event.message };

    default:
      return state;
  }
}

/** 把工具结果写回对应的卡片：结果事件只带 callId，卡片可能在任意一条消息里 */
function fillToolResult(
  state: AgentConversation,
  callID: string,
  ok: boolean,
  output: string,
): AgentConversation {
  for (const id of state.order) {
    const message = state.byId[id];
    if (!message) continue;
    const index = message.parts.findIndex(
      (part) => part.type === "tool" && part.callID === callID,
    );
    if (index < 0) continue;
    const part = message.parts[index];
    if (part.type !== "tool") return state;
    const next: AgentToolState = {
      ...part.state,
      status: ok ? "completed" : "error",
      ...(ok ? { output } : { error: output }),
    };
    const parts = message.parts.map((item, at) =>
      at === index ? { ...part, state: next } : item,
    );
    return { ...state, byId: { ...state.byId, [id]: { ...message, parts } } };
  }
  return state;
}

export function formatTime(ms: number): string {
  if (!ms) return "";
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ms).toLocaleDateString();
}

/**
 * 把后端的历史消息收成会话状态。
 *
 * 后端直接返回界面要的形状（`{id, role, parts}`），这里只做一次防御性收口：
 * 认不出的片段丢掉，缺字段的消息跳过——旧版本写下的会话不该让整段历史崩掉。
 */
export function conversationFromHistory(raw: unknown): AgentConversation {
  const list = Array.isArray(raw) ? raw : [];
  const state: AgentConversation = { order: [], byId: {}, streaming: false, error: null };

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const role =
      record.role === "user" ? "user" : record.role === "assistant" ? "assistant" : null;
    if (!id || !role) continue;

    const parts: AgentPart[] = [];
    for (const raw of Array.isArray(record.parts) ? record.parts : []) {
      const part = raw as Record<string, unknown>;
      const partId = typeof part.id === "string" ? part.id : "";
      if (!partId) continue;
      if (part.type === "text" && typeof part.text === "string") {
        parts.push({ id: partId, messageID: id, type: "text", text: part.text });
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        parts.push({ id: partId, messageID: id, type: "reasoning", text: part.text });
      } else if (part.type === "tool") {
        const toolState = (part.state ?? {}) as Record<string, unknown>;
        parts.push({
          id: partId,
          messageID: id,
          type: "tool",
          callID: typeof part.callID === "string" ? part.callID : partId,
          tool: typeof part.tool === "string" ? part.tool : "",
          state: {
            status:
              toolState.status === "error"
                ? "error"
                : toolState.status === "running"
                  ? "running"
                  : "completed",
            input: toolState.input,
            output: typeof toolState.output === "string" ? toolState.output : undefined,
            error: typeof toolState.error === "string" ? toolState.error : undefined,
          },
        });
      }
    }

    state.order.push(id);
    state.byId[id] = { id, role, parts };
  }

  return state;
}

/** 把会话列表收成摘要数组，按最后活动时间倒序 */
export function parseSessions(raw: unknown): AgentSessionSummary[] {
  const list = Array.isArray(raw) ? raw : [];
  const sessions: AgentSessionSummary[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    sessions.push({
      id: record.id,
      title:
        typeof record.title === "string" && record.title.trim() ? record.title : "未命名会话",
      updated: typeof record.updated === "number" ? record.updated : 0,
    });
  }
  return sessions.sort((a, b) => b.updated - a.updated);
}
