import { assetUrl } from "./asset-url";

/**
 * 能就地渲染的 Office 文档类型。`docm` / `xlsm` 与对应的 docx / xlsx 是同一套
 * OOXML 包结构，预览库能直接读，跟着一起收。
 */
export type OfficeKind = "docx" | "xlsx" | "pptx";

const OFFICE_EXTENSIONS: Record<string, OfficeKind> = {
  docx: "docx",
  docm: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  pptx: "pptx",
};

/** 旧版二进制格式（BIFF / OLE）：前端预览库都不认，只能提示另存为新格式 */
const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "xls", "ppt"]);

function extensionOf(path: string | null): string {
  if (path === null) return "";
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

export function officeKindOf(path: string | null): OfficeKind | null {
  return OFFICE_EXTENSIONS[extensionOf(path)] ?? null;
}

/** 旧版格式的扩展名；不是这类文件返回 null */
export function legacyOfficeExtension(path: string | null): string | null {
  const ext = extensionOf(path);
  return LEGACY_OFFICE_EXTENSIONS.has(ext) ? ext : null;
}

/**
 * 单个文档的预览上限。渲染库要把整份文件解进内存，超大表格 / 幻灯片会直接把
 * 界面卡死；到这条线为止都还是「打得开」的量级。
 */
const MAX_OFFICE_BYTES = 80 * 1024 * 1024;

/**
 * 读 Office 文档的原始字节。走 asset 协议而不是新开 Tauri 命令：
 * 工作区根在 `workspace_activate` 时已经放行给 asset 协议（见 fs_api.rs），
 * 二进制文件不该再绕一道 IPC 序列化。
 */
export async function readOfficeBytes(path: string): Promise<ArrayBuffer> {
  const response = await fetch(assetUrl(path));
  if (!response.ok) {
    throw new Error(`读取文件失败（HTTP ${response.status}）`);
  }
  // 先看响应头，能省掉把超大文件整个拉进内存
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_OFFICE_BYTES) {
    throw new Error("文件超过 80MB，已跳过预览");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_OFFICE_BYTES) {
    throw new Error("文件超过 80MB，已跳过预览");
  }
  return buffer;
}
