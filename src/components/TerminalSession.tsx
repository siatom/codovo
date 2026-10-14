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
import type { AttentionKind } from "../lib/attention";
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
  /** 「用户看到了」：撤掉 done 标记。切到已经活动的标签时 prop 不变，只能走 handle */
  markSeen(): void;
}

/**
 * 「终端是不是停在等用户输入的提示上」的启发式特征（逐行判断的那部分）。
 *
 * 只能从 PTY 输出里猜——AI CLI（CodeBuddy CLI / Claude Code / Codex 这类）的确认框长什么样
 * 没有稳定协议。挑的是「菜单式选择」和「明确的确认问句」，尽量避开助手正文里的普通疑问句。
 */
const WAIT_PATTERNS: RegExp[] = [
  // inquirer / clack 风格的选择菜单：光标行紧跟编号选项（Unicode 光标）
  /^\s*[❯›]\s*[1-9][.)]\s+\S/,
  // 同一个菜单的 ASCII 光标版本（部分 CLI 用 `>` 当选中指示）。
  // 刻意只在后面跟「编号 / 是 / 否」时才算，否则助手正文里的 markdown 引用行 `> xxx` 会误判
  /^\s*>\s+(\[?\d|yes\b|no\b)/i,
  // 单行的 [1] xxx / (1) xxx 选项行
  /^\s*[\[(]\s*[1-9]\s*[\])]\s+\S/,
  // 是 / 否 的括号提示
  /\[\s*[yYnN]\s*\/\s*[yYnN]\s*\]/,
  /\(\s*[yYnN]\s*\/\s*[yYnN]\s*\)/,
  // 按键提示：只有真的在等按键才会出现
  /(press\s+enter|press\s+any\s+key|hit\s+enter|press\s+y)\b/i,
  // 简短确认问句：必须带问号且在行尾，避免把正文里的陈述误判
  /\b(continue|proceed|confirm|overwrite)\?\s*$/i,
  // 明确的确认问句
  /(do you want to proceed|would you like to proceed|are you sure|allow this|approve this)\b/i,
  // 权限询问 + 问号
  /(permission|approve|allow|deny|reject)\b[^?？]*[?？]\s*$/i,
  // Claude Code 这类「要不要执行这条命令」的许可框
  /(run this command|execute this|run bash)\b/i,
];

/**
 * 需要看「相邻两行」才能判定的菜单特征：单独一行 `1. xxx` 可能是正文列表，
 * 但连着两行编号选项（`1. yes / 2. no`）就基本只可能是选择菜单了。
 * 这些正则带 `m` 且作用在「拼好的整块文本」上（见 looksLikeWaitingPrompt）。
 */
const WAIT_BLOCK_PATTERNS: RegExp[] = [
  // 1. xxx / 2. xxx
  /^\s*[1-9][.)][ \t]+\S[^\n]*\n[ \t]*[2-9][.)][ \t]+\S/m,
  // [1] xxx / [2] xxx
  /^\s*\[\s*[1-9]\s*\][ \t]+\S[^\n]*\n[ \t]*\[\s*[2-9]\s*\][ \t]+\S/m,
  // (1) xxx / (2) xxx
  /^\s*\(\s*[1-9]\s*\)[ \t]+\S[^\n]*\n[ \t]*\(\s*[2-9]\s*\)[ \t]+\S/m,
];

/** 输出停下多久后去判一次：太短会在重绘中途误判，太长会显得迟钝 */
const WAIT_CHECK_MS = 700;

