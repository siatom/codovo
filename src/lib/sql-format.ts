// SQL 美化：交给 sql-formatter（零依赖，按方言词法解析后重排空白）。
//
// 这里只放纯函数——Monaco 侧的接线在 DatabaseQuery 里，因为只有那儿拿得到当前连接的类型
// （方言要按库选）。纯函数不依赖编辑器，方便单测 / 复用。

import { format } from "sql-formatter";

import type { DbKind } from "./database";

/** 三个库各自对应的 sql-formatter 方言名（其余方言用不到，不做透传） */
const DIALECT: Record<DbKind, "mysql" | "postgresql" | "sqlite"> = {
  mysql: "mysql",
  postgres: "postgresql",
  sqlite: "sqlite",
};

/**
 * 按库的方言重排 SQL：关键字统一大写、缩进跟随编辑器设置。
 * 语句有语法错误时 sql-formatter 会抛错，由调用方兜住提示。
 */
export function formatSql(sql: string, kind: DbKind, tabSize: number): string {
  return format(sql, {
    language: DIALECT[kind],
    keywordCase: "upper",
    tabWidth: tabSize,
    useTabs: false,
    // 多条语句之间空一行，跟常见客户端的风格一致
    linesBetweenQueries: 1,
  });
}
