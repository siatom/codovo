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
 * 一条提交左侧的泳道图。
 *
 * 整块是 `self-stretch` 的：竖线一直画到行底。提交展开出文件列表时行会变高，竖线跟着延伸，
 * 上下两行之间才不会断线——只按提交行高度画的话，展开的行后面就缺一截。
 * 但 `tail`（本行才起始的泳道）只从提交行底往下延伸：它上方没有线，画满高会在提交点上方多出一截。
 */
export function CommitGraph({ row, width }: { row: GraphRow; width: number }) {
  const mid = GRAPH_ROW_H / 2;
  return (
    <div className="relative shrink-0 self-stretch" style={{ width }}>
      {/* 满高竖线先画，SVG 里的提交点盖在上面 */}
      {row.through.map((lane) => (
        <span
          key={`through-${lane}`}
          className="absolute top-0 bottom-0 -translate-x-1/2"
          style={{ left: laneX(lane), width: GRAPH_LINE_W, background: laneColorVar(lane) }}
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
            background: laneColorVar(lane),
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
            style={{ stroke: laneColorVar(edge.from) }}
          />
        ))}
        {row.bottom.map((edge, index) => (
          <path
            key={`bottom-${index}`}
            d={edgePath(edge, "bottom")}
            fill="none"
            strokeWidth={GRAPH_LINE_W}
            // 向下的线归「去往的那条泳道」所有：合并拐向第二父时才会跟着分支色，和下方的竖线接上
            style={{ stroke: laneColorVar(edge.to) }}
          />
        ))}
        <circle
          cx={laneX(row.lane)}
          cy={mid}
          r={GRAPH_DOT_R}
          style={{ fill: laneColorVar(row.lane) }}
        />
      </svg>
    </div>
  );
}
