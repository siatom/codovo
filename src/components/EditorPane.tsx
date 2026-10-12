import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  // 起个别名：文件里还有 DOM 的 MouseEvent（window 的 mousedown 监听），别让它被顶掉
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import { monaco, monacoThemeFor } from "../lib/monaco-setup";
import { languageOf } from "../lib/languages";
import { reindentModelOnOpen } from "../lib/json5";
import { renderMarkdown } from "../lib/markdown";
import { parseShortcut, matchesShortcut, formatShortcut } from "../lib/shortcuts";
import {
  gitFileDiff,
  isPathInside,
  ownerRoot,
  pathKey,
  readFile,
  readImage,
  toDisplayPath,
  writeFile,
} from "../lib/fs";
import type { GitMark } from "../lib/git";
import { useSettings, resolveFont, type EditorIndent } from "../lib/settings";
import { useTabReorder } from "../lib/use-tab-reorder";
import { sameTab, tabKey, tabSuffix, tabTitle, type Tab } from "../lib/tabs";
import type { EditorLocation } from "../lib/types";
import { useTheme } from "../lib/theme";
import { GitMarkBadge } from "./GitMarkBadge";
import { FullscreenButton } from "./FullscreenButton";
import { HtmlPreview } from "./HtmlPreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  IconArrowDown,
  IconArrowUp,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconEye,
  IconLayoutColumns,
  IconLayoutSingle,
  IconMore,
  IconPencil,
  IconTerminal,
} from "./icons";

/** 选中浮窗的估算宽度，用来把它收进窗口右边缘 */
const FLOAT_BAR_W = 76;

/** 标签「⋯」菜单：宽度和条目样式，跟 Sidebar 的同类菜单保持一致 */
const TABS_MENU_W = 112;
const TABS_MENU_ITEM =
  "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted";

/** 浮窗按钮：两个动作同款，禁用态（智能体没开）不给 hover 反馈 */
const FLOAT_BAR_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

/** 编码下拉菜单的宽度，和标签「⋯」菜单同一套写法 */
const ENCODING_MENU_W = 156;

/** 状态栏左侧（语言 / 缩进 / 换行符）下拉的宽度。语言名有长有短，给宽一点 */
const STATUS_MENU_W = 200;

/** 状态栏上的小按钮，和右侧编码入口同一套写法 */
const STATUS_BUTTON =
  "flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-hover hover:text-fg";

/** 状态栏上的图标按钮（差异视图的排布切换 / 上一处下一处），禁用态不给 hover 反馈 */
const STATUS_ICON_BUTTON =
  "flex shrink-0 items-center justify-center rounded px-1.5 py-0.5 text-fg-dim hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

/**
 * 差异视图的排布（内联 / 并排）是窗口级偏好，存 sessionStorage：多窗口下各记各的。
 * 默认内联——窄面板里左右并排会把两侧压得很窄，内联更好读。
 */
const DIFF_SIDE_BY_SIDE_KEY = "codedock.diffSideBySide";

function readDiffSideBySide(): boolean {
  try {
    return window.sessionStorage.getItem(DIFF_SIDE_BY_SIDE_KEY) === "1";
  } catch {
    // 读不到就用默认的内联
    return false;
  }
}

/**
 * 状态栏要显示的「当前文件视图信息」。从 editor / model 现取后落到 state（不像编码那样
 * 每帧现算），是因为切这些选项时要主动触发重渲染。
 */
interface ViewInfo {
  line: number;
  column: number;
  language: string;
  eol: "LF" | "CRLF";
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
}

/** 两个视图信息是否完全一样，用来省掉光标没动时的无谓 setState */
function sameViewInfo(a: ViewInfo, b: ViewInfo): boolean {
  return (
    a.line === b.line &&
    a.column === b.column &&
    a.language === b.language &&
    a.eol === b.eol &&
    a.tabSize === b.tabSize &&
    a.insertSpaces === b.insertSpaces &&
    a.wordWrap === b.wordWrap
  );
}

/**
 * 缩进是 model 级选项：选了具体宽度就固定下来；auto 时按内容再猜一次（默认 4 空格兜底）。
 * Monaco 只在建 model 那一刻按内容探测，之后不再重猜，所以固定宽度只要覆盖 tabSize 即可
 */
function applyIndentToModel(model: monaco.editor.ITextModel, indent: EditorIndent) {
  if (indent === "auto") {
    model.detectIndentation(true, 4);
  } else {
    model.updateOptions({ tabSize: Number(indent), insertSpaces: true });
  }
}

/** Monaco 语言 id 的显示名缓存：aliases 取第一个，取不到就用 id 本身 */
const languageLabels = new Map<string, string>();
function languageLabel(id: string): string {
  let label = languageLabels.get(id);
  if (label === undefined) {
    const lang = monaco.languages.getLanguages().find((item) => item.id === id);
    label = lang?.aliases?.[0] ?? id;
    languageLabels.set(id, label);
  }
  return label;
}

/** 状态栏下拉里的一项。key 单独给（语言菜单里可能有重名 label），checked 只用于打勾 */
interface StatusMenuItem {
  key: string;
  label: string;
  checked?: boolean;
  onPick: () => void;
}

/**
 * 可切换的编码，顺序即下拉顺序。label 必须和后端 `Encoding::from_label` 一一对应，
 * 保存时原样回传给后端；name 只是给人看的显示名。
 */
const ENCODINGS: { label: string; name: string }[] = [
  { label: "utf-8", name: "UTF-8" },
  { label: "utf-8-bom", name: "UTF-8 with BOM" },
  { label: "utf-16le", name: "UTF-16 LE" },
  { label: "utf-16be", name: "UTF-16 BE" },
  { label: "gbk", name: "GBK" },
  { label: "big5", name: "Big5" },
];

/** 后端编码标签 -> 显示名；认不出就原样显示，不吞掉信息 */
function encodingName(label: string): string {
  return ENCODINGS.find((item) => item.label === label)?.name ?? label;
}

/** Monaco 的键名和 DOM 的 event.key 有几处对不上，别名一下 */
const MONACO_KEY_ALIASES: Record<string, string> = {
  ArrowUp: "UpArrow",
  ArrowDown: "DownArrow",
  ArrowLeft: "LeftArrow",
  ArrowRight: "RightArrow",
};

/**
 * 把配置里的键位字符串翻成 Monaco 的 keybinding 位掩码。翻不出来（键名 Monaco 不认）
 * 就返回 null，调用方换成"不注册键位"，而不是抛错。
 *
 * Mod 走 `CtrlCmd`：Monaco 自己按平台映射成 Cmd / Ctrl，正好对上配置里 Mod 的语义。
 */
function toMonacoKeybinding(combo: string): number | null {
  const parsed = parseShortcut(combo);
  if (!parsed) return null;
  const codes = monaco.KeyCode as unknown as Record<string, number>;
  const name = MONACO_KEY_ALIASES[parsed.key] ?? parsed.key;
  let code: number | undefined;
  if (/^[A-Z]$/.test(name)) code = codes[`Key${name}`];
  else if (/^[0-9]$/.test(name)) code = codes[`Digit${name}`];
  else code = codes[name];
  if (code === undefined) return null;

  let mods = 0;
  // Monaco 没有单独的 Ctrl 修饰位：CtrlCmd 在 mac 是 Cmd、其余平台是 Ctrl，正好覆盖
  // Mod；显式写的 Ctrl token 也并到这里（mac 上会被当成 Cmd，属罕见边角，不额外处理）
  if (parsed.mod || parsed.ctrl) mods |= monaco.KeyMod.CtrlCmd;
  if (parsed.meta) mods |= monaco.KeyMod.WinCtrl;
  if (parsed.shift) mods |= monaco.KeyMod.Shift;
  if (parsed.alt) mods |= monaco.KeyMod.Alt;
  return mods | code;
}

interface EditorPaneProps {
  /** 已打开的标签，按打开顺序 */
  tabs: Tab[];
  /** 当前显示的那个 */
  active: Tab | null;
  /** 归一化路径 -> git 标记 */
  gitMarks: ReadonlyMap<string, GitMark>;
  onActivate: (tab: Tab) => void;
  onClose: (tab: Tab) => void;
  /** 拖动重排标签：只改显示顺序，不碰激活态和 model。父级负责把新顺序写回 openTabs */
  onReorder: (from: number, to: number) => void;
  /** 批量关闭：标题栏右侧「⋯」菜单用 */
  onCloseAll: () => void;
  onCloseOthers: () => void;
  /** 全屏展示状态。按钮挂在编辑器标题栏右端，也就是右边栏的右上角 */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 选中浮窗的两个动作：把位置引用送到终端 / 智能体输入框 */
  onSendToTerminal: (location: EditorLocation) => void;
  onSendToAgent: (location: EditorLocation) => void;
  /** 工作区内当前活动根。文件命令的沙箱根按**文件实际所属根**算，见 `roots` */
  root: string;
  /**
   * 工作区的全部工作目录。标签是跨根共用一个的，读一个次要根里的文件时如果仍拿活动根
   * 去请求，后端会判「路径越界（不在工作区内）」——所以每条读写都先按路径找归属
   */
  roots: string[];
  /** 这个工作区是不是当前显示的。从隐藏切回可见时 Monaco 要补一次 layout */
  visible: boolean;
  /** 搜索替换要用的几个动作。React 19 起 ref 可以直接当普通 prop 传，不必再包 forwardRef */
  ref?: Ref<EditorPaneHandle>;
}

interface CachedModel {
  /** 落盘要用，Map 的键是 tabKey 不是路径 */
  path: string;
  model: monaco.editor.ITextModel;
  savedVersionId: number;
  /**
   * 打开时后端检测到的编码标签。保存时原样回传，按原编码写回——
   * 不带着它的话 GBK / Big5 / UTF-16 文件会被 UTF-8 覆盖而损坏。
   */
  encoding: string;
}

