import { useCallback, useEffect, useRef, useState } from "react";
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
import { PreviewAgent } from "./PreviewAgent";
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

/** 子视图切换按钮的样式，和数据库面板那边的子标签一致 */
const SEGMENT = "rounded px-2 py-0.5 text-[11px]";

const KIND_LABEL: Record<string, string> = {
  web: "Web",
  tauri: "Tauri 桌面",
  unknown: "未知",
};

/** 面板主体分三块：默认是助手对话（核心），另有预览画面与进程日志两个标签 */
type SubTab = "assistant" | "view" | "logs";

/**
 * 右栏的「预览」模块：**核心是助手对话**，按当前工作区的实际情况把项目跑起来，
 * 看日志、起不来时诊断纠错；顶栏按钮与「画面」标签是配套的手动操作入口。
 *
 * - 助手：一个绑定本工作区的预览助手（见 `PreviewAgent`），带一组预览 MCP 工具，
 *   cwd 就是本工作区，所以能自己看项目、按项目特征决定怎么起。
 * - 画面：web 项目起 dev server、内嵌 iframe 看；Tauri 桌面起带 CDP 调试端口的实例，
 *   面板显示端口。命令 / 端口都能手改。
 * - 日志：实时滚动子进程输出，进程自己退出也会收到事件刷新状态。
 *
 * 和「浏览器」模块的分工：浏览器是手动填地址的通用窗口，这里是按项目自动起进程。
 *
 * 结构对齐「部署」模块：头部主操作 + 可折叠常驻配置区 + 独立错误条（失败可 AI 诊断）+
 * 日志区自动滚到底。差别在于主体是助手对话，画面与日志各占一个标签。
 */
export function PreviewPane({
  root,
  visible,
  focused,
  fullscreen,
  onToggleFullscreen,
}: {
  root: string;
  /** 面板是不是真的露在用户眼前（右栏展开且当前看的正是它）。收起时轮询短路 */
  visible: boolean;
  /** 这个工作区是不是当前显示的工作区。非当前时助手不拉服务（免得给隐藏工作区白起进程） */
  focused: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const [detection, setDetection] = useState<PreviewDetection | null>(null);
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customPort, setCustomPort] = useState("");
  const [configOpen, setConfigOpen] = useState(true);
  /** 变一次就重挂 iframe，等于刷新 */
  const [nonce, setNonce] = useState(0);
  /** 主体默认给助手对话——它才是这个面板的核心 */
  const [tab, setTab] = useState<SubTab>("assistant");
  /** AI 辅助：生效的模型配置 + 是否正在诊断 */
  const { config: aiConfig, ready: aiReady } = useEffectiveAiConfig();
  const [aiBusy, setAiBusy] = useState(false);
  const [dialog, setDialog] = useState<{
    title: string;
    text: string | null;
    error: string | null;
  } | null>(null);
  /**
   * 进程退出后后端会清空槽位（日志一并没了），所以轮询时把最近一次非空输出留一份，
   * 供「AI 诊断」用。
   */
  const lastLogRef = useRef<{ command: string; logs: string[] }>({ command: "", logs: [] });
  const logRef = useRef<HTMLDivElement | null>(null);

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
    lastLogRef.current = { command: "", logs: [] };
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

  // 日志自动滚到底（和部署模块一致）；切到「日志」标签时也补一次，免得隐藏期间停在顶部
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [status?.logs, tab]);

  const start = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const portText = customPort.trim();
      const port = portText ? Number(portText) : undefined;
      const next = await startPreview(root, {
        command: customCommand.trim() || undefined,
        port: Number.isFinite(port) ? port : undefined,
      });
      setStatus(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [root, customCommand, customPort]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
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
          disabled={busy}
          title={running ? "停止预览" : "启动预览"}
          className="flex h-6 shrink-0 items-center gap-1 rounded border border-line-strong px-2 text-[11px] text-fg hover:bg-hover disabled:opacity-50"
        >
          {running ? (
            <IconStop className="h-3.5 w-3.5" />
          ) : (
            <IconPlay className="h-3.5 w-3.5" />
          )}
          {running ? "停止" : "启动"}
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

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-danger-bg px-3 py-1.5 text-[11px] leading-relaxed text-danger">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => void diagnose()}
            disabled={!aiReady || aiBusy}
            title={aiReady ? "让大模型分析启动失败原因" : "先在「设置 → 智能体 → 模型提供商」里配置"}
            className="h-6 shrink-0 rounded border border-danger-line px-2 text-[11px] text-danger hover:bg-hover disabled:opacity-50"
          >
            {aiBusy ? "分析中…" : "AI 诊断"}
          </button>
        </div>
      )}

      {/* 主体子标签：助手（核心）/ 画面 / 日志 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="flex items-center gap-0.5 rounded-md border border-line-strong p-0.5">
          <button
            type="button"
            onClick={() => setTab("assistant")}
            className={`${SEGMENT} ${tab === "assistant" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
          >
            助手
          </button>
          <button
            type="button"
            onClick={() => setTab("view")}
            className={`${SEGMENT} ${tab === "view" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
          >
            画面
          </button>
          <button
            type="button"
            onClick={() => setTab("logs")}
            className={`${SEGMENT} ${tab === "logs" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
          >
            日志{logs.length > 0 ? `（${logs.length}）` : ""}
          </button>
        </div>
      </div>

      {/* 助手：常挂载、只切可见性，来回切标签对话不丢。非当前工作区时不拉服务 */}
      <div className={tab === "assistant" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
        <PreviewAgent root={root} active={visible && focused && tab === "assistant"} />
      </div>

      {/* 画面：配置 + 预览内容 */}
      <div className={tab === "view" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
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

        <div className="relative min-h-0 flex-1">
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
                  用 CDP 工具连 127.0.0.1:{cdpPort} 做界面验证；输出见「日志」标签。
                </p>
              </div>
            </div>
          ) : running ? (
            <div className="flex h-full items-center justify-center px-6">
              <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
                已启动，正在等待 dev server 就绪。地址会从输出里自动识别，见「日志」标签。
              </p>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
                配置好启动命令后，点右上角「启动」运行预览。
              </p>
            </div>
          )}
        </div>

      </div>

      {/* 日志：占据整个主体，实时滚动 */}
      <div className={tab === "logs" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
        <div
          ref={logRef}
          className="min-h-0 flex-1 overflow-auto bg-app px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-dim"
        >
          {logs.length > 0 ? logs.join("\n") : "（暂无输出）"}
        </div>
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
