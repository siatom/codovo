import { Channel, invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export interface AppUpdate {
  version: string;
  notes: string;
  releaseUrl: string;
  size: number | null;
  installStatus: "available" | "unsupported" | "checkFailed";
}

interface UpdateProgress {
  phase: "downloading" | "installing";
  downloaded: number;
  total: number | null;
}

interface UpdateSnapshot {
  update: AppUpdate | null;
  checking: boolean;
  busy: boolean;
  forceShow: boolean;
  message: string;
  progress: UpdateProgress | null;
}

let snapshot: UpdateSnapshot = {
  update: null,
  checking: false,
  busy: false,
  forceShow: false,
  message: "",
  progress: null,
};
const listeners = new Set<() => void>();
const publish = (patch: Partial<UpdateSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useAppUpdate() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export async function checkAppUpdate(manual = false): Promise<void> {
  if (snapshot.busy) return;
  if (manual) publish({ forceShow: true });
  if (snapshot.checking) return;
  publish({ checking: true, message: "" });
  try {
    const update = await invoke<AppUpdate | null>("app_update_check");
    publish({ update, message: manual && !update ? "当前已是最新版本" : "" });
  } catch {
    // 离线、限流、尚无发布都不弹错误，也不抹掉已经发现的更新。
    if (manual) publish({ message: "暂未取得更新信息，可稍后再检查" });
  } finally {
    publish({ checking: false });
  }
}

export function hideAppUpdate() {
  publish({ forceShow: false, message: "" });
}

export async function installAppUpdate(): Promise<void> {
  const update = snapshot.update;
  if (update?.installStatus !== "available" || snapshot.busy || snapshot.checking) return;
  publish({
    busy: true,
    message: "",
    progress: { phase: "downloading", downloaded: 0, total: update.size },
  });
  const progress = new Channel<UpdateProgress>();
  progress.onmessage = (value) => publish({ progress: value });
  try {
    await invoke("app_update_install", { version: update.version, progress });
  } catch (error) {
    publish({ message: String(error), busy: false, progress: null });
  }
}

export function updateSize(bytes: number | null): string {
  return bytes === null
    ? "大小暂不可用"
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
