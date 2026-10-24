//! M3 统一 Agent 协议：消息、工具卡、审批、来源可信度和资源登记。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    Native,
    Observed,
    Inferred,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    User,
    Assistant,
    System,
    Tool,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredMessage {
    pub id: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub kind: MessageKind,
    pub text: String,
    pub source: EvidenceSource,
    pub sequence: Option<i64>,
    pub created_at: i64,
    pub citations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Proposed,
    AwaitingApproval,
    Running,
    Succeeded,
    Failed,
    Rejected,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCard {
    pub id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub status: ToolStatus,
    pub source: EvidenceSource,
    pub requires_approval: bool,
    pub approval_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    Pending,
    Approved,
    Rejected,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub session_id: Option<String>,
    pub tool_id: String,
    pub summary: String,
    pub state: ApprovalState,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedAgentEvent {
    pub schema_version: i64,
    pub event_key: String,
    pub adapter_id: String,
    pub event_type: String,
    pub source: EvidenceSource,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub message: Option<StructuredMessage>,
    pub tool: Option<ToolCard>,
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRecord {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub scope: String,
    pub path: String,
    pub digest: Option<String>,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionInput {
    pub request: ApprovalRequest,
    pub decision: ApprovalState,
}

fn id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

#[tauri::command]
pub fn protocol_normalize_event(event: serde_json::Value) -> Result<NormalizedAgentEvent, String> {
    let adapter_id = event
        .get("adapterId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let event_key = event
        .get("eventKey")
        .and_then(|v| v.as_str())
        .or_else(|| event.get("id").and_then(|v| v.as_str()))
        .unwrap_or("unkeyed")
        .to_string();
    let event_type = event
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let source = match event.get("source").and_then(|v| v.as_str()) {
        Some("native") => EvidenceSource::Native,
        Some("user") => EvidenceSource::User,
        Some("inferred") => EvidenceSource::Inferred,
        _ => EvidenceSource::Observed,
    };
    Ok(NormalizedAgentEvent {
        schema_version: 1,
        event_key,
        adapter_id,
        event_type,
        source,
        session_id: event
            .get("sessionId")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        run_id: event
            .get("runId")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        message: None,
        tool: None,
        raw: event,
    })
}

#[tauri::command]
pub fn protocol_create_approval(
    tool_id: String,
    session_id: Option<String>,
    summary: String,
    expires_at: Option<i64>,
) -> ApprovalRequest {
    ApprovalRequest {
        id: id("approval"),
        session_id,
        tool_id,
        summary,
        state: ApprovalState::Pending,
        expires_at,
    }
}

#[tauri::command]
pub fn protocol_decide_approval(input: PermissionDecisionInput) -> Result<ApprovalRequest, String> {
    if !matches!(
        input.decision,
        ApprovalState::Approved | ApprovalState::Rejected | ApprovalState::TimedOut
    ) {
        return Err("invalid_input: approval decision must be terminal".into());
    }
    let mut request = input.request;
    request.state = input.decision;
    Ok(request)
}

#[tauri::command]
pub fn protocol_resource_conflicts(resources: Vec<ResourceRecord>) -> Vec<ResourceRecord> {
    let mut seen: HashMap<(String, String), String> = HashMap::new();
    let mut out = Vec::new();
    for mut resource in resources {
        let key = (resource.scope.clone(), resource.name.clone());
        if let Some(previous) = seen.insert(key, resource.id.clone()) {
            resource.conflicts.push(previous);
            out.push(resource);
        }
    }
    out
}

#[tauri::command]
pub fn protocol_index_workspace_resources(root: String) -> Result<Vec<ResourceRecord>, String> {
    let root_path = Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("invalid_input: workspace root: {e}"))?;
    let resource_dir = root_path.join(".codovo");
    let entries = [
        ("rules", "rules.md"),
        ("memory", "memory.md"),
        ("skills", "skills.json"),
        ("agents", "agents.json"),
    ];
    let mut resources = Vec::new();
    for (kind, name) in entries {
        let path = resource_dir.join(name);
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("storage_error: {e}"))?;
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut hasher);
        let digest = format!("{:016x}", hasher.finish());
        resources.push(ResourceRecord {
            id: format!("resource_{kind}"),
            kind: kind.into(),
            name: name.into(),
            scope: "workspace".into(),
            path: path.to_string_lossy().into_owned(),
            digest: Some(digest),
            conflicts: Vec::new(),
        });
    }
    Ok(protocol_resource_conflicts(resources))
}

#[tauri::command]
pub fn protocol_sanitize_diagnostics(value: serde_json::Value) -> serde_json::Value {
    fn sanitize(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(mut object) => {
                for (key, item) in object.clone() {
                    let upper = key.to_ascii_uppercase();
                    if upper.contains("TOKEN")
                        || upper.contains("SECRET")
                        || upper.contains("PASSWORD")
                        || upper.contains("API_KEY")
                        || upper.contains("PRIVATE_KEY")
                    {
                        object.insert(key, "[REDACTED]".into());
                    } else {
                        object.insert(key, sanitize(item));
                    }
                }
                serde_json::Value::Object(object)
            }
            serde_json::Value::Array(items) => {
                serde_json::Value::Array(items.into_iter().map(sanitize).collect())
            }
            other => other,
        }
    }
    sanitize(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approvals_cannot_remain_pending_after_decision() {
        let request = protocol_create_approval("shell".into(), None, "run tests".into(), None);
        let result = protocol_decide_approval(PermissionDecisionInput {
            request,
            decision: ApprovalState::Approved,
        })
        .unwrap();
        assert!(matches!(result.state, ApprovalState::Approved));
    }
}
