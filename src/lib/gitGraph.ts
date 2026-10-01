import type { GitCommit } from "./types";

/** 相邻两条泳道的水平间距（px）。右侧栏窄，12 够放下线 + 点，还能留出点间隙 */
export const LANE_W = 12;

/** 每条提交行的高度（px）。图列的 SVG 与提交按钮都用它，上下两行才对得齐 */
export const GRAPH_ROW_H = 22;

/** 泳道线宽（px）。竖线 span 与 SVG 连线共用同一个值，别各写各的 */
export const GRAPH_LINE_W = 1.5;

/** 提交点半径（px） */
export const GRAPH_DOT_R = 4;

/** 泳道配色的数量，对应 styles.css 里的 --c-graph-1…8 */
const LANE_COLOR_COUNT = 8;

/** 一条连线：from / to 是泳道序号，相同即直连，不同即拐弯 */
export interface GraphEdge {
  from: number;
  to: number;
}

/** 一行提交在图里的画法 */
export interface GraphRow {
  /** 提交点所在的泳道 */
  lane: number;
  /** 从上方进入本行提交点的连线（同泳道直连 + 别的泳道拐入） */
  top: GraphEdge[];
  /** 从本行提交点向下连到各父提交的连线 */
  bottom: GraphEdge[];
  /** 贯穿整行的泳道，画满高竖线（含提交展开出来的文件区） */
  through: number[];
  /**
   * 本行才起始的泳道（分支尖端、合并的第二父）：线只从行底往下画。
   * 这些泳道在上方并不存在，若也按满高画，提交点上方会多出一截无主的出头线。
   */
  tail: number[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** 所有行用到的泳道总数，用来定图列的统一宽度，保证各行文字左对齐 */
  laneCount: number;
}

/** 找第一条空泳道；没有就在末尾追加一条 */
function firstFree(lanes: (string | null)[]): number {
  const free = lanes.indexOf(null);
  if (free !== -1) return free;
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * 把一串提交排成泳道图。输入必须按拓扑序（父一定排在子之后，后端用 `--topo-order` 保证），
 * 否则会先给父提交另开泳道、后面子提交再想接上去就接不上了。
 *
 * 做法是经典的「泳道记账」：`lanes[i]` 存这条泳道下一个该出现的提交 hash。
 * 遇到一条提交先找它在哪条泳道（找不到说明是分支尖端，新开一条）；第一父留在原泳道，
 * 其余父各占一条新泳道；还有别的泳道也在等这条提交（多个子分支汇入）的，这一行之后清掉。
 *
 * 每翻一页都拿完整的提交列表从头重排，结果只跟列表内容有关，分页不会让图跳变。
 */
export function layoutGraph(commits: readonly GitCommit[]): GraphLayout {
  /** 每条泳道下一个应出现的提交 hash；null = 空泳道 */
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    // 1. 找提交所在泳道；找不到（分支尖端）就新开一条
    let lane = lanes.indexOf(commit.hash);
    const found = lane !== -1;
    if (!found) {
      lane = firstFree(lanes);
      lanes[lane] = commit.hash;
    }

    // 本行之前就有线的泳道（分支尖端刚占上的那条不算），决定它算「贯穿」还是「本行新起」
    const hadLine = lanes.map((value, index) => value !== null && (index !== lane || found));

    // 2. 还有哪些泳道也在等这条提交（子分支汇入），它们这一行之后要清掉
    const converging: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (i !== lane && lanes[i] === commit.hash) converging.push(i);
    }

    // 3. 分配父提交：第一父留在本泳道，其余父各占一条新泳道
    const bottom: GraphEdge[] = [];
    const [firstParent, ...extraParents] = commit.parents;
    if (firstParent) {
      lanes[lane] = firstParent;
      bottom.push({ from: lane, to: lane });
    } else {
      lanes[lane] = null; // 根提交：这条泳道到此为止
    }
    for (const parent of extraParents) {
      const parentLane = firstFree(lanes);
      lanes[parentLane] = parent;
      bottom.push({ from: lane, to: parentLane });
    }

    // 4. 清掉汇入的泳道（它们此前一直等于 commit.hash）
    for (const index of converging) lanes[index] = null;

    // 5. 上边连线：本泳道（分支尖端不画）+ 各汇入泳道拐进来
    const top: GraphEdge[] = [];
    if (found) top.push({ from: lane, to: lane });
    for (const index of converging) top.push({ from: index, to: lane });

    // 6. 处理完仍非空的泳道：此前已有线的算贯穿，本行才起始的只往下画
    const through: number[] = [];
    const tail: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === null) continue;
      if (hadLine[i]) through.push(i);
      else tail.push(i);
    }

    rows.push({ lane, top, bottom, through, tail });

    // 行宽按这一行真正用到的最大泳道算，别被末尾的空泳道撑宽
    let rowMax = lane;
    for (const edge of top) rowMax = Math.max(rowMax, edge.from, edge.to);
    for (const edge of bottom) rowMax = Math.max(rowMax, edge.from, edge.to);
    for (const laneIndex of through) rowMax = Math.max(rowMax, laneIndex);
    for (const laneIndex of tail) rowMax = Math.max(rowMax, laneIndex);
    laneCount = Math.max(laneCount, rowMax + 1);
  }

  return { rows, laneCount };
}

/** 泳道序号 -> 主题里的图色变量名（8 色循环） */
export function laneColorVar(lane: number): string {
  return `var(--c-graph-${(lane % LANE_COLOR_COUNT) + 1})`;
}

/** 泳道中心的 x 坐标 */
export function laneX(lane: number): number {
  return lane * LANE_W + LANE_W / 2;
}

/** 提交行文字与本行圆圈（或最右泳道线）之间要留的净空隙 */
const GRAPH_TEXT_GAP = 6;

/** 提交行按钮的左右内边距（`px-1`）。算净空隙时要减掉它，改按钮 padding 这里要跟着改 */
const ROW_PADDING_X = 4;

/**
 * 提交行文字相对图列左边缘的偏移，可能是负数——文字要压到图列上，贴住本行的圆圈。
 *
 * 只按「本行真正会画出来的线」算：本行的圆圈、以及 top / bottom / through 里出现过的
 * 泳道。`tail` 不算——它的线从提交行底（y=22）才起，压不到标题，算进去的话合并行的
 * 标题会被一条根本没到它那儿的线推走。
 */
export function graphTextInset(row: GraphRow, width: number): number {
  let maxLane = row.lane;
  for (const edge of row.top) maxLane = Math.max(maxLane, edge.from, edge.to);
  for (const edge of row.bottom) maxLane = Math.max(maxLane, edge.from, edge.to);
  for (const lane of row.through) maxLane = Math.max(maxLane, lane);
  const right = Math.max(laneX(row.lane) + GRAPH_DOT_R, laneX(maxLane) + GRAPH_LINE_W / 2);
  return right + GRAPH_TEXT_GAP - ROW_PADDING_X - width;
}
