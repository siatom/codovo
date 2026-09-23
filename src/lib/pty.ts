import { Channel, invoke } from "@tauri-apps/api/core";
import type { PtyEvent } from "./types";

export interface PtyHandle {
  id: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export async function spawnPty(options: {
  cwd?: string;
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
    cwd: options.cwd ?? null,
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
