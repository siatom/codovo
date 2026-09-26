import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { useSettings } from "./settings";
import type { DiffSource } from "./tabs";

/** OpenAI 兼容接口的配置。开发调试版里可能被 `src-tauri/.env` 盖掉，见 useEffectiveAiConfig */
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

/**
 * 开发调试版从 `src-tauri/.env` 读到的覆盖值；正式版恒为空。
 * 空串 / false 都表示「这一项没被覆盖」，用设置里的值。
 */
export interface DevAiOverrides {
  baseUrl: string;
  model: string;
  /** 密钥正文不回 WebView，这里只说后端手上有没有 */
  apiKeySet: boolean;
}

const NO_OVERRIDES: DevAiOverrides = { baseUrl: "", model: "", apiKeySet: false };

// 单例 promise：界面里好几处都会拉覆盖值，只该 invoke 一次
let pending: Promise<DevAiOverrides> | null = null;

function loadDevAiOverrides(): Promise<DevAiOverrides> {
  if (!pending) {
    pending = invoke<DevAiOverrides>("dev_ai_overrides").catch(() => NO_OVERRIDES);
  }
  return pending;
}

/**
 * 拉一次覆盖值给界面用。只在挂载时拉：后端每次调用都会重读 `.env`，所以「改值」
 * 是立刻生效的；但要是往 `.env` 里新加一个原本没写的键，得重开应用才能让这里的
 * 守卫放行。
 */
export function useDevAiOverrides(): DevAiOverrides {
  const [overrides, setOverrides] = useState(NO_OVERRIDES);

  useEffect(() => {
    let cancelled = false;
    void loadDevAiOverrides().then((value) => {
      if (!cancelled) setOverrides(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return overrides;
}

/**
 * 设置里的 AI 三项与 `.env` 覆盖值合并后的生效配置。
 *
 * 前端在 invoke 之前就要判空，所以必须先知道覆盖值——否则「面板留空、只写 .env」
 * 会被守卫直接拦掉，根本传不到后端。密钥那份 `.env` 由后端自己盖，前端只按
 * `apiKeySet` 判断后端手上有没有。
 */
export function useEffectiveAiConfig(): { config: AiConfig; ready: boolean } {
  const { settings } = useSettings();
  const overrides = useDevAiOverrides();
  const { aiBaseUrl, aiModel, aiApiKey } = settings;

  return useMemo(() => {
    const config: AiConfig = {
      baseUrl: overrides.baseUrl || aiBaseUrl.trim(),
      model: overrides.model || aiModel.trim(),
      apiKey: aiApiKey.trim(),
    };
    const ready =
      !!config.baseUrl && !!config.model && (!!config.apiKey || overrides.apiKeySet);
    return { config, ready };
  }, [overrides, aiBaseUrl, aiModel, aiApiKey]);
}
