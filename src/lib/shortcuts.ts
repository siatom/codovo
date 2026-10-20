/**
 * 应用自己的命令键位：一张集中的命令表，加上解析 / 匹配 / 显示 / 录制这几样工具。
 *
 * 键位字符串用 token 拼，例如 `Mod+Shift+K`。`Mod` 是**跨平台的主修饰键**（macOS ⌘、其余
 * 平台 Ctrl），落到存储里就这一个写法，切平台不用改数据；其余 token（Ctrl / Meta / Shift /
 * Alt）和 KeyboardEvent 的修饰键一一对应。判定、显示、录制全走这里，别处别再拼字面量。
 *
 * 终端捕获的 Ctrl+C/V 与 Esc 关闭弹窗**不在这张表里**：它们和 shell / 系统语义绑死
 * （Ctrl+C 是 SIGINT），改了会出事，保留内置。
 *
 * 表里的命令分两级作用域：编辑器命令（`editor.*`）在编辑器区按下时生效；窗口级命令
 * （`app.*`）由 App 统一分发。分发的写法见 `components/EditorPane.tsx` 的 onPaneKeyDown
 * 与 `App.tsx` 的全局分发 effect——两级都不会在终端里抢键（见 `isTypingTarget`）。
 */
import { IS_MAC } from "./keys";

/** 一条可配置的应用命令 */
export interface ShortcutCommand {
  id: string;
  label: string;
  /** 出厂默认键位（token 形式） */
  defaultCombo: string;
  /**
   * 改过默认值的命令：把**老的出厂默认键位**填在这儿。用户存下来的键位若正好等于它，
   * 视为「没特意设过」、跟着换到新默认——否则升级上来的用户还攥着旧键，新默认形同虚设
   * （`newTab` 从 Mod+T 挪开就是因为旧键撞 AI CLI，见下）。
   */
  legacyDefault?: string;
}

export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  // 关的是「当前标签页」：焦点在编辑器就关文件 / 差异标签，在终端就关终端标签，
  // 在右侧面板里也照关当前编辑器标签（含从「变更」打开的差异）
  { id: "closeTab", label: "关闭标签页", defaultCombo: "Mod+W" },
  // 开的是「焦点所在的那处终端」的新标签页：本地终端 / 远程终端各听各的 keydown，
  // 只有拿到焦点的那一处会响应（两处同键不冲突，见 components/RemotePane.tsx）。
  // **默认刻意不用 Mod+T**：Ctrl+T 是 CodeBuddy / Claude Code 这类 TUI 的常用键
  // （展开 tasks），宿主抢了前台程序就没法用；Mod+Shift+T 是浏览器 / VS Code 的新建标签惯例
  { id: "newTab", label: "新建终端标签页", defaultCombo: "Mod+Shift+T", legacyDefault: "Mod+T" },
  { id: "editor.save", label: "保存文件", defaultCombo: "Mod+S" },
  { id: "editor.saveAs", label: "文件另存为", defaultCombo: "Mod+Shift+S" },
  { id: "editor.newFile", label: "新建文件（未命名缓冲区）", defaultCombo: "Mod+N" },
  // Ctrl+O 选中的文件必须在某个工作目录里：跨工作区的单文件打开（临时工作区）还没做
  { id: "editor.openFile", label: "打开文件", defaultCombo: "Mod+O" },
  // 查找的默认键与 Monaco 自带的 actions.find 同键：编辑器区捕获后走本应用的动作，
  // 因此仍然打开同一个 find widget（Ctrl+H 的替换留 Monaco 内置，不改）
  { id: "editor.find", label: "查找", defaultCombo: "Mod+F" },
  // 默认沿用 VS Code / Prettier 的惯例键；Monaco 自带的「格式化文档」只在注册过
  // 格式化 provider 的语言（json5 / jsonc）上激活，本应用注册的动态键位排在它之后、优先生效
  { id: "editor.format", label: "格式化文档", defaultCombo: "Shift+Alt+F" },
  { id: "editor.togglePreview", label: "切换预览（Markdown / 网页）", defaultCombo: "Mod+Shift+V" },
  // 标签切换照 VS Code / CodeLite 用 Ctrl+Tab：刻意不写 Mod+Tab——macOS 上 Cmd+Tab
  // 是系统级的应用切换，注册上去也收不到事件。另外 Ctrl+PageUp/PageDown 是同义的
  // 内置别名（那两键进不了这张表，见 EditorPane 的说明）
  { id: "editor.nextTab", label: "下一个标签页", defaultCombo: "Ctrl+Tab" },
  { id: "editor.prevTab", label: "上一个标签页", defaultCombo: "Ctrl+Shift+Tab" },
  { id: "editor.zoomIn", label: "增大编辑器字号", defaultCombo: "Mod+=" },
  { id: "editor.zoomOut", label: "减小编辑器字号", defaultCombo: "Mod+-" },
  { id: "editor.zoomReset", label: "重置编辑器字号", defaultCombo: "Mod+0" },
  { id: "app.settings", label: "打开设置", defaultCombo: "Mod+," },
  { id: "app.toggleSidebar", label: "切换侧边栏", defaultCombo: "Mod+B" },
  { id: "git.commit", label: "提交（提交信息框内）", defaultCombo: "Mod+Enter" },
  // 文件树的复制 / 剪切 / 粘贴：只在树里某一行有焦点时生效（事件走行自己的 keydown，
  // 终端那边是兄弟子树、抢不到），所以和终端的 Ctrl+C 语义不冲突
  { id: "explorer.copy", label: "复制（文件树）", defaultCombo: "Mod+C" },
  { id: "explorer.cut", label: "剪切（文件树）", defaultCombo: "Mod+X" },
  { id: "explorer.paste", label: "粘贴（文件树）", defaultCombo: "Mod+V" },
];

