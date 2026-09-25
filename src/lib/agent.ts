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

/** 后端推 SSE 事件用的事件名，和 src-tauri/src/agent.rs 的常量对齐 */
const EVENT_NAME = "agent-event";
/** opencode 子进程自己退出时后端补发的事件 */
const EXIT_EVENT = "agent-exit";

/** 拉起 opencode 需要的全部配置；三个接口字段复用「设置 → AI」里那份 */
export interface AgentLaunchConfig {
  command: string;
  /** 0 表示让后端挑一个空闲端口 */
  port: number;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 启动智能体服务。幂等：同一工作区已经在跑就直接复用。 */
export function startAgent(config: AgentLaunchConfig): Promise<AgentInfo> {
  return invoke<AgentInfo>("agent_start", { config });
}

export function agentStatus(): Promise<AgentStatus> {
  return invoke<AgentStatus>("agent_status");
}

/** 停掉服务。换工作区、退出前都要调。 */
export function stopAgent(): Promise<void> {
  return invoke<void>("agent_stop");
}

export function createAgentSession(title?: string): Promise<{ id: string }> {
  return invoke<{ id: string }>("agent_create_session", { title: title ?? null });
}

/** 拉某个会话的历史消息，打开会话时灌一次，之后靠 SSE 增量 */
export function fetchAgentMessages(sessionId: string): Promise<unknown> {
  return invoke<unknown>("agent_messages", { sessionId });
}

/**
 * 列出 opencode 里的所有会话。
 * 它是全局存的、把各个项目的会话混在一起返回，调用方还得用 parseSessions 按工作区筛。
 */
export function listAgentSessions(): Promise<unknown> {
  return invoke<unknown>("agent_list_sessions");
}

/**
 * 发一条消息。后端走 prompt_async，立刻返回，正文靠事件流推回来。
 * `model` 必须显式给：不给的话 opencode 会用用户全局配置里的默认模型，
 * 那多半不是 CodeDock 里配的那个。
 */
export function sendAgentMessage(
  sessionId: string,
  text: string,
  model: string,
): Promise<void> {
  return invoke<void>("agent_send", { sessionId, text, model });
}

export function abortAgentSession(sessionId: string): Promise<void> {
  return invoke<void>("agent_abort", { sessionId });
}

/** 删掉一个会话（连同消息）。opencode 那边不可撤销。 */
export function deleteAgentSession(sessionId: string): Promise<void> {
  return invoke<void>("agent_delete_session", { sessionId });
}

/** 改会话标题。opencode 那边是 `PATCH /session/:id`，只动标题、不动消息。 */
export function renameAgentSession(sessionId: string, title: string): Promise<void> {
  return invoke<void>("agent_rename_session", { sessionId, title });
}

export function onAgentEvent(handler: (event: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>(EVENT_NAME, (event) => handler(event.payload));
}

/** 订阅子进程退出。payload 是退出码。 */
export function onAgentExit(handler: (code: number) => void): Promise<UnlistenFn> {
  return listen<number>(EXIT_EVENT, (event) => handler(event.payload));
}

// ---- 事件归并 ----

export const EMPTY_CONVERSATION: AgentConversation = {
  order: [],
  byId: {},
  streaming: false,
  error: null,
};

/**
 * 事件有两种壳，载荷位置不一样，这里统一取出来。
 * 老的用 properties，新的 durable 事件（session.idle 等）用 data。
 */
function payloadOf(event: AgentEvent): Record<string, unknown> {
  return (event.properties ?? event.data ?? {}) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseToolState(raw: unknown): AgentToolState {
  const record = asRecord(raw) ?? {};
  const status = record.status;
  return {
    status:
      status === "running" || status === "completed" || status === "error"
        ? status
        : "pending",
    input: record.input,
    output: typeof record.output === "string" ? record.output : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

/** 把 opencode 的 Part 收窄成我们认得的几种；不认识的留个 raw 兜住 */
function parsePart(raw: unknown): AgentPart | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = record.id;
  const messageID = record.messageID;
  if (typeof id !== "string" || typeof messageID !== "string") return null;

  const type = typeof record.type === "string" ? record.type : "";
  const text = typeof record.text === "string" ? record.text : "";

  if (type === "text") return { id, messageID, type: "text", text };
  if (type === "reasoning") return { id, messageID, type: "reasoning", text };
  if (type === "tool") {
    return {
      id,
      messageID,
      type: "tool",
      callID: typeof record.callID === "string" ? record.callID : "",
      tool: typeof record.tool === "string" ? record.tool : "",
      state: parseToolState(record.state),
    };
  }
  return { id, messageID, type: "unknown", raw };
}

function upsertMessage(
  state: AgentConversation,
  id: string,
  role: "user" | "assistant",
): AgentConversation {
  const existing = state.byId[id];
  if (existing) {
    if (existing.role === role) return state;
    return { ...state, byId: { ...state.byId, [id]: { ...existing, role } } };
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
  // part 一定跟在它所属消息的 message.updated 后面到（实测顺序如此）。
  // 真丢了就等下次拉历史补，不在这儿凭空造消息——role 猜错了更麻烦。
  if (!message) return state;

  const index = message.parts.findIndex((item) => item.id === part.id);
  const parts =
    index >= 0
      ? message.parts.map((item) => (item.id === part.id ? part : item))
      : [...message.parts, part];
  return {
    ...state,
    byId: { ...state.byId, [part.messageID]: { ...message, parts } },
  };
}

function removePart(state: AgentConversation, messageID: string, partID: string): AgentConversation {
  const message = state.byId[messageID];
  if (!message) return state;
  const parts = message.parts.filter((item) => item.id !== partID);
  if (parts.length === message.parts.length) return state;
  return { ...state, byId: { ...state.byId, [messageID]: { ...message, parts } } };
}

function removeMessage(state: AgentConversation, id: string): AgentConversation {
  if (!state.byId[id]) return state;
  const byId = { ...state.byId };
  delete byId[id];
  return { ...state, order: state.order.filter((item) => item !== id), byId };
}

/**
 * 把 `GET /session/:id/message` 的返回灌成对话状态。
 * 打开会话时先灌一次历史，之后靠 SSE 增量往上接。
 */
export function conversationFromHistory(raw: unknown): AgentConversation {
  const list = Array.isArray(raw) ? raw : [];
  let state = EMPTY_CONVERSATION;

  for (const item of list) {
    const record = asRecord(item);
    const info = asRecord(record?.info);
    if (!info || typeof info.id !== "string") continue;
    state = upsertMessage(state, info.id, info.role === "user" ? "user" : "assistant");

    const parts = Array.isArray(record?.parts) ? record.parts : [];
    for (const rawPart of parts) {
      const part = parsePart(rawPart);
      if (part) state = upsertPart(state, part);
    }
  }

  return state;
}

/** 相对时间，够用就行——会话列表不需要精确到分秒。opencode 给的是毫秒 */
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
 * 把 `GET /session` 的返回收成会话列表，按最后活动时间倒序。
 * opencode 的会话不分项目，不过滤 directory 的话会把别的仓库的对话也列出来。
 */
export function parseSessions(raw: unknown, cwd: string): AgentSessionSummary[] {
  const list = Array.isArray(raw) ? raw : [];
  const sessions: AgentSessionSummary[] = [];

  for (const item of list) {
    const record = asRecord(item);
    if (!record || typeof record.id !== "string") continue;
    if (record.directory !== cwd) continue;

    const time = asRecord(record.time);
    const title = typeof record.title === "string" ? record.title.trim() : "";
    sessions.push({
      id: record.id,
      title: title || "未命名会话",
      updated: typeof time?.updated === "number" ? time.updated : 0,
    });
  }

  return sessions.sort((a, b) => b.updated - a.updated);
}

/**
 * 把一个 SSE 事件并进对话状态。
 *
 * 纯函数，只认当前会话的事件——后端是全量转发的，过滤放在这儿省得调用方各写一遍。
 */
export function reduceAgentEvent(
  state: AgentConversation,
  event: AgentEvent,
  sessionId: string,
): AgentConversation {
  const payload = payloadOf(event);

  // 不是当前会话的直接放过，连 session.idle 也一样
  if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) {
    return state;
  }

  switch (event.type) {
    case "message.updated": {
      const info = asRecord(payload.info);
      if (!info || typeof info.id !== "string") return state;
      const role = info.role === "user" ? "user" : "assistant";
      return upsertMessage(state, info.id, role);
    }

    case "message.part.updated": {
      const part = parsePart(payload.part);
      return part ? upsertPart(state, part) : state;
    }

    case "message.part.removed": {
      // 两种字段名都试一下：spec 里这部分是泛对象，没写死
      const part = asRecord(payload.part);
      const partID =
        (typeof payload.partID === "string" && payload.partID) ||
        (part && typeof part.id === "string" ? part.id : "") ||
        (typeof payload.id === "string" ? payload.id : "");
      const messageID =
        (typeof payload.messageID === "string" && payload.messageID) ||
        (part && typeof part.messageID === "string" ? part.messageID : "");
      if (!partID || !messageID) return state;
      return removePart(state, messageID, partID);
    }

    case "message.removed": {
      const id =
        (typeof payload.messageID === "string" && payload.messageID) ||
        (typeof payload.id === "string" ? payload.id : "");
      return id ? removeMessage(state, id) : state;
    }

    case "session.idle":
      return state.streaming ? { ...state, streaming: false } : state;

    case "session.error": {
      const error = asRecord(payload.error);
      const message =
        (error && typeof error.message === "string" ? error.message : "") ||
        (typeof payload.error === "string" ? payload.error : "") ||
        "会话出错了";
      return { ...state, streaming: false, error: message };
    }

    case "session.status": {
      // status 里有 idle 时这一轮就结束了；busy/retry 期间保持 streaming
      const status = asRecord(payload.status);
      if (status?.type === "idle") {
        return state.streaming ? { ...state, streaming: false } : state;
      }
      return state;
    }

    default:
      return state;
  }
}
