import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
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

/** 右键菜单：宽度按最长一项量，高度按项数算，用来贴着窗口边缘收一收 */
const MENU_W = 132;
/** 一项 24px 上下内边距 + 文字，再加上容器自己的 py-1 */
const MENU_ITEM_H = 24;
const MENU_PAD = 8;
const MENU_H = MENU_ITEM_H * 2 + MENU_PAD;
const MENU_ITEM = "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

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
  /** 右键菜单：位置 + 被点单元格的值与整行文本（NULL 统一按空串处理） */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    cell: string;
    row: string;
  } | null>(null);

  // 菜单开着时，任何滚动都把它收起来：列表是 overflow-auto，滚动后菜单会浮在原地
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [menu]);

  /** 写系统剪贴板。走插件而不是 navigator.clipboard：WebView2 会弹系统授权框 */
  const copy = async (text: string) => {
    setMenu(null);
    // 表格没有报错位，复制失败就静默忽略
    await writeText(text).catch(() => {});
  };

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
                    <td
                      key={cellIndex}
                      className={TD}
                      onContextMenu={(event) => {
                        // 应用全局屏蔽了原生右键菜单，这里自己声明一个（见 main.tsx）
                        event.preventDefault();
                        setMenu({
                          x: event.clientX,
                          y: event.clientY,
                          cell: cell ?? "",
                          // 整行按 Tab 分隔：粘进表格软件正好一列一格
                          row: row.map((value) => value ?? "").join("\t"),
                        });
                      }}
                    >
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

      {/* 单元格右键菜单。fixed 定位：表格在 overflow-auto 里，绝对定位会被裁掉 */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: MENU_W,
              left: Math.min(menu.x, window.innerWidth - MENU_W - 4),
              top: Math.min(menu.y, window.innerHeight - MENU_H - 4),
            }}
          >
            <button type="button" onClick={() => void copy(menu.cell)} className={MENU_ITEM}>
              复制单元格
            </button>
            <button type="button" onClick={() => void copy(menu.row)} className={MENU_ITEM}>
              复制整行
            </button>
          </div>
        </>
      )}
    </div>
  );
}
