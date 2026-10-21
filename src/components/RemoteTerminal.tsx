import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  readImage,
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";
import {
  isLayoutAnimating,
  onLayoutAnimationStart,
  onLayoutSettled,
} from "../lib/layout-motion";
import { isPrimaryModifier } from "../lib/keys";
import { matchesShortcut } from "../lib/shortcuts";
import {
  connectRemote,
  type RemoteConnectionState,
  type RemoteHandle,
  type RemoteHost,
} from "../lib/remote";
import { resolveFont, useSettings } from "../lib/settings";
import { TUI_MODE_RESET, watchAltScreenExit } from "../lib/terminal-modes";
import { resolveTerminalTheme } from "../lib/terminal-themes";
import { useTheme } from "../lib/theme";
import { pauseDevicePixelSync } from "../lib/xterm-webgl";
import { IconArrowDownToLine } from "./icons";

/**
 * 走 Tauri 的 clipboard 插件读写系统剪贴板，不用 `navigator.clipboard`：
 * WebView 那套要文档有焦点、WebView2 还会弹系统授权框，插件从 Rust 侧直接读写。
 * （和 TerminalSession 里的同名工具一致，那边是本地 shell 用的，这里不共用、免得动它。）
 */
async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    // 复制失败没有可补救的动作，静默丢弃
  }
}

async function readClipboard(): Promise<string | null> {
  try {
    return await readText();
  } catch {
    return null;
  }
}

/** 剪贴板里有没有图片：CLI 粘图靠「收到原始 Ctrl+V 后自己去读剪贴板」，我们只透传 Ctrl+V */
async function hasClipboardImage(): Promise<boolean> {
  try {
    const image = await readImage();
    await image.close();
    return true;
  } catch {
    return false;
  }
}

interface RemoteTerminalProps {
  host: RemoteHost;
  /** 是否是当前显示的那台：从后台切回来要重新量尺寸并聚焦 */
  active: boolean;
  /** 是否在当前布局中显示 */
  visible: boolean;
  /** 会话建好 / 断开时上报 session id，SFTP 面板要用 */
  onSession: (hostId: string, sessionId: number | null) => void;
  /** 连接状态变化，供主机列表的状态点与错误提示用 */
  onState: (hostId: string, state: RemoteConnectionState) => void;
  /** 首次信任时把服务器指纹交回上层保存 */
  onFingerprint: (hostId: string, fingerprint: string) => void;
  /**
   * 焦点在这个远程终端里时按了「关闭当前标签」/「新建标签页」。标签栏归 RemotePane 管，
   * 会话自己不知道自己是第几个。只有拿到焦点的那一处终端会收到键盘事件，所以这里
   * 和本地终端用同一套键位也不会打架。
   */
  onRequestClose?: () => void;
  onRequestNew?: () => void;
}

/**
 * 一个远程终端会话 = 一个 xterm 实例 + 一条 SSH shell 通道。
 * 结构和 TerminalSession 一样，只是后端换成 remote_connect；断线不自动重连，给个「重连」按钮。
 */
