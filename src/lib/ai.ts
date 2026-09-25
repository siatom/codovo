import { invoke } from "@tauri-apps/api/core";
import type { DiffSource } from "./tabs";

/** OpenAI 兼容接口的配置，三个字段都来自设置里的 AI 分组 */
export interface AiConfig {
  /** 基地址，结尾带不带 `/` 都行 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 让后端取暂存区改动 + 分支 + 近期提交主题，调大模型生成一条提交信息。
 * 走 Rust 侧的 HTTP，密钥不进 WebView；字段没配全时后端会直接报错。
 */
export function generateCommitMessage(config: AiConfig): Promise<string> {
  return invoke<string>("ai_generate_commit_message", { config });
}

/**
 * 让大模型解释一个改动文件里改了什么，返回 markdown 正文。
 * `source` 决定跟谁比，和编辑器的差异视图同一个枚举。
 */
export function explainChange(
  config: AiConfig,
  path: string,
  source: DiffSource,
): Promise<string> {
  return invoke<string>("ai_explain_change", { config, path, source });
}