/** 一个差异标签的一对 model，销毁时必须一起走 */
interface CachedDiff {
  /** 落盘用不到，但搜索替换后要按路径找到它、把过期的基线丢掉 */
  path: string;
  original: monaco.editor.ITextModel;
  modified: monaco.editor.ITextModel;
}

/** 要定位到的位置。nonce 递增，好让「重复点同一条结果」也能重新定位 */
export interface RevealTarget {
  path: string;
  /** 1 起算 */
  line: number;
  /** 1 起算，UTF-16 单位 */
  column: number;
  /** 匹配长度，UTF-16 单位 */
  length: number;
  nonce: number;
}

export interface EditorPaneHandle {
  /** 把编辑器里所有未保存的改动落盘；返回 false 表示有文件没存成功 */
  saveAll: () => Promise<boolean>;
  /**
   * 重新从磁盘加载这些文件，扔掉编辑器里的旧内容。两个场景共用：搜索替换之后，
   * 以及外部（终端 / git / 别的编辑器 / 智能体）改了打开着的文件。
   * 有未保存改动的文件不覆盖——用户的编辑优先。
   */
  reload: (paths: string[]) => Promise<void>;
  /** 打开文件并定位到指定位置 */
  revealAt: (target: RevealTarget) => void;
  /**
   * 丢掉落在这些路径下（含路径本身）的缓存 model。文件树里改了名或删了文件时用：
   * 名字变了要按新路径重读，文件没了就不该再留着——留着的话 Ctrl+S 会把删掉的
   * 文件又写回磁盘。
   */
  dropPaths: (paths: string[]) => void;
  /**
   * 丢掉**所有**差异视图的缓存。差异的基线跟着 HEAD / index 走，切分支之后一律过期，
   * 留着就会拿旧基线跟新内容比，显示出根本不存在的差异。
   */
  dropDiffs: () => void;
  /**
   * 这些路径里哪些在磁盘上已经不存在了。切分支用：checkout 删掉的文件 watcher
   * 收不到通知（它只对 `is_file()` 发事件），得主动问一次才能把死标签清掉。
   */
  missingPaths: (paths: string[]) => Promise<string[]>;
  /** 关掉当前标签页。焦点在右侧面板（文件树 / 变更）里时走这个入口 */
  closeActiveTab: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "binary" }
  | { kind: "tooLarge" }
  | { kind: "emptyDiff" }
  | { kind: "image"; src: string }
  | { kind: "error"; message: string };

/**
 * 当图片预览的扩展名，和后端 `image_mime` 一一对应。`svg` 不在列里——
 * 它是文本，编辑器里当 xml 打开能改能高亮，挪去预览是倒退。
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

function isImagePath(path: string): boolean {
  const name = toDisplayPath(path).split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1));
}

/**
 * 编辑器内可预览的网页文件：html / htm 是网页文档，svg 是浏览器能直接渲染的矢量图。
 * 预览走 iframe + asset 协议读磁盘（相对路径的 css / js / 图片才加载得到），
 * 和右栏「浏览器」模块同一套。`svg` 编辑时仍按 xml 高亮（见 `languages.ts`），
 * 只是多给一个「编辑 / 预览」开关——它不是图片，别混进 `IMAGE_EXTENSIONS`。
 */
const HTML_PREVIEW_EXTENSIONS = new Set(["html", "htm", "svg"]);

function isHtmlPreviewPath(path: string): boolean {
  const name = toDisplayPath(path).split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && HTML_PREVIEW_EXTENSIONS.has(name.slice(dot + 1));
}

function baseName(path: string): string {
  return toDisplayPath(path).split("/").pop() ?? path;
}

/**
 * 工作区内的相对路径，一律用 `/`。给智能体标「文件:行号」用——
 * 绝对路径又长又带机器信息，相对路径才是仓库里的说法。
 */
function relativeToRoot(path: string, root: string): string {
  const full = toDisplayPath(path);
  const base = toDisplayPath(root).replace(/\/+$/, "");
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
}

/**
 * 差异标签的 model URI 必须和普通文件的 `file://` 分开，否则同一个路径两个
 * model 会撞在一起（同一个文件既可能被当文件打开、又被当差异打开，差异本身
 * 还分未暂存/暂存/某个提交三种）。
 */
function diffUri(tab: Extract<Tab, { kind: "diff" }>, side: "original" | "modified"): monaco.Uri {
  const { source } = tab;
  // range 要带上两侧 ref 才能区分「同一个文件的两次不同比较」，否则它们会撞同一个 model
  const key =
    source.mode === "commit"
      ? `commit-${source.rev.slice(0, 12)}`
      : source.mode === "range"
        ? `range-${source.from.slice(0, 12)}-${source.to.slice(0, 12)}`
        : source.mode;
  return monaco.Uri.parse(
    `codedock-diff:/${key}/${encodeURIComponent(pathKey(tab.path))}/${side}`,
  );
}

/** 一次关闭动作：单个标签 / 全部标签 / 除当前外的其他标签。三种共用同一套确认逻辑 */
type CloseRequest = { kind: "one"; tab: Tab } | { kind: "all" } | { kind: "others" };

