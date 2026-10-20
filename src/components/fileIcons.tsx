import { useSyncExternalStore } from "react";
import { useTheme } from "../lib/theme";
import { IconFile, IconFolder, IconFolderOpen } from "./icons";

/**
 * 文件树的图标用 material-icon-theme 那一套（MIT，装在 devDependencies 里），
 * 资源由 `scripts/gen-file-icons.mjs` 生成到 `public/material-icons/` 下——
 * 约 1180 个 svg 加一份映射表，都不进仓库、也不进 bundle（3.3MB 的 svg 全量打包不划算），
 * 所以这里异步取一次、进程内缓存住，取到之前先落到内置的线条图标上。
 *
 * 实际看不出「先线条后彩色」这一下：目录内容是后端异步列出来的，这份表通常先到。
 * 生成脚本没跑过也只是回落成线条图标，不会让文件树整块报错。
 */

interface IconTable {
  /** 整个文件名 -> 图标 id。键统一是小写（生成时补过别名，见脚本的 withAliases） */
  fileNames: Record<string, string>;
  /** 扩展名 -> 图标 id */
  fileExtensions: Record<string, string>;
  /** 目录名 -> 图标 id */
  folderNames: Record<string, string>;
  /** 浅色主题下少数图标的覆盖项；查不到就回落上面三张表 */
  light: {
    fileNames: Record<string, string>;
    fileExtensions: Record<string, string>;
    folderNames: Record<string, string>;
  };
  defaultFile: string;
  defaultFolder: string;
}

const MAPPING_URL = `${import.meta.env.BASE_URL}material-icons/mapping.json`;

let table: IconTable | null = null;
let requested = false;
const listeners = new Set<() => void>();

function requestTable(): void {
  if (requested) return;
  requested = true;
  fetch(MAPPING_URL)
    .then((res) => (res.ok ? (res.json() as Promise<IconTable>) : null))
    .then((data) => {
      if (!data) return;
      table = data;
      for (const listener of listeners) listener();
    })
    .catch(() => {
      // 读不到就当没这回事，继续用内置线条图标
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useIconTable(): IconTable | null {
  requestTable();
  return useSyncExternalStore(subscribe, () => table);
}

/**
 * 查表。名字大小写不定（Windows/macOS 上尤其），所以先精确命中、再退回小写——
 * 生成脚本对 `Dockerfile`、`CNAME` 这类大小写敏感的键补过小写别名。
 */
function lookup(map: Record<string, string>, key: string): string | undefined {
  if (!key) return undefined;
  return map[key] ?? map[key.toLowerCase()];
}

/**
 * 扩展名。和 VS Code 一样把 `.env` 也算成「env」——它的点在第 0 位，
 * 按「点不在开头」的老写法会当成没有扩展名，`.env` 就挑不到图标了。
 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

/**
 * 挑文件图标，顺序照 VS Code：先整个文件名、再扩展名；每一档里浅色覆盖项优先，
 * 都没有才回落兜底图标。
 */
function fileIconId(current: IconTable, name: string, light: boolean): string {
  const nameId =
    (light ? lookup(current.light.fileNames, name) : undefined) ?? lookup(current.fileNames, name);
  if (nameId) return nameId;
  const ext = extensionOf(name);
  return (
    (light ? lookup(current.light.fileExtensions, ext) : undefined) ??
    lookup(current.fileExtensions, ext) ??
    current.defaultFile
  );
}

/** 挑目录图标：按目录名认（src / node_modules / .git 各有一套），认不出用兜底文件夹 */
function folderIconId(current: IconTable, name: string, light: boolean): string {
  return (
    (light ? lookup(current.light.folderNames, name) : undefined) ??
    lookup(current.folderNames, name) ??
    current.defaultFolder
  );
}

/**
 * 展开态文件夹的 id：material 的 folderNamesExpanded 恒等于闭合态 id 加 `-open`，
 * 浅色变体则把 `_light` 挪到末尾（folder-jinja_light -> folder-jinja-open_light）。
 * 生成脚本已经把这条约定跟原始数据对过，所以这里直接拼、不用再带一张表。
 */
function openFolderId(id: string): string {
  return id.endsWith("_light") ? `${id.slice(0, -"_light".length)}-open_light` : `${id}-open`;
}

/**
 * material 的 svg 颜色是烤在 fill 里的（不像内置图标走 currentColor），当图片用最省事。
 * `draggable={false}` 仍然保留：拖动浮标里也会用到图标，别让指针按在图标上时拖出一张
 * 浏览器原生幽灵图（文件树内部已经改用 Pointer Events，不依赖 HTML5 拖拽）。
 */
function IconImage({ id, className }: { id: string; className: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}material-icons/${id}.svg`}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`${className} shrink-0`}
    />
  );
}

/** 文件行前面的图标：按文件名 / 扩展名认 */
export function FileTypeIcon({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  const table = useIconTable();
  const light = useTheme().theme === "light";
  if (!table) return <IconFile className={className} />;
  return <IconImage id={fileIconId(table, name, light)} className={className} />;
}

/** 文件夹行前面的图标：闭合态和展开态是两张图 */
export function FolderTypeIcon({
  name,
  isOpen = false,
  className = "h-4 w-4",
}: {
  name: string;
  isOpen?: boolean;
  className?: string;
}) {
  const table = useIconTable();
  const light = useTheme().theme === "light";
  if (!table) {
    return isOpen ? <IconFolderOpen className={className} /> : <IconFolder className={className} />;
  }
  const id = folderIconId(table, name, light);
  return <IconImage id={isOpen ? openFolderId(id) : id} className={className} />;
}
