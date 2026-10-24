import { invoke } from "@tauri-apps/api/core";

export type EvidenceSource = "native" | "observed" | "inferred" | "user";
export type ApprovalState = "pending" | "approved" | "rejected" | "timed_out";
export type ApprovalRequest = { id: string; sessionId: string | null; toolId: string; summary: string; state: ApprovalState; expiresAt: number | null };
export type NormalizedAgentEvent = { schemaVersion: number; eventKey: string; adapterId: string; eventType: string; source: EvidenceSource; sessionId: string | null; runId: string | null; message: unknown; tool: unknown; raw: unknown };
export const normalizeAgentEvent = (event: unknown) => invoke<NormalizedAgentEvent>("protocol_normalize_event", { event });
export const createApproval = (toolId: string, summary: string, sessionId?: string, expiresAt?: number) => invoke<ApprovalRequest>("protocol_create_approval", { toolId, summary, sessionId, expiresAt });
export const decideApproval = (request: ApprovalRequest, decision: Exclude<ApprovalState, "pending">) => invoke<ApprovalRequest>("protocol_decide_approval", { input: { request, decision } });
