import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { DiffSource } from "./tabs";
import type {
  DiscardSource,
  FileContent,
  FileDiff,
  FileEntry,
  GitCommit,
  GitCommitFile,
  GitStatusPayload,
  ImageContent,
  ReplaceResult,
  SearchOptions,
  SearchResult,
} from "./types";

const WORKSPACE_KEY = "codedock.workspace";
const WORKSPACES_KEY = "codedock.workspaces";
const WORKSPACE_NAMES_KEY = "codedock.workspaceNames";

/**
 * 打开 / 切换项目：后端登记这个项目的**全部源文件夹**、把目录监听整体换成这一组，
 * 返回 canonical 后的路径（顺序跟传入一致，`roots[0]` 是主要根）。
 *
 * 之后每条命令都带着某个 root——单窗口下会同时开着多个项目，后端靠 root 分辨是谁。
 */
export function projectActivate(roots: string[]): Promise<string[]> {
  return invoke<string[]>("project_activate", { roots });
}

/**
 * 只登记源文件夹、**不换目录监听**：编辑一个「开着、但不是当前显示」的项目时用。
 * 监听只跟当前项目，给后台项目改根不能顺手 activate，否则会把监听抢过去。
 */
export function projectRegister(roots: string[]): Promise<string[]> {
  return invoke<string[]>("project_register", { roots });
}

/** 关闭项目：收掉它每个源文件夹的终端与智能体进程、停掉各自的目录监听，并从后端白名单里摘掉 */
export function projectClose(roots: string[]): Promise<void> {
  return invoke("project_close", { roots });
}

/** 弹目录选择框，返回选中的路径；用户取消时返回 null */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "选择工作目录" });
  return typeof picked === "string" ? picked : null;
}

