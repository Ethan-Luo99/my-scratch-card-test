/**
 * 服务端公开视图白名单清洗（纯函数，无 DOM / fetch 依赖）。
 *
 * 这是前端内存侧的唯一入口：任何来自服务端的卡对象在进入前端状态前，
 * 都必须经过 sanitizeCardView。
 *
 * 硬性不变量：
 * - 未揭晓（idle/pending）卡只允许 {cardId,campaignId,status,rev,
 *   commitment,expiresAt}；出现 prize/receipt/seed/seedHex 等字段视为
 *   协议错误，整卡丢弃（返回 null），调用方保留上一帧已知视图；
 * - 只有 revealed/claimed 才允许 prize 与 receipt；
 * - receipt 自身也按白名单裁剪，未知字段一律剔除。
 */

export const CARD_STATUS = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  REVEALED: 'revealed',
  CLAIMED: 'claimed',
  // expired 是 pending 超过 expiresAt 的纯展示态（服务端内部记 pending-expired，
  // 公开视图仍为 pending；机会不退、结果不重摇，仍可继续刮开命中同一结果）。
  EXPIRED: 'expired',
})

const PRE_REVEAL_STATUSES = new Set([CARD_STATUS.IDLE, CARD_STATUS.PENDING])
const POST_REVEAL_STATUSES = new Set([CARD_STATUS.REVEALED, CARD_STATUS.CLAIMED])

function asFiniteInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

function asIsoString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sanitizeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null
  const out = {}
  for (const field of ['seedHex', 'algorithm', 'weightsVersion', 'commitment', 'serverTime', 'signature']) {
    if (typeof receipt[field] === 'string') out[field] = receipt[field]
  }
  // receipt 至少要有 seedHex + signature 才有复核意义
  if (typeof out.seedHex !== 'string' || typeof out.signature !== 'string') return null
  return out
}

function sanitizePrize(prize) {
  if (!prize || typeof prize !== 'object') return null
  if (typeof prize.name !== 'string' || prize.name.length === 0) return null
  return { name: prize.name, win: Boolean(prize.win) }
}

/**
 * 清洗单卡公开视图。
 * @returns {object|null} 清洗后的卡视图；协议错误（未揭晓夹带秘密/形态非法）时 null
 */
export function sanitizeCardView(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const status = typeof raw.status === 'string' ? raw.status : null
  if (!isKnownStatus(status)) return null
  const rev = asFiniteInt(raw.rev)
  if (rev === null) return null
  if (typeof raw.cardId !== 'string' || raw.cardId.length === 0) return null

  const view = {
    cardId: raw.cardId,
    status,
    rev,
  }
  if (typeof raw.campaignId === 'string') view.campaignId = raw.campaignId
  if (typeof raw.commitment === 'string' && raw.commitment.length > 0) view.commitment = raw.commitment
  const expiresAt = asIsoString(raw.expiresAt)
  if (expiresAt) view.expiresAt = expiresAt

  if (PRE_REVEAL_STATUSES.has(status)) {
    // 一票否决：未揭晓视图绝不允许携带任何可推出结果的字段
    if (raw.prize !== undefined || raw.receipt !== undefined ||
      raw.seed !== undefined || raw.seedHex !== undefined) {
      return null
    }
    return view
  }

  // revealed / claimed
  const prize = sanitizePrize(raw.prize)
  if (!prize) return null
  view.prize = prize
  const receipt = sanitizeReceipt(raw.receipt)
  if (receipt) view.receipt = receipt
  if (status === CARD_STATUS.CLAIMED && typeof raw.claimRef === 'string') {
    view.claimRef = raw.claimRef
  }
  return view
}

function isKnownStatus(status) {
  return PRE_REVEAL_STATUSES.has(status) || POST_REVEAL_STATUSES.has(status)
}

/** 把无记录的卡槽位补成 idle 公开视图 */
export function idleCardView(cardId, campaignId) {
  return { cardId, campaignId, status: CARD_STATUS.IDLE, rev: 0 }
}

/**
 * 清洗 GET /api/state、POST /api/recover 的全量视图。
 * 非法/泄密的卡被丢弃（调用方可与上一帧合并）。
 */
export function sanitizeStateView(raw) {
  if (!raw || typeof raw !== 'object') return null
  const campaignsInput = Array.isArray(raw.campaigns) ? raw.campaigns : []
  const campaigns = []
  for (const item of campaignsInput) {
    if (!item || typeof item !== 'object' || typeof item.campaignId !== 'string') continue
    const cards = []
    if (Array.isArray(item.cards)) {
      for (const rawCard of item.cards) {
        const card = sanitizeCardView(rawCard)
        if (card) cards.push(card)
      }
    }
    const snapshot = {
      campaignId: item.campaignId,
      cards,
    }
    const chancesLeft = asFiniteInt(item.chancesLeft)
    if (chancesLeft !== null) snapshot.chancesLeft = chancesLeft
    const dailyChances = asFiniteInt(item.dailyChances)
    if (dailyChances !== null) snapshot.dailyChances = dailyChances
    if (typeof item.title === 'string') snapshot.title = item.title
    if (typeof item.subtitle === 'string') snapshot.subtitle = item.subtitle
    if (Array.isArray(item.cardIds)) {
      snapshot.cardIds = item.cardIds.filter((id) => typeof id === 'string')
    }
    campaigns.push(snapshot)
  }
  const view = { campaigns }
  if (typeof raw.serverTime === 'string') view.serverTime = raw.serverTime
  if (typeof raw.day === 'string') view.day = raw.day
  if (typeof raw.clockAnomaly === 'boolean') view.clockAnomaly = raw.clockAnomaly
  return view
}

/**
 * 纯展示派生：pending 超过 expiresAt 即显示 expired（不改变任何授权语义）。
 */
export function effectiveStatus(card, nowMs = Date.now()) {
  if (!card) return CARD_STATUS.IDLE
  if (card.status === CARD_STATUS.PENDING && card.expiresAt) {
    const expiresAtMs = Date.parse(card.expiresAt)
    if (Number.isFinite(expiresAtMs) && nowMs > expiresAtMs) return CARD_STATUS.EXPIRED
  }
  return card.status
}
