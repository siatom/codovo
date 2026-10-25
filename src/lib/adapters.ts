import { Channel, invoke } from "@tauri-apps/api/core";

export type AdapterDescriptor = { id: string; displayName: string; command: string; modes: string[]; capabilities: string[]; fallbackMode: string; approvalPolicy: string; structuredArgs: string[] };
export type RuntimeEvent =
  | { type: "started"; id: number; processId: number }
  | { type: "output"; id: number; stream: string; data: string }
  | { type: "exited"; id: number; code: number | null }
  | { type: "timedOut"; id: number }
  | { type: "cancelled"; id: number };
export const listAdapters = () => invoke<AdapterDescriptor[]>("adapter_catalog");
export const capabilitySummary = (adapterId: string, verified: string[]) => invoke<AdapterDescriptor>("adapter_capability_summary", { adapterId, verified });
export async function startAdapter(
  input: { adapterId: string; owner: string; program?: string; args: string[]; cwd?: string; mode?: "pty" | "headless_json"; timeoutMs?: number },
  onEvent: (event: RuntimeEvent) => void,
): Promise<number> {
  const channel = new Channel<RuntimeEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("adapter_start", { input, onEvent: channel });
}
export const cancelRuntime = (id: number) => invoke<boolean>("runtime_cancel", { id });
export const normalizeAdapterOutput = (adapterId: string, line: string) => invoke("adapter_normalize_output", { adapterId, line });
