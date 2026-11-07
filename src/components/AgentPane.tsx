import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { emptyAgentLayer, useSettings, type AgentLayer } from "../lib/settings";
import { samePath } from "../lib/fs";
import { useEffectiveAiConfig } from "../lib/ai";
import {
  boundModelRef,
  enabledModels,
  enabledProviders,
  modelRefLabel,
  resolveDefaultModel,
} from "../lib/providers";
import {
  EMPTY_CONVERSATION,
  abortAgentSession,
  conversationFromHistory,
  createAgentSession,
  deleteAgentSession,
  fetchAgentMessages,
  listAgentSessions,
  onAgentEvent,
  parseSessions,
  reduceAgentEvent,
  renameAgentSession,
  sendAgentMessage,
  startAgent,
} from "../lib/agent";
import { useAgentSession } from "../lib/agent-session";
import { agentTarget, useAttention, type AttentionKind } from "../lib/attention";
import { APP_AGENT_LABEL, APP_AGENT_NAME, mergeAgentLayer } from "../lib/agent-profiles";
import { readWorkspaceLayer } from "../lib/agent-config";
import type { AgentConversation, AgentSessionSummary, EditorLocation } from "../lib/types";
import { AgentHistoryMenu } from "./AgentHistoryMenu";
import { AgentMessageView } from "./AgentMessageView";
import { ConfirmDialog } from "./ConfirmDialog";
import { ScrollToBottomButton, useStickToBottom } from "./ScrollToBottom";
import {
  IconBot,
  IconClose,
  IconPlus,
  IconSend,
  IconStop,
  closeIconHtml,
  fileIconHtml,
} from "./icons";
import { ICON_SM, IconButton } from "./ui";

export interface AgentPaneHandle {
  /** 把一段位置引用插成一个可整体删除的 chip；服务还没就绪就先挂着，就绪后补上 */
  insertRef: (location: EditorLocation) => void;
}

interface AgentPaneProps {
  /** 这个助手面板属于哪个工作区。一个工作区一个后端槽位，各自独立 */
  root: string;
  /** 面板是否展示中；第一次变 true 时才去拉服务 */
  active: boolean;
  /** 关闭面板（抽屉右上角的关闭按钮） */
  onClose: () => void;
  /** React 19 起 ref 可以直接当普通 prop 传，不必再包 forwardRef */
  ref?: Ref<AgentPaneHandle>;
}

type Phase = "idle" | "starting" | "ready" | "error";

/**
 * 当前选中的会话 id 按工作区记，换工作区就是另一套历史。
 * 存 sessionStorage：多窗口下同一个工作区可以各看各的会话，互不影响。
 */
const SESSION_KEY_PREFIX = "codovo.agentSession.";

/** 发送键是这一屏唯一的主操作，做成实心圆钮；圆底上的字色复用角标那套 text-app */
const SEND_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-app transition-opacity hover:opacity-90 disabled:opacity-30 disabled:hover:opacity-30";

/** 停止键和发送键同尺寸同位置，但保持中性色，免得被当成"再发一次" */
const STOP_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-active text-fg hover:bg-hover";

/* ---------- 输入框里的位置引用 chip ---------- */

/** chip 的样式：圆角小块 + 选中色底，和普通文字一眼分得开 */
const CHIP_CLASS =
  "group inline-flex items-center gap-1 rounded bg-selected py-0.5 pl-1.5 pr-1 align-middle text-[12px] text-fg";

/**
 * chip 上的删除按钮：平时透明但占着位置——悬浮时才显示，改宽度会让 chip 跳一下。
 * 点击走 composer 上的事件委托，见 onComposerClick。
 */
const CHIP_DEL_CLASS =
  "flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger";

/** 「路径:起[-止]」——单行只写一个行号，跨行才带结束行号 */
function formatLocation({ path, start, end }: EditorLocation): string {
  return `${path}:${start}${end > start ? `-${end}` : ""}`;
}

/** chip 的内容要拼 HTML 字符串，路径和文本都得转义（路径里可能有 & " 这类字符） */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 造一个 chip 节点。contentEditable=false 让它对光标是个原子：退格一次删整块，
 * 光标也进不到里面去编辑。
 */
function createChip(location: EditorLocation): HTMLElement {
  const text = formatLocation(location);
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.location = text;
  chip.className = CHIP_CLASS;
  chip.innerHTML =
    `${fileIconHtml("h-3 w-3 shrink-0")}<span>${escapeHtml(text)}</span>` +
    `<span data-chip-del title="移除" class="${CHIP_DEL_CLASS}">${closeIconHtml("h-2.5 w-2.5")}</span>`;
  return chip;
}