export function readSavedWorkspace(): string | null {
  try {
    return window.localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function saveWorkspace(path: string) {
  try {
    window.localStorage.setItem(WORKSPACE_KEY, path);
  } catch {
    // 隐私模式等场景写不进去，忽略即可，只是下次启动不会自动打开
  }
}

export function clearSavedWorkspace() {
  try {
    window.localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // 同上
  }
}

/** 用过的目录，最近打开的排在最前。 */
export function readSavedWorkspaces(): string[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function saveWorkspaces(paths: string[]) {
  try {
    window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(paths));
  } catch {
    // 同 saveWorkspace
  }
}

/**
 * 把一个目录提到历史最前并写回，返回新的列表。
 *
 * 写之前先读一遍最新的：多窗口共享同一份 localStorage，直接拿本窗口记的列表
 * 覆盖，会把别的窗口刚打开的项目抹掉。Windows 上大小写、分隔符不同也算同一个
 * 目录，只比字符串会把同一个目录存成两条。
 */
export function addSavedWorkspace(path: string): string[] {
  const list = [path, ...readSavedWorkspaces()].filter(
    (item, index, all) => all.findIndex((other) => samePath(other, item)) === index,
  );
  saveWorkspaces(list);
  return list;
}

/** 从历史里去掉一个目录，同样先读最新再写，返回新的列表 */
export function dropSavedWorkspace(path: string): string[] {
  const list = readSavedWorkspaces().filter((item) => !samePath(item, path));
  saveWorkspaces(list);
  return list;
}

/**
 * 项目在 CodeDock 里的显示名（别名），按目录路径存。
 * 只是界面上的名字，**不改磁盘上的文件夹名**；没有别名的目录直接用目录名。
 */
export function readWorkspaceNames(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_NAMES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const names: Record<string, string> = {};
    for (const [path, name] of Object.entries(parsed)) {
      if (typeof name === "string" && name.trim()) names[path] = name;
    }
    return names;
  } catch {
    return {};
  }
}

export function saveWorkspaceNames(names: Record<string, string>) {
  try {
    window.localStorage.setItem(WORKSPACE_NAMES_KEY, JSON.stringify(names));
  } catch {
    // 同 saveWorkspace
  }
}

/**
 * 订阅「工作区列表被别的窗口改了」。返回取消订阅的函数。
 * storage 事件只在别的 document 触发，正好用来做跨窗口同步，不会自己回灌自己。
 */
export function onWorkspacesChanged(handler: (list: string[]) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== WORKSPACES_KEY) return;
    handler(readSavedWorkspaces());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** 订阅「项目别名被别的窗口改了」。返回取消订阅的函数 */
export function onWorkspaceNamesChanged(
  handler: (names: Record<string, string>) => void,
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== WORKSPACE_NAMES_KEY) return;
    handler(readWorkspaceNames());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function listDir(root: string, path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("fs_list_dir", { root, path });
}

/**
 * 按文件名递归搜工作区（大小写不敏感的子串匹配），返回命中的绝对路径。
 * 后端会跳过 node_modules / .git / target 这类目录，并且有结果条数上限。
 */
export function searchFiles(root: string, query: string): Promise<string[]> {
  return invoke<string[]>("fs_search_files", { root, query });
}

/**
 * 按内容递归搜工作区，带大小写 / 全字 / 正则三个开关。结果按文件分组，
 * 行列都用 UTF-16 单位，能直接喂给 Monaco 的 Range。
 */
export function searchContents(
  root: string,
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  return invoke<SearchResult>("fs_search_content", { root, query, options });
}

/** 替换单条匹配；行列对不上时后端会报「内容已经变了」，让用户重新搜索 */
export function replaceOne(request: {
  root: string;
  path: string;
  position: { line: number; column: number; length: number };
  query: string;
  options: SearchOptions;
  replacement: string;
}): Promise<void> {
  return invoke("fs_replace_one", request);
}

/** 替换一批文件里的所有匹配；只动传进来的这些路径 */
export function replaceAll(request: {
  root: string;
  paths: string[];
  query: string;
  options: SearchOptions;
  replacement: string;
}): Promise<ReplaceResult> {
  return invoke<ReplaceResult>("fs_replace_all", request);
}

export function readFile(root: string, path: string): Promise<FileContent> {
  return invoke<FileContent>("fs_read_file", { root, path });
}

/**
 * 读一张图片当预览用，后端返回 data URL。只认 png / jpg / gif / webp / bmp / ico，
 * 其余扩展名后端直接报错（`svg` 是文本，仍旧走 `readFile` 在编辑器里编辑）。
 */
export function readImage(root: string, path: string): Promise<ImageContent> {
  return invoke<ImageContent>("fs_read_image", { root, path });
}

export function writeFile(root: string, path: string, text: string): Promise<void> {
  return invoke("fs_write_file", { root, path, text });
}

export function createFile(root: string, path: string): Promise<void> {
  return invoke("fs_create_file", { root, path });
}

export function createDirectory(root: string, path: string): Promise<void> {
  return invoke("fs_create_directory", { root, path });
}

/** 就地改名。`newName` 只是一段名字，不带分隔符；返回改名后的绝对路径。 */
export function renameEntry(root: string, path: string, newName: string): Promise<string> {
  return invoke<string>("fs_rename", { root, path, newName });
}

/** 删除文件或整个目录（递归）。**不可撤销**，调用前必须先跟用户确认。 */
export function deleteEntry(root: string, path: string): Promise<void> {
  return invoke("fs_delete", { root, path });
}

/**
 * 工作区里的目录结构变了（后端监听 + 防抖后才发）。载荷是需要重新列一遍的
 * 目录绝对路径，调用方自己决定哪些还没展开、不用管。
 */
export function onDirsChanged(handler: (dirs: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>("fs-changed", (event) => handler(event.payload));
}

/**
 * 工作区里有文件的内容变了（终端、git、别的编辑器、智能体写的）。载荷是这些
 * 文件的绝对路径，编辑器按它重读。
 *
 * 和 `onDirsChanged` 分开是有意的：目录变化要重列整棵树，文件变化只影响编辑器，
 * 混成一条的话编辑器每存一次盘都得把树刷一遍。
 */
export function onFilesChanged(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>("fs-file-changed", (event) => handler(event.payload));
}

/** 某个项目的 git 状态；目录不是仓库时 isRepo 为 false */
export function gitStatus(root: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_status", { root });
}

/**
 * 这批绝对路径里，哪些被 .gitignore 之类的规则忽略了。文件树按它把条目置灰。
 * 目录不是仓库（或没装 git）时返回空数组，不是错误。
 */
export function gitIgnored(root: string, paths: string[]): Promise<string[]> {
  return invoke<string[]>("git_ignored", { root, paths });
}

/**
 * 把一条路径追加进工作区根的 `.gitignore`（目录自动带上尾斜杠）。
 * 已经有同样的规则时后端什么都不做，不是错误。
 */
export function gitAddToIgnore(root: string, path: string): Promise<void> {
  return invoke("git_add_to_ignore", { root, path });
}

/** 暂存；不传 paths 表示全部暂存。返回写完之后的新状态。 */
export function gitStage(root: string, paths?: string[]): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_stage", { root, paths: paths ?? null });
}

/** 取消暂存；不传 paths 表示全部取消。 */
export function gitUnstage(root: string, paths?: string[]): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_unstage", { root, paths: paths ?? null });
}

