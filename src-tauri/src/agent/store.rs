//! 会话存储：一个会话一个目录，里面是 rig-memory 的 `DirStore`。
//!
//! 布局（`<配置目录>/agent-sessions/<工作区哈希>/<会话 id>/`）：
//! - `logs/main.jsonl`：Rig 写的对话日志，模型的历史靠它
//! - `index.json`：我们自己维护的标题与时间，列表用它，不去折日志
//!
//! 一个 `DirStore` 对应**一个会话**（它的 `meta.json` 是单份的），所以会话之间
//! 用目录隔开，而不是在同一个 store 里放多个日志。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rig_core::completion::Message;
use rig_core::message::{AssistantContent, UserContent};
use rig_memory::{load, DirStore};
use serde::{Deserialize, Serialize};

/// 主 agent 的日志名。一个会话只有一个对话，没有子 agent。
const LOG: &str = "main";

/// 会话索引文件，和 rig 的 `files/` 并列放在会话目录里。
const INDEX: &str = "index.json";

/// 列表里的一条。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    /// 最后活动时间，Unix 毫秒
    pub updated: u64,
}

/// `index.json` 的内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    title: String,
    created: u64,
    updated: u64,
}

/// 一条消息，形状与前端 `AgentMessage` 对齐。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMessage {
    pub id: String,
    /// user / assistant
    pub role: &'static str,
    pub parts: Vec<UiPart>,
}

/// 一条消息里的片段，形状与前端 `AgentPart` 对齐。
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UiPart {
    #[serde(rename = "text")]
    Text {
        id: String,
        #[serde(rename = "messageID")]
        message_id: String,
        text: String,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        #[serde(rename = "messageID")]
        message_id: String,
        text: String,
    },
    #[serde(rename = "tool")]
    Tool {
        id: String,
        #[serde(rename = "messageID")]
        message_id: String,
        #[serde(rename = "callID")]
        call_id: String,
        tool: String,
        state: ToolState,
    },
}

/// 工具调用的状态，字段与前端 `AgentToolState` 对齐。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    /// pending / running / completed / error
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 一个工作区的会话集合。
pub struct SessionStore {
    dir: PathBuf,
}

impl SessionStore {
    /// 指向工作区对应的目录，不存在就建出来。
    pub fn open(dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建会话目录失败：{e}"))?;
        Ok(Self { dir })
    }

    /// 新建一个空会话，返回它的 id。
    pub fn create(&self, title: &str) -> Result<String, String> {
        let id = new_id();
        let dir = self.dir.join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建会话失败：{e}"))?;
        let now = now_ms();
        let index = Index {
            title: title.trim().to_string(),
            created: now,
            updated: now,
        };
        write_index(&dir, &index)?;
        Ok(id)
    }

