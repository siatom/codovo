import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconPlus,
  IconRefresh,
  IconSend,
  IconTarget,
} from "./icons";
import {
  defaultOrchestrationPolicy,
  storePlan,
  transitionWorkflow,
  type OrchestrationPolicy,
  type PlannerPlan,
  type ProposalCandidate,
} from "../lib/orchestration";
import {
  addTaskDependency,
  decideProposal,
  listTaskDependencies,
  listProposals,
  type Proposal,
} from "../lib/task-plane";
import {
  listAgentRegistry,
  listAgentSessions,
  listControlEvents,
  type AgentInstallation,
  type AgentSessionRecord,
  type ExecutionEventEnvelope,
} from "../lib/control-plane";
import { cancelRuntime, listAdapters, startAdapter, type AdapterDescriptor, type RuntimeEvent } from "../lib/adapters";
import {
  listGoals,
  listRuns,
  listTasks,
  listVerifications,
  recordVerification,
  taskRunStart,
  taskRunFinish,
  transitionTask,
  upsertGoal,
  upsertTask,
  type Goal,
  type Task,
  type TaskRun,
  type Verification,
} from "../lib/task-plane";

interface WorkflowPaneProps {
  root: string;
  visible: boolean;
}

const WORKFLOW_STEPS = [
  { id: "planner", label: "规划", hint: "拆解目标与依赖" },
  { id: "developer", label: "执行", hint: "分配任务给 Agent" },
  { id: "reviewer", label: "审阅", hint: "检查改动与证据" },
  { id: "verifier", label: "验收", hint: "运行验收检查" },
  { id: "done", label: "完成", hint: "归档交付结果" },
] as const;

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  ready: "就绪",
  blocked: "阻塞",
  running: "执行中",
  waiting: "等待",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};

const BUTTON = "inline-flex items-center justify-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";
const INPUT = "min-w-0 rounded-md border border-line bg-input px-2 py-1.5 text-[11px] text-fg outline-none placeholder:text-fg-faint focus:border-accent";

function errorText(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}

function nextWorkflowState(current: string): string | null {
  const index = WORKFLOW_STEPS.findIndex((step) => step.id === current);
  return index >= 0 && index < WORKFLOW_STEPS.length - 1 ? WORKFLOW_STEPS[index + 1].id : null;
}

