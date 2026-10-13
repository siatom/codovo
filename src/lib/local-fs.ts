import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 远程连接「本地文件」面板的数据源。
 *
 * 和 `lib/fs.ts` 不同：这些命令**不受工作区白名单限制**，可以浏览整个文件系统。
 * 后端 `local_fs.rs` 里说明了为什么这样是安全的。
 */
export interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** 目录一律 0 */
  size: number;
  /** 秒级 Unix 时间戳，0 表示未知（和 SftpEntry 一致） */
  mtime: number;
}

export function localHome(): Promise<string> {
  return invoke<string>("local_home");
}

/** 列目录。`path` 传空串表示「此电脑」那一层（Windows 盘符列表 / Unix 根） */
export function localListDir(path: string): Promise<LocalEntry[]> {
  return invoke<LocalEntry[]>("local_list_dir", { path });
}

export function localMkdir(path: string): Promise<void> {
  return invoke<void>("local_mkdir", { path });
}

/** 就地改名，返回改名后的绝对路径 */
export function localRename(path: string, newName: string): Promise<string> {
  return invoke<string>("local_rename", { path, newName });
}

/** 删除文件或整个目录（递归）。**不可撤销**，调用前必须先确认 */
export function localRemove(path: string): Promise<void> {
  return invoke<void>("local_remove", { path });
}

/**
 * 开始监听一个本地目录的变动（新增 / 删除 / 重命名 / 内容变更）。
 *
 * 本地面板能退到工作区之外的任意目录，`watcher.rs` 那套按工作区根的监听用不上，
 * 所以单独开了这条按需通道。`path` 传空串（「此电脑」）什么都不做。
 */
export function localWatchDir(path: string): Promise<void> {
  return invoke<void>("local_watch_dir", { path });
}

/** 停止监听（面板切走目录或卸载时调用），避免监听一直挂着 */
export function localUnwatchDir(path: string): Promise<void> {
  return invoke<void>("local_unwatch_dir", { path });
}

/**
 * 被监听的本地目录发生了变动。载荷是**发生变动的那个目录**的绝对路径，
 * 调用方拿它和自己的当前目录比对，只认自己关心的那个。
 */
export function onLocalDirChanged(handler: (dir: string) => void): Promise<UnlistenFn> {
  return listen<string>("local-fs-changed", (event) => handler(event.payload));
}

/** 是不是 Windows 的盘符（`C:` / `C:\` / `C:/`） */
function isDrive(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(path);
}

/** 这段路径用哪种分隔符：带盘符或出现 `\` 就当 Windows */
export function localSeparator(path: string): string {
  return /^[A-Za-z]:/.test(path) || path.includes("\\") ? "\\" : "/";
}

/** 拼一段子路径。dir 为空（此电脑）时直接给名字 */
export function joinLocal(dir: string, name: string): string {
  if (!dir) return name;
  const sep = localSeparator(dir);
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** 父目录；已经到顶层（盘符列表 / Unix 根）时返回 null。盘符根再往上是「此电脑」（空串） */
export function parentLocal(path: string): string | null {
  if (!path) return null;
  if (isDrive(path)) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  if (index === 0) return "/";
  const head = trimmed.slice(0, index);
  // `C:` 单独一段时要补回分隔符，否则拼出来是相对路径
  return isDrive(head) ? `${head}${localSeparator(path)}` : head;
}

/**
 * 面包屑分段。Windows 首段是「此电脑」（点开列盘符），Unix 首段是 `/`。
 * `C:\Users\me` -> [此电脑, C:\, Users, me]
 */
export function localCrumbs(path: string): { name: string; path: string }[] {
  if (!path) return [{ name: "此电脑", path: "" }];

  if (localSeparator(path) === "\\") {
    const drive = path.slice(0, 2);
    const rest = path.slice(2).split(/[\\/]/).filter(Boolean);
    const crumbs = [
      { name: "此电脑", path: "" },
      { name: `${drive}\\`, path: `${drive}\\` },
    ];
    let acc = `${drive}\\`;
    for (const part of rest) {
      acc = acc.endsWith("\\") ? `${acc}${part}` : `${acc}\\${part}`;
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  }

  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}