    /// 列出全部会话，最近的在前。
    pub fn list(&self) -> Result<Vec<SessionSummary>, String> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("读取会话目录失败：{error}")),
        };

        let mut out = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            let dir = entry.path();
            // 索引丢了（手删过、写失败过）就现读一份日志补标题，别让会话从列表里消失
            let index = read_index(&dir).unwrap_or_else(|| {
                let title = self
                    .conversation(&id)
                    .map(|messages| first_user_text(&messages))
                    .unwrap_or_default();
                Index {
                    title,
                    created: 0,
                    updated: file_mtime(&dir),
                }
            });
            out.push(SessionSummary {
                id,
                title: index.title,
                updated: index.updated,
            });
        }
        out.sort_by_key(|item| std::cmp::Reverse(item.updated));
        Ok(out)
    }

    /// 改标题。只动索引，不碰日志。
    pub fn rename(&self, id: &str, title: &str) -> Result<(), String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("会话标题不能为空".to_string());
        }
        let dir = self.session_dir(id)?;
        let mut index = read_index(&dir).unwrap_or(Index {
            title: String::new(),
            created: 0,
            updated: now_ms(),
        });
        index.title = title.to_string();
        index.updated = now_ms();
        write_index(&dir, &index)
    }

    /// 删掉整个会话目录（日志 + 索引 + 锁文件）。
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let dir = self.session_dir(id)?;
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除会话失败：{e}"))
    }

    /// 记录一次活动：更新时间，标题为空时用首条用户消息补上。
    pub fn touch(&self, id: &str, title_hint: Option<&str>) -> Result<(), String> {
        let dir = self.session_dir(id)?;
        let mut index = read_index(&dir).unwrap_or(Index {
            title: String::new(),
            created: now_ms(),
            updated: now_ms(),
        });
        if index.title.trim().is_empty() {
            if let Some(hint) = title_hint.map(str::trim).filter(|hint| !hint.is_empty()) {
                index.title = title_of(hint);
            }
        }
        index.updated = now_ms();
        write_index(&dir, &index)
    }

    /// 会话对应的 rig 存储。Rig 的 `AgentBuilder::memory` 与 `load` 都用它。
    pub fn store(&self, id: &str) -> Result<DirStore, String> {
        let dir = self.session_dir(id)?;
        DirStore::open(&dir).map_err(|e| format!("打开会话存储失败：{e}"))
    }

    /// 读会话历史，转成界面用的消息列表。
    pub fn history(&self, id: &str) -> Result<Vec<UiMessage>, String> {
        self.conversation(id).map(to_ui)
    }

    /// 读会话里的原始消息。
    fn conversation(&self, id: &str) -> Result<Vec<Message>, String> {
        let store = self.store(id)?;
        let conversation = load(&store, LOG).map_err(|e| format!("读取会话失败：{e}"))?;
        Ok(conversation.messages().iter().map(|m| (**m).clone()).collect())
    }

    /// 会话目录，顺便挡住路径穿越（id 由我们自己生成，但仍不信任外部输入）。
    fn session_dir(&self, id: &str) -> Result<PathBuf, String> {
        let valid = !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-' || c == '_');
        if !valid {
            return Err(format!("会话 id 不合法：{id}"));
        }
        let dir = self.dir.join(id);
        if !dir.is_dir() {
            return Err("这个会话已经不存在了".to_string());
        }
        Ok(dir)
    }
}

