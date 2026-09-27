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

/** 后端推 SSE 事件用的事件名，和 src-tauri/src/agent.rs 的常量对齐 */
const EVENT_NAME = "agent-event";
/** opencode 子进程自己退出时后端补发的事件 */
const EXIT_EVENT = "agent-exit";

/** 一个提供商喂给 opencode 的形状：只给模型 id 和一个「有没有密钥」的标记 */
export interface AgentProviderConfig {
  /** opencode 的 provider key，也是 `provider/model` 引用的前缀 */
  id: string;
  name: string;
  baseUrl: string;
  /** 有没有配密钥。前端不传密钥正文，后端按 id 去系统钥匙串取 */
  hasKey: boolean;
  models: string[];
}

/** 拉起 opencode 需要的全部配置；提供商和默认模型复用「设置 → 智能体」里那份 */
export interface AgentLaunchConfig {
  command: string;
  /** 0 表示让后端挑一个空闲端口 */
  port: number;
  /** 只传启用的提供商；空的话后端直接拒绝启动 */
  providers: AgentProviderConfig[];
  /** 全局默认模型，形如 `provider/model`；空则后端取第一个可用项 */
  defaultModel: string;
  /** 生效的规则 / 记忆正文（全局 + 项目已合并），见 lib/agent-profiles.ts */
  rules: string;
  memory: string;
  skills: AgentSkill[];
  agents: AgentProfile[];
  /** 选中的 primary agent；空则不下发 default_agent */
  primary: string;
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
 * `model` 是 `provider/model` 引用，必须显式给：不给的话 opencode 会用用户全局
 * 配置里的默认模型，那多半不是 CodeDock 里配的那个。
 */
export function sendAgentMessage(
  sessionId: string,
  text: string,
  model: string,
  /** 选中的 primary agent；v2 走切 agent 路由、v1 塞进请求体，都在后端处理 */
  agent?: string,
): Promise<void> {
  return invoke<void>("agent_send", { sessionId, text, model, agent: agent ?? null });
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

// ---- v1 的形状（旧包 opencode-ai 的 message.part.*）----
//
// v1 把一条消息拆成 info + parts[]，part 自带 id/messageID/type，工具调用在
// `type:"tool"` 的 part 里（`tool` + `callID` + `state`）。v2 换成了
// `content: [{type:"text"|"tool"}]`，所以这一段只在 v1 那条路上用。

/** 把 v1 的 part 收窄成内部模型；认不出的留 raw 兜住 */
function parsePart(raw: unknown): AgentPart | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = record.id;
  const messageID = record.messageID;
  if (typeof id !== "string" || typeof messageID !== "string") return null;

  const type = typeof record.type === "string" ? record.type : "";
  const text = asText(record.text);

  if (type === "text") return { id, messageID, type: "text", text };
  if (type === "reasoning") return { id, messageID, type: "reasoning", text };
  if (type === "tool") {
    const nested = asRecord(record.state);
    const status = nested?.status;
    return {
      id,
      messageID,
      type: "tool",
      callID: asText(record.callID),
      tool: asText(record.tool),
      state: {
        status:
          status === "running" || status === "completed" || status === "error"
            ? status
            : "pending",
        input: nested?.input,
        output: asText(nested?.output) || undefined,
        title: asText(nested?.title) || undefined,
        // v1 工具的 error 有时是字符串、有时是 {message}
        error: errorText(nested?.error) || undefined,
      },
    };
  }
  return { id, messageID, type: "unknown", raw };
}

/**
 * 把一个 v2 的消息对象拆成内部用的 parts。
 *
 * v2 的用户消息把文本放在顶层 `text`；助手消息放 `content` 数组（内容块的形状
 * 和大多数模型接口一样）。v1 那套 `parts: [{id, messageID, type}]` 没有了。
 * part id 用「消息 id + 序号」拼：这个组合在一条消息里唯一，而且重新拉历史时
 * 稳定，不会因为重新解析就错位。
 */
function historyParts(record: Record<string, unknown>, role: string): AgentPart[] {
  const messageID = record.id as string;
  const parts: AgentPart[] = [];

  if (role === "user") {
    const text = typeof record.text === "string" ? record.text : "";
    parts.push({ id: `${messageID}:0`, messageID, type: "text", text });
    return parts;
  }

  const content = Array.isArray(record.content) ? record.content : [];
  content.forEach((raw, index) => {
    const block = asRecord(raw);
    if (!block) return;
    const id = `${messageID}:${index}`;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text") {
      parts.push({ id, messageID, type: "text", text: asText(block.text) });
      return;
    }
    if (type === "reasoning") {
      parts.push({ id, messageID, type: "reasoning", text: asText(block.text) });
      return;
    }
    // 工具调用块：这是个自成一体的对象（块级 id/name + 嵌套 state），
    // 和流里的工具事件长得不一样，得分开认
    if (type === "tool") {
      const callID = asText(block.id);
      const nested = asRecord(block.state);
      const status = nested?.status;
      parts.push({
        id: toolPartId(messageID, callID || String(index)),
        messageID,
        type: "tool",
        callID,
        tool: asText(block.name),
        state: {
          status:
            status === "running" || status === "completed" || status === "error"
              ? status
              : "pending",
          input: nested?.input,
          output: asText(nested?.output) || undefined,
          title: asText(nested?.title) || undefined,
          error: errorText(nested?.error) || undefined,
        },
      });
      return;
    }
    // 认不出的块类型原样留着，别再往对话里糊原始 JSON
    parts.push({ id, messageID, type: "unknown", raw: block });
  });
  return parts;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 把会话历史灌成对话状态。打开会话时先灌一次，之后靠 SSE 增量往上接。
 *
 * 两代的历史形状不同，**逐条按形状分派**，不需要知道当前是哪一代：
 * - v1：`{info: {id, role}, parts: [{id, messageID, type, ...}]}`
 * - v2：`{id, type: "user"|"assistant", text?}` / `{..., content: [{type, ...}]}`
 *
 * v2 的返回里还混着 `type: "idle"` 这种标记消息（表示上一轮结束了），它们不是
 * 对话内容，直接跳过。
 */
export function conversationFromHistory(raw: unknown): AgentConversation {
  const list = Array.isArray(raw) ? raw : [];
  let state = EMPTY_CONVERSATION;

  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;

    // v1：消息元信息在 info 里，parts 是平铺的 part 数组
    const info = asRecord(record.info);
    if (info && typeof info.id === "string") {
      state = upsertMessage(state, info.id, info.role === "user" ? "user" : "assistant");
      for (const rawPart of Array.isArray(record.parts) ? record.parts : []) {
        const part = parsePart(rawPart);
        if (part) state = upsertPart(state, part);
      }
      continue;
    }

    // v2：type 直接在顶层，正文在 text / content 里
    if (typeof record.id !== "string") continue;
    const type = typeof record.type === "string" ? record.type : "";
    if (type !== "user" && type !== "assistant") continue;

    state = upsertMessage(state, record.id, type === "user" ? "user" : "assistant");
    for (const part of historyParts(record, type)) {
      state = upsertPart(state, part);
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
 * 把会话列表收成摘要数组，按最后活动时间倒序。
 * opencode 的会话不分项目，不过滤目录的话会把别的仓库的对话也列出来。
 *
 * 目录字段两代位置不同：v1 在顶层 `directory`，v2 挪进了 `location.directory`。
 * 时间都还在 `time.updated`。
 */
export function parseSessions(raw: unknown, cwd: string): AgentSessionSummary[] {
  const list = Array.isArray(raw) ? raw : [];
  const sessions: AgentSessionSummary[] = [];

  for (const item of list) {
    const record = asRecord(item);
    if (!record || typeof record.id !== "string") continue;

    const directory =
      typeof record.directory === "string"
        ? record.directory
        : asRecord(record.location)?.directory;
    if (directory !== cwd) continue;

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
 * v2 的文本片段按「消息 id + ordinal」定位（同一条消息里可以有多个文本片段），
 * 用它拼一个稳定的 part id；这个 id 和拉历史时用的编号规则也对得上。
 */
function textPartId(messageID: string, ordinal: number): string {
  return `${messageID}:${ordinal}`;
}

function appendPartText(
  state: AgentConversation,
  messageID: string,
  partID: string,
  delta: string,
): AgentConversation {
  const message = state.byId[messageID];
  if (!message) return state;
  const existing = message.parts.find((item) => item.id === partID);
  const text = existing && existing.type === "text" ? existing.text : "";
  return upsertPart(state, { id: partID, messageID, type: "text", text: text + delta });
}

/** 按事件类型定工具调用的状态。认不出的都当"在跑"，总比整条不显示强 */
function toolStatusOf(type: string): AgentToolState["status"] {
  if (type === "session.tool.success") return "completed";
  if (type === "session.tool.failed") return "error";
  return "running";
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof source[key] === "string" && source[key]) return source[key] as string;
  }
  return "";
}

/**
 * 取一段错误文案。opencode 两种都给过：有时是字符串，有时是
 * `{type, message}` 这种对象（工具失败就是后者）。
 */
function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return record && typeof record.message === "string" ? record.message : "";
}

/**
 * 把 v2 的工具事件并成一个工具 part。
 *
 * v2 把一次工具调用拆成了七八个事件（called / input.started / input.delta /
 * input.ended / progress / success / failed）。这里不逐个区分，统一按工具调用的
 * 那个 id 归并到同一个 part、各字段增量覆盖——卡片上显示的是一行摘要加一份输出。
 *
 * 字段名是实测来的：调用 id 在 `id`（不是 `callID`），名字在 `name`
 * （不是 `tool`），历史里则换成块级的 `id`/`name` + 嵌套的 `state`。
 */
function toolPartOf(
  type: string,
  data: Record<string, unknown>,
): { partID: string; messageID: string; part: AgentPart } | null {
  const messageID = firstString(data, ["assistantMessageID", "messageID"]);
  const callID = firstString(data, ["id", "callID", "callId", "toolCallID"]);
  if (!messageID || !callID) return null;

  const partID = toolPartId(messageID, callID);
  return {
    partID,
    messageID,
    part: {
      id: partID,
      messageID,
      type: "tool",
      callID,
      tool: firstString(data, ["name", "tool", "toolName"]),
      state: {
        status: toolStatusOf(type),
        // called 给结构化入参；input.ended 给的是原始 JSON 字符串，两者都有就用前者
        input: data.input ?? data.args,
        output: typeof data.output === "string" ? data.output : undefined,
        title: firstString(data, ["title", "summary"]) || undefined,
        error: errorText(data.error) || undefined,
      },
    },
  };
}

/** 工具的 part id：一次工具调用跨多个事件，得用调用 id 认，才能归到同一个 part */
function toolPartId(messageID: string, callID: string): string {
  return `${messageID}:tool:${callID}`;
}

/**
 * 把一个 SSE 事件并进对话状态。
 *
 * 纯函数，只认当前会话的事件——后端是全量转发的，过滤放在这儿省得调用方各写一遍。
 *
 * 事件名是 opencode v2 那套（`session.text.delta` / `session.execution.*` /
 * `session.tool.*`）。v2 之前的 `message.part.updated` / `session.idle` 在 v2 里
 * 已经不再发出了，别照旧名写。
 */
export function reduceAgentEvent(
  state: AgentConversation,
  event: AgentEvent,
  sessionId: string,
): AgentConversation {
  const payload = payloadOf(event);

  // 不是当前会话的直接放过，连回合结束的事件也一样
  if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) {
    return state;
  }

  switch (event.type) {
    // 一轮开始 / 一个步骤开始：assistantMessageID 在这里才第一次出现，
    // 后面的文本与工具事件都挂在它下面
    case "session.step.started": {
      const messageID = firstString(payload, ["assistantMessageID", "messageID"]);
      return messageID ? upsertMessage(state, messageID, "assistant") : state;
    }

    case "session.text.started": {
      const messageID = firstString(payload, ["assistantMessageID", "messageID"]);
      const ordinal = typeof payload.ordinal === "number" ? payload.ordinal : 0;
      if (!messageID) return state;
      const withMessage = upsertMessage(state, messageID, "assistant");
      return upsertPart(withMessage, {
        id: textPartId(messageID, ordinal),
        messageID,
        type: "text",
        text: "",
      });
    }

    // delta 是增量（实测 A、B、C、D 逐个到），所以是追加
    case "session.text.delta": {
      const messageID = firstString(payload, ["assistantMessageID", "messageID"]);
      const ordinal = typeof payload.ordinal === "number" ? payload.ordinal : 0;
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if (!messageID || !delta) return state;
      return appendPartText(
        upsertMessage(state, messageID, "assistant"),
        messageID,
        textPartId(messageID, ordinal),
        delta,
      );
    }

    // 结束时给的是完整文本，用它兜一次——万一中间漏了 delta，这里能纠回来
    case "session.text.ended": {
      const messageID = firstString(payload, ["assistantMessageID", "messageID"]);
      const ordinal = typeof payload.ordinal === "number" ? payload.ordinal : 0;
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!messageID) return state;
      return upsertPart(upsertMessage(state, messageID, "assistant"), {
        id: textPartId(messageID, ordinal),
        messageID,
        type: "text",
        text,
      });
    }

    case "session.tool.called":
    case "session.tool.input.started":
    case "session.tool.input.delta":
    case "session.tool.input.ended":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed": {
      const tool = toolPartOf(event.type, payload);
      if (!tool) return state;
      const withMessage = upsertMessage(state, tool.messageID, "assistant");
      const existing = withMessage.byId[tool.messageID]?.parts.find(
        (item) => item.id === tool.partID,
      );
      // 同一个 part 会被好几个事件轮流更新，后到的字段覆盖先到的，
      // 但别把已经拿到的 output/title 用一个空值擦掉
      if (existing && existing.type === "tool" && tool.part.type === "tool") {
        const merged: AgentPart = {
          ...tool.part,
          tool: tool.part.tool || existing.tool,
          state: {
            status: tool.part.state.status,
            input: tool.part.state.input ?? existing.state.input,
            output: tool.part.state.output ?? existing.state.output,
            title: tool.part.state.title ?? existing.state.title,
            error: tool.part.state.error ?? existing.state.error,
          },
        };
        return upsertPart(withMessage, merged);
      }
      return upsertPart(withMessage, tool.part);
    }

