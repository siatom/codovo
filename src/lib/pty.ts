import { Channel, invoke } from "@tauri-apps/api/core";
import type { PtyEvent } from "./types";

export interface PtyHandle {
  id: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** 终端可选的 shell；id 为空串的那项表示「自动」，由后端按平台挑 */
export interface ShellInfo {
  id: string;
  label: string;
  /** 终端标签页上的简洁名，如 pwsh / cmd / Git Bash / zsh */
  name: string;
  /** 挑图标用的键，见 icons.tsx 的 ShellIcon */
  kind: string;
}

/** 本机真实存在的 shell 候选，由后端探测（含每个 shell 该带的启动参数） */
export async function listShells(): Promise<ShellInfo[]> {
  return invoke<ShellInfo[]>("shell_list");
}

export async function spawnPty(options: {
  /** 这个会话属于哪个工作区；没选工作区时传空串（后端用它按工作区收 shell） */
  root: string;
  cwd?: string;
  /** 选中的 shell 候选 id；不传走自动 */
  shell?: string;
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number) => void;
}): Promise<PtyHandle> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event) => {
    if (event.type === "data") {
      options.onData(decodeBase64(event.data));
    } else {
      options.onExit(event.code);
    }
  };

  const id = await invoke<number>("pty_spawn", {
    root: options.root,
    cwd: options.cwd ?? null,
    shell: options.shell ?? null,
    cols: options.cols,
    rows: options.rows,
    onEvent: channel,
  });

  let alive = true;

  return {
    id,
    write(data) {
      if (!alive) return;
      void invoke("pty_write", { id, data }).catch(() => {});
    },
    resize(cols, rows) {
      if (!alive) return;
      void invoke("pty_resize", { id, cols, rows }).catch(() => {});
    },
    kill() {
      if (!alive) return;
      alive = false;
      void invoke("pty_kill", { id }).catch(() => {});
    },
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
