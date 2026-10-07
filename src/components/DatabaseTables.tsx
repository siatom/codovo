import { useCallback, useEffect, useState } from "react";
import {
  dbQuery,
  dbTables,
  selectAllSql,
  type DbKind,
  type QueryResult,
  type TableInfo,
} from "../lib/database";
import { ResultGrid } from "./ResultGrid";
import { IconRefresh } from "./icons";

const PAGE_SIZE = 50;

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

/** 表页：左侧表 / 视图列表，右侧点开某张表看数据（服务端翻页）。 */
export function DatabaseTables({ sessionId, kind }: { sessionId: number; kind: DbKind }) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [tablesError, setTablesError] = useState("");
  const [selected, setSelected] = useState<TableInfo | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState("");

  const loadTables = useCallback(async () => {
    setLoadingTables(true);
    setTablesError("");
    try {
      setTables(await dbTables(sessionId));
    } catch (reason) {
      setTablesError(String(reason));
      setTables([]);
    } finally {
      setLoadingTables(false);
    }
  }, [sessionId]);

  // 换连接（sessionId 变）时清掉上一份选择，重新拉表
  useEffect(() => {
    setSelected(null);
    setResult(null);
    setQueryError("");
    void loadTables();
  }, [loadTables]);

  const loadPage = useCallback(
    async (table: TableInfo, page: number) => {
      setLoading(true);
      setQueryError("");
      try {
        setResult(await dbQuery(sessionId, selectAllSql(kind, table), page, PAGE_SIZE));
      } catch (reason) {
        setQueryError(String(reason));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [sessionId, kind],
  );

  const openTable = (table: TableInfo) => {
    setSelected(table);
    void loadPage(table, 0);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* 左窄栏：表 / 视图列表 */}
      <div className="flex h-full w-44 shrink-0 flex-col border-r border-line">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim">
            表 / 视图
          </span>
          <button
            type="button"
            onClick={() => void loadTables()}
            disabled={loadingTables}
            title="刷新列表"
            className={HEAD_BUTTON}
          >
            <IconRefresh className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {tablesError ? (
            <p className="px-3 py-2 text-[11px] leading-relaxed text-danger">{tablesError}</p>
          ) : tables.length === 0 ? (
            <p className="px-3 py-2 text-[11px] leading-relaxed text-fg-faint">
              {loadingTables ? "加载中…" : "没有表或视图。"}
            </p>
          ) : (
            tables.map((table) => {
              const isActive =
                selected?.name === table.name && selected?.schema === table.schema;
              return (
                <button
                  key={`${table.schema}.${table.name}`}
                  type="button"
                  onClick={() => openTable(table)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${
                    isActive ? "bg-selected" : "hover:bg-hover"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-fg">{table.name}</span>
                    <span className="block truncate text-[10px] text-fg-faint">
                      {table.kind === "view" ? "视图" : table.schema}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* 右侧：选中表的数据 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ResultGrid
          result={result}
          loading={loading}
          error={queryError}
          onPage={(page) => selected && void loadPage(selected, page)}
          hint="从左侧选一张表，看它的数据。"
        />
      </div>
    </div>
  );
}
