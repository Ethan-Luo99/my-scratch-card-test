/**
 * 存储版本化与数据迁移（纯函数，旧数据进、新数据出，可直接 Node 单测）。
 *
 * 信封格式（v2，按活动一个 key：`scratch-campaign:v2:<namespace>`）：
 * {
 *   version: 2,
 *   rev: number,                 // 单调递增的写入版本号（CAS / 去重）
 *   state: {
 *     date, lastDate,            // 当前归属日 / 最近活跃日期（防回拨）
 *     timeAnomaly,               // 是否检测到系统时间异常
 *     chancesUsed,               // 当日已用次数
 *     cards: { [cardId]: {
 *       state, chanceSpent, prize:{name,win}|null, seed, seedHash
 *     }}
 *   }
 * }
 *
 * 旧格式（v1，单 key 'scratch-campaign-v1'）：
 * { date, chancesUsed, cards: { id: { state, prize, chanceSpent } } }
 *
 * 迁移保证：chancesUsed、已锁定奖品、"已刮开未领取"中间态、日期字段全部保留；
 * 缺字段 / 类型错误 / 未知版本一律容错（能修则修，不能修则按当日新状态处理）。
 */

export const STORAGE_VERSION = 2
export const LEGACY_KEY = 'scratch-campaign-v1'

export function freshEnvelope({ date, cardIds, createDailyStateFn }) {
  return {
    version: STORAGE_VERSION,
    rev: 0,
    state: createDailyStateFn({ date, cardIds }),
  }
}

/**
 * 把任意来源的已解析数据迁移为当前版本信封。
 * @param {unknown} parsed 已 JSON.parse 的旧/新数据（也可能是 null / 垃圾值）
 * @param {{date:string, cardIds:string[], currentVersion?:number, createDailyStateFn:Function}} ctx
 * @returns {{envelope:object, migrated:boolean}} migrated=true 表示由旧格式迁移而来
 */
export function migrateData(parsed, { date, cardIds, dailyChances, createDailyStateFn, sanitizeFn }) {
  const fresh = freshEnvelope({ date, cardIds, createDailyStateFn })

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { envelope: fresh, migrated: false }
  }

  const version = Number(parsed.version)

  if (version === STORAGE_VERSION && parsed.state && typeof parsed.state === 'object') {
    // 当前版本：仅做字段级容错清洗，rev 保留（0 视为初始写入）
    const rev = Number(parsed.rev)
    const state = sanitizeFn(parsed.state, { cardIds, date, dailyChances })
    // 日期字段：state 内自带的日期优先（迁移语义：日期字段保留），非法才用今天
    if (typeof parsed.state.date === 'string') state.date = parsed.state.date
    if (typeof parsed.state.lastDate === 'string') state.lastDate = parsed.state.lastDate
    return {
      envelope: {
        version: STORAGE_VERSION,
        rev: Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0,
        state,
      },
      migrated: false,
    }
  }

  // 未知版本（含大于当前版本）：保守起见不信任结构，按新一天处理
  if (Number.isFinite(version)) return { envelope: fresh, migrated: false }

  // 无版本号：按旧版 v1 结构尝试无损迁移
  const legacy = parsed
  const state = createDailyStateFn({ date, cardIds })

  const cap = Number.isFinite(dailyChances) ? dailyChances : cardIds.length
  const used = Number(legacy.chancesUsed)
  state.chancesUsed = Number.isFinite(used)
    ? Math.min(cap, Math.max(0, Math.floor(used)))
    : 0

  // 日期字段原样保留（后续 rollover 逻辑负责跨天/回拨判定）
  if (typeof legacy.date === 'string') state.date = legacy.date
  if (typeof legacy.date === 'string') state.lastDate = legacy.date

  if (legacy.cards && typeof legacy.cards === 'object') {
    for (const id of cardIds) {
      const raw = legacy.cards[id]
      const card = state.cards[id]
      if (!raw || typeof raw !== 'object') continue
      card.chanceSpent = Boolean(raw.chanceSpent)
      if (raw.prize && typeof raw.prize === 'object' && typeof raw.prize.name === 'string') {
        card.prize = { name: raw.prize.name, win: Boolean(raw.prize.win) }
      }
      if (['idle', 'scratching', 'revealed', 'claimed'].includes(raw.state)) {
        // scratching 中间态随刷新恢复规则归一为 idle，机会/奖品保留
        card.state = raw.state === 'scratching' ? 'idle' : raw.state
      }
      // 一致性护栏：没花过机会的卡不允许带着奖品/进度
      if (!card.chanceSpent) {
        card.prize = null
        card.state = 'idle'
      }
    }
  }

  return { envelope: { version: STORAGE_VERSION, rev: 0, state }, migrated: true }
}