/**
 * AI CLI「运行中」与「空闲」的屏幕特征（看屏幕底部几行的状态行 / 活动行）。
 *
 * 两代特征都认（均为实测）：
 * - 状态行版（老版 Claude Code / CodeBuddy CLI / Codex 同款）：干活时状态行挂
 *   `esc to interrupt`，跑完回到输入框换成 `? for shortcuts`。
 * - 活动行版（新版 Claude Code）：状态行两态不变（只换模式提示），但输入框上方的
 *   活动行会翻——干活时是 spinner `✻ Sketching… (6s · ↓ 90 tokens)`（前缀图标是
 *   动画帧、动词随机，只有「省略号 +（秒数 · 」的结构稳定），跑完换成结束行
 *   `✻ Cogitated for 10s · done 18:24`；按 ESC 打断显示 `Interrupted · ...`，不算完成。
 *
 * 据此区分「任务完成在等指令」和「还在干活」。
 */
const BUSY_RE = /esc\s+to\s+interrupt/i;
const BUSY_SPINNER_RE = /…\s*[（(]\s*\d+s\s*·/;
const IDLE_RE = /\?\s*for\s*shortcuts/i;
const IDLE_DONE_RE = /·\s*done\s/;
/**
 * 会话列表视图（新版 Claude Code 启动后的默认界面）的顶部统计行：
 * `0 awaiting input · 1 working · 3 completed`——`N working` 非 0 就是有任务在跑；
 * 统计行还在但 working 归零，就是都跑完回到等指令。统计行固定在屏幕顶部，不在底部。
 */
const LIST_WORKING_RE = /\b[1-9]\d*\s+working\b/;
const LIST_STATS_RE = /\bawaiting input\b/;
/** 底部取几行找状态行：活动行贴着输入框上沿，连状态区共十行之内兜得住 */
const FOOTER_ROWS = 10;
/** 输出期间采「运行中」特征的节流间隔：spinner 每秒重绘多次，不必每块输出都扫屏幕 */
const BUSY_PROBE_MS = 250;

/**
 * xterm 自己发出、并非用户按键的应答：焦点上报（`CSI I` / `CSI O`）与光标位置应答（`CSI r;c R`）。
 * 它们和用户输入走同一条 `onData`，但**不代表用户给了交互**——不能拿它们清掉「在等用户」的标记。
 * （实测踩过：切到别的工作区时终端失焦，xterm 上报 `ESC[O`，把标记误清了。）
 */
function isTerminalReport(data: string): boolean {
  return data === "\x1b[I" || data === "\x1b[O" || /^\x1b\[\d+;\d+R$/.test(data);
}

/** 从屏幕底部往上取几行非空文本（只看一屏之内，别把整段回滚都扫一遍） */
function recentLines(term: Terminal, max: number): string[] {
  const buffer = term.buffer.active;
  const bottom = buffer.baseY + term.rows - 1;
  const top = Math.max(0, bottom - term.rows + 1);
  const lines: string[] = [];
  for (let y = bottom; y >= top && lines.length < max; y -= 1) {
    const text = buffer.getLine(y)?.translateToString(true).trim() ?? "";
    if (text) lines.push(text);
  }
  return lines;
}

/** 从屏幕顶部往下取几行非空文本（会话列表视图的统计行挂在顶部第 3 行，不在底部窗口里） */
function topLines(term: Terminal, max: number): string[] {
  const buffer = term.buffer.active;
  const hi = Math.min(buffer.baseY + term.rows, buffer.length);
  const lines: string[] = [];
  for (let y = buffer.baseY; y < hi && lines.length < max; y += 1) {
    const text = buffer.getLine(y)?.translateToString(true).trim() ?? "";
    if (text) lines.push(text);
  }
  return lines;
}

/**
 * 屏幕底部连续 N 行的原文（自上而下，**保留空行**）。
 *
 * 保留空行是给「相邻两行」的多行特征用的：真菜单的编号选项是紧挨着的屏幕行，
 * 助手正文里的 markdown 编号列表项之间常夹空行——丢了空行会把后者也误判成菜单。
 * 只看底部若干行也是同样的理由：菜单贴着屏幕底部的提示符，正文列表可能在任意位置。
 */
function recentRows(term: Terminal, max: number): string[] {
  const buffer = term.buffer.active;
  const bottom = buffer.baseY + term.rows - 1;
  const top = Math.max(0, bottom - max + 1);
  const rows: string[] = [];
  for (let y = top; y <= bottom; y += 1) {
    rows.push(buffer.getLine(y)?.translateToString(true).trimEnd() ?? "");
  }
  return rows;
}

/**
 * 判定终端此刻停在等用户输入的提示上（确认框 / 选择菜单）。
 *
 * 单行特征沿屏幕取若干「非空行」扫（屏幕上内容稀疏时也能扫到）；多行特征只看底部连续屏行，
 * 靠「紧挨着的两行编号选项」把菜单和正文里的编号列表区分开。
 */
function looksLikeWaitingPrompt(term: Terminal): boolean {
  if (recentLines(term, 6).some((line) => WAIT_PATTERNS.some((pattern) => pattern.test(line)))) {
    return true;
  }
  return WAIT_BLOCK_PATTERNS.some((pattern) => pattern.test(recentRows(term, 12).join("\n")));
}

/** 全屏 TUI 此刻的状态：等用户回应 / 运行中 / 空闲等指令 */
type CliActivity = "prompt" | "busy" | "idle";

/**
 * 看一眼终端的屏幕，判断全屏程序处于什么状态。
 *
 * **只在备用屏里判**：全屏 TUI（AI CLI、vim、less）跑在备用屏，裸 shell 提示符在普通屏——
 * 这样普通 shell 永远不会被误标，只有全屏程序才进这个判断。
 * （当前 CLI 的交互提示基本都出在全屏 TUI 里，所以没有为主屏另开一条宽松判定。）
 *
 * 顺序很重要：先判「在等回应」（确认框可能挂在运行中界面之上），再看底部的运行 / 空闲特征。
 */
function judgeActivity(term: Terminal): CliActivity | null {
  if (term.buffer.active.type !== "alternate") return null;
  if (looksLikeWaitingPrompt(term)) return "prompt";
  // 会话列表视图的统计行在屏幕顶部，底部窗口看不到，单独判：working 非 0 = 有任务在跑；
  // 统计行还在、working 归零 = 任务都跑完了，停在列表上等指令
  const head = topLines(term, 6).join("\n");
  if (LIST_WORKING_RE.test(head)) return "busy";
  const foot = recentRows(term, FOOTER_ROWS).join("\n");
  if (BUSY_RE.test(foot) || BUSY_SPINNER_RE.test(foot)) return "busy";
  if (IDLE_RE.test(foot) || IDLE_DONE_RE.test(foot)) return "idle";
  if (LIST_STATS_RE.test(head)) return "idle";
  return null;
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
  /**
   * 这个会话的「在等用户」状态变化（启发式判断，见 judgeActivity）：停在交互提示上
   * 是 `prompt`、任务跑完回到空闲输入框是 `done`、null 表示都没有。
   * 由 TerminalPane 写进 attention store，在标签栏与侧栏上标记出来。
   */
  onAttentionChange?: (kind: AttentionKind | null) => void;
  /**
   * 这个会话有「真实使用」时上报一次：用户敲了输入，或该会话已在跑命令、有输出。
   * 由 TerminalPane 写进 activity store，侧栏据此把最近用过的终端排在前面。
   * 单纯打开 / 切换工作区不算——shell 启动的提示符不触发（见 engaged）。
   */
  onActivity?: () => void;
}

/**
 * 一个终端会话 = 一个 xterm 实例 + 一个 PTY。
 * 会话之间互不影响，切换标签只是把别的会话藏起来（不销毁，shell 继续活着）。
 */
export const TerminalSession = forwardRef<
  TerminalSessionHandle,
  TerminalSessionProps
>(function TerminalSession(
  {
    root,
    active,
    visible = active,
    initialCommand,
    shell,
    onRequestClose,
    onRequestNew,
    onAttentionChange,
    onActivity,
  },
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
  // 同理：上抛「在等用户」的回调每次渲染都是新的，建实例的 effect 依赖里塞不下
  const onAttentionChangeRef = useRef(onAttentionChange);
  onAttentionChangeRef.current = onAttentionChange;
  // 上报「有真实使用」的回调同理，也走 ref
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  // 等待提示的开关随时能关，而判定逻辑挂在建实例的 effect 里、只跑一次，所以也走 ref
  const waitHintRef = useRef(settings.terminalWaitHint);
  waitHintRef.current = settings.terminalWaitHint;
  // 「用户已看到」的入口（切到该标签时调用）：实现在建实例的 effect 里，经 ref 转交
  const seenRef = useRef<(() => void) | null>(null);

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
      markSeen() {
        seenRef.current?.();
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

    /**
     * 「在等用户」的判定，两种：
     * - prompt：停在确认框 / 菜单上，等用户回应；
     * - done：任务跑完回到空闲输入框，等下一步指令。只有「见过运行中」之后才判
     *   （workSeen）——刚启动、还没跑过任务的 CLI 也是空闲态，不能算「完成」。
     *
     * 输出每来一块就重置计时器，停下来 WAIT_CHECK_MS 之后扫一眼屏幕（静默判定）；
     * 只在实际翻转时上报，避免每次输出都惊动 React。
     *
     * 但「运行中」特征不能只靠静默判定：CLI 干活时 spinner 每秒重绘多次，输出永远
     * 停不下来，静态判定根本跑不到。得在输出到达时另开一路节流采样（probeBusy）。
     */
    let shown: AttentionKind | null = null;
    let workSeen = false;
    let lastBusyProbe = 0;
    let waitTimer: number | undefined;
    const report = (next: AttentionKind | null) => {
      if (next === shown) return;
      shown = next;
      onAttentionChangeRef.current?.(next);
    };
    const probeBusy = () => {
      const now = Date.now();
      if (now - lastBusyProbe < BUSY_PROBE_MS) return;
      lastBusyProbe = now;
      if (judgeActivity(term) !== "busy") return;
      workSeen = true;
      // 顺手撤掉陈旧标记（上一轮留下的 done / 已经消失的确认框）
      report(null);
    };
    const scheduleWaitCheck = () => {
      window.clearTimeout(waitTimer);
      waitTimer = window.setTimeout(() => {
        if (cancelled) return;
        if (!waitHintRef.current) {
          report(null);
          return;
        }
        const activity = judgeActivity(term);
        // 停在确认框/菜单上是在等回应，不许动 workSeen：别把「答完启动询问」
        // 当成跑完了一轮任务
        if (activity === "prompt") {
          report("prompt");
          return;
        }
        if (activity === "busy") workSeen = true;
        report(activity === "idle" && workSeen ? "done" : null);
      }, WAIT_CHECK_MS);
    };
    /**
     * 「用户已经看到这个终端了」（切到该标签 / 从别的工作区、GUI 切回来）。
     * 除了撤标记，还必须解除 workSeen：切过来那一帧会 fit + resize，CLI 必定重绘，
     * 判定会重跑——武装未解除的话标记会当场复活。prompt 标记不动：那是在等回应，
     * 看一眼不代表回应过了。
     */
    const seen = () => {
      workSeen = false;
      if (shown === "done") report(null);
    };
    seenRef.current = seen;

    // 句柄就绪前先攒着的输入，见 writeInput
    let pendingInput: string[] = [];

    // 待敲的启动命令。每次 effect 跑起来都重新待命：StrictMode 的第一轮是作废的
    // 那一轮，它写出去的命令会随 shell 一起被 kill，第二轮要重新写一遍；
    // 用户点「重开」时也是重新拉起同一个会话，顺带把 resume 再执行一次
    let bootPending = bootCommand;

    /*
     * 「这个会话已经被真实使用过了」的门控，只影响活动上报（侧栏排序），不碰 attention。
     * shell 一启动就会吐提示符，若「有输出就上报活动」，那么单纯打开 / 切换工作区都会
     * 被记成活动。所以：用户真的敲了输入才置位，之后（含长跑命令的输出）才继续上报。
     * 带启动命令的会话（AI CLI / resume）一上来就算在用，初值直接给 true。
     */
    let engaged = Boolean(bootCommand);

    /**
     * 往 PTY 里写用户/终端产生的输入。句柄是异步拿到的，写可能比它先到——最典型的是
     * xterm 对 shell 启动时 `ESC[6n`（查光标位置，bash/readline 用它算提示符宽度）的
     * 自动应答：应答比 `spawnPty` 的 await 先到，此时直接 `ptyRef.current?.write` 会被
     * 丢掉，shell 就一直等这个应答、永远不出提示符（实测：应用启动时的第一个终端没有
     * 提示符、也不响应输入，看着像卡住；之后新建的终端因为句柄早就绪所以正常）。
     * 所以先攒起来，句柄就绪后按原顺序补发。
     */
    const writeInput = (data: string) => {
      // 用户已经在敲了，标记立刻撤掉；等他停下来、若还停在提示上会再判一次。
      // 同时解除 workSeen——他打字停顿的间隙不能再被判成「任务完成」。
      // 但 xterm 自己的焦点 / 光标应答不算用户交互，别误清
      if (!isTerminalReport(data)) {
        workSeen = false;
        report(null);
        // 真实用户输入：这个会话从此算「在用」，并把这次记成工作区的一次活动
        engaged = true;
        onActivityRef.current?.();
      }
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
          // 只有「已经在用」的会话才把输出算作活动：新 shell 的启动提示符不算，
          // 否则打开 / 切换工作区就会把顺序改掉
          if (engaged) onActivityRef.current?.();
          // 这里不再「有输出就撤标记」：空闲态 CLI 也会偶尔重绘（状态行刷新、窗口
          // 变化），撤了再判会让 done 闪成呼吸灯。清陈旧标记交给 probeBusy 和静默判定
          probeBusy();
          // 读 ptyRef 而不是直接用 handle：事件有可能先于 await 返回到达，
          // 那时 handle 还在 TDZ 里，碰它会直接抛 ReferenceError。
          // 那种情况下 ptyRef 还是 null，这一轮不消费，交给下面的补写。
          flushBoot(ptyRef.current);
          scheduleWaitCheck();
        },
        onExit: (code) => {
          if (cancelled) return;
          setExited(true);
          // shell 都没了，挂在标签上的标记（在等回应 / 已完成）也一并撤掉
          workSeen = false;
          report(null);
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
     *
     * 但**前台跑着全屏 TUI 时这两条键一律让行**：xterm 的备用屏缓冲能直接判出来——
     * CodeBuddy CLI、Claude Code、vim、less、top 一启动就切到备用屏，退出时切回。这类程序
     * 大量占用 Ctrl+字母（CodeBuddy 的 Ctrl+T 是展开 tasks、vim 的 Ctrl+W 是切窗），宿主抢了
     * 它们就没法用；只有裸 shell 提示符（normal 缓冲）下才落到我们手上。
     */
    const onKeyDown = (event: KeyboardEvent) => {
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
      window.clearTimeout(waitTimer);
      // 会话没了就别留着标记：StrictMode 的第一轮也会走到这儿，报一次 null 是无害的
      report(null);
      seenRef.current = null;
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

  // 切到该标签（含从别的视图 / 工作区切回来）就算「看到了」：撤掉 done 标记。
  // 不并进上面那个 effect：那个带 rAF（等布局稳定才 fit），这里要立刻生效，
  // 免得 fit 触发的重绘把标记重新点亮
  useEffect(() => {
    if (active) seenRef.current?.();
  }, [active]);

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