/** 把输入框的 DOM 序列化成要发出去的文本：普通文字取原文，chip 换回它的引用串 */
function serializeComposer(root: HTMLElement): string {
  let out = "";
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
    } else if (node.nodeName === "BR") {
      // 浏览器删到只剩一行时可能留个 <br>，它没有文本，得当成换行
      out += "\n";
    } else if (node instanceof HTMLElement) {
      out += node.dataset.location ?? serializeComposer(node);
    }
  }
  return out;
}

/** 在光标处插入一个节点，光标落到它后面。返回 false 表示当前没有可用的光标位置 */
function insertAtCaret(node: Node): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** 把光标放到输入框末尾（插完 chip 后接着打字用） */
function focusComposerEnd(root: HTMLElement): void {
  root.focus();
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * 应用助手面板：后端是进程内的 Rig 运行时（见 src-tauri/src/agent/），
 * 这里只负责发消息、把推回来的事件渲染成对话。
 *
 * 它是**内置应用助手**的界面：靠内置的工具问答 Codovo 用法、按指令改设置 /
 * 管工作区 / 切右栏模块（见 lib/app-agent.ts 的事件桥）。后端按 `Kind::App`
 * 装配提示词与工具，面板这边不给用户切换——要聊代码请用终端里的 AI CLI。
 */
export function AgentPane({ root, active, onClose, ref }: AgentPaneProps) {
  const { settings } = useSettings();
  // 会话列表和当前会话按工作区存在 agent-session 里：抽屉的历史菜单要靠它切会话
  const {
    sessions,
    setSessions,
    currentId,
    currentIdRef,
    setCurrentId,
    requestedId,
    clearRequest,
    requestDelete,
    requestedDeleteId,
    clearDeleteRequest,
    requestedNew,
    clearNewRequest,
    requestRename,
    requestedRename,
    clearRenameRequest,
  } = useAgentSession(root);
  // 有待用户处理的会话（权限询问 / 提问 / 任务完成），在历史菜单里点一颗脉冲点；
  // 等回应还是已完成靠 kind 出文案。attention 里会话类目标键是 `agent:<id>`
  const { entries: attentionEntries, clear: clearAttention, clearIf: clearAttentionIf } =
    useAttention(root);
  const waitingKinds = useMemo(() => {
    const map = new Map<string, AttentionKind>();
    for (const [key, kind] of Object.entries(attentionEntries)) {
      if (key.startsWith("agent:")) map.set(key.slice("agent:".length), kind);
    }
    return map;
  }, [attentionEntries]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [fatal, setFatal] = useState<string | null>(null);
  const [conversation, setConversation] = useState<AgentConversation>(EMPTY_CONVERSATION);
  /** 标题栏历史菜单里点了「删除」，等确认框 */
  const [pendingDelete, setPendingDelete] = useState<AgentSessionSummary | null>(null);
  /** 输入框内容的纯文本形态（chip 已序列化成引用串），只用来判断能不能发、发什么 */
  const [draft, setDraft] = useState("");
  /** 从编辑器浮窗送来、还没插进去的位置引用；服务没就绪时先挂起，ready 后补上 */
  const [pendingRef, setPendingRef] = useState<EditorLocation | null>(null);
  const startedRef = useRef(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  // 对话流贴底跟随（上滚暂停、回到底部恢复），终端区智能体与数据库智能体共用这套逻辑
  const {
    ref: scrollRef,
    atBottom,
    onScroll,
    jumpToBottom,
    reset: resetScroll,
  } = useStickToBottom(conversation);

  // 默认模型那家提供商走合并后的生效配置：开发调试版可能被 src-tauri/.env 覆盖
  const { config: aiConfig, ready: aiReady } = useEffectiveAiConfig();

  // 项目层配置以仓库根的 `.codovo/` 为准，异步读进来；读到之前保持 null，
  // boot 会等它就绪再启动，免得把半截配置喂给后端。
  const [workspaceLayer, setWorkspaceLayer] = useState<AgentLayer | null>(null);
  useEffect(() => {
    if (!root) {
      setWorkspaceLayer(emptyAgentLayer());
      return;
    }
    let cancelled = false;
    setWorkspaceLayer(null);
    readWorkspaceLayer(root, settings.agentWorkspaces[root])
      .then(({ layer: loaded, migrated }) => {
        if (cancelled) return;
        setWorkspaceLayer(loaded);
        if (migrated) console.info("已把旧的项目层智能体配置迁移到 .codovo/");
      })
      .catch((reason) => {
        console.error("读取项目层智能体配置失败", reason);
        if (!cancelled) setWorkspaceLayer(emptyAgentLayer());
      });
    return () => {
      cancelled = true;
    };
  }, [root, settings.agentWorkspaces]);

  // 生效层只剩项目层：全局层随「设置 → 智能体」的瘦身一起去掉了，助手改用仓库根的
  // `.codovo/`（rules / memory / skills / agents），随仓库走、能进 git。
  // 仍然过一遍 mergeAgentLayer：它负责滤掉关掉的和名字非法的条目，非法名会让后端校验拦下整个服务。
  const layer = useMemo(
    () => mergeAgentLayer(emptyAgentLayer(), workspaceLayer ?? emptyAgentLayer()),
    [workspaceLayer],
  );
  // 内置应用助手的名字：只用来找用户给它绑的模型（见上方组件注释）
  const agentName = APP_AGENT_NAME;

  /** 喂给后端的提供商。只给启用的、地址填了的；密钥只说有没有，正文留后端取 */
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

  // 全局默认模型引用。提供商为空但 aiReady（开发调试只写 .env）时，
  // 后端会合成一个 id 为 codovo 的提供商，引用得跟它对上，
  // 见 src-tauri/src/agent/config.rs 的 apply()
  const fallbackRef = aiConfig.model ? `codovo/${aiConfig.model}` : "";
  const defaultModelRef = resolveDefaultModel(settings)?.ref ?? fallbackRef;

  // 这一轮对话用哪个模型：agent 自己绑了就用绑的，否则跟随全局默认。
  // 必须显式指定——后端不会替我们猜用户想用哪个模型。
  const boundAgent = layer.agents.find((agent) => agent.name === agentName);
  const sendModel = boundModelRef(settings, boundAgent?.model ?? "") ?? fallbackRef;

  /** 拉一次会话列表。失败不抛，返回空数组让调用方兜底 */
  const refreshSessions = useCallback(async (): Promise<AgentSessionSummary[]> => {
    if (!root) return [];
    try {
      const list = parseSessions(await listAgentSessions(root));
      setSessions(list);
      return list;
    } catch {
      // 列表拉不到不该挡住对话，界面保持上一次的样子
      return [];
    }
  }, [root]);

  /** 打开某个会话：拉历史灌进来，并把它记成当前会话 */
  const openSession = useCallback(
    async (id: string) => {
      if (!root) return;
      // 「打开即已读」：撤掉任务完成标记。等回应的 permission / question 不动，
      // 那还得用户真的回应（后端收到工具回执后会自己清）
      clearAttentionIf(agentTarget(id), "done");
      try {
        const history = await fetchAgentMessages(root, id);
        setCurrentId(id);
        window.sessionStorage.setItem(SESSION_KEY_PREFIX + root, id);
        setConversation(conversationFromHistory(history));
        // 换了一段对话，跟随状态跟着复位（否则会带着上一条的「已上滚」停在半空）
        resetScroll();
        setPhase("ready");
      } catch (reason) {
        setFatal(String(reason));
        setPhase("error");
      }
    },
    [root, setCurrentId, resetScroll, clearAttentionIf],
  );

  /** 拉服务 → 接着上次的会话（没了就接最近的一条；一条都没有就停在空态，等用户发第一句再建） */
  const boot = useCallback(async () => {
    if (!root) {
      setFatal("先选一个工作目录，助手要知道在哪个仓库里干活");
      setPhase("error");
      return;
    }
    if (!aiReady) {
      setFatal(
        "请先在「设置 → AI → 模型提供商」里加一个提供商，并把它下面的模型设为默认",
      );
      setPhase("error");
      return;
    }

    setPhase("starting");
    setFatal(null);

    try {
      await startAgent(root, {
        providers,
        defaultModel: defaultModelRef,
        rules: layer.rules,
        memory: layer.memory,
        skills: layer.skills,
        agents: layer.agents,
      });
    } catch (reason) {
      setFatal(String(reason));
      setPhase("error");
      return;
    }

    // 会话列表才是真相：本地存的那个 id 可能已经被删了，也可能清过缓存。
    // 所以先问列表——本地那条还在就接着它，否则退一步接最近的一条。
    const list = await refreshSessions();
    const saved = window.sessionStorage.getItem(SESSION_KEY_PREFIX + root);
    const target = list.find((item) => item.id === saved) ?? list[0];
    if (target) {
      await openSession(target.id);
      return;
    }

    // 一条历史都没有：不急着建会话，先停在「等第一句」的空态。
    // 会话等用户真的发出去才建，否则历史列表里会堆一串聊都没聊过的空条目。
    setCurrentId(null);
    setConversation(EMPTY_CONVERSATION);
    setPhase("ready");
  }, [
    root,
    aiReady,
    providers,
    defaultModelRef,
    layer,
    refreshSessions,
    openSession,
    setCurrentId,
  ]);

  useEffect(() => {
    // 等项目层配置读到再启动：boot 会把 layer 喂给后端，读到之前启动会漏配置
    if (!active || startedRef.current || workspaceLayer === null) return;
    startedRef.current = true;
    void boot();
  }, [active, boot, workspaceLayer]);

  // 事件流只订阅一次。后端是全量转发的，用 ref 拿当前会话 id，
  // 免得每次开会话都要重订阅一遍
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void onAgentEvent((eventRoot, event) => {
      // 一个窗口里会同时开着几个工作区、各有一个槽位在跑，只认自己这份
      if (!samePath(eventRoot, root)) return;
      // 一个槽位里可能开着几条会话，只认当前这条（别的会话可能在后台跑）
      const sessionId = currentIdRef.current;
      if (!sessionId || event.sessionId !== sessionId) return;
      setConversation((current) => reduceAgentEvent(current, event));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentIdRef]);

  // 侧边栏点了某条历史会话：真正打开的动作在这儿做。
  // 服务还没就绪（比如刚切到 GUI）就等 phase 变 ready 再消费，别去拉一个还没起的服务。
  useEffect(() => {
    if (!requestedId || phase !== "ready") return;
    clearRequest();
    // 「打开即已读」要在这里也做一次：请求的正好是当前这条会话时下面提前返回、
    // 不走 openSession，标记会清不掉
    clearAttentionIf(agentTarget(requestedId), "done");
    if (requestedId === currentIdRef.current) return;
    setConversation(EMPTY_CONVERSATION);
    void openSession(requestedId);
  }, [requestedId, phase, clearRequest, currentIdRef, openSession, clearAttentionIf]);

  // 新内容进来就贴到底部（由 useStickToBottom 统一处理：上滚后暂停、回底恢复）

  // 输入框跟着内容长高，超过上限就内部滚动
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [draft]);

  /** 把输入框的 DOM 重新序列化一遍，同步到 draft */
  const syncDraft = useCallback(() => {
    const root = composerRef.current;
    setDraft(root ? serializeComposer(root) : "");
  }, []);

  /** 清空输入框（发送后用） */
  const clearComposer = useCallback(() => {
    const root = composerRef.current;
    if (root) root.innerHTML = "";
    setDraft("");
  }, []);

  /**
   * 把一个位置引用插成 chip：光标在输入框里就插到光标处，否则追加到末尾。
   * chip 是 contentEditable=false 的原子节点，退格一次删整块。
   */
  const insertRefAt = useCallback(
    (location: EditorLocation) => {
      const root = composerRef.current;
      if (!root) return;

      const chip = createChip(location);
      const selection = window.getSelection();
      const atCaret = Boolean(
        selection && selection.rangeCount > 0 && root.contains(selection.anchorNode),
      );

      if (atCaret) {
        insertAtCaret(chip);
        root.focus();
      } else {
        // 末尾是普通文字就先补个空格，免得和 chip 粘成一串
        const last = root.lastChild;
        if (last?.nodeType === Node.TEXT_NODE && !/\s$/.test(last.textContent ?? "")) {
          root.appendChild(document.createTextNode(" "));
        }
        root.appendChild(chip);
        focusComposerEnd(root);
      }
      syncDraft();
    },
    [syncDraft],
  );

  // 编辑器浮窗「复制到智能体输入框」送进来的位置引用：先挂起，等面板就绪后再插进去。
  // 面板没就绪时（还在 starting / error）body 里根本没有输入框，直接插会丢
  const insertRef = useCallback((location: EditorLocation) => {
    setPendingRef(location);
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || conversation.streaming) return;

    clearComposer();
    // 用户消息不本地插：等 runStarted 回来，省得和真实消息对不上
    setConversation((current) => ({ ...current, streaming: true, error: null }));

    // 会话是发出第一句时才建的：还没会话就先建一个。
    // 必须先 setCurrentId 再发消息——事件处理器靠 currentIdRef 认会话，晚一步这条消息的事件就被丢了
    let sessionId = currentIdRef.current;
    if (!sessionId) {
      try {
        const session = await createAgentSession(root);
        sessionId = session.id;
        setCurrentId(sessionId);
        if (root) window.sessionStorage.setItem(SESSION_KEY_PREFIX + root, sessionId);
        void refreshSessions();
      } catch (reason) {
        setConversation((current) => ({ ...current, streaming: false, error: String(reason) }));
        return;
      }
    }

    void sendAgentMessage(root, sessionId, text, sendModel).catch((reason) => {
      setConversation((current) => ({
        ...current,
        streaming: false,
        error: String(reason),
      }));
    });
  }, [draft, conversation.streaming, sendModel, root, setCurrentId, refreshSessions, clearComposer]);

  const stop = useCallback(() => {
    const sessionId = currentIdRef.current;
    if (!sessionId) return;
    void abortAgentSession(root, sessionId).catch(() => {
      // 掐不断也无所谓：那一轮跑完自然会给 runFinished
    });
  }, [root, currentIdRef]);

  /** 新对话：只把面板清成「等第一句」，会话本身等发送时再建，免得留下一串空记录 */
  const newSession = useCallback(() => {
    setCurrentId(null);
    setConversation(EMPTY_CONVERSATION);
    resetScroll();
  }, [setCurrentId, resetScroll]);

  useEffect(() => {
    if (!pendingRef || phase !== "ready") return;
    setPendingRef(null);
    insertRefAt(pendingRef);
  }, [pendingRef, phase, insertRefAt]);

  useImperativeHandle(ref, () => ({ insertRef }), [insertRef]);

  /** 侧边栏确认删了一条历史会话：删掉后刷新列表；删的正好是当前这条就退到最近的一条 */
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await deleteAgentSession(root, id);
      } catch (reason) {
        setConversation((current) => ({ ...current, error: String(reason) }));
        return;
      }
      // 会话没了，它那份「在等用户」标记也一并丢掉，别留成点了没反应的死标记
      clearAttention(agentTarget(id));
      const list = await refreshSessions();
      if (id !== currentIdRef.current) return;
      if (list[0]) {
        setConversation(EMPTY_CONVERSATION);
        void openSession(list[0].id);
      } else {
        // 一条都不剩了：回到「等第一句」的空态，别再自动建一条空会话出来
        newSession();
      }
    },
    [refreshSessions, openSession, newSession, currentIdRef, clearAttention],
  );

  // 侧边栏确认删除后置上 id，真正删的动作在这儿做（和 requestedId 一个路子）。
  // 必须写在 deleteSession 之后：依赖数组是在渲染期求值的，放前面会撞上 TDZ
  useEffect(() => {
    if (!requestedDeleteId) return;
    clearDeleteRequest();
    void deleteSession(requestedDeleteId);
  }, [requestedDeleteId, clearDeleteRequest, deleteSession]);

  // 侧边栏确认改名后置上 id 和新标题，真正改的动作在这儿做（和 requestedDeleteId 一个路子）。
  // 面板自己不显示会话标题，改完刷一遍列表就行，侧边栏那边自然会换字
  useEffect(() => {
    if (!requestedRename) return;
    const { id, title } = requestedRename;
    clearRenameRequest();
    void renameAgentSession(root, id, title)
      .then(() => refreshSessions())
      .catch((reason) => {
        setConversation((current) => ({ ...current, error: String(reason) }));
      });
  }, [requestedRename, clearRenameRequest, refreshSessions]);

  // 侧边栏那个「+」：服务就绪才把面板清成新对话，没就绪就先挂着等 phase 变 ready
  useEffect(() => {
    if (!requestedNew || phase !== "ready") return;
    clearNewRequest();
    newSession();
  }, [requestedNew, phase, clearNewRequest, newSession]);

  const messages = useMemo(
    () => conversation.order.map((id) => conversation.byId[id]).filter(Boolean),
    [conversation],
  );

  // 只有最后一条助手消息算「还在写」，其余的都按完成态渲染 markdown
  const streamingId = useMemo(() => {
    if (!conversation.streaming) return null;
    for (let index = conversation.order.length - 1; index >= 0; index -= 1) {
      const message = conversation.byId[conversation.order[index]];
      if (message?.role === "assistant") return message.id;
    }
    return null;
  }, [conversation]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    // 输入法组合中的回车是在选字，不能当发送
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (event.shiftKey) {
      // 换行直接往光标处塞一个 \n 文本节点（容器上是 pre-wrap），不能用 execCommand——
      // 后者被浏览器当成段落级换行，生成 <div><br></div>，序列化时换行就丢了
      const root = composerRef.current;
      const selection = window.getSelection();
      if (root && selection && root.contains(selection.anchorNode)) {
        insertAtCaret(document.createTextNode("\n"));
        syncDraft();
      }
      return;
    }
    send();
  };

  // 富文本粘进来会带一堆标签，序列化和视觉都不可控；只收纯文本
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) document.execCommand("insertText", false, text);
  };

  // chip 上那个删除按钮：整块移除，光标落到原来那块的位置，接着打字不会跳到开头。
  // 用委托而不是给每个 chip 挂监听——chip 是拼出来的 DOM，还可能被复制粘贴
  const onComposerClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.closest("[data-chip-del]")) return;
    const root = composerRef.current;
    const chip = target.closest("[data-location]");
    if (!root || !chip) return;

    const next = chip.nextSibling;
    const prev = chip.previousSibling;
    chip.remove();
    root.focus();

    const range = document.createRange();
    if (next) range.setStartBefore(next);
    else if (prev) range.setStartAfter(prev);
    else range.selectNodeContents(root);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    syncDraft();
  };

  if (phase === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded border border-line bg-app p-4 text-center">
          <div className="text-[12px] leading-relaxed text-fg-muted">{fatal}</div>
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => void boot()}
              className="rounded border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              重试
            </button>
            {/* 这一屏没有标题栏，关闭按钮得在这儿给一个，否则只能靠 Esc */}
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase !== "ready") {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-fg-faint">
        正在启动应用助手…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="shrink-0 text-[12px] font-medium text-fg">{APP_AGENT_LABEL}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
          Rig ·{" "}
          {/* 只在真配了提供商时才把引用译成名字：开发调试下提供商是后端合成的，
              译出来会是 `codovo/xxx`，不如直接显示 .env 里的模型名 */}
          {(settings.aiProviders.length > 0 && sendModel
            ? modelRefLabel(settings, sendModel)
            : aiConfig.model) || "未配置模型"}
        </span>
        {/* 历史 / 新建：面板里这一份是为了不用去侧栏就能切会话 */}
        <AgentHistoryMenu
          sessions={sessions}
          currentId={currentId}
          onOpen={(id) => void openSession(id)}
          onNew={newSession}
          onRename={requestRename}
          onDelete={setPendingDelete}
          waitingKinds={waitingKinds}
        />
        <IconButton label="新建对话" onClick={newSession}>
          <IconPlus className={ICON_SM} />
        </IconButton>
        <IconButton label="关闭助手" onClick={onClose}>
          <IconClose className={ICON_SM} />
        </IconButton>
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
                问答 Codovo 用法，或让它改设置与界面
              </div>
              <div className="text-[12px] leading-relaxed text-fg-faint">
                改设置、加 / 删工作区、切右栏模块；不可逆操作会先弹确认框
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

      {/* 输入区是一整块圆角卡片：底色用 app、和面板的 surface 拉开一层，
          边界交给边框而不是分隔线，看着更像现代的对话输入框 */}
      <div className="shrink-0 px-3 pt-1 pb-3">
        <div className="rounded-2xl border border-line bg-app px-3 pt-3 pb-2 transition-colors focus-within:border-line-hover">
          {/* 输入框自己不留内边距：自动长高量的是它的 scrollHeight，留了会把高度算虚。
              用 contenteditable 而不是 textarea，位置引用才能插成一个可整体删除的 chip */}
          <div
            ref={composerRef}
            contentEditable
            role="textbox"
            aria-multiline="true"
            onInput={syncDraft}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onClick={onComposerClick}
            data-placeholder="问 Codovo 用法，或让它改设置与界面…"
            className="agent-composer min-h-6 max-h-40 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-[13px] leading-relaxed text-fg outline-none"
          />
          <div className="mt-1 flex items-center gap-2">
            {/* 键盘提示常驻在底行，占位文案就能只留一句人话 */}
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
              Enter 发送 · Shift+Enter 换行
            </span>
            {conversation.streaming ? (
              <button type="button" onClick={stop} title="停止" className={STOP_BUTTON}>
                <IconStop className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
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
            requestDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