/// 把 rig 的消息折成界面要的形状。
///
/// 工具结果在 rig 里是**下一条 user 消息**（`UserContent::ToolResult`），而界面上
/// 它属于发起调用的那张工具卡，所以先建卡片、再回填结果。
fn to_ui(messages: Vec<Message>) -> Vec<UiMessage> {
    let mut out: Vec<UiMessage> = Vec::new();
    // callID -> (消息下标, 片段下标)，回填结果时按它定位
    let mut calls: Vec<(String, usize, usize)> = Vec::new();

    for (index, message) in messages.into_iter().enumerate() {
        let id = format!("m{index}");
        match message {
            Message::System { .. } => continue,
            Message::User { content } => {
                let mut parts = Vec::new();
                let mut pending: Vec<(String, String, bool)> = Vec::new();
                for item in content {
                    match item {
                        UserContent::Text(text) => {
                            if text.text.trim().is_empty() {
                                continue;
                            }
                            let part_id = format!("{id}:{}", parts.len());
                            parts.push(UiPart::Text {
                                id: part_id,
                                message_id: id.clone(),
                                text: text.text,
                            });
                        }
                        UserContent::ToolResult(result) => {
                            let call = result.call.to_string();
                            let text = join_result(&result);
                            pending.push((call, text, result.is_error));
                        }
                        // 图片 / 音频 / 文档：当前界面不渲染，直接跳过
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    out.push(UiMessage {
                        id: id.clone(),
                        role: "user",
                        parts,
                    });
                }
                for (call, text, is_error) in pending {
                    fill_result(&mut out, &calls, &call, text, is_error);
                }
            }
            Message::Assistant(assistant) => {
                let mut parts = Vec::new();
                for block in assistant.content {
                    let part_id = format!("{id}:{}", parts.len());
                    match block {
                        AssistantContent::Text(text) => {
                            if text.text.trim().is_empty() {
                                continue;
                            }
                            parts.push(UiPart::Text {
                                id: part_id,
                                message_id: id.clone(),
                                text: text.text,
                            });
                        }
                        AssistantContent::Reasoning(reasoning) => {
                            if reasoning.text.trim().is_empty() {
                                continue;
                            }
                            parts.push(UiPart::Reasoning {
                                id: part_id,
                                message_id: id.clone(),
                                text: reasoning.text,
                            });
                        }
                        AssistantContent::ToolCall(call) => {
                            let call_id = call.id.to_string();
                            let tool = call.function.name.to_string();
                            let input = serde_json::Value::Object(call.function.arguments.clone());
                            calls.push((call_id.clone(), out.len(), parts.len()));
                            parts.push(UiPart::Tool {
                                id: part_id,
                                message_id: id.clone(),
                                call_id,
                                tool,
                                state: ToolState {
                                    status: "completed",
                                    input: Some(input),
                                    output: None,
                                    error: None,
                                },
                            });
                        }
                        // 图片与不认识的 provider 原生块不渲染
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    out.push(UiMessage {
                        id,
                        role: "assistant",
                        parts,
                    });
                }
            }
        }
    }

    out
}

/// 把一条工具结果写回对应的卡片。找不到卡片（结果先到、卡片被截断）就丢掉。
fn fill_result(
    out: &mut [UiMessage],
    calls: &[(String, usize, usize)],
    call_id: &str,
    text: String,
    is_error: bool,
) {
    let Some((_, message, part)) = calls.iter().find(|(id, _, _)| id == call_id) else {
        return;
    };
    let Some(UiMessage { parts, .. }) = out.get_mut(*message) else {
        return;
    };
    let Some(UiPart::Tool { state, .. }) = parts.get_mut(*part) else {
        return;
    };
    state.status = if is_error { "error" } else { "completed" };
    if is_error {
        state.error = Some(text);
    } else {
        state.output = Some(text);
    }
}

/// 工具结果里的文本部分拼起来。
fn join_result(result: &rig_core::message::ToolResult) -> String {
    let mut text = String::new();
    for item in &result.content {
        match item {
            rig_core::message::ToolResultContent::Text(value) => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&value.text);
            }
            rig_core::message::ToolResultContent::Json { value } => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&value.to_string());
            }
            _ => {}
        }
    }
    text
}

fn first_user_text(messages: &[Message]) -> String {
    for message in messages {
        if let Message::User { content } = message {
            for item in content {
                if let UserContent::Text(text) = item {
                    if !text.text.trim().is_empty() {
                        return title_of(&text.text);
                    }
                }
            }
        }
    }
    String::new()
}

/// 标题：单行、连续空白折成一个空格、最多 60 字（超出加省略号）。
fn title_of(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = line.chars();
    let head: String = chars.by_ref().take(60).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn read_index(dir: &Path) -> Option<Index> {
    let bytes = std::fs::read(dir.join(INDEX)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_index(dir: &Path, index: &Index) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    // 先写临时文件再 rename：列表正好读到半截 JSON 会当作「没有索引」
    let tmp = dir.join(format!("{INDEX}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入会话索引失败：{e}"))?;
    std::fs::rename(&tmp, dir.join(INDEX)).map_err(|e| format!("写入会话索引失败：{e}"))
}

fn file_mtime(dir: &Path) -> u64 {
    std::fs::metadata(dir)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 会话 id：毫秒时间戳 + 自增段，十六进制，文件名安全且按时间可排。
fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    format!(
        "{:x}{:04x}",
        now_ms(),
        SEQ.fetch_add(1, Ordering::Relaxed) & 0xffff
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}
