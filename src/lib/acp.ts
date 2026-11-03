import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cliKey, cliProvider } from "./cli-sessions";

/** 后端推事件用的事件名，和 src-tauri/src/acp/event.rs 的常量对齐 */
const EVENT_NAME = "acp-event";

/**
 * 能进对话面板的 CLI key，和 src-tauri/src/acp/launch.rs 的 supported 对齐。
 * Codex / Claude Code 没有原生 ACP 入口，后端用官方 npx 适配器起。
 */
export const ACP_PROVIDER_KEYS = new Set([
  "opencode",
  "codebuddy",
  "gemini",
  "copilot",
  "codex",
  "claude",
  "qoder",
]);

/**
 * 认出「这家 CLI 能不能进对话面板」。返回后端 launch.rs 认的 provider key。
 *
 * 先走 `cliProvider`（有统一会话历史的那几家），再补 Gemini / Copilot——
 * 它们还没进 `lib/cli-sessions.ts` 的 `CLI_PROVIDERS`，但 ACP 入口是明确的。
 */
export function acpProviderKey(command: string, name = ""): string | null {
  const provider = cliProvider(command, name);
  if (provider && ACP_PROVIDER_KEYS.has(provider.key)) return provider.key;

  const aliases: Record<string, string> = {
    gemini: "gemini",
    "gemini-cli": "gemini",
    copilot: "copilot",
    "github-copilot": "copilot",
  };
  const words = [...command.trim().split(/\s+/), name.trim()].map(cliKey);
  for (const word of words) {
    const key = aliases[word];
    if (key && ACP_PROVIDER_KEYS.has(key)) return key;
  }
  return null;
}

/** 一条环境变量，和设置里 AI CLI 的 env 同形 */
export interface AcpEnvVar {
  key: string;
  value: string;
}

export interface AcpInfo {
  provider: string;
  /** Agent 自报的名字 / 版本 */
  agentName: string;
  agentVersion: string;
  /** ACP session id */
  sessionId: string;
  cwd: string;
  /** 这次启动是不是恢复了旧会话 */
  resumed: boolean;
  /** Agent 支持 `session/load`：恢复时会把历史当更新重放回来 */
  canLoad: boolean;
  /** Agent 支持 `session/resume`：恢复但不重放历史 */
  canResume: boolean;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  /** allow_once / allow_always / reject_once / reject_always */
  kind: string;
}

export interface AcpToolLocation {
  path: string;
  line?: number;
}

export interface AcpTextContent {
  type: "text";
  text: string;
}

/** ACP ContentBlock：只认渲染用得到的 text，其余保留原样 */
export type AcpContentBlock =
  | AcpTextContent
  | { type: string; [key: string]: unknown };

export type AcpToolContent =
  | { type: "content"; content?: AcpContentBlock }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; terminalId?: string }
  | { type: string; [key: string]: unknown };

/** ACP ToolCall / ToolCallUpdate 的公共字段（camelCase） */
export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  name?: string;
  /** read / edit / delete / move / search / execute / think / fetch / other */
  kind?: string;
  /** pending / in_progress / completed / failed */
  status?: string;
  content?: AcpToolContent[];
  locations?: AcpToolLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpPlanEntry {
  content?: string;
  status?: string;
  priority?: string;
}

/** 后端会原样转发 ACP `session/update`，这里只挑出面板认识的字段 */
export type AcpUpdate =
  | { sessionUpdate: "agent_message_chunk"; content?: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content?: AcpContentBlock }
  | { sessionUpdate: "user_message_chunk"; content?: AcpContentBlock }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCall)
  | { sessionUpdate: "plan"; entries?: AcpPlanEntry[] }
  | { sessionUpdate: "current_mode_update"; currentModeId?: string }
  | { sessionUpdate: "usage_update"; used?: number; size?: number }
  | { sessionUpdate: string; [key: string]: unknown };

export type AcpEvent =
  | { type: "ready"; info: AcpInfo }
  | { type: "update"; update: AcpUpdate }
  | { type: "permission"; requestId: string; toolCall: AcpToolCall; options: AcpPermissionOption[] }
  | { type: "promptDone"; stopReason: string }
  | { type: "error"; message: string }
  | { type: "closed"; reason: string };

export interface AcpEnvelope {
  root: string;
  chatId: string;
  event: AcpEvent;
}

export interface AcpToolCallInput {
  root: string;
  chatId: string;
  provider: string;
  command: string;
  roots: string[];
  env: AcpEnvVar[];
  /** 要恢复的 ACP session id；不传就新开一轮会话 */
  resumeSessionId?: string;
}

/* ---------- 会话状态 ---------- */

export type AcpChatPhase = "idle" | "starting" | "ready" | "error" | "closed";

