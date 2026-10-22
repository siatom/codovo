import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExplainChangeDialog } from "./ExplainChangeDialog";
import { FullscreenButton } from "./FullscreenButton";
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconPlay,
  IconRefresh,
  IconStop,
} from "./icons";
import { diagnosePreview, useEffectiveAiConfig } from "../lib/ai";
import { PREVIEW_AGENT_LABEL } from "../lib/agent-profiles";
import { previewAgentRoot } from "../lib/preview-agent";
import {
  EMPTY_CONVERSATION,
  abortAgentSession,
  createAgentSession,
  onAgentEvent,
  onAgentExit,
  reduceAgentEvent,
  sendAgentMessage,
  startAgent,
} from "../lib/agent";
import { enabledModels, enabledProviders, resolveDefaultModel } from "../lib/providers";
import { useSettings } from "../lib/settings";
import type { AgentConversation } from "../lib/types";
import { LogResizeHandle, readStoredLogHeight, writeStoredLogHeight } from "./LogResizeHandle";
import {
  detectPreview,
  onPreviewExit,
  previewStatus,
  startPreview,
  stopPreview,
  type PreviewDetection,
  type PreviewStatus,
} from "../lib/preview";

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

const INPUT =
  "mt-1 h-7 w-full rounded border border-line-strong bg-surface px-2 text-[12px] text-fg outline-none placeholder:text-fg-faint focus:border-accent";

const KIND_LABEL: Record<string, string> = {
  web: "Web",
  tauri: "Tauri 桌面",
  unknown: "未知",
};

/** 日志区高度按工作目录记；上下限在拖动时再受面板高度约束 */
const LOG_HEIGHT_KEY = "codovo.previewLogHeight.";
const DEFAULT_LOG_HEIGHT = 224;
const MIN_LOG_HEIGHT = 80;
const MAX_LOG_HEIGHT = 600;
/** 拖到最高时，上面的预览内容至少留这么高 */
const PREVIEW_MIN_HEIGHT = 120;

/**
 * 把一轮对话压成日志行：助手正文原样铺开，工具调用收成一行 `▸ 名字 · 摘要`。
 * 面板没有对话界面，这些就是「opencode 的执行过程」。
 */
function transcriptLines(conversation: AgentConversation): string[] {
  const lines: string[] = [];
  for (const id of conversation.order) {
    const message = conversation.byId[id];
    if (!message || message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        const text = part.text.trim();
        if (text) lines.push(text);
      } else if (part.type === "tool") {
        const summary = part.state.title?.trim();
        const failed = part.state.status === "error" ? " ✗" : "";
        lines.push(`▸ ${part.tool}${summary ? ` · ${summary}` : ""}${failed}`);
      }
    }
  }
  return lines;
}

/**
 * 右栏的「预览」模块：点「启动」由**内置预览助手**按项目决定怎么起，然后把结果（页面 /
 * CDP 端口）呈现出来，助手的执行过程与预览进程输出一起显示在下方日志里。
 *
 * - web：起 dev server，拿到地址后用内嵌 iframe 看。
 * - Tauri 桌面：起带 CDP 调试端口的 `tauri dev`，面板里显示端口，交给 CDP 工具驱动验证。
 *
 * 没配模型提供商时退回到「按探测结果直接起」，面板不至于整个用不了。
 * 和「浏览器」模块的分工：浏览器是手动填地址的通用窗口，这里是按项目自动起进程。
 *
 * 结构对齐「部署」模块：头部主操作 + 可折叠常驻配置区 + 独立错误条（失败可 AI 诊断）+
 * 日志区自动滚到底。中间留了一块 flex-1 的预览内容（iframe / 提示），
 * 所以日志区做成底部折叠、高度可拖动（上限受面板高度和预览区最小高度约束）。
 */
