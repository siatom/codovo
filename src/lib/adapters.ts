import { invoke } from "@tauri-apps/api/core";

export type AdapterDescriptor = { id: string; displayName: string; command: string; modes: string[]; capabilities: string[]; fallbackMode: string; approvalPolicy: string; structuredArgs: string[] };
export const listAdapters = () => invoke<AdapterDescriptor[]>("adapter_catalog");
export const capabilitySummary = (adapterId: string, verified: string[]) => invoke<AdapterDescriptor>("adapter_capability_summary", { adapterId, verified });
export const startAdapter = (input: { adapterId: string; owner: string; program?: string; args: string[]; cwd?: string; mode?: "pty" | "headless_json"; timeoutMs?: number }, onEvent: unknown) =>
  invoke<number>("adapter_start", { input, onEvent });
