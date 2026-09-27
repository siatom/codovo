import { invoke } from "@tauri-apps/api/core";

/**
 * 系统钥匙串的状态。
 *
 * `storeError` 非空表示这台机器上压根没有可用的凭据库（Linux 缺 Secret Service
 * 最常见），此时密钥存不上，界面要如实提示；`available` 列出确实存着密钥的
 * 提供商 id——localStorage 里那个 `apiKeySet` 只是个布尔位，条目可能被用户
 * 在系统设置里删掉过，以这边为准。
 */
export interface SecretStatus {
  storeError: string;
  available: string[];
}

/** 把一个提供商的密钥写进系统钥匙串。空串按删除处理。 */
export function setSecret(providerId: string, key: string): Promise<void> {
  return invoke<void>("secret_set", { providerId, key });
}

/** 从系统钥匙串删掉一个提供商的密钥。本来就没有也算成功。 */
export function deleteSecret(providerId: string): Promise<void> {
  return invoke<void>("secret_delete", { providerId });
}

/**
 * 查这些提供商里哪些存着密钥。
 *
 * 后端**不抛错**：钥匙串不可用是种正常状态，用 `storeError` 如实报回来，
 * 比让整个调用失败更好用。这里的 catch 只兜住偶发的序列化 / IPC 问题。
 */
export async function secretStatus(providerIds: string[]): Promise<SecretStatus> {
  try {
    return await invoke<SecretStatus>("secret_status", { providerIds });
  } catch (reason) {
    return { storeError: String(reason), available: [] };
  }
}
