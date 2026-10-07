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
import {
  readImage,
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";
import { isPrimaryModifier } from "../lib/keys";
import { matchesShortcut } from "../lib/shortcuts";
import { spawnPty, type PtyHandle } from "../lib/pty";
import { resolveFont, useSettings } from "../lib/settings";
import { resolveTerminalTheme } from "../lib/terminal-themes";
import { useTheme } from "../lib/theme";
import { IconArrowDownToLine } from "./icons";

/**
 * 走 Tauri 的 clipboard 插件读写系统剪贴板，不用 `navigator.clipboard`：
 * WebView 那套要文档有焦点、WebView2 还会弹系统授权框，插件从 Rust 侧直接读写，三端都不问人。
 */
async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    // 复制失败没有可补救的动作，静默丢弃，别打断终端里的操作
  }
}

async function readClipboard(): Promise<string | null> {
  try {
    return await readText();
  } catch {
    return null;
  }
}

/**
 * 剪贴板里有没有图片。CLI（CodeBuddy / Codex 这类）粘图靠「收到原始 Ctrl+V 后
 * 自己去读系统剪贴板」，不是靠终端把图片数据送进去；所以我们只要判断出「没文本、
 * 但有图」，把 Ctrl+V 原样透传给 PTY 就行，图片由 CLI 自己取。
 */
async function hasClipboardImage(): Promise<boolean> {
  try {
    // readImage 拿到的是资源句柄，必须显式 close，否则每探一次泄一个
    const image = await readImage();
    await image.close();
    return true;
  } catch {
    return false;
  }
}

export interface TerminalSessionHandle {
  /** 往这个会话的 shell 里写命令 */
  write(data: string): void;
  focus(): void;
}

interface TerminalSessionProps {
  /** 这个会话属于哪个工作区；shell 就落在这个目录，后端也按它归属会话 */
  root: string;
  /** 是否是当前显示的那个会话：从后台切回来要重新量尺寸并聚焦 */
  active: boolean;
  /** 是否在当前布局中显示；显示多个终端时不等同于焦点会话 */
  visible?: boolean;
  /** shell 起来后自动敲进去的一条命令（resume 会话用）。只在建实例那一次生效 */
  initialCommand?: string;
  /**
   * 这个会话指定的 shell 候选 id。undefined = 用设置里的默认；空串 = 明确要「自动」
   * （由后端按平台挑）。两者得分开，否则在下拉里点「自动」会被设置里的具体 shell 顶掉。
   */
  shell?: string;
  /**
   * 焦点在这个会话里时按了「关闭当前标签」的快捷键。谁管标签栏谁来关——
   * 会话自己不知道自己是第几个，也不知道关掉后该切到谁。
   */
  onRequestClose?: () => void;
  /**
   * 同理，按了「新建标签页」的快捷键。标签栏归 TerminalPane 管，新会话由它开。
   */
  onRequestNew?: () => void;
}

/**
 * 一个终端会话 = 一个 xterm 实例 + 一个 PTY。
 * 会话之间互不影响，切换标签只是把别的会话藏起来（不销毁，shell 继续活着）。
 */
export const TerminalSession = forwardRef<
  TerminalSessionHandle,
  TerminalSessionProps
