/**
 * 旧本地信封（v1 单 key / v2 命名空间信封）的解析与分类（纯函数）。
 *
 * 信任边界：客户端自报数据默认可伪造。服务端只做搬运分类：
 * - claimed：只登记历史已领取（claimsLedger 去重），不补发、不增额度；
 * - revealed：登记为可领取待领记录，但去重键永久保留，防二次导入重复领；
 * - pending/scratching/idle 但 chanceSpent：已扣费未揭晓的本地开奖数据，
 *   按设计推荐策略 B 作废（只读历史，不导入可玩结果、不退次、不重摇）；
 * - idle 且未 chanceSpent：直接丢弃，不产生任何记录。
 */

/**
 * 把任意形态的 import payload 归一为信封数组。
 * 支持：{campaignId?, envelope:{...v2}}、v2 信封本体、v1 信封本体、
 * 或多信封 { envelopes:[...] }。
 * @returns {Array<{campaignId:string, envelope:object}>}
 */
export function normalizeEnvelopes(payload, fallbackCampaignId = 'daily') {
  if (!payload || typeof payload !== 'object') return []
  const list = []
  const pushOne = (raw, campaignId) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      list.push({ campaignId: typeof campaignId === 'string' ? campaignId : fallbackCampaignId, envelope: raw })
    }
  }
  if (Array.isArray(payload.envelopes)) {
    for (const item of payload.envelopes) {
      if (item && typeof item === 'object' && item.envelope) {
        pushOne(item.envelope, item.campaignId ?? fallbackCampaignId)
      }
    }
    return list
  }
  if (payload.envelope && typeof payload.envelope === 'object') {
    pushOne(payload.envelope, payload.campaignId ?? fallbackCampaignId)
    return list
  }
  pushOne(payload, payload.campaignId ?? fallbackCampaignId)
  return list
}

function isV2Envelope(envelope) {
  return Number(envelope.version) === 2 && envelope.state && typeof envelope.state === 'object'
}

/**
 * 分类一个信封内的卡片。
 * @returns {{
 *   campaignId:string, day:string|null,
 *   claimed:Array<{cardId:string,prize:object,seedHex:string|null}>,
 *   revealed:Array<{cardId:string,prize:object,seedHex:string|null,chanceSpent:boolean}>,
 *   spentUnrevealed:Array<{cardId:string}>,
 *   idleUnspent:Array<{cardId:string}>
 * }}
 */
export function classifyEnvelope(campaignId, envelope) {
  const result = {
    campaignId,
    day: null,
    claimed: [],
    revealed: [],
    spentUnrevealed: [],
    idleUnspent: [],
  }
  if (!envelope || typeof envelope !== 'object') return result

  const cards = isV2Envelope(envelope) ? envelope.state.cards ?? {} : envelope.cards ?? {}
  if (isV2Envelope(envelope)) {
    if (typeof envelope.state.date === 'string') result.day = envelope.state.date
  } else if (typeof envelope.date === 'string') {
    result.day = envelope.date
  }
  if (typeof cards !== 'object' || cards === null) return result

  for (const [cardId, raw] of Object.entries(cards)) {
    if (!raw || typeof raw !== 'object') continue
    const status = raw.state === 'scratching' ? 'idle' : raw.state
    const chanceSpent = Boolean(raw.chanceSpent)
    const prize =
      raw.prize && typeof raw.prize === 'object' && typeof raw.prize.name === 'string'
        ? { name: String(raw.prize.name), win: Boolean(raw.prize.win) }
        : null
    let seedHex = null
    if (Number.isFinite(Number(raw.seed)) && chanceSpent) {
      seedHex = (Number(raw.seed) >>> 0).toString(16).padStart(8, '0')
    }
    if (status === 'claimed' && chanceSpent && prize) {
      result.claimed.push({ cardId: String(cardId), prize, seedHex })
    } else if (status === 'revealed' && chanceSpent && prize) {
      result.revealed.push({ cardId: String(cardId), prize, seedHex, chanceSpent })
    } else if (chanceSpent) {
      result.spentUnrevealed.push({ cardId: String(cardId) })
    } else {
      result.idleUnspent.push({ cardId: String(cardId) })
    }
  }
  return result
}

/** 迁移记录的稳定去重键（永久，防"导入→领取→再导入→再领"） */
export function migrationDedupKey(sid, campaignId, day, cardId) {
  return `migrate#${sid}#${campaignId}#${day ?? 'unknown-day'}#${cardId}`
}

/** 正常开奖卡的 claimsLedger 去重键（设计 2.5 建议格式） */
export function cardDedupKey(sid, campaignId, cardId, weightsVersion, seedHex) {
  return `${sid}#${campaignId}#${cardId}#${weightsVersion}#${seedHex}`
}
