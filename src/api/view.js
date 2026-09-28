/**
 * 服务端公开视图的白名单过滤器（设计 4.2 内存门控）。
 *
 * 唯一真相来源是服务端；本模块只是纵深防御：即便服务端/中间层误在未揭晓
 * 卡对象上附带 seed/prize/receipt，前端也不会把它纳入内存视图，更不会落盘。
 * 未揭晓卡出现秘密字段属于协议错误：该卡更新整体丢弃，返回 null。
 *
 * 纯函数，无 DOM / fetch 依赖，可被 node --test 直接单测。
 */

export const CARD_STATUS = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  REVEALED: 'revealed',
  CLAIMED: 'claimed',
  EXPIRED: 'expired',
})

const STATUSES = new Set(Object.values(CARD_STATUS))

const PRIZE_NAME_PATTERN = /[^\x20-\x7e]/

function isString(value) {
  return typeof value === 'string'
}

function isFiniteInteger(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizePrize(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!isString(raw.name) || raw.name.length === 0 || raw.name.length > 100) return null
  return { name: raw.name, win: Boolean(raw.win) }
}

function sanitizeReceipt(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!isString(raw.seedHex) || !/^[0-9a-f]{32}$/.test(raw.seedHex)) return null
  if (!isString(raw.commitment) || !/^[0-9a-f]{64}$/.test(raw.commitment)) return null
  if (!isString(raw.algorithm) || !isString(raw.signature)) return null
  if (!isString(raw.weightsVersion)) return null
  if (!isString(raw.serverTime)) return null
  return {
    seedHex: raw.seedHex,
    algorithm: raw.algorithm,
    weightsVersion: raw.weightsVersion,
    commitment: raw.commitment,
    serverTime: raw.serverTime,
    signature: raw.signature,
  }
}

/**
 * 把任意来源的卡对象过滤为安全公开视图。
 * @returns {object|null} 协议错误（缺字段 / 未揭晓带秘密）时返回 null
 */
export function sanitizeCardView(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!isString(raw.cardId) || !isString(raw.campaignId)) return null
  if (!STATUSES.has(raw.status)) return null
  const rev = isFiniteInteger(raw.rev) && raw.rev >= 0 ? Math.trunc(raw.rev) : null
  if (rev === null) return null

  const view = {
    cardId: raw.cardId,
    campaignId: raw.campaignId,
    status: raw.status,
    rev,
  }

  if (isString(raw.expiresAt)) view.expiresAt = raw.expiresAt
  if (isString(raw.commitment) && /^[0-9a-f]{64}$/.test(raw.commitment)) {
    view.commitment = raw.commitment
  }

  const open = raw.status === CARD_STATUS.REVEALED || raw.status === CARD_STATUS.CLAIMED

  if (!open) {
    // 一票否决：未揭晓卡视图里出现任何可推出结果的字段，丢弃整个更新
    if ('prize' in raw && raw.prize != null) return null
    if ('seed' in raw && raw.seed != null) return null
    if ('seedHex' in raw && raw.seedHex != null) return null
    if ('receipt' in raw && raw.receipt != null) return null
    return view
  }

  const prize = sanitizePrize(raw.prize)
  if (!prize) return null
  view.prize = prize

  const receipt = sanitizeReceipt(raw.receipt)
  if (receipt) view.receipt = receipt
  if (isString(raw.claimRef)) view.claimRef = raw.claimRef
  return view
}

/**
 * 过滤一个活动快照（GET /state、/recover、begin/reveal/claim 后的对齐结果）。
 * 无法识别的卡直接剔除；返回结构始终完整。
 */
export function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!isString(raw.campaignId)) return null
  const cards = Array.isArray(raw.cards)
    ? raw.cards.map(sanitizeCardView).filter(Boolean)
    : []
  const snapshot = {
    campaignId: raw.campaignId,
    cards,
  }
  if (isFiniteInteger(raw.chancesLeft) && raw.chancesLeft >= 0) {
    snapshot.chancesLeft = Math.min(2 ** 31 - 1, Math.trunc(raw.chancesLeft))
  }
  if (isFiniteInteger(raw.dailyChances) && raw.dailyChances >= 0) {
    snapshot.dailyChances = Math.trunc(raw.dailyChances)
  }
  if (isString(raw.title)) snapshot.title = raw.title
  if (isString(raw.subtitle)) snapshot.subtitle = raw.subtitle
  if (Array.isArray(raw.cardIds)) {
    snapshot.cardIds = raw.cardIds.filter(isString)
  }
  return snapshot
}

/** 过滤整份全量视图（含 serverTime/day） */
export function sanitizeFullView(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!Array.isArray(raw.campaigns)) return null
  const campaigns = raw.campaigns.map(sanitizeSnapshot).filter(Boolean)
  const view = { campaigns }
  if (isString(raw.serverTime)) view.serverTime = raw.serverTime
  if (isString(raw.day) && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)) view.day = raw.day
  if (typeof raw.clockAnomaly === 'boolean') view.clockAnomaly = raw.clockAnomaly
  return view
}

/** 深扫描：一段文本中是否包含任一奖品名（验收 A2/B5 用） */
export function textContainsAnyPrizeName(text, prizes) {
  if (!isString(text)) return false
  return prizes.some((prize) => isString(prize?.name) && text.includes(prize.name))
}

export { PRIZE_NAME_PATTERN }
