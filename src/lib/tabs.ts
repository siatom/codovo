import { pathKey } from "./fs";

/**
 * 差异视图跟谁比。
 * - unstaged：index ↔ 工作区
 * - staged：HEAD ↔ index
 * - commit：`<rev>^` ↔ `<rev>`
 * - range：`<from>` ↔ `<to>`，两侧都是任意 ref（提交 / 分支 / 标签）
 */
export type DiffSource =
  | { mode: "unstaged" }
  | { mode: "staged" }
  | { mode: "commit"; rev: string }
  | { mode: "range"; from: string; to: string };

/**
 * 编辑器里一个标签。
 *
 * 不能只拿文件路径当标签的身份：同一个文件可能既被当普通文件打开、又被当差异
 * 视图打开，差异视图里未暂存/暂存/某个提交又是三条不同的记录。所以做成结构化的。
 */
export type Tab =
  | { kind: "file"; path: string }
  | { kind: "diff"; path: string; source: DiffSource };

/** Map/Set 的键。路径里不可能出现 \u0000，拿它当分隔符是安全的。 */
const SEP = "\u0000";

/** 提交号在 key 里只取前 12 位就够区分了，也免得 key 太长 */
function sourceKey(source: DiffSource): string {
  switch (source.mode) {
    case "staged":
      return "s";
    case "unstaged":
      return "u";
    case "commit":
      return `c${SEP}${source.rev.slice(0, 12)}`;
    case "range":
      return `r${SEP}${source.from.slice(0, 12)}${SEP}${source.to.slice(0, 12)}`;
  }
}

export function tabKey(tab: Tab): string {
  const path = pathKey(tab.path);
  return tab.kind === "file"
    ? `f${SEP}${path}`
    : `d${SEP}${sourceKey(tab.source)}${SEP}${path}`;
}

export function sameTab(a: Tab, b: Tab): boolean {
  return tabKey(a) === tabKey(b);
}

/**
 * 标签标题后面的淡色说明。「文件」标签为空，差异标签给出跟谁比——
 * 同一个文件的不同差异标签也靠它区分。
 */
export function tabSuffix(tab: Tab): string {
  if (tab.kind === "file") return "";
  switch (tab.source.mode) {
    case "staged":
      return "↔ HEAD";
    case "unstaged":
      return "↔ index";
    case "commit":
      return `↔ ${tab.source.rev.slice(0, 7)}^`;
    case "range":
      return `${tab.source.from.slice(0, 7)} ↔ ${tab.source.to.slice(0, 7)}`;
  }
}

/** 标签的悬停说明 */
export function tabTitle(tab: Tab): string {
  const path = tab.path.replace(/\\/g, "/");
  if (tab.kind === "file") return path;
  switch (tab.source.mode) {
    case "staged":
      return `${path}（差异：与 HEAD 比较）`;
    case "unstaged":
      return `${path}（差异：与 index 比较）`;
    case "commit":
      return `${path}（差异：提交 ${tab.source.rev.slice(0, 7)} 与它的父提交比较）`;
    case "range":
      return `${path}（差异：${tab.source.from.slice(0, 7)} ↔ ${tab.source.to.slice(0, 7)}）`;
  }
}
