//! 工作区**项目层**的智能体配置读写。
//!
//! 项目层（规则 / 记忆 / 技能 / Agents）以仓库根 `.codovo/` 下的文件为准，而不是
//! localStorage——这样配置随仓库走、能进 git、也能用编辑器直接改。全局层仍留在
//! `codovo.settings`（它不属于任何仓库）。
//!
//! 文件布局：
//! - `.codovo/rules.md` / `.codovo/memory.md`：纯文本
//! - `.codovo/skills.json`：`AgentSkill[]`
//! - `.codovo/agents.json`：`AgentProfile[]`
//!
//! 空内容不落盘（删掉对应文件），全空时连目录都不建。读的时候文件缺失当空、解析失败报错。

use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::State;

use crate::fs_api::FsState;

/// 工作区根下存放项目层配置的目录名。
const DIR: &str = ".codovo";

/// 项目层的一整套配置。字段与前端 `lib/settings.tsx` 的 `AgentLayer` 对齐。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLayer {
    #[serde(default)]
    pub rules: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub skills: Vec<AgentSkill>,
    #[serde(default)]
    pub agents: Vec<AgentProfile>,
}

/// 一条自定义技能，物化成一份 SKILL.md。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// 一个自定义 agent。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// primary / subagent / all
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// 读一个文本文件；不存在当空串，其余错误如实报。
fn read_text(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("读取 {} 失败: {error}", path.display())),
    }
}

/// 读一个 JSON 数组文件；不存在当空表，解析失败报错（不静默丢配置）。
fn read_json_vec<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("解析 {} 失败: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("读取 {} 失败: {error}", path.display())),
    }
}

/// 从工作区根读项目层配置。目录 / 文件不存在都当空层。
fn read_layer(root: &Path) -> Result<AgentLayer, String> {
    let dir = root.join(DIR);
    Ok(AgentLayer {
        rules: read_text(&dir.join("rules.md"))?,
        memory: read_text(&dir.join("memory.md"))?,
        skills: read_json_vec(&dir.join("skills.json"))?,
        agents: read_json_vec(&dir.join("agents.json"))?,
    })
}

/// 写文本：空内容就删掉文件，保持目录干净。
fn write_or_remove(path: &Path, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    std::fs::write(path, text).map_err(|error| format!("写入 {} 失败: {error}", path.display()))
}

/// 写 JSON 数组：空表就删掉文件。
fn write_or_remove_json<T: Serialize>(path: &Path, items: &[T]) -> Result<(), String> {
    if items.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    let text = serde_json::to_string_pretty(items).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("写入 {} 失败: {error}", path.display()))
}

/// 把项目层配置写到工作区根的 `.codovo/` 下。全空时不建目录。
fn write_layer(root: &Path, layer: &AgentLayer) -> Result<(), String> {
    let dir = root.join(DIR);
    let empty = layer.rules.trim().is_empty()
        && layer.memory.trim().is_empty()
        && layer.skills.is_empty()
        && layer.agents.is_empty();
    if empty {
        // 全空：清掉旧文件（目录留着也无妨）
        for name in ["rules.md", "memory.md", "skills.json", "agents.json"] {
            let _ = std::fs::remove_file(dir.join(name));
        }
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建 .codovo 目录失败: {error}"))?;
    write_or_remove(&dir.join("rules.md"), &layer.rules)?;
    write_or_remove(&dir.join("memory.md"), &layer.memory)?;
    write_or_remove_json(&dir.join("skills.json"), &layer.skills)?;
    write_or_remove_json(&dir.join("agents.json"), &layer.agents)?;
    Ok(())
}

// ---- Tauri 命令 ----

/// 读工作区项目层的智能体配置（`.codovo/` 下）。没有就返回空层。
#[tauri::command]
pub fn agent_config_read(state: State<'_, FsState>, root: String) -> Result<AgentLayer, String> {
    let root: PathBuf = state.checked_root(&root)?;
    read_layer(&root)
}

/// 把项目层配置写到工作区根的 `.codovo/` 下。
#[tauri::command]
pub fn agent_config_write(
    state: State<'_, FsState>,
    root: String,
    layer: AgentLayer,
) -> Result<(), String> {
    let root: PathBuf = state.checked_root(&root)?;
    write_layer(&root, &layer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codovo-agent-config-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample() -> AgentLayer {
        AgentLayer {
            rules: "只改请求范围内的代码".to_string(),
            memory: "本项目用 pnpm".to_string(),
            skills: vec![AgentSkill {
                name: "release".to_string(),
                description: "发版流程".to_string(),
                content: "1. pnpm version patch".to_string(),
                enabled: true,
            }],
            agents: vec![AgentProfile {
                name: "reviewer".to_string(),
                description: "代码审查".to_string(),
                mode: "subagent".to_string(),
                model: "".to_string(),
                prompt: "审查改动".to_string(),
                enabled: true,
            }],
        }
    }

    #[test]
    fn missing_files_read_as_empty_layer() {
        let dir = temp_dir("missing");
        let layer = read_layer(&dir).unwrap();
        assert!(layer.rules.is_empty());
        assert!(layer.skills.is_empty());
        assert!(layer.agents.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trips_through_files() {
        let dir = temp_dir("roundtrip");
        let original = sample();
        write_layer(&dir, &original).unwrap();

        // 落盘位置正确
        assert!(dir.join(".codovo").join("rules.md").is_file());
        assert!(dir.join(".codovo").join("skills.json").is_file());

        let read_back = read_layer(&dir).unwrap();
        assert_eq!(read_back.rules, original.rules);
        assert_eq!(read_back.memory, original.memory);
        assert_eq!(read_back.skills.len(), 1);
        assert_eq!(read_back.skills[0].name, "release");
        assert_eq!(read_back.agents.len(), 1);
        assert_eq!(read_back.agents[0].mode, "subagent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_layer_removes_files() {
        let dir = temp_dir("empty");
        write_layer(&dir, &sample()).unwrap();
        write_layer(&dir, &AgentLayer::default()).unwrap();
        assert!(!dir.join(".codovo").join("rules.md").exists());
        assert!(!dir.join(".codovo").join("skills.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_json_is_reported() {
        let dir = temp_dir("broken");
        std::fs::create_dir_all(dir.join(".codovo")).unwrap();
        std::fs::write(dir.join(".codovo").join("agents.json"), "{ not json").unwrap();
        assert!(read_layer(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
