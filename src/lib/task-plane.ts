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
export const listRuns = (taskId?: string) => invoke<TaskRun[]>("task_run_list", { taskId });
export const listProposals = (status?: string) => invoke<Proposal[]>("proposal_list", { status });
export const proposalFromSession = (sessionId: string, title: string, excerpt?: string) =>
  invoke<Proposal>("proposal_from_session", { sessionId, title, excerpt });
export const decideProposal = (id: string, decision: string, decidedBy: string, expectedVersion: number) => invoke<Proposal>("proposal_decide", { id, decision, decidedBy, expectedVersion });