export function WorkflowPane({ root, visible }: WorkflowPaneProps) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [installations, setInstallations] = useState<AgentInstallation[]>([]);
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [events, setEvents] = useState<ExecutionEventEnvelope[]>([]);
  const [adapters, setAdapters] = useState<AdapterDescriptor[]>([]);
  const [selectedAdapterId, setSelectedAdapterId] = useState("codex");
  const [runtimeId, setRuntimeId] = useState<number | null>(null);
  const [runtimeOutput, setRuntimeOutput] = useState<string[]>([]);
  const [policy, setPolicy] = useState<OrchestrationPolicy | null>(null);
  const [workflowState, setWorkflowState] = useState("planner");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [dependencies, setDependencies] = useState<Record<string, string[]>>({});
  const [goalTitle, setGoalTitle] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDependency, setTaskDependency] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    tasks: true,
    plan: true,
    proposals: false,
    runs: false,
    runtime: true,
  });

  const selectedGoal = goals.find((goal) => goal.id === selectedGoalId) ?? goals[0] ?? null;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  const refresh = useCallback(async () => {
    if (!visible) return;
    setBusy(true);
    try {
      const [nextGoals, nextPolicy, nextProposals, nextInstallations, nextSessions, nextEvents, nextAdapters] = await Promise.all([
        listGoals(),
        defaultOrchestrationPolicy(),
        listProposals("pending"),
        listAgentRegistry().catch(() => []),
        listAgentSessions(root).catch(() => []),
        listControlEvents({ limit: 30 }).catch(() => []),
        listAdapters().catch(() => []),
      ]);
      setGoals(nextGoals);
      setPolicy(nextPolicy);
      setProposals(nextProposals);
      setInstallations(nextInstallations);
      setSessions(nextSessions);
      setEvents(nextEvents);
      setAdapters(nextAdapters);
      if (!nextAdapters.some((adapter) => adapter.id === selectedAdapterId)) setSelectedAdapterId(nextAdapters[0]?.id ?? "codex");
      const goalId = selectedGoalId ?? nextGoals[0]?.id ?? null;
      setSelectedGoalId(goalId);
      const nextTasks = goalId ? await listTasks(goalId) : [];
      setTasks(nextTasks);
      const dependencyEntries = await Promise.all(
        nextTasks.map(async (task) => [task.id, await listTaskDependencies(task.id)] as const),
      );
      setDependencies(Object.fromEntries(dependencyEntries));
      const taskId = selectedTaskId && nextTasks.some((task) => task.id === selectedTaskId)
        ? selectedTaskId
        : nextTasks[0]?.id ?? null;
      setSelectedTaskId(taskId);
      if (taskId) {
        const nextRuns = await listRuns(taskId);
        setRuns(nextRuns);
        setVerifications(nextRuns[0] ? await listVerifications(nextRuns[0].id) : []);
      } else {
        setRuns([]);
        setVerifications([]);
      }
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [root, selectedAdapterId, selectedGoalId, selectedTaskId, visible]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const plan: PlannerPlan | null = useMemo(() => {
    if (!selectedGoal) return null;
    const candidates: ProposalCandidate[] = tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      source: "manual",
      sourceRef: task.id,
      parentId: task.parentId,
      dependsOn: dependencies[task.id] ?? [],
      acceptance: task.acceptance.length > 0 ? task.acceptance : ["任务完成并通过验收"],
      confidence: 1,
    }));
    return { goalId: selectedGoal.id, candidates };
  }, [dependencies, selectedGoal, tasks]);

  const runAction = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const createGoal = () => {
    const title = goalTitle.trim();
    if (!title) return;
    void runAction(async () => {
      const goal = await upsertGoal({ title, description: "" });
      setSelectedGoalId(goal.id);
      setGoalTitle("");
    }, "目标已创建");
  };

  const createTask = () => {
    const title = taskTitle.trim();
    if (!title || !selectedGoal) return;
    void runAction(async () => {
      const task = await upsertTask({ goalId: selectedGoal.id, title, description: "", acceptance: [] });
      if (taskDependency) await addTaskDependency(task.id, taskDependency);
      setTaskTitle("");
      setTaskDependency("");
    }, "任务已加入规划");
  };

  const advanceWorkflow = () => {
    const next = nextWorkflowState(workflowState);
    if (!next) return;
    void runAction(async () => {
      await transitionWorkflow(workflowState, next);
      setWorkflowState(next);
    }, `工作流已进入「${WORKFLOW_STEPS.find((step) => step.id === next)?.label}」`);
  };

  const savePlan = () => {
    if (!plan || !policy) return;
    void runAction(
      () => storePlan(`plan_${selectedGoal?.id ?? "current"}`, plan, policy),
      "规划已保存",
    );
  };

  const startSelectedTask = () => {
    if (!selectedTask || selectedTask.status !== "ready") return;
    void runAction(async () => {
      const run = await taskRunStart({ taskId: selectedTask.id, baselineDirty: false });
      const adapter = adapters.find((item) => item.id === selectedAdapterId);
      let finished = false;
      const finish = (status: "succeeded" | "failed" | "cancelled", error?: string) => {
        if (finished) return;
        finished = true;
        void taskRunFinish({ runId: run.id, status, error });
      };
      let id: number;
      try {
        id = await startAdapter(
          {
            adapterId: selectedAdapterId,
            owner: `workflow:${root}`,
            program: adapter?.command,
            args: [selectedTask.title],
            cwd: root,
            mode: "headless_json",
            timeoutMs: policy?.timeoutMs,
          },
          (event: RuntimeEvent) => {
            if (event.type === "started") setRuntimeId(event.id);
            if (event.type === "output") setRuntimeOutput((current) => [...current.slice(-19), event.data.trim()].filter(Boolean));
            if (event.type === "exited") finish(event.code === 0 ? "succeeded" : "failed", event.code === 0 ? undefined : `Agent 退出码 ${event.code ?? "未知"}`);
            if (event.type === "cancelled") finish("cancelled", "用户停止了 Agent");
            if (event.type === "timedOut") finish("failed", "Agent 运行超时");
            if (event.type === "exited" || event.type === "cancelled" || event.type === "timedOut") setRuntimeId(null);
          },
        );
      } catch (error) {
        finish("failed", errorText(error));
        throw error;
      }
      setRuntimeId(id);
    }, "任务已派发给 Agent");
  };

  const markTaskReady = () => {
    if (!selectedTask || selectedTask.status !== "draft") return;
    void runAction(
      () => transitionTask(selectedTask.id, "ready", selectedTask.version),
      "任务已标记为就绪",
    );
  };

  const recordAcceptance = (status: "passed" | "failed") => {
    if (!runs[0]) return;
    void runAction(
      () => recordVerification({ runId: runs[0].id, kind: "manual_acceptance", status, summary: status === "passed" ? "工作流面板手工验收通过" : "工作流面板手工验收失败" }),
      status === "passed" ? "验收已通过" : "验收已记录为失败",
    );
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-content text-fg">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <IconTarget className="h-3.5 w-3.5 text-accent" />
        <span className="text-[11px] font-medium tracking-wide">工作流</span>
        <span className="text-[10px] text-fg-faint">{root.split(/[\\/]/).pop() ?? root}</span>
        <button type="button" className={`${BUTTON} ml-auto border-0 px-1.5`} onClick={() => void refresh()} title="刷新" disabled={busy}>
          <IconRefresh className={busy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {message && <div className="mb-2 rounded-md border border-line bg-surface-raised px-2 py-1.5 text-[10px] text-fg-muted">{message}</div>}

        <div className="mb-3 rounded-lg border border-line bg-surface-raised p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium">流程进度</span>
            <span className="text-[10px] text-fg-faint">{WORKFLOW_STEPS.find((step) => step.id === workflowState)?.hint}</span>
          </div>
          <div className="flex items-center">
            {WORKFLOW_STEPS.map((step, index) => {
              const active = step.id === workflowState;
              const complete = WORKFLOW_STEPS.findIndex((item) => item.id === workflowState) > index;
              return (
                <div key={step.id} className="flex min-w-0 flex-1 items-center">
                  <div className={`flex min-w-0 flex-col items-center gap-1 ${active ? "text-accent" : complete ? "text-success" : "text-fg-faint"}`}>
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] ${active ? "border-accent bg-accent/10" : complete ? "border-success/60" : "border-line"}`}>
                      {complete ? <IconCheck className="h-3 w-3" /> : index + 1}
                    </span>
                    <span className="truncate text-[10px]">{step.label}</span>
                  </div>
                  {index < WORKFLOW_STEPS.length - 1 && <span className={`mx-1 h-px flex-1 ${complete ? "bg-success/60" : "bg-line"}`} />}
                </div>
              );
            })}
          </div>
          <button type="button" className={`${BUTTON} mt-3 w-full`} onClick={advanceWorkflow} disabled={busy || !nextWorkflowState(workflowState)}>
            <IconSend className="h-3 w-3" /> 推进到下一阶段
          </button>
        </div>

        <div className="mb-2 flex gap-2">
          <input className={`${INPUT} flex-1`} value={goalTitle} onChange={(event) => setGoalTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && createGoal()} placeholder="新建目标…" />
          <button type="button" className={BUTTON} onClick={createGoal} disabled={busy || !goalTitle.trim()}><IconPlus className="h-3 w-3" />目标</button>
        </div>
        <select className={`${INPUT} mb-3 w-full`} value={selectedGoal?.id ?? ""} onChange={(event) => { setSelectedGoalId(event.target.value || null); setSelectedTaskId(null); }}>
          <option value="">选择一个目标</option>
          {goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title} · {goal.status}</option>)}
        </select>

        <Section title="运行态" open={expanded.runtime} onToggle={() => setExpanded((value) => ({ ...value, runtime: !value.runtime }))}>
          <div className="mb-2 flex items-center justify-between text-[10px] text-fg-faint">
            <span>Agent {installations.length} 个 · Session {sessions.length} 条</span>
            <span>{events.length} 条事件</span>
          </div>
          {installations.length > 0 && <div className="mb-2 grid grid-cols-2 gap-1.5">{installations.slice(0, 4).map((item) => <div key={item.adapterId} className="rounded border border-line px-2 py-1.5"><div className="truncate text-[10px] text-fg">{item.adapterId}</div><div className="mt-0.5 text-[9px] text-fg-faint">{item.version ?? "版本未知"} · {item.auth === "ready" ? "已认证" : item.auth === "unavailable" ? "未安装" : "未核实"}</div></div>)}</div>}
          {sessions.length > 0 && <div className="mb-2 space-y-1">{sessions.slice(0, 3).map((session) => <div key={session.id} className="flex items-center justify-between text-[10px] text-fg-muted"><span className="truncate">{session.nativeSessionId ?? session.id}</span><span className="ml-2 shrink-0 text-fg-faint">{session.status}</span></div>)}</div>}
          {runtimeId !== null && <div className="mb-2 rounded border border-accent/40 bg-accent/5 px-2 py-1.5 text-[10px] text-accent">进程 #{runtimeId} 正在运行</div>}
          {runtimeOutput.length > 0 && <pre className="mb-2 max-h-28 overflow-auto rounded border border-line bg-input p-2 text-[9px] leading-4 text-fg-muted">{runtimeOutput.join("\n")}</pre>}
          {events.length === 0 ? <p className="text-[10px] text-fg-faint">暂无结构化运行事件</p> : <div className="max-h-36 space-y-1 overflow-y-auto">{events.slice(0, 12).map((event) => <div key={event.eventKey} className="rounded border border-line px-2 py-1.5"><div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] text-fg">{event.eventType}</span><span className="shrink-0 text-[9px] text-fg-faint">{event.source}</span></div><div className="mt-0.5 truncate text-[9px] text-fg-faint">{event.adapterId}{event.sessionId ? ` · ${event.sessionId}` : ""}</div></div>)}</div>}
        </Section>

        <Section title="任务 DAG" open={expanded.tasks} onToggle={() => setExpanded((value) => ({ ...value, tasks: !value.tasks }))}>
          <div className="mb-2 flex gap-2">
            <input className={`${INPUT} flex-1`} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && createTask()} placeholder={selectedGoal ? "添加任务…" : "先选择目标"} disabled={!selectedGoal} />
            <button type="button" className={BUTTON} onClick={createTask} disabled={busy || !selectedGoal || !taskTitle.trim()}><IconPlus className="h-3 w-3" />任务</button>
          </div>
          <select className={`${INPUT} mb-2 w-full`} value={taskDependency} onChange={(event) => setTaskDependency(event.target.value)} disabled={!selectedGoal || tasks.length === 0}>
            <option value="">依赖任务（可选）</option>
            {tasks.filter((task) => task.id !== selectedTaskId).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
          {tasks.length === 0 ? <p className="py-2 text-[10px] text-fg-faint">还没有任务。先添加任务，规划会自动形成。</p> : <div className="space-y-1.5">
            {tasks.map((task) => {
              const selected = task.id === selectedTaskId;
              const taskDependencies = dependencies[task.id] ?? [];
              return <button key={task.id} type="button" onClick={() => setSelectedTaskId(task.id)} className={`w-full rounded-md border px-2.5 py-2 text-left ${selected ? "border-accent/60 bg-accent/5" : "border-line hover:bg-hover"}`}>
                <div className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${task.status === "succeeded" ? "bg-success" : task.status === "failed" ? "bg-danger" : task.status === "running" ? "bg-accent" : "bg-fg-faint"}`} /><span className="min-w-0 flex-1 truncate text-[11px] text-fg">{task.title}</span><span className="text-[10px] text-fg-faint">{STATUS_LABEL[task.status] ?? task.status}</span></div>
                {taskDependencies.length > 0 && <div className="mt-1 pl-3.5 text-[9px] text-fg-faint">← {taskDependencies.map((id) => tasks.find((item) => item.id === id)?.title ?? id).join("、")}</div>}
              </button>;
            })}
          </div>}
          {selectedTask && <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-2">
            {selectedTask.status === "draft" && <button type="button" className={BUTTON} onClick={markTaskReady} disabled={busy}><IconCheck className="h-3 w-3" />标记就绪</button>}
            {selectedTask.status === "ready" && <>
              <select className={`${INPUT} max-w-[120px]`} value={selectedAdapterId} onChange={(event) => setSelectedAdapterId(event.target.value)} disabled={busy || adapters.length === 0}>
                {adapters.map((adapter) => <option key={adapter.id} value={adapter.id}>{adapter.displayName}</option>)}
              </select>
              <button type="button" className={BUTTON} onClick={startSelectedTask} disabled={busy || runtimeId !== null}><IconSend className="h-3 w-3" />派发执行</button>
            </>}
            {runtimeId !== null && <button type="button" className={BUTTON} onClick={() => void cancelRuntime(runtimeId)}><IconClose className="h-3 w-3" />停止</button>}
            <span className="ml-auto text-[9px] text-fg-faint">v{selectedTask.version}</span>
          </div>}
        </Section>

        <Section title="规划与策略" open={expanded.plan} onToggle={() => setExpanded((value) => ({ ...value, plan: !value.plan }))}>
          {plan && <>
            <div className="mb-2 flex items-center justify-between text-[10px] text-fg-faint"><span>{plan.candidates.length} 个候选节点</span><span>{policy?.creationPolicy ?? "manual"} · 并发 {policy?.maxConcurrent ?? "-"}</span></div>
            <div className="space-y-1">{plan.candidates.map((candidate, index) => <div key={candidate.id} className="rounded border border-line px-2 py-1.5"><div className="flex items-center gap-2"><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[9px] text-accent">{index + 1}</span><span className="min-w-0 flex-1 truncate text-[10px]">{candidate.title}</span><span className="text-[9px] text-fg-faint">{candidate.acceptance.length} 项验收</span></div>{candidate.dependsOn.length > 0 && <div className="mt-1 pl-6 text-[9px] text-fg-faint">依赖：{candidate.dependsOn.map((id) => tasks.find((task) => task.id === id)?.title ?? id).join("、")}</div>}</div>)}</div>
            <button type="button" className={`${BUTTON} mt-2 w-full`} onClick={savePlan} disabled={busy || !policy || plan.candidates.length === 0}><IconCheck className="h-3 w-3" />保存编排计划</button>
          </>}
        </Section>

        <Section title={`待审批提案${proposals.length ? ` · ${proposals.length}` : ""}`} open={expanded.proposals} onToggle={() => setExpanded((value) => ({ ...value, proposals: !value.proposals }))}>
          {proposals.length === 0 ? <p className="text-[10px] text-fg-faint">暂无待审批提案</p> : <div className="space-y-2">{proposals.map((proposal) => <div key={proposal.id} className="rounded border border-line px-2 py-2"><div className="text-[11px] text-fg">{proposal.title}</div><div className="mt-1 text-[9px] text-fg-faint">{proposal.kind} · 来源 {proposal.source}</div><div className="mt-2 flex gap-1"><button type="button" className={BUTTON} onClick={() => void runAction(() => decideProposal(proposal.id, "approved", "user", proposal.version), "提案已批准")} disabled={busy}><IconCheck className="h-3 w-3" />批准</button><button type="button" className={BUTTON} onClick={() => void runAction(() => decideProposal(proposal.id, "rejected", "user", proposal.version), "提案已拒绝")} disabled={busy}><IconClose className="h-3 w-3" />拒绝</button></div></div>)}</div>}
        </Section>

        <Section title={`运行与验收${runs.length ? ` · ${runs.length}` : ""}`} open={expanded.runs} onToggle={() => setExpanded((value) => ({ ...value, runs: !value.runs }))}>
          {!selectedTask ? (
            <p className="text-[10px] text-fg-faint">选择任务查看运行记录</p>
          ) : runs.length === 0 ? (
            <p className="text-[10px] text-fg-faint">该任务还没有运行</p>
          ) : (
            <div className="space-y-1.5">
              {runs.slice(0, 5).map((run) => (
                <div key={run.id} className="rounded border border-line px-2 py-1.5 text-[10px]">
                  <div className="flex justify-between"><span>第 {run.attemptNo} 次 · {STATUS_LABEL[run.status] ?? run.status}</span><span className="text-fg-faint">{run.finalSha?.slice(0, 8) ?? "未提交"}</span></div>
                  {run.error && <div className="mt-1 text-danger">{run.error}</div>}
                </div>
              ))}
              {verifications.length > 0 && <div className="border-t border-line pt-1 text-[10px] text-fg-muted">验收：{verifications.map((item) => `${item.kind}/${item.status}`).join("、")}</div>}
              <div className="flex gap-1 border-t border-line pt-2">
                <button type="button" className={BUTTON} onClick={() => recordAcceptance("passed")} disabled={busy || runs[0].status === "running"}><IconCheck className="h-3 w-3" />验收通过</button>
                <button type="button" className={BUTTON} onClick={() => recordAcceptance("failed")} disabled={busy || runs[0].status === "running"}><IconClose className="h-3 w-3" />验收失败</button>
              </div>
            </div>
          )}
        </Section>
      </div>
    </section>
  );
}

function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return <section className="mb-2 rounded-lg border border-line bg-surface-raised"><button type="button" className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-[11px] font-medium" onClick={onToggle}>{open ? <IconChevronDown className="h-3 w-3 text-fg-faint" /> : <IconChevronRight className="h-3 w-3 text-fg-faint" />}{title}</button>{open && <div className="border-t border-line px-2.5 py-2.5">{children}</div>}</section>;
}
