/**
 * 服务端时钟与日账本（纯逻辑）。
 * day 一律按固定时区（默认 Asia/Shanghai，UTC+8）从服务端时钟推导，
 * 客户端时间与请求体中的任何时间字段均不参与授权判定。
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/** 固定偏移时区的 YYYY-MM-DD（不依赖运行环境本地时区） */
export function dayKeyFor(nowMs, offsetMinutes = 8 * 60) {
  const shifted = new Date(Number(nowMs) + offsetMinutes * 60 * 1000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isoTime(nowMs) {
  return new Date(Number(nowMs)).toISOString()
}

/**
 * 单调时钟基线：已持久化事件的最大时间戳为基线，时钟回拨时
 * 记账时间不回退（沿用更晚的已记账时刻），并标记 clockAnomaly。
 */
export function createMonotonicClock(clock) {
  let maxObservedMs = null
  let maxObservedDayKey = null
  return {
    /** 返回 { nowMs, dayKey, clockAnomaly }；nowMs 单调不减 */
    observe(offsetMinutes) {
      const raw = Number(clock())
      const anomaly = maxObservedMs !== null && raw < maxObservedMs
      const nowMs = anomaly ? maxObservedMs : raw
      const dayKey = dayKeyFor(nowMs, offsetMinutes)
      if (maxObservedMs === null || nowMs >= maxObservedMs) {
        maxObservedMs = nowMs
        maxObservedDayKey = dayKey
      }
      return { nowMs, dayKey, clockAnomaly: anomaly }
    },
    get maxObservedMs() {
      return maxObservedMs
    },
    get maxObservedDayKey() {
      return maxObservedDayKey
    },
  }
}