/** 修饰键 token，顺序也按这个来序列化，保证同组合只有一种写法 */
const MODIFIERS = ["Mod", "Ctrl", "Meta", "Shift", "Alt"] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_SET = new Set<string>(MODIFIERS);

/** event.key 里是修饰键本身的值：单独按下不算一条键位 */
const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "AltGraph",
  "OS",
  "CapsLock",
]);

/**
 * 保留键：Esc 用来取消录制，Dead / Unidentified / Process 也不许录。
 *
 * **Tab 是特例**：这里刻意不列它——单按 Tab（以及 Shift+Tab）交给下面的「至少要有一个
 * 前缀」那条规则挡掉，留给焦点切换；而 Ctrl+Tab / Ctrl+Shift+Tab 是正常的命令键
 * （切标签），必须能录能匹配。
 */
const RESERVED_KEYS = new Set(["Escape", "Esc", "Dead", "Unidentified", "Process"]);

export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** 规范化后的键名：单字符统一大写，空格统一成 "Space"，其余原样（Enter / F5 / ArrowUp…） */
  key: string;
}

/** event.key 的规范化。空格和 "+" 会破坏 token 序列化，单独处理 */
function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** 解析键位字符串；不合法（缺键、只有修饰键、保留键、键名带 +）返回 null */
export function parseShortcut(combo: string): ParsedShortcut | null {
  if (typeof combo !== "string" || combo === "") return null;
  const flags: Record<Modifier, boolean> = {
    Mod: false,
    Ctrl: false,
    Meta: false,
    Shift: false,
    Alt: false,
  };
  let key: string | null = null;
  for (const raw of combo.split("+")) {
    const token = raw.trim();
    if (token === "") continue;
    if (MODIFIER_SET.has(token)) {
      flags[token as Modifier] = true;
      continue;
    }
    if (key !== null) return null; // 出现了第二个键：不是合法组合
    if (token.includes("+")) return null;
    key = token;
  }
  if (key === null) return null; // 只有修饰键
  if (RESERVED_KEYS.has(key)) return null;
  // 至少要有一个真正的"前缀"（Mod/Ctrl/Meta/Alt），光靠 Shift 会和正常输入撞车；
  // 单按 Tab / Shift+Tab 也正好被这条挡掉，交给焦点切换
  if (!flags.Mod && !flags.Ctrl && !flags.Meta && !flags.Alt) return null;
  return {
    mod: flags.Mod,
    ctrl: flags.Ctrl,
    meta: flags.Meta,
    shift: flags.Shift,
    alt: flags.Alt,
    key,
  };
}

function serialize(parsed: ParsedShortcut): string {
  const parts: string[] = [];
  if (parsed.mod) parts.push("Mod");
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Meta");
  if (parsed.shift) parts.push("Shift");
  if (parsed.alt) parts.push("Alt");
  parts.push(parsed.key);
  return parts.join("+");
}

/** 规范化键位字符串；不合法返回 null。用于去重比对和落盘前的统一 */
export function normalizeCombo(combo: string): string | null {
  const parsed = parseShortcut(combo);
  return parsed ? serialize(parsed) : null;
}

