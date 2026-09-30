import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { useSettings } from "./settings";
import { resolveDefaultModel } from "./providers";
import type { DiffSource } from "./tabs";

/**
 * OpenAI 兼容接口的配置。开发调试版里可能被 `src-tauri/.env` 盖掉，
 * 见 useEffectiveAiConfig。
 *
 * 没有密钥字段：密钥在系统钥匙串里，后端按 `providerId` 自己取。
 */
export interface AiConfig {
  /** 基地址，结尾带不带 `/` 都行 */
  baseUrl: string;
  /** 这个提供商在钥匙串里的条目名 */
  providerId: string;
  model: string;
}

/**
 * 测一个提供商的连通性：后端打一次很轻的探针请求，返回一句给用户看的结果
 * （成功时说明发现了多少模型，失败时说明是鉴权、限流、超时还是网络问题）。
 *
 * `apiKey` 是「刚在输入框里敲完、还没保存」的那份，传了就优先用它，否则后端按
 * `providerId` 去钥匙串取。测的是界面上的这份配置，不套 `.env` 覆盖。
 */
export function testProviderConnection(config: AiConfig, apiKey?: string): Promise<string> {
  return invoke<string>("ai_test_provider", {
    baseUrl: config.baseUrl,
    providerId: config.providerId,
    apiKey: apiKey ?? null,
    model: config.model,
  });
}

/** 从提供商接口拉回来的一条模型。`name` 多数兼容实现不给，留空按 id 显示 */
export interface RemoteModel {
  id: string;
  name: string;
}

/**
 * 拉一份提供商那边可用的模型列表，给设置面板的「从接口拉取」用。
 *
 * 走 `GET /models`；不是所有 OpenAI 兼容实现都有这条路由，没有会直接报错
 * （不猜模型名）。`apiKey` 同 `testProviderConnection`：传了就用界面上的草稿。
 */
export function listProviderModels(config: AiConfig, apiKey?: string): Promise<RemoteModel[]> {
  return invoke<RemoteModel[]>("ai_list_provider_models", {
    baseUrl: config.baseUrl,
    providerId: config.providerId,
    apiKey: apiKey ?? null,
  });
}

/**
 * 让后端取暂存区改动 + 分支 + 近期提交主题，调大模型生成一条提交信息。
 * 走 Rust 侧的 HTTP，密钥不进 WebView；字段没配全时后端会直接报错。
 */
export function generateCommitMessage(root: string, config: AiConfig): Promise<string> {
  return invoke<string>("ai_generate_commit_message", { root, config });
}

/**
 * 让大模型解释一个文件，返回 markdown 正文。
 *
 * `source` 决定看什么：给了就解释那次改动（diff），和编辑器的差异视图同一个
 * 枚举；传 `null` 就解释**整个文件**的职责与实现逻辑，不依赖 git，只读。
 */
export function explainChange(
  root: string,
  config: AiConfig,
  path: string,
  source: DiffSource | null,
): Promise<string> {
  return invoke<string>("ai_explain_change", { root, config, path, source });
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
 * 设置里「默认模型」所在提供商的配置，与 `.env` 覆盖值合并后的生效配置。
 *
 * 默认指向被删 / 停用 / 清空时由 `resolveDefaultModel` 回落到第一个可用项，
 * 回落不到 `ready` 就是 false。
 *
 * 前端在 invoke 之前就要判空，所以必须先知道覆盖值——否则「面板留空、只写 .env」
 * 会被守卫直接拦掉，根本传不到后端。密钥正文压根不回前端，所以这里只能用
 * 提供商的 `apiKeySet` 标记（或 `.env` 的 `apiKeySet`）判断后端手上有没有。
 */
export function useEffectiveAiConfig(): { config: AiConfig; ready: boolean } {
  const { settings } = useSettings();
  const overrides = useDevAiOverrides();

  return useMemo(() => {
    const resolved = resolveDefaultModel(settings);
    const provider = resolved
      ? settings.aiProviders.find((item) => item.id === resolved.providerId)
      : undefined;
    const config: AiConfig = {
      baseUrl: overrides.baseUrl || (provider?.baseUrl.trim() ?? ""),
      providerId: resolved?.providerId ?? "",
      model: overrides.model || (resolved?.modelId ?? ""),
    };
    const ready =
      !!config.baseUrl &&
      !!config.model &&
      (!!provider?.apiKeySet || overrides.apiKeySet);
    return { config, ready };
  }, [overrides, settings]);
}