export function PreviewPane({
  root,
  visible,
  fullscreen,
  onToggleFullscreen,
}: {
  root: string;
  /** 面板是不是真的露在用户眼前（右栏展开且当前看的正是它）。收起时轮询短路 */
  visible: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { settings } = useSettings();
  const { agentCommand, agentPort } = settings;
  const { config: aiConfig, ready: aiReady } = useEffectiveAiConfig();

  const [detection, setDetection] = useState<PreviewDetection | null>(null);
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customPort, setCustomPort] = useState("");
  const [configOpen, setConfigOpen] = useState(true);
  const [showLogs, setShowLogs] = useState(true);
  /** 变一次就重挂 iframe，等于刷新 */
  const [nonce, setNonce] = useState(0);
  /** 预览助手的这一轮执行过程（正文 + 工具调用），渲染成日志 */
  const [conversation, setConversation] = useState<AgentConversation>(EMPTY_CONVERSATION);
  const [aiBusy, setAiBusy] = useState(false);
  const [dialog, setDialog] = useState<{
    title: string;
    text: string | null;
    error: string | null;
  } | null>(null);
  /** 助手复用一个会话：一次启动一轮，历史留着让它在重试时有上下文 */
  const sessionIdRef = useRef<string | null>(null);
  /**
   * 进程退出后后端会清空槽位（日志一并没了），所以轮询时把最近一次非空输出留一份，
   * 供「AI 诊断」用。
   */
  const lastLogRef = useRef<{ command: string; logs: string[] }>({ command: "", logs: [] });
  const logRef = useRef<HTMLDivElement | null>(null);
  /** 预览内容区：拖日志高度时靠它算「还能长多高」，保证上面不被挤没 */
  const previewRef = useRef<HTMLDivElement | null>(null);
  /** 日志区（含标题行）高度，可按工作目录记住 */
  const [logHeight, setLogHeight] = useState(() =>
    readStoredLogHeight(LOG_HEIGHT_KEY + root, MIN_LOG_HEIGHT, MAX_LOG_HEIGHT, DEFAULT_LOG_HEIGHT),
  );

  /** 拖动上限：日志长高的同时预览区变矮，所以按两者当前高度现算 */
  const maxLogHeight = () => {
    const preview = previewRef.current?.clientHeight ?? 0;
    return Math.min(
      MAX_LOG_HEIGHT,
      logHeight + Math.max(0, preview - PREVIEW_MIN_HEIGHT),
    );
  };

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

  const runDetect = useCallback(async () => {
    try {
      const result = await detectPreview(root);
      setDetection(result);
      setCustomCommand(result.command);
      setCustomPort(result.port != null ? String(result.port) : "");
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, [root]);

  // 切工作区 / 首次挂载：重置并重新探测
  useEffect(() => {
    setDetection(null);
    setStatus(null);
    setError("");
    setConversation(EMPTY_CONVERSATION);
    sessionIdRef.current = null;
    lastLogRef.current = { command: "", logs: [] };
    setLogHeight(
      readStoredLogHeight(LOG_HEIGHT_KEY + root, MIN_LOG_HEIGHT, MAX_LOG_HEIGHT, DEFAULT_LOG_HEIGHT),
    );
    void runDetect();
  }, [runDetect]);

  // 状态轮询：只在面板可见时跑，收起 / 停在别的模块就短路
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await previewStatus(root);
        if (stopped) return;
        setStatus(next);
        // 留一份最近的输出，进程退出后还能拿它做诊断
        if (next.logs.length > 0) {
          lastLogRef.current = {
            command: next.command || lastLogRef.current.command,
            logs: next.logs,
          };
        }
      } catch {
        // 轮询失败不打扰界面，下一次再试
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [visible, root]);

  // 预览进程自己退出（dev server 崩了）时刷新状态
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPreviewExit((exitRoot, code) => {
      if (exitRoot !== root) return;
      void previewStatus(root).then(setStatus);
      if (code !== 0) setError(`预览进程退出，退出码 ${code}`);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [root]);

  // 预览助手的执行过程：后端全量转发事件，只认本面板那个哨兵 root，再按会话归并
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const sentinel = previewAgentRoot(root);
    void onAgentEvent((eventRoot, event) => {
      if (eventRoot !== sentinel) return;
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      setConversation((current) => reduceAgentEvent(current, event, sessionId));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [root]);

  // 助手进程自己挂了：把还在流式的状态收干净，免得按钮一直转
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const sentinel = previewAgentRoot(root);
    void onAgentExit((eventRoot) => {
      if (eventRoot !== sentinel) return;
      setConversation((current) => ({ ...current, streaming: false }));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [root]);

  const agentLines = useMemo(() => transcriptLines(conversation), [conversation]);

  // 日志自动滚到底（和部署模块一致）
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [status?.logs, agentLines]);

  /**
   * 启动：默认交给预览助手——它自己探测项目、决定命令并起进程；用户手改过命令 / 端口
   * 就随指令一并带过去。没配模型时退回到按探测结果直接起（面板仍可用）。
   */
  const start = useCallback(async () => {
    setError("");
    const command = customCommand.trim();
    const portText = customPort.trim();

    if (!aiReady) {
      setBusy(true);
      try {
        const port = portText ? Number(portText) : undefined;
        setStatus(
          await startPreview(root, {
            command: command || undefined,
            port: Number.isFinite(port) ? port : undefined,
          }),
        );
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    setConversation(EMPTY_CONVERSATION);
    try {
      // 手改过才当覆盖下发给助手：和探测结果一样就让它自己判断
      const detectedCommand = detection?.command ?? "";
      const detectedPort = detection?.port != null ? String(detection.port) : "";
      let prompt = "启动这个项目的预览。";
      if (command && command !== detectedCommand) prompt += ` 用这个启动命令：${command}。`;
      if (portText && portText !== detectedPort) prompt += ` 端口用 ${portText}。`;
      prompt += " 起好后用一句话汇报地址或 CDP 调试端口。";

      await startAgent(previewAgentRoot(root), {
        command: agentCommand,
        port: agentPort,
        providers,
        defaultModel: modelRef,
        rules: "",
        memory: "",
        skills: [],
        agents: [],
        primary: "",
        preview: true,
        workspaceRoot: root,
      });

      let sessionId = sessionIdRef.current;
      if (!sessionId) {
        sessionId = (await createAgentSession(previewAgentRoot(root), "预览启动")).id;
        sessionIdRef.current = sessionId;
      }
      await sendAgentMessage(previewAgentRoot(root), sessionId, prompt, modelRef);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [
    aiReady,
    root,
    customCommand,
    customPort,
    detection,
    agentCommand,
    agentPort,
    providers,
    modelRef,
  ]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void abortAgentSession(previewAgentRoot(root), sessionId).catch(() => {
          // 中止失败无所谓：进程停掉就行，事件那边也会以 session.idle 收尾
        });
      }
      await stopPreview(root);
      setStatus(await previewStatus(root));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [root]);

  /** 把启动命令与最近的日志交给大模型诊断，结果走居中弹窗 */
  const diagnose = useCallback(async () => {
    const command = lastLogRef.current.command || customCommand.trim();
    const log = lastLogRef.current.logs.join("\n");
    const title = command || "预览启动失败";

    setDialog({ title, text: null, error: null });
    setAiBusy(true);
    try {
      const text = await diagnosePreview(root, aiConfig, command, log);
      setDialog({ title, text, error: null });
    } catch (reason) {
      setDialog({ title, text: null, error: String(reason) });
    } finally {
      setAiBusy(false);
    }
  }, [root, aiConfig, customCommand]);

  const running = status?.running === true;
  const url = status?.url ?? null;
  const cdpPort = status?.cdpPort ?? null;
  const kind = detection?.kind ?? status?.kind ?? "unknown";
  const command = running ? (status?.command ?? "") : (detection?.command ?? "");
  const logs = status?.logs ?? [];
  const warnings = detection?.warnings ?? [];
  /** 助手还在跑（探测 / 启进程中）：按钮转起来，预览区换成进度提示 */
  const agentBusy = conversation.streaming;
  const banner = error || conversation.error || "";

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-content">
      <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${running ? "bg-accent" : "bg-line-strong"}`}
          title={running ? "预览运行中" : "未运行"}
        />
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-fg-dim">
          预览
        </span>
        <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-fg-dim">
          {KIND_LABEL[kind] ?? kind}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-fg-faint"
          title={command}
        >
          {command}
        </span>
        <button
          type="button"
          onClick={running ? stop : start}
          disabled={running ? busy : busy || agentBusy}
          title={running ? "停止预览" : "由预览助手启动预览"}
          className="flex h-6 shrink-0 items-center gap-1 rounded border border-line-strong px-2 text-[11px] text-fg hover:bg-hover disabled:opacity-50"
        >
          {running ? (
            <IconStop className="h-3.5 w-3.5" />
          ) : (
            <IconPlay className="h-3.5 w-3.5" />
          )}
          {running ? "停止" : agentBusy ? "启动中…" : "启动"}
        </button>
        <button
          type="button"
          onClick={() => setNonce((count) => count + 1)}
          disabled={!url}
          title="重新加载"
          className={HEAD_BUTTON}
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => url && void openUrl(url).catch(() => {})}
          disabled={!url}
          title="用系统浏览器打开"
          className={HEAD_BUTTON}
        >
          <IconExternalLink className="h-3.5 w-3.5" />
        </button>
        <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
      </header>

      {warnings.length > 0 && (
        <div className="shrink-0 border-b border-line bg-warn-bg px-3 py-1.5 text-[11px] leading-relaxed text-warn">
          {warnings.join("；")}
        </div>
      )}

      {banner && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-danger-bg px-3 py-1.5 text-[11px] leading-relaxed text-danger">
          <span className="min-w-0 flex-1">{banner}</span>
          <button
            type="button"
            onClick={() => void diagnose()}
            disabled={!aiReady || aiBusy}
            title={
              aiReady
                ? "让大模型分析启动失败原因"
                : "先在「设置 → 智能体 → 模型提供商」里配置"
            }
            className="h-6 shrink-0 rounded border border-danger-line px-2 text-[11px] text-danger hover:bg-hover disabled:opacity-50"
          >
            {aiBusy ? "分析中…" : "AI 诊断"}
          </button>
        </div>
      )}

      {/* 配置区：可折叠常驻，运行中也能改（改完重新启动生效） */}
      <div className="shrink-0 border-b border-line">
        <button
          type="button"
          onClick={() => setConfigOpen((open) => !open)}
          className="flex h-7 w-full items-center gap-1 px-3 text-[11px] text-fg-dim hover:bg-hover"
        >
          {configOpen ? (
            <IconChevronDown className="h-3 w-3" />
          ) : (
            <IconChevronRight className="h-3 w-3" />
          )}
          <span>配置</span>
          <span className="min-w-0 flex-1 truncate text-right text-fg-faint">
            {detection?.reason ?? ""}
          </span>
        </button>
        {configOpen && (
          <div className="space-y-2 px-3 pb-2">
            <label className="block">
              <span className="text-fg-dim">启动命令</span>
              <input
                value={customCommand}
                onChange={(event) => setCustomCommand(event.target.value)}
                placeholder={detection ? "" : "探测中…"}
                spellCheck={false}
                className={INPUT}
              />
            </label>

            {kind === "web" && (
              <label className="block">
                <span className="text-fg-dim">端口</span>
                <input
                  value={customPort}
                  onChange={(event) => setCustomPort(event.target.value)}
                  placeholder="留空则用探测到的端口"
                  spellCheck={false}
                  className={INPUT}
                />
              </label>
            )}

            <button
              type="button"
              onClick={() => void runDetect()}
              className="h-6 rounded border border-line-strong px-2 text-[11px] text-fg hover:bg-hover"
            >
              按项目重新探测
            </button>
          </div>
        )}
      </div>

      <div ref={previewRef} className="relative min-h-0 flex-1">
        {running && url ? (
          // 页面多半按白底设计，深色主题下不给白底会透出面板色
          <iframe
            key={nonce}
            src={url}
            title="预览"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        ) : running && cdpPort ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-[380px] text-center text-[12px] leading-relaxed text-fg-dim">
              <p>
                已启动 Tauri 开发实例，CDP 调试端口{" "}
                <span className="font-medium text-fg">{cdpPort}</span>。
              </p>
              <p className="mt-2 text-fg-faint">
                用 CDP 工具连 127.0.0.1:{cdpPort} 做界面验证；输出见下方日志。
              </p>
            </div>
          </div>
        ) : agentBusy ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
              {PREVIEW_AGENT_LABEL}正在分析项目并启动预览…
            </p>
          </div>
        ) : running ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
              已启动，正在等待 dev server 就绪。地址会从输出里自动识别，见下方日志。
            </p>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
              点右上角「启动」，{PREVIEW_AGENT_LABEL}会按项目决定怎么起；也可以在「配置」里手改命令或端口。
            </p>
          </div>
        )}
      </div>

      {/* 日志区高度可拖：条在日志上方，往上拖就是把日志拉高；收起日志时不画 */}
      {showLogs && (
        <LogResizeHandle
          height={logHeight}
          min={MIN_LOG_HEIGHT}
          max={maxLogHeight}
          onChange={setLogHeight}
          onCommit={(height) => writeStoredLogHeight(LOG_HEIGHT_KEY + root, height)}
          onReset={() => {
            setLogHeight(DEFAULT_LOG_HEIGHT);
            writeStoredLogHeight(LOG_HEIGHT_KEY + root, DEFAULT_LOG_HEIGHT);
          }}
        />
      )}

      <div
        className="flex min-h-0 shrink-0 flex-col border-t border-line"
        style={showLogs ? { height: logHeight } : undefined}
      >
        <button
          type="button"
          onClick={() => setShowLogs((show) => !show)}
          className="flex h-7 w-full shrink-0 items-center gap-1 px-3 text-[11px] text-fg-dim hover:bg-hover"
        >
          {showLogs ? (
            <IconChevronDown className="h-3 w-3" />
          ) : (
            <IconChevronRight className="h-3 w-3" />
          )}
          日志{logs.length > 0 ? `（${logs.length}）` : ""}
        </button>
        {showLogs && (
          <div
            ref={logRef}
            className="min-h-0 flex-1 overflow-auto bg-app px-3 py-2 text-[11px] leading-relaxed"
          >
            {agentLines.length > 0 && (
              <div className="mb-2">
                <div className="mb-0.5 font-mono text-[10px] tracking-wide text-fg-faint">
                  智能体
                </div>
                {agentLines.map((line, index) =>
                  line.startsWith("▸") ? (
                    <div key={index} className="font-mono text-fg-faint">
                      {line}
                    </div>
                  ) : (
                    <div key={index} className="whitespace-pre-wrap text-fg-dim">
                      {line}
                    </div>
                  ),
                )}
              </div>
            )}
            <div className="mb-0.5 font-mono text-[10px] tracking-wide text-fg-faint">
              预览进程
            </div>
            <div className="font-mono whitespace-pre-wrap text-fg-dim">
              {logs.length > 0 ? logs.join("\n") : "（暂无输出）"}
            </div>
          </div>
        )}
      </div>

      {dialog && (
        <ExplainChangeDialog
          title={dialog.title}
          text={dialog.text}
          error={dialog.error}
          onClose={() => setDialog(null)}
          titlePrefix="预览诊断"
          loadingText="正在分析启动日志…"
        />
      )}
    </section>
  );
}
