import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { spawnPty, type PtyHandle } from "../lib/pty";
import { resolveFont, useSettings } from "../lib/settings";
import { resolveTerminalTheme } from "../lib/terminal-themes";
import { useTheme } from "../lib/theme";

export interface TerminalSessionHandle {
  /** 往这个会话的 shell 里写命令 */
  write(data: string): void;
  focus(): void;
}

interface TerminalSessionProps {
  /** 当前工作目录；null 表示用户还没选工作区，shell 落在用户主目录 */
  cwd: string | null;
  /** 是否是当前显示的那个会话：从后台切回来要重新量尺寸并聚焦 */
  active: boolean;
}

/**
 * 一个终端会话 = 一个 xterm 实例 + 一个 PTY。
 * 会话之间互不影响，切换标签只是把别的会话藏起来（不销毁，shell 继续活着）。
 */
export const TerminalSession = forwardRef<
  TerminalSessionHandle,
  TerminalSessionProps
>(function TerminalSession({ cwd, active }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyRef = useRef<PtyHandle | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const { theme } = useTheme();
  const { settings } = useSettings();

  // 建实例的 effect 只认挂载那一刻的主题，切换主题走下面的 effect 单独更新
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const fontSizeRef = useRef(settings.terminalFontSize);
  fontSizeRef.current = settings.terminalFontSize;
  const fontFamilyRef = useRef(settings.terminalFontFamily);
  fontFamilyRef.current = settings.terminalFontFamily;
  const fontBoldRef = useRef(settings.terminalFontBold);
  fontBoldRef.current = settings.terminalFontBold;
  const terminalThemeRef = useRef(settings.terminalTheme);
  terminalThemeRef.current = settings.terminalTheme;

  useImperativeHandle(
    ref,
    () => ({
      write(data) {
        ptyRef.current?.write(data);
      },
      focus() {
        termRef.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setError(null);
    setExited(false);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: resolveFont(fontFamilyRef.current),
      fontSize: fontSizeRef.current,
      fontWeight: fontBoldRef.current ? "bold" : "normal",
      lineHeight: 1.25,
      scrollback: 5000,
      theme: resolveTerminalTheme(terminalThemeRef.current, themeRef.current),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL 不可用时 xterm 会留在默认渲染器上，不影响使用
    }

    try {
      fit.fit();
    } catch {
      // 容器尺寸还没稳定，交给 ResizeObserver
    }

    termRef.current = term;
    fitRef.current = fit;

    let cancelled = false;

    const start = async () => {
      const handle = await spawnPty({
        cwd: cwd ?? undefined,
        cols: term.cols,
        rows: term.rows,
        // StrictMode 会挂载两次，第一轮的 channel 在 cleanup 之后才收到 exit。
        // 不挡住的话，已经作废的那次会话会把"shell 已退出"打到存活的界面上。
        onData: (bytes) => {
          if (!cancelled) term.write(bytes);
        },
        onExit: (code) => {
          if (cancelled) return;
          setExited(true);
          term.write(`\r\n\x1b[90m[shell 已退出，退出码 ${code}]\x1b[0m\r\n`);
        },
      });
      // 卸载可能发生在这行之前（React StrictMode 会立刻重挂一次），此时必须自己收尾
      if (cancelled) {
        handle.kill();
        return;
      }
      ptyRef.current = handle;
    };

    void start().catch((reason) => {
      if (!cancelled) setError(String(reason));
    });

    const dataDisposable = term.onData((data) => ptyRef.current?.write(data));

    let resizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        ptyRef.current?.resize(term.cols, term.rows);
      }, 100);
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      dataDisposable.dispose();
      ptyRef.current?.kill();
      ptyRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // cwd 变了就重开一个 shell 落在新目录，比往运行中的 shell 里塞 cd 可靠
    // （跨盘符、各种 shell 的转义规则都不一样）
  }, [sessionKey, cwd]);

  // 切界面主题、或换终端配色，都不重建会话，只换调色板：滚动历史和正在跑的命令不受影响
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolveTerminalTheme(settings.terminalTheme, theme);
    // 只改 options 时 WebGL 渲染器不保证重画整屏，显式刷一遍底色才跟着换
    term.refresh(0, Math.max(0, term.rows - 1));
  }, [theme, settings.terminalTheme]);

  // 字体/字号/字重同理，改完补一次 fit，把新的行列数告诉 PTY
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontFamily = resolveFont(settings.terminalFontFamily);
    term.options.fontSize = settings.terminalFontSize;
    // 加粗会改变字宽，列数跟着变，所以和字号一样得重新量一次
    term.options.fontWeight = settings.terminalFontBold ? "bold" : "normal";
    // 藏起来的会话量不到尺寸，切回来的那个 effect 会补上
    if (!containerRef.current?.clientWidth) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    ptyRef.current?.resize(term.cols, term.rows);
  }, [
    settings.terminalFontFamily,
    settings.terminalFontSize,
    settings.terminalFontBold,
  ]);

  // 藏起来的会话在 display:none 里量不到尺寸，切回来的这一帧要补一次 fit 和聚焦
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit || !containerRef.current?.clientWidth) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      ptyRef.current?.resize(term.cols, term.rows);
      term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, sessionKey]);

  return (
    // overflow-clip 是必须的：输入法合成时 xterm 的 .composition-view 会按光标位置
    // 画到行尾之外，浏览器为了让这个"焦点附近"的内容可见，会去横向滚动最近的可滚动祖先
    // （分栏面板是 overflow:hidden，照样能被程序滚动），整块终端就被推左再弹回，看着在抖。
    // 用 clip 而不是 hidden：clip 连程序滚动都不允许，溢出到此为止。
    <div className={active ? "absolute inset-0 overflow-clip" : "hidden"}>
      {/* FitAddon 只减 xterm 自身的 padding、不减父元素 padding，所以容器不能留内边距 */}
      <div ref={containerRef} className="absolute inset-0" />
      {error && (
        <div className="absolute inset-x-2 top-2 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
          终端启动失败：{error}
        </div>
      )}
      {exited && !error && (
        <div className="absolute inset-x-2 top-2 flex items-center gap-2 rounded border border-warn-line bg-warn-bg px-2 py-1 text-[11px] text-warn">
          <span className="flex-1">shell 已退出。</span>
          <button
            type="button"
            onClick={() => setSessionKey((key) => key + 1)}
            className="rounded border border-warn-line-strong px-2 py-0.5 hover:bg-warn-line"
          >
            重开
          </button>
        </div>
      )}
    </div>
  );
});
