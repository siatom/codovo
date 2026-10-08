import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  dbTableStructure,
  type TableInfo,
  type TableStructure as TableStructureData,
} from "../lib/database";

const TH =
  "border-b border-line-strong px-2 py-1 text-left font-medium text-fg-dim whitespace-nowrap";
const TD = "border-b border-line px-2 py-1 align-top text-fg";
/** 空值统一画一条短横线，别留白（否则分不清「没有」和「没加载出来」） */
const EMPTY = <span className="text-fg-faint">—</span>;

function Centered({ children }: { children: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
        {children}
      </p>
    </div>
  );
}

/** 一块结构（列 / 索引 / 外键 / DDL）：标题条 + 内容，纵向依次堆叠 */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="shrink-0 border-b border-line">
      <div className="flex items-baseline gap-2 px-2 pt-2 pb-1">
        <span className="text-[11px] font-medium tracking-wide text-fg-dim">{title}</span>
        {hint && <span className="text-[10px] text-fg-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ text = "无" }: { text?: string }) {
  return <p className="px-2 pb-2 text-[11px] text-fg-faint">{text}</p>;
}

const yesNo = (value: boolean) => (value ? "是" : "否");

/**
 * 表结构视图（右侧「表格」子视图里的「结构」页）：列 / 索引 / 外键 / 建表 DDL。
 * 只在选中一张表后可用；没选中时给一句提示，不报错。
 */
export function TableStructure({
  sessionId,
  table,
}: {
  /** 当前会话 id；没建好会话时为 null */
  sessionId: number | null;
  /** 选中的表；没选就是 null */
  table: TableInfo | null;
}) {
  const [structure, setStructure] = useState<TableStructureData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const tableName = table?.name ?? "";
  const schema = table?.schema;

  useEffect(() => {
    if (sessionId === null || !table) {
      setStructure(null);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    dbTableStructure(sessionId, schema, tableName)
      .then((data) => {
        if (!cancelled) setStructure(data);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
          setStructure(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // schema / tableName 都来自 table，直接依赖它即可
  }, [sessionId, schema, tableName, table]);

  if (!table) return <Centered>从左侧选中一张表后再看结构。</Centered>;
  if (sessionId === null) return <Centered>{loading ? "加载中…" : "连接尚未就绪。"}</Centered>;
  if (error) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <p className="whitespace-pre-wrap break-all text-[12px] leading-relaxed text-danger">
          {error}
        </p>
      </div>
    );
  }
  if (!structure) return <Centered>{loading ? "加载中…" : "暂无结构信息。"}</Centered>;

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-2">
      <Section title="列">
        {structure.columns.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-max min-w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <th className={TH}>列名</th>
                <th className={TH}>类型</th>
                <th className={TH}>可空</th>
                <th className={TH}>默认值</th>
                <th className={TH}>主键</th>
                <th className={TH}>注释</th>
              </tr>
            </thead>
            <tbody>
              {structure.columns.map((column, index) => (
                <tr key={index} className="hover:bg-hover">
                  <td className={TD}>{column.name}</td>
                  <td className={TD}>{column.dataType}</td>
                  <td className={TD}>{yesNo(column.nullable)}</td>
                  <td className={TD}>
                    {column.default === null ? EMPTY : <code>{column.default}</code>}
                  </td>
                  <td className={TD}>{yesNo(column.primaryKey)}</td>
                  <td className={`${TD} max-w-[280px]`}>
                    {column.comment === null ? EMPTY : column.comment}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="索引">
        {structure.indexes.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-max min-w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <th className={TH}>索引名</th>
                <th className={TH}>列</th>
                <th className={TH}>唯一</th>
                <th className={TH}>主键</th>
              </tr>
            </thead>
            <tbody>
              {structure.indexes.map((idx, index) => (
                <tr key={index} className="hover:bg-hover">
                  <td className={TD}>{idx.name}</td>
                  <td className={TD}>{idx.columns.join(", ")}</td>
                  <td className={TD}>{yesNo(idx.unique)}</td>
                  <td className={TD}>{yesNo(idx.primary)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="外键">
        {structure.foreignKeys.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-max min-w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <th className={TH}>约束名</th>
                <th className={TH}>本表列</th>
                <th className={TH}>引用</th>
              </tr>
            </thead>
            <tbody>
              {structure.foreignKeys.map((fk, index) => (
                <tr key={index} className="hover:bg-hover">
                  <td className={TD}>{fk.name === "" ? EMPTY : fk.name}</td>
                  <td className={TD}>{fk.columns.join(", ")}</td>
                  <td className={TD}>
                    {fk.refTable} ({fk.refColumns.join(", ")})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="建表 DDL" hint={structure.ddlApproximate ? "（由元数据尽力拼出）" : undefined}>
        {structure.ddl === null ? (
          <Empty text="没有可用的 DDL。" />
        ) : (
          <div className="px-2 pb-2">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void writeText(structure.ddl ?? "").catch(() => {})}
                className="rounded border border-line-strong px-2 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
              >
                复制
              </button>
            </div>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded border border-line bg-surface p-2 text-[11px] leading-relaxed text-fg">
              {structure.ddl}
            </pre>
          </div>
        )}
      </Section>
    </div>
  );
}
