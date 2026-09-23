import { pathKey } from "./fs";

/**
 * 编辑器里一个标签。
 *
 * 不能只拿文件路径当标签的身份：同一个文件可能既被当普通文件打开、又被当差异
 * 视图打开，差异视图里暂存和未暂存两组又是两条不同的记录。所以做成结构化的。
 */
export type Tab =
  | { kind: "file"; path: string }
  | { kind: "diff"; path: string; staged: boolean };

/** Map/Set 的键。路径里不可能出现 \u0000，拿它当分隔符是安全的。 */
const SEP = "\u0000";

export function tabKey(tab: Tab): string {
  const path = pathKey(tab.path);
  return tab.kind === "file" ? `f${SEP}${path}` : `d${SEP}${tab.staged ? "1" : "0"}${SEP}${path}`;
}

export function sameTab(a: Tab, b: Tab): boolean {
  return tabKey(a) === tabKey(b);
}

/**
 * 标签标题后面的淡色说明。「文件」标签为空，差异标签给出跟谁比——
 * 同一个文件的两个差异标签也靠它区分。
 */
export function tabSuffix(tab: Tab): string {
  if (tab.kind === "file") return "";
  return tab.staged ? "↔ HEAD" : "↔ index";
}
