import { invoke } from "@tauri-apps/api/core";

export interface InstallResult {
  ok: boolean;
  message: string;
}

/** 依赖 id 由设置页白名单产生，后端仍会再次校验。 */
export function installDependency(id: string): Promise<InstallResult> {
  return invoke<InstallResult>("install_dependency", { id });
}