/**
 * 放弃某些文件的改动，还原到 index（unstaged）或 HEAD（staged）。**不可撤销**，
 * 调用前必须先跟用户确认。paths 不能为空：丢弃按分组来，没有"全部"这个说法。
 */
export function gitDiscard(
  root: string,
  paths: string[],
  source: DiscardSource,
): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_discard", { root, paths, source });
}

export function gitCommit(root: string, message: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_commit", { root, message });
}

/**
 * 一个改动文件的两侧内容。`source` 决定跟谁比：
 * 未暂存比 index、暂存比 HEAD、看某个提交比它的父提交。
 */
export function gitFileDiff(
  root: string,
  path: string,
  source: DiffSource,
): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { root, path, source });
}

/** 提交历史，最新的在最前；不传 limit 就取一页 */
export function gitLog(root: string, limit?: number): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", { root, limit: limit ?? null });
}

/** 某个提交改了哪些文件 */
export function gitCommitFiles(root: string, rev: string): Promise<GitCommitFile[]> {
  return invoke<GitCommitFile[]>("git_commit_files", { root, rev });
}

/**
 * 从远程取回引用，不动工作区。成功后 ahead/behind 才是最新的。
 * 耗时按网络算，后端给了 3 分钟超时。
 */
export function gitFetch(root: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_fetch", { root });
}

/** 拉取当前分支的上游，后端只允许快进（分叉时直接报错） */
export function gitPull(root: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_pull", { root });
}

/** 推送当前分支；还没有上游时后端会顺手建立跟踪关系 */
export function gitPush(root: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_push", { root });
}

/**
 * 合并当前分支的上游：后端先 fetch 再 merge，分叉时产生合并提交。
 * 冲突不算失败——返回的状态里 `merging` 为真，面板据此切到"合并中"界面。
 */
export function gitMerge(root: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_merge", { root });
}

/** 中止正在进行的合并，工作区回到合并前（不在合并态时是 no-op） */
export function gitMergeAbort(root: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_merge_abort", { root });
}

/** 冲突都解决并暂存后，用 MERGE_MSG 提交完成合并 */
export function gitMergeContinue(root: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_merge_continue", { root });
}

/** 后端一律用原生分隔符；界面按 VS Code 习惯显示 `/`。 */
export function toDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * 路径的归一化 key，用来做 Map 的键和相等判断。
 * Windows 路径不区分大小写，分隔符也可能混用（对话框给 `/`、后端给 `\`、
 * git 给 `/`），不归一化就会把同一个文件认成两个。
 */
export function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** 判断两个路径是不是同一个目录。 */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * child 是不是 parent 本身、或者落在 parent 目录里。
 * 比的是归一化后的路径段，所以 `a/bc` 不会被 `a/b` 误判成子孙；
 * 父路径末尾的分隔符先去掉，否则盘符根（`D:\`）拼出来会是 `d://`。
 */
export function isPathInside(child: string, parent: string): boolean {
  const base = pathKey(parent).replace(/\/+$/, "");
  const kid = pathKey(child);
  if (kid === base) return true;
  return kid.startsWith(base ? `${base}/` : "/");
}

/**
 * 这条路径落在哪个根里——取**最长**的那个匹配，这样一根套在另一根里时也算给里层
 * （外层根下的那条路径其实归里层管）。哪个根都不是就返回 null。
 *
 * 一个项目可以挂多个源文件夹，但后端每条 fs 命令只认一个白名单里的 root：
 * 拿错 root 会被 `checked_root` 挡下，报「路径越界（不在工作区内）」。
 * 所以凡是「路径可能来自任意根」的地方，都得先过这一道。
 */
export function ownerRoot(roots: string[], path: string): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (!isPathInside(path, root)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

/**
 * 一组根的稳定标识。数组每次渲染都可能是新引用，effect / useMemo 的依赖得靠这个
 * 字符串来判断「根换没换」，不然每渲染一次就重订阅一遍。
 */
export function rootsKeyOf(roots: string[]): string {
  return roots.map((root) => pathKey(root)).join("\u0000");
}
