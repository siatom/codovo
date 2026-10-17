import { invoke } from "@tauri-apps/api/core";
import {
  AUTOSAVE_DELAY_MAX,
  AUTOSAVE_DELAY_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type Settings,
  type SettingsSection,
} from "./settings";
import { folderName, newWorkspaceId, saveWorkspace, type Workspace } from "./workspaces";
import { DEFAULT_THEME, THEME_NAMES, type Theme } from "./theme";
import { samePath } from "./fs";
import type { ToolId } from "../components/ToolPane";
import type { Fullscreen } from "../components/WorkspacePane";
import { RIGHT_TOOLS } from "../components/ToolRail";

/**
 * 界面操作智能体（应用助手）的桥。
 *
 * 设置、工作区列表、界面布局全在前端 WebView 里（localStorage + React state），而工具调用
 * 发生在 opencode 拉起的**独立子进程**（`codedock.exe --mcp-app`，见
 * `src-tauri/src/app_agent.rs`）里，够不着这些状态。所以后端把每次工具调用写成一个请求文件，
 * 这里轮询取走、执行、再把结果写回，形成一个「后端工具 → 前端执行 → 回传结果」的环。
 */

/** 一条待执行的界面操作请求，字段和后端 `AppAgentRequest` 对齐 */
export interface AppAgentRequest {
  id: string;
  /** MCP 工具名（不带 opencode 加的 `app_` 前缀） */
  tool: string;
  args: Record<string, unknown>;
}

/** 取一条待执行的请求；没有就返回 null。取走即删除，同一条不会被处理两次。 */
export function takeAppAgentRequest(): Promise<AppAgentRequest | null> {
  return invoke<AppAgentRequest | null>("app_agent_take_request");
}

/** 把执行结果写回去，等着的 MCP 调用据此返回给模型 */
export function respondAppAgent(id: string, ok: boolean, result: string): Promise<void> {
  return invoke<void>("app_agent_respond", { id, ok, result });
}

/**
 * 执行一次界面操作需要的一切。由 `App.tsx` 的 Shell 每次渲染时组装（读的都是最新值），
 * 执行器本身不持有任何状态——它是纯函数式的，方便单测与复用。
 */
export interface AppAgentContext {
  settings: Settings;
  /** 当前主题（不在 Settings 上，在 theme.tsx） */
  theme: Theme;
  /** 当前全屏区域（在 App 的 Shell 上） */
  fullscreen: Fullscreen;
  /** 当前活动工作区；没有打开工作区时为 null */
  activeWorkspace: Workspace | null;
  update: (patch: Partial<Settings>) => void;
  setTheme: (theme: Theme) => void;
  reset: () => void;
  resetSection: (section: SettingsSection) => void;
  workspaces: Workspace[];
  setWorkspaces: (list: Workspace[]) => void;
  /** 打开一个工作区；目录打不开时返回 null（实现里已经提示过） */
  openWorkspace: (workspace: Workspace) => Promise<Workspace | null>;
  /** 移除一个工作区（只动记录、不删磁盘），并把它还开着的实例一并关掉 */
  removeWorkspace: (workspace: Workspace) => void;
  /** 当前活动工作区的界面句柄；没有打开的工作区时为 null */
  layout: { openTool: (id: ToolId) => void; setRightOpen: (open: boolean) => void } | null;
  setFullscreen: (area: Fullscreen) => void;
  /** 弹确认框，返回用户是否确认 */
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
}

export interface AppAgentOutcome {
  ok: boolean;
  text: string;
}

/** 跑一个工具调用。任何抛错都转成 `ok:false` 的文案回给模型，不让它把整轮对话拖挂。 */
export async function runAppAgentTool(
  request: AppAgentRequest,
  ctx: AppAgentContext,
): Promise<AppAgentOutcome> {
  try {
    return { ok: true, text: await execute(request.tool, request.args, ctx) };
  } catch (reason) {
    return { ok: false, text: reason instanceof Error ? reason.message : String(reason) };
  }
}

