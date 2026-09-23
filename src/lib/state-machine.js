/**
 * 活动状态机 / 规则引擎（纯逻辑，不依赖 DOM / Canvas / window / storage，
 * 可在 Node 中直接单测）。
 *
 * 状态机（单卡）：
 *   idle(未开始) --beginScratch--> scratching(刮刮中)
 *   scratching    --reveal--------> revealed(已刮开未领取)
 *   revealed      --claim---------> claimed(已领取)
 *
 * 关键规则：
 * - beginScratch 首次生效那一刻扣 1 次机会，生成 seed + 哈希并按权重锁定奖品，
 *   之后刷新/重进都不重抽、不重扣（chanceSpent 幂等护栏）；
 * - 刷新时处于 scratching 的卡回退 idle（涂层复原可重刮），次数不退、
 *   奖品不重摇；处于 revealed 的卡保持 revealed；
 * - applyRollover 负责跨天/时间回拨判定后的归零或延续；
 * - 所有迁移均为对传入状态的纯变换：不修改入参，返回 { state, result }，
 *   CAS 重试时可安全地对新快照重放。
 */

import { drawPrize, fnv1aHex } from './randomness.js'

export const CARD_STATE = Object.freeze({
  IDLE: 'idle',
  SCRATCHING: 'scratching',
  REVEALED: 'revealed',
  CLAIMED: 'claimed',
})

export function freshCard() {
  return { state: CARD_STATE.IDLE, prize: null, chanceSpent: false, seed: null, seedHash: null }
}

/** 构造全新的一天（或首次加载）的活动状态 */
export function createDailyState({ date, cardIds }) {
  return {
    date,
    lastDate: date,
    timeAnomaly: false,
    chancesUsed: 0,
    cards: Object.fromEntries(cardIds.map((id) => [id, freshCard()])),
  }
}

function cloneState(state) {
  return { ...state, cards: Object.fromEntries(Object.entries(state.cards).map(([id, c]) => [id, { ...c }])) }
}

/**
 * 根据当前日期做跨天结算（纯函数）。
 * 回滚到新一天时所有卡片归零；同一天则只刷新日期与告警标记。
 */
export function applyRollover(state, { cardIds, currentDate, resolveDayFn }) {
  const day = resolveDayFn(state.lastDate, currentDate)
  if (day.verdict === 'reset') {
    return { state: createDailyState({ date: day.date, cardIds }), changed: true, anomaly: false }
  }
  if (state.date === day.date && state.lastDate === day.date && Boolean(state.timeAnomaly) === day.anomaly) {
    return { state, changed: false, anomaly: day.anomaly }
  }
  return {
    state: { ...state, date: day.date, lastDate: day.date, timeAnomaly: day.anomaly },
    changed: true,
    anomaly: day.anomaly,
  }
}

/**
 * 开始刮卡（纯迁移）。
 * @returns {{state:object, result:{ok:boolean, reason?:string}}}
 */
export function transitionBegin(state, { cardId, dailyChances, prizes, seed }) {
  const card = state.cards[cardId]
  if (!card) return { state, result: { ok: false, reason: 'unknown-card' } }
  if (card.state !== CARD_STATE.IDLE && card.state !== CARD_STATE.SCRATCHING) {
    return { state, result: { ok: false, reason: 'invalid-state' } }
  }
  if (!card.chanceSpent && state.chancesUsed >= dailyChances) {
    return { state, result: { ok: false, reason: 'no-chances' } }
  }

  const next = cloneState(state)
  const nextCard = next.cards[cardId]
  if (!nextCard.chanceSpent) {
    // 扣减 + 锁定奖品与公平性凭证（seed 此刻才产生）
    next.chancesUsed += 1
    nextCard.chanceSpent = true
    nextCard.seed = seed >>> 0
    nextCard.prize = drawPrize(prizes, nextCard.seed)
    nextCard.seedHash = fnv1aHex(String(nextCard.seed))
  }
  nextCard.state = CARD_STATE.SCRATCHING
  return { state: next, result: { ok: true, card: nextCard } }
}

/** scratching -> revealed（纯迁移） */
export function transitionReveal(state, { cardId }) {
  const card = state.cards[cardId]
  if (!card) return { state, result: { ok: false, reason: 'unknown-card' } }
  if (card.state !== CARD_STATE.SCRATCHING) {
    return { state, result: { ok: false, reason: 'invalid-state' } }
  }
  const next = cloneState(state)
  next.cards[cardId].state = CARD_STATE.REVEALED
  return { state: next, result: { ok: true, card: next.cards[cardId] } }
}

/** revealed -> claimed（纯迁移）；先到先得，重复领取由调用方据此提示 */
export function transitionClaim(state, { cardId }) {
  const card = state.cards[cardId]
  if (!card) return { state, result: { ok: false, reason: 'unknown-card' } }
  if (card.state !== CARD_STATE.REVEALED) {
    return { state, result: { ok: false, reason: 'invalid-state' } }
  }
  const next = cloneState(state)
  next.cards[cardId].state = CARD_STATE.CLAIMED
  return { state: next, result: { ok: true, card: next.cards[cardId] } }
}

/**
 * 刷新恢复（纯函数）：进行中的 scratching 回退为 idle（涂层复原可重刮），
 * 但 chanceSpent / prize / seed 全部保留，不重扣不重摇。
 */
export function normalizeAfterReload(state) {
  let changed = false
  const cards = {}
  for (const [id, card] of Object.entries(state.cards)) {
    if (card.state === CARD_STATE.SCRATCHING) {
      cards[id] = { ...card, state: CARD_STATE.IDLE }
      changed = true
    } else {
      cards[id] = card
    }
  }
  return changed ? { ...state, cards } : state
}

/** 清洗 v2 快照：未知卡剔除、非法字段回退默认（迁移/外部数据入口共用） */
export function sanitizeDailyState(input, { cardIds, date, maxChances }) {
  const base = createDailyState({ date, cardIds })
  if (!input || typeof input !== 'object') return base
  const limit = Number.isFinite(Number(maxChances))
    ? Math.max(0, Math.floor(Number(maxChances)))
    : cardIds.length
  const chancesUsed = Number(input.chancesUsed)
  base.chancesUsed = Number.isFinite(chancesUsed)
    ? Math.min(limit, Math.max(0, Math.floor(chancesUsed)))
    : 0
  for (const id of cardIds) {
    const raw = input.cards && typeof input.cards === 'object' ? input.cards[id] : null
    const card = base.cards[id]
    if (raw && typeof raw === 'object') {
      if (raw.prize && typeof raw.prize === 'object' && typeof raw.prize.name === 'string') {
        card.prize = { name: raw.prize.name, win: Boolean(raw.prize.win) }
      }
      card.chanceSpent = Boolean(raw.chanceSpent)
      const seedNum = Number(raw.seed)
      card.seed = Number.isFinite(seedNum) ? seedNum >>> 0 : null
      card.seedHash = typeof raw.seedHash === 'string' ? raw.seedHash : null
      if (Object.values(CARD_STATE).includes(raw.state)) card.state = raw.state
    }
    // 只有确实消耗过机会的卡才允许保留奖品/进行态，否则重摇防护无意义
    if (!card.chanceSpent) {
      card.prize = null
      card.seed = null
      card.seedHash = null
      card.state = CARD_STATE.IDLE
    }
  }
  base.timeAnomaly = Boolean(input.timeAnomaly)
  return base
}
