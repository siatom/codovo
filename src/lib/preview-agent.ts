import { invoke } from "@tauri-apps/api/core";
import {
  detectPreview,
  previewStatus,
  startPreview,
  stopPreview,
  type PreviewStatus,
} from "./preview";

/**
 * 预览助手的桥。
 *
 * 预览进程池的唯一事实来源是后端主进程的 `PreviewState`，而工具调用发生在 opencode
 * 拉起的**独立子进程**（`codedock.exe --mcp-preview`，见 `src-tauri/src/preview_agent.rs`）里。
 * 所以后端把每次工具调用写成一个请求文件，这里轮询取走、调 `lib/preview.ts` 的命令、
 * 再把结果写回，形成「后端工具 → 前端执行 → 回传结果」的环（和 `lib/app-agent.ts` 同一套）。
 *
 * 预览助手是**每个工作区一个进程**：请求里带着该助手所属的工作区路径（后端经
 * `CODEDOCK_PREVIEW_ROOT` 注入），所以这里不依赖「当前活动工作区」，后台工作区的调用也照常执行。
 */

/** 一条待执行的预览操作请求，字段和后端 `AppAgentRequest` 对齐 */
export interface PreviewAgentRequest {
  id: string;
  /** MCP 工具名（不带 opencode 加的 `preview_` 前缀） */
  tool: string;
  args: Record<string, unknown>;
}

/** 取一条待执行的请求；没有就返回 null。取走即删除，同一条不会被处理两次。 */
export function takePreviewAgentRequest(): Promise<PreviewAgentRequest | null> {
  return invoke<PreviewAgentRequest | null>("preview_agent_take_request");
}

/** 把执行结果写回去，等着的 MCP 调用据此返回给模型 */
export function respondPreviewAgent(id: string, ok: boolean, result: string): Promise<void> {
  return invoke<void>("preview_agent_respond", { id, ok, result });
}

/**
 * 预览助手的哨兵 root。它不是工作区路径——后端据此把预览助手与终端区智能体分开，
 * **按工作区取不同哨兵**（每个工作区一个 opencode 进程），与 `src-tauri/src/preview_agent.rs`
 * 的 `agent_root` 对齐。
 */
export function previewAgentRoot(workspaceRoot: string): string {
  return `__preview_agent__::${workspaceRoot}`;
}

/**
 * 当前会话 id 存 sessionStorage，**按工作区分开记**：一个窗口里同时开着多个工作区，
 * 每个的预览助手各有各的对话，切回来还能接上。
 */
const SESSION_KEY_PREFIX = "codedock.previewAgentSession:";

export function readPreviewAgentSession(workspaceRoot: string): string {
  try {
    return window.sessionStorage.getItem(SESSION_KEY_PREFIX + workspaceRoot) ?? "";
  } catch {
    return "";
  }
}

export function writePreviewAgentSession(workspaceRoot: string, sessionId: string) {
  try {
    window.sessionStorage.setItem(SESSION_KEY_PREFIX + workspaceRoot, sessionId);
  } catch {
    // 记不住只影响下次打开时的还原
  }
}

export interface PreviewAgentOutcome {
  ok: boolean;
  text: string;
}

/** 跑一个工具调用。任何抛错都转成 `ok:false` 的文案回给模型。 */
export async function runPreviewTool(
  request: PreviewAgentRequest,
): Promise<PreviewAgentOutcome> {
  try {
    return { ok: true, text: await execute(request.tool, request.args) };
  } catch (reason) {
    return { ok: false, text: reason instanceof Error ? reason.message : String(reason) };
  }
}

async function execute(tool: string, args: Record<string, unknown>): Promise<string> {
  switch (tool) {
    case "detect": {
      const detected = await detectPreview(resolveRoot(args));
      return JSON.stringify(detected, null, 2);
    }
    case "start": {
      const command =
        typeof args.command === "string" && args.command.trim() ? args.command.trim() : undefined;
      const port = typeof args.port === "number" ? args.port : undefined;
      const status = await startPreview(resolveRoot(args), { command, port });
      return describeStatus(status);
    }
    case "stop": {
      await stopPreview(resolveRoot(args));
      return "已停止预览";
    }
    case "status": {
      return describeStatus(await previewStatus(resolveRoot(args)));
    }
    default:
      throw new Error(`不支持的预览操作：${tool}`);
  }
}

/**
 * 解析目标工作区根：后端为每条请求注入了本助手所属的工作区（`root`），
 * 模型显式给 `path` 时以它为准。两者都没有就报错——比默默操作错的项目好。
 */
function resolveRoot(args: Record<string, unknown>): string {
  const root = typeof args.root === "string" && args.root.trim() ? args.root.trim() : null;
  const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : null;
  const resolved = path ?? root;
  if (!resolved) {
    throw new Error("这条预览请求没有带上工作区路径");
  }
  return resolved;
}

/** 把运行状态讲成人话，附上最近几行日志——诊断起不来就靠这一段。 */
function describeStatus(status: PreviewStatus): string {
  if (!status.running) return "预览没有在运行。";
  const parts = [`预览运行中（pid ${status.pid}）`];
  if (status.url) parts.push(`地址 ${status.url}`);
  if (status.cdpPort) parts.push(`CDP 调试端口 ${status.cdpPort}`);
  const tail = status.logs.slice(-40).join("\n");
  return tail ? `${parts.join("；")}\n最近日志：\n${tail}` : parts.join("；");
}
