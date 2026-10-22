import { useCallback, useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  dbExport,
  dbQuery,
  defaultExportName,
  type DbExportFormat,
  type DbExportScope,
  type DbKind,
  type QueryResult,
} from "../lib/database";
import { monaco, monacoThemeFor } from "../lib/monaco-setup";
import { resolveFont, useSettings } from "../lib/settings";
import { formatSql } from "../lib/sql-format";
import { useTheme } from "../lib/theme";
import { ResultGrid } from "./ResultGrid";

const PAGE_SIZE = 50;

/** 编辑器区默认高度（占整个查询页的百分比），拖分隔条可改 */
const DEFAULT_EDITOR_PERCENT = 40;

/** 查询页：Monaco SQL 编辑器 + 结果表格，中间一条可拖的横向分隔条。 */
export function DatabaseQuery({ sessionId, kind }: { sessionId: number; kind: DbKind }) {
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
  /** 美化失败（多半是语句还没写完）的提示，和查询错误分开——它不该顶掉结果区 */
  const [formatError, setFormatError] = useState("");
  const [lastSql, setLastSql] = useState("");
  const [exporting, setExporting] = useState(false);
  /** 导出结果提示（成功行数 / 失败原因），和查询、美化错误分开 */
  const [exportNotice, setExportNotice] = useState<{ ok: boolean; text: string } | null>(null);

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
      setExportNotice(null);
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

  /** 一键美化：按当前连接的方言重排全文；语句没写完时 sql-formatter 会抛错，只提示不阻断编辑 */
  const beautify = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const before = model.getValue();
    if (!before.trim()) return;
    let after: string;
    try {
      after = formatSql(before, kind, model.getOptions().tabSize);
    } catch (reason) {
      setFormatError(String(reason));
      return;
    }
    setFormatError("");
    if (after === before) return;
    // 走 executeEdits 而不是 setValue：进撤销栈，一次 Ctrl+Z 就能回到美化前
    editor.executeEdits("codovo.beautifySql", [
      { range: model.getFullModelRange(), text: after, forceMoveMarkers: true },
    ]);
    editor.pushUndoStop();
  }, [kind]);

  // 同上：快捷键 / 按钮的闭包只挂一次，用 ref 兜住最新的 kind
  const beautifyRef = useRef(beautify);
  beautifyRef.current = beautify;

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

  /**
   * 导出结果：用系统保存对话框选路径，再让后端取数 + 写盘。
   * 导出用的 SQL 取「上次运行的语句（lastSql）」而不是编辑器当前内容——结果区显示的就是它，
   * 导出的内容要和眼前所见一致。翻页交给后端按 page/pageSize 重跑。
   */
  const handleExport = async (format: DbExportFormat, scope: DbExportScope) => {
    if (!lastSql || !result || result.kind !== "rows") {
      setExportNotice({ ok: false, text: "先运行一条查询再导出" });
      return;
    }
    setExporting(true);
    setExportNotice(null);
    try {
      const path = await save({
        title: "导出查询结果",
        defaultPath: defaultExportName("query", format),
        filters: [{ name: format === "csv" ? "CSV 文件" : "Excel 工作簿", extensions: [format] }],
      });
      if (!path) return; // 用户取消
      const out = await dbExport({
        id: sessionId,
        sql: lastSql,
        format,
        path,
        scope,
        page: result.page,
        pageSize: result.pageSize,
        title: "query",
      });
      setExportNotice({
        ok: true,
        text: `已导出 ${out.rows} 行${out.truncated ? "（超过上限，已截断）" : ""}`,
      });
    } catch (reason) {
      setExportNotice({ ok: false, text: String(reason) });
    } finally {
      setExporting(false);
    }
  };

  // 编辑器只建一次
  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      language: "sql",
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
    // Shift+Alt+F 是 Monaco / VS Code 的格式化键位，这里绑到自己的美化上
    editor.addAction({
      id: "codovo.beautifySql",
      label: "美化 SQL",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      run: () => beautifyRef.current(),
    });
    // 用户一开始改代码就把上次的美化报错收掉，免得一直挂在工具栏上误导
    editor.onDidChangeModelContent(() => setFormatError(""));
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
    setFormatError("");
    setLastSql("");
  }, [sessionId]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    document.body.classList.add("codovo-dragging");
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
    document.body.classList.remove("codovo-dragging");
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
        <button
          type="button"
          onClick={beautify}
          title="美化 SQL（Shift + Alt + F）"
          className="rounded-md border border-line-strong px-2.5 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          美化
        </button>
        <span className="flex-1" />
        {formatError && (
          <span
            className="min-w-0 max-w-[45%] truncate text-[11px] text-danger"
            title={formatError}
          >
            美化失败：{formatError}
          </span>
        )}
        {exportNotice && (
          <span
            className={`min-w-0 max-w-[45%] truncate text-[11px] ${
              exportNotice.ok ? "text-accent" : "text-danger"
            }`}
            title={exportNotice.text}
          >
            {exportNotice.text}
          </span>
        )}
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
          onExport={result?.kind === "rows" ? handleExport : undefined}
          exportBusy={exporting}
        />
      </div>
    </div>
  );
}