    // 回合结束。v2 用三个 execution.* 分别表示成功 / 失败 / 被打断，
    // 不再有 v1 那个 session.idle
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return state.streaming ? { ...state, streaming: false } : state;

    case "session.execution.failed": {
      const message =
        firstString(payload, ["error", "message"]) || "会话出错了";
      return { ...state, streaming: false, error: message };
    }

    case "session.error": {
      const error = asRecord(payload.error);
      const message =
        (error && typeof error.message === "string" ? error.message : "") ||
        (typeof payload.error === "string" ? payload.error : "") ||
        "会话出错了";
      return { ...state, streaming: false, error: message };
    }

    // ---- 以下是 v1（旧包 opencode-ai）的事件 ----
    //
    // 两代事件名完全不重叠，所以一个 switch 就能同时吃下，不用把"当前是哪一代"
    // 传到前端。v1 的载荷同样放 properties，上面的 payloadOf 已经兼容了。

    case "message.updated": {
      const info = asRecord(payload.info);
      if (!info || typeof info.id !== "string") return state;
      return upsertMessage(state, info.id, info.role === "user" ? "user" : "assistant");
    }

    case "message.part.updated": {
      const part = parsePart(payload.part);
      return part ? upsertPart(state, part) : state;
    }

    case "message.part.removed": {
      // 字段名几种都试一下：v1 的这部分是泛对象，没写死
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

    // v1 的回合结束是 session.idle
    case "session.idle":
      return state.streaming ? { ...state, streaming: false } : state;

    case "session.status": {
      // status 里是 idle 就表示这一轮结束了；busy / retry 期间保持 streaming
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