export type AcpBlock =
  /** local：用户在这台前端上敲的。恢复历史重放时保留，其余旧块会被换掉 */
  | { id: string; kind: "user"; text: string; local?: boolean; streaming?: boolean }
  | { id: string; kind: "assistant"; text: string; streaming: boolean }
  | { id: string; kind: "thought"; text: string; streaming: boolean }
  | { id: string; kind: "tool"; call: AcpToolCall }
  | { id: string; kind: "plan"; entries: AcpPlanEntry[] }
  | { id: string; kind: "notice"; text: string; tone: "info" | "error" };

export interface AcpPendingPermission {
  requestId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
  /** 用户已经点过哪个选项；null 表示取消 */
  resolved?: string | null;
}

export interface AcpChat {
  /** 前端生成的对话 id；后端按它路由事件 */
  chatId: string;
  /** ACP session id；拿到后可以跨重启恢复 */
  sessionId?: string;
  phase: AcpChatPhase;
  info?: AcpInfo;
  blocks: AcpBlock[];
  busy: boolean;
  permission?: AcpPendingPermission;
  stopReason?: string;
  error?: string;
  mode?: string;
  usage?: { used?: number; size?: number };
}

export function newChatId(provider: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `acp_${provider}_${Date.now().toString(36)}_${random}`;
}

export function emptyAcpChat(chatId = ""): AcpChat {
  return { chatId, phase: "idle", blocks: [], busy: false };
}

function blockId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 存档 → 面板状态：进程还没起来，phase 用 idle，下一条消息触发恢复 */
export function chatFromStored(stored: StoredChat): AcpChat {
  return {
    chatId: stored.chatId,
    sessionId: stored.sessionId,
    phase: "idle",
    blocks: stored.blocks,
    busy: false,
  };
}

/** 取 ACP 内容块里的纯文本；非 text（图片、资源链接）先不渲染正文 */
export function contentText(content: AcpContentBlock | undefined): string | null {
  if (!content) return null;
  if (content.type === "text" && typeof (content as AcpTextContent).text === "string") {
    return (content as AcpTextContent).text;
  }
  return null;
}

function appendStreaming(
  chat: AcpChat,
  kind: "assistant" | "thought" | "user",
  text: string,
): AcpChat {
  const blocks = [...chat.blocks];
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind && last.streaming) {
    blocks[blocks.length - 1] = { ...last, text: last.text + text };
  } else if (kind === "user") {
    // 重放的旧消息没有 local 标记：它们来自 Agent 的历史，不是这台前端刚敲的
    blocks.push({ id: blockId("user"), kind: "user", text, streaming: true });
  } else {
    blocks.push({ id: blockId(kind), kind, text, streaming: true });
  }
  return { ...chat, blocks };
}

function finishStreaming(chat: AcpChat): AcpChat {
  if (!chat.blocks.some((block) => "streaming" in block && block.streaming)) {
    return chat;
  }
  return {
    ...chat,
    blocks: chat.blocks.map((block) =>
      "streaming" in block && block.streaming ? { ...block, streaming: false } : block,
    ),
  };
}

function upsertTool(chat: AcpChat, patch: Partial<AcpToolCall> & { toolCallId: string }): AcpChat {
  const blocks = [...chat.blocks];
  const index = blocks.findIndex(
    (block) => block.kind === "tool" && block.call.toolCallId === patch.toolCallId,
  );
  if (index >= 0) {
    const current = blocks[index];
    if (current.kind === "tool") {
      const merged: AcpToolCall = { ...current.call };
      // 只有真正带值的字段才覆盖：tool_call_update 是按字段增量的
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined && value !== null) {
          (merged as unknown as Record<string, unknown>)[key] = value;
        }
      }
      blocks[index] = { ...current, call: merged };
    }
  } else {
    blocks.push({ id: blockId("tool"), kind: "tool", call: { ...patch } });
  }
  return { ...chat, blocks };
}

function stopReasonText(stopReason: string): string | null {
  switch (stopReason) {
    case "end_turn":
      return null;
    case "cancelled":
      return "已取消这一轮";
    case "max_tokens":
      return "达到模型长度上限，回答被截断";
    case "max_turn_requests":
      return "达到单轮工具调用上限";
    case "refusal":
      return "Agent 拒绝继续这一轮";
    default:
      return `这一轮结束：${stopReason}`;
  }
}

/**
 * 把一条后端事件折进会话状态。纯函数，方便以后做持久化或单测。
 *
 * 文本块只在「最后一块还是同类型的流式块」时追加；中间插入了工具卡之后再来
 * 正文就自然另起一块，和真实对话的节奏一致。
 */
