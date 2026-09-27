import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { monaco, DARK_THEME, LIGHT_THEME } from "../lib/monaco-setup";
import { languageOf } from "../lib/languages";
import { renderMarkdown } from "../lib/markdown";
import {
  gitFileDiff,
  isPathInside,
  pathKey,
  readFile,
  readImage,
  toDisplayPath,
  writeFile,
} from "../lib/fs";
import type { GitMark } from "../lib/git";
import { useSettings, resolveFont } from "../lib/settings";
import { tabKey, tabSuffix, tabTitle, type Tab } from "../lib/tabs";
import type { EditorLocation } from "../lib/types";
import { useTheme } from "../lib/theme";
import { GitMarkBadge } from "./GitMarkBadge";
import { FullscreenButton } from "./FullscreenButton";
import { MarkdownPreview } from "./MarkdownPreview";
import { IconBot, IconClose, IconEye, IconPencil, IconTerminal } from "./icons";

/** 选中浮窗的估算宽度，用来把它收进窗口右边缘 */
const FLOAT_BAR_W = 76;

/** 浮窗按钮：两个动作同款，禁用态（智能体没开）不给 hover 反馈 */
const FLOAT_BAR_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

interface EditorPaneProps {
  /** 已打开的标签，按打开顺序 */
  tabs: Tab[];
  /** 当前显示的那个 */
  active: Tab | null;
  /** 归一化路径 -> git 标记 */
  gitMarks: ReadonlyMap<string, GitMark>;
  onActivate: (tab: Tab) => void;
  onClose: (tab: Tab) => void;
  /** 全屏展示状态。按钮挂在编辑器标题栏右端，也就是右边栏的右上角 */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 选中浮窗的两个动作：把位置引用送到终端 / 智能体输入框 */
  onSendToTerminal: (location: EditorLocation) => void;
  onSendToAgent: (location: EditorLocation) => void;
  /** 工作区根目录：把绝对路径收敛成相对路径，给智能体标位置用 */
  root: string;
  /** 搜索替换要用的几个动作。React 19 起 ref 可以直接当普通 prop 传，不必再包 forwardRef */
  ref?: Ref<EditorPaneHandle>;
}

interface CachedModel {
  /** 落盘要用，Map 的键是 tabKey 不是路径 */
  path: string;
  model: monaco.editor.ITextModel;
  savedVersionId: number;
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
  const key =
    source.mode === "commit" ? `commit-${source.rev.slice(0, 12)}` : source.mode;
  return monaco.Uri.parse(
    `codedock-diff:/${key}/${encodeURIComponent(pathKey(tab.path))}/${side}`,
  );
}

