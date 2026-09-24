/**
 * 服务端时钟工具（纯逻辑）。
 *
 * 服务端固定按 Asia/Shanghai (UTC+8) 记账，与现状前端日期口径一致。
 * 授权 / 次数重置只看服务端时钟，客户端时间一律不参与。
 */

export const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

/** 返回 ISO-8601 UTC 时间串 */
export function toServerTime(nowMs) {
  return new Date(nowMs).toISOString()
}

/** 服务端时区（UTC+8）下的日期键 YYYY-MM-DD */
export function dayKeyForNow(nowMs) {
  const shifted = new Date(nowMs + SHANGHAI_UTC_OFFSET_MS)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 某日期键 23:59:59.999（UTC+8）对应的毫秒戳，用于过期判断 */
export function endOfDayShanghaiMs(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number)
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999) - SHANGHAI_UTC_OFFSET_MS
}

/**
 * 单调基线日：时钟回拨时不回退日账本。
 * @param {string|null|undefined} maxObservedDayKey 历史已记账的最大日期键
 * @param {string} currentDayKey 时钟当前日期键
 * @returns {{ dayKey: string, anomaly: boolean }}
 */
export function resolveEffectiveDay(maxObservedDayKey, currentDayKey) {
  if (!maxObservedDayKey || currentDayKey > maxObservedDayKey) {
    return { dayKey: currentDayKey, anomaly: false }
  }
  if (currentDayKey === maxObservedDayKey) {
    return { dayKey: maxObservedDayKey, anomaly: false }
  }
  return { dayKey: maxObservedDayKey, anomaly: true }
}
