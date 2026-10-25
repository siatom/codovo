import { invoke } from "@tauri-apps/api/core";

export type IntegrationMode = "pty" | "headless" | "native_api";

export interface AgentCapabilities {
  mode: IntegrationMode;
  structuredEvents: boolean;
  streamText: boolean;
  persistentSession: boolean;
  sessionResume: boolean;
  sessionFork: boolean;
  interactiveTurn: boolean;
  nativeToolEvents: boolean;
  approvalCallback: boolean;
  nativeTaskEvents: boolean;
  tokenUsage: boolean;
  modelSelection: boolean;
  nativeSubagents: boolean;
}

export interface AgentInstallation {
  adapterId: string;
  executablePath: string | null;
  version: string | null;
  auth: "ready" | "needs_login" | "unknown" | "unavailable";
  supportedModes: IntegrationMode[];
  diagnostics: string[];
  checkedAt: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  adapterId: string;
  command: string;
  cwd: string | null;
  args: string[];
  env: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSessionRecord {
  id: string;
  adapterId: string;
  profileId: string | null;
  root: string | null;
  nativeSessionId: string | null;
  transport: string;
  recoveryStrategy: string;
  status: string;
  lastSeenAt: number;
  nativeMetadata: Record<string, unknown>;
}

export interface ExecutionEventEnvelope {
  schemaVersion: number;
  eventId: string;
  eventKey: string;
  eventType: string;
  source: "native" | "observed" | "inferred" | "user" | "policy";
  adapterId: string;
  profileId: string | null;
  sessionId: string | null;
  nativeSessionId: string | null;
  runId: string | null;
  sequence: number | null;
  occurredAt: number;
  recordedAt: number;
  payload: unknown;
}

export interface AgentCliQuery {
  id: string;
  commands: string[];
}

export function scanAgentRegistry(queries: AgentCliQuery[]): Promise<AgentInstallation[]> {
  return invoke("control_registry_scan", { queries });
}

export function listAgentRegistry(): Promise<AgentInstallation[]> {
  return invoke("control_registry_list");
}

export function listAgentProfiles(): Promise<AgentProfile[]> {
  return invoke("control_profile_list");
}

export function listAgentSessions(root?: string): Promise<AgentSessionRecord[]> {
  return invoke("control_session_list", { root: root ?? null });
}

export function listControlEvents(options: { sessionId?: string; limit?: number; offset?: number } = {}): Promise<ExecutionEventEnvelope[]> {
  return invoke("control_event_list", {
    sessionId: options.sessionId ?? null,
    limit: options.limit ?? 100,
    offset: options.offset ?? 0,
  });
}

export function updateAgentSessionStatus(id: string, status: string): Promise<void> {
  return invoke("control_session_update_status", { id, status });
}

export function listExecutionEvents(options: {
  sessionId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<ExecutionEventEnvelope[]> {
  return invoke("control_event_list", {
    sessionId: options.sessionId ?? null,
    limit: options.limit ?? 100,
    offset: options.offset ?? 0,
  });
}

export function reconcileControlPlane(): Promise<number> {
  return invoke("control_reconcile");
}