>(function TerminalSession(
  { root, active, visible = active, initialCommand, shell, onRequestClose, onRequestNew },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyRef = useRef<PtyHandle | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  // 视口是否停在最新输出上：滚离底部时浮出「回到最新输出」按钮。每个会话各一份，互不影响
  const [atBottom, setAtBottom] = useState(true);
  const [sessionKey, setSessionKey] = useState(0);
  const { theme, palette } = useTheme();
  const { settings } = useSettings();

  // 建实例的 effect 只认挂载那一刻的主题，切换主题走下面的 effect 单独更新
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
  // 关标签的键位可配置，而下面的 keydown 监听挂一次就不重建（依赖只有 [sessionKey, root]），
  // 所以拿 ref 存最新值，改键位立刻生效
  const closeComboRef = useRef(settings.shortcuts["closeTab"]);
  closeComboRef.current = settings.shortcuts["closeTab"];
  // 新建标签的键位同理
  const newComboRef = useRef(settings.shortcuts["newTab"]);
  newComboRef.current = settings.shortcuts["newTab"];
  // 建实例的 effect 依赖是 [sessionKey, root]，塞不进这个回调：它每次渲染都变，
  // 进了依赖就等于「每关一个标签就重开 shell」。用 ref 存最新的那份。
  const onRequestCloseRef = useRef(onRequestClose);
  onRequestCloseRef.current = onRequestClose;
  const onRequestNewRef = useRef(onRequestNew);
  onRequestNewRef.current = onRequestNew;

  // 要自动敲的那条命令只在"这个会话被创建"那一次算数，所以用 useState 的初始化
  // 把它定死、不跟着 prop 走（用户手动点「重开」或 cwd 变化重建 shell 时不该重放
  // resume）。**不能用 ref + 在 effect 里清空**：StrictMode 会立刻重挂一次，清空
  // 发生在那一轮，第二轮的 effect 就读到空了，命令会被悄悄丢掉。
  const [bootCommand] = useState(initialCommand);

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
      // 右键在我们这儿是复制/粘贴，别让它顺带按词选中，不然会先把选区改掉再复制
      rightClickSelectsWord: false,
      theme: resolveTerminalTheme(terminalThemeRef.current, themeRef.current, paletteRef.current),
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

    /**
     * 视口是否停在最新输出上。滚动会触发 onScroll，但**追加新输出**只改 baseY、
     * 不一定触发 onScroll，所以 onWriteParsed 也得校正一次，否则按钮会出现/消失不及时。
     */
    const syncAtBottom = () => {
      const buffer = term.buffer.active;
      setAtBottom(buffer.viewportY >= buffer.baseY);
    };
    const scrollDisposable = term.onScroll(syncAtBottom);
    const writeParsedDisposable = term.onWriteParsed(syncAtBottom);

    let cancelled = false;

    // 句柄就绪前先攒着的输入，见 writeInput
    let pendingInput: string[] = [];

    // 待敲的启动命令。每次 effect 跑起来都重新待命：StrictMode 的第一轮是作废的
    // 那一轮，它写出去的命令会随 shell 一起被 kill，第二轮要重新写一遍；
    // 用户点「重开」时也是重新拉起同一个会话，顺带把 resume 再执行一次
    let bootPending = bootCommand;

    /**
     * 往 PTY 里写用户/终端产生的输入。句柄是异步拿到的，写可能比它先到——最典型的是
     * xterm 对 shell 启动时 `ESC[6n`（查光标位置，bash/readline 用它算提示符宽度）的
     * 自动应答：应答比 `spawnPty` 的 await 先到，此时直接 `ptyRef.current?.write` 会被
     * 丢掉，shell 就一直等这个应答、永远不出提示符（实测：应用启动时的第一个终端没有
     * 提示符、也不响应输入，看着像卡住；之后新建的终端因为句柄早就绪所以正常）。
     * 所以先攒起来，句柄就绪后按原顺序补发。
     */
    const writeInput = (data: string) => {
      const pty = ptyRef.current;
      if (pty) pty.write(data);
      else pendingInput.push(data);
    };

    /**
     * 把待敲的启动命令交给刚就绪的 PTY。传 null 表示还没就绪——直接返回、
     * 不消费 bootPending，留给下一次调用（首个输出块或 await 返回之后）。
     *
     * 拿"首个输出块到达"当就绪信号：它意味着提示符（或 pwsh 启动时的 ESC[6n
     * 查询）已经出来了，此时写入不会被启动序列吞掉。往刚 spawn 完的 PTY 里
     * 立刻写是不行的，命令可能先于提示符被丢掉。
     */
    const flushBoot = (pty: PtyHandle | null) => {
      if (!pty || !bootPending) return;
      const command = bootPending;
      bootPending = undefined;
      pty.write(`${command}\r`);
    };

    const start = async () => {
      const handle = await spawnPty({
        root,
        cwd: root,
        // 刻意读闭包里的值、且不放进下面的依赖数组：改了 shell 只该影响之后新建的
        // 会话，不能把正在跑的终端重建掉（那会打断命令和 AI CLI）。
        shell: (shell ?? settings.terminalShell) || undefined,
        cols: term.cols,
        rows: term.rows,
        // StrictMode 会挂载两次，第一轮的 channel 在 cleanup 之后才收到 exit。
        // 不挡住的话，已经作废的那次会话会把"shell 已退出"打到存活的界面上。
        onData: (bytes) => {
          if (cancelled) return;
          term.write(bytes);
          // 读 ptyRef 而不是直接用 handle：事件有可能先于 await 返回到达，
          // 那时 handle 还在 TDZ 里，碰它会直接抛 ReferenceError。
          // 那种情况下 ptyRef 还是 null，这一轮不消费，交给下面的补写。
          flushBoot(ptyRef.current);
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
      // 句柄就绪前攒下的输入现在补发。顺序不能变：最前面那个多半是 shell 正等着的
      // 光标位置应答，压到后面它会一直等下去
      for (const chunk of pendingInput) handle.write(chunk);
      pendingInput = [];
      // 首个输出块比 await 先到的话 bootPending 还挂着，这里补一次；
      // 已经消费过就是空操作
      flushBoot(handle);
    };

    // StrictMode 会挂载两次：第一轮 effect 刚跑完就被 cleanup 掉。spawn 是异步的，
    // 立刻发起的话第一轮会白白起一个 shell、随即又被 kill 掉。推迟到下一个宏任务再
    // spawn，cleanup 里 clearTimeout 掉，第一轮就根本不起 PTY（StrictMode 的
    // 挂载→卸载→挂载是同一个同步批次里跑的，所以这个 clearTimeout 一定赶得上）。
    const startTimer = window.setTimeout(() => {
      void start().catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    }, 0);

    const dataDisposable = term.onData(writeInput);

    // 粘贴走 term.paste()：它会按当前是否开启 bracketed paste 决定包不包 ESC[200~，
    // 多行内容才不会被 shell 逐行当命令执行。
    //
    // 剪贴板里没有文本时，可能是张图片：CLI 粘图要的是「原始 Ctrl+V」这个触发信号，
    // 自己再去读系统剪贴板。所以把 \x16 原样写进 PTY，别自己读图片——终端里的程序
    // 拿到的是字节流，我们读出来的图它也收不到。
    const pasteFromClipboard = () => {
      void readClipboard().then((text) => {
        if (cancelled) return;
        if (text) {
          term.paste(text);
          return;
        }
        void hasClipboardImage().then((image) => {
          if (!cancelled && image) ptyRef.current?.write("\x16");
        });
      });
    };

    /**
     * 快捷键认领：关闭 / 新建当前终端标签（键位可配置，关标签和编辑器共用「关闭标签页」
     * 这条命令），以及复制/粘贴。用捕获阶段 + stopPropagation 抢在 xterm 自己的 textarea
     * 监听之前处理，否则 Ctrl+V 会被 xterm 挡下、Ctrl+C 会先被发成 \x03（中断）。
     *
     * 关闭 / 新建键位先判：它们可能不是主修饰键（比如用户改成 Alt+W），不能受
     * isPrimaryModifier 限制。只有拿到终端焦点的那一处终端会收到这个事件，
     * 所以本地终端和远程终端用同一个键位不会打架。
     */
    const onKeyDown = (event: KeyboardEvent) => {
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
      if (!isPrimaryModifier(event)) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        // 没选区时不认领，让它落到 shell 上发 SIGINT —— 这是终端的肌肉记忆
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

    // 右键：有选中就复制，没有就粘贴（和 VS Code / Windows Terminal 一致）
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) void copyText(term.getSelection());
      else pasteFromClipboard();
    };
    container.addEventListener("contextmenu", onContextMenu);

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
      window.clearTimeout(startTimer);
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      dataDisposable.dispose();
      scrollDisposable.dispose();
      writeParsedDisposable.dispose();
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("contextmenu", onContextMenu);
      ptyRef.current?.kill();
      ptyRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // root 变了就重开一个 shell 落在新目录，比往运行中的 shell 里塞 cd 可靠
    // （跨盘符、各种 shell 的转义规则都不一样）
  }, [sessionKey, root]);

  // 切界面主题、或换终端配色，都不重建会话，只换调色板：滚动历史和正在跑的命令不受影响
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolveTerminalTheme(settings.terminalTheme, theme, palette);
    // 只改 options 时 WebGL 渲染器不保证重画整屏，显式刷一遍底色才跟着换
    term.refresh(0, Math.max(0, term.rows - 1));
  }, [theme, palette, settings.terminalTheme]);

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
      if (!term || !fit) return;
      // 藏起来时收不到滚动事件，这一帧顺带校正一次按钮显隐（放在尺寸判断之前，
      // 免得容器还没量出宽度时被跳过）
      const buffer = term.buffer.active;
      setAtBottom(buffer.viewportY >= buffer.baseY);
      if (!containerRef.current?.clientWidth) return;
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

  // FitAddon 只按整数行列铺，容器高度是像素分数，底部会剩不到一行的空当。
  // 把它涂成终端自己的底色，否则会露出外面面板的底色——上下并列时那道空当
  // 正好贴在分割线上方，看着像一条平行的白色阴影。
  const terminalBg = resolveTerminalTheme(
    settings.terminalTheme,
    theme,
    palette,
  ).background;

  return (
    // overflow-clip 是必须的：输入法合成时 xterm 的 .composition-view 会按光标位置
    // 画到行尾之外，浏览器为了让这个"焦点附近"的内容可见，会去横向滚动最近的可滚动祖先
    // （分栏面板是 overflow:hidden，照样能被程序滚动），整块终端就被推左再弹回，看着在抖。
    // 用 clip 而不是 hidden：clip 连程序滚动都不允许，溢出到此为止。
    <div
      className={visible ? "absolute inset-0 overflow-clip" : "hidden"}
      style={{ backgroundColor: terminalBg }}
    >
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
      {/* 滚离底部时才浮出。点一下回尾部，并顺手把焦点还给终端，免得之后打字落到按钮上 */}
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
});
