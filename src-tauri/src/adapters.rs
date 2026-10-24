//! M3 Adapter Catalog：四家 Agent 的能力声明、入口模式和安全降级策略。
//!
//! 这里不猜测厂商是否支持某项原生能力；未被版本探测确认的字段保持 false，
//! 统一回退到既有 PTY。真实 SDK/Server 连接器可以在这个契约上逐家替换。

use serde::{Deserialize, Serialize};

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
}

pub fn descriptors() -> Vec<AdapterDescriptor> {
    [
        ("codex", "Codex", "codex"),
        ("opencode", "OpenCode", "opencode"),
        ("claude", "Claude", "claude"),
        ("codebuddy", "CodeBuddy", "codebuddy"),
    ]
    .into_iter()
    .map(|(id, display_name, command)| AdapterDescriptor {
        id: id.into(),
        display_name: display_name.into(),
        command: command.into(),
        modes: vec!["pty".into(), "headless_json".into()],
        capabilities: vec!["stream_text".into(), "interactive_turn".into()],
        fallback_mode: "pty".into(),
        approval_policy: "native_only_else_pty".into(),
    })
    .collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_capabilities_are_not_enabled() {
        let item = adapter_capability_summary("codex".into(), vec![]).unwrap();
        assert!(item.capabilities.is_empty());
        assert_eq!(item.fallback_mode, "pty");
    }
}
