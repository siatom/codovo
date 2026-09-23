import { useCallback, useEffect, useRef, useState } from "react";
import { monaco, DARK_THEME, LIGHT_THEME } from "../lib/monaco-setup";
import { languageOf } from "../lib/languages";
import { pathKey, readFile, toDisplayPath, writeFile } from "../lib/fs";
import type { GitMark } from "../lib/git";
import { useSettings, resolveFont } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { GitMarkBadge } from "./GitMarkBadge";

interface EditorPaneProps {
  /** 已打开的文件，按打开顺序 */
  paths: string[];
  /** 当前显示的那个 */
  active: string | null;
  /** 归一化路径 -> git 标记 */
  gitMarks: ReadonlyMap<string, GitMark>;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

interface CachedModel {
  model: monaco.editor.ITextModel;
  savedVersionId: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "binary" }
  | { kind: "tooLarge" }
  | { kind: "error"; message: string };

function baseName(path: string): string {
  return toDisplayPath(path).split("/").pop() ?? path;
}

export function EditorPane({ paths, active, gitMarks, onActivate, onClose }: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, CachedModel>());
  const activeRef = useRef<string | null>(active);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
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

  // 只重算当前文件的脏标记：别的标签的 model 没在编辑器里，比较不了版本号
  const syncDirty = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    const cached = modelsRef.current.get(current);
    const model = editorRef.current?.getModel();
    const isDirty = Boolean(
      cached && model && model.getAlternativeVersionId() !== cached.savedVersionId,
    );
    setDirtyPaths((prev) => {
      if (prev.has(current) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(current);
      else next.delete(current);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    const current = activeRef.current;
    const model = editorRef.current?.getModel();
    if (!current || !model) return;
    setSaving(true);
    try {
      await writeFile(current, model.getValue());
      const cached = modelsRef.current.get(current);
      if (cached) cached.savedVersionId = model.getAlternativeVersionId();
      setDirtyPaths((prev) => {
        if (!prev.has(current)) return prev;
        const next = new Set(prev);
        next.delete(current);
        return next;
      });
    } catch (reason) {
      setStatus({ kind: "error", message: `保存失败：${reason}` });
    } finally {
      setSaving(false);
    }
  }, []);

  const saveRef = useRef(save);
  saveRef.current = save;

  // editor 只建一次，切文件时换 model
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
    };
  }, [syncDirty]);

  // 切主题不重建 editor，只换配色
  useEffect(() => {
    monaco.editor.setTheme(theme === "light" ? LIGHT_THEME : DARK_THEME);
  }, [theme]);

  // 字体/字号同理。换字体后要让 Monaco 重新量一遍字宽，否则列宽还是旧字体的
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: resolveFont(settings.editorFontFamily),
      fontSize: settings.editorFontSize,
    });
    monaco.editor.remeasureFonts();
  }, [settings.editorFontFamily, settings.editorFontSize]);

  // 切文件
  useEffect(() => {
    activeRef.current = active;
    const editor = editorRef.current;

    if (!active || !editor) {
      editor?.setModel(null);
      setStatus({ kind: "idle" });
      return;
    }

    const cached = modelsRef.current.get(active);
    if (cached) {
      editor.setModel(cached.model);
      setStatus({ kind: "ready" });
      syncDirty();
      return;
    }

    let cancelled = false;
    setStatus({ kind: "loading" });
    editor.setModel(null);

    void readFile(active)
      .then((content) => {
        if (cancelled || activeRef.current !== active) return;
        if (content.tooLarge) {
          setStatus({ kind: "tooLarge" });
          return;
        }
        if (content.isBinary) {
          setStatus({ kind: "binary" });
          return;
        }
        const uri = monaco.Uri.file(active);
        const model =
          monaco.editor.getModel(uri) ??
          monaco.editor.createModel(content.text, languageOf(active), uri);
        modelsRef.current.set(active, {
          model,
          savedVersionId: model.getAlternativeVersionId(),
        });
        editor.setModel(model);
        setStatus({ kind: "ready" });
        syncDirty();
      })
      .catch((reason) => {
        if (cancelled || activeRef.current !== active) return;
        setStatus({ kind: "error", message: String(reason) });
      });

    return () => {
      cancelled = true;
    };
  }, [active, syncDirty]);

  const closeTab = useCallback(
    (path: string) => {
      if (
        dirtyPaths.has(path) &&
        !window.confirm(`${baseName(path)} 有未保存的改动，确定关闭吗？`)
      ) {
        return;
      }

      const cached = modelsRef.current.get(path);
      if (cached) {
        modelsRef.current.delete(path);
        // Monaco 不允许 dispose 正在编辑的 model，先把编辑器摘下来
        if (editorRef.current?.getModel() === cached.model) {
          editorRef.current.setModel(null);
        }
        cached.model.dispose();
      }

      setDirtyPaths((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });

      onClose(path);
    },
    [dirtyPaths, onClose],
  );

  const activeDirty = active ? dirtyPaths.has(active) : false;

  return (
    <section className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {paths.length === 0 && (
            <span className="px-1 text-[11px] text-fg-faint">未打开文件</span>
          )}
          {paths.map((path) => {
            const isActive = path === active;
            const isDirty = dirtyPaths.has(path);
            const mark = gitMarks.get(pathKey(path));
            return (
              <div
                key={path}
                className={`flex shrink-0 items-center rounded ${
                  isActive ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onActivate(path)}
                  title={toDisplayPath(path)}
                  className="max-w-[160px] truncate py-0.5 pl-2 text-[11px]"
                >
                  {baseName(path)}
                  {/* 未保存的改动比 git 状态更要紧，两者只占同一个位置 */}
                  {isDirty ? (
                    <span className="ml-1 text-warn" title="有未保存的改动">
                      ●
                    </span>
                  ) : (
                    mark && <GitMarkBadge mark={mark} className="ml-1 text-[10px]" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(path)}
                  title="关闭这个文件"
                  className="px-1.5 py-0.5 text-[12px] leading-none text-fg-faint hover:text-danger"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {activeDirty && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="shrink-0 rounded border border-accent-line px-2 py-0.5 text-[11px] text-accent-soft hover:bg-active disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存 Ctrl+S"}
          </button>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {status.kind !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface px-6 text-center">
            {status.kind === "idle" && (
              <p className="text-[12px] text-fg-faint">从左侧文件树选一个文件</p>
            )}
            {status.kind === "loading" && (
              <p className="text-[12px] text-fg-faint">加载中…</p>
            )}
            {status.kind === "binary" && (
              <p className="text-[12px] text-warn">二进制文件，无法以文本方式编辑</p>
            )}
            {status.kind === "tooLarge" && (
              <p className="text-[12px] text-warn">文件超过 2MB，已跳过加载</p>
            )}
            {status.kind === "error" && (
              <p className="text-[12px] text-danger">{status.message}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
