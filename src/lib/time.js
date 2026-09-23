/**
 * 本地日期与时间篡改防御（纯逻辑，now 可注入，可直接 Node 单测）。
 *
 * 规则（不变量：date 永不晚于 lastDate）：
 * - currentDate >  lastDate        -> RESET，正常跨天，新的一天；
 * - currentDate == lastDate        -> SAME，同一天延续；
 * - currentDate <  lastDate        -> SAME + anomaly，系统时间被回拨，
 *                                     按已持久化的那一天继续，次数不重置、
 *                                     状态保留（防止"改回昨天刷次数"）。
 * 持久化缺失/非法时按第一天处理（不告警）。
 */

/** 本地日期串 YYYY-MM-DD */
export function localDateString(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 是否形如 YYYY-MM-DD 的合法日期串（且日历真实存在） */
export function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1) return false
  const daysInMonth = new Date(y, m, 0).getDate()
  return d <= daysInMonth
}

export const DAY_VERDICT = Object.freeze({
  SAME: 'same',
  RESET: 'reset',
})

/**
 * 判定当前日期相对持久化状态的跨天结论。
 * @param {string|null|undefined} lastDate 已持久化的最近活跃日期
 * @param {string} currentDate 当前本地日期
 * @returns {{verdict:'same'|'reset', date:string, anomaly:boolean}}
 */
export function resolveDay(lastDate, currentDate) {
  if (!isValidDateString(currentDate)) {
    // 当前时钟产出非法日期：不应发生；保守按同一天延续
    return {
      verdict: DAY_VERDICT.SAME,
      date: isValidDateString(lastDate) ? lastDate : currentDate,
      anomaly: Boolean(lastDate),
    }
  }
  if (!isValidDateString(lastDate)) {
    return { verdict: DAY_VERDICT.RESET, date: currentDate, anomaly: false }
  }
  if (currentDate > lastDate) {
    return { verdict: DAY_VERDICT.RESET, date: currentDate, anomaly: false }
  }
  if (currentDate === lastDate) {
    return { verdict: DAY_VERDICT.SAME, date: lastDate, anomaly: false }
  }
  // currentDate < lastDate：时间回拨，沿用 lastDate 延续当天
  return { verdict: DAY_VERDICT.SAME, date: lastDate, anomaly: true }
}
