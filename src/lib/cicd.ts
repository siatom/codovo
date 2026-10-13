import { Channel, invoke } from "@tauri-apps/api/core";

/** 五阶段的 id，和 Rust 侧 `cicd.rs` 的常量一一对应 */
export type CicdStageId = "preflight" | "build" | "deploy" | "verify" | "rollback";

/**
 * 流水线事件。后端用 `#[serde(tag = "type", rename_all = "camelCase")]` 序列化，
 * 所以 variant 名是小驼峰、字段名也是。
 */
export type CicdEvent =
  | { type: "stageStart"; stage: string; command: string }
  | { type: "output"; stage: string; stream: "stdout" | "stderr"; line: string }
  | { type: "stageEnd"; stage: string; ok: boolean; code: number; durationMs: number }
  | { type: "finished"; ok: boolean; rolledBack: boolean; message: string };

export interface CicdConfigFile {
  /** 配置文件绝对路径（`.local-cicd.yaml`） */
  path: string;
  exists: boolean;
  yaml: string;
}

export interface CicdStatus {
  running: boolean;
  /** `.local-cicd/current` 记录的当前部署版本号 */
  currentVersion: string | null;
}

/** 读项目根的 `.local-cicd.yaml` */
export function readCicdConfig(root: string): Promise<CicdConfigFile> {
  return invoke<CicdConfigFile>("cicd_read_config", { root });
}

/** 写回 `.local-cicd.yaml`；写前后端会校验 YAML 是否合法 */
export function writeCicdConfig(root: string, yaml: string): Promise<void> {
  return invoke("cicd_write_config", { root, yaml });
}

/** 按项目标记探测，生成一份建议配置（YAML 文本） */
export function detectCicdConfig(root: string): Promise<string> {
  return invoke<string>("cicd_detect_config", { root });
}

export function cicdStatus(root: string): Promise<CicdStatus> {
  return invoke<CicdStatus>("cicd_status", { root });
}

/** 打断正在跑的流水线并 kill 当前子进程 */
export function stopCicd(root: string): Promise<void> {
  return invoke("cicd_stop", { root });
}

/**
 * 跑一条流水线。后端 spawn 后台线程后立即返回，阶段进度与日志经 `onEvent` 流式推来，
 * 直到收到 `finished` 才算结束。
 */
export function runCicd(root: string, onEvent: (event: CicdEvent) => void): Promise<void> {
  const channel = new Channel<CicdEvent>();
  channel.onmessage = onEvent;
  return invoke("cicd_run", { root, onEvent: channel });
}