export function EditorPane({
  tabs,
  active,
  gitMarks,
  onActivate,
  onClose,
  fullscreen,
  onToggleFullscreen,
  onSendToTerminal,
  onSendToAgent,
  root,
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

  const activeRef = useRef<Tab | null>(active);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [diffStatus, setDiffStatus] = useState<Status>({ kind: "idle" });
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  /** 正处在预览模式的 markdown 标签（存 tabKey）；不在集合里就是编辑模式 */
  const [previewPaths, setPreviewPaths] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  /** 选中文本浮窗的视口坐标；null = 不显示 */
  const [floatBar, setFloatBar] = useState<{ top: number; left: number } | null>(null);
  /**
   * 浮窗对应的选中位置。点按钮那一刻编辑器可能已经失焦，现取不可靠，所以在选中那一刻就存下来
   */
  const floatLocationRef = useRef<EditorLocation | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  /** 标签栏的横向滚动容器，用来在切换标签时把激活标签滚进可视区 */
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const { theme } = useTheme();
  const { settings } = useSettings();

  // 建 editor 的 effect 只认挂载那一刻的主题，切换主题走下面的 effect 单独更新
  const themeRef = useRef(theme);
  themeRef.current = theme;
  // 浮窗的鼠标回调也建在「只跑一次」的建 editor effect 里，读 root 同样得走 ref
  const rootRef = useRef(root);
  rootRef.current = root;
  const fontSizeRef = useRef(settings.editorFontSize);
  fontSizeRef.current = settings.editorFontSize;
  const fontFamilyRef = useRef(settings.editorFontFamily);
  fontFamilyRef.current = settings.editorFontFamily;
  const fontBoldRef = useRef(settings.editorFontBold);
  fontBoldRef.current = settings.editorFontBold;

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
   * 用视口坐标（和项目里其它弹出菜单一致），因为编辑器会随分栏拖动而移动。
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
            path: relativeToRoot(current.path, rootRef.current),
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
        await writeFile(cached.path, cached.model.getValue());
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
            const content = await readFile(cached.path);
            if (content.isBinary || content.tooLarge) continue;
            // 读文件这一下用户可能又敲进了改动，再查一次，编辑优先
            if (cached.model.getAlternativeVersionId() !== cached.savedVersionId) continue;
            // 磁盘上和 model 里一模一样就别 setValue——这一般是编辑器自己刚保存
            // 触发的回声，重设一遍会白白清掉撤销栈、还会把光标弹回开头
            if (cached.model.getValue() === content.text) continue;
            cached.model.setValue(content.text);
            cached.savedVersionId = cached.model.getAlternativeVersionId();
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
            const content = await readImage(current.path);
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
    }),
    [disposeModels, forgetKeys],
  );

  /**
   * 把差异视图滚到第一处改动（在「变更」里点开一个文件时用）。
   * 差异是 Monaco 异步算出来的：model 刚挂上时 getLineChanges() 还是 null，得等
   * onDidUpdateDiff 再滚；复用缓存 model 时通常已经算好，当场就能滚。容器可能刚
   * 从 hidden 切到可见，等一帧让 Monaco 量到尺寸，否则滚不动。
   */
  const revealFirstDiffChange = useCallback(() => {
    const diff = diffRef.current;
    if (!diff) return;
    const changes = diff.getLineChanges();
    if (!changes || changes.length === 0) return;
    diffRevealPendingRef.current = false;
    // 纯删除的改动块里 modifiedStartLineNumber 可能落到区块前一行的位置，兜到 1
    const line = Math.max(1, changes[0].modifiedStartLineNumber);
    requestAnimationFrame(() => diffRef.current?.getModifiedEditor().revealLineInCenter(line));
  }, []);

  // 差异编辑器只在第一次真的要看差异时才建：省一份初始化，
  // 也避免在 hidden（0 尺寸）的容器上建实例
  const ensureDiffEditor = useCallback(() => {
    if (diffRef.current) return;
    const container = diffContainerRef.current;
    if (!container) return;
    diffRef.current = monaco.editor.createDiffEditor(container, {
      // 内联：新增/删除行上下相邻，窄面板下也比左右并排好读
      renderSideBySide: false,
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
    // 差异算完的那一刻才知道第一处改动在哪
    diffRef.current.onDidUpdateDiff(() => {
      if (diffRevealPendingRef.current) revealFirstDiffChange();
    });
  }, [revealFirstDiffChange]);

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
        payload = await gitFileDiff(tab.path, tab.source);
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

    const themeName = themeRef.current === "light" ? LIGHT_THEME : DARK_THEME;
    monaco.editor.setTheme(themeName);
    const editor = monaco.editor.create(container, {
      theme: themeName,
      automaticLayout: true,
      fontSize: fontSizeRef.current,
      fontFamily: resolveFont(fontFamilyRef.current),
      fontWeight: fontBoldRef.current ? "bold" : "normal",
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      tabSize: 2,
      padding: { top: 8 },
    });
    editorRef.current = editor;

    const contentSub = editor.onDidChangeModelContent(() => syncDirty());

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
    const saveAction = editor.addAction({
      id: "codedock.save",
      label: "保存文件",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void saveRef.current();
      },
    });

    return () => {
      saveAction.dispose();
      contentSub.dispose();
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
  }, [syncDirty, showFloatBar]);

  // 切主题不重建 editor，只换配色（差分编辑器共用全局主题）
  useEffect(() => {
    monaco.editor.setTheme(theme === "light" ? LIGHT_THEME : DARK_THEME);
  }, [theme]);

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

      void readImage(active.path)
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

    void readFile(path)
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
        const model =
          monaco.editor.getModel(uri) ??
          monaco.editor.createModel(content.text, languageOf(path), uri);
        modelsRef.current.set(key, {
          path,
          model,
          savedVersionId: model.getAlternativeVersionId(),
        });
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

  // 切换当前 markdown 文件的编辑/预览模式。用 ref 读当前标签，省得 active 一变就重建这个回调
  const togglePreview = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.kind !== "file") return;
    const key = tabKey(current);
    setPreviewPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const closeTab = useCallback(
    (tab: Tab) => {
      const key = tabKey(tab);
      if (
        dirtyPaths.has(key) &&
        !window.confirm(`${baseName(tab.path)} 有未保存的改动，确定关闭吗？`)
      ) {
        return;
      }

      forgetKeys(disposeModels((_, current) => current === key));
      onClose(tab);
    },
    [dirtyPaths, onClose, disposeModels, forgetKeys],
  );

  const isDiffTab = active?.kind === "diff";
  const activeKey = active ? tabKey(active) : null;

  // 图片没有"编辑/预览"两个模式，打开就是预览。判据用 active 而不是 status：
  // 加载中和加载失败时也得把 Monaco 那块藏住，否则会露出上一次的残留内容
  const isImageTab = active?.kind === "file" && isImagePath(active.path);

  // 只有加载完成的 markdown 文件才有预览可切
  const canPreview =
    status.kind === "ready" &&
    active?.kind === "file" &&
    languageOf(active.path) === "markdown";
  const isPreview = canPreview && activeKey !== null && previewPaths.has(activeKey);

  // 进预览时同步渲染一次：放在渲染期算完，就不会先闪一帧空白。
  // 依赖里没有 model —— 预览期间编辑器是 hidden 的、内容改不了，
  // 而 isPreview / active 一变就会重算，读到的永远是刚挂上去的那个 model。
  const previewHtml = useMemo(() => {
    if (!isPreview) return "";
    const model = editorRef.current?.getModel();
    return model ? renderMarkdown(model.getValue()) : "";
  }, [isPreview, active, previewNonce]);

  // 预览或差异视图下 Monaco 容器是 hidden 的、量不到尺寸，切回可见得补一次 layout，
  // 否则行号栏宽度和滚动位置还是按 0 尺寸算出来的
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      editorRef.current?.layout();
      diffRef.current?.layout();
    });
    return () => cancelAnimationFrame(frame);
  }, [isPreview, isDiffTab, isImageTab]);

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

  const activeDirty = activeKey !== null && dirtyPaths.has(activeKey);
  const overlay: Status = isDiffTab ? diffStatus : status;

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <div
          ref={tabsScrollRef}
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.length === 0 && (
            <span className="px-1 text-[11px] text-fg-faint">未打开文件</span>
          )}
          {tabs.map((tab) => {
            const key = tabKey(tab);
            const isActive = active !== null && tabKey(active) === key;
            const isDirty = dirtyPaths.has(key);
            const mark = gitMarks.get(pathKey(tab.path));
            const suffix = tabSuffix(tab);
            return (
              <div
                key={key}
                data-tab-active={isActive ? "" : undefined}
                className={`flex shrink-0 items-center rounded ${
                  isActive ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
                }`}
              >
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
            {saving ? "保存中…" : "保存 Ctrl+S"}
          </button>
        )}
        {/* 右边栏整体的全屏开关，三个模块共用这一个位置（浏览器模块时这一列是浏览器自己） */}
        <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className={isPreview || isDiffTab || isImageTab ? "hidden" : "absolute inset-0"}
        />
        <div
          ref={diffContainerRef}
          className={isDiffTab ? "absolute inset-0" : "hidden"}
        />

        {isPreview && <MarkdownPreview html={previewHtml} />}

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
    </section>
  );
}
