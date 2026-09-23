import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_STATE,
  createDailyState,
  transitionBegin,
  transitionReveal,
  transitionClaim,
  normalizeAfterReload,
  applyRollover,
} from '../src/lib/state-machine.js'
import { resolveDay } from '../src/lib/time.js'

const PRIZES = [
  { name: '大奖', weight: 1, win: true },
  { name: '谢谢参与', weight: 99, win: false },
]
const IDS = ['c1', 'c2']

function fresh(overrides = {}) {
  return { ...createDailyState({ date: '2026-09-23', cardIds: IDS }), ...overrides }
}

test('beginScratch：扣 1 次、锁定 seed/哈希/奖品，状态推进到 scratching', () => {
  const { state, result } = transitionBegin(fresh(), {
    cardId: 'c1', dailyChances: 3, prizes: PRIZES, seed: 42,
  })
  assert.ok(result.ok)
  assert.equal(state.chancesUsed, 1)
  const card = state.cards.c1
  assert.equal(card.state, CARD_STATE.SCRATCHING)
  assert.equal(card.chanceSpent, true)
  assert.equal(card.seed, 42)
  assert.match(card.seedHash, /^[0-9a-f]{8}$/)
  assert.ok(card.prize && typeof card.prize.name === 'string')
})

test('beginScratch：次数用尽返回 no-chances，状态不变', () => {
  const s0 = fresh({ chancesUsed: 3 })
  const { state, result } = transitionBegin(s0, {
    cardId: 'c1', dailyChances: 3, prizes: PRIZES, seed: 1,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-chances')
  assert.equal(state.chancesUsed, 3)
})

test('beginScratch：chanceSpent 幂等——刷新后重刮不重复扣次数、不重摇', () => {
  const first = transitionBegin(fresh(), {
    cardId: 'c1', dailyChances: 3, prizes: PRIZES, seed: 42,
  })
  const restored = normalizeAfterReload(first.state) // 模拟刷新：scratching -> idle
  assert.equal(restored.cards.c1.state, CARD_STATE.IDLE)
  const second = transitionBegin(restored, {
    cardId: 'c1', dailyChances: 3, prizes: PRIZES, seed: 999, // 新 seed 不应被采用
  })
  assert.ok(second.result.ok)
  assert.equal(second.state.chancesUsed, 1) // 不重扣
  assert.equal(second.state.cards.c1.seed, 42) // 不重摇
  assert.deepEqual(second.state.cards.c1.prize, first.state.cards.c1.prize)
})

test('reveal：仅 scratching（或刷新恢复后的 idle+chanceSpent）可结算', () => {
  const begun = transitionBegin(fresh(), {
    cardId: 'c1', dailyChances: 3, prizes: PRIZES, seed: 7,
  }).state
  const revealed = transitionReveal(begun, { cardId: 'c1' })
  assert.ok(revealed.result.ok)
  assert.equal(revealed.state.cards.c1.state, CARD_STATE.REVEALED)

  // 刷新恢复后（idle 但已扣次数）也允许结算
  const restored = normalizeAfterReload(begun)
  assert.ok(transitionReveal(restored, { cardId: 'c1' }).result.ok)

  // 未开始 / 已领取不可结算
  assert.equal(transitionReveal(fresh(), { cardId: 'c1' }).result.reason, 'invalid-state')
  const claimed = transitionClaim(revealed.state, { cardId: 'c1' }).state
  assert.equal(transitionReveal(claimed, { cardId: 'c1' }).result.reason, 'invalid-state')
})

test('claim：先到先得——只有 revealed 能领取，重复领取失败', () => {
  const revealed = transitionReveal(
    transitionBegin(fresh(), { cardId: 'c1', dailyChances: 3, prizes: PRIZES, seed: 7 }).state,
    { cardId: 'c1' },
  ).state
  const first = transitionClaim(revealed, { cardId: 'c1' })
  assert.ok(first.result.ok)
  const second = transitionClaim(first.state, { cardId: 'c1' })
  assert.equal(second.result.ok, false)
  assert.equal(second.result.reason, 'invalid-state')
})

test('applyRollover：跨天全部归零；回拨则保留并置异常标记', () => {
  const used = transitionBegin(fresh(), {
    cardId: 'c1', dailyChances: 3, prizes: PRIZES, seed: 7,
  }).state

  const nextDay = applyRollover(used, {
    cardIds: IDS, currentDate: '2026-09-24', resolveDayFn: resolveDay,
  })
  assert.ok(nextDay.changed)
  assert.equal(nextDay.state.chancesUsed, 0)
  assert.equal(nextDay.state.cards.c1.state, CARD_STATE.IDLE)
  assert.equal(nextDay.state.cards.c1.prize, null)

  const rolledBack = applyRollover(used, {
    cardIds: IDS, currentDate: '2026-09-22', resolveDayFn: resolveDay,
  })
  assert.equal(rolledBack.anomaly, true)
  assert.equal(rolledBack.state.chancesUsed, 1) // 次数不重置
  assert.equal(rolledBack.state.date, '2026-09-23')
  assert.equal(rolledBack.state.timeAnomaly, true)
})

test('迁移均为纯变换：不修改入参', () => {
  const s0 = fresh()
  const snapshot = structuredClone(s0)
  transitionBegin(s0, { cardId: 'c1', dailyChances: 3, prizes: PRIZES, seed: 1 })
  transitionReveal(s0, { cardId: 'c1' })
  transitionClaim(s0, { cardId: 'c1' })
  applyRollover(s0, { cardIds: IDS, currentDate: '2026-09-24', resolveDayFn: resolveDay })
  assert.deepEqual(s0, snapshot)
})