export function reduceAcpEvent(chat: AcpChat, event: AcpEvent): AcpChat {
  switch (event.type) {
    case "ready": {
      const { info } = event;
      // 走 session/load 的 Agent 会把旧历史当更新重放回来；先清掉本地旧块，
      // 只留这台前端刚敲的那条（local），否则会和重放内容重复。
      const replay = info.resumed && info.canLoad;
      const blocks = replay ? chat.blocks.filter((block) => block.kind === "user" && block.local) : chat.blocks;
      return {
        ...chat,
        phase: "ready",
        info,
        sessionId: info.sessionId,
        error: undefined,
        blocks,
      };
    }
    case "update": {
      const update = event.update;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = contentText((update as { content?: AcpContentBlock }).content);
          return text ? appendStreaming(chat, "assistant", text) : chat;
        }
        case "agent_thought_chunk": {
          const text = contentText((update as { content?: AcpContentBlock }).content);
          return text ? appendStreaming(chat, "thought", text) : chat;
        }
        case "user_message_chunk": {
          // 只在恢复历史时出现：Agent 把旧对话里的用户消息重放回来
          const text = contentText((update as { content?: AcpContentBlock }).content);
          return text ? appendStreaming(chat, "user", text) : chat;
        }
        case "tool_call":
        case "tool_call_update":
          return upsertTool(chat, update as AcpToolCall);
        case "plan": {
          const entries = (update as { entries?: AcpPlanEntry[] }).entries ?? [];
          const blocks = [...chat.blocks];
          const index = blocks.findIndex((block) => block.kind === "plan");
          if (index >= 0) blocks[index] = { id: blocks[index].id, kind: "plan", entries };
          else blocks.push({ id: blockId("plan"), kind: "plan", entries });
          return { ...chat, blocks };
        }
        case "current_mode_update": {
          const mode = (update as { currentModeId?: string }).currentModeId;
          return mode ? { ...chat, mode } : chat;
        }
        case "usage_update": {
          const { used, size } = update as { used?: number; size?: number };
          return { ...chat, usage: { used, size } };
        }
        default:
          return chat;
      }
    }
    case "permission": {
      const withTool = upsertTool(chat, event.toolCall);
      return {
        ...withTool,
        permission: {
          requestId: event.requestId,
          toolCall: event.toolCall,
          options: event.options,
        },
      };
    }
    case "promptDone": {
      const finished = finishStreaming(chat);
      const notice = stopReasonText(event.stopReason);
      return {
        ...finished,
        busy: false,
        stopReason: event.stopReason,
        permission: undefined,
        blocks: notice
          ? [...finished.blocks, { id: blockId("notice"), kind: "notice", text: notice, tone: "info" }]
          : finished.blocks,
      };
    }
    case "error": {
      const finished = finishStreaming(chat);
      return {
        ...finished,
        busy: false,
        error: event.message,
        blocks: [
          ...finished.blocks,
          { id: blockId("notice"), kind: "notice", text: event.message, tone: "error" },
        ],
      };
    }
    case "closed": {
      return {
        ...finishStreaming(chat),
        phase: "closed",
        busy: false,
        permission: undefined,
        blocks: [
          ...chat.blocks,
          { id: blockId("notice"), kind: "notice", text: `对话已结束：${event.reason}`, tone: "info" },
        ],
      };
    }
    default:
      return chat;
  }
}

/* ---------- 命令封装 ---------- */

export function startAcpChat(input: AcpToolCallInput): Promise<AcpInfo> {
  return invoke<AcpInfo>("acp_start", {
    input: {
      root: input.root,
      chatId: input.chatId,
      provider: input.provider,
      command: input.command,
      roots: input.roots,
      env: input.env,
      resumeSessionId: input.resumeSessionId ?? null,
    },
  });
}

export interface AcpStatus {
  running: boolean;
  busy: boolean;
  info?: AcpInfo;
}

/** 面板重新挂载时问后端：这条对话的子进程还活着吗 */
export function getAcpStatus(root: string, chatId: string): Promise<AcpStatus> {
  return invoke<AcpStatus>("acp_status", { root, chatId });
}

export function sendAcpMessage(root: string, chatId: string, text: string): Promise<void> {
  return invoke<void>("acp_prompt", { root, chatId, text });
}

export function cancelAcpChat(root: string, chatId: string): Promise<void> {
  return invoke<void>("acp_cancel", { root, chatId });
}

export function respondAcpPermission(
  root: string,
  chatId: string,
  requestId: string,
  optionId: string | null,
): Promise<void> {
  return invoke<void>("acp_respond_permission", { root, chatId, requestId, optionId });
}

export function stopAcpChat(root: string, chatId: string): Promise<void> {
  return invoke<void>("acp_stop", { root, chatId });
}

