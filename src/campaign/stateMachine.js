/**
 * 活动状态机与规则（纯逻辑模块）。
 * 职责边界：只负责状态迁移、每日次数扣减、开奖；不碰 DOM、不碰存储。
 * 所有函数输入输出均为普通对象，可注入 rng / now，便于单元测试。
 */

export const CARD_STATUS = Object.freeze({
  IDLE: 'idle', // 未开始
  SCRATCHING: 'scratching', // 刮刮中（结果已锁定）
  REVEALED: 'revealed', // 已刮开未领取
  CLAIMED: 'claimed', // 已领取
})

export const DAILY_ATTEMPTS = 3
export const REVEAL_THRESHOLD = 0.6

export const PRIZES = Object.freeze([
  { id: 'coupon-5', name: '5 元优惠券', win: true, weight: 15 },
  { id: 'free-order', name: '免单券', win: true, weight: 5 },
  { id: 'none', name: '谢谢参与', win: false, weight: 80 },
])

/** 本地日期 key（跨天重置以本地日期为准） */
export function todayKey(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 按权重开奖，rng 可注入以便测试 */
export function rollPrize(rng = Math.random) {
  const total = PRIZES.reduce((sum, p) => sum + p.weight, 0)
  let r = rng() * total
  for (const p of PRIZES) {
    r -= p.weight
    if (r < 0) return { id: p.id, name: p.name, win: p.win }
  }
  const last = PRIZES[PRIZES.length - 1]
  return { id: last.id, name: last.name, win: last.win }
}

export function createCampaignState(now = new Date()) {
  return { day: todayKey(now), attemptsUsed: 0, cards: {} }
}

/**
 * 归一化外部读入的原始数据：
 * - 跨天（raw.day !== 今天）时次数清零，但卡片状态保留；
 * - 丢弃非法字段，容忍脏数据。
 */
export function normalizeState(raw, now = new Date()) {
  const state = createCampaignState(now)
  if (!raw || typeof raw !== 'object') return state
  if (raw.day === state.day && Number.isFinite(raw.attemptsUsed)) {
    state.attemptsUsed = Math.max(0, Math.min(DAILY_ATTEMPTS, Math.floor(raw.attemptsUsed)))
  }
  if (raw.cards && typeof raw.cards === 'object') {
    for (const [id, card] of Object.entries(raw.cards)) {
      if (card && Object.values(CARD_STATUS).includes(card.status)) {
        state.cards[id] = { status: card.status, prize: card.prize ?? null }
      }
    }
  }
  return state
}

export function remainingAttempts(state) {
  return Math.max(0, DAILY_ATTEMPTS - state.attemptsUsed)
}

/**
 * 开始刮卡：扣减次数并在这一刻锁定开奖结果（防刷新刷奖）。
 * 已开始的卡重复调用为幂等操作，返回已锁定的 prize，不会重新随机。
 */
export function startScratch(state, cardId, rng = Math.random) {
  const card = state.cards[cardId]
  if (card && card.status !== CARD_STATUS.IDLE) {
    return { ok: true, state, prize: card.prize, alreadyStarted: true }
  }
  if (remainingAttempts(state) <= 0) {
    return { ok: false, reason: 'no-attempts', state }
  }
  const prize = rollPrize(rng)
  const next = {
    ...state,
    attemptsUsed: state.attemptsUsed + 1,
    cards: { ...state.cards, [cardId]: { status: CARD_STATUS.SCRATCHING, prize } },
  }
  return { ok: true, state: next, prize }
}

/** 刮开完成：scratching -> revealed（唯一合法来源状态） */
export function completeReveal(state, cardId) {
  const card = state.cards[cardId]
  if (!card || card.status !== CARD_STATUS.SCRATCHING) {
    return { ok: false, reason: 'invalid-transition', state }
  }
  return {
    ok: true,
    state: {
      ...state,
      cards: { ...state.cards, [cardId]: { ...card, status: CARD_STATUS.REVEALED } },
    },
  }
}

/** 领取：revealed -> claimed（唯一合法来源状态） */
export function claimPrize(state, cardId) {
  const card = state.cards[cardId]
  if (!card || card.status !== CARD_STATUS.REVEALED) {
    return { ok: false, reason: 'invalid-transition', state }
  }
  return {
    ok: true,
    state: {
      ...state,
      cards: { ...state.cards, [cardId]: { ...card, status: CARD_STATUS.CLAIMED } },
    },
  }
}
