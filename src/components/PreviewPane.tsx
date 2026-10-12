import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FullscreenButton } from "./FullscreenButton";
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconRefresh,
} from "./icons";
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

/**
 * 右栏的「预览」模块：探测当前工作区是什么项目，一键起/停预览进程。
 *
 * - web：起 dev server，拿到地址后用内嵌 iframe 看。
 * - Tauri 桌面：起带 CDP 调试端口的 `tauri dev`，面板里显示端口，交给 CDP 工具驱动验证。
 *
 * 和「浏览器」模块的分工：浏览器是手动填地址的通用窗口，这里是按项目自动起进程。
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
  const [detection, setDetection] = useState<PreviewDetection | null>(null);
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customPort, setCustomPort] = useState("");
  const [showLogs, setShowLogs] = useState(true);
  /** 变一次就重挂 iframe，等于刷新 */
  const [nonce, setNonce] = useState(0);

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
    void runDetect();
  }, [runDetect]);

  // 状态轮询：只在面板可见时跑，收起 / 停在别的模块就短路
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await previewStatus(root);
        if (!stopped) setStatus(next);
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

  const running = status?.running === true;
  const url = status?.url ?? null;
  const cdpPort = status?.cdpPort ?? null;
  const kind = detection?.kind ?? status?.kind ?? "unknown";
  const command = running ? (status?.command ?? "") : (detection?.command ?? "");
  const logs = status?.logs ?? [];
  const warnings = detection?.warnings ?? [];

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface">
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
                用 CDP 工具连 127.0.0.1:{cdpPort} 做界面验证；输出见下方日志。
              </p>
            </div>
          </div>
        ) : running ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
              已启动，正在等待 dev server 就绪。地址会从输出里自动识别，见下方日志。
            </p>
          </div>
        ) : (
          <div className="h-full overflow-auto px-4 py-4">
            <div className="mx-auto max-w-[400px] space-y-3 text-[12px]">
              {error && <p className="leading-relaxed text-warn">{error}</p>}
              <div>
                <p className="text-fg-dim">
                  项目类型：
                  <span className="ml-1 text-fg">{KIND_LABEL[kind] ?? kind}</span>
                </p>
                {detection?.reason && (
                  <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
                    {detection.reason}
                  </p>
                )}
              </div>

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
                onClick={start}
                disabled={busy || !customCommand.trim()}
                className="h-7 w-full rounded bg-accent text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "启动中…" : "启动预览"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line">
        <button
          type="button"
          onClick={() => setShowLogs((show) => !show)}
          className="flex h-7 w-full items-center gap-1 px-3 text-[11px] text-fg-dim hover:bg-hover"
        >
          {showLogs ? (
            <IconChevronDown className="h-3 w-3" />
          ) : (
            <IconChevronRight className="h-3 w-3" />
          )}
          日志{logs.length > 0 ? `（${logs.length}）` : ""}
        </button>
        {showLogs && (
          <pre className="max-h-40 overflow-auto bg-app px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-fg-dim">
            {logs.length > 0 ? logs.join("\n") : "（暂无输出）"}
          </pre>
        )}
      </div>
    </section>
  );
}
