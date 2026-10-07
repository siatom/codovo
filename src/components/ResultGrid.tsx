import type { QueryResult } from "../lib/database";

interface ResultGridProps {
  result: QueryResult | null;
  loading: boolean;
  error: string;
  /** 翻到某一页（0 基） */
  onPage: (page: number) => void;
  /** 还没有结果时的提示 */
  hint: string;
}

const PAGE_BUTTON =
  "rounded border border-line-strong px-2 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";

const TH =
  "sticky top-0 z-10 border-b border-line-strong bg-panel px-2 py-1 text-left font-medium text-fg-dim whitespace-nowrap";
const TD = "border-b border-line px-2 py-1 align-top";

function Centered({ children }: { children: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
        {children}
      </p>
    </div>
  );
}

/**
 * 查询结果的表格：表头吸顶、横向滚动、NULL 灰显、底部翻页。
 * 表页（点表看数据）和查询页共用，所以结果与翻页都从外面传进来。
 */
export function ResultGrid({ result, loading, error, onPage, hint }: ResultGridProps) {
  if (error) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <p className="whitespace-pre-wrap break-all text-[12px] leading-relaxed text-danger">
          {error}
        </p>
      </div>
    );
  }
  if (!result) {
    return <Centered>{loading ? "查询中…" : hint}</Centered>;
  }
  if (result.kind === "affected") {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <p className="text-[12px] text-fg-muted">
          影响 {result.affected} 行 · {result.elapsedMs} ms
        </p>
      </div>
    );
  }

  // 有列名就画表头（空表也要能看到字段名，后端为此专门 prepare 了一次）
  const showTable = result.columns.length > 0 || result.rows.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {!showTable ? (
          <p className="px-3 py-3 text-[12px] text-fg-faint">
            {loading ? "查询中…" : "0 行"}
          </p>
        ) : (
          <table className="w-max min-w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <th className={`${TH} w-10 text-right text-fg-faint`}>#</th>
                {result.columns.map((column, index) => (
                  <th key={index} className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-hover">
                  <td className={`${TD} text-right text-fg-faint tabular-nums`}>
                    {result.page * result.pageSize + rowIndex + 1}
                  </td>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className={TD}>
                      {cell === null ? (
                        <span className="text-fg-faint italic">NULL</span>
                      ) : (
                        <span
                          className="block max-w-[360px] truncate text-fg"
                          title={cell}
                        >
                          {cell}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td
                    colSpan={result.columns.length + 1}
                    className="px-3 py-3 text-[12px] text-fg-faint"
                  >
                    {loading ? "查询中…" : "0 行"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-2 text-[11px] text-fg-dim">
        <span className="tabular-nums">
          第 {result.page + 1} 页 · {result.rows.length} 行 · {result.elapsedMs} ms
          {result.hasMore ? "" : " · 已到末页"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          disabled={result.page === 0 || loading}
          onClick={() => onPage(result.page - 1)}
          className={PAGE_BUTTON}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={!result.hasMore || loading}
          onClick={() => onPage(result.page + 1)}
          className={PAGE_BUTTON}
        >
          下一页
        </button>
      </footer>
    </div>
  );
}
