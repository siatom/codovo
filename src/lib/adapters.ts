import { invoke } from "@tauri-apps/api/core";

export type AdapterDescriptor = { id: string; displayName: string; command: string; modes: string[]; capabilities: string[]; fallbackMode: string; approvalPolicy: string };
export const listAdapters = () => invoke<AdapterDescriptor[]>("adapter_catalog");
export const capabilitySummary = (adapterId: string, verified: string[]) => invoke<AdapterDescriptor>("adapter_capability_summary", { adapterId, verified });
