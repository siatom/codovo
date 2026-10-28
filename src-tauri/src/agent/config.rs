//! 前端传进来的助手配置：提供商、默认模型、规则 / 记忆 / 技能 / Agents。
//!
//! 形状沿用切 opencode 之前的那份，只去掉两个进程参数（`command` / `port`）——
//! 现在没有子进程可配了。

use serde::Deserialize;

use crate::dev;
use crate::llm::ModelSpec;

/// 一条技能。切 Rig 之后没有 `SKILL.md` 可写，技能正文直接拼进系统提示词。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
}

/// 一个自定义 agent。界面上固定用内置助手，所以这里只取它的提示词——
/// 绑定模型由前端按 `agent.model` 算好，以 `provider/model` 引用传进来。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub prompt: String,
}

/// 一个 LLM 提供商，OpenAI 兼容协议。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// 提供商 id，也是 `provider/model` 引用的前缀。前端保证非空且不含 `/`
    pub id: String,
    /// OpenAI 兼容基地址；空的话这条提供商作废
    pub base_url: String,
    /// 有没有配密钥。正文不从这里走，只表示该去钥匙串取一条
    #[serde(default)]
    pub has_key: bool,
    #[serde(default)]
    pub models: Vec<String>,
}

impl ProviderSpec {
    fn usable(&self) -> bool {
        !self.id.trim().is_empty()
            && !self.id.contains('/')
            && !self.base_url.trim().is_empty()
            && self.models.iter().any(|model| !model.trim().is_empty())
    }
}

/// 前端传进来的配置。提供商与默认模型来自「设置 → 模型」；
/// 规则 / 记忆 / 技能 / Agents 是前端把「全局 + 当前工作区」两层合并后的生效值。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default)]
    pub providers: Vec<ProviderSpec>,
    /// 全局默认模型，形如 `provider/model`；空则取第一个可用项
    #[serde(default)]
    pub default_model: String,
    /// 开发调试用：`src-tauri/.env` 里那个密钥，连它属于哪个提供商一起记。
    /// 前端传不进来（`skip`），只在 debug 构建里由 `apply` 填上。
    #[serde(skip)]
    pub dev_api_key: Option<(String, String)>,
    #[serde(default)]
    pub rules: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub skills: Vec<SkillSpec>,
    #[serde(default)]
    pub agents: Vec<AgentSpec>,
    /// 数据库助手：只读数据库工具
    #[serde(default)]
    pub database: bool,
    /// 预览助手：预览工具
    #[serde(default)]
    pub preview: bool,
    /// 预览助手要预览的工作区根目录（`root` 传的是哨兵，真正操作哪个项目以它为准）
    #[serde(default)]
    pub workspace_root: String,
}

impl AgentConfig {
    /// 真正能拿去建连的提供商：id / 地址 / 模型齐全
    pub fn usable_providers(&self) -> impl Iterator<Item = &ProviderSpec> {
        self.providers.iter().filter(|provider| provider.usable())
    }

    /// 默认模型引用的提供商前缀，认不出来就退到第一个可用提供商
    fn default_provider_id(&self) -> Option<String> {
        let prefix = self
            .default_model
            .split('/')
            .next()
            .filter(|part| !part.is_empty());
        if let Some(prefix) = prefix {
            if self
                .providers
                .iter()
                .any(|provider| provider.usable() && provider.id == prefix)
            {
                return Some(prefix.to_string());
            }
        }
        self.usable_providers().next().map(|p| p.id.clone())
    }

    /// 生效的默认模型引用；设置里没填或指向的提供商已经没了时取第一个可用项
    pub fn resolved_default_model(&self) -> Option<String> {
        let id = self.default_provider_id()?;
        let provider = self.providers.iter().find(|item| item.id == id)?;
        let wanted = self.default_model.split_once('/').map(|(_, model)| model);
        let model = wanted
            .filter(|model| provider.models.iter().any(|item| item.trim() == *model))
            .or_else(|| {
                provider
                    .models
                    .iter()
                    .map(|item| item.trim())
                    .find(|item| !item.is_empty())
            })?;
        Some(format!("{}/{model}", provider.id))
    }

