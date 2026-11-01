import type { WorkstreamInfo } from "./types";

/**
 * 一条工作线（工作树 / 本地分支）此刻的状态。
 *
 * 这里把原先总览面板里那套「Git 事实」与「需要你」两套判据合成一套：
 * 之前同一个工作树在「需要你」和工作树列表里可能显示两种说法，用户建立不起心智。
 * 现在全应用只有这一份判据，雷达排序、图标条角标、行内文案都从它来。
 *
 * 判据分两层：
 * - Git 事实：冲突、合并中、游离 HEAD、未提交、待合并、已合并；
 * - 运行时事实：工作树里有没有终端在跑、终端是不是停在「等用户」上。
 *   这两项只有雷达能拿到（终端会话按 cwd 归属），所以由调用方传进来。
 */

export type WorkstreamTone = "danger" | "warn" | "accent" | "ok" | "muted";

export interface WorkstreamState {
  label: string;
  tone: WorkstreamTone;
  /** 越大越该先看：雷达按它排序，图标条角标数 `needsYou` 的那几条 */
  weight: number;
  /** 是不是「要人处理」——冲突、卡住、agent 在等你 */
  needsYou: boolean;
}

/** Git 之外才知道的信号 */
export interface WorkstreamSignals {
  /** cwd 落在这条工作线里的终端会话数 */
  terminals: number;
  /** 这些会话里有没有停在「等用户」上的 */
  waiting: boolean;
}

const IDLE: WorkstreamSignals = { terminals: 0, waiting: false };

export function workstreamState(
  item: WorkstreamInfo,
  signals: WorkstreamSignals = IDLE,
): WorkstreamState {
  // Git 的 prunable 标记可能滞后于目录实际状态；目录存在时仍可进入，不能报失联。
  if (!item.exists) {
    return { label: "目录失联", tone: "danger", weight: 100, needsYou: true };
  }
  // 冲突 / 合并中：下一步只能人来做，排在「在等你」前面
  if (item.conflicts > 0) {
    return { label: `冲突 ${item.conflicts}`, tone: "danger", weight: 98, needsYou: true };
  }
  if (item.merging) {
    return { label: "合并中", tone: "danger", weight: 95, needsYou: true };
  }
  // 智能体/终端停在交互提示上，这是 Agent 编程里最该被看见的一条
  if (signals.waiting) {
    return { label: "在等你", tone: "warn", weight: 90, needsYou: true };
  }
  // 游离 HEAD 不是错误，但提交容易丢，值得提醒一句
  if (item.detached) {
    return { label: "游离 HEAD", tone: "warn", weight: 80, needsYou: true };
  }
  // 有终端在跑、工作区又脏：说明智能体正在这棵树上干活
  if (signals.terminals > 0 && item.changed > 0) {
    return { label: "运行中", tone: "accent", weight: 70, needsYou: false };
  }
  // 分支条目本身没有工作区，只可能「有独有提交」或「已合进基准」
  if (item.kind === "branch") {
    return item.merged
      ? { label: "已合并", tone: "ok", weight: 20, needsYou: false }
      : { label: "待合并", tone: "accent", weight: 55, needsYou: false };
  }
  // 有未提交改动但没终端在跑：多半是上一轮 agent 停下留下的
  if (item.changed > 0) {
    return { label: `${item.changed} 处未提交`, tone: "warn", weight: 45, needsYou: false };
  }
  // head === baseHead 是刚建出来还没干活的树，只能说「干净」，不能说「已合并」
  if (item.merged && item.head !== item.baseHead) {
    return { label: "已合并", tone: "ok", weight: 20, needsYou: false };
  }
  if (item.ahead > 0) {
    return { label: "待合并", tone: "accent", weight: 55, needsYou: false };
  }
  return { label: "干净", tone: "muted", weight: 10, needsYou: false };
}
