import { pathKey } from "./fs";

/**
 * 差异视图跟谁比。
 * - unstaged：index ↔ 工作区
 * - staged：HEAD ↔ index
 * - commit：`<rev>^` ↔ `<rev>`
 * - range：`<from>` ↔ `<to>`，两侧都是任意 ref（提交 / 分支 / 标签）
 *
 * `root` 只在**文件不属于工作区任何根**时才需要：工作树（worktree）里的文件就属于
 * 这种情况，它不在 workspace.roots 下，编辑器按路径推断仓库会落到主检出上，diff
 * 直接报「路径不在仓库里」。带上它，diff 就在那棵工作树上跑。
 */
export type DiffSource =
  | { mode: "unstaged"; root?: string }
  | { mode: "staged"; root?: string }
  | { mode: "commit"; rev: string; root?: string }
  | { mode: "range"; from: string; to: string; root?: string };

/**
 * 磁盘跟编辑器内容对不上的外部变更状态：
 * - `none`：一致
 * - `updated`：磁盘被外部改过、编辑器已同步（只可能是干净标签），切到这个标签时清除
 * - `conflict`：磁盘被外部改过，但这个标签有未保存改动，编辑器内容**没有被覆盖**，等用户处理
 * - `deleted`：磁盘上的文件已经没了，等用户处理
 */
export type ExternalState = "none" | "updated" | "conflict" | "deleted";

/** 普通文件标签。`path` 为 null 表示还没落盘的未命名缓冲区 */
export interface FileTab {
  kind: "file";
  /** 文件绝对路径；未命名缓冲区是 null */
  path: string | null;
  /** 未命名缓冲区的稳定标识（如 `"1"`）。没有路径时标签身份靠它，不能被当成空路径 */
  untitledId?: string;
  /** 磁盘外部变更标记 */
  externalState: ExternalState;
}

/**
 * 编辑器里一个标签。
 *
 * 不能只拿文件路径当标签的身份：同一个文件可能既被当普通文件打开、又被当差异
 * 视图打开，差异视图里未暂存/暂存/某个提交又是三条不同的记录；未命名缓冲区更是
 * 连路径都没有。所以做成结构化的。
 */
export type Tab = FileTab | { kind: "diff"; path: string; source: DiffSource };

/** 打开磁盘上的一个文件（标签建档走它，`externalState` 才有默认值） */
export function openFileTab(path: string): FileTab {
  return { kind: "file", path, externalState: "none" };
}

/** 建一个未命名缓冲区；`untitledId` 只需在同一个工作区内唯一且稳定 */
export function newUntitledTab(untitledId: string): FileTab {
  return { kind: "file", path: null, untitledId, externalState: "none" };
}

/** Map/Set 的键。路径里不可能出现 \u0000，拿它当分隔符是安全的。 */
const SEP = "\u0000";

/** 提交号在 key 里只取前 12 位就够区分了，也免得 key 太长 */
function sourceKey(source: DiffSource): string {
  // 同一个文件可能分别在工作树和主检出上被打开成差异标签，root 要进 key，
  // 否则两个标签会撞成同一个
  const root = source.root ? `${SEP}${pathKey(source.root)}` : "";
  switch (source.mode) {
    case "staged":
      return `s${root}`;
    case "unstaged":
      return `u${root}`;
    case "commit":
      return `c${SEP}${source.rev.slice(0, 12)}${root}`;
    case "range":
      return `r${SEP}${source.from.slice(0, 12)}${SEP}${source.to.slice(0, 12)}${root}`;
  }
}

/** 磁盘上某个文件对应的标签 key（另存为后按新路径归位缓存时用） */
export function fileTabKey(path: string): string {
  return `f${SEP}${pathKey(path)}`;
}

export function tabKey(tab: Tab): string {
  if (tab.kind === "diff") {
    return `d${SEP}${sourceKey(tab.source)}${SEP}${pathKey(tab.path)}`;
  }
  // 未命名缓冲区没有路径，用它的稳定 id 当身份；不能退化成「空路径」，
  // 否则每个未命名标签都会撞成同一个 key
  return tab.path === null ? `u${SEP}${tab.untitledId ?? ""}` : fileTabKey(tab.path);
}

export function sameTab(a: Tab, b: Tab): boolean {
  return tabKey(a) === tabKey(b);
}

/** 标签显示名。未命名缓冲区没有文件名，用「未命名-N」 */
export function tabName(tab: Tab): string {
  if (tab.kind === "diff") return lastSegment(tab.path);
  if (tab.path === null) return `未命名-${tab.untitledId ?? "缓冲区"}`;
  return lastSegment(tab.path);
}

/** 路径最后一段（`\` 和 `/` 都认），空串时退回原路径 */
function lastSegment(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || path;
}

/** 标签元数据补丁：另存为改路径、外部变更改标记，都只动这几个字段 */
export interface TabPatch {
  /** 只能改成真实路径（另存为）；没有「改回未命名」这回事 */
  path?: string;
  externalState?: ExternalState;
}

/** 给标签套一个元数据补丁。差异标签没有这些字段，原样返回 */
export function patchTab(tab: Tab, patch: TabPatch): Tab {
  if (tab.kind === "diff") return tab;
  return { ...tab, ...patch };
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
  if (tab.path === null) return "未命名缓冲区（尚未保存到磁盘）";
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
