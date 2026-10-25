import { invoke } from "@tauri-apps/api/core";

export type Goal = { id: string; title: string; description: string; status: string; version: number; createdAt: number; updatedAt: number };
export type Milestone = { id: string; goalId: string; title: string; status: string; version: number; createdAt: number; updatedAt: number };
export type Task = { id: string; goalId: string | null; milestoneId: string | null; parentId: string | null; title: string; description: string; status: string; priority: number; acceptance: string[]; version: number; createdAt: number; updatedAt: number };
export type TaskRun = { id: string; taskId: string; attemptNo: number; status: string; profileId: string | null; sessionId: string | null; worktreeId: string | null; baselineSha: string | null; baselineDirty: boolean | null; finalSha: string | null; finalDirty: boolean | null; changedPaths: string[]; startedAt: number; finishedAt: number | null; error: string | null };
export type Proposal = { id: string; taskId: string | null; kind: string; title: string; payload: unknown; source: string; status: string; decidedBy: string | null; decidedAt: number | null; version: number };

export const listGoals = () => invoke<Goal[]>("task_goal_list");
export const upsertGoal = (input: Record<string, unknown>) => invoke<Goal>("task_goal_upsert", { input });
export const listTasks = (goalId?: string, status?: string) => invoke<Task[]>("task_list", { goalId, status });
export const upsertTask = (input: Record<string, unknown>) => invoke<Task>("task_upsert", { input });
export const transitionTask = (id: string, to: string, expectedVersion: number) => invoke<Task>("task_transition", { id, to, expectedVersion });
export const listTaskDependencies = (taskId: string) => invoke<string[]>("task_dependency_list", { taskId });
export const addTaskDependency = (taskId: string, dependsOnId: string) => invoke<void>("task_dependency_add", { taskId, dependsOnId });
export const listRuns = (taskId?: string) => invoke<TaskRun[]>("task_run_list", { taskId });
export const taskRunStart = (input: { taskId: string; profileId?: string; worktreeId?: string; baselineSha?: string; baselineDirty?: boolean }) =>
  invoke<TaskRun>("task_run_start", { input });
export const taskRunFinish = (input: { runId: string; status: "succeeded" | "failed" | "cancelled" | "interrupted"; sessionId?: string; finalSha?: string; finalDirty?: boolean; changedPaths?: string[]; error?: string }) =>
  invoke<TaskRun>("task_run_finish", { ...input, sessionId: input.sessionId ?? null, finalSha: input.finalSha ?? null, finalDirty: input.finalDirty ?? null, changedPaths: input.changedPaths ?? [], error: input.error ?? null });
export type Verification = { id: string; runId: string; kind: string; status: string; summary: string; evidence: unknown; source: string; createdAt: number };
export const listVerifications = (runId: string) => invoke<Verification[]>("verification_list", { runId });
export const recordVerification = (input: { runId: string; kind: string; status: "passed" | "failed" | "unknown" | "accepted" | "rejected"; summary: string; evidence?: unknown; source?: string }) =>
  invoke<Verification>("verification_record", { input: { ...input, evidence: input.evidence ?? {}, source: input.source ?? "workflow_ui" } });
export const listProposals = (status?: string) => invoke<Proposal[]>("proposal_list", { status });
export const proposalFromSession = (sessionId: string, title: string, excerpt?: string) =>
  invoke<Proposal>("proposal_from_session", { sessionId, title, excerpt });
export const decideProposal = (id: string, decision: string, decidedBy: string, expectedVersion: number) => invoke<Proposal>("proposal_decide", { id, decision, decidedBy, expectedVersion });
