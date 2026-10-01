import {
  GRAPH_DOT_R,
  GRAPH_LINE_W,
  GRAPH_ROW_H,
  laneColorVar,
  laneX,
  type GraphEdge,
  type GraphRow,
} from "../lib/gitGraph";

/**
 * 跨泳道的连线画成三次贝塞尔，起止点都留竖直切线，和上下相邻行的线接上时才是顺的。
 * 同泳道就退化成半截竖线（提交点在行中间，所以分上下两半画）。
 */
function edgePath(edge: GraphEdge, half: "top" | "bottom"): string {
  const mid = GRAPH_ROW_H / 2;
  const x1 = laneX(edge.from);
  const x2 = laneX(edge.to);
  if (edge.from === edge.to) {
    return half === "top" ? `M ${x1} 0 V ${mid}` : `M ${x1} ${mid} V ${GRAPH_ROW_H}`;
  }
  if (half === "top") {
    return `M ${x1} 0 C ${x1} ${mid / 2}, ${x2} ${mid / 2}, ${x2} ${mid}`;
  }
  return `M ${x1} ${mid} C ${x1} ${mid + mid / 2}, ${x2} ${mid + mid / 2}, ${x2} ${GRAPH_ROW_H}`;
}

/**
 * 本地领先上游（未推送）那条线的颜色。和圆圈、主题文字用同一个强调色，
 * 一眼能把「还没推上去的那一截」串成一条。
 */
const LOCAL_LINE_COLOR = "var(--c-accent)";

/**
 * 一条提交左侧的泳道图。
 *
 * 整块是 `self-stretch` 的：竖线一直画到行底。提交展开出文件列表时行会变高，竖线跟着延伸，
 * 上下两行之间才不会断线——只按提交行高度画的话，展开的行后面就缺一截。
 * 但 `tail`（本行才起始的泳道）只从提交行底往下延伸：它上方没有线，画满高会在提交点上方多出一截。
 *
 * `local` = 这条提交还没推送到上游：圆圈放大换色，本行属于**它自己那条泳道**的线段也换色。
 * 只换本泳道是因为别的泳道是别的分支的线，跟推没推上去无关；拐进 / 拐出的连线归对端泳道所有，
 * 也保持原色。未推送的提交在列表里是连续的一段，所以换完就是一条完整换色的线。
 */
export function CommitGraph({
  row,
  width,
  local = false,
}: {
  row: GraphRow;
  width: number;
  /** 本地领先上游（未推送）的提交：圆圈 + 本泳道线段换色 */
  local?: boolean;
}) {
  const mid = GRAPH_ROW_H / 2;
  /** 某条泳道在本行的线用什么色：本行是未推送的，且正是它自己那条泳道，才换色 */
  const lineColor = (lane: number) =>
    local && lane === row.lane ? LOCAL_LINE_COLOR : laneColorVar(lane);
  return (
    <div className="relative shrink-0 self-stretch" style={{ width }}>
      {/* 满高竖线先画，SVG 里的提交点盖在上面 */}
      {row.through.map((lane) => (
        <span
          key={`through-${lane}`}
          className="absolute top-0 bottom-0 -translate-x-1/2"
          style={{ left: laneX(lane), width: GRAPH_LINE_W, background: lineColor(lane) }}
        />
      ))}
      {/* 本行才起始的泳道：只从提交行底（22px）往下画，上方留给 SVG 里的拐弯线 */}
      {row.tail.map((lane) => (
        <span
          key={`tail-${lane}`}
          className="absolute bottom-0 -translate-x-1/2"
          style={{
            left: laneX(lane),
            top: GRAPH_ROW_H,
            width: GRAPH_LINE_W,
            background: lineColor(lane),
          }}
        />
      ))}
      <svg
        width={width}
        height={GRAPH_ROW_H}
        viewBox={`0 0 ${width} ${GRAPH_ROW_H}`}
        className="absolute top-0 left-0"
        aria-hidden="true"
      >
        {row.top.map((edge, index) => (
          <path
            key={`top-${index}`}
            d={edgePath(edge, "top")}
            fill="none"
            strokeWidth={GRAPH_LINE_W}
            // 颜色走 style 而不是 stroke 属性：SVG 的表现属性不认 var()，内联样式才认
            style={{ stroke: lineColor(edge.from) }}
          />
        ))}
        {row.bottom.map((edge, index) => (
          <path
            key={`bottom-${index}`}
            d={edgePath(edge, "bottom")}
            fill="none"
            strokeWidth={GRAPH_LINE_W}
            // 向下的线归「去往的那条泳道」所有：合并拐向第二父时才会跟着分支色，和下方的竖线接上
            style={{ stroke: lineColor(edge.to) }}
          />
        ))}
        <circle
          cx={laneX(row.lane)}
          cy={mid}
          // 未推送的再放大一档：泳道配色里也有蓝（`--c-graph-1`），只换色的话
          // 它和同泳道的已推送提交看着还是像，多个尺寸差异才分得开
          r={local ? GRAPH_DOT_R + 1 : GRAPH_DOT_R}
          style={{ fill: local ? LOCAL_LINE_COLOR : laneColorVar(row.lane) }}
        />
      </svg>
    </div>
  );
}
