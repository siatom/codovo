import { useCallback, useEffect, useRef, useState } from "react";
import { dbQuery, type QueryResult } from "../lib/database";
import { monaco, monacoThemeFor } from "../lib/monaco-setup";
import { resolveFont, useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { ResultGrid } from "./ResultGrid";

const PAGE_SIZE = 50;

/** 编辑器区默认高度（占整个查询页的百分比），拖分隔条可改 */
const DEFAULT_EDITOR_PERCENT = 40;

/** 查询页：Monaco SQL 编辑器 + 结果表格，中间一条可拖的横向分隔条。 */
export function DatabaseQuery({ sessionId }: { sessionId: number }) {
  const { theme, palette } = useTheme();
  const { settings } = useSettings();

  const paneRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const draggingRef = useRef(false);

  const [editorPercent, setEditorPercent] = useState(DEFAULT_EDITOR_PERCENT);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastSql, setLastSql] = useState("");

  const readSql = () => editorRef.current?.getValue().trim() ?? "";

  const run = useCallback(
    async (page: number) => {
      const sql = readSql();
      if (!sql) {
        setError("请输入 SQL");
        setResult(null);
        return;
      }
      setLoading(true);
      setError("");
      try {
        setResult(await dbQuery(sessionId, sql, page, PAGE_SIZE));
        setLastSql(sql);
      } catch (reason) {
        setError(String(reason));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  // 编辑器里的 Ctrl/Cmd+Enter 要能触发运行，但它只挂一次、闭包会读到旧的 sessionId，用 ref 兜
  const runRef = useRef(run);
  runRef.current = run;

  /** 翻页用上次跑过的 SQL，不读编辑器——免得翻页时把用户正在改的语句也带上 */
  const loadPage = useCallback(
    async (page: number) => {
      if (!lastSql) return;
      setLoading(true);
      setError("");
      try {
        setResult(await dbQuery(sessionId, lastSql, page, PAGE_SIZE));
      } catch (reason) {
        setError(String(reason));
      } finally {
        setLoading(false);
      }
    },
    [sessionId, lastSql],
  );

  // 编辑器只建一次
  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      tabSize: 2,
      padding: { top: 8 },
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void runRef.current(0);
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // 主题跟随界面
  useEffect(() => {
    monaco.editor.setTheme(monacoThemeFor(palette, theme));
  }, [palette, theme]);

  // 字体跟随编辑器设置（放在单独的 effect 里，编辑器本身不因字体变化重建）
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: settings.editorFontSize,
      fontFamily: resolveFont(settings.editorFontFamily),
      fontWeight: settings.editorFontBold ? "bold" : "normal",
    });
  }, [settings.editorFontSize, settings.editorFontFamily, settings.editorFontBold]);

  // 换连接时清掉上一份结果（SQL 文本留着，方便换库重跑）
  useEffect(() => {
    setResult(null);
    setError("");
    setLastSql("");
  }, [sessionId]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    document.body.classList.add("codedock-dragging");
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const rect = paneRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    const percent = ((event.clientY - rect.top) / rect.height) * 100;
    setEditorPercent(Math.min(85, Math.max(10, percent)));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingRef.current = false;
    document.body.classList.remove("codedock-dragging");
  };

  return (
    <div ref={paneRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => void run(0)}
          className="rounded-md border border-accent px-2.5 py-0.5 text-[11px] text-accent hover:bg-selected disabled:opacity-60"
        >
          运行
        </button>
        <span className="text-[11px] text-fg-faint">Ctrl / Cmd + Enter</span>
        <span className="flex-1" />
        {loading && <span className="text-[11px] text-fg-dim">执行中…</span>}
      </div>

      <div
        className="min-h-0 shrink-0 overflow-hidden"
        style={{ flexBasis: `${editorPercent}%`, flexGrow: 0, flexShrink: 0 }}
      >
        <div ref={editorHostRef} className="h-full w-full" />
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative h-px shrink-0 cursor-row-resize bg-line-strong hover:bg-line-hover"
      >
        {/* 加宽命中区，视觉上仍是一条细线 */}
        <span className="absolute inset-x-0 -top-1 -bottom-1" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <ResultGrid
          result={result}
          loading={loading}
          error={error}
          onPage={(page) => void loadPage(page)}
          hint="写一条 SQL，按「运行」或 Ctrl/Cmd + Enter 执行。"
        />
      </div>
    </div>
  );
}
