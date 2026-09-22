/**
 * 刮开覆盖率统计。
 * 职责边界：只回答"刮开了多大比例"，不参与渲染与业务流转。
 *
 * 技术选型：粗粒度网格位图，而非 getImageData 逐像素统计。
 * - 把卡面划分为 cols x rows 的网格（默认 40x24 = 960 格，每格约 8px），
 *   擦除笔画经过的格子被置位，覆盖率 = 已置位格数 / 总格数；
 * - 每次 pointermove 的统计成本为 O(笔画包围盒内的格子数)（几十次简单运算），
 *   无需任何 GPU 回读，可以每帧实时调用，也就无需额外节流；
 * - 取舍：精度是格子粒度而非像素粒度（误差 < 1 格），对"60% 结算"
 *   这类阈值判定完全够用；统计单调递增，不会反复。
 */
export function createCoverageTracker({
  width,
  height,
  cols = 40,
  rows = 24,
  brushRadius = 18,
}) {
  const cellW = width / cols
  const cellH = height / rows
  // 格子半径补偿：格子中心距笔画 <= 笔刷半径 + 格子外接圆半径即视为被覆盖
  const cellRadius = Math.hypot(cellW, cellH) / 2
  const cells = new Uint8Array(cols * rows)
  let covered = 0

  /** 标记一条笔画线段（逻辑坐标）扫过的格子 */
  function stampSegment(x0, y0, x1, y1) {
    const reach = brushRadius + cellRadius
    const minCx = clampCell(Math.floor((Math.min(x0, x1) - reach) / cellW), cols)
    const maxCx = clampCell(Math.floor((Math.max(x0, x1) + reach) / cellW), cols)
    const minCy = clampCell(Math.floor((Math.min(y0, y1) - reach) / cellH), rows)
    const maxCy = clampCell(Math.floor((Math.max(y0, y1) + reach) / cellH), rows)

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const idx = cy * cols + cx
        if (cells[idx]) continue
        const px = (cx + 0.5) * cellW
        const py = (cy + 0.5) * cellH
        if (distToSegment(px, py, x0, y0, x1, y1) <= reach) {
          cells[idx] = 1
          covered++
        }
      }
    }
  }

  return {
    stampSegment,
    ratio: () => covered / cells.length,
    reset() {
      cells.fill(0)
      covered = 0
    },
  }
}

function clampCell(v, max) {
  return v < 0 ? 0 : v > max - 1 ? max - 1 : v
}

/** 点到线段的最短距离 */
function distToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0
  const dy = y1 - y0
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = x0 + t * dx
  const cy = y0 + t * dy
  return Math.hypot(px - cx, py - cy)
}
