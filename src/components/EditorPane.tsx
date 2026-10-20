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
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  canFormatTab,
  errorText,
  formatIssueLocation,
  formatText,
  issueSignature,
  supportsFormatting,
  validateText,
} from "../lib/formatter";
import { renderMarkdown } from "../lib/markdown";
import { isDocumentPath } from "../lib/translate";
import { clearTranslation } from "../lib/translate-store";
import { addRecent } from "../lib/recent";
import { parseShortcut, matchesShortcut, formatShortcut } from "../lib/shortcuts";
import {
  ENCODINGS,
  encodingName,
  gitFileDiff,
  isPathInside,
  ownerRoot,
  pathKey,
  pathsExist,
  pickOpenPath,
  pickSavePath,
  readFile,
  readImage,
  toDisplayPath,
  writeFile,
} from "../lib/fs";
import type { GitMark } from "../lib/git";
import { useSettings, resolveFont, type EditorIndent, type EditorLineHeight } from "../lib/settings";
import { useTabReorder } from "../lib/use-tab-reorder";
import {
  fileTabKey,
  patchTab,
  sameTab,
  tabKey,
  tabName,
  tabSuffix,
  tabTitle,
  type ExternalState,
  type FileTab,
  type Tab,
  type TabPatch,
} from "../lib/tabs";
import type { EditorLocation, Eol, FileContent } from "../lib/types";
import { useTheme } from "../lib/theme";
import { GitMarkBadge } from "./GitMarkBadge";
import { FullscreenButton } from "./FullscreenButton";
import { HtmlPreview } from "./HtmlPreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { TranslationView } from "./TranslationView";
import { PdfPreview } from "./PdfPreview";
import { SplitPane } from "./SplitPane";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsLeftRight,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconEye,
  IconLayoutColumns,
  IconLayoutSingle,
  IconMore,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTerminal,
  IconWand,
} from "./icons";

/** 选中浮窗的估算宽度，用来把它收进窗口右边缘 */
const FLOAT_BAR_W = 76;

/** 标签「⋯」菜单：宽度和条目样式，跟 Sidebar 的同类菜单保持一致 */
const TABS_MENU_W = 112;

/** 标签右键菜单的宽度：里面有「重新加载（放弃我的修改）」这种长文案 */
const TAB_MENU_W = 190;

/** markdown 的四种查看方式，顺序也是标题栏按钮的顺序 */
const MARKDOWN_MODES = [
  { id: "preview", label: "预览" },
  { id: "edit", label: "编辑" },
  { id: "split", label: "对照" },
  { id: "translate", label: "翻译" },
] as const;
type MarkdownMode = (typeof MARKDOWN_MODES)[number]["id"];

/** 预览里的内容块锚点：源码行号 + 在滚动内容里的纵向位置 */
interface PreviewAnchor {
  line: number;
  top: number;
}

/** 读预览里带 data-src-line 的顶层块。只认直接子节点，避免用户手写 HTML 里的同名属性搅局 */
function readPreviewAnchors(scroller: HTMLElement): PreviewAnchor[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const anchors: PreviewAnchor[] = [];
  for (const node of scroller.children) {
    if (!(node instanceof HTMLElement)) continue;
    const line = Number(node.dataset.srcLine);
    if (!Number.isFinite(line) || line <= 0) continue;
    anchors.push({ line, top: node.getBoundingClientRect().top - base });
  }
  return anchors;
}

/** 0..1 的进度，除数为 0 时按块首处理 */
function progress(value: number, from: number, to: number): number {
  if (to <= from) return 0;
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}

/** 编辑器顶行 -> 预览里对应块的位置 */
function scrollPreviewToEditor(
  scroller: HTMLElement,
  anchors: PreviewAnchor[],
  line: number,
): void {
  if (anchors.length === 0) return;
  let index = 0;
  while (index + 1 < anchors.length && anchors[index + 1].line <= line) index += 1;
  const anchor = anchors[index];
  const next = anchors[index + 1];
  // 块内按行数插值，长段落滚动时不会一直卡在块首
  const t = next ? progress(line, anchor.line, next.line) : 0;
  const top = next ? anchor.top + (next.top - anchor.top) * t : anchor.top;
  scroller.scrollTop = Math.max(0, top - 8);
}

/** 预览滚动位置 -> 编辑器对应行 */
function scrollEditorToPreview(
  editor: monaco.editor.IStandaloneCodeEditor,
  anchors: PreviewAnchor[],
  scrollTop: number,
): void {
  if (anchors.length === 0) return;
  let index = 0;
  while (index + 1 < anchors.length && anchors[index + 1].top <= scrollTop) index += 1;
  const anchor = anchors[index];
  const next = anchors[index + 1];
  const t = next ? progress(scrollTop, anchor.top, next.top) : 0;
  const line = Math.round(anchor.line + (next ? (next.line - anchor.line) * t : 0));
  editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(Math.max(1, line)) - 8));
}
const TABS_MENU_ITEM =
  "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted";

/** 标题栏上的次级动作（另存为 / 放弃变更），比主「保存」按钮弱一档 */
const HEADER_BUTTON =
  "shrink-0 rounded border border-line-strong px-2 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted";

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
  /** 标签记录的换行风格。CR 在 Monaco 里表示不了，但保存时要按它回写 */
  eol: Eol;
  tabSize: number;
  insertSpaces: boolean;
  /** 当前选区的长度（UTF-16 单位）；空选区是 0，状态栏据此才显示「已选」 */
  selectionLength: number;
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
    a.selectionLength === b.selectionLength
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
 * 可切换的编码列表由 `lib/fs.ts` 统一维护（后端支持的标签只能有一份），
 * 这里只负责把它渲染到状态栏菜单里。
 */

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

/**
 * 外观三项（行号 / 当前行高亮 / 行高）拼成 Monaco 选项，创建实例与热更新共用同一份口径。
 *
 * 行高直接给**倍数**：Monaco 的 `lineHeight` 小于 8 时按「字号 × 该值」解释（em 语义，
 * 见 monaco 的 BareFontInfo），于是字号一变行高自己跟着变，这里不用再乘一次字号。
 * `renderLineHighlight` 取 `all`（行内 + 行号栏一起亮）而不是 `line`，后者在高亮当前行时
 * 行号栏那片会显得断开。
 */
function appearanceOptions(
  lineNumbers: boolean,
  activeLine: boolean,
  lineHeight: EditorLineHeight,
): monaco.editor.IEditorOptions {
  return {
    lineNumbers: lineNumbers ? "on" : "off",
    renderLineHighlight: activeLine ? "all" : "none",
    lineHeight: Number(lineHeight),
  };
}

/**
 * Monaco find widget 贡献对象里我们用到的那两个成员。`editor.contrib.findController`
 * 是内部 API，版本锁在 package.json（见 monaco-editor），所以这里只声明用到的签名，
 * 取不到就由调用方退回 DOM 判断，不会因为上游改名直接崩掉。
 */
interface FindControllerLike {
  getState?: () => { isRevealed?: boolean } | null;
}

/** find widget 现在是不是开着。工具栏按钮要按它决定「打开还是收起」 */
function isFindWidgetVisible(editor: monaco.editor.IStandaloneCodeEditor): boolean {
  const controller = editor.getContribution("editor.contrib.findController") as
    | FindControllerLike
    | null;
  const state = controller?.getState?.();
  if (state && typeof state.isRevealed === "boolean") return state.isRevealed;
  // 兜底：widget 的 DOM 在展开时会带上 visible 类（见 monaco 的 findWidget）
  return editor.getDomNode()?.querySelector(".find-widget.visible") !== null;
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
  /** 新建一个未命名缓冲区。标签由 WorkspacePane 管，这里只管点按钮 */
  onNewUntitled: () => void;
  /** 改标签元数据：另存为改路径、外部变更改标记 */
  onPatchTab: (tab: Tab, patch: TabPatch) => void;
  /** 打开一个工作区内的文件（快捷键 Ctrl+O 走它，标签由 WorkspacePane 管） */
  onOpenPath: (path: string) => void;
  /** 在右栏文件树里定位到这个文件（标签右键「打开所在目录」） */
  onRevealInFiles: (path: string) => void;
  /** 翻译视图里的「设置」入口：打开设置面板的 AI 页 */
  onOpenSettings: () => void;
  /** 全屏展示状态。按钮挂在编辑器标题栏右端，也就是右边栏的右上角 */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 选中浮窗的两个动作：把位置引用送到终端 / 应用助手输入框 */
  onSendToTerminal: (location: EditorLocation) => void;
  onSendToAssistant: (location: EditorLocation) => void;
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
  /** 落盘要用，Map 的键是 tabKey 不是路径；未命名缓冲区是 null（没有可写的盘上位置） */
  path: string | null;
  model: monaco.editor.ITextModel;
  savedVersionId: number;
  /**
   * 最近一次保存 / 读盘时的正文。未命名缓冲区「放弃变更」要回到这份快照——
   * 它没有磁盘可重读，只有版本号是不够的。
   */
  savedText: string;
  /**
   * 打开时后端检测到的编码标签。保存时原样回传，按原编码写回——
   * 不带着它的话 GBK / Big5 / UTF-16 文件会被 UTF-8 覆盖而损坏。
   */
  encoding: string;
  /** 原文件的换行风格。保存时按它回写，保证 CR / CRLF 原样往返 */
  eol: Eol;
  /** 最近一次落盘时的换行风格；和 `eol` 不同也算「有未保存改动」（CR 改不了 model，只能记在这） */
  savedEol: Eol;
  /** 原文件开头有没有 BOM，保存时原样回传 */
  hasBom: boolean;
  /** 只读文件（或截断）：编辑器只读、保存禁用 */
  readOnly: boolean;
  /** 只加载了前 8MB：模型只读，且禁止保存 / 另存为 */
  truncated: boolean;
  /** 超过 8MB：关掉缩略图 / 折叠 / occurrences 这类高成本能力 */
  isLarge: boolean;
  /** 文件总字节数（截断时是完整大小），提示里显示给用户看 */
  size: number;
}

/** 一个差异标签的一对 model，销毁时必须一起走 */
interface CachedDiff {
  /** 落盘用不到，但搜索替换后要按路径找到它、把过期的基线丢掉 */
  path: string;
  original: monaco.editor.ITextModel;
  modified: monaco.editor.ITextModel;
}

