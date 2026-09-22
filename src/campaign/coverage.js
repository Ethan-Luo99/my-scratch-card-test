/**
 * 覆盖率检测（纯逻辑模块，可单测）。
 * 职责边界：只回答"刮开了多大比例"，不操作 Canvas。
 *
 * 技术选型：逻辑网格采样，而非 getImageData 逐像素统计。
 * - getImageData 会强制 CPU/GPU 同步、读回整幅位图，在 mousemove 中调用代价不可接受；
 * - 这里把卡面划分为 32x18 的逻辑网格，擦除时顺手把笔刷覆盖的格子打标，
 *   每次擦除代价 O(笔刷覆盖的格子数)，覆盖率查询 O(1)，完全无 GPU 读回。
 * 取舍：精度为单元格级（320x180 卡面下约 10px 见方），对 60% 阈值判定足够，
 *       且结果确定性高、不依赖设备像素比。
 */

export function createCoverageTracker(cols = 32, rows = 18) {
  const total = cols * rows
  const grid = new Uint8Array(total)
  let covered = 0

  function stampCircle(cx, cy, radius, width, height) {
    const cellW = width / cols
    const cellH = height / rows
    const colFrom = Math.max(0, Math.floor((cx - radius) / cellW))
    const colTo = Math.min(cols - 1, Math.floor((cx + radius) / cellW))
    const rowFrom = Math.max(0, Math.floor((cy - radius) / cellH))
    const rowTo = Math.min(rows - 1, Math.floor((cy + radius) / cellH))
    const r2 = radius * radius
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        const px = (col + 0.5) * cellW
        const py = (row + 0.5) * cellH
        const dx = px - cx
        const dy = py - cy
        if (dx * dx + dy * dy <= r2) {
          const idx = row * cols + col
          if (!grid[idx]) {
            grid[idx] = 1
            covered++
          }
        }
      }
    }
  }

  return {
    /** 沿线段打点（步长为半径一半，保证快速划动时采样连续），返回当前覆盖率 */
    stampSegment(x0, y0, x1, y1, radius, width, height) {
      const dx = x1 - x0
      const dy = y1 - y0
      const dist = Math.hypot(dx, dy)
      const step = Math.max(radius / 2, 1)
      const n = Math.max(1, Math.ceil(dist / step))
      for (let i = 0; i <= n; i++) {
        stampCircle(x0 + (dx * i) / n, y0 + (dy * i) / n, radius, width, height)
      }
      return covered / total
    },
    ratio() {
      return covered / total
    },
  }
}
