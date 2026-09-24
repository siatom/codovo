import { invoke } from "@tauri-apps/api/core";

/** OpenAI 兼容接口的配置，三个字段都来自设置里的 AI 分组 */
export interface AiCommitConfig {
  /** 基地址，结尾带不带 `/` 都行 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 让后端取暂存区改动 + 分支 + 近期提交主题，调大模型生成一条提交信息。
 * 走 Rust 侧的 HTTP，密钥不进 WebView；字段没配全时后端会直接报错。
 */
export function generateCommitMessage(config: AiCommitConfig): Promise<string> {
  return invoke<string>("ai_generate_commit_message", { config });
}