export function isValidShortcut(combo: string): boolean {
  return parseShortcut(combo) !== null;
}

/**
 * 是否正在录制键位（设置面板的 ShortcutRecorder）。录制期间要独占键盘：录制控件自己也
 * 挂在 window 捕获阶段，但它**注册得比全局快捷键分发晚**，所以分发那边得先看这个标志
 * 让路——否则录 Ctrl+B 会顺手把侧边栏收起来、录 Ctrl+= 会顺手把字号改了。
 */
let shortcutRecording = false;

export function setShortcutRecording(recording: boolean): void {
  shortcutRecording = recording;
}

export function isShortcutRecording(): boolean {
  return shortcutRecording;
}

/**
 * 从一次键盘事件录一条键位。返回 null 表示这次按键不接受（纯修饰键、保留键、
 * 或不带 Mod/Ctrl/Meta/Alt 的裸键），调用方应继续等下一个按键。
 */
export function shortcutFromEvent(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): string | null {
  const key = normalizeKey(event.key);
  if (MODIFIER_KEYS.has(event.key) || RESERVED_KEYS.has(key)) return null;
  if (key.includes("+")) return null;
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return null;

  const parsed: ParsedShortcut = {
    mod: false,
    ctrl: false,
    meta: false,
    shift: event.shiftKey,
    alt: event.altKey,
    key,
  };
  // Mod 记到当前平台的主修饰键上：录制出来的键位换平台仍能对上本机语义
  if (IS_MAC) {
    if (event.metaKey) parsed.mod = true;
    if (event.ctrlKey) parsed.ctrl = true;
  } else {
    if (event.ctrlKey) parsed.mod = true;
    if (event.metaKey) parsed.meta = true;
  }
  return serialize(parsed);
}

/** 事件是否命中某条键位。修饰键要求完全一致（多按一个就不算），避免误触 */
export function matchesShortcut(
  event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  combo: string,
): boolean {
  const parsed = parseShortcut(combo);
  if (!parsed) return false;
  // Mod 落到当前平台的主修饰键上
  const expectMeta = (parsed.mod && IS_MAC) || parsed.meta;
  const expectCtrl = (parsed.mod && !IS_MAC) || parsed.ctrl;
  if (event.metaKey !== expectMeta) return false;
  if (event.ctrlKey !== expectCtrl) return false;
  if (event.shiftKey !== parsed.shift) return false;
  if (event.altKey !== parsed.alt) return false;
  return normalizeKey(event.key).toLowerCase() === parsed.key.toLowerCase();
}

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function displayKey(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/** 展示用文案：mac 渲染成 ⌃⌥⇧⌘ 符号，其余平台用 Ctrl / Alt / Shift / Win + 键名 */
export function formatShortcut(combo: string): string {
  const parsed = parseShortcut(combo);
  if (!parsed) return combo;
  if (IS_MAC) {
    const symbols = [
      parsed.ctrl ? "⌃" : "",
      parsed.alt ? "⌥" : "",
      parsed.shift ? "⇧" : "",
      parsed.mod || parsed.meta ? "⌘" : "",
    ].join("");
    return symbols + displayKey(parsed.key);
  }
  const parts: string[] = [];
  if (parsed.mod || parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Win");
  if (parsed.shift) parts.push("Shift");
  if (parsed.alt) parts.push("Alt");
  parts.push(displayKey(parsed.key));
  return parts.join("+");
}

/** 出厂默认键位表。每次返回新对象：DEFAULTS 是模块级常量，不能被就地改到 */
export function defaultShortcuts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const command of SHORTCUT_COMMANDS) out[command.id] = command.defaultCombo;
  return out;
}

/**
 * 从存下来的数据还原键位表：逐条校验合法性并去重，任何一条非法、或与前面已占用的
 * 组合撞车，都回落默认——宁可回到出厂，也不让两条命令抢同一个键。
 * 存着老出厂默认值的（`legacyDefault`）按「没设过」处理，换到新默认。
 * 缺失的 id 补默认，多出来的键忽略。
 */
export function resolveShortcuts(value: unknown): Record<string, string> {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const command of SHORTCUT_COMMANDS) {
    const saved =
      typeof raw[command.id] === "string" ? normalizeCombo(raw[command.id] as string) : null;
    const legacy = saved !== null && saved === command.legacyDefault;
    const combo = saved && !legacy && !used.has(saved) ? saved : command.defaultCombo;
    used.add(combo);
    out[command.id] = combo;
  }
  return out;
}
