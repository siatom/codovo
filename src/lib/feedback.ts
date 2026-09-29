import { invoke } from "@tauri-apps/api/core";

/**
 * 一条提交过的反馈。正文和大段讨论都在 Gitee 那边，这里只有索引信息——
 * 界面要正文就点 `url` 跳过去。
 */
export interface FeedbackRecord {
  /** Gitee issue 编号，形如 `IKIHSS`（不是数字 id） */
  number: string;
  title: string;
  url: string;
  /** open / progressing / closed / rejected；后端只透传，不翻译 */
  state: string;
  /** bug / feature / other */
  category: string;
  /** 提交时间（毫秒时间戳） */
  createdAt: number;
  /** 最近一次刷新状态的时间（毫秒时间戳） */
  updatedAt: number;
}

/**
 * 刷新结果。`errors` 是那些查不动的记录（比如 Gitee 那边被删了），
 * 剩下的照样更新——一条坏编号不该挡住整份列表。
 */
export interface FeedbackRefresh {
  records: FeedbackRecord[];
  errors: string[];
}

/** 反馈目标仓库。由后端给，避免前后端各抄一份 owner/repo 后漂移 */
export interface FeedbackTarget {
  owner: string;
  repo: string;
  /** 新建 issue 的网页地址，拼预填参数用 */
  webNewIssue: string;
}

/**
 * 本机 gitee CLI 的状态。反馈的提交与状态查询都交给它——令牌由 CLI 自己保管，
 * 本应用既不存也拿不到。
 */
export interface CliStatus {
  /** PATH 里找不找得到 gitee 命令 */
  available: boolean;
  /** CLI 自己那套凭据是否已登录 */
  loggedIn: boolean;
  /** 给用户看的原文：没装时的提示，或 CLI 报的原因 */
  detail: string;
}

/**
 * 反馈分类。value 存进记录，label 给人看——后端只当字符串存，不认这两个值。
 */
export const CATEGORIES = [
  { value: "bug", label: "缺陷" },
  { value: "feature", label: "建议" },
  { value: "other", label: "其他" },
] as const;

/** 分类的中文名。认不出的值原样返回，免得界面出现空白 */
export function categoryLabel(value: string): string {
  return CATEGORIES.find((item) => item.value === value)?.label ?? value;
}

/** issue 状态的中文名。Gitee 的四种状态，认不出的原样返回 */
export function stateLabel(state: string): string {
  switch (state) {
    case "open":
      return "待处理";
    case "progressing":
      return "处理中";
    case "closed":
      return "已解决";
    case "rejected":
      return "已关闭";
    default:
      return state;
  }
}

/** 目标仓库信息（含新建 issue 的网页地址） */
export function feedbackTarget(): Promise<FeedbackTarget> {
  return invoke<FeedbackTarget>("feedback_target");
}

/** 本机 gitee CLI 是否可用、是否已登录 */
export function cliStatus(): Promise<CliStatus> {
  return invoke<CliStatus>("feedback_cli_status");
}

/** 本机提交过的反馈记录，最近提交的在前 */
export function listFeedback(): Promise<FeedbackRecord[]> {
  return invoke<FeedbackRecord[]>("feedback_list");
}

/** 提交一条反馈，返回新建出来的记录 */
export function submitFeedback(
  title: string,
  body: string,
  category: string,
): Promise<FeedbackRecord> {
  return invoke<FeedbackRecord>("feedback_submit", { title, body, category });
}

/** 逐条刷新状态。没有配置令牌时后端直接报错 */
export function refreshFeedback(): Promise<FeedbackRefresh> {
  return invoke<FeedbackRefresh>("feedback_refresh");
}

/** 删掉一条本地记录。只清索引，不动 Gitee 上的 issue */
export function deleteFeedback(number: string): Promise<FeedbackRecord[]> {
  return invoke<FeedbackRecord[]>("feedback_delete", { number });
}

/**
 * 拼成 issue 正文：分类行在前、正文居中、环境信息在末尾。
 *
 * 两条提交路径（直连 API 和浏览器兜底）共用它——同一段文案在两处各拼一遍，
 * 迟早会有一处忘了改。
 */
export function composeBody(category: string, content: string, env: string): string {
  const head = `> 类型：${categoryLabel(category)}`;
  const tail = env ? `\n\n---\n\n${env}` : "";
  return `${head}\n\n${content.trim()}${tail}`;
}

/**
 * 随反馈一起提交的环境信息。版本号里那串 `<短 hash>[.dirty]` 才是「这一次构建」
 * 的身份（见 AGENTS.md），排查问题全指望它，所以必须带上。
 */
export function environmentInfo(): string {
  return [
    "**环境信息**",
    `- 版本：${__APP_VERSION__}`,
    `- 系统：${navigator.platform} · ${navigator.userAgent}`,
  ].join("\n");
}

/**
 * 没有令牌时的兜底地址：Gitee 的新建 issue 页 + 预填标题正文。
 *
 * 预填参数算是尽力而为——Gitee 不认这两个参数时页面照常打开，只是空的，
 * 所以调用方还要把正文写进剪贴板兜住这种情况。
 */
export function newIssueUrl(base: string, title: string, body: string): string {
  const query = new URLSearchParams({
    "issue[title]": title,
    "issue[description]": body,
  });
  return `${base}?${query.toString()}`;
}
