import { invoke } from "@tauri-apps/api/core";
import type { ToolId } from "../components/ToolPane";
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
 * 执行一次预览操作需要的一切。由 `App.tsx` 每次渲染时组装（读的都是最新值），
 * 执行器本身不持有状态——纯函数式，方便复用。
 */
export interface PreviewAgentContext {
  /** 当前活动工作区的根目录；没有打开工作区时为 null */
  activeRoot: string | null;
  /** 当前活动工作区的界面句柄；没有打开工作区时为 null */
  layout: { openTool: (id: ToolId) => void } | null;
}

export interface PreviewAgentOutcome {
  ok: boolean;
  text: string;
}

/** 跑一个工具调用。任何抛错都转成 `ok:false` 的文案回给模型。 */
export async function runPreviewTool(
  request: PreviewAgentRequest,
  ctx: PreviewAgentContext,
): Promise<PreviewAgentOutcome> {
  try {
    return { ok: true, text: await execute(request.tool, request.args, ctx) };
  } catch (reason) {
    return { ok: false, text: reason instanceof Error ? reason.message : String(reason) };
  }
}

async function execute(
  tool: string,
  args: Record<string, unknown>,
  ctx: PreviewAgentContext,
): Promise<string> {
  switch (tool) {
    case "detect": {
      const root = resolveRoot(args, ctx);
      const detected = await detectPreview(root);
      return JSON.stringify(detected, null, 2);
    }
    case "start": {
      const root = resolveRoot(args, ctx);
      const command =
        typeof args.command === "string" && args.command.trim() ? args.command.trim() : undefined;
      const port = typeof args.port === "number" ? args.port : undefined;
      const status = await startPreview(root, { command, port });
      // 起了就顺手把右栏切到「预览」模块，用户能直接看到结果
      ctx.layout?.openTool("preview");
      return describeStatus(status);
    }
    case "stop": {
      const root = resolveRoot(args, ctx);
      await stopPreview(root);
      return "已停止预览";
    }
    case "status": {
      const root = resolveRoot(args, ctx);
      return describeStatus(await previewStatus(root));
    }
    default:
      throw new Error(`不支持的预览操作：${tool}`);
  }
}

/** 解析目标工作区根：参数里的 path 优先，否则用当前活动工作区。 */
function resolveRoot(args: Record<string, unknown>, ctx: PreviewAgentContext): string {
  const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : null;
  const root = path ?? ctx.activeRoot;
  if (!root) {
    throw new Error("没有可用的工作区：请先打开一个工作区，或在参数里给出 path");
  }
  return root;
}

/** 把运行状态讲成人话，附上最近几行日志。 */
function describeStatus(status: PreviewStatus): string {
  if (!status.running) return "预览没有在运行。";
  const parts = [`预览运行中（pid ${status.pid}）`];
  if (status.url) parts.push(`地址 ${status.url}`);
  if (status.cdpPort) parts.push(`CDP 调试端口 ${status.cdpPort}`);
  const tail = status.logs.slice(-8).join("\n");
  return tail ? `${parts.join("；")}\n最近日志：\n${tail}` : parts.join("；");
}
