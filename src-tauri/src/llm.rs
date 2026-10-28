//! 模型构造与一次性生成：把「设置里的提供商 + 模型 + 密钥」变成 Rig 的模型句柄。
//!
//! 只走 OpenAI 兼容协议——设置里本来也只支持这一种（见 `lib/providers.ts`）。
//! 密钥不进前端、不落配置文件：前端只传提供商 id，正文由这里按 id 去系统钥匙串取。

use rig_agent::AgentBuilder;
use rig_core::driver::Model;
use rig_core::providers::openai::wire::{Auth, Chat, OpenAIConfig};

/// 建一个模型要的全部信息。
pub struct ModelSpec {
    /// OpenAI 兼容基地址，例如 https://api.deepseek.com/v1
    pub base_url: String,
    pub model: String,
    /// None / 空串表示本地模型（Ollama 之类），不发 Authorization 头
    pub api_key: Option<String>,
}

/// 建一个 chat 补全模型。
///
/// 不用 `OpenAI::new()`：那个固定打 api.openai.com。用户填的是任意兼容端点，
/// 必须走 `OpenAIConfig::with_base_url`。
pub fn build(spec: &ModelSpec) -> Result<Model<Chat>, String> {
    let base_url = spec.base_url.trim();
    if base_url.is_empty() {
        return Err("这个提供商没有填接口地址".to_string());
    }
    let model = spec.model.trim();
    if model.is_empty() {
        return Err("没有指定模型".to_string());
    }

    let key = spec.api_key.as_deref().unwrap_or("").trim();
    let mut config = OpenAIConfig::new(key).with_base_url(base_url);
    if key.is_empty() {
        // 本地模型不认鉴权头；带一个空的 Bearer 反而会被某些服务端拒掉
        config.auth = Auth::OptionalBearer;
    }
    Ok(config.client().chat(model))
}

/// 跑一次单轮生成：给定角色说明与用户正文，返回模型输出的纯文本。
///
/// 不带工具、不带历史、不落会话——翻译 / 提交方案 / 诊断这类一次性任务都走这里。
pub async fn complete(spec: &ModelSpec, preamble: &str, user: &str) -> Result<String, String> {
    let model = build(spec)?;
    let agent = AgentBuilder::new(model).preamble(preamble).build();
    let response = agent
        .prompt(user)
        .await
        .map_err(|error| format!("生成失败：{error}"))?;
    Ok(response.output())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{json, serve};

    fn spec(base_url: &str) -> ModelSpec {
        ModelSpec {
            base_url: base_url.to_string(),
            model: "test-model".to_string(),
            api_key: None,
        }
    }

    #[tokio::test]
    async fn complete_reads_a_plain_completion() {
        let body = r#"{"id":"1","object":"chat.completion","created":1,"model":"test-model","choices":[{"index":0,"message":{"role":"assistant","content":"你好"},"finish_reason":"stop"}]}"#;
        let (base_url, server) = serve(vec![json(body)]);

        let text = complete(&spec(&base_url), "你是助手", "打个招呼")
            .await
            .expect("生成失败");

        assert_eq!(text, "你好");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn a_missing_base_url_is_rejected_before_any_request() {
        let error = build(&spec("  ")).expect_err("空地址应当报错");
        assert!(error.contains("接口地址"), "{error}");
    }
}
