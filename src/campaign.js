/**
 * 活动状态机与规则引擎（纯逻辑，不依赖 DOM / Canvas / window）。
 * 职责边界：卡片状态迁移、每日次数控制、中奖结果锁定、跨天重置。
 * 存储通过注入的 store 适配器读写，rng / now 均可注入，可在 Node 中直接单测。
 *
 * 状态机：
 *   idle(未开始) --beginScratch--> scratching(刮刮中)
 *   scratching   --reveal--------> revealed(已刮开未领取)
 *   revealed     --claim---------> claimed(已领取)
 *
 * 关键规则：
 * - beginScratch 成功的那一刻扣减次数、按权重抽取奖品并锁定持久化，
 *   之后无论刷新还是重进都不允许重抽（防刷新刷奖）；
 * - 刷新时处于 scratching 的卡回退为 idle（涂层复原可重刮），
 *   但已扣次数不退、已锁定的奖品保留，重刮不再重复扣次数；
 * - 刷新时处于 revealed 的卡保持 revealed（涂层不回来，结果不变）；
 * - 以本地日期为准跨天重置：日期变化后次数与所有卡片状态全部归零。
 */

export const CARD_STATE = Object.freeze({
  IDLE: 'idle',
  SCRATCHING: 'scratching',
  REVEALED: 'revealed',
  CLAIMED: 'claimed',
})

/** 本地日期串 YYYY-MM-DD，作为"每日"的判定依据 */
export function localDateString(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function freshCard() {
  return { state: CARD_STATE.IDLE, prize: null, chanceSpent: false }
}

export function createCampaign({
  store,
  cardIds,
  prizes,
  dailyChances = 3,
  rng = Math.random,
  now = () => new Date(),
}) {
  const listeners = new Set()
  const state = load()

  function load() {
    const today = localDateString(now())
    const saved = store.load()
    const isValid =
      saved &&
      saved.date === today &&
      typeof saved.chancesUsed === 'number' &&
      saved.cards &&
      typeof saved.cards === 'object'

    if (!isValid) {
      // 无历史 / 跨天 / 数据损坏：全新的一天
      return {
        date: today,
        chancesUsed: 0,
        cards: Object.fromEntries(cardIds.map((id) => [id, freshCard()])),
      }
    }

    for (const id of cardIds) {
      const card = { ...freshCard(), ...saved.cards[id] }
      if (card.state === CARD_STATE.SCRATCHING) {
        // 刮到一半刷新：回退为未开始，次数不退、奖品不重抽
        card.state = CARD_STATE.IDLE
      }
      saved.cards[id] = card
    }
    return saved
  }

  function commit() {
    store.save(state)
    for (const fn of listeners) fn(state)
  }

  function drawPrize() {
    const total = prizes.reduce((sum, p) => sum + p.weight, 0)
    let roll = rng() * total
    for (const p of prizes) {
      roll -= p.weight
      if (roll < 0) return { name: p.name, win: Boolean(p.win) }
    }
    const last = prizes[prizes.length - 1]
    return { name: last.name, win: Boolean(last.win) }
  }

  function getChancesLeft() {
    return Math.max(0, dailyChances - state.chancesUsed)
  }

  return {
    /** 订阅状态变化，返回取消订阅函数 */
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getSnapshot: () => state,
    getCard: (id) => state.cards[id],
    getChancesLeft,

    /**
     * 开始刮卡：idle -> scratching。
     * 首次开始时扣 1 次机会并锁定奖品；刷新后重刮（chanceSpent=true）不重复扣次数。
     */
    beginScratch(id) {
      const card = state.cards[id]
      if (!card) return { ok: false, reason: 'unknown-card' }
      if (card.state !== CARD_STATE.IDLE && card.state !== CARD_STATE.SCRATCHING) {
        return { ok: false, reason: 'invalid-state' }
      }
      if (!card.chanceSpent) {
        if (getChancesLeft() <= 0) return { ok: false, reason: 'no-chances' }
        state.chancesUsed += 1
        card.prize = drawPrize()
        card.chanceSpent = true
      }
      card.state = CARD_STATE.SCRATCHING
      commit()
      return { ok: true, card }
    },

    /** 完全刮开（手动刮满阈值或"直接揭开"共用此入口）：scratching -> revealed */
    reveal(id) {
      const card = state.cards[id]
      if (!card || card.state !== CARD_STATE.SCRATCHING) {
        return { ok: false, reason: 'invalid-state' }
      }
      card.state = CARD_STATE.REVEALED
      commit()
      return { ok: true, card }
    },

    /** 领取结果：revealed -> claimed */
    claim(id) {
      const card = state.cards[id]
      if (!card || card.state !== CARD_STATE.REVEALED) {
        return { ok: false, reason: 'invalid-state' }
      }
      card.state = CARD_STATE.CLAIMED
      commit()
      return { ok: true, card }
    },
  }
}