    /// 按 `provider/model` 引用取一份可用的模型配置。引用为空或不认识时回落默认模型。
    ///
    /// 密钥优先取 `.env` 里的调试值（它本来就该盖住界面配置），否则按 provider id
    /// 去系统钥匙串取；提供商自己标了没有密钥（本地模型）时返回空。
    pub fn model_spec(&self, reference: Option<&str>) -> Result<ModelSpec, String> {
        let reference = reference
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.resolved_default_model())
            .ok_or_else(|| "没有可用的模型：请先在「设置 → 模型」里添加提供商和模型".to_string())?;

        let (provider_id, model) = reference
            .split_once('/')
            .ok_or_else(|| format!("模型引用格式不对：{reference}"))?;
        let provider = self
            .providers
            .iter()
            .find(|item| item.id == provider_id && item.usable())
            .ok_or_else(|| format!("找不到提供商「{provider_id}」，请检查设置"))?;

        let api_key = match &self.dev_api_key {
            Some((id, key)) if id == &provider.id => Some(key.clone()),
            _ if provider.has_key => crate::secrets::get(&provider.id)?,
            _ => None,
        };

        Ok(ModelSpec {
            base_url: provider.base_url.clone(),
            model: model.to_string(),
            api_key: api_key.filter(|key| !key.trim().is_empty()),
        })
    }

    /// 选中 agent 的自定义提示词与说明（没有就空）。
    ///
    /// 界面上固定用内置助手，所以这里的「选中」按助手种类的固定名字找
    /// （`app` / `preview` / `database`）。
    pub fn agent_profile(&self, name: &str) -> Option<(&str, &str)> {
        self.agents
            .iter()
            .find(|agent| agent.name == name)
            .map(|agent| (agent.prompt.as_str(), agent.description.as_str()))
            .filter(|(prompt, description)| {
                !prompt.trim().is_empty() || !description.trim().is_empty()
            })
    }

    /// 开发调试时让 `src-tauri/.env` 优先。逐字段覆盖，只写一个键不会清空别的。
    ///
    /// 覆盖打在**默认提供商**上：`base_url` 改它的地址，`api_key` 只记进
    /// `dev_api_key`（不进钥匙串），`model` 只换模型段、保留提供商前缀。
    pub fn apply(&mut self, overrides: &dev::AiOverrides) {
        if overrides.base_url.is_none() && overrides.model.is_none() && overrides.api_key.is_none() {
            return;
        }

        // 界面上一个提供商都没配、全靠 .env：合成一个，保留「面板留空也能跑」的调试路径
        if self.providers.is_empty() {
            let id = "codovo".to_string();
            self.providers.push(ProviderSpec {
                base_url: overrides.base_url.clone().unwrap_or_default(),
                has_key: overrides.api_key.is_some(),
                models: overrides.model.clone().into_iter().collect(),
                id: id.clone(),
            });
            self.default_model = overrides
                .model
                .clone()
                .map(|model| format!("{id}/{model}"))
                .unwrap_or_default();
            self.dev_api_key = overrides.api_key.clone().map(|key| (id, key));
            return;
        }

        let target = self.default_provider_id();
        if let (Some(base_url), Some(id)) = (&overrides.base_url, &target) {
            if let Some(provider) = self.providers.iter_mut().find(|item| item.id == *id) {
                provider.base_url = base_url.clone();
            }
        }
        if let (Some(api_key), Some(id)) = (&overrides.api_key, &target) {
            if let Some(provider) = self.providers.iter_mut().find(|item| item.id == *id) {
                provider.has_key = true;
            }
            self.dev_api_key = Some((id.clone(), api_key.clone()));
        }
        if let Some(model) = &overrides.model {
            self.default_model = match &target {
                Some(id) => format!("{id}/{model}"),
                None => model.clone(),
            };
        }
    }
}