async function execute(
  tool: string,
  args: Record<string, unknown>,
  ctx: AppAgentContext,
): Promise<string> {
  switch (tool) {
    case "get_state":
      return JSON.stringify(describeState(ctx), null, 2);
    case "update_settings": {
      const patch = args.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("update_settings 需要一个 patch 对象");
      }
      return applySettingsPatch(patch as Record<string, unknown>, ctx);
    }
    case "add_workspace":
      return addWorkspace(args, ctx);
    case "rename_workspace": {
      const workspace = findWorkspace(ctx, requireString(args.workspace, "workspace"));
      const name = requireString(args.name, "name");
      ctx.setWorkspaces(saveWorkspace({ ...workspace, name }));
      return `已把工作区「${workspace.name}」改名为「${name}」`;
    }
    case "pin_workspace": {
      const workspace = findWorkspace(ctx, requireString(args.workspace, "workspace"));
      if (typeof args.pinned !== "boolean") throw new Error("pin_workspace 需要 pinned 为 true/false");
      ctx.setWorkspaces(saveWorkspace({ ...workspace, pinned: args.pinned }));
      return `已${args.pinned ? "置顶" : "取消置顶"}工作区「${workspace.name}」`;
    }
    case "remove_workspace": {
      const workspace = findWorkspace(ctx, requireString(args.workspace, "workspace"));
      const confirmed = await ctx.confirm(
        `应用助手请求移除工作区「${workspace.name}」。只去掉 CodeDock 里的记录，不会动磁盘上的文件夹。`,
        "移除",
      );
      if (!confirmed) return `已取消移除工作区「${workspace.name}」`;
      ctx.removeWorkspace(workspace);
      return `已从列表移除工作区「${workspace.name}」（磁盘目录未动）`;
    }
    case "reset_settings": {
      const section = asSection(args.section);
      const confirmed = await ctx.confirm(
        section
          ? `应用助手请求把「${SECTION_LABELS[section]}」这一类设置恢复默认。`
          : "应用助手请求把全部设置恢复默认，当前的自定义设置都会丢失。",
        "恢复默认",
      );
      if (!confirmed) return "已取消恢复默认";
      if (section) {
        ctx.resetSection(section);
        // 主题不在 Settings 上（在 theme.tsx），外观页要单独带一下——和设置面板一致
        if (section === "appearance") ctx.setTheme(DEFAULT_THEME);
      } else {
        ctx.reset();
        ctx.setTheme(DEFAULT_THEME);
      }
      return section ? `已把「${SECTION_LABELS[section]}」这一类设置恢复默认` : "已把全部设置恢复默认";
    }
    case "switch_panel": {
      const requested = requireString(args.panel, "panel");
      // 「搜索」已经并进「文件」模块：老提示词 / 会话里还可能传 search，顺着落到 files
      const panel = requested === "search" ? "files" : requested;
      const ids = RIGHT_TOOLS.map((item) => item.id);
      if (!ids.includes(panel as ToolId)) {
        throw new Error(`panel 只能取 ${ids.join(" / ")}`);
      }
      if (!ctx.layout) throw new Error("当前没有打开的工作区，右栏模块切不了");
      ctx.layout.openTool(panel as ToolId);
      const label = RIGHT_TOOLS.find((item) => item.id === panel)?.label ?? panel;
      return `已切到右栏「${label}」模块`;
    }
    case "set_right_pane": {
      if (typeof args.open !== "boolean") throw new Error("set_right_pane 需要 open 为 true/false");
      if (!ctx.layout) throw new Error("当前没有打开的工作区，右边栏动不了");
      ctx.layout.setRightOpen(args.open);
      return args.open ? "已展开右边栏" : "已收起右边栏";
    }
    case "set_fullscreen": {
      const area = requireString(args.area, "area");
      if (area !== "none" && area !== "left" && area !== "right") {
        throw new Error("area 只能取 none / left / right");
      }
      ctx.setFullscreen(area);
      if (area === "none") return "已退出全屏";
      return `已切换到${area === "left" ? "左侧（终端与智能体）" : "右侧（右边栏）"}全屏`;
    }
    default:
      throw new Error(`不支持的界面操作：${tool}`);
  }
}

