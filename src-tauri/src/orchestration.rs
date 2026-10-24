//! M4 长程任务编排：Proposal Pipeline、Planner DAG、Handoff、预算和 Verifier。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalSource {
    Manual,
    Conversation,
    Agent,
    Planner,
    Import,
    Execution,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreationPolicy {
    Manual,
    Assisted,
    AutonomousLimited,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunRole {
    Planner,
    Developer,
    Reviewer,
    Verifier,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalCandidate {
    pub id: String,
    pub title: String,
    pub description: String,
    pub source: ProposalSource,
    pub source_ref: Option<String>,
    pub parent_id: Option<String>,
    pub depends_on: Vec<String>,
    pub acceptance: Vec<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerPlan {
    pub goal_id: String,
    pub candidates: Vec<ProposalCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationPolicy {
    pub creation_policy: CreationPolicy,
    pub max_concurrent: u32,
    pub max_retries: u32,
    pub timeout_ms: u64,
    pub budget_units: u64,
    pub require_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffPackage {
    pub task_id: String,
    pub from_run_id: String,
    pub to_adapter_id: String,
    pub role: RunRole,
    pub summary: String,
    pub constraints: Vec<String>,
    pub evidence: Vec<EvidenceRef>,
    pub native_session_preserved: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    pub kind: String,
    pub source: String,
    pub value: serde_json::Value,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub run_id: String,
    pub status: String,
    pub checks: Vec<CheckResult>,
    pub derived_proposal: Option<ProposalCandidate>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    pub name: String,
    pub status: String,
    pub output: String,
}

fn id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

pub fn validate_plan(plan: &PlannerPlan) -> Result<(), String> {
    if plan.goal_id.trim().is_empty() {
        return Err("invalid_input: goal_id".into());
    }
    let ids: HashSet<&str> = plan.candidates.iter().map(|v| v.id.as_str()).collect();
    if ids.len() != plan.candidates.len() {
        return Err("conflict: duplicate proposal id".into());
    }
    for item in &plan.candidates {
        if item.title.trim().is_empty() || item.acceptance.is_empty() {
            return Err(format!(
                "invalid_input: proposal {} requires title and acceptance",
                item.id
            ));
        }
        if item
            .depends_on
            .iter()
            .any(|dep| !ids.contains(dep.as_str()))
        {
            return Err(format!("invalid_input: unknown dependency in {}", item.id));
        }
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for item in &plan.candidates {
        visit(&item.id, plan, &mut visiting, &mut visited)?;
    }
    Ok(())
}
fn visit(
    id: &str,
    plan: &PlannerPlan,
    visiting: &mut HashSet<String>,
    visited: &mut HashSet<String>,
) -> Result<(), String> {
    if visited.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id.to_string()) {
        return Err("invalid_input: planner dependency cycle".into());
    }
    let node = plan
        .candidates
        .iter()
        .find(|v| v.id == id)
        .ok_or("invalid_input: missing proposal")?;
    for dep in &node.depends_on {
        visit(dep, plan, visiting, visited)?;
    }
    visiting.remove(id);
    visited.insert(id.to_string());
    Ok(())
}

pub fn ready_candidates(
    plan: &PlannerPlan,
    completed: &HashSet<String>,
    active: usize,
    policy: &OrchestrationPolicy,
) -> Vec<ProposalCandidate> {
    if active >= policy.max_concurrent as usize {
        return Vec::new();
    }
    plan.candidates
        .iter()
        .filter(|v| {
            !completed.contains(&v.id) && v.depends_on.iter().all(|dep| completed.contains(dep))
        })
        .take(policy.max_concurrent as usize - active)
        .cloned()
        .collect()
}

#[tauri::command]
pub fn orchestration_validate_plan(plan: PlannerPlan) -> Result<PlannerPlan, String> {
    validate_plan(&plan)?;
    Ok(plan)
}

#[tauri::command]
pub fn orchestration_ready_candidates(
    plan: PlannerPlan,
    completed: Vec<String>,
    active: u32,
    policy: OrchestrationPolicy,
) -> Result<Vec<ProposalCandidate>, String> {
    validate_plan(&plan)?;
    Ok(ready_candidates(
        &plan,
        &completed.into_iter().collect(),
        active as usize,
        &policy,
    ))
}

#[tauri::command]
pub fn orchestration_dedupe(candidates: Vec<ProposalCandidate>) -> Vec<ProposalCandidate> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|v| seen.insert(v.title.trim().to_lowercase()))
        .collect()
}

#[tauri::command]
pub fn orchestration_handoff(
    task_id: String,
    from_run_id: String,
    to_adapter_id: String,
    role: RunRole,
    summary: String,
    constraints: Vec<String>,
    evidence: Vec<EvidenceRef>,
) -> HandoffPackage {
    HandoffPackage {
        task_id,
        from_run_id,
        to_adapter_id,
        role,
        summary,
        constraints,
        evidence,
        native_session_preserved: false,
    }
}

#[tauri::command]
pub fn orchestration_verify(
    run_id: String,
    checks: Vec<CheckResult>,
    create_repair_proposal: bool,
) -> VerificationResult {
    let failed = checks.iter().any(|v| v.status == "failed");
    let derived = if failed && create_repair_proposal {
        Some(ProposalCandidate {
            id: id("repair"),
            title: "修复验证失败项".into(),
            description: "由 Verifier 根据失败检查派生，仍需人工批准".into(),
            source: ProposalSource::Execution,
            source_ref: Some(run_id.clone()),
            parent_id: None,
            depends_on: Vec::new(),
            acceptance: vec!["重新运行失败检查".into()],
            confidence: 1.0,
        })
    } else {
        None
    };
    VerificationResult {
        run_id,
        status: if failed {
            "failed".into()
        } else {
            "passed".into()
        },
        checks,
        derived_proposal: derived,
    }
}

#[tauri::command]
pub fn orchestration_policy_default() -> OrchestrationPolicy {
    OrchestrationPolicy {
        creation_policy: CreationPolicy::Manual,
        max_concurrent: 1,
        max_retries: 2,
        timeout_ms: 900_000,
        budget_units: 100,
        require_approval: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(id: &str, dep: Vec<&str>) -> ProposalCandidate {
        ProposalCandidate {
            id: id.into(),
            title: id.into(),
            description: id.into(),
            source: ProposalSource::Planner,
            source_ref: None,
            parent_id: None,
            depends_on: dep.into_iter().map(str::to_owned).collect(),
            acceptance: vec!["check".into()],
            confidence: 1.0,
        }
    }
    #[test]
    fn planner_rejects_cycles() {
        let plan = PlannerPlan {
            goal_id: "g".into(),
            candidates: vec![item("a", vec!["b"]), item("b", vec!["a"])],
        };
        assert!(validate_plan(&plan).is_err());
    }
    #[test]
    fn verifier_does_not_claim_failed() {
        let result = orchestration_verify(
            "r".into(),
            vec![CheckResult {
                name: "test".into(),
                status: "failed".into(),
                output: "x".into(),
            }],
            true,
        );
        assert_eq!(result.status, "failed");
        assert!(result.derived_proposal.is_some());
    }
}