export function RemoteTerminal({
  host,
  active,
  visible,
  onSession,
  onState,
  onFingerprint,
  onRequestClose,
  onRequestNew,
}: RemoteTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<RemoteHandle | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [sessionKey, setSessionKey] = useState(0);
  const { theme, palette } = useTheme();
  const { settings } = useSettings();

  // 建实例的 effect 只认挂载那一刻的主题 / 字体，之后的变化走各自的 effect 单独更新
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const fontSizeRef = useRef(settings.terminalFontSize);
  fontSizeRef.current = settings.terminalFontSize;
  const fontFamilyRef = useRef(settings.terminalFontFamily);
  fontFamilyRef.current = settings.terminalFontFamily;
  const fontBoldRef = useRef(settings.terminalFontBold);
  fontBoldRef.current = settings.terminalFontBold;
  const terminalThemeRef = useRef(settings.terminalTheme);
  terminalThemeRef.current = settings.terminalTheme;
  // GPU 加速：建实例时读一次，改设置只影响之后新建的会话
  const gpuAccelRef = useRef(settings.terminalGpuAcceleration);
  gpuAccelRef.current = settings.terminalGpuAcceleration;

  // 回调每次渲染都可能换身份，而建实例的 effect 依赖里塞不进它们，用 ref 存最新值
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const onFingerprintRef = useRef(onFingerprint);
  onFingerprintRef.current = onFingerprint;
  const hostRef = useRef(host);
  hostRef.current = host;
  // 关 / 新建标签的键位可配置，而建实例的 effect 挂一次就不重建，用 ref 存最新值；
  // 回调每次渲染都换身份，同样只能走 ref 进不了依赖数组
  const closeComboRef = useRef(settings.shortcuts["closeTab"]);
  closeComboRef.current = settings.shortcuts["closeTab"];
  const newComboRef = useRef(settings.shortcuts["newTab"]);
  newComboRef.current = settings.shortcuts["newTab"];
  const onRequestCloseRef = useRef(onRequestClose);
  onRequestCloseRef.current = onRequestClose;
  const onRequestNewRef = useRef(onRequestNew);
  onRequestNewRef.current = onRequestNew;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setError(null);
    setExited(null);
    onStateRef.current(host.id, { phase: "connecting" });

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: resolveFont(fontFamilyRef.current),
      fontSize: fontSizeRef.current,
      fontWeight: fontBoldRef.current ? "bold" : "normal",
      lineHeight: 1.25,
      scrollback: 5000,
      rightClickSelectsWord: false,
      theme: resolveTerminalTheme(terminalThemeRef.current, themeRef.current, paletteRef.current),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    let webgl: WebglAddon | null = null;
    try {
      // 和本地终端同理：WebGL 渲染器在重输出下会花屏，关掉 GPU 加速退回 DOM 渲染器
      if (gpuAccelRef.current) {
        const addon = new WebglAddon();
        addon.onContextLoss(() => addon.dispose());
        term.loadAddon(addon);
        webgl = addon;
      }
    } catch {
      // WebGL 不可用时 xterm 会留在默认渲染器上
      webgl = null;
    }
    try {
      fit.fit();
    } catch {
      // 容器尺寸还没稳定，交给 ResizeObserver
    }

    termRef.current = term;
    fitRef.current = fit;

    const syncAtBottom = () => {
      const buffer = term.buffer.active;
      setAtBottom(buffer.viewportY >= buffer.baseY);
    };
    const scrollDisposable = term.onScroll(syncAtBottom);
    const writeParsedDisposable = term.onWriteParsed(syncAtBottom);

    let cancelled = false;
    // 句柄就绪前先攒着的输入（和 TerminalSession 同理：应答可能比 await 先到）
    let pendingInput: string[] = [];
    // 全屏程序退出（切回主屏）时兜底复位它可能漏关的终端模式，见 lib/terminal-modes
    const altScreenExit = watchAltScreenExit();

    const writeInput = (data: string) => {
      const handle = handleRef.current;
      if (handle) handle.write(data);
      else pendingInput.push(data);
    };

    const start = async () => {
      const handle = await connectRemote({
        host: hostRef.current,
        cols: term.cols,
        rows: term.rows,
        onData: (bytes) => {
          if (cancelled) return;
          term.write(bytes);
          // 远端跑 opencode 这类 TUI 退出时会漏关鼠标 / 焦点上报，提示符上会不断冒乱码
          if (altScreenExit(bytes)) term.write(TUI_MODE_RESET);
        },
        onExit: (message) => {
          if (cancelled) return;
          setExited(message);
          onStateRef.current(host.id, { phase: "closed" });
          onSessionRef.current(host.id, null);
          term.write(`\r\n\x1b[90m[${message}]\x1b[0m\r\n`);
        },
      });
      // 卸载可能发生在这行之前（StrictMode 会立刻重挂一次），此时必须自己收尾
      if (cancelled) {
        handle.disconnect();
        return;
      }
      handleRef.current = handle;
      for (const chunk of pendingInput) handle.write(chunk);
      pendingInput = [];
      onSessionRef.current(host.id, handle.id);
      onStateRef.current(host.id, { phase: "ready" });
      if (handle.fingerprint) onFingerprintRef.current(host.id, handle.fingerprint);
    };

    // StrictMode 挂载两次：推迟到下一个宏任务再连，cleanup 里 clearTimeout 掉，
    // 第一轮就根本不会去连（和 TerminalSession 一个道理）
    const startTimer = window.setTimeout(() => {
      void start().catch((reason) => {
        if (cancelled) return;
        const message = String(reason);
        setError(message);
        onStateRef.current(host.id, { phase: "error", error: message });
        onSessionRef.current(host.id, null);
      });
    }, 0);

    const dataDisposable = term.onData(writeInput);

    const pasteFromClipboard = () => {
      void readClipboard().then((text) => {
        if (cancelled) return;
        if (text) {
          term.paste(text);
          return;
        }
        void hasClipboardImage().then((image) => {
          if (!cancelled && image) handleRef.current?.write("\x16");
        });
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // 关 / 新建标签先判：键位可能不是主修饰键，不受 isPrimaryModifier 限制。
      // 但前台跑着全屏程序时让行——备用屏缓冲（normal / alternate）能直接判出来，
      // CodeBuddy CLI 的 Ctrl+T、vim 的 Ctrl+W 这些得留给它们自己（同 TerminalSession）
      if (term.buffer.active.type === "normal") {
        if (matchesShortcut(event, closeComboRef.current)) {
          event.preventDefault();
          event.stopPropagation();
          onRequestCloseRef.current?.();
          return;
        }
        if (matchesShortcut(event, newComboRef.current)) {
          event.preventDefault();
          event.stopPropagation();
          onRequestNewRef.current?.();
          return;
        }
      }
      if (!isPrimaryModifier(event)) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        if (!term.hasSelection()) return;
        event.preventDefault();
        event.stopPropagation();
        void copyText(term.getSelection());
      } else if (key === "v") {
        event.preventDefault();
        event.stopPropagation();
        pasteFromClipboard();
      }
    };
    container.addEventListener("keydown", onKeyDown, true);

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) void copyText(term.getSelection());
      else pasteFromClipboard();
    };
    container.addEventListener("contextmenu", onContextMenu);

    /** 面板收放动画期间先不 fit，等动画落定补一次（见 lib/layout-motion） */
    let resizeTimer: number | undefined;
    let settleFallback: number | undefined;
    let resizedDuringMotion = false;
    /** 面板动画期间暂停 WebGL 的设备像素回调；动画结束或兜底时恢复 */
    let resumeWebglSync: (() => void) | null = null;
    const resumeWebgl = () => {
      if (!resumeWebglSync) return;
      resumeWebglSync();
      resumeWebglSync = null;
    };
    const stopWebglMotion = onLayoutAnimationStart(() => {
      if (webgl && !resumeWebglSync) resumeWebglSync = pauseDevicePixelSync(webgl);
    });
    const fitOnce = () => {
      if (isLayoutAnimating()) {
        resizedDuringMotion = true;
        return;
      }
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      handleRef.current?.resize(term.cols, term.rows);
    };
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      if (isLayoutAnimating()) {
        resizedDuringMotion = true;
        // 兜底：结束信号没送到时也不能一直不 fit
        window.clearTimeout(settleFallback);
        settleFallback = window.setTimeout(() => {
          resumeWebgl();
          fitOnce();
        }, 500);
        return;
      }
      resizeTimer = window.setTimeout(fitOnce, 100);
    });
    observer.observe(container);
    const stopSettled = onLayoutSettled(() => {
      resumeWebgl();
      if (!resizedDuringMotion) return;
      resizedDuringMotion = false;
      window.clearTimeout(resizeTimer);
      window.clearTimeout(settleFallback);
      fitOnce();
    });

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(settleFallback);
      resumeWebgl();
      stopWebglMotion();
      stopSettled();
      observer.disconnect();
      dataDisposable.dispose();
      scrollDisposable.dispose();
      writeParsedDisposable.dispose();
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("contextmenu", onContextMenu);
      handleRef.current?.disconnect();
      handleRef.current = null;
      onSessionRef.current(host.id, null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // host.id 变了就是换了台主机（正常由上层用 key 重挂）；sessionKey 变是点了「重连」
  }, [sessionKey, host.id]);

  // 换主题 / 终端配色不重建会话，只换调色板
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolveTerminalTheme(settings.terminalTheme, theme, palette);
    term.refresh(0, Math.max(0, term.rows - 1));
  }, [theme, palette, settings.terminalTheme]);

  // 字体 / 字号 / 字重同理，改完补一次 fit
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontFamily = resolveFont(settings.terminalFontFamily);
    term.options.fontSize = settings.terminalFontSize;
    term.options.fontWeight = settings.terminalFontBold ? "bold" : "normal";
    if (!containerRef.current?.clientWidth) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    handleRef.current?.resize(term.cols, term.rows);
  }, [settings.terminalFontFamily, settings.terminalFontSize, settings.terminalFontBold]);

  // 藏起来的会话量不到尺寸，切回来的这一帧补一次 fit 和聚焦
  useEffect(() => {
    if (!active || !visible) return;
    const frame = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      const buffer = term.buffer.active;
      setAtBottom(buffer.viewportY >= buffer.baseY);
      if (!containerRef.current?.clientWidth) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      handleRef.current?.resize(term.cols, term.rows);
      term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, visible, sessionKey]);

  const terminalBg = resolveTerminalTheme(
    settings.terminalTheme,
    theme,
    palette,
  ).background;

  return (
    // overflow-clip：见 TerminalSession 的注释（输入法合成时防止整块被推左再弹回）
    <div
      className={visible ? "absolute inset-0 overflow-clip" : "hidden"}
      style={{ backgroundColor: terminalBg }}
    >
      <div ref={containerRef} className="absolute inset-0" />
      {error && (
        <div className="absolute inset-x-2 top-2 flex items-start gap-2 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
          <span className="flex-1 break-all">{error}</span>
          <button
            type="button"
            onClick={() => setSessionKey((key) => key + 1)}
            className="shrink-0 rounded border border-danger-line px-2 py-0.5 hover:bg-hover"
          >
            重连
          </button>
        </div>
      )}
      {exited && !error && (
        <div className="absolute inset-x-2 top-2 flex items-center gap-2 rounded border border-warn-line bg-warn-bg px-2 py-1 text-[11px] text-warn">
          <span className="flex-1">{exited}</span>
          <button
            type="button"
            onClick={() => setSessionKey((key) => key + 1)}
            className="rounded border border-warn-line-strong px-2 py-0.5 hover:bg-warn-line"
          >
            重连
          </button>
        </div>
      )}
      {!atBottom && (
        <button
          type="button"
          title="回到最新输出"
          aria-label="回到最新输出"
          onClick={() => {
            termRef.current?.scrollToBottom();
            termRef.current?.focus();
            setAtBottom(true);
          }}
          className="absolute right-3 bottom-3 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-line-strong bg-surface text-fg-dim shadow-lg hover:bg-hover hover:text-fg"
        >
          <IconArrowDownToLine className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