// ---- 各项操作 ----

/** 给模型看的状态快照。只放它能改、也答得出的字段，不碰密钥那类敏感内容。 */
function describeState(ctx: AppAgentContext) {
  const { settings } = ctx;
  return {
    theme: ctx.theme,
    fullscreen: ctx.fullscreen,
    activeWorkspace: ctx.activeWorkspace?.name ?? null,
    settings: {
      uiFontFamily: settings.uiFontFamily,
      terminalFontFamily: settings.terminalFontFamily,
      terminalFontSize: settings.terminalFontSize,
      terminalFontBold: settings.terminalFontBold,
      terminalTheme: settings.terminalTheme,
      terminalShell: settings.terminalShell,
      terminalGpuAcceleration: settings.terminalGpuAcceleration,
      terminalWaitHint: settings.terminalWaitHint,
      editorFontFamily: settings.editorFontFamily,
      uiMonoFontFamily: settings.uiMonoFontFamily,
      editorFontSize: settings.editorFontSize,
      editorFontBold: settings.editorFontBold,
      editorAutoSave: settings.editorAutoSave,
      editorAutoSaveDelay: settings.editorAutoSaveDelay,
      editorMinimap: settings.editorMinimap,
      editorIndent: settings.editorIndent,
      agentEnabled: settings.agentEnabled,
      agentCommand: settings.agentCommand,
      agentPort: settings.agentPort,
      agentPrimary: settings.agentPrimary,
      rightFilesVisible: settings.rightFilesVisible,
      rightChangesVisible: settings.rightChangesVisible,
      rightBrowserVisible: settings.rightBrowserVisible,
      rightRemoteVisible: settings.rightRemoteVisible,
      rightDatabaseVisible: settings.rightDatabaseVisible,
      rightPreviewVisible: settings.rightPreviewVisible,
      closeToTray: settings.closeToTray,
      restoreWorkspace: settings.restoreWorkspace,
    },
    workspaces: ctx.workspaces.map((workspace) => ({
      name: workspace.name,
      roots: workspace.roots,
      pinned: workspace.pinned === true,
      activeRoot: workspace.activeRoot,
    })),
  };
}

/** 数值型设置项的合法区间；不在表里的数值字段一律不接受 */
const NUMERIC_LIMITS: Record<string, [number, number]> = {
  terminalFontSize: [FONT_SIZE_MIN, FONT_SIZE_MAX],
  editorFontSize: [FONT_SIZE_MIN, FONT_SIZE_MAX],
  editorAutoSaveDelay: [AUTOSAVE_DELAY_MIN, AUTOSAVE_DELAY_MAX],
  agentPort: [0, 65535],
};

const BOOLEAN_KEYS = new Set([
  "terminalFontBold",
  "terminalGpuAcceleration",
  "terminalWaitHint",
  "editorFontBold",
  "editorMinimap",
  "agentEnabled",
  "closeToTray",
  "restoreWorkspace",
  "rightFilesVisible",
  "rightChangesVisible",
  "rightBrowserVisible",
  "rightRemoteVisible",
  "rightDatabaseVisible",
  "rightPreviewVisible",
]);

const STRING_KEYS = new Set([
  "uiFontFamily",
  "terminalShell",
  "terminalFontFamily",
  "terminalTheme",
  "editorFontFamily",
  "uiMonoFontFamily",
  "agentCommand",
  "agentPrimary",
]);

const ENUM_KEYS: Record<string, string[]> = {
  editorAutoSave: ["off", "afterDelay", "onFocusChange", "onWindowChange"],
  editorIndent: ["auto", "2", "4", "8"],
};

const SECTION_LABELS: Record<SettingsSection, string> = {
  appearance: "外观",
  terminal: "终端",
  editor: "编辑器",
  shortcuts: "快捷键",
  agent: "智能体",
};

const SECTIONS = Object.keys(SECTION_LABELS) as SettingsSection[];