/** 这个 model 相对最近一次保存有没有改动 */
function isCachedDirty(cached: CachedModel): boolean {
  return (
    cached.model.getAlternativeVersionId() !== cached.savedVersionId ||
    cached.eol !== cached.savedEol
  );
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
   * 处理「磁盘上的文件被外部改了」：干净标签同步内容，脏标签只打冲突标记，
   * 文件已经没了打删除标记。绝不覆盖未保存的编辑。
   */
  handleExternalChanges: (paths: string[]) => Promise<void>;
  /**
   * 重新从磁盘加载这些文件，扔掉编辑器里的旧内容。搜索替换之后用它：
   * 替换前已经保存过，这里的「覆盖」是预期行为。
   */
  reload: (paths: string[]) => Promise<void>;
  /** 打开文件并定位到指定位置 */
  revealAt: (target: RevealTarget) => void;
  /**
   * 格式化某个磁盘文件：文件树右键「格式化文档」走这里。
   * 文件已打开就直接格式化；还没加载好就记下来，等标签切过去、model 就绪后再做。
   */
  formatPath: (path: string) => void;
  /**
   * 丢掉落在这些路径下（含路径本身）的缓存 model。文件树里改了名或删了文件时用：
   * 名字变了要按新路径重读，文件没了就不该再留着——留着的话 Ctrl+S 会把删掉的
   * 文件又写回磁盘。
   */
  dropPaths: (paths: string[]) => void;
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
  | { kind: "pdf" }
  | { kind: "error"; message: string };

/**
 * 当图片预览的扩展名，和后端 `image_mime` 一一对应。`svg` 不在列里——
 * 它是文本，编辑器里当 xml 打开能改能高亮，挪去预览是倒退。
 * 只收 WebView 渲染引擎本身就能画的格式：`avif` 两边引擎都支持，直接当图片；
 * `tif` / `tiff` 都不认、`heic` 只有 macOS 侧能画，要支持得靠 Rust 侧解码转码。
 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
]);

function isImagePath(path: string | null): boolean {
  if (path === null) return false;
  const name = toDisplayPath(path).split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1));
}

/**
 * PDF 走 WebView 内置阅读器预览（见 `PdfPreview`），是二进制、不进 Monaco，
 * 打开即预览、没有「编辑 / 预览」开关——和图片同一套判据。
 */
const PDF_EXTENSIONS = new Set(["pdf"]);

function isPdfPath(path: string | null): boolean {
  if (path === null) return false;
  const name = toDisplayPath(path).split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && PDF_EXTENSIONS.has(name.slice(dot + 1));
}

/**
 * 编辑器内可预览的网页文件：html / htm 是网页文档，svg 是浏览器能直接渲染的矢量图。
 * 预览走 iframe + asset 协议读磁盘（相对路径的 css / js / 图片才加载得到），
 * 和右栏「浏览器」模块同一套。`svg` 编辑时仍按 xml 高亮（见 `languages.ts`），
 * 只是多给一个「编辑 / 预览」开关——它不是图片，别混进 `IMAGE_EXTENSIONS`。
 */
const HTML_PREVIEW_EXTENSIONS = new Set(["html", "htm", "svg"]);

function isHtmlPreviewPath(path: string | null): boolean {
  if (path === null) return false;
  const name = toDisplayPath(path).split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && HTML_PREVIEW_EXTENSIONS.has(name.slice(dot + 1));
}

const SVG_EXTENSIONS = new Set(["svg"]);

function isSvgPath(path: string | null): boolean {
  if (path === null) return false;
  const name = toDisplayPath(path).split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && SVG_EXTENSIONS.has(name.slice(dot + 1));
}

/**
 * 走 markdown 渲染预览的文件：markdown 系列（含按 `.mdc` 映射过来的规则文件），
 * 以及 `.mdx`——Monaco 里 mdx 是独立语言（markdown + jsx），所以判定得连语言一起看，
 * 只比 `"markdown"` 会把它漏掉。未命名缓冲区没有扩展名，永远不走预览。
 */
function isMarkdownPath(path: string | null): boolean {
  if (path === null) return false;
  const language = languageOf(path);
  return language === "markdown" || language === "mdx";
}

/**
 * 打开即预览的文件：markdown（含 mdx）与 svg。这两种多半是拿来看的，进来先给渲染结果，
 * 想改再点「回到编辑」。`html` / `htm` 不在此列——它们通常是要动手改的，保持打开即编辑。
 */
function previewsOnOpen(path: string | null): boolean {
  return isMarkdownPath(path) || isSvgPath(path);
}

/**
 * 后端按原样读回正文（可能混着 CRLF / CR），Monaco 只认 \n / \r\n。
 * 喂给模型、以及和模型内容比对之前，一律先统一成 LF。
 */
function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 字节数转人话，只用在截断提示里，不追求精确到小数点后几位 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
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

/** 路径末级文件名，提示文案里用；取不到就退回整个路径 */
function baseNameOf(path: string): string {
  return toDisplayPath(path).split("/").filter(Boolean).pop() ?? path;
}

/**
 * 编辑器缩进宽度：设了具体值就用它，auto 时按 model 自己探测到的值——
 * Prettier 的 tabWidth 要和编辑器里看到的一致，格式化结果才不会和手写风格打架。
 */
function indentWidthOf(model: monaco.editor.ITextModel, indent: EditorIndent): number {
  return indent === "auto" ? model.getOptions().tabSize : Number(indent);
}

/**
 * 把格式化结果落到 model 上。
 *
 * 走 pushEditOperations 而不是 setValue：前者是一次**正常编辑**，撤销栈原样保留，
 * 用户一步 Ctrl+Z 就能回到格式化之前。内容一致时直接返回 false，不产生无意义的
 * edit——否则每次保存时格式化都会把干净的文件标脏。
 */
function applyFormatToModel(model: monaco.editor.ITextModel, text: string): boolean {
  if (model.getValue() === text) return false;
  model.pushEditOperations(
    null,
    [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }],
    () => null,
  );
  model.pushStackElement();
  return true;
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
  onNewUntitled,
  onPatchTab,
  onOpenPath,
  onRevealInFiles,
  onOpenSettings,
  fullscreen,
  onToggleFullscreen,
  onSendToTerminal,
  onSendToAssistant,
  root,
  roots,
  visible,
  ref,
}: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, CachedModel>());
  /**
   * 每个标签的视图状态（滚动位置、光标、选区）。Monaco 只给「此刻挂着的那个 model」
   * 记住这些，而切标签、切到差异、进图片 / PDF 预览都会把 model 摘下来，不自己存就丢了。
   * 关标签时由 forgetKeys 清掉，不跟着会话泄漏。
   */
  const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  /** 编辑器此刻挂着的 model 属于哪个标签（tabKey）；null = 没挂文本 model（差异 / 图片 / 空态） */
  const shownKeyRef = useRef<string | null>(null);

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
  /** 最新的标签列表。事件处理（外部变更 / 另存为）里要按 key 反查标签，props 闭包靠不住 */
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  /**
   * 另存为把未命名缓冲区换成真实路径时，旧 key → 新 key 的映射。
   * 关闭流程里「保存并关闭」发生在父级标签列表刷新之前，收尾时得靠它找到新 key 的 model。
   */
  const rekeyedRef = useRef(new Map<string, { key: string; path: string }>());
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
   * 待确认的关闭：`queue` 是这批要关的标签里有未保存改动的那些，逐个问
   * 「保存 / 不保存 / 取消」；全部答完才真正执行 `request`。
   */
  const [closeRequest, setCloseRequest] = useState<{
    request: CloseRequest;
    queue: Tab[];
    index: number;
  } | null>(null);
  /**
   * 一次性的轻提示（保存失败、外部变更、放弃变更…），几秒后自动消失。
   * 不能塞进 status 的错误态：那会把整个编辑区盖成错误页，而这里要的是「边改边看」。
   */
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  /** 正处在预览模式的标签（存 tabKey）；不在集合里就是编辑模式 */
  const [previewPaths, setPreviewPaths] = useState<ReadonlySet<string>>(new Set());
  // togglePreview 是稳定回调（依赖为空），要用 ref 读预览集合的最新值来判断该进还是该退
  const previewPathsRef = useRef(previewPaths);
  previewPathsRef.current = previewPaths;
  /**
   * 已经定过「默认模式」的标签（存 tabKey）。每个标签只在第一次激活时按扩展名决定
   * 预览还是编辑，之后一律尊重用户的手动切换——切走再切回来不会被拽回预览。
   * 关标签时一并清掉（见 forgetKeys），重开还是默认预览。
   */
  const seededRef = useRef(new Set<string>());
  /**
   * 保存前语法问题的确认框内容；null = 不显示。确认结果通过下面那个 Promise 回传：
   * ConfirmDialog 是声明式的，保存流程却要「等到用户点完再决定存不存」。
   */
  const [syntaxPrompt, setSyntaxPrompt] = useState<{ name: string; detail: string } | null>(null);
  const syntaxResolveRef = useRef<((proceed: boolean) => void) | null>(null);
  /** 自动保存的语法提示去重：同一标签的同一个问题（message + 行 + 列）只提示一次 */
  const syntaxReportedRef = useRef(new Map<string, string>());
  /** 文件树右键「格式化文档」时，还没加载好的那个目标（tabKey）；就绪后再格式化 */
  const pendingFormatRef = useRef<string | null>(null);
  /**
   * 正处在左右分屏预览的标签（存 tabKey）。只对 markdown 有效：html / svg 的预览要读磁盘，
   * 不适合同屏边改边看。与 previewPaths 互斥（同一个标签不会既整屏预览又分屏）
   */
  const [splitPaths, setSplitPaths] = useState<ReadonlySet<string>>(new Set());
  /**
   * 正处在翻译视图的标签（存 tabKey）。和 previewPaths / splitPaths 互斥，
   * 翻译运行状态本身放在 translate-store 里，切标签不丢进度。
   */
  const [translationPaths, setTranslationPaths] = useState<ReadonlySet<string>>(new Set());
  const translationPathsRef = useRef(translationPaths);
  translationPathsRef.current = translationPaths;
  const [saving, setSaving] = useState(false);
  /** 选中文本浮窗的视口坐标；null = 不显示 */
  const [floatBar, setFloatBar] = useState<{ top: number; left: number } | null>(null);
  /** 标题栏「⋯」菜单的视口坐标；null = 不显示 */
  const [tabsMenu, setTabsMenu] = useState<{ x: number; y: number } | null>(null);
  /** 标签右键菜单：位置 + 作用的标签。外部变更的「重新加载 / 保留我的修改」都在这里 */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
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
  // 保存流程（persist）里的格式化 / 校验开关走 ref：让 persist 回调不因设置变化而重建
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

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
  // 自动换行同理：建 editor 的那一刻要拿到最新设置
  const wordWrapRef = useRef(settings.editorWordWrap);
  wordWrapRef.current = settings.editorWordWrap;
  const indentRef = useRef(settings.editorIndent);
  indentRef.current = settings.editorIndent;
  // 行号 / 当前行高亮 / 行高同理：editor 只建一次，建的那一刻要拿到最新设置
  const lineNumbersRef = useRef(settings.editorLineNumbers);
  lineNumbersRef.current = settings.editorLineNumbers;
  const activeLineRef = useRef(settings.editorHighlightActiveLine);
  activeLineRef.current = settings.editorHighlightActiveLine;
  const lineHeightRef = useRef(settings.editorLineHeight);
  lineHeightRef.current = settings.editorLineHeight;
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
    // 版本号之外还要看换行：CR 在 model 里表示不了，只改了缓存上的 eol
    const isDirty = Boolean(cached && isCachedDirty(cached));
    setDirtyPaths((prev) => {
      if (prev.has(key) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  /** 弹一条几秒后自动消失的提示 */
  const pushNotice = useCallback((text: string, tone: "info" | "error" = "info") => {
    setNotice({ text, tone });
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), []);

  /**
   * 把 model 上跟文件有关的能力开关同步到编辑器：大文件关掉缩略图 / 折叠 /
   * occurrences 高亮 / codeLens 这些高成本能力，只读 / 截断的文件锁住编辑。
   * 切标签、加载完成、外部重载、改设置之后都要重新按当前标签算一次。
   */
  const applyCapabilities = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const current = activeRef.current;
    const cached =
      current && current.kind === "file" ? modelsRef.current.get(tabKey(current)) ?? null : null;
    const isLarge = cached?.isLarge ?? false;
    editor.updateOptions({
      readOnly: cached?.readOnly ?? false,
      minimap: { enabled: minimapRef.current && !isLarge },
      folding: !isLarge,
      occurrencesHighlight: isLarge ? "off" : "singleFile",
      codeLens: !isLarge,
    });
  }, []);

  /**
   * 把一次读盘结果套到已有 model 上：正文、编码、EOL、BOM、只读 / 大文件元数据一起换。
   * 换完就是「和磁盘一致」，所以顺带把保存基准也推到现在。
   */
  const applyLoadedContent = useCallback((cached: CachedModel, content: FileContent) => {
    const text = toLf(content.text);
    cached.model.setValue(text);
    cached.savedVersionId = cached.model.getAlternativeVersionId();
    cached.savedText = text;
    cached.encoding = content.encoding;
    cached.eol = content.eol;
    cached.savedEol = content.eol;
    cached.hasBom = content.hasBom;
    cached.readOnly = content.readOnly || content.truncated;
    cached.truncated = content.truncated;
    cached.isLarge = content.isLarge;
    cached.size = content.size;
  }, []);

  /**
   * 刷新状态栏的「当前文件视图信息」。光标一动就调，切标签 / 改选项也复用。
   * 只在编辑器确实挂着当前文本 model 时才算数：差异、图片、加载中都没有 model，
   * 这时把信息清空，状态栏左侧整块收起来。读到的值和上一次一样就直接 bail，不白渲染。
   */
  const refreshViewInfo = useCallback(() => {
    const current = activeRef.current;
    const cached =
      current && current.kind === "file" ? modelsRef.current.get(tabKey(current)) ?? null : null;
    const model = cached?.model ?? null;
    const editor = editorRef.current;
    if (!editor || !model || editor.getModel() !== model) {
      setViewInfo((prev) => (prev === null ? prev : null));
      return;
    }
    const position = editor.getPosition();
    const modelOptions = model.getOptions();
    const selection = editor.getSelection();
    const next: ViewInfo = {
      line: position?.lineNumber ?? 1,
      column: position?.column ?? 1,
      language: model.getLanguageId(),
      // EOL 以标签记录为准：CR 在 Monaco 里表示不了（模型只能是 LF / CRLF），
      // 但保存时要按 CR 回写，状态栏也不能显示成 LF
      eol: cached?.eol ?? (model.getEOL() === "\r\n" ? "CRLF" : "LF"),
      tabSize: modelOptions.tabSize,
      insertSpaces: modelOptions.insertSpaces,
      // 选区长度按 UTF-16 单位算，和 Monaco 的行列口径一致
      selectionLength:
        selection && !selection.isEmpty() ? model.getValueLengthInRange(selection) : 0,
    };
    setViewInfo((prev) => (prev && sameViewInfo(prev, next) ? prev : next));
  }, []);

  /**
   * 把某个标签的 model 挂到编辑器上，并恢复它上次的视图状态（滚动位置 / 光标 / 选区）。
   * 与 saveCurrentViewState 配套：换 model 之前先存旧的，挂上之后恢复新的。
   */
  const attachModel = useCallback((key: string, model: monaco.editor.ITextModel) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setModel(model);
    shownKeyRef.current = key;
    const state = viewStatesRef.current.get(key);
    if (state) editor.restoreViewState(state);
  }, []);

  /** 存下当前挂着的这个 model 的视图状态。切标签 / 切差异 / 进图片预览之前都要调 */
  const saveCurrentViewState = useCallback(() => {
    const editor = editorRef.current;
    const key = shownKeyRef.current;
    if (!editor || key === null || !editor.getModel()) return;
    viewStatesRef.current.set(key, editor.saveViewState());
  }, []);

  /** 工具栏按钮与 editor.find：开着就收起，关着就打开（对齐 CodeLite 的切换语义） */
  const toggleFind = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !editor.getModel()) return;
    if (isFindWidgetVisible(editor)) {
      editor.trigger("codedock", "closeFindWidget", null);
      editor.focus();
      return;
    }
    editor.trigger("codedock", "actions.find", null);
  }, []);

  /** 按标签栏顺序切到下一个 / 上一个标签（含差异标签），到头绕回 */
  const stepTab = useCallback(
    (delta: number) => {
      const list = tabsRef.current;
      if (list.length === 0) return;
      const current = activeRef.current;
      const index = current ? list.findIndex((item) => sameTab(item, current)) : -1;
      // 找不到当前标签（列表刚被换掉）时从第一个开始往 delta 的方向走
      const base = index >= 0 ? index : 0;
      const next = list[(base + delta + list.length) % list.length];
      if (next && (!current || !sameTab(next, current))) onActivate(next);
    },
    [onActivate],
  );

  /**
   * 按条件丢掉缓存里的 model，普通文件和差异（成对的）一起处理。返回被丢掉的
   * tabKey，调用处拿它清理脏标记和预览集合。只碰 ref，不碰 state。
   */
  const disposeModels = useCallback(
    (match: (path: string | null, key: string) => boolean): string[] => {
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
    },
    [],
  );

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
    setSplitPaths(prune);
    setTranslationPaths(prune);
    // 翻译运行状态按标签隔离，关标签就清掉；译文缓存仍留在 localStorage
    for (const key of keys) clearTranslation(key);
    // 视图状态跟着标签走：标签关了、文件改了名就把对应那份丢掉，不让它一直留在 Map 里
    for (const key of keys) viewStatesRef.current.delete(key);
    if (shownKeyRef.current !== null && keys.includes(shownKeyRef.current)) {
      shownKeyRef.current = null;
    }
    // 顺手把「默认模式」的记账也清掉，重开这个文件时重新按扩展名决定
    for (const key of keys) seededRef.current.delete(key);
    // 语法提示的去重记账跟着标签走：关掉再开是同一个文件的新一次会话
    for (const key of keys) syntaxReportedRef.current.delete(key);
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
    // 只认普通文件标签——差异视图和预览不弹浮窗，这里再兜一层；未命名缓冲区没有路径可指代
    const current = activeRef.current;
    floatLocationRef.current =
      current && current.kind === "file" && current.path !== null
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
    (target: "terminal" | "assistant") => {
      const location = floatLocationRef.current;
      setFloatBar(null);
      if (!location) return;
      if (target === "terminal") onSendToTerminal(location);
      else onSendToAssistant(location);
    },
    [onSendToTerminal, onSendToAssistant],
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
   * 弹保存前的语法问题确认框，返回用户是否要继续保存。
   * ConfirmDialog 是声明式的，这里用一个 Promise 把按钮结果接回来：
   * 弹出时把 resolve 存进 ref，点「仍然保存 / 取消」时兑现。
   */
  const askSyntaxProceed = useCallback(
    (name: string, detail: string) =>
      new Promise<boolean>((resolve) => {
        // 上一个还挂着就先按「取消」结掉，免得它永远悬着
        syntaxResolveRef.current?.(false);
        syntaxResolveRef.current = resolve;
        setSyntaxPrompt({ name, detail });
      }),
    [],
  );

  /** 语法确认框的两个按钮：先收起框，再兑现保存流程等着的那个 Promise */
  const answerSyntax = useCallback((proceed: boolean) => {
    setSyntaxPrompt(null);
    const resolve = syntaxResolveRef.current;
    syntaxResolveRef.current = null;
    resolve?.(proceed);
  }, []);

  /**
   * 把有未保存改动的文件写回磁盘；传 only（tabKey）就只存那一个。
   * 自动保存走"存全部"——别的标签切走后也可能留着没保存的 model。
   * 差异标签的 model 在另一个 Map 里，这里永远碰不到。
   *
   * 未命名缓冲区不进这里（没有可写的路径，自动保存绝不能弹「另存为」）；
   * 只读 / 截断的文件直接跳过——截断时写回去会把文件毁成 8MB。
   *
   * 落盘前按设置做两件事：
   * 1. `editorFormatOnSave`：先用 Prettier 格式化一遍，失败只提示、绝不阻断保存。
   * 2. `editorCheckSyntaxOnSave`：用 Prettier 解析器校验；交互式保存（only 有值）弹
   *    「仍然保存 / 取消」，取消则这个文件不落盘；自动保存（silent）只提示不打断。
   */
  const persist = useCallback(
    async (only?: string, options?: { silent?: boolean }): Promise<boolean> => {
      const silent = options?.silent ?? false;
      const targets = [...modelsRef.current.entries()].filter(
        ([key, cached]) =>
          (!only || key === only) &&
          cached.path !== null &&
          !cached.readOnly &&
          !cached.truncated &&
          isCachedDirty(cached),
      );
      if (targets.length === 0) return true;

      const { editorFormatOnSave, editorCheckSyntaxOnSave } = settingsRef.current;
      setSaving(true);
      const saved = new Set<string>();
      let ok = true;
      try {
        for (const [key, cached] of targets) {
          const path = cached.path;
          if (path === null) continue;

          // 1) 保存时格式化：结果直接落到 model，随后的写盘与 savedVersionId 都以它为准
          if (editorFormatOnSave && canFormatTab(cached) && supportsFormatting(path)) {
            try {
              const outcome = await formatText(cached.model.getValue(), path, {
                tabWidth: indentWidthOf(cached.model, indentRef.current),
              });
              applyFormatToModel(cached.model, outcome.text);
            } catch (reason) {
              pushNotice(
                `「${baseNameOf(path)}」格式化失败，已按原内容保存：${errorText(reason)}`,
                "error",
              );
            }
          }

          // 2) 保存前语法校验。空内容、Prettier 不覆盖的类型都不拦
          if (editorCheckSyntaxOnSave && canFormatTab(cached)) {
            const text = cached.model.getValue();
            if (text.trim() !== "") {
              const issue = await validateText(text, path);
              if (!issue) {
                syntaxReportedRef.current.delete(key);
              } else {
                const name = baseNameOf(path);
                const where = formatIssueLocation(issue);
                if (silent) {
                  // 自动保存不打断输入：同一个问题只提示一次，否则会按节拍反复弹
                  const signature = issueSignature(issue);
                  if (syntaxReportedRef.current.get(key) !== signature) {
                    syntaxReportedRef.current.set(key, signature);
                    pushNotice(`「${name}」疑似语法错误${where}：${issue.message}`, "error");
                  }
                } else {
                  const proceed = await askSyntaxProceed(name, `${issue.message}${where}`);
                  if (!proceed) {
                    // 用户选「取消」：这个文件不落盘（关闭流程据此中止）
                    ok = false;
                    continue;
                  }
                }
              }
            }
          }

          await writeFile(
            rootFor(path),
            path,
            cached.model.getValue(),
            cached.encoding,
            cached.eol,
            cached.hasBom,
          );
          cached.savedVersionId = cached.model.getAlternativeVersionId();
          cached.savedText = cached.model.getValue();
          cached.savedEol = cached.eol;
          saved.add(key);
          // 保存就是用户选择用本地内容覆盖磁盘，冲突 / 已更新提醒随之解除
          const tab = tabsRef.current.find((item) => tabKey(item) === key);
          if (tab && tab.kind === "file" && tab.externalState !== "none") {
            onPatchTab(tab, { externalState: "none" });
          }
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
    },
    [askSyntaxProceed, onPatchTab, pushNotice],
  );

  /** 另存为：选路径 → 写盘 → 成功后才改标签。失败 / 取消时标签保持原样 */
  const saveAs = useCallback(
    async (key: string): Promise<boolean> => {
      const cached = modelsRef.current.get(key);
      if (!cached) return false;
      if (cached.truncated) {
        pushNotice("文件已截断，不能另存为", "error");
        return false;
      }
      const current = tabsRef.current.find((item) => tabKey(item) === key);
      const defaultName =
        cached.path ??
        (current ? `${tabName(current)}.txt` : "未命名.txt");
      const target = await pickSavePath(defaultName);
      if (target === null) return false;
      const targetRoot = ownerRoot(rootsRef.current, target);
      if (targetRoot === null) {
        pushNotice("另存为的目标不在当前工作区内", "error");
        return false;
      }
      // 目标已经开在另一个标签里就不写：写进去会得到两个同 key 的标签，缓存也会打架
      const opened = tabsRef.current.find(
        (item) =>
          item.kind === "file" &&
          item.path !== null &&
          tabKey(item) !== key &&
          pathKey(item.path) === pathKey(target),
      );
      if (opened) {
        pushNotice("目标文件已经在另一个标签中打开", "error");
        return false;
      }
      try {
        await writeFile(
          targetRoot,
          target,
          cached.model.getValue(),
          cached.encoding,
          cached.eol,
          cached.hasBom,
        );
      } catch (reason) {
        pushNotice(`保存失败：${reason}`, "error");
        return false;
      }

      // 写盘已成功，这里才开始改标签与缓存：顺序反过来会让失败留下一个不可用的路径。
      // model 的 URI 改不了，只把语法切到新扩展名对应的语言。
      monaco.editor.setModelLanguage(cached.model, languageOf(target));
      cached.path = target;
      cached.savedVersionId = cached.model.getAlternativeVersionId();
      cached.savedText = cached.model.getValue();
      cached.savedEol = cached.eol;
      cached.readOnly = false;
      cached.truncated = false;
      modelsRef.current.delete(key);
      const nextKey = fileTabKey(target);
      modelsRef.current.set(nextKey, cached);
      rekeyedRef.current.set(key, { key: nextKey, path: target });
      // 视图状态跟着换 key：另存为不该把滚动位置、光标丢掉
      const movedView = viewStatesRef.current.get(key);
      if (movedView !== undefined) {
        viewStatesRef.current.delete(key);
        viewStatesRef.current.set(nextKey, movedView);
      }
      if (shownKeyRef.current === key) shownKeyRef.current = nextKey;
      // 旧 key 的派生状态一起搬走（脏标记除外：刚保存完，新 key 是干净的）
      const prune = (prev: ReadonlySet<string>) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        next.add(nextKey);
        return next;
      };
      setPreviewPaths(prune);
      setSplitPaths(prune);
      setDirtyPaths((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      seededRef.current.delete(key);
      // 新路径不再按扩展名重新播种视图模式：另存为不该把用户正在编辑的窗口切成预览
      seededRef.current.add(nextKey);
      if (current && current.kind === "file") {
        onPatchTab(current, { path: target, externalState: "none" });
      }
      pushNotice(`已保存 ${target.replace(/\\/g, "/").split("/").pop() ?? target}`);
      return true;
    },
    [onPatchTab, pushNotice],
  );

  /** 保存某个标签：未命名缓冲区自动走另存为 */
  const saveTab = useCallback(
    async (key: string, options?: { silent?: boolean }): Promise<boolean> => {
      const cached = modelsRef.current.get(key);
      if (!cached) return false;
      if (cached.path === null) return saveAs(key);
      if (cached.truncated) {
        pushNotice("文件已截断，不能保存", "error");
        return false;
      }
      if (cached.readOnly) {
        pushNotice("文件是只读的，不能保存", "error");
        return false;
      }
      return persist(key, options);
    },
    [persist, pushNotice, saveAs],
  );

  /**
   * Ctrl+O / 工具栏入口：选一个文件打开。**只能开当前工作区里的文件**——
   * 工作区外的单文件打开（临时工作区）属于后面的事，这里如实拒绝而不是悄悄失败。
   */
  const openFromDisk = useCallback(async () => {
    const target = await pickOpenPath();
    if (target === null) return;
    if (ownerRoot(rootsRef.current, target) === null) {
      pushNotice("只能打开当前工作区内的文件", "error");
      return;
    }
    onOpenPath(target);
  }, [onOpenPath, pushNotice]);

  /** 标签右键「打开所在目录」：右栏切到「文件」模块并在树里定位这个文件 */
  const revealInFiles = useCallback(
    (path: string) => onRevealInFiles(path),
    [onRevealInFiles],
  );

  /** 标签右键「在文件管理器中显示」：交给系统文件管理器，并选中这个文件 */
  const revealInSystem = useCallback(
    (path: string) => {
      void revealItemInDir(path).catch(() => pushNotice("无法在文件管理器中显示", "error"));
    },
    [pushNotice],
  );

  /**
   * 状态栏点路径：复制绝对路径。走 Tauri 的 clipboard 插件而不是 `navigator.clipboard`，
   * 理由同 ExplorerPane（WebView2 会弹系统授权框）。
   */
  const copyActivePath = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.kind !== "file" || current.path === null) return;
    void writeText(current.path).then(
      () => pushNotice(`已复制路径 ${current.path}`),
      () => pushNotice("复制路径失败", "error"),
    );
  }, [pushNotice]);

  /**
   * 放弃某个标签的未保存改动：已落盘的文件从磁盘重读，未命名缓冲区回到最近一次
   * 保存快照。没有未保存改动时什么都不做。
   */
  const discardChanges = useCallback(
    async (key: string) => {
      const cached = modelsRef.current.get(key);
      if (!cached || !isCachedDirty(cached)) return;
      const current = tabsRef.current.find((item) => tabKey(item) === key);

      if (cached.path === null) {
        // 未命名缓冲区没有磁盘可读，只能回到「最后一次保存」的那份正文
        cached.model.setValue(cached.savedText);
        cached.savedVersionId = cached.model.getAlternativeVersionId();
        cached.eol = cached.savedEol;
        pushNotice("已放弃未保存的修改");
      } else {
        try {
          const content = await readFile(rootFor(cached.path), cached.path, cached.encoding);
          if (content.isBinary || content.tooLarge) {
            pushNotice("文件无法作为文本重新读取，未放弃改动", "error");
            return;
          }
          applyLoadedContent(cached, content);
          applyCapabilities();
          pushNotice("已放弃未保存的修改");
        } catch (reason) {
          pushNotice(`放弃改动失败：${reason}`, "error");
          return;
        }
      }

      if (current && current.kind === "file" && current.externalState !== "none") {
        onPatchTab(current, { externalState: "none" });
      }
      setPreviewNonce((count) => count + 1);
      syncDirty();
      refreshViewInfo();
    },
    [
      applyCapabilities,
      applyLoadedContent,
      onPatchTab,
      pushNotice,
      refreshViewInfo,
      rootFor,
      syncDirty,
    ],
  );

  // 快捷键和保存按钮只管当前文件；差异标签是只读的，按了没反应
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") return;
    void saveTab(tabKey(current));
  };

  /**
   * 格式化一个标签的正文（工具栏 / 快捷键 / 文件树右键共用）。
   *
   * - Prettier 覆盖的类型走 Prettier；其余类型或解析失败时退回 Monaco 的
   *   `editor.action.reindentlines`，不做「静默什么都不干」。
   * - 结果走 pushEditOperations 落到 model（见 applyFormatToModel），撤销栈保留；
   *   光标按 Prettier 的映射结果还原，内容没变时不产生 edit、也不会把干净文件标脏。
   */
  const formatTab = useCallback(
    async (key: string): Promise<void> => {
      const cached = modelsRef.current.get(key);
      const editor = editorRef.current;
      if (!cached || !editor) return;
      if (!canFormatTab(cached)) {
        pushNotice(
          cached.truncated
            ? "文件已截断，不能格式化"
            : cached.isLarge
              ? "大文件已跳过格式化"
              : "只读文件不能格式化",
          "error",
        );
        return;
      }

      // 只有正显示在编辑器里才谈得上「保持光标」与「退回缩进重排」
      const live = editor.getModel() === cached.model ? editor : null;
      const name = cached.path !== null ? baseNameOf(cached.path) : "未命名缓冲区";

      if (cached.path !== null && supportsFormatting(cached.path)) {
        const cursorOffset = live
          ? cached.model.getOffsetAt(live.getPosition() ?? { lineNumber: 1, column: 1 })
          : undefined;
        try {
          const outcome = await formatText(cached.model.getValue(), cached.path, {
            tabWidth: indentWidthOf(cached.model, indentRef.current),
            cursorOffset,
          });
          const changed = applyFormatToModel(cached.model, outcome.text);
          if (live && changed && outcome.cursorOffset !== null) {
            live.setPosition(cached.model.getPositionAt(outcome.cursorOffset));
          }
          pushNotice(changed ? `已格式化 ${name}` : "内容已符合格式化规范");
          syncDirty();
          refreshViewInfo();
          return;
        } catch (reason) {
          pushNotice(`格式化失败：${errorText(reason)}，已改用缩进重排`, "error");
        }
      }

      if (live) {
        // 未命名缓冲区没有扩展名，判断不了语言；退回缩进重排对纯文本也没有意义，
        // 如实说明而不是假装做过了
        if (cached.path === null) {
          pushNotice("未命名缓冲区还没有扩展名，暂不支持格式化", "info");
          return;
        }
        // 兜底：Monaco 的按语法重排缩进。至少把缩进对齐，不静默失败
        live.trigger("codedock", "editor.action.reindentlines", null);
        syncDirty();
        return;
      }
      pushNotice("当前文件类型暂不支持格式化", "info");
    },
    [pushNotice, refreshViewInfo, syncDirty],
  );

  /** 工具栏按钮与 Shift+Alt+F：格式化当前标签 */
  const formatActive = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") {
      pushNotice("当前没有可格式化的文件", "error");
      return;
    }
    void formatTab(tabKey(current));
  }, [formatTab, pushNotice]);
  // Monaco 的 action 回调建在只跑一次的 effect 里，拿不到最新闭包，用 ref 兜住
  const formatActiveRef = useRef(formatActive);
  formatActiveRef.current = formatActive;

  /**
   * 文件树右键「格式化文档」：文件已打开就直接格式化；还没加载好就记下来，
   * 等标签切过去、model 就绪后再做（见 flushPendingFormat 与切标签 effect）。
   */
  const formatPath = useCallback(
    (path: string) => {
      const key = fileTabKey(path);
      const cached = modelsRef.current.get(key);
      if (cached && editorRef.current?.getModel() === cached.model) {
        void formatTab(key);
        return;
      }
      pendingFormatRef.current = key;
    },
    [formatTab],
  );

  /** 待格式化的标签就绪了，补做一次；没记着就什么都不做 */
  const flushPendingFormat = useCallback(() => {
    const key = pendingFormatRef.current;
    if (key === null) return;
    pendingFormatRef.current = null;
    void formatTab(key);
  }, [formatTab]);

  /** 这个待格式化请求作废（标签换走了、或文件根本没法当文本加载） */
  const dropPendingFormat = useCallback((key: string | null) => {
    if (key === null || pendingFormatRef.current === key) pendingFormatRef.current = null;
  }, []);

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
      if (tab.kind !== "file" || tab.path === null) return;
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
        applyLoadedContent(cached, content);
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
        const model = existing ?? monaco.editor.createModel(toLf(content.text), language, uri);
        if (!existing) applyIndentToModel(model, indentRef.current);
        modelsRef.current.set(key, {
          path,
          model,
          // 版本号在重排之前取：json5/jsonc 自动重排后会算成未保存改动（和打开时一致）
          savedVersionId: model.getAlternativeVersionId(),
          savedText: model.getValue(),
          encoding: content.encoding || label,
          eol: content.eol,
          savedEol: content.eol,
          hasBom: content.hasBom,
          readOnly: content.readOnly || content.truncated,
          truncated: content.truncated,
          isLarge: content.isLarge,
          size: content.size,
        });
        if (!existing && (language === "json5" || language === "jsonc")) {
          reindentModelOnOpen(model);
        }
        if (editor) attachModel(key, model);
        applyCapabilities();
      }
      setStatus({ kind: "ready" });
      syncDirty();
      refreshViewInfo();
    },
    [applyCapabilities, applyLoadedContent, refreshViewInfo, rootFor, syncDirty, attachModel],
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
      // 批量落盘（替换 / 改名 / 关闭全部前）不打断用户：语法问题只提示，照常保存
      saveAll: () => persistRef.current(undefined, { silent: true }),

      handleExternalChanges: async (paths) => {
        const wanted = new Map(paths.map((path) => [pathKey(path), path]));

        for (const [key, cached] of [...modelsRef.current]) {
          if (cached.path === null) continue;
          const diskPath = wanted.get(pathKey(cached.path));
          if (diskPath === undefined) continue;
          // 标签已经关了（或这条缓存已经没有对应标签）就没什么可提醒的
          const tab = tabsRef.current.find((item) => tabKey(item) === key);
          if (!tab || tab.kind !== "file") continue;

          // 先看文件还在不在。删除是唯一没法靠「读回内容比较」判断的状态
          let exists = true;
          try {
            const flags = await pathsExist([diskPath]);
            exists = flags[0] !== false;
          } catch {
            // 探不到就当它还在，下面读文件时照常报错
          }
          if (!exists) {
            onPatchTab(tab, { externalState: "deleted" });
            pushNotice(`「${tabName(tab)}」已在磁盘上被删除`, "error");
            continue;
          }

          let content: FileContent;
          try {
            content = await readFile(rootFor(diskPath), diskPath, cached.encoding);
          } catch {
            // 读不回来（权限、被占用…）保持原样，界面上还有旧内容可用
            continue;
          }
          if (content.isBinary || content.tooLarge) continue;

          const diskText = toLf(content.text);
          // 内容没变 = 多半是编辑器自己刚保存触发的写入回声。只同步元数据，
          // 不重设 model（重设会清掉撤销栈、把光标弹回开头）
          if (diskText === cached.model.getValue()) {
            cached.eol = content.eol;
            cached.savedEol = content.eol;
            cached.hasBom = content.hasBom;
            cached.readOnly = content.readOnly || content.truncated;
            cached.truncated = content.truncated;
            cached.isLarge = content.isLarge;
            cached.size = content.size;
            if (activeRef.current !== null && tabKey(activeRef.current) === key) {
              applyCapabilities();
              refreshViewInfo();
            }
            continue;
          }

          // 有未保存改动：绝不覆盖编辑器内容，只打冲突标记等用户决定
          if (isCachedDirty(cached)) {
            onPatchTab(tab, { externalState: "conflict" });
            pushNotice(
              `「${tabName(tab)}」在磁盘上被外部修改，你也有未保存的修改`,
              "error",
            );
            continue;
          }

          // 干净标签：直接同步成磁盘内容。前台标签不打扰用户，后台标签留个「已更新」提醒
          applyLoadedContent(cached, content);
          const isActive = activeRef.current !== null && tabKey(activeRef.current) === key;
          onPatchTab(tab, { externalState: isActive ? "none" : "updated" });
          if (!isActive) pushNotice(`「${tabName(tab)}」已在磁盘上更新`);
          setPreviewNonce((count) => count + 1);
          if (isActive) {
            applyCapabilities();
            syncDirty();
            refreshViewInfo();
          }
        }

        // 差异视图的基线是旧的，留着会显示出过期的对比，整对丢掉、下次切过去重拉
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
      },

      reload: async (paths) => {
        const wanted = new Set(paths.map(pathKey));
        const done: string[] = [];
        let touched = false;

        for (const [key, cached] of modelsRef.current) {
          if (cached.path === null || !wanted.has(pathKey(cached.path))) continue;
          // 编辑器里还留着没保存的改动就不覆盖，用户的编辑优先
          if (isCachedDirty(cached)) continue;
          try {
            const content = await readFile(rootFor(cached.path), cached.path);
            if (content.isBinary || content.tooLarge) continue;
            // 读文件这一下用户可能又敲进了改动，再查一次，编辑优先
            if (isCachedDirty(cached)) continue;
            // 磁盘上和 model 里一模一样就别 setValue——这一般是编辑器自己刚保存
            // 触发的回声，重设一遍会白白清掉撤销栈、还会把光标弹回开头
            if (cached.model.getValue() === toLf(content.text)) continue;
            // 外部可能用别的编码 / 换行重写过这个文件，跟着更新，保存时按新元数据回写
            applyLoadedContent(cached, content);
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
          // 替换之后磁盘上就是编辑器里的内容，冲突 / 已更新提醒不再成立
          for (const key of done) {
            const tab = tabsRef.current.find((item) => tabKey(item) === key);
            if (tab?.kind === "file" && tab.externalState !== "none") {
              onPatchTab(tab, { externalState: "none" });
            }
          }
        }
        if (touched) {
          setPreviewNonce((count) => count + 1);
          applyCapabilities();
          refreshViewInfo();
        }

        // 图片不进 modelsRef（缓存里不可能有它），正在看的那张单独重读一遍
        const current = activeRef.current;
        const currentPath = current?.kind === "file" ? current.path : null;
        if (
          currentPath !== null &&
          isImagePath(currentPath) &&
          paths.some((item) => pathKey(item) === pathKey(currentPath))
        ) {
          try {
            const content = await readImage(rootFor(currentPath), currentPath);
            // 等这一下的时候用户可能已经切走了，别把结果盖到别的标签上
            const now = activeRef.current;
            if (now && now.kind === "file" && now.path === currentPath) {
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

      formatPath,

      dropPaths: (paths) => {
        forgetKeys(
          disposeModels(
            (path) => path !== null && paths.some((item) => isPathInside(path, item)),
          ),
        );
      },

      // 关掉当前标签。焦点在右侧面板里时由 ToolPane 调它——差异标签就开在这根标签栏上
      closeActiveTab: () => {
        const current = activeRef.current;
        if (current) closeTabRef.current(current);
      },
    }),
    [
      applyCapabilities,
      applyLoadedContent,
      disposeModels,
      forgetKeys,
      formatPath,
      onPatchTab,
      pushNotice,
      refreshViewInfo,
      rootFor,
      syncDirty,
    ],
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
      // 行号 / 当前行高亮 / 行高与主编辑器同一口径（改设置时两边一起热更新）
      ...appearanceOptions(
        lineNumbersRef.current,
        activeLineRef.current,
        lineHeightRef.current,
      ),
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
      wordWrap: wordWrapRef.current ? "on" : "off",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      tabSize: 2,
      padding: { top: 8 },
      // 行号 / 当前行高亮 / 行高（见 appearanceOptions）
      ...appearanceOptions(
        lineNumbersRef.current,
        activeLineRef.current,
        lineHeightRef.current,
      ),
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
    // 选区被清空、或内容滚动了，浮窗的位置立刻失真，直接收起。
    // 顺带刷新状态栏：选区长度就在这个事件里变，不刷的话「已选 N」不会更新
    const selectionSub = editor.onDidChangeCursorSelection((event) => {
      if (event.selection.isEmpty()) setFloatBar(null);
      refreshViewInfo();
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
      shownKeyRef.current = null;
      viewStatesRef.current.clear();
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

  // 保存与格式化键可配置：单独挂一个 effect，改键位时重建 action。
  // 不能塞进上面那个建实例的 effect——它的依赖里没有 settings，改键位永远不会生效。
  // 声明在建实例之后，首次挂载跑起来时 editorRef 已经是新的编辑器了。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const saveKey = toMonacoKeybinding(settings.shortcuts["editor.save"]);
    const saveAction = editor.addAction({
      id: "codedock.save",
      label: "保存文件",
      // 键位翻不出来就不注册键位，保存按钮和菜单里的该项仍可用
      keybindings: saveKey === null ? [] : [saveKey],
      run: () => {
        void saveRef.current();
      },
    });

    // 格式化：键位默认 Shift+Alt+F（VS Code 惯例）。Monaco 自带的「格式化文档」同键，
    // 但只在注册过格式化 provider 的语言（json5 / jsonc）上激活，本应用注册的动态键位
    // 排在它之后、_findCommand 从数组尾部找起，因此这里优先生效。
    // 只读时 Monaco 不接管（截断 / 只读不该改内容），工具栏按钮另有针对性禁用。
    const formatKey = toMonacoKeybinding(settings.shortcuts["editor.format"]);
    const formatAction = editor.addAction({
      id: "codedock.format",
      label: "格式化文档",
      keybindings: formatKey === null ? [] : [formatKey],
      precondition: "!editorReadonly",
      run: () => formatActiveRef.current(),
    });

    return () => {
      saveAction.dispose();
      formatAction.dispose();
    };
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

  // 缩略图是 editor 级选项，热更新即可（差异编辑器不显示缩略图，无需跟随）。
  // 大文件会强制关掉缩略图，所以这里统一交给 applyCapabilities 按当前标签重算
  useEffect(() => {
    applyCapabilities();
  }, [settings.editorMinimap, applyCapabilities]);

  // 自动换行也是 editor 级选项；改设置立刻生效，不用重开文件
  useEffect(() => {
    editorRef.current?.updateOptions({
      wordWrap: settings.editorWordWrap ? "on" : "off",
    });
  }, [settings.editorWordWrap]);

  // 行号 / 当前行高亮 / 行高：主编辑器与差异编辑器一起热更新。
  // 行高给的是倍数（见 appearanceOptions），字号变化时 Monaco 自己会重算，这里不用跟着动
  useEffect(() => {
    const options = appearanceOptions(
      settings.editorLineNumbers,
      settings.editorHighlightActiveLine,
      settings.editorLineHeight,
    );
    editorRef.current?.updateOptions(options);
    diffRef.current?.updateOptions(options);
  }, [
    settings.editorLineNumbers,
    settings.editorHighlightActiveLine,
    settings.editorLineHeight,
  ]);

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
          () => void persistRef.current(undefined, { silent: true }),
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
      const sub = editor.onDidBlurEditorText(() => void persistRef.current(undefined, { silent: true }));
      return () => sub.dispose();
    }

    // onWindowChange：整个窗口失焦时存一次
    const onBlur = () => void persistRef.current(undefined, { silent: true });
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [settings.editorAutoSave, settings.editorAutoSaveDelay]);

  // 切标签：文件走一套（换成文件 model），差异走另一套（跟 git 要两侧内容）
  useEffect(() => {
    activeRef.current = active;
    // 换了标签，上一次的浮窗不再对应任何文本
    setFloatBar(null);
    // 「磁盘上已更新」只是后台提醒：切到这个标签就算看到了，清掉。
    // 冲突 / 已删除不能自动清，必须等用户明确处理。
    if (active?.kind === "file" && active.externalState === "updated") {
      onPatchTab(active, { externalState: "none" });
    }
    const editor = editorRef.current;
    if (!editor) return;

    // 先把当前标签的视图状态存下来再换 model：下面几条分支（差异 / 图片 / PDF / 空态）
    // 都会把 model 摘下来，而 Monaco 只给「此刻挂着的那个 model」记住滚动与选区
    saveCurrentViewState();
    shownKeyRef.current = null;

    if (!active) {
      editor.setModel(null);
      diffRef.current?.setModel(null);
      setStatus({ kind: "idle" });
      setDiffStatus({ kind: "idle" });
      dropPendingFormat(null);
      return;
    }

    if (active.kind === "diff") {
      // 文件编辑器摘掉 model，免得它在后面白白占着
      editor.setModel(null);
      setStatus({ kind: "idle" });
      dropPendingFormat(null);
      void showDiff(active);
      return;
    }

    diffRef.current?.setModel(null);
    setDiffStatus({ kind: "idle" });

    const key = tabKey(active);

    // 图片整张读回来当 data URL 渲染，不进 Monaco——二进制没有 model 可言。
    // 放在缓存查找之前：图片永远不进 modelsRef，缓存里不可能有它
    if (active.path !== null && isImagePath(active.path)) {
      const imagePath = active.path;
      let cancelled = false;
      setStatus({ kind: "loading" });
      editor.setModel(null);
      dropPendingFormat(key);

      void readImage(rootFor(imagePath), imagePath)
        .then((content) => {
          if (cancelled || !activeRef.current || tabKey(activeRef.current) !== key) return;
          if (content.tooLarge) {
            setStatus({ kind: "tooLarge" });
            return;
          }
          addRecent(imagePath);
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

    // PDF 交给 WebView 内置阅读器渲染（见 PdfPreview），也不进 Monaco、没有 model。
    // 和图片一样：打开即预览，判据只看扩展名，不必先把文件读进来
    if (isPdfPath(active.path)) {
      editor.setModel(null);
      setStatus({ kind: "pdf" });
      dropPendingFormat(key);
      return;
    }

    const cached = modelsRef.current.get(key);
    if (cached) {
      attachModel(key, cached.model);
      setStatus({ kind: "ready" });
      syncDirty();
      applyCapabilities();
      // 文件树右键的「打开并格式化」：模型已经挂上，补做那一次格式化
      flushPendingFormat();
      return;
    }

    const path = active.path;
    if (path === null) {
      // 未命名缓冲区：没有磁盘内容可读，直接给一个空 model。序号由 WorkspacePane 发，
      // 这里只按它建 URI；重开同一个标签会先命中上面的缓存，不会重复建
      const uri = monaco.Uri.parse(`inmemory://codedock/untitled-${active.untitledId ?? "new"}`);
      const model = monaco.editor.createModel("", "plaintext", uri);
      applyIndentToModel(model, indentRef.current);
      modelsRef.current.set(key, {
        path: null,
        model,
        savedVersionId: model.getAlternativeVersionId(),
        savedText: "",
        encoding: "utf-8",
        eol: "LF",
        savedEol: "LF",
        hasBom: false,
        readOnly: false,
        truncated: false,
        isLarge: false,
        size: 0,
      });
      attachModel(key, model);
      setStatus({ kind: "ready" });
      syncDirty();
      applyCapabilities();
      flushPendingFormat();
      return;
    }

    let cancelled = false;
    setStatus({ kind: "loading" });
    editor.setModel(null);

    void readFile(rootFor(path), path)
      .then((content) => {
        if (cancelled || !activeRef.current || tabKey(activeRef.current) !== key) return;
        if (content.tooLarge) {
          setStatus({ kind: "tooLarge" });
          dropPendingFormat(key);
          return;
        }
        if (content.isBinary) {
          setStatus({ kind: "binary" });
          dropPendingFormat(key);
          return;
        }
        const uri = monaco.Uri.file(path);
        const language = languageOf(path);
        const existing = monaco.editor.getModel(uri);
        // 后端按原样读回，可能带着 CRLF / CR；Monaco 只认 LF / CRLF，先统一成 LF，
        // 原换行风格记在 cached.eol 里，保存时由后端按它还原
        const model = existing ?? monaco.editor.createModel(toLf(content.text), language, uri);
        if (!existing) applyIndentToModel(model, indentRef.current);
        // savedVersionId 取「重排之前」的版本号：json5/jsonc 打开时会自动重排，
        // 于是重排完立刻算未保存改动（用户 Ctrl+Z 撤销回原缩进时，版本号回到这里又会变干净）
        modelsRef.current.set(key, {
          path,
          model,
          savedVersionId: model.getAlternativeVersionId(),
          savedText: model.getValue(),
          encoding: content.encoding,
          eol: content.eol,
          savedEol: content.eol,
          hasBom: content.hasBom,
          readOnly: content.readOnly || content.truncated,
          truncated: content.truncated,
          isLarge: content.isLarge,
          size: content.size,
        });
        // 只对首次创建的 json5 / jsonc 自动重排；缓存 model 与差异 model 都到不了这里
        if (!existing && (language === "json5" || language === "jsonc")) {
          reindentModelOnOpen(model);
        }
        // 读盘成功才算「打开成功」：路径不存在 / 二进制 / 超限的文件不进最近列表
        addRecent(path);
        attachModel(key, model);
        setStatus({ kind: "ready" });
        syncDirty();
        applyCapabilities();
        flushPendingFormat();
      })
      .catch((reason) => {
        if (cancelled || !activeRef.current || tabKey(activeRef.current) !== key) return;
        setStatus({ kind: "error", message: String(reason) });
        dropPendingFormat(key);
      });

    return () => {
      cancelled = true;
    };
  }, [
    active,
    applyCapabilities,
    attachModel,
    saveCurrentViewState,
    dropPendingFormat,
    flushPendingFormat,
    onPatchTab,
    syncDirty,
    showDiff,
  ]);

  /**
   * markdown / svg 打开即预览：标签第一次被激活时按扩展名给它定默认模式。
   *
   * 必须排在下面「搜索定位」的 effect 之前：搜索点进来时 reveal 会把人拉回编辑，
   * 先播种再撤销，最终停在编辑模式；反过来播种会把撤销覆盖掉。
   * svg 的预览虽要读磁盘，但刚打开的文件没有未保存改动，直接进即可。
   */
  useEffect(() => {
    if (!active || active.kind !== "file") return;
    const key = tabKey(active);
    if (seededRef.current.has(key)) return;
    seededRef.current.add(key);
    if (!previewsOnOpen(active.path)) return;
    setPreviewPaths((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, [active]);

  // 搜索结果的定位：等标签切过去、model 挂上之后再选中并滚过去
  useEffect(() => {
    if (!reveal || !active || active.kind !== "file" || active.path === null) return;
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
    // 翻译视图同样把编辑器藏起来了，定位前也退出去
    setTranslationPaths((prev) => {
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
    const enter = () => {
      setPreviewPaths((prev) => new Set(prev).add(key));
      // 分屏与整屏预览互斥：进整屏就把该标签从分屏里摘掉，否则两块预览会同时挂着
      setSplitPaths((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      // 翻译视图也是整块替换内容，和预览互斥
      setTranslationPaths((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    };
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
   * 切换 markdown 的查看方式：预览 / 编辑 / 对照 / 翻译。
   * 同一份内容只在一处显示，所以每次进入一种模式都把其余集合摘掉。
   * 翻译视图的内容变化由内容签名驱动，切回编辑后译文仍留在 store 里。
   */
  const setMarkdownMode = useCallback((mode: MarkdownMode) => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") return;
    const key = tabKey(current);
    const without = (prev: ReadonlySet<string>) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    };
    const add = (prev: ReadonlySet<string>) =>
      prev.has(key) ? prev : new Set(prev).add(key);
    if (mode === "edit") {
      setPreviewPaths(without);
      setSplitPaths(without);
      setTranslationPaths(without);
      return;
    }
    if (mode === "preview") {
      setPreviewPaths(add);
      setSplitPaths(without);
      setTranslationPaths(without);
      return;
    }
    if (mode === "split") {
      setSplitPaths(add);
      setPreviewPaths(without);
      setTranslationPaths(without);
      return;
    }
    setTranslationPaths(add);
    setPreviewPaths(without);
    setSplitPaths(without);
  }, []);

  /** 纯文本等非 markdown 文档的翻译入口：再点一次回到编辑 */
  const toggleTranslation = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") return;
    const key = tabKey(current);
    if (translationPathsRef.current.has(key)) {
      setTranslationPaths((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setTranslationPaths((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setPreviewPaths((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setSplitPaths((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  /**
   * 这批关闭动作里哪些标签有未保存的改动。差异标签永远干净，未命名缓冲区也要算。
   * 一个都没有就直接关；有的话逐个弹「保存 / 不保存 / 取消」。
   */
  const dirtyTargets = useCallback(
    (request: CloseRequest): Tab[] => {
      const targets =
        request.kind === "one"
          ? [request.tab]
          : tabs.filter(
              (tab) => request.kind === "all" || !active || !sameTab(tab, active),
            );
      return targets.filter((tab) => dirtyPaths.has(tabKey(tab)));
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
        // 这次关闭可能刚做过「另存为」：标签已经换了路径（甚至父级的列表还没刷新），
        // 用记录下来的新 key / 新路径收尾，model 才不会漏在缓存里
        const moved = rekeyedRef.current.get(key);
        forgetKeys(disposeModels((_, current) => current === (moved?.key ?? key)));
        onClose(moved ? patchTab(request.tab, { path: moved.path }) : request.tab);
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
      const queue = dirtyTargets(request);
      if (queue.length === 0) {
        performClose(request);
        return;
      }
      setCloseRequest({ request, queue, index: 0 });
    },
    [active, dirtyTargets, performClose],
  );

  /** 当前正在问的那个待关闭标签；null 表示没有待确认的关闭 */
  const closeTabNow = closeRequest ? closeRequest.queue[closeRequest.index] ?? null : null;

  /** 当前这个答完了，接着问下一个；全部答完才真正关 */
  const answerClose = useCallback(
    (action: "save" | "discard") => {
      const state = closeRequest;
      if (!state) return;
      const tab = state.queue[state.index];
      const finish = (ok: boolean) => {
        if (!ok) {
          // 保存失败 / 另存为取消：中止整次关闭，标签原样留着
          setCloseRequest(null);
          pushNotice("保存失败，已取消关闭", "error");
          return;
        }
        const next = state.index + 1;
        if (next >= state.queue.length) {
          setCloseRequest(null);
          performClose(state.request);
          return;
        }
        setCloseRequest({ ...state, index: next });
      };
      if (action === "discard" || !tab) {
        finish(true);
        return;
      }
      void saveTab(tabKey(tab), { silent: true }).then(finish);
    },
    [closeRequest, performClose, pushNotice, saveTab],
  );

  const closeTab = useCallback(
    (tab: Tab) => requestClose({ kind: "one", tab }),
    [requestClose],
  );
  closeTabRef.current = closeTab;

  /**
   * 编辑器区内的命令分发：焦点在这一区（含标签栏、状态栏）时按下配置里的键就跑对应命令，
   * 键位全部来自 `settings.shortcuts`（见 lib/shortcuts.ts 的命令表）。
   *
   * 挂在最外层 section 的**捕获阶段**：焦点落在 Monaco 里、或落在标签栏按钮上都收得到，
   * 而且抢在 Monaco 自己的按键处理之前把事件吃掉。几条刻意留白的边界：
   * - 终端在另一个面板里，事件到不了这里，Ctrl+C/V/W 的 shell 语义不受影响；
   * - 终端专属的键（Ctrl+B 这类 readline 键）在窗口级分发那边被 `isTypingTarget` 挡掉；
   * - Monaco 自带的 Ctrl+H、撤销、多光标照旧由 Monaco 处理，只有本应用注册过的命令键
   *   才被吃掉（`editor.find` 打开的就是 Monaco 同一个 find widget）。
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

    // Ctrl+PageDown / Ctrl+PageUp 是切标签的同义别名（对齐 VS Code / CodeLite）。
    // 刻意不进命令表：单按 PageUp / PageDown 要留给翻页，录成键位后会和浏览器语义打架
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "PageDown" || event.key === "PageUp")
    ) {
      event.preventDefault();
      event.stopPropagation();
      stepTab(event.key === "PageDown" ? 1 : -1);
      return;
    }

    // 顺序即匹配顺序；resolveShortcuts 保证了不会有两条命令占同一个键
    const commands: [string, () => void][] = [
      ["closeTab", () => current && closeTabRef.current(current)],
      ["editor.save", () => saveRef.current()],
      [
        "editor.saveAs",
        () => {
          if (current?.kind === "file") void saveAs(tabKey(current));
        },
      ],
      ["editor.newFile", onNewUntitled],
      ["editor.openFile", () => void openFromDisk()],
      ["editor.find", toggleFind],
      ["editor.format", () => formatActiveRef.current()],
      ["editor.togglePreview", togglePreview],
      ["editor.nextTab", () => stepTab(1)],
      ["editor.prevTab", () => stepTab(-1)],
    ];
    for (const [id, run] of commands) {
      if (!matchesShortcut(event, settings.shortcuts[id])) continue;
      event.preventDefault();
      event.stopPropagation();
      run();
      return;
    }
  };

  const isDiffTab = active?.kind === "diff";
  const activeKey = active ? tabKey(active) : null;
  /** 当前标签是普通文件（含未命名缓冲区）时才有文件生命周期动作 */
  const activeFile: FileTab | null = active !== null && active.kind === "file" ? active : null;

  // 图片没有"编辑/预览"两个模式，打开就是预览。判据用 active 而不是 status：
  // 加载中和加载失败时也得把 Monaco 那块藏住，否则会露出上一次的残留内容
  const isImageTab = active?.kind === "file" && isImagePath(active.path);

  // PDF 同理：打开即预览，没有编辑模式
  const isPdfTab = active?.kind === "file" && isPdfPath(active.path);

  // 有预览可切的文件：markdown 实时渲染，html / htm / svg 走 asset 协议读磁盘。
  // 判据是 status.kind === "ready"：加载中和加载失败时不给预览入口
  const canPreview =
    status.kind === "ready" &&
    active?.kind === "file" &&
    (isMarkdownPath(active.path) || isHtmlPreviewPath(active.path));
  const isPreview = canPreview && activeKey !== null && previewPaths.has(activeKey);
  const isMarkdownPreview = isPreview && active?.kind === "file" && isMarkdownPath(active.path);
  const isHtmlPreview =
    isPreview && active?.kind === "file" && isHtmlPreviewPath(active.path);

  // 当前文件是不是 markdown——整屏预览与分屏预览都只有它走「从 model 现渲染」这条路
  const isMarkdownFile = active?.kind === "file" && isMarkdownPath(active.path);
  /** 预览时按这个路径解析相对图片；diff / 非文件标签没有 */
  const previewSourcePath = active?.kind === "file" ? active.path : null;
  // 当前文件在 model 缓存里的那条记录。直接从缓存里现取（每次渲染都算）：加载完成、
  // 切标签、切编码都会走一次渲染，取到的自然是最新的；不用 state 单独存一份，省得两处对不上
  const activeCached = activeKey ? modelsRef.current.get(activeKey) ?? null : null;
  /**
   * 左右分屏预览。只对 markdown 开：html / svg 的预览读磁盘、要整屏才够用。
   * 和整屏预览互斥（两个 toggle 各自会把对方摘掉），这里再兜一层：整屏优先
   */
  const isSplitPreview =
    canPreview && activeKey !== null && isMarkdownFile && splitPaths.has(activeKey) && !isPreview;

  /**
   * 翻译视图：只对文档扩展名开放（源码 / 脚本 / 配置不给入口），
   * 大文件、二进制、空内容都不进。翻译与预览 / 对照互斥。
   */
  const isTranslate = activeKey !== null && translationPaths.has(activeKey);
  const canTranslate =
    status.kind === "ready" &&
    activeFile !== null &&
    activeCached !== null &&
    isDocumentPath(activeFile.path) &&
    !activeCached.isLarge &&
    activeCached.model.getValue().trim() !== "";

  /**
   * 当前 markdown 标签的查看方式。默认由 previewsOnOpen 播种成「预览」；
   * 之后只认用户点的那几个按钮，切走再切回来保持原样。
   */
  const markdownMode: MarkdownMode | null = !isMarkdownFile
    ? null
    : isTranslate
      ? "translate"
      : isPreview
        ? "preview"
        : isSplitPreview
          ? "split"
          : "edit";

  // 进预览时同步渲染一次：放在渲染期算完，就不会先闪一帧空白。
  // 内容按 activeKey 从缓存里取，**不能**读编辑器当前挂着的 model：换 model 的
  // effect 在渲染之后才跑，切到另一个 md 标签的这一帧读到的还是上一个文件的
  // model；而 isMarkdownPreview 由 false 变 true 就发生在这同一帧，等 effect 把 model
  // 换好之后依赖没再变过，memo 不会重算，上一个文件的内容就永久留在预览层上了。
  // 预览期间编辑器是 hidden 的、内容改不了，缓存里那份就是当前内容。
  const previewHtml = useMemo(() => {
    if (!isMarkdownPreview || activeKey === null || previewSourcePath === null) return "";
    const cached = modelsRef.current.get(activeKey);
    // 大文件不渲染全文：MarkdownPreview 会显示降级提示，编辑模式仍然可用
    if (!cached || cached.isLarge) return "";
    return renderMarkdown(cached.model.getValue(), { filePath: previewSourcePath, roots });
  }, [isMarkdownPreview, activeKey, previewNonce, previewSourcePath, roots]);

  /**
   * 分屏预览的 HTML。整屏那份是渲染期一次算完的，前提「预览期间编辑器改不了内容」
   * 在分屏下不成立——左侧一直在打字。所以这里存 state，订阅当前 model 的
   * onDidChangeContent，防抖后再重渲染右侧（大文件渲染有点成本，别每敲一下算一遍）。
   */
  const [splitHtml, setSplitHtml] = useState("");
  /** 对照模式右侧的滚动容器外壳，同步滚动时从这里找 .markdown-body */
  const splitPreviewRef = useRef<HTMLDivElement>(null);
  /** 预览里的块锚点；每次同步前重读，图片 / 字体加载后的高度变化也能跟上 */
  const splitAnchorsRef = useRef<PreviewAnchor[]>([]);
  /** 防止「同步预览 -> 预览滚动 -> 又同步编辑器」的回环 */
  const syncGuardRef = useRef<"editor" | "preview" | null>(null);
  const syncGuardTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!isSplitPreview || activeKey === null) {
      // 退出分屏 / 换标签时清掉，免得下次进入先闪一帧上一个文件的内容
      setSplitHtml("");
      return;
    }
    const cached = modelsRef.current.get(activeKey);
    // 大文件不渲染右侧正文：MarkdownPreview 只显示降级提示，避免整篇渲染卡住
    if (!cached || cached.isLarge) {
      setSplitHtml("");
      return;
    }
    const model = cached.model;
    // 进入分屏先同步渲染一次，右侧不留空白
    setSplitHtml(
      renderMarkdown(model.getValue(), {
        sourceLines: true,
        filePath: previewSourcePath ?? undefined,
        roots,
      }),
    );
    let timer: number | undefined;
    const sub = model.onDidChangeContent(() => {
      // 手一直不停就一直往后推，停下来才重渲染
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () =>
          setSplitHtml(
            renderMarkdown(model.getValue(), {
              sourceLines: true,
              filePath: previewSourcePath ?? undefined,
              roots,
            }),
          ),
        200,
      );
    });
    return () => {
      sub.dispose();
      window.clearTimeout(timer);
    };
  }, [isSplitPreview, activeKey, activeCached?.isLarge, previewSourcePath, roots]);

  /**
   * 对照模式的滚动同步：顶部先按块锚点对齐，块内再按行数插值。
   * 只监听真正可见的那一侧的用户滚动，程序化滚动用 syncGuard 吃掉回声。
   */
  useEffect(() => {
    if (!isSplitPreview) {
      splitAnchorsRef.current = [];
      return;
    }
    const editor = editorRef.current;
    const scroller =
      splitPreviewRef.current?.querySelector<HTMLElement>(".markdown-body") ?? null;
    if (!editor || !scroller) return;

    let frame = 0;
    const readAnchors = () => {
      splitAnchorsRef.current = readPreviewAnchors(scroller);
    };
    const holdGuard = (side: "editor" | "preview") => {
      syncGuardRef.current = side;
      window.clearTimeout(syncGuardTimerRef.current);
      syncGuardTimerRef.current = window.setTimeout(() => {
        syncGuardRef.current = null;
      }, 120);
    };
    const fromEditor = () => {
      if (syncGuardRef.current === "preview") return;
      readAnchors();
      holdGuard("editor");
      const line = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
      scrollPreviewToEditor(scroller, splitAnchorsRef.current, line);
    };
    const fromPreview = () => {
      if (syncGuardRef.current === "editor") return;
      // 图片 / 字体加载后块高度会变，滚动时重读一次，别拿过期位置对齐
      readAnchors();
      holdGuard("preview");
      scrollEditorToPreview(editor, splitAnchorsRef.current, scroller.scrollTop);
    };
    const schedule = (run: () => void) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(run);
    };

    readAnchors();
    // 刚进对照 / 内容刚重渲染：先把预览对齐到编辑器当前位置
    fromEditor();

    const editorSub = editor.onDidScrollChange(() => schedule(fromEditor));
    const onScroll = () => schedule(fromPreview);
    scroller.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      editorSub.dispose();
      scroller.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(syncGuardTimerRef.current);
      syncGuardRef.current = null;
    };
  }, [isSplitPreview, splitHtml]);

  // 预览或差异视图下 Monaco 容器是 hidden 的、量不到尺寸，切回可见得补一次 layout，
  // 否则行号栏宽度和滚动位置还是按 0 尺寸算出来的；工作区从后台切回来时同理。
  // 分屏切换会改 Monaco 容器的可用宽度，也要补一次
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      editorRef.current?.layout();
      diffRef.current?.layout();
    });
    return () => cancelAnimationFrame(frame);
  }, [isPreview, isSplitPreview, isDiffTab, isImageTab, isPdfTab, visible]);

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

  const activeEncoding = activeCached?.encoding || null;
  /**
   * 另存为的可用性：截断文件写出去只会得到残缺内容，直接禁掉。
   * 保存按钮另有针对性禁用（只读 / 截断都不给按）。
   */
  const canSaveAsActive = activeCached !== null && !activeCached.truncated;

  /**
   * 编码状态栏只在普通文本文件上出现：差异、图片没有「按原编码回写」这回事；
   * 未命名缓冲区固定按 UTF-8 落盘，也没有可切的编码；
   * 二进制 / 超限也没有 model 可重读。编码已知、或加载失败（认不出编码）时显示——
   * 后者正是它的补救入口。首次加载中不显示，免得和正在跑的加载抢着建 model。
   */
  const showEncodingBar =
    active?.kind === "file" &&
    active.path !== null &&
    !isImageTab &&
    !isPdfTab &&
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

  // 标签右键菜单要显示哪些项，取决于这个标签当前的状态；先算好，JSX 里就不再嵌逻辑
  const tabMenuKey = tabMenu ? tabKey(tabMenu.tab) : null;
  const tabMenuCached = tabMenuKey !== null ? modelsRef.current.get(tabMenuKey) ?? null : null;
  const tabMenuDirty = tabMenuKey !== null && dirtyPaths.has(tabMenuKey);
  const tabMenuExternal: ExternalState =
    tabMenu && tabMenu.tab.kind === "file" ? tabMenu.tab.externalState : "none";

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

  /**
   * 换行符：LF / CRLF 用 pushEOL（一次可撤销的内容编辑），不用会清掉撤销栈的 setEOL。
   * CR 在 Monaco 里表示不了，模型保持 LF、只把「保存时按 CR 回写」记在缓存上。
   * 状态栏显示与保存都以 cached.eol 为准，不再拿 model.getEOL() 当唯一依据。
   */
  const applyEol = (eol: Eol) => {
    setStatusMenu(null);
    const current = activeRef.current;
    if (!current || current.kind !== "file") return;
    const cached = modelsRef.current.get(tabKey(current));
    if (!cached) return;
    cached.eol = eol;
    if (eol !== "CR") {
      cached.model.pushEOL(
        eol === "CRLF"
          ? monaco.editor.EndOfLineSequence.CRLF
          : monaco.editor.EndOfLineSequence.LF,
      );
    }
    refreshViewInfo();
    // CR 这种 Monaco 表示不了的换行只改缓存、不改内容，脏标记得手动刷一次
    syncDirty();
  };

  /** 缩进：作用在 model 上，只影响这个文件的编辑行为 */
  const applyIndent = (tabSize: number, insertSpaces: boolean) => {
    setStatusMenu(null);
    const model = activeTextModel();
    if (!model) return;
    model.updateOptions({ tabSize, insertSpaces });
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

  /** 换行符菜单项。CR 只是保存目标，Monaco 里看不到区别，所以状态栏显示得单独说明 */
  const eolItems = (): StatusMenuItem[] => [
    { key: "lf", label: "LF", checked: viewInfo?.eol === "LF", onPick: () => applyEol("LF") },
    {
      key: "crlf",
      label: "CRLF",
      checked: viewInfo?.eol === "CRLF",
      onPick: () => applyEol("CRLF"),
    },
    {
      key: "cr",
      label: "CR（老式 Mac）",
      checked: viewInfo?.eol === "CR",
      onPick: () => applyEol("CR"),
    },
  ];

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-surface" onKeyDownCapture={onPaneKeyDown}>
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <div
          ref={tabsScrollRef}
          onClickCapture={onClickCapture}
          // 标签栏空白处双击新建未命名缓冲区（照 VS Code）；落在标签 / 关闭按钮上不触发
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest("[data-tab-item]")) return;
            onNewUntitled();
          }}
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.length === 0 && (
            <span className="px-1 text-[11px] text-fg-faint">未打开文件</span>
          )}
          {tabs.map((tab, index) => {
            const key = tabKey(tab);
            const isActive = active !== null && tabKey(active) === key;
            const isDirty = dirtyPaths.has(key);
            // 未命名缓冲区没有路径，既没有 git 标记也不显示路径
            const mark = tab.path === null ? undefined : gitMarks.get(pathKey(tab.path));
            const external: ExternalState = tab.kind === "file" ? tab.externalState : "none";
            const suffix = tabSuffix(tab);
            const dropBefore = dropIndex === index;
            const dropAfter = dropIndex === tabs.length && index === tabs.length - 1;
            return (
              <div
                key={key}
                data-tab-item
                data-tab-active={isActive ? "" : undefined}
                onPointerDown={onTabDown(index)}
                // 中键关闭：和 VS Code / 浏览器的习惯一致（左键拖动重排不受影响，
                // onTabDown 只认左键）
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  closeTab(tab);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setTabMenu({ x: event.clientX, y: event.clientY, tab });
                }}
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
                  <span className="truncate">{tabName(tab)}</span>
                  {suffix && (
                    <span className="ml-1 shrink-0 text-[10px] text-fg-faint">{suffix}</span>
                  )}
                  {/* 外部变更比未保存圆点更要紧：冲突 / 删除要用户处理，先占这个位置 */}
                  {external !== "none" && (
                    <span
                      title={
                        external === "conflict"
                          ? "磁盘上的文件已被外部修改，你的未保存修改没有被覆盖"
                          : external === "deleted"
                            ? "磁盘上的文件已被删除"
                            : "磁盘上的文件已在外部更新"
                      }
                      className={`ml-1 shrink-0 text-[10px] font-medium ${
                        external === "conflict"
                          ? "text-danger"
                          : external === "deleted"
                            ? "text-danger"
                            : "text-accent-soft"
                      }`}
                    >
                      {external === "conflict" ? "≠" : external === "deleted" ? "∅" : "↓"}
                    </span>
                  )}
                  {/* 未保存的改动比 git 状态更要紧，两者只占同一个位置：脏的时候下面那颗
                      圆点按钮就是它的标记（点一下即保存），这里让位 */}
                  {!isDirty && mark && <GitMarkBadge mark={mark} className="ml-1 text-[10px]" />}
                </button>
                {/* 脏标签的圆点即保存（照 VS Code / CodeLite）：点它是保存，不是关闭。
                    关闭入口仍在右边，只是不再和「保存」抢同一个圆点的语义 */}
                {isDirty && (
                  <button
                    type="button"
                    data-tab-save
                    onClick={() => void saveTab(key)}
                    title={`保存（${formatShortcut(settings.shortcuts["editor.save"])}）`}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-warn hover:bg-hover"
                  >
                    <span className="h-2 w-2 rounded-full bg-current" />
                  </button>
                )}
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
        {/* 新建未命名缓冲区。快捷键 Ctrl+N，标签栏空白处双击也能新建 */}
        <button
          type="button"
          onClick={onNewUntitled}
          title={`新建文件（${formatShortcut(settings.shortcuts["editor.newFile"])}）`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
        >
          <IconPlus className="h-3.5 w-3.5" />
        </button>
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
        {/* html / svg 仍是「编辑 ↔ 预览」两态，markdown 用下面那组三态按钮 */}
        {canPreview && !isMarkdownFile && (
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
        {/* markdown：预览 / 编辑 / 对照。默认预览，三种方式同一时间只开一个 */}
        {isMarkdownFile && status.kind === "ready" && markdownMode !== null && (
          <div
            role="group"
            aria-label="markdown 查看方式"
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-line-strong p-0.5"
          >
            {MARKDOWN_MODES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMarkdownMode(id)}
                aria-pressed={markdownMode === id}
                disabled={id === "translate" && !canTranslate}
                title={
                  id === "preview"
                    ? "预览渲染后的效果"
                    : id === "edit"
                      ? "编辑 Markdown 源码"
                      : id === "split"
                        ? "左边源码，右边渲染"
                        : "左原文、右译文的文档翻译"
                }
                className={`rounded px-2 py-0.5 text-[11px] ${
                  markdownMode === id
                    ? "bg-selected text-fg"
                    : "text-fg-dim hover:bg-hover hover:text-fg"
                } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {/* 纯文本 / 日志等文档：markdown 走上面的四态分组，这里给一个独立的翻译开关 */}
        {activeFile && status.kind === "ready" && !isMarkdownFile && canTranslate && (
          <button
            type="button"
            onClick={toggleTranslation}
            aria-pressed={isTranslate}
            title={isTranslate ? "回到编辑" : "文档翻译（左原文、右译文）"}
            className={`flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] ${
              isTranslate
                ? "bg-selected text-fg"
                : "text-fg-dim hover:bg-hover hover:text-fg"
            }`}
          >
            <IconArrowsLeftRight className="h-3.5 w-3.5" />
            翻译
          </button>
        )}
        {/* 查找 / 替换：切换 Monaco 的 find widget（开着再点就收起）。
            Ctrl+F 走命令分发打开同一个 widget，Ctrl+H 的替换仍是 Monaco 内置 */}
        {activeFile && status.kind === "ready" && (
          <button
            type="button"
            onClick={toggleFind}
            title={`查找 / 替换（${formatShortcut(settings.shortcuts["editor.find"])}、Ctrl+H）`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
          >
            <IconSearch className="h-3.5 w-3.5" />
          </button>
        )}
        {/* 格式化：Prettier 覆盖的类型走 Prettier，其余退回缩进重排。
            只读 / 截断 / 大文件不给按（重写整篇正文对它们没有意义） */}
        {activeFile && activeCached && (
          <button
            type="button"
            onClick={formatActive}
            disabled={!canFormatTab(activeCached)}
            title={`格式化文档（${formatShortcut(settings.shortcuts["editor.format"])}）`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim"
          >
            <IconWand className="h-3.5 w-3.5" />
          </button>
        )}
        {activeDirty && activeCached && !activeCached.truncated && !activeCached.readOnly && (
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
        {/* 文件生命周期入口：另存为对所有文件标签开放，放弃变更只在确实有未保存改动时可用 */}
        {activeFile && activeCached && (
          <>
            <button
              type="button"
              onClick={() => {
                if (activeKey !== null) void saveAs(activeKey);
              }}
              disabled={!canSaveAsActive || saving}
              title={
                activeCached.truncated
                  ? "文件已截断，不能另存为"
                  : activeCached.path === null
                    ? "把未命名缓冲区保存到工作区里的文件"
                    : "另存为…"
              }
              className={HEADER_BUTTON}
            >
              另存为
            </button>
            <button
              type="button"
              onClick={() => {
                if (activeKey !== null) void discardChanges(activeKey);
              }}
              disabled={!activeDirty}
              title="放弃未保存的修改（已落盘文件从磁盘重读）"
              className={HEADER_BUTTON}
            >
              放弃变更
            </button>
          </>
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

      {/* 标签右键菜单：定位文件（打开所在目录 / 在文件管理器中显示）+ 文件生命周期动作
          + 外部变更的处理入口 */}
      {tabMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setTabMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: TAB_MENU_W,
              left: Math.min(tabMenu.x, window.innerWidth - TAB_MENU_W - 4),
              // 最多 7 项（定位 2 项 + 另存为 / 放弃变更 / 重载 / 保留 + 关闭），按每项 ~23px 估
              top: Math.min(tabMenu.y, window.innerHeight - 250),
            }}
          >
            {tabMenu.tab.kind === "file" && (
              <>
                <button
                  type="button"
                  disabled={tabMenuCached === null || tabMenuCached.truncated}
                  onClick={() => {
                    const key = tabMenuKey;
                    setTabMenu(null);
                    if (key !== null) void saveAs(key);
                  }}
                  className={TABS_MENU_ITEM}
                >
                  另存为…
                </button>
                <button
                  type="button"
                  disabled={!tabMenuDirty || tabMenuCached === null}
                  onClick={() => {
                    const key = tabMenuKey;
                    setTabMenu(null);
                    if (key !== null) void discardChanges(key);
                  }}
                  className={TABS_MENU_ITEM}
                >
                  放弃变更
                </button>
                {tabMenuExternal === "conflict" && (
                  <button
                    type="button"
                    onClick={() => {
                      const key = tabMenuKey;
                      setTabMenu(null);
                      if (key !== null) void discardChanges(key);
                    }}
                    className={TABS_MENU_ITEM}
                  >
                    重新加载（放弃我的修改）
                  </button>
                )}
                {(tabMenuExternal === "conflict" || tabMenuExternal === "deleted") && (
                  <button
                    type="button"
                    onClick={() => {
                      const tab = tabMenu.tab;
                      setTabMenu(null);
                      onPatchTab(tab, { externalState: "none" });
                    }}
                    className={TABS_MENU_ITEM}
                  >
                    保留我的修改
                  </button>
                )}
              </>
            )}
            {/* 打开所在目录 / 在文件管理器中显示：都用于「找到这个文件」，一个在应用内的
                文件树里定位（右栏会切到「文件」模块并展开到它），一个交给系统文件管理器。
                未命名缓冲区还没有路径，两项都禁用 */}
            <button
              type="button"
              disabled={tabMenu.tab.path === null}
              onClick={() => {
                const path = tabMenu.tab.path;
                setTabMenu(null);
                if (path !== null) revealInFiles(path);
              }}
              className={TABS_MENU_ITEM}
            >
              打开所在目录
            </button>
            <button
              type="button"
              disabled={tabMenu.tab.path === null}
              onClick={() => {
                const path = tabMenu.tab.path;
                setTabMenu(null);
                if (path !== null) revealInSystem(path);
              }}
              className={TABS_MENU_ITEM}
            >
              在文件管理器中显示
            </button>
            <button
              type="button"
              onClick={() => {
                const tab = tabMenu.tab;
                setTabMenu(null);
                closeTab(tab);
              }}
              className={TABS_MENU_ITEM}
            >
              关闭
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

      {/* relative 给下面的绝对定位预览层（图片 / 整屏预览 / 加载遮罩）当定位父级；
          flex 让 SplitPane 的 flex-1 撑满 */}
      <div className="relative flex min-h-0 flex-1">
        {/* 分栏的壳一直在：直接把 Monaco 的容器从「绝对铺满」改成「有宽度参与分栏」，
            切分屏时才会重新挂载（Monaco 实例只建一次，重挂载会让它挂到脱离的节点上）。
            不分屏时收起第二块，第一块自动撑满，和以前一个样 */}
        <SplitPane
          initial={50}
          min={20}
          max={80}
          secondCollapsed={!isSplitPreview}
          first={
            <div
              ref={containerRef}
              className={isPreview || isDiffTab || isImageTab || isPdfTab || isTranslate ? "hidden" : "h-full w-full"}
            />
          }
          second={
            // 右侧渲染预览。MarkdownPreview 是 absolute inset-0，得给它一个定位父级；
            // 滚动同步通过这个外壳找到里面真正的滚动容器
            <div ref={splitPreviewRef} className="relative h-full w-full">
              {isSplitPreview && (
                <MarkdownPreview html={splitHtml} isLarge={activeCached?.isLarge ?? false} />
              )}
            </div>
          }
        />
        <div
          ref={diffContainerRef}
          className={isDiffTab ? "absolute inset-0" : "hidden"}
        />

        {isMarkdownPreview && (
          <MarkdownPreview html={previewHtml} isLarge={activeCached?.isLarge ?? false} />
        )}
        {/* 翻译视图：左原文右译文，正文取编辑器当前内容（含未保存改动），不写回文件 */}
        {isTranslate && status.kind === "ready" && activeKey !== null && activeFile && activeCached && (
          <TranslationView
            tabKey={activeKey}
            path={activeFile.path}
            title={tabName(activeFile)}
            content={activeCached.model.getValue()}
            roots={roots}
            isLarge={activeCached.isLarge}
            onOpenSettings={onOpenSettings}
          />
        )}
        {/* html / htm / svg 预览：iframe 走 asset 协议读磁盘，相对路径的 css / js / 图片一并生效 */}
        {isHtmlPreview && activeFile && activeFile.path !== null && (
          <HtmlPreview path={activeFile.path} nonce={previewNonce} />
        )}

        {/* PDF 预览：同样走 asset 协议，交给 WebView 内置阅读器翻页 / 缩放 */}
        {isPdfTab && activeFile && activeFile.path !== null && (
          <PdfPreview path={activeFile.path} />
        )}

        {/* 图片按原比例整体放进可视区，不放大也不让横竖滚动条出场 */}
        {status.kind === "image" && (
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden p-4">
            <img
              src={status.src}
              alt={active ? tabName(active) : ""}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}

        {overlay.kind !== "ready" && overlay.kind !== "image" && overlay.kind !== "pdf" && (
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

      {/* 状态栏。普通文件左侧是光标位置与视图选项（语言 / 缩进 / 换行符），
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
                {/* 路径：点击复制绝对路径（只对已落盘的文件显示；未命名缓冲区没有路径）。
                    窄面板里靠 max-w + truncate 收住，完整路径挂在 title 上 */}
                {activeFile && activeFile.path !== null && (
                  <button
                    type="button"
                    onClick={copyActivePath}
                    title={`${toDisplayPath(activeFile.path)}\n点击复制路径`}
                    className={`${STATUS_BUTTON} min-w-0 max-w-[45%]`}
                  >
                    <span className="truncate">{toDisplayPath(activeFile.path)}</span>
                  </button>
                )}
                <span
                  title="光标位置"
                  className="shrink-0 px-1.5 text-[11px] tabular-nums text-fg-dim"
                >
                  行 {viewInfo.line}，列 {viewInfo.column}
                  {viewInfo.selectionLength > 0 && `（已选 ${viewInfo.selectionLength}）`}
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
                  title="换行符（点击切换，保存时按它回写）"
                  className={STATUS_BUTTON}
                >
                  {viewInfo.eol}
                </button>
                {/* 文件属性标记：截断最要紧（不能保存），其次是只读，再是大文件降级 */}
                {activeCached?.truncated && (
                  <span
                    title={`文件 ${formatSize(activeCached.size)}，只加载了前 8MB，保存已禁用`}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-danger"
                  >
                    已截断，只读
                  </span>
                )}
                {!activeCached?.truncated && activeCached?.readOnly && (
                  <span
                    title="磁盘上的文件是只读的，保存已禁用"
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-warn"
                  >
                    只读
                  </span>
                )}
                {activeCached?.isLarge && !activeCached.truncated && (
                  <span
                    title={`文件 ${formatSize(activeCached.size)}，已关闭缩略图 / 折叠 / 高亮等高成本能力`}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-warn"
                  >
                    大文件
                  </span>
                )}
                {/* 文件大小：只在已落盘的文件上有意义（未命名缓冲区是 0） */}
                {activeFile && activeFile.path !== null && activeCached && (
                  <span
                    title="文件大小（磁盘上的字节数）"
                    className="shrink-0 px-1.5 text-[11px] tabular-nums text-fg-dim"
                  >
                    {formatSize(activeCached.size)}
                  </span>
                )}
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
            title="送给应用助手"
            onClick={() => sendSelection("assistant")}
            className={FLOAT_BAR_BUTTON}
          >
            <IconBot className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 切编码会从磁盘重读，等于丢掉未保存的改动，脏标签先确认 */}
      {encodingSwitch && (
        <ConfirmDialog
          message={`按 ${encodingName(encodingSwitch.label)} 重新读取 ${tabName(
            encodingSwitch.tab,
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

      {/* 关闭有未保存改动的标签（单个 / 全部 / 其他）：逐个问「保存 / 不保存 / 取消」。
          保存失败或另存为取消都会中止整次关闭，标签原样留着 */}
      {closeRequest && closeTabNow && (
        <ConfirmDialog
          message={`${tabName(closeTabNow)} 有未保存的改动。${
            closeTabNow.kind === "file" && closeTabNow.path === null
              ? "这个缓冲区还没保存到磁盘。"
              : ""
          }`}
          confirmLabel="保存"
          secondaryLabel="不保存"
          danger={false}
          onConfirm={() => answerClose("save")}
          onSecondary={() => answerClose("discard")}
          onCancel={() => setCloseRequest(null)}
        />
      )}

      {/* 保存前的语法问题：交互式保存时问一句「仍然保存 / 取消」，取消则这个文件不落盘。
          排在其它弹窗之后渲染，真要同时出现时也压在最上面 */}
      {syntaxPrompt && (
        <ConfirmDialog
          message={`「${syntaxPrompt.name}」可能存在语法错误：${syntaxPrompt.detail}。仍要保存吗？`}
          confirmLabel="仍然保存"
          danger={false}
          onConfirm={() => answerSyntax(true)}
          onCancel={() => answerSyntax(false)}
        />
      )}

      {/* 一次性提示条。浮在编辑区底部，几秒后自动消失，不挡住内容 */}
      {notice && (
        <div className="pointer-events-none absolute bottom-8 left-1/2 z-30 -translate-x-1/2 px-4">
          <div
            className={`pointer-events-auto rounded-md border px-3 py-1.5 text-[11px] shadow-lg ${
              notice.tone === "error"
                ? "border-danger-line bg-danger-bg text-danger"
                : "border-line-strong bg-raised text-fg-muted"
            }`}
          >
            {notice.text}
          </div>
        </div>
      )}
    </section>
  );
}
