import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { monaco, DARK_THEME, LIGHT_THEME } from "../lib/monaco-setup";
import { languageOf } from "../lib/languages";
import { renderMarkdown } from "../lib/markdown";
import { gitFileDiff, pathKey, readFile, toDisplayPath, writeFile } from "../lib/fs";
import type { GitMark } from "../lib/git";
import { useSettings, resolveFont } from "../lib/settings";
import { tabKey, tabSuffix, type Tab } from "../lib/tabs";
import { useTheme } from "../lib/theme";
import { GitMarkBadge } from "./GitMarkBadge";
import { MarkdownPreview } from "./MarkdownPreview";
import { IconEye, IconPencil } from "./icons";

interface EditorPaneProps {
  /** 已打开的标签，按打开顺序 */
  tabs: Tab[];
  /** 当前显示的那个 */
  active: Tab | null;
  /** 归一化路径 -> git 标记 */
  gitMarks: ReadonlyMap<string, GitMark>;
  onActivate: (tab: Tab) => void;
  onClose: (tab: Tab) => void;
}

interface CachedModel {
  /** 落盘要用，Map 的键是 tabKey 不是路径 */
  path: string;
  model: monaco.editor.ITextModel;
  savedVersionId: number;
}

/** 一个差异标签的一对 model，销毁时必须一起走 */
interface CachedDiff {
  original: monaco.editor.ITextModel;
  modified: monaco.editor.ITextModel;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "binary" }
  | { kind: "tooLarge" }
  | { kind: "emptyDiff" }
  | { kind: "error"; message: string };

function baseName(path: string): string {
  return toDisplayPath(path).split("/").pop() ?? path;
}

/**
 * 差异标签的 model URI 必须和普通文件的 `file://` 分开，否则同一个路径两个
 * model 会撞在一起（同一个文件既可能被当文件打开、又被当差异打开）。
 */
function diffUri(tab: Tab, side: "original" | "modified"): monaco.Uri {
  const staged = tab.kind === "diff" && tab.staged ? "staged" : "unstaged";
  return monaco.Uri.parse(
    `codedock-diff:/${staged}/${encodeURIComponent(pathKey(tab.path))}/${side}`,
  );
}

export function EditorPane({ tabs, active, gitMarks, onActivate, onClose }: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, CachedModel>());

  // 差异视图：另一套编辑器 + 另一套 model，和上面那套彻底分开——
  // 这样"只读"就是结构性保证，persist 根本看不到它
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const diffModelsRef = useRef(new Map<string, CachedDiff>());

  const activeRef = useRef<Tab | null>(active);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [diffStatus, setDiffStatus] = useState<Status>({ kind: "idle" });
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  /** 正处在预览模式的 markdown 标签（存 tabKey）；不在集合里就是编辑模式 */
  const [previewPaths, setPreviewPaths] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const { theme } = useTheme();
  const { settings } = useSettings();

  // 建 editor 的 effect 只认挂载那一刻的主题，切换主题走下面的 effect 单独更新
  const themeRef = useRef(theme);
  themeRef.current = theme;
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
   * 把有未保存改动的文件写回磁盘；传 only（tabKey）就只存那一个。
   * 自动保存走"存全部"——别的标签切走后也可能留着没保存的 model。
   * 差异标签的 model 在另一个 Map 里，这里永远碰不到。
   */
  const persist = useCallback(async (only?: string) => {
    const targets = [...modelsRef.current.entries()].filter(
      ([key, cached]) =>
        (!only || key === only) &&
        cached.model.getAlternativeVersionId() !== cached.savedVersionId,
    );
    if (targets.length === 0) return;

    setSaving(true);
    const saved = new Set<string>();
    try {
      for (const [key, cached] of targets) {
        await writeFile(cached.path, cached.model.getValue());
        cached.savedVersionId = cached.model.getAlternativeVersionId();
        saved.add(key);
      }
    } catch (reason) {
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
  }, []);

  const showDiff = useCallback(
    async (tab: Extract<Tab, { kind: "diff" }>) => {
      const key = tabKey(tab);
      const cached = diffModelsRef.current.get(key);
      if (cached) {
        ensureDiffEditor();
        diffRef.current?.setModel(cached);
        setDiffStatus({ kind: "ready" });
        return;
      }

      setDiffStatus({ kind: "loading" });
      diffRef.current?.setModel(null);

      let payload;
      try {
        payload = await gitFileDiff(tab.path, tab.staged);
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
    },
    [ensureDiffEditor],
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
  }, [syncDirty]);

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

      const cached = modelsRef.current.get(key);
      if (cached) {
        modelsRef.current.delete(key);
        // Monaco 不允许 dispose 正在编辑的 model，先把编辑器摘下来
        if (editorRef.current?.getModel() === cached.model) {
          editorRef.current.setModel(null);
        }
        cached.model.dispose();
      }

      const pair = diffModelsRef.current.get(key);
      if (pair) {
        diffModelsRef.current.delete(key);
        const showing = diffRef.current?.getModel();
        if (showing && (showing.original === pair.original || showing.modified === pair.modified)) {
          diffRef.current?.setModel(null);
        }
        // 成对的 model 要一起销毁
        pair.original.dispose();
        pair.modified.dispose();
      }

      setDirtyPaths((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });

      // 关掉的标签不该在预览集合里留下名字
      setPreviewPaths((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });

      onClose(tab);
    },
    [dirtyPaths, onClose],
  );

  const isDiffTab = active?.kind === "diff";
  const activeKey = active ? tabKey(active) : null;

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
  }, [isPreview, active]);

  // 预览或差异视图下 Monaco 容器是 hidden 的、量不到尺寸，切回可见得补一次 layout，
  // 否则行号栏宽度和滚动位置还是按 0 尺寸算出来的
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      editorRef.current?.layout();
      diffRef.current?.layout();
    });
    return () => cancelAnimationFrame(frame);
  }, [isPreview, isDiffTab]);

  const activeDirty = activeKey !== null && dirtyPaths.has(activeKey);
  const overlay: Status = isDiffTab ? diffStatus : status;

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
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
                className={`flex shrink-0 items-center rounded ${
                  isActive ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onActivate(tab)}
                  title={
                    tab.kind === "file"
                      ? toDisplayPath(tab.path)
                      : `${toDisplayPath(tab.path)}（差异：与 ${tab.staged ? "HEAD" : "index"} 比较）`
                  }
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
                  className="px-1.5 py-0.5 text-[12px] leading-none text-fg-faint hover:text-danger"
                >
                  ×
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
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className={isPreview || isDiffTab ? "hidden" : "absolute inset-0"}
        />
        <div
          ref={diffContainerRef}
          className={isDiffTab ? "absolute inset-0" : "hidden"}
        />

        {isPreview && <MarkdownPreview html={previewHtml} />}

        {overlay.kind !== "ready" && (
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
                {isDiffTab ? "文件超过 2MB，已跳过差异加载" : "文件超过 2MB，已跳过加载"}
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
    </section>
  );
}
