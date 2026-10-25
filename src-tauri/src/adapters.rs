//! M3 Adapter Catalog：四家 Agent 的能力声明、入口模式和安全降级策略。
//!
//! 这里不猜测厂商是否支持某项原生能力；未被版本探测确认的字段保持 false，
//! 统一回退到既有 PTY。真实 SDK/Server 连接器可以在这个契约上逐家替换。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::runtime::{runtime_start, RuntimeEvent, RuntimeState};
use crate::agent_protocol::{protocol_normalize_event, NormalizedAgentEvent};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterDescriptor {
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub modes: Vec<String>,
    pub capabilities: Vec<String>,
    pub fallback_mode: String,
    pub approval_policy: String,
    pub structured_args: Vec<String>,
}

pub fn descriptors() -> Vec<AdapterDescriptor> {
    vec![
        AdapterDescriptor {
            id: "codex".into(),
            display_name: "Codex".into(),
            command: "codex".into(),
            modes: vec!["pty".into(), "headless_json".into()],
            capabilities: vec![
                "stream_text".into(),
                "interactive_turn".into(),
                "session_resume".into(),
            ],
            fallback_mode: "pty".into(),
            approval_policy: "native_only_else_pty".into(),
            structured_args: vec!["exec".into(), "--json".into()],
        },
        AdapterDescriptor {
            id: "opencode".into(),
            display_name: "OpenCode".into(),
            command: "opencode".into(),
            modes: vec!["pty".into(), "server".into()],
            capabilities: vec![
                "stream_text".into(),
                "interactive_turn".into(),
                "persistent_session".into(),
            ],
            fallback_mode: "pty".into(),
            approval_policy: "native_only_else_pty".into(),
            structured_args: vec!["--server".into()],
        },
        AdapterDescriptor {
            id: "claude".into(),
            display_name: "Claude".into(),
            command: "claude".into(),
            modes: vec!["pty".into(), "headless_json".into()],
            capabilities: vec![
                "stream_text".into(),
                "interactive_turn".into(),
                "session_resume".into(),
            ],
            fallback_mode: "pty".into(),
            approval_policy: "native_only_else_pty".into(),
            structured_args: vec![
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
            ],
        },
        AdapterDescriptor {
            id: "codebuddy".into(),
            display_name: "CodeBuddy".into(),
            command: "codebuddy".into(),
            modes: vec![
                "pty".into(),
                "headless_json".into(),
                "acp".into(),
                "server".into(),
            ],
            capabilities: vec![
                "stream_text".into(),
                "interactive_turn".into(),
                "session_resume".into(),
                "native_subagents".into(),
            ],
            fallback_mode: "pty".into(),
            approval_policy: "native_only_else_pty".into(),
            structured_args: vec![
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
            ],
        },
    ]
}

#[tauri::command]
pub fn adapter_catalog() -> Vec<AdapterDescriptor> {
    descriptors()
}

#[tauri::command]
pub fn adapter_capability_summary(
    adapter_id: String,
    verified: Vec<String>,
) -> Result<AdapterDescriptor, String> {
    let mut descriptor = descriptors()
        .into_iter()
        .find(|v| v.id == adapter_id)
        .ok_or_else(|| format!("not_found: adapter {adapter_id}"))?;
    descriptor
        .capabilities
        .retain(|v| verified.iter().any(|item| item == v));
    descriptor.capabilities.sort();
    Ok(descriptor)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStartInput {
    pub adapter_id: String,
    pub owner: String,
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub mode: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// 启动真实 CLI，但不替调用方注入危险的免审批参数；结构化能力由探测结果另行决定。
#[tauri::command]
pub fn adapter_start(
    state: tauri::State<'_, RuntimeState>,
    on_event: Channel<RuntimeEvent>,
    input: AdapterStartInput,
) -> Result<u64, String> {
    let descriptor = descriptors()
        .into_iter()
        .find(|item| item.id == input.adapter_id)
        .ok_or_else(|| format!("not_found: adapter {}", input.adapter_id))?;
    let mode = input
        .mode
        .unwrap_or_else(|| descriptor.fallback_mode.clone());
    if mode != "pty" && mode != "headless_json" {
        return Err("unsupported_capability: adapter mode".into());
    }
    let program = input.program.unwrap_or(descriptor.command);
    let mut args = input.args;
    if mode == "headless_json" || mode == "server" {
        let mut structured = descriptor.structured_args.clone();
        structured.retain(|arg| !args.iter().any(|existing| existing == arg));
        structured.extend(args);
        args = structured;
    }
    runtime_start(
        state,
        on_event,
        input.owner,
        program,
        args,
        input.cwd,
        input.timeout_ms,
    )
}

#[tauri::command]
pub fn adapter_normalize_output(adapter_id: String, line: String) -> Result<NormalizedAgentEvent, String> {
    let descriptor = descriptors().into_iter().find(|item| item.id == adapter_id).ok_or_else(|| format!("not_found: adapter {adapter_id}"))?;
    let value: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| format!("transport_error: structured output is not JSON: {e}"))?;
    let mut event = protocol_normalize_event(value)?;
    event.adapter_id = descriptor.id;
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_capabilities_are_not_enabled() {
        let item = adapter_capability_summary("codex".into(), vec![]).unwrap();
        assert!(item.capabilities.is_empty());
        assert_eq!(item.fallback_mode, "pty");
    }

    #[test]
    fn structured_output_is_normalized_with_catalog_adapter() {
        let event = adapter_normalize_output(
            "codex".into(),
            r#"{"type":"message.delta","eventKey":"x"}"#.into(),
        )
        .unwrap();
        assert_eq!(event.adapter_id, "codex");
        assert_eq!(event.event_key, "x");
    }
}