/**
 * 应用 `update_settings` 的 patch。
 *
 * 逐键校验而不是整块写进 settings：设置里混着 aiProviders / agentGlobal 这类复杂结构，
 * 让模型直接覆盖它们太危险；只放行「扁平、能一眼校验」的那些字段，其余报错让模型改口。
 */
function applySettingsPatch(patch: Record<string, unknown>, ctx: AppAgentContext): string {
  const next: Partial<Settings> = {};
  const applied: string[] = [];
  let theme: Theme | null = null;

  for (const [key, value] of Object.entries(patch)) {
    if (key === "theme") {
      if (typeof value !== "string" || !THEME_NAMES.includes(value as Theme)) {
        throw new Error(`theme 取值非法：${JSON.stringify(value)}`);
      }
      theme = value as Theme;
      applied.push(`theme=${value}`);
      continue;
    }

    const limit = NUMERIC_LIMITS[key];
    if (limit) {
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${key} 需要一个数字`);
      const clamped = Math.min(limit[1], Math.max(limit[0], Math.round(parsed)));
      (next as Record<string, unknown>)[key] = clamped;
      applied.push(`${key}=${clamped}`);
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== "boolean") throw new Error(`${key} 需要 true 或 false`);
      (next as Record<string, unknown>)[key] = value;
      applied.push(`${key}=${value}`);
      continue;
    }
    if (STRING_KEYS.has(key)) {
      if (typeof value !== "string") throw new Error(`${key} 需要一个字符串`);
      (next as Record<string, unknown>)[key] = value;
      applied.push(`${key}=${value === "" ? "(留空)" : value}`);
      continue;
    }
    const allowed = ENUM_KEYS[key];
    if (allowed) {
      if (typeof value !== "string" || !allowed.includes(value)) {
        throw new Error(`${key} 只能取 ${allowed.join(" / ")}`);
      }
      (next as Record<string, unknown>)[key] = value;
      applied.push(`${key}=${value}`);
      continue;
    }
    throw new Error(`不认识的设置项：${key}（可改的字段见技能说明，或先调 get_state）`);
  }

  if (Object.keys(next).length > 0) ctx.update(next);
  if (theme) ctx.setTheme(theme);
  if (applied.length === 0) return "没有需要修改的设置项。";
  return `已更新：${applied.join("、")}`;
}

async function addWorkspace(
  args: Record<string, unknown>,
  ctx: AppAgentContext,
): Promise<string> {
  const path = requireString(args.path, "path");
  const name =
    typeof args.name === "string" && args.name.trim() ? args.name.trim() : folderName(path);
  const workspace: Workspace = {
    id: newWorkspaceId(),
    name,
    roots: [path],
    activeRoot: path,
  };
  const opened = await ctx.openWorkspace(workspace);
  if (!opened) {
    throw new Error(`打不开目录 ${path}：它可能不存在、不是目录，或没有访问权限`);
  }
  return `已添加并打开工作区「${opened.name}」（${opened.activeRoot}）`;
}

/** 按路径或名字找一个工作区；找不到时报错并把可选的名字列出来，方便模型改口。 */
function findWorkspace(ctx: AppAgentContext, reference: string): Workspace {
  const needle = reference.trim();
  if (!needle) throw new Error("要指定工作区名或路径");
  const byPath = ctx.workspaces.find((item) =>
    item.roots.some((root) => samePath(root, needle)),
  );
  const byName =
    ctx.workspaces.find((item) => item.name === needle) ??
    ctx.workspaces.find((item) => item.name.toLowerCase() === needle.toLowerCase());
  const hit = byPath ?? byName;
  if (!hit) {
    const names = ctx.workspaces.map((item) => item.name);
    throw new Error(
      `找不到工作区「${needle}」。当前工作区：${names.length ? names.join("、") : "（一个都没有）"}`,
    );
  }
  return hit;
}

function asSection(value: unknown): SettingsSection | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !SECTIONS.includes(value as SettingsSection)) {
    throw new Error(`section 只能取 ${SECTIONS.join(" / ")}，或省略表示全部`);
  }
  return value as SettingsSection;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少参数 ${field}`);
  return value.trim();
}
