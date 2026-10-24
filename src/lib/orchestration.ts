import { invoke } from "@tauri-apps/api/core";

export type ProposalCandidate = { id: string; title: string; description: string; source: string; sourceRef?: string | null; parentId?: string | null; dependsOn: string[]; acceptance: string[]; confidence: number };
export type PlannerPlan = { goalId: string; candidates: ProposalCandidate[] };
export type OrchestrationPolicy = { creationPolicy: string; maxConcurrent: number; maxRetries: number; timeoutMs: number; budgetUnits: number; requireApproval: boolean };
export const validatePlannerPlan = (plan: PlannerPlan) => invoke<PlannerPlan>("orchestration_validate_plan", { plan });
export const readyCandidates = (plan: PlannerPlan, completed: string[], active: number, policy: OrchestrationPolicy) => invoke<ProposalCandidate[]>("orchestration_ready_candidates", { plan, completed, active, policy });
export const defaultOrchestrationPolicy = () => invoke<OrchestrationPolicy>("orchestration_policy_default");
export const verifyRun = (runId: string, checks: Array<{ name: string; status: string; output: string }>, createRepairProposal: boolean) => invoke("orchestration_verify", { runId, checks, createRepairProposal });