/** 订阅对话事件；别的工作区 / 别的前端会话由调用方过滤 */
export function onAcpEvent(
  handler: (root: string, chatId: string, event: AcpEvent) => void,
): Promise<UnlistenFn> {
  return listen<AcpEnvelope>(EVENT_NAME, (payload) => {
    handler(payload.payload.root, payload.payload.chatId, payload.payload.event);
  });
}

/* ---------- 本地存档 ---------- */

/**
 * 对话存档：重启应用或切走工作区后，切回来还能看见上次的记录，
 * 并且带着 ACP session id，下一条消息可以直接恢复旧会话。
 *
 * 存 localStorage 而不是后端：ACP 会话本身在 Agent 那边，前端只需要记住 id
 * 和一份展示用的记录；后端 Chat 的进程池跟着工作区生命周期走。
 */
const STORE_KEY = "codovo.acpChats";
/** 只留最近若干块：存档是接着聊的上下文，不是完整审计日志 */
const MAX_BLOCKS = 40;
/** 单块正文上限，防止一次大 diff 把 localStorage 塞满 */
const MAX_TEXT = 4000;
/** 同一家 CLI 在一个工作区里最多留几条对话 */
export const MAX_CHATS = 6;

export interface StoredChat {
  chatId: string;
  sessionId: string;
  provider: string;
  blocks: AcpBlock[];
  updatedAt: number;
}

/** 一个「工作区 + 命令」槽位下的全部对话 */
export interface StoredSlot {
  chats: StoredChat[];
  activeId: string;
}

type StoredMap = Record<string, StoredSlot>;

function storedKey(root: string, command: string): string {
  return `${root}\u0000${command}`;
}

function readStore(): StoredMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredMap) : {};
  } catch {
    // 存档坏了不该挡住面板：当作没有历史
    return {};
  }
}

function writeStore(map: StoredMap) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    // 配额满了 / 隐私模式下不可写，静默放弃；对话本身还在内存里
  }
}

/** 工具正文和 diff 可能很大，存档只留摘要 */
function pruneBlocks(blocks: AcpBlock[]): AcpBlock[] {
  return blocks.slice(-MAX_BLOCKS).map((block) => {
    if (block.kind === "tool") {
      return { ...block, call: { ...block.call, content: undefined, rawOutput: undefined } };
    }
    if ("text" in block && block.text.length > MAX_TEXT) {
      return { ...block, text: `${block.text.slice(0, MAX_TEXT)}\n…` };
    }
    return block;
  });
}

/** 读回某个工作区 + 某条命令的存档；没有就返回 null */
export function loadStoredSlot(root: string, command: string): StoredSlot | null {
  const entry = readStore()[storedKey(root, command)];
  if (!entry) return null;

  // 早期版本一个槽位只存一条对话，读到时升级成单元素列表
  const legacy = entry as unknown as Partial<StoredChat>;
  const chats: StoredChat[] = Array.isArray(entry.chats)
    ? entry.chats
    : typeof legacy.chatId === "string" && typeof legacy.sessionId === "string"
      ? [legacy as StoredChat]
      : [];

  const cleaned = chats
    .filter((chat) => chat && typeof chat.chatId === "string" && typeof chat.sessionId === "string")
    .map((chat) => ({
      ...chat,
      provider: chat.provider ?? "",
      blocks: (chat.blocks ?? []).map((block) =>
        "streaming" in block ? { ...block, streaming: false } : block,
      ),
    }));
  if (cleaned.length === 0) return null;

  const activeId =
    typeof entry.activeId === "string" && cleaned.some((chat) => chat.chatId === entry.activeId)
      ? entry.activeId
      : cleaned[0].chatId;
  return { chats: cleaned, activeId };
}

/** 一轮结束 / 关面板时落盘。没有 session id 的对话恢复不了，不存。 */
export function saveStoredSlot(root: string, command: string, chats: AcpChat[], activeId: string) {
  const entries = chats
    .filter((chat) => chat.chatId && chat.sessionId && chat.blocks.length > 0)
    .slice(-MAX_CHATS)
    .map<StoredChat>((chat) => ({
      chatId: chat.chatId,
      sessionId: chat.sessionId as string,
      provider: chat.info?.provider ?? "",
      blocks: pruneBlocks(chat.blocks),
      updatedAt: Date.now(),
    }));
  const map = readStore();
  if (entries.length === 0) {
    delete map[storedKey(root, command)];
  } else {
    map[storedKey(root, command)] = {
      chats: entries,
      activeId: entries.some((chat) => chat.chatId === activeId) ? activeId : entries[0].chatId,
    };
  }
  writeStore(map);
}

export function clearStoredSlot(root: string, command: string) {
  const map = readStore();
  if (!(storedKey(root, command) in map)) return;
  delete map[storedKey(root, command)];
  writeStore(map);
}