export function EditorPane({
  tabs,
  active,
  gitMarks,
  onActivate,
  onClose,
  onReorder,
  onCloseAll,
  onCloseOthers,
  fullscreen,
  onToggleFullscreen,
  onSendToTerminal,
  onSendToAgent,
  root,
  roots,
  visible,
  ref,
}: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, CachedModel>());

  // 差异视图：另一套编辑器 + 另一套 model，和上面那套彻底分开——
  // 这样"只读"就是结构性保证，persist 根本看不到它
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const diffModelsRef = useRef(new Map<string, CachedDiff>());
  /** 「滚到第一处改动」还欠着：model 挂上时差异往往还没算完，等 onDidUpdateDiff 再滚 */
  const diffRevealPendingRef = useRef(false);
  /**
   * 差异编辑器当前算出的改动块列表（`getLineChanges()` 的结果）。上一处 / 下一处与
   * 「第 x / N 处」都读它，免得每次跳转重算；差异重算 / 换标签由 syncDiffChanges 刷新。
   */
  const diffChangesRef = useRef<monaco.editor.ILineChange[]>([]);

  const activeRef = useRef<Tab | null>(active);
  /**
   * 关标签的实现要经 ref 暴露成 `closeActiveTab` 句柄（右侧面板也用它）。它定义在
   * useImperativeHandle 之后，塞不进那个依赖数组，只能用 ref 兜住最新那份。
   */
  const closeTabRef = useRef<(tab: Tab) => void>(() => {});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [diffStatus, setDiffStatus] = useState<Status>({ kind: "idle" });
  /** 差异视图的排布偏好（内联 / 并排），窗口级；初值从 sessionStorage 读 */
  const [diffSideBySide, setDiffSideBySide] = useState(readDiffSideBySide);
  /** 当前差异的改动块数量与所处块序号（0 基），驱动状态栏的「第 x / N 处」与按钮禁用态 */
  const [diffChangeCount, setDiffChangeCount] = useState(0);
  const [diffChangeIndex, setDiffChangeIndex] = useState(0);
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  /**
   * 待确认的关闭动作（单个脏标签 / 关闭全部 / 关闭其他）。走自研确认框，
   * 见 ConfirmDialog 的说明。null 表示没有待确认的关闭
   */
  const [closeRequest, setCloseRequest] = useState<{
    request: CloseRequest;
    message: string;
  } | null>(null);
  /** 正处在预览模式的标签（存 tabKey）；不在集合里就是编辑模式 */
  const [previewPaths, setPreviewPaths] = useState<ReadonlySet<string>>(new Set());
  // togglePreview 是稳定回调（依赖为空），要用 ref 读预览集合的最新值来判断该进还是该退
  const previewPathsRef = useRef(previewPaths);
  previewPathsRef.current = previewPaths;
  const [saving, setSaving] = useState(false);
  /** 选中文本浮窗的视口坐标；null = 不显示 */
  const [floatBar, setFloatBar] = useState<{ top: number; left: number } | null>(null);
  /** 标题栏「⋯」菜单的视口坐标；null = 不显示 */
  const [tabsMenu, setTabsMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * 编码菜单的位置。状态栏在底部，所以记的是按钮顶边的 y，渲染时按 `bottom` 定位到它上方
   */
  const [encodingMenu, setEncodingMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * 状态栏左侧的下拉（语言 / 缩进 / 换行符）。位置记按钮左边缘 + 顶边，渲染时顶到按钮上方
   */
  const [statusMenu, setStatusMenu] = useState<{
    x: number;
    y: number;
    items: StatusMenuItem[];
  } | null>(null);
  /** 状态栏左侧显示的当前文件视图信息；没有可用文本 model 时为 null（状态栏左侧整块收起） */
  const [viewInfo, setViewInfo] = useState<ViewInfo | null>(null);
  /**
   * 待确认的编码切换（脏标签才有）。切编码会从磁盘重读、丢掉未保存的改动，先确认再动手
   */
  const [encodingSwitch, setEncodingSwitch] = useState<{ tab: Tab; label: string } | null>(null);
  /**
   * 浮窗对应的选中位置。点按钮那一刻编辑器可能已经失焦，现取不可靠，所以在选中那一刻就存下来
   */
  const floatLocationRef = useRef<EditorLocation | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  /**
   * 标签栏的拖动重排。这里只管指针状态机，新顺序由父级（WorkspacePane 的 openTabs）
   * 落盘；scrollerRef 同时用来在切换标签时把激活标签滚进可视区。
   */
  const { scrollerRef: tabsScrollRef, dragFrom, dropIndex, onTabDown, onClickCapture } =
    useTabReorder(onReorder);
  const { theme, palette } = useTheme();
  const { settings } = useSettings();

  // 建 editor 的 effect 只认挂载那一刻的主题，切换主题走下面的 effect 单独更新
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  // 浮窗的鼠标回调也建在「只跑一次」的建 editor effect 里，读 root 同样得走 ref
  const rootRef = useRef(root);
  rootRef.current = root;
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  /**
   * 这个路径该用哪个沙箱根去请求后端。标签跨根共用，次要根里的文件拿活动根去读会
   * 被判「路径越界」；万一一个都不匹配（比如路径已被删掉），退回活动根，让后端照常报错
   */
  const rootFor = useCallback(
    (path: string) => ownerRoot(rootsRef.current, path) ?? rootRef.current,
    [],
  );
  const fontSizeRef = useRef(settings.editorFontSize);
  fontSizeRef.current = settings.editorFontSize;
  const fontFamilyRef = useRef(settings.editorFontFamily);
  fontFamilyRef.current = settings.editorFontFamily;
  const fontBoldRef = useRef(settings.editorFontBold);
  fontBoldRef.current = settings.editorFontBold;
  // 缩略图 / 缩进宽度同理：editor 与 model 只建一次，建的那一刻闭包里拿不到最新 state
  const minimapRef = useRef(settings.editorMinimap);
  minimapRef.current = settings.editorMinimap;
  const indentRef = useRef(settings.editorIndent);
  indentRef.current = settings.editorIndent;
  // 差异编辑器只在第一次要看差异时建，建实例那一刻闭包里拿不到最新 state，
  // 所以排布偏好也走 ref（和 fontSizeRef 同一套路）
  const diffSideBySideRef = useRef(diffSideBySide);
  diffSideBySideRef.current = diffSideBySide;

  // 只重算当前文件的脏标记：别的标签的 model 没在编辑器里，比较不了版本号。
  // 差异标签是只读的，永远没有脏标记
  const syncDirty = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") return;
    const key = tabKey(current);
    const cached = modelsRef.current.get(key);
    const model = editorRef.current?.getModel();
    const isDirty = Boolean(
      cached && model && model.getAlternativeVersionId() !== cached.savedVersionId,
    );
    setDirtyPaths((prev) => {
      if (prev.has(key) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  /**
   * 刷新状态栏的「当前文件视图信息」。光标一动就调，切标签 / 改选项也复用。
   * 只在编辑器确实挂着当前文本 model 时才算数：差异、图片、加载中都没有 model，
   * 这时把信息清空，状态栏左侧整块收起来。读到的值和上一次一样就直接 bail，不白渲染。
   */
  const refreshViewInfo = useCallback(() => {
    const current = activeRef.current;
    const model =
      current && current.kind === "file"
        ? modelsRef.current.get(tabKey(current))?.model ?? null
        : null;
    const editor = editorRef.current;
    if (!editor || !model || editor.getModel() !== model) {
      setViewInfo((prev) => (prev === null ? prev : null));
      return;
    }
    const position = editor.getPosition();
    const modelOptions = model.getOptions();
    const next: ViewInfo = {
      line: position?.lineNumber ?? 1,
      column: position?.column ?? 1,
      language: model.getLanguageId(),
      eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
      tabSize: modelOptions.tabSize,
      insertSpaces: modelOptions.insertSpaces,
      wordWrap: editor.getOption(monaco.editor.EditorOption.wordWrap) !== "off",
    };
    setViewInfo((prev) => (prev && sameViewInfo(prev, next) ? prev : next));
  }, []);

  /**
   * 按条件丢掉缓存里的 model，普通文件和差异（成对的）一起处理。返回被丢掉的
   * tabKey，调用处拿它清理脏标记和预览集合。只碰 ref，不碰 state。
   */
  const disposeModels = useCallback((match: (path: string, key: string) => boolean): string[] => {
    const dropped: string[] = [];

    for (const [key, cached] of modelsRef.current) {
      if (!match(cached.path, key)) continue;
      modelsRef.current.delete(key);
      // Monaco 不允许 dispose 正在编辑的 model，先把编辑器摘下来
      if (editorRef.current?.getModel() === cached.model) editorRef.current.setModel(null);
      cached.model.dispose();
      dropped.push(key);
    }

    for (const [key, pair] of diffModelsRef.current) {
      if (!match(pair.path, key)) continue;
      diffModelsRef.current.delete(key);
      const showing = diffRef.current?.getModel();
      if (showing && (showing.original === pair.original || showing.modified === pair.modified)) {
        diffRef.current?.setModel(null);
      }
      // 成对的 model 要一起销毁
      pair.original.dispose();
      pair.modified.dispose();
      dropped.push(key);
    }

    return dropped;
  }, []);

  /** 把已经销毁的标签从脏标记 / 预览集合里摘掉 */
  const forgetKeys = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    const prune = (prev: ReadonlySet<string>) => {
      let changed = false;
      const next = new Set(prev);
      for (const key of keys) if (next.delete(key)) changed = true;
      return changed ? next : prev;
    };
    setDirtyPaths(prune);
    setPreviewPaths(prune);
  }, []);

  /**
   * 鼠标松开后决定浮窗的去向：有非空选区就摆到选区末端下方，否则收起。
   * 用视口坐标（和工作区里其它弹出菜单一致），因为编辑器会随分栏拖动而移动。
   */
  const showFloatBar = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const dom = editor?.getDomNode();
    if (!editor || !model || !selection || selection.isEmpty() || !dom) {
      setFloatBar(null);
      return;
    }
    const text = model.getValueInRange(selection);
    // 全是空白（比如拖过一片缩进）没有送出去的意义
    if (!text.trim()) {
      setFloatBar(null);
      return;
    }
    const pos = editor.getScrolledVisiblePosition(selection.getEndPosition());
    if (!pos) {
      setFloatBar(null);
      return;
    }
    // 两个动作发的都是这个位置：整段贴过去对 AI CLI / 智能体都没用，位置的指代才是要的。
    // 只认普通文件标签——差异视图和预览不弹浮窗，这里再兜一层
    const current = activeRef.current;
    floatLocationRef.current =
      current && current.kind === "file"
        ? {
            path: relativeToRoot(current.path, rootFor(current.path)),
            start: selection.startLineNumber,
            end: selection.endLineNumber,
          }
        : null;
    const rect = dom.getBoundingClientRect();
    setFloatBar({ top: rect.top + pos.top + pos.height + 6, left: rect.left + pos.left });
  }, []);

  /** 点浮窗按钮：把快照里的位置交出去，然后收起浮窗 */
  const sendSelection = useCallback(
    (target: "terminal" | "agent") => {
      const location = floatLocationRef.current;
      setFloatBar(null);
      if (!location) return;
      if (target === "terminal") onSendToTerminal(location);
      else onSendToAgent(location);
    },
    [onSendToTerminal, onSendToAgent],
  );

  // 浮窗开着时点别处就收起。用 window 监听而不是透明遮罩——遮罩会把编辑器也挡住，
  // 选完还想接着编辑就点不动了
  useEffect(() => {
    if (!floatBar) return;
    const onDown = (event: MouseEvent) => {
      if (!floatRef.current?.contains(event.target as Node)) setFloatBar(null);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [floatBar]);

  /**
   * 把有未保存改动的文件写回磁盘；传 only（tabKey）就只存那一个。
   * 自动保存走"存全部"——别的标签切走后也可能留着没保存的 model。
   * 差异标签的 model 在另一个 Map 里，这里永远碰不到。
   */
  const persist = useCallback(async (only?: string): Promise<boolean> => {
    const targets = [...modelsRef.current.entries()].filter(
      ([key, cached]) =>
        (!only || key === only) &&
        cached.model.getAlternativeVersionId() !== cached.savedVersionId,
    );
    if (targets.length === 0) return true;

    setSaving(true);
    const saved = new Set<string>();
    let ok = true;
    try {
      for (const [key, cached] of targets) {
        await writeFile(
          rootFor(cached.path),
          cached.path,
          cached.model.getValue(),
          cached.encoding,
        );
        cached.savedVersionId = cached.model.getAlternativeVersionId();
        saved.add(key);
      }
    } catch (reason) {
      ok = false;
      setStatus({ kind: "error", message: `保存失败：${reason}` });
    } finally {
      setSaving(false);
      if (saved.size > 0) {
        setDirtyPaths((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const key of saved) if (next.delete(key)) changed = true;
          return changed ? next : prev;
        });
      }
    }
    return ok;
  }, []);

  // 快捷键和保存按钮只管当前文件；差异标签是只读的，按了没反应
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") return;
    void persist(tabKey(current));
  };

  // 自动保存要存全部，单独留一个给下面的 effect
  const persistRef = useRef(persist);
  persistRef.current = persist;

  /** 预览层的内容是渲染期从 model 现算的，替换改了内容后得让它重算 */
  const [previewNonce, setPreviewNonce] = useState(0);
  /** 待执行的定位请求；等标签切过去、model 就绪之后再应用 */
  const [reveal, setReveal] = useState<RevealTarget | null>(null);

  /**
   * 按指定编码把当前文件**从磁盘重读**并刷新 model。编码切换本质上是一次重新加载：
   * 旧内容的撤销历史针对的是旧解码结果，`setValue` 顺带清掉它才符合语义（保留下来会
   * 撤销回一段用错编码读出来的乱码）。之后保存按新编码走 `cached.encoding`。
   *
   * 已经加载成功的标签走「替换内容」；之前没加载成功的（编码认不出来、报错留在界面上）
   * 走「补建 model」——状态栏上的编码入口也是那种情况下的补救路径。
   */
  const applyEncoding = useCallback(
    async (tab: Tab, label: string) => {
      if (tab.kind !== "file") return;
      const key = tabKey(tab);
      const path = tab.path;
      const cached = modelsRef.current.get(key);
      // 已经是这个编码就不用重读
      if (cached && cached.encoding === label) return;

      setStatus({ kind: "loading" });
      let content;
      try {
        content = await readFile(rootFor(path), path, label);
      } catch (reason) {
        // 只有还停在同一个标签上才把错误亮出来
        if (activeRef.current && tabKey(activeRef.current) === key) {
          setStatus({ kind: "error", message: String(reason) });
        }
        return;
      }
      // 等这一下的工夫用户可能已经切走 / 关了标签，别把结果盖到别的标签上
      if (!activeRef.current || tabKey(activeRef.current) !== key) return;
      if (content.tooLarge) {
        setStatus({ kind: "tooLarge" });
        return;
      }
      if (content.isBinary) {
        setStatus({ kind: "binary" });
        return;
      }

      const editor = editorRef.current;
      if (cached) {
        cached.model.setValue(content.text);
        cached.savedVersionId = cached.model.getAlternativeVersionId();
        cached.encoding = content.encoding || label;
        // 标成干净的：刚才是整份从磁盘读回来的，和磁盘一致
        setDirtyPaths((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        // markdown 预览层按 activeKey 从 model 缓存取内容，得让它重算
        setPreviewNonce((count) => count + 1);
      } else {
        const uri = monaco.Uri.file(path);
        const language = languageOf(path);
        const existing = monaco.editor.getModel(uri);
        const model = existing ?? monaco.editor.createModel(content.text, language, uri);
        if (!existing) applyIndentToModel(model, indentRef.current);
        modelsRef.current.set(key, {
          path,
          model,
          // 版本号在重排之前取：json5/jsonc 自动重排后会算成未保存改动（和打开时一致）
          savedVersionId: model.getAlternativeVersionId(),
          encoding: content.encoding || label,
        });
        if (!existing && (language === "json5" || language === "jsonc")) {
          reindentModelOnOpen(model);
        }
        editor?.setModel(model);
      }
      setStatus({ kind: "ready" });
      syncDirty();
    },
    [rootFor, syncDirty],
  );

  /** 状态栏里选了某个编码：脏标签先确认（会丢掉未保存的改动），干净的直接切 */
  const requestEncodingSwitch = useCallback(
    (label: string) => {
      setEncodingMenu(null);
      const current = activeRef.current;
      if (!current || current.kind !== "file") return;
      const key = tabKey(current);
      const cached = modelsRef.current.get(key);
      if (cached && cached.encoding === label) return;
      if (cached && cached.model.getAlternativeVersionId() !== cached.savedVersionId) {
        setEncodingSwitch({ tab: current, label });
        return;
      }
      void applyEncoding(current, label);
    },
    [applyEncoding],
  );

  useImperativeHandle(
    ref,
    () => ({
      saveAll: () => persistRef.current(),

      reload: async (paths) => {
        const wanted = new Set(paths.map(pathKey));
        const done: string[] = [];
        let touched = false;

        for (const [key, cached] of modelsRef.current) {
          if (!wanted.has(pathKey(cached.path))) continue;
          // 编辑器里还留着没保存的改动就不覆盖，用户的编辑优先
          if (cached.model.getAlternativeVersionId() !== cached.savedVersionId) continue;
          try {
            const content = await readFile(rootFor(cached.path), cached.path);
            if (content.isBinary || content.tooLarge) continue;
            // 读文件这一下用户可能又敲进了改动，再查一次，编辑优先
            if (cached.model.getAlternativeVersionId() !== cached.savedVersionId) continue;
            // 磁盘上和 model 里一模一样就别 setValue——这一般是编辑器自己刚保存
            // 触发的回声，重设一遍会白白清掉撤销栈、还会把光标弹回开头
            if (cached.model.getValue() === content.text) continue;
            cached.model.setValue(content.text);
            cached.savedVersionId = cached.model.getAlternativeVersionId();
            // 外部可能用别的编码重写过这个文件，跟着更新，保存时按新编码回写
            cached.encoding = content.encoding;
            done.push(key);
            touched = true;
          } catch {
            // 读不回来的保持原样，界面上还有旧内容可用
          }
        }

        // 差异视图的基线是替换之前的，留着会显示出过期的对比，整对丢掉、下次切过去重拉
        for (const [key, pair] of diffModelsRef.current) {
          if (!wanted.has(pathKey(pair.path))) continue;
          diffModelsRef.current.delete(key);
          const showing = diffRef.current?.getModel();
          if (
            showing &&
            (showing.original === pair.original || showing.modified === pair.modified)
          ) {
            diffRef.current?.setModel(null);
          }
          pair.original.dispose();
          pair.modified.dispose();
        }

        if (done.length > 0) {
          setDirtyPaths((prev) => {
            const next = new Set(prev);
            for (const key of done) next.delete(key);
            return next;
          });
        }
        if (touched) setPreviewNonce((count) => count + 1);

        // 图片不进 modelsRef（缓存里不可能有它），正在看的那张单独重读一遍
        const current = activeRef.current;
        if (
          current &&
          current.kind === "file" &&
          isImagePath(current.path) &&
          paths.some((item) => pathKey(item) === pathKey(current.path))
        ) {
          try {
            const content = await readImage(rootFor(current.path), current.path);
            // 等这一下的时候用户可能已经切走了，别把结果盖到别的标签上
            const now = activeRef.current;
            if (now && now.kind === "file" && pathKey(now.path) === pathKey(current.path)) {
              setStatus(
                content.tooLarge ? { kind: "tooLarge" } : { kind: "image", src: content.data },
              );
            }
          } catch {
            // 读不回来的保持原样，界面上还有旧图可用
          }
        }
      },

      revealAt: (target) => setReveal(target),

      dropPaths: (paths) => {
        forgetKeys(
          disposeModels((path) => paths.some((item) => isPathInside(path, item))),
        );
      },

      dropDiffs: () => {
        const keys: string[] = [];
        for (const [key, pair] of diffModelsRef.current) {
          const showing = diffRef.current?.getModel();
          if (showing && (showing.original === pair.original || showing.modified === pair.modified)) {
            diffRef.current?.setModel(null);
          }
          pair.original.dispose();
          pair.modified.dispose();
          keys.push(key);
        }
        diffModelsRef.current.clear();
        forgetKeys(keys);
      },

      missingPaths: async (paths) => {
        const gone: string[] = [];
        for (const path of paths) {
          try {
            await readFile(rootFor(path), path);
          } catch {
            // 读不回来就算它没了。这里只处理「文件被删」这一种，二进制 / 过大的
            // 文件读得回来，不会误判
            gone.push(path);
          }
        }
        return gone;
      },

      // 关掉当前标签。焦点在右侧面板里时由 ToolPane 调它——差异标签就开在这根标签栏上
      closeActiveTab: () => {
        const current = activeRef.current;
        if (current) closeTabRef.current(current);
      },
    }),
    [disposeModels, forgetKeys],
  );

  /** 读一遍当前差异的改动块缓存进 ref 并同步数量；差异重算 / 换标签 / 打开时都走它 */
  const syncDiffChanges = useCallback(() => {
    const changes = diffRef.current?.getLineChanges() ?? [];
    diffChangesRef.current = changes;
    setDiffChangeCount(changes.length);
    return changes;
  }, []);

  /**
   * 把差异视图滚到第一处改动（在「变更」里点开一个文件时用）。
   * 差异是 Monaco 异步算出来的：model 刚挂上时 getLineChanges() 还是 null，得等
   * onDidUpdateDiff 再滚；复用缓存 model 时通常已经算好，当场就能滚。容器可能刚
   * 从 hidden 切到可见，等一帧让 Monaco 量到尺寸，否则滚不动。
   */
  const revealFirstDiffChange = useCallback(() => {
    const diff = diffRef.current;
    if (!diff) return;
    const changes = syncDiffChanges();
    if (changes.length === 0) return;
    diffRevealPendingRef.current = false;
    setDiffChangeIndex(0);
    // 纯删除的改动块里 modifiedStartLineNumber 可能落到区块前一行的位置，兜到 1
    const line = Math.max(1, changes[0].modifiedStartLineNumber);
    requestAnimationFrame(() => diffRef.current?.getModifiedEditor().revealLineInCenter(line));
  }, [syncDiffChanges]);

  /**
   * 跳到第 index 处改动（0 基，越界收进 [0, count-1]）。状态栏的上一处 / 下一处按钮与
   * F7 / Shift+F7 共用它；纯删除块的行号落到块前时兜到 1（同 revealFirstDiffChange）。
   */
  const gotoDiff = useCallback((index: number) => {
    const changes = diffChangesRef.current;
    if (changes.length === 0) return;
    const next = Math.min(Math.max(index, 0), changes.length - 1);
    setDiffChangeIndex(next);
    const line = Math.max(1, changes[next].modifiedStartLineNumber);
    diffRef.current?.getModifiedEditor().revealLineInCenter(line);
  }, []);

  /** 内联 / 并排切换：改实例选项、写回 sessionStorage，下次打开沿用 */
  const toggleDiffSideBySide = useCallback(() => {
    const next = !diffSideBySideRef.current;
    diffSideBySideRef.current = next;
    setDiffSideBySide(next);
    diffRef.current?.updateOptions({ renderSideBySide: next });
    try {
      window.sessionStorage.setItem(DIFF_SIDE_BY_SIDE_KEY, next ? "1" : "0");
    } catch {
      // 存不进去也无所谓，只是下次不记得选择
    }
    // 两侧宽度重排后补一次 layout，让行号栏宽度与滚动位置按新布局重算
    requestAnimationFrame(() => diffRef.current?.layout());
  }, []);

  // 差异编辑器只在第一次真的要看差异时才建：省一份初始化，
  // 也避免在 hidden（0 尺寸）的容器上建实例
  const ensureDiffEditor = useCallback(() => {
    if (diffRef.current) return;
    const container = diffContainerRef.current;
    if (!container) return;
    diffRef.current = monaco.editor.createDiffEditor(container, {
      // 排布读会话里的偏好（默认内联：新增/删除行上下相邻，窄面板下也比左右并排好读）
      renderSideBySide: diffSideBySideRef.current,
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      fontSize: fontSizeRef.current,
      fontFamily: resolveFont(fontFamilyRef.current),
      fontWeight: fontBoldRef.current ? "bold" : "normal",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      renderOverviewRuler: false,
      padding: { top: 8 },
    });
    // 差异算完的那一刻才知道第一处改动在哪；顺带把块数量同步给状态栏
    diffRef.current.onDidUpdateDiff(() => {
      if (diffRevealPendingRef.current) revealFirstDiffChange();
      else syncDiffChanges();
    });
  }, [revealFirstDiffChange, syncDiffChanges]);

  const showDiff = useCallback(
    async (tab: Extract<Tab, { kind: "diff" }>) => {
      const key = tabKey(tab);
      const cached = diffModelsRef.current.get(key);
      if (cached) {
        ensureDiffEditor();
        diffRef.current?.setModel(cached);
        setDiffStatus({ kind: "ready" });
        diffRevealPendingRef.current = true;
        revealFirstDiffChange();
        return;
      }

      setDiffStatus({ kind: "loading" });
      diffRef.current?.setModel(null);

      let payload;
      try {
        payload = await gitFileDiff(rootFor(tab.path), tab.path, tab.source);
      } catch (reason) {
        if (activeRef.current && tabKey(activeRef.current) === key) {
          setDiffStatus({ kind: "error", message: String(reason) });
        }
        return;
      }

      // 等待期间用户可能已经切走了，别把结果盖到别的标签上
      if (!activeRef.current || tabKey(activeRef.current) !== key) return;
      if (payload.tooLarge) {
        setDiffStatus({ kind: "tooLarge" });
        return;
      }
      if (payload.isBinary) {
        setDiffStatus({ kind: "binary" });
        return;
      }
      if (!payload.original && !payload.modified) {
        setDiffStatus({ kind: "emptyDiff" });
        return;
      }

      const language = languageOf(tab.path);
      const originalUri = diffUri(tab, "original");
      const modifiedUri = diffUri(tab, "modified");
      const pair: CachedDiff = {
        path: tab.path,
        original:
          monaco.editor.getModel(originalUri) ??
          monaco.editor.createModel(payload.original, language, originalUri),
        modified:
          monaco.editor.getModel(modifiedUri) ??
          monaco.editor.createModel(payload.modified, language, modifiedUri),
      };
      // 差异是只读的，缩进只影响显示宽度，直接按当前设置对齐两侧
      applyIndentToModel(pair.original, indentRef.current);
      applyIndentToModel(pair.modified, indentRef.current);
      diffModelsRef.current.set(key, pair);

      ensureDiffEditor();
      diffRef.current?.setModel(pair);
      setDiffStatus({ kind: "ready" });
      diffRevealPendingRef.current = true;
      revealFirstDiffChange();
    },
    [ensureDiffEditor, revealFirstDiffChange],
  );

  // editor 只建一次，切标签时换 model
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const themeName = monacoThemeFor(paletteRef.current, themeRef.current);
    monaco.editor.setTheme(themeName);
    const editor = monaco.editor.create(container, {
      theme: themeName,
      automaticLayout: true,
      fontSize: fontSizeRef.current,
      fontFamily: resolveFont(fontFamilyRef.current),
      fontWeight: fontBoldRef.current ? "bold" : "normal",
      minimap: { enabled: minimapRef.current, renderCharacters: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      tabSize: 2,
      padding: { top: 8 },
    });
    editorRef.current = editor;

    const contentSub = editor.onDidChangeModelContent(() => syncDirty());
    // 光标一动就刷新状态栏的 Ln, Col（顺带校正语言 / 缩进 / EOL 这几项）
    const cursorSub = editor.onDidChangeCursorPosition(() => refreshViewInfo());

    // 只有鼠标左键选完（拖拽 / 双击抬起）才弹浮窗，键盘 Shift 选择不弹，免得干扰打字；
    // 右键自带上下文菜单，这时不叠第二个
    const mouseUpSub = editor.onMouseUp((event) => {
      if (event.event.browserEvent.button !== 0) return;
      showFloatBar();
    });
    // 选区被清空、或内容滚动了，浮窗的位置立刻失真，直接收起
    const selectionSub = editor.onDidChangeCursorSelection((event) => {
      if (event.selection.isEmpty()) setFloatBar(null);
    });
    const scrollSub = editor.onDidScrollChange(() => setFloatBar(null));

    return () => {
      contentSub.dispose();
      cursorSub.dispose();
      mouseUpSub.dispose();
      selectionSub.dispose();
      scrollSub.dispose();
      editor.dispose();
      editorRef.current = null;
      for (const cached of modelsRef.current.values()) cached.model.dispose();
      modelsRef.current.clear();

      // diff 编辑器要先于它的 model 销毁
      diffRef.current?.dispose();
      diffRef.current = null;
      for (const pair of diffModelsRef.current.values()) {
        pair.original.dispose();
        pair.modified.dispose();
      }
      diffModelsRef.current.clear();
    };
  }, [syncDirty, showFloatBar, refreshViewInfo]);

  // 保存键可配置：单独挂一个 effect，改键位时重建 action。
  // 不能塞进上面那个建实例的 effect——它的依赖里没有 settings，改键位永远不会生效。
  // 声明在建实例之后，首次挂载跑起来时 editorRef 已经是新的编辑器了。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const keybinding = toMonacoKeybinding(settings.shortcuts["editor.save"]);
    const action = editor.addAction({
      id: "codedock.save",
      label: "保存文件",
      // 键位翻不出来就不注册键位，保存按钮和菜单里的该项仍可用
      keybindings: keybinding === null ? [] : [keybinding],
      run: () => {
        void saveRef.current();
      },
    });
    return () => action.dispose();
  }, [settings.shortcuts]);

  // 切主题不重建 editor，只换配色（差分编辑器共用全局主题）
  useEffect(() => {
    monaco.editor.setTheme(monacoThemeFor(palette, theme));
  }, [palette, theme]);

  // 字体/字号/字重同理。换字体后要让 Monaco 重新量一遍字宽，否则列宽还是旧字体的
  useEffect(() => {
    const options = {
      fontFamily: resolveFont(settings.editorFontFamily),
      fontSize: settings.editorFontSize,
      fontWeight: settings.editorFontBold ? "bold" : "normal",
    };
    editorRef.current?.updateOptions(options);
    diffRef.current?.updateOptions(options);
    monaco.editor.remeasureFonts();
  }, [
    settings.editorFontFamily,
    settings.editorFontSize,
    settings.editorFontBold,
  ]);

  // 缩略图是 editor 级选项，热更新即可（差异编辑器不显示缩略图，无需跟随）
  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: settings.editorMinimap } });
  }, [settings.editorMinimap]);

  // 缩进宽度是 model 级选项：改了要把缓存里的所有 model 一起更新（含差异两侧），
  // 否则已打开的文件还是旧缩进，切回来才发现不一致
  useEffect(() => {
    for (const cached of modelsRef.current.values()) {
      applyIndentToModel(cached.model, settings.editorIndent);
    }
    for (const pair of diffModelsRef.current.values()) {
      applyIndentToModel(pair.original, settings.editorIndent);
      applyIndentToModel(pair.modified, settings.editorIndent);
    }
    refreshViewInfo();
  }, [settings.editorIndent, refreshViewInfo]);

  // 自动保存：时机照 VS Code 那套，落盘统一走 persist
  useEffect(() => {
    const mode = settings.editorAutoSave;
    if (mode === "off") return;

    // afterDelay 盯的是内容变化，另外两种等的是事件，所以分开挂
    if (mode === "afterDelay") {
      const editor = editorRef.current;
      if (!editor) return;
      let timer: number | undefined;
      const sub = editor.onDidChangeModelContent(() => {
        // 手一直不停就一直往后推，停下来才落盘
        window.clearTimeout(timer);
        timer = window.setTimeout(
          () => void persistRef.current(),
          settings.editorAutoSaveDelay,
        );
      });
      return () => {
        sub.dispose();
        window.clearTimeout(timer);
      };
    }

    if (mode === "onFocusChange") {
      const editor = editorRef.current;
      if (!editor) return;
      const sub = editor.onDidBlurEditorText(() => void persistRef.current());
      return () => sub.dispose();
    }

    // onWindowChange：整个窗口失焦时存一次
    const onBlur = () => void persistRef.current();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [settings.editorAutoSave, settings.editorAutoSaveDelay]);

  // 切标签：文件走一套（换成文件 model），差异走另一套（跟 git 要两侧内容）
  useEffect(() => {
    activeRef.current = active;
    // 换了标签，上一次的浮窗不再对应任何文本
    setFloatBar(null);
    const editor = editorRef.current;
    if (!editor) return;

    if (!active) {
      editor.setModel(null);
      diffRef.current?.setModel(null);
      setStatus({ kind: "idle" });
      setDiffStatus({ kind: "idle" });
      return;
    }

    if (active.kind === "diff") {
      // 文件编辑器摘掉 model，免得它在后面白白占着
      editor.setModel(null);
      setStatus({ kind: "idle" });
      void showDiff(active);
      return;
    }

    diffRef.current?.setModel(null);
    setDiffStatus({ kind: "idle" });

    const key = tabKey(active);

    // 图片整张读回来当 data URL 渲染，不进 Monaco——二进制没有 model 可言。
    // 放在缓存查找之前：图片永远不进 modelsRef，缓存里不可能有它
    if (isImagePath(active.path)) {
      let cancelled = false;
      setStatus({ kind: "loading" });
      editor.setModel(null);

      void readImage(rootFor(active.path), active.path)
        .then((content) => {
          if (cancelled || !activeRef.current || tabKey(activeRef.current) !== key) return;
          if (content.tooLarge) {
            setStatus({ kind: "tooLarge" });
            return;
          }
          setStatus({ kind: "image", src: content.data });
        })
        .catch((reason) => {
          if (cancelled || !activeRef.current || tabKey(activeRef.current) !== key) return;
          setStatus({ kind: "error", message: String(reason) });
        });

      return () => {
        cancelled = true;
      };
    }

    const cached = modelsRef.current.get(key);
    if (cached) {
      editor.setModel(cached.model);
      setStatus({ kind: "ready" });
      syncDirty();
      return;
    }

    const path = active.path;
    let cancelled = false;
    setStatus({ kind: "loading" });
    editor.setModel(null);

    void readFile(rootFor(path), path)
      .then((content) => {
        if (cancelled || !activeRef.current || tabKey(activeRef.current) !== key) return;
        if (content.tooLarge) {
          setStatus({ kind: "tooLarge" });
          return;
        }
        if (content.isBinary) {
          setStatus({ kind: "binary" });
          return;
        }
        const uri = monaco.Uri.file(path);
        const language = languageOf(path);
        const existing = monaco.editor.getModel(uri);
        const model = existing ?? monaco.editor.createModel(content.text, language, uri);
        if (!existing) applyIndentToModel(model, indentRef.current);
        // savedVersionId 取「重排之前」的版本号：json5/jsonc 打开时会自动重排，
        // 于是重排完立刻算未保存改动（用户 Ctrl+Z 撤销回原缩进时，版本号回到这里又会变干净）
        modelsRef.current.set(key, {
          path,
          model,
          savedVersionId: model.getAlternativeVersionId(),
          encoding: content.encoding,
        });
        // 只对首次创建的 json5 / jsonc 自动重排；缓存 model 与差异 model 都到不了这里
        if (!existing && (language === "json5" || language === "jsonc")) {
          reindentModelOnOpen(model);
        }
        editor.setModel(model);
        setStatus({ kind: "ready" });
        syncDirty();
      })
      .catch((reason) => {
        if (cancelled || !activeRef.current || tabKey(activeRef.current) !== key) return;
        setStatus({ kind: "error", message: String(reason) });
      });

    return () => {
      cancelled = true;
    };
  }, [active, syncDirty, showDiff]);

  // 搜索结果的定位：等标签切过去、model 挂上之后再选中并滚过去
  useEffect(() => {
    if (!reveal || !active || active.kind !== "file") return;
    if (status.kind !== "ready") return;
    if (pathKey(active.path) !== pathKey(reveal.path)) return;

    const editor = editorRef.current;
    if (!editor || !editor.getModel()) return;

    // 预览模式下先退回编辑，否则高亮落在 hidden 的编辑器里，用户什么都看不到
    const key = tabKey(active);
    setPreviewPaths((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

    editor.setSelection(
      new monaco.Range(
        reveal.line,
        reveal.column,
        reveal.line,
        reveal.column + reveal.length,
      ),
    );
    editor.revealLineInCenter(reveal.line);
    editor.focus();
  }, [reveal, active, status.kind]);

  /**
   * 切换当前文件的编辑/预览模式。用 ref 读当前标签，省得 active 一变就重建这个回调。
   * markdown 从 model 现渲染、实时；html / svg 的预览走 asset 协议读磁盘，所以进入
   * 预览前先把未保存的改动落盘（保存失败就不进，错误由 persist 亮出来）。
   */
  const togglePreview = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") return;
    const key = tabKey(current);
    if (previewPathsRef.current.has(key)) {
      setPreviewPaths((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    const enter = () => setPreviewPaths((prev) => new Set(prev).add(key));
    if (!isHtmlPreviewPath(current.path)) {
      enter();
      return;
    }
    void persistRef.current(key).then((ok) => {
      if (!ok) return;
      // 重新加载 iframe：磁盘内容可能刚被保存改过
      setPreviewNonce((count) => count + 1);
      enter();
    });
  }, []);

  /**
   * 这批关闭动作涉及的标签里哪些有未保存的改动，拼一句确认文案；一个都没有就返回 null
   * （不用弹框，直接关）。单个关闭报文件名，批量关闭只列前几个，别把十几个名字铺满整屏。
   */
  const dirtyLabel = useCallback(
    (request: CloseRequest): string | null => {
      const targets =
        request.kind === "one"
          ? [request.tab]
          : tabs.filter(
              (tab) => request.kind === "all" || !active || !sameTab(tab, active),
            );
      const names = targets
        .filter((tab) => dirtyPaths.has(tabKey(tab)))
        .map((tab) => baseName(tab.path));
      if (names.length === 0) return null;
      if (names.length === 1) return `${names[0]} 有未保存的改动，确定关闭吗？`;
      const shown =
        names.length > 3
          ? `${names.slice(0, 3).join("、")} 等 ${names.length} 个`
          : names.join("、");
      return `有未保存改动的文件：${shown}，确定关闭吗？`;
    },
    [tabs, active, dirtyPaths],
  );

  /**
   * 真正执行关闭：把要关的 model 一并 dispose、清掉脏标记，再让上层收掉标签。
   * 批量关闭必须走这里——只改标签数组的话 model 会留在缓存里，重开同一个文件
   * 又冒出旧改动，和「标签已关」自相矛盾。
   */
  const performClose = useCallback(
    (request: CloseRequest) => {
      if (request.kind === "one") {
        const key = tabKey(request.tab);
        forgetKeys(disposeModels((_, current) => current === key));
        onClose(request.tab);
        return;
      }
      if (request.kind === "all") {
        forgetKeys(disposeModels(() => true));
        onCloseAll();
        return;
      }
      const keep = active ? tabKey(active) : null;
      forgetKeys(disposeModels((_, key) => key !== keep));
      onCloseOthers();
    },
    [active, onClose, onCloseAll, onCloseOthers, disposeModels, forgetKeys],
  );

  /**
   * 关闭的统一入口：有未保存改动就先弹自研确认框——WKWebView（macOS）不支持
   * `window.confirm`，调了会静默返回、直接跳过确认，所以不能再走原生那个。
   * 单个关闭和关闭全部 / 关闭其他共用这一条分支，不再各写一套。
   */
  const requestClose = useCallback(
    (request: CloseRequest) => {
      // 关闭其他时当前标签要留着，没有当前标签就没得可关
      if (request.kind === "others" && !active) return;
      const message = dirtyLabel(request);
      if (!message) {
        performClose(request);
        return;
      }
      setCloseRequest({ request, message });
    },
    [active, dirtyLabel, performClose],
  );

  const closeTab = useCallback(
    (tab: Tab) => requestClose({ kind: "one", tab }),
    [requestClose],
  );
  closeTabRef.current = closeTab;

  /**
   * 关掉当前标签（文件标签和差异标签同一根标签栏，走同一套逻辑）。键位可配置，
   * 默认 Ctrl/Cmd+W。
   *
   * 挂在编辑器区最外层、**捕获阶段**：焦点在标签栏按钮上、或落在 Monaco 里都收得到，
   * 而且抢在 Monaco 自己的按键处理之前把事件吃掉。焦点在右侧面板里时另有一份处理
   * （见 ToolPane），所以这里只管编辑器区内。
   */
  const onPaneKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const current = activeRef.current;
    // 差异视图的改动跳转：F7 下一处、Shift+F7 上一处。裸功能键进不了 shortcuts 表
    // （那张表要求带 Mod/Ctrl 前缀），所以在差异标签上就地处理。挂在捕获阶段还能抢在
    // Monaco 自带的 diffReview 键位（默认也用 F7）之前，吃掉它、免得两头各跳一次。
    if (
      current?.kind === "diff" &&
      diffStatus.kind === "ready" &&
      event.key === "F7" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      gotoDiff(diffChangeIndex + (event.shiftKey ? -1 : 1));
      return;
    }
    if (!matchesShortcut(event, settings.shortcuts["closeTab"])) return;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    closeTabRef.current(current);
  };

  const isDiffTab = active?.kind === "diff";
  const activeKey = active ? tabKey(active) : null;

  // 图片没有"编辑/预览"两个模式，打开就是预览。判据用 active 而不是 status：
  // 加载中和加载失败时也得把 Monaco 那块藏住，否则会露出上一次的残留内容
  const isImageTab = active?.kind === "file" && isImagePath(active.path);

  // 有预览可切的文件：markdown 实时渲染，html / htm / svg 走 asset 协议读磁盘。
  // 判据是 status.kind === "ready"：加载中和加载失败时不给预览入口
  const canPreview =
    status.kind === "ready" &&
    active?.kind === "file" &&
    (languageOf(active.path) === "markdown" || isHtmlPreviewPath(active.path));
  const isPreview = canPreview && activeKey !== null && previewPaths.has(activeKey);
  const isMarkdownPreview =
    isPreview && active?.kind === "file" && languageOf(active.path) === "markdown";
  const isHtmlPreview =
    isPreview && active?.kind === "file" && isHtmlPreviewPath(active.path);

  // 进预览时同步渲染一次：放在渲染期算完，就不会先闪一帧空白。
  // 内容按 activeKey 从缓存里取，**不能**读编辑器当前挂着的 model：换 model 的
  // effect 在渲染之后才跑，切到另一个 md 标签的这一帧读到的还是上一个文件的
  // model；而 isMarkdownPreview 由 false 变 true 就发生在这同一帧，等 effect 把 model
  // 换好之后依赖没再变过，memo 不会重算，上一个文件的内容就永久留在预览层上了。
  // 预览期间编辑器是 hidden 的、内容改不了，缓存里那份就是当前内容。
  const previewHtml = useMemo(() => {
    if (!isMarkdownPreview || activeKey === null) return "";
    const model = modelsRef.current.get(activeKey)?.model;
    return model ? renderMarkdown(model.getValue()) : "";
  }, [isMarkdownPreview, activeKey, previewNonce]);

  // 预览或差异视图下 Monaco 容器是 hidden 的、量不到尺寸，切回可见得补一次 layout，
  // 否则行号栏宽度和滚动位置还是按 0 尺寸算出来的；工作区从后台切回来时同理
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      editorRef.current?.layout();
      diffRef.current?.layout();
    });
    return () => cancelAnimationFrame(frame);
  }, [isPreview, isDiffTab, isImageTab, visible]);

  // 标签过多、栏溢出时，激活标签可能落在可视区外，需要滚进来。
  // 用两边的 rect 差算滚动量、只挪横向，避免 scrollIntoView 连祖先的纵向滚动一起动。
  useEffect(() => {
    const scroller = tabsScrollRef.current;
    const el = scroller?.querySelector<HTMLElement>("[data-tab-active]");
    if (!scroller || !el) return;
    const view = scroller.getBoundingClientRect();
    const tab = el.getBoundingClientRect();
    if (tab.left < view.left) {
      scroller.scrollLeft -= view.left - tab.left;
    } else if (tab.right > view.right) {
      scroller.scrollLeft += tab.right - view.right;
    }
  }, [activeKey]);

  // 当前文件的编码。直接从 model 缓存里现取（每次渲染都算）：加载完成、切标签、切编码
  // 都会走一次渲染，取到的自然是最新的；不用 state 单独存一份，省得两处对不上。
  const activeEncoding = activeKey ? modelsRef.current.get(activeKey)?.encoding || null : null;

  /**
   * 编码状态栏只在普通文本文件上出现：差异、图片没有「按原编码回写」这回事；
   * 二进制 / 超限也没有 model 可重读。编码已知、或加载失败（认不出编码）时显示——
   * 后者正是它的补救入口。首次加载中不显示，免得和正在跑的加载抢着建 model。
   */
  const showEncodingBar =
    active?.kind === "file" &&
    !isImageTab &&
    status.kind !== "binary" &&
    status.kind !== "tooLarge" &&
    (activeEncoding !== null || status.kind === "error");

  /**
   * 差异标签就绪时也要状态栏：放「内联/并排切换 + 上一处/下一处 + 第 x / N 处」。
   * 差异没有 viewInfo，光靠原来那两个条件状态栏整块都不显示。
   */
  const showDiffBar = isDiffTab && diffStatus.kind === "ready";

  const activeDirty = activeKey !== null && dirtyPaths.has(activeKey);
  const overlay: Status = isDiffTab ? diffStatus : status;

  // 切标签 / 文件加载完成后刷一次状态栏信息。声明在「换 model」那个 effect 之后，
  // 保证轮到它时 editor 上挂的已经是新 model（effect 按声明顺序跑）
  useEffect(() => {
    refreshViewInfo();
  }, [activeKey, status.kind, refreshViewInfo]);

  /** 打开状态栏下拉：位置取按钮左边缘 + 顶边，菜单顶到它上方 */
  const openStatusMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    items: StatusMenuItem[],
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setStatusMenu({ x: rect.left, y: rect.top, items });
  };

  /** 当前文本 model；不在文本文件上（差异 / 图片 / 加载中）返回 null */
  const activeTextModel = () => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") return null;
    return modelsRef.current.get(tabKey(current))?.model ?? null;
  };

  /** 换语言：走 Monaco 的 setModelLanguage，只改语法着色，不动文件内容 */
  const applyLanguage = (id: string) => {
    setStatusMenu(null);
    const model = activeTextModel();
    if (!model) return;
    monaco.editor.setModelLanguage(model, id);
    refreshViewInfo();
  };

  /** 换行符：用 pushEOL（一次可撤销的内容编辑），不用会清掉撤销栈的 setEOL */
  const applyEol = (eol: "LF" | "CRLF") => {
    setStatusMenu(null);
    const model = activeTextModel();
    if (!model) return;
    model.pushEOL(
      eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF,
    );
    refreshViewInfo();
  };

  /** 缩进：作用在 model 上，只影响这个文件的编辑行为 */
  const applyIndent = (tabSize: number, insertSpaces: boolean) => {
    setStatusMenu(null);
    const model = activeTextModel();
    if (!model) return;
    model.updateOptions({ tabSize, insertSpaces });
    refreshViewInfo();
  };

  /** 自动换行开关：作用在 editor 实例上，不写进 model */
  const toggleWordWrap = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const on = editor.getOption(monaco.editor.EditorOption.wordWrap) !== "off";
    editor.updateOptions({ wordWrap: on ? "off" : "on" });
    refreshViewInfo();
  };

  /** 语言菜单项：Monaco 已注册的全部语言，按显示名排序 */
  const languageItems = (): StatusMenuItem[] =>
    monaco.languages
      .getLanguages()
      .map((lang) => ({ id: lang.id, label: lang.aliases?.[0] ?? lang.id }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((lang) => ({
        key: `lang-${lang.id}`,
        label: lang.label,
        checked: viewInfo?.language === lang.id,
        onPick: () => applyLanguage(lang.id),
      }));

  /** 缩进菜单项：空格 2 / 4 / 8，外加「制表符」 */
  const indentItems = (): StatusMenuItem[] => {
    const items: StatusMenuItem[] = [2, 4, 8].map((size) => ({
      key: `spaces-${size}`,
      label: `空格: ${size}`,
      checked: viewInfo?.insertSpaces === true && viewInfo.tabSize === size,
      onPick: () => applyIndent(size, true),
    }));
    items.push({
      key: "tab",
      label: "制表符（Tab）",
      checked: viewInfo?.insertSpaces === false,
      onPick: () => applyIndent(viewInfo?.tabSize ?? 4, false),
    });
    return items;
  };

  /** 换行符菜单项 */
  const eolItems = (): StatusMenuItem[] => [
    { key: "lf", label: "LF", checked: viewInfo?.eol === "LF", onPick: () => applyEol("LF") },
    {
      key: "crlf",
      label: "CRLF",
      checked: viewInfo?.eol === "CRLF",
      onPick: () => applyEol("CRLF"),
    },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface" onKeyDownCapture={onPaneKeyDown}>
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <div
          ref={tabsScrollRef}
          onClickCapture={onClickCapture}
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.length === 0 && (
            <span className="px-1 text-[11px] text-fg-faint">未打开文件</span>
          )}
          {tabs.map((tab, index) => {
            const key = tabKey(tab);
            const isActive = active !== null && tabKey(active) === key;
            const isDirty = dirtyPaths.has(key);
            const mark = gitMarks.get(pathKey(tab.path));
            const suffix = tabSuffix(tab);
            const dropBefore = dropIndex === index;
            const dropAfter = dropIndex === tabs.length && index === tabs.length - 1;
            return (
              <div
                key={key}
                data-tab-item
                data-tab-active={isActive ? "" : undefined}
                onPointerDown={onTabDown(index)}
                className={`relative flex shrink-0 items-center rounded ${
                  isActive ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
                } ${dragFrom === index ? "opacity-40" : ""}`}
              >
                {/* 落点线：插在某个标签之前画在它左缘，插在末尾画在最后一个标签右缘 */}
                {(dropBefore || dropAfter) && (
                  <span
                    className={`pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 rounded bg-accent-strong ${
                      dropBefore ? "-left-0.5" : "-right-0.5"
                    }`}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onActivate(tab)}
                  title={tabTitle(tab)}
                  className="flex max-w-[200px] items-center py-0.5 pl-2 text-[11px]"
                >
                  <span className="truncate">{baseName(tab.path)}</span>
                  {suffix && (
                    <span className="ml-1 shrink-0 text-[10px] text-fg-faint">{suffix}</span>
                  )}
                  {/* 未保存的改动比 git 状态更要紧，两者只占同一个位置 */}
                  {isDirty ? (
                    <span className="ml-1 shrink-0 text-warn" title="有未保存的改动">
                      ●
                    </span>
                  ) : (
                    mark && <GitMarkBadge mark={mark} className="ml-1 text-[10px]" />
                  )}
                </button>
                <button
                  type="button"
                  data-tab-close
                  onClick={() => closeTab(tab)}
                  title="关闭这个标签"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:text-danger"
                >
                  <IconClose className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        {/* 批量关闭入口。紧贴 tab 栏右端，只在有标签时出现 */}
        {tabs.length > 0 && (
          <button
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setTabsMenu({ x: rect.right, y: rect.bottom });
            }}
            title="标签操作"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
          >
            <IconMore className="h-3.5 w-3.5" />
          </button>
        )}
        {canPreview && (
          <button
            type="button"
            onClick={togglePreview}
            title={isPreview ? "回到编辑" : "预览"}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
          >
            {isPreview ? (
              <IconPencil className="h-3.5 w-3.5" />
            ) : (
              <IconEye className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {activeDirty && (
          <button
            type="button"
            onClick={() => saveRef.current()}
            disabled={saving}
            className="shrink-0 rounded border border-accent-line px-2 py-0.5 text-[11px] text-accent-soft hover:bg-active disabled:opacity-50"
          >
            {/* 文案跟随可配置快捷键，改键后这里也跟着变，不再写死 Ctrl+S */}
            {saving ? "保存中…" : `保存 ${formatShortcut(settings.shortcuts["editor.save"])}`}
          </button>
        )}
        {/* 右边栏整体的全屏开关，三个模块共用这一个位置（浏览器模块时这一列是浏览器自己） */}
        <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
      </header>

      {/* 标签「⋯」菜单。fixed 定位：标题栏是横向滚动容器，绝对定位会被 overflow 裁掉 */}
      {tabsMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setTabsMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: TABS_MENU_W,
              left: tabsMenu.x - TABS_MENU_W,
              top: Math.min(tabsMenu.y + 4, window.innerHeight - 72),
            }}
          >
            <button
              type="button"
              onClick={() => {
                setTabsMenu(null);
                requestClose({ kind: "others" });
              }}
              disabled={tabs.length <= 1}
              className={TABS_MENU_ITEM}
            >
              关闭其他
            </button>
            <button
              type="button"
              onClick={() => {
                setTabsMenu(null);
                requestClose({ kind: "all" });
              }}
              className={TABS_MENU_ITEM}
            >
              关闭全部
            </button>
          </div>
        </>
      )}

      {/* 编码菜单。状态栏在底部，用 bottom 定位到按钮上方（不估高度，靠 bottom 顶住） */}
      {encodingMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setEncodingMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: ENCODING_MENU_W,
              left: Math.min(encodingMenu.x - ENCODING_MENU_W, window.innerWidth - ENCODING_MENU_W - 4),
              bottom: window.innerHeight - encodingMenu.y + 4,
            }}
          >
            {ENCODINGS.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => requestEncodingSwitch(item.label)}
                title={`按 ${item.name} 重新读取这个文件`}
                className={TABS_MENU_ITEM}
              >
                <span className="flex items-center gap-1.5">
                  <span className="flex w-3 shrink-0 justify-center">
                    {activeEncoding === item.label && <IconCheck className="h-3 w-3 text-ok" />}
                  </span>
                  {item.name}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* 状态栏左侧的下拉（语言 / 缩进 / 换行符）。状态栏在底部，用 bottom 顶到按钮上方；
          语言列表长，超出上限就滚 */}
      {statusMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setStatusMenu(null)} />
          <div
            className="fixed z-40 flex max-h-[320px] flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: STATUS_MENU_W,
              left: Math.min(statusMenu.x, window.innerWidth - STATUS_MENU_W - 4),
              bottom: window.innerHeight - statusMenu.y + 4,
            }}
          >
            {statusMenu.items.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={item.onPick}
                className={TABS_MENU_ITEM}
              >
                <span className="flex items-center gap-1.5">
                  <span className="flex w-3 shrink-0 justify-center">
                    {item.checked && <IconCheck className="h-3 w-3 text-ok" />}
                  </span>
                  {item.label}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className={isPreview || isDiffTab || isImageTab ? "hidden" : "absolute inset-0"}
        />
        <div
          ref={diffContainerRef}
          className={isDiffTab ? "absolute inset-0" : "hidden"}
        />

        {isMarkdownPreview && <MarkdownPreview html={previewHtml} />}
        {/* html / htm / svg 预览：iframe 走 asset 协议读磁盘，相对路径的 css / js / 图片一并生效 */}
        {isHtmlPreview && active && active.kind === "file" && (
          <HtmlPreview path={active.path} nonce={previewNonce} />
        )}

        {/* 图片按原比例整体放进可视区，不放大也不让横竖滚动条出场 */}
        {status.kind === "image" && (
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden p-4">
            <img
              src={status.src}
              alt={active ? baseName(active.path) : ""}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}

        {overlay.kind !== "ready" && overlay.kind !== "image" && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface px-6 text-center">
            {overlay.kind === "idle" && (
              <p className="text-[12px] text-fg-faint">
                {isDiffTab ? "加载差异中…" : "从左侧文件树选一个文件"}
              </p>
            )}
            {overlay.kind === "loading" && (
              <p className="text-[12px] text-fg-faint">
                {isDiffTab ? "加载差异中…" : "加载中…"}
              </p>
            )}
            {overlay.kind === "binary" && (
              <p className="text-[12px] text-warn">
                {isDiffTab ? "二进制文件，无法显示差异" : "二进制文件，无法以文本方式编辑"}
              </p>
            )}
            {overlay.kind === "tooLarge" && (
              <p className="text-[12px] text-warn">
                {isDiffTab
                  ? "文件超过 2MB，已跳过差异加载"
                  : isImageTab
                    ? "图片超过 10MB，已跳过预览"
                    : "文件超过 2MB，已跳过加载"}
              </p>
            )}
            {overlay.kind === "emptyDiff" && (
              <p className="text-[12px] text-fg-faint">没有可显示的差异</p>
            )}
            {overlay.kind === "error" && (
              <p className="text-[12px] text-danger">{overlay.message}</p>
            )}
          </div>
        )}
      </div>

      {/* 状态栏。普通文件左侧是光标位置与视图选项（语言 / 缩进 / 换行符 / 自动换行），
          差异标签左侧换成排布切换与改动跳转；右侧仍只放文件编码入口（行为不变）。
          图片 / 加载中没有 viewInfo，左侧整块收起 */}
      {(showEncodingBar || viewInfo !== null || showDiffBar) && (
        <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-line px-1.5">
          <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
            {showDiffBar && (
              <>
                <button
                  type="button"
                  onClick={toggleDiffSideBySide}
                  title={diffSideBySide ? "切换到内联视图" : "切换到并排视图"}
                  className={STATUS_ICON_BUTTON}
                >
                  {diffSideBySide ? (
                    <IconLayoutSingle className="h-3.5 w-3.5" />
                  ) : (
                    <IconLayoutColumns className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => gotoDiff(diffChangeIndex - 1)}
                  disabled={diffChangeCount <= 1}
                  title="上一处改动（Shift+F7）"
                  className={STATUS_ICON_BUTTON}
                >
                  <IconArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => gotoDiff(diffChangeIndex + 1)}
                  disabled={diffChangeCount <= 1}
                  title="下一处改动（F7）"
                  className={STATUS_ICON_BUTTON}
                >
                  <IconArrowDown className="h-3.5 w-3.5" />
                </button>
                <span
                  title="当前位置"
                  className="shrink-0 px-1.5 text-[11px] tabular-nums text-fg-dim"
                >
                  {diffChangeCount === 0 ? "无改动" : `第 ${diffChangeIndex + 1} / ${diffChangeCount} 处`}
                </span>
              </>
            )}
            {!showDiffBar && viewInfo && (
              <>
                <span
                  title="光标位置"
                  className="shrink-0 px-1.5 text-[11px] tabular-nums text-fg-dim"
                >
                  行 {viewInfo.line}，列 {viewInfo.column}
                </span>
                <button
                  type="button"
                  onClick={(event) => openStatusMenu(event, languageItems())}
                  title="语言模式（点击切换）"
                  className={STATUS_BUTTON}
                >
                  {languageLabel(viewInfo.language)}
                </button>
                <button
                  type="button"
                  onClick={(event) => openStatusMenu(event, indentItems())}
                  title="缩进（点击切换）"
                  className={STATUS_BUTTON}
                >
                  {viewInfo.insertSpaces ? `空格: ${viewInfo.tabSize}` : "制表符"}
                </button>
                <button
                  type="button"
                  onClick={(event) => openStatusMenu(event, eolItems())}
                  title="换行符（点击切换）"
                  className={STATUS_BUTTON}
                >
                  {viewInfo.eol}
                </button>
                <button
                  type="button"
                  onClick={toggleWordWrap}
                  title="自动换行"
                  className={STATUS_BUTTON}
                >
                  {viewInfo.wordWrap ? "自动换行" : "不换行"}
                </button>
              </>
            )}
          </div>
          {showEncodingBar && (
            <button
              type="button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setEncodingMenu({ x: rect.right, y: rect.top });
              }}
              title="文件编码（点击切换，切换后按新编码重新读取）"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-hover hover:text-fg"
            >
              <span>{activeEncoding ? encodingName(activeEncoding) : "编码"}</span>
              <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
            </button>
          )}
        </div>
      )}

      {/* 选中文本后的小浮窗：位置在选中那一刻算好就不再跟，滚动或换标签会把它收掉 */}
      {floatBar && (
        <div
          ref={floatRef}
          className="fixed z-40 flex items-center gap-0.5 rounded border border-line-strong bg-raised p-0.5 shadow-lg"
          style={{
            top: floatBar.top,
            // 靠右边缘时往回收，别把浮窗顶出可视区
            left: Math.min(floatBar.left, window.innerWidth - FLOAT_BAR_W - 4),
          }}
          // 别让编辑器在这里失焦、把选区丢掉；click 照样会派发
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            title="复制到终端"
            onClick={() => sendSelection("terminal")}
            className={FLOAT_BAR_BUTTON}
          >
            <IconTerminal className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="复制到智能体输入框"
            disabled={!settings.agentEnabled}
            onClick={() => sendSelection("agent")}
            className={FLOAT_BAR_BUTTON}
          >
            <IconBot className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 切编码会从磁盘重读，等于丢掉未保存的改动，脏标签先确认 */}
      {encodingSwitch && (
        <ConfirmDialog
          message={`按 ${encodingName(encodingSwitch.label)} 重新读取 ${baseName(
            encodingSwitch.tab.path,
          )}，未保存的改动会丢失，确定吗？`}
          confirmLabel="丢弃改动"
          onConfirm={() => {
            const { tab, label } = encodingSwitch;
            setEncodingSwitch(null);
            void applyEncoding(tab, label);
          }}
          onCancel={() => setEncodingSwitch(null)}
        />
      )}

      {/* 关闭有未保存改动的标签（单个 / 全部 / 其他）前先确认，统一走自研确认框 */}
      {closeRequest && (
        <ConfirmDialog
          message={closeRequest.message}
          confirmLabel="放弃改动"
          onConfirm={() => {
            const { request } = closeRequest;
            setCloseRequest(null);
            performClose(request);
          }}
          onCancel={() => setCloseRequest(null)}
        />
      )}
    </section>
  );
}
