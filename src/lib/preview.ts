import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 探测结果：这个工作区是什么项目、该怎么起。 */
export interface PreviewDetection {
  /** tauri | web | unknown */
  kind: string;
  packageManager: string;
  /** 展示用整行，如 "pnpm tauri dev" */
  command: string;
  program: string;
  args: string[];
  cwd: string;
  port: number | null;
  url: string | null;
  cdpPort: number | null;
  reason: string;
  warnings: string[];
}

/** 预览进程的运行状态快照。 */
export interface PreviewStatus {
  running: boolean;
  pid: number | null;
  kind: string;
  command: string;
  cwd: string;
  url: string | null;
  cdpPort: number | null;
  startedAt: number;
  logs: string[];
  exitCode: number | null;
}

/** 探测工作区的预览方式，不启动任何进程。 */
export function detectPreview(root: string): Promise<PreviewDetection> {
  return invoke("preview_detect", { root });
}

/** 启动预览。已在跑的先停掉。`command` / `port` 是用户覆盖值。 */
export function startPreview(
  root: string,
  options: { command?: string; port?: number } = {},
): Promise<PreviewStatus> {
  return invoke("preview_start", {
    root,
    command: options.command ?? null,
    port: options.port ?? null,
  });
}

export function stopPreview(root: string): Promise<void> {
  return invoke("preview_stop", { root });
}

export function previewStatus(root: string): Promise<PreviewStatus> {
  return invoke("preview_status", { root });
}

/** 订阅预览进程自己退出的事件（dev server 崩了 / 被关了）。 */
export function onPreviewExit(
  handler: (root: string, code: number) => void,
): Promise<UnlistenFn> {
  return listen<{ root: string; code: number }>("preview-exit", (event) => {
    handler(event.payload.root, event.payload.code);
  });
}
