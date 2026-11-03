//! 对话面板的事件形状。前端 `src/lib/acp.ts` 的 reducer 一一对应。
//!
//! 和 Rig 应用助手的 `agent-event` 分开：那是进程内助手自己的消息模型，这里的
//! `update` 基本是 ACP `session/update` 的原样 JSON，另加几种面板自己需要的事件。

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// 事件名，与 `src/lib/acp.ts` 对齐。
pub(crate) const EVENT_NAME: &str = "acp-event";

/// 一个对话后端（一家 CLI + 一个工作区）的启动结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpInfo {
    pub provider: String,
    /// Agent 自报的名字 / 版本（initialize 响应）
    pub agent_name: String,
    pub agent_version: String,
    /// ACP session id（不是终端 CLI 自己的会话 id）
    pub session_id: String,
    /// 实际 cwd，展示用
    pub cwd: String,
    /// 这次启动是不是恢复出来的旧会话
    pub resumed: bool,
    /// Agent 是否支持 `session/load`（带历史重放）
    pub can_load: bool,
    /// Agent 是否支持 `session/resume`（不带历史重放）
    pub can_resume: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionChoice {
    pub option_id: String,
    pub name: String,
    /// allow_once / allow_always / reject_once / reject_always
    pub kind: String,
}

/// 权限请求里带的工具调用信息。形状就是 ACP `ToolCallUpdate` 的 JSON。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AcpEvent {
    /// initialize + session/new 完成，可以发第一条消息了
    Ready {
        info: AcpInfo,
    },
    /// ACP `session/update` 的原样 JSON（`sessionUpdate` 判别字段在里层）
    Update {
        update: Value,
    },
    /// 需要用户拍板。前端点完按钮调 `acp_respond_permission`
    Permission {
        request_id: String,
        tool_call: Value,
        options: Vec<PermissionChoice>,
    },
    /// 一轮结束。stop_reason 是 ACP `StopReason` 的 JSON 字符串
    PromptDone {
        stop_reason: Value,
    },
    Error {
        message: String,
    },
    /// 子进程退出 / 连接关闭。之后同一 chatId 可以重新 start
    Closed {
        reason: String,
    },
}

/// 前端按 root + chatId 过滤：一个窗口同时开着多个工作区。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tagged {
    root: String,
    chat_id: String,
    event: AcpEvent,
}

pub(crate) fn emit(app: &AppHandle, root: &str, chat_id: &str, event: AcpEvent) {
    let _ = app.emit(
        EVENT_NAME,
        Tagged {
            root: root.to_string(),
            chat_id: chat_id.to_string(),
            event,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_fields_are_camel_case() {
        let event = serde_json::to_value(AcpEvent::PromptDone {
            stop_reason: Value::String("end_turn".to_string()),
        })
        .unwrap();
        assert_eq!(event["type"], "promptDone");
        assert_eq!(event["stopReason"], "end_turn");

        let event = serde_json::to_value(AcpEvent::Permission {
            request_id: "perm_1".to_string(),
            tool_call: Value::Null,
            options: vec![PermissionChoice {
                option_id: "opt_1".to_string(),
                name: "允许一次".to_string(),
                kind: "allow_once".to_string(),
            }],
        })
        .unwrap();
        assert_eq!(event["type"], "permission");
        assert_eq!(event["requestId"], "perm_1");
        assert_eq!(event["toolCall"], Value::Null);
        assert_eq!(event["options"][0]["optionId"], "opt_1");
    }

    #[test]
    fn envelope_carries_root_and_chat_id() {
        let tagged = Tagged {
            root: "D:/code".to_string(),
            chat_id: "chat_1".to_string(),
            event: AcpEvent::Closed {
                reason: "done".to_string(),
            },
        };
        let value = serde_json::to_value(tagged).unwrap();
        assert_eq!(value["root"], "D:/code");
        assert_eq!(value["chatId"], "chat_1");
        assert_eq!(value["event"]["type"], "closed");
        assert_eq!(value["event"]["reason"], "done");
    }
}
