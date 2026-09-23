import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_STATE,
  createDailyState,
  applyRollover,
  transitionBegin,
  transitionReveal,
  transitionClaim,
  normalizeAfterReload,
  sanitizeDailyState,
} from '../src/lib/state-machine.js'
import { resolveDay } from '../src/lib/time.js'
import { mulberry32, drawPrizeIndex } from '../src/lib/randomness.js'

const CARD_IDS = ['c1', 'c2', 'c3']
const PRIZES = [
  { name: 'A', weight: 1, win: true },
  { name: 'X', weight: 99, win: false },
]

function begin(state, cardId = 'c1', seed = 123, dailyChances = 3) {
  return transitionBegin(state, { cardId, dailyChances, prizes: PRIZES, seed })
}

test('createDailyState：全 idle、无奖品、次数 0', () => {
  const s = createDailyState({ date: '2026-09-23', cardIds: CARD_IDS })
  assert.equal(s.chancesUsed, 0)
  assert.equal(s.date, '2026-09-23')
  for (const id of CARD_IDS) {
    assert.equal(s.cards[id].state, CARD_STATE.IDLE)
    assert.equal(s.cards[id].prize, null)
    assert.equal(s.cards[id].seed, null)
  }
})

test('begin：扣次数并锁定奖品/seed/哈希；同一卡再次 begin 不重复扣', () => {
  let s = createDailyState({ date: '2026-09-23', cardIds: CARD_IDS })
  const r1 = begin(s)
  assert.equal(r1.result.ok, true)
  s = r1.state
  assert.equal(s.chancesUsed, 1)
  assert.equal(s.cards.c1.chanceSpent, true)
  assert.equal(s.cards.c1.seed, 123)
  assert.match(s.cards.c1.seedHash, /^[0-9a-f]{8}$/)
  assert.ok(s.cards.c1.prize)
  // 奖品必须与 seed 确定性重算一致
  const idx = drawPrizeIndex(PRIZES, mulberry32(123))
  assert.equal(s.cards.c1.prize.name, PRIZES[idx].name)

  const r2 = begin(s)
  assert.equal(r2.result.ok, true)
  assert.equal(r2.state.chancesUsed, 1, '重刮不重复扣次数')
  assert.equal(r2.state.cards.c1.seed, 123, '不重摇')
})

test('begin 不修改入参（纯函数，CAS 重放安全）', () => {
  const s = createDailyState({ date: '2026-09-23', cardIds: CARD_IDS })
  const snapshot = JSON.stringify(s)
  begin(s)
  assert.equal(JSON.stringify(s), snapshot)
})

test('次数用尽：no-chances（重刮已消耗卡不扣次数，刮新卡才被拒）', () => {
  const four = ['c1', 'c2', 'c3', 'c4']
  let s = createDailyState({ date: '2026-09-23', cardIds: four })
  s = begin(s, 'c1', 1).state
  s = begin(s, 'c2', 2).state
  s = begin(s, 'c3', 3).state
  assert.equal(s.chancesUsed, 3)
  // 第 4 张全新卡：无次数 -> 拒绝
  const r = begin(s, 'c4', 4)
  assert.equal(r.result.ok, false)
  assert.equal(r.result.reason, 'no-chances')
  // 已消耗过的卡重刮仍允许且不扣次数
  const re = begin(s, 'c1', 9)
  assert.equal(re.result.ok, true)
  assert.equal(re.state.chancesUsed, 3)
})

test('非法卡 / 非法状态迁移被拒绝', () => {
  const s = createDailyState({ date: '2026-09-23', cardIds: CARD_IDS })
  assert.equal(begin(s, 'nope').result.reason, 'unknown-card')
  const revealed = transitionReveal(begin(s).state, { cardId: 'c1' }).state
  assert.equal(begin(revealed, 'c1').result.reason, 'invalid-state')
  assert.equal(transitionClaim(s, { cardId: 'c1' }).result.reason, 'invalid-state')
})

test('完整流转 begin -> reveal -> claim', () => {
  let s = createDailyState({ date: '2026-09-23', cardIds: CARD_IDS })
  s = begin(s).state
  const rv = transitionReveal(s, { cardId: 'c1' })
  assert.equal(rv.result.ok, true)
  s = rv.state
  assert.equal(s.cards.c1.state, CARD_STATE.REVEALED)
  const cl = transitionClaim(s, { cardId: 'c1' })
  assert.equal(cl.result.ok, true)
  assert.equal(cl.state.cards.c1.state, CARD_STATE.CLAIMED)
  // 重复领取被拒（先到先得的纯逻辑基础）
  assert.equal(transitionClaim(cl.state, { cardId: 'c1' }).result.ok, false)
})

test('normalizeAfterReload：scratching 回 idle 且次数/奖品保留；无变化时引用不变（幂等）', () => {
  let s = createDailyState({ date: '2026-09-23', cardIds: CARD_IDS })
  s = begin(s).state
  assert.equal(s.cards.c1.state, CARD_STATE.SCRATCHING)
  const n1 = normalizeAfterReload(s)
  assert.equal(n1.cards.c1.state, CARD_STATE.IDLE)
  assert.equal(n1.cards.c1.chanceSpent, true)
  assert.ok(n1.cards.c1.prize)
  assert.equal(n1.chancesUsed, 1)
  const n2 = normalizeAfterReload(n1)
  assert.equal(n2, n1, '无 scratching 时原样返回，避免无意义写盘')
})

test('applyRollover：跨天归零；同天不变；回拨延续并告警', () => {
  const s = createDailyState({ date: '2026-09-23', cardIds: CARD_IDS })
  const used = begin(s, 'c1', 1).state

  const reset = applyRollover(used, {
    cardIds: CARD_IDS,
    currentDate: '2026-09-24',
    resolveDayFn: resolveDay,
  })
  assert.equal(reset.changed, true)
  assert.equal(reset.state.chancesUsed, 0)
  assert.equal(reset.state.cards.c1.state, CARD_STATE.IDLE)
  assert.equal(reset.state.date, '2026-09-24')

  const same = applyRollover(used, {
    cardIds: CARD_IDS,
    currentDate: '2026-09-23',
    resolveDayFn: resolveDay,
  })
  assert.equal(same.changed, false)
  assert.equal(same.state.chancesUsed, 1)

  const back = applyRollover(used, {
    cardIds: CARD_IDS,
    currentDate: '2026-09-22',
    resolveDayFn: resolveDay,
  })
  assert.equal(back.changed, true)
  assert.equal(back.anomaly, true)
  assert.equal(back.state.chancesUsed, 1, '回拨不重置次数')
  assert.equal(back.state.date, '2026-09-23', '沿用更晚的已持久化日期')
})

test('sanitizeDailyState：未知卡剔除、非法字段回退、无 chanceSpent 不允许带奖品', () => {
  const dirty = {
    date: '2026-09-23',
    lastDate: '2026-09-23',
    chancesUsed: 99,
    timeAnomaly: true,
    cards: {
      c1: { state: 'claimed', chanceSpent: true, prize: { name: 'A', win: true }, seed: 7 },
      c2: { state: 'revealed', chanceSpent: false, prize: { name: 'B', win: true } },
      ghost: { state: 'claimed', chanceSpent: true },
    },
  }
  const clean = sanitizeDailyState(dirty, { cardIds: CARD_IDS, date: '2026-09-23', maxChances: 3 })
  assert.equal(clean.chancesUsed, 3, '按上限封顶')
  assert.equal(clean.cards.c1.state, 'claimed')
  assert.equal(clean.cards.c2.state, 'idle')
  assert.equal(clean.cards.c2.prize, null, '没花过机会的奖品必须被清除')
  assert.equal(clean.cards.ghost, undefined, '未知卡剔除')
  assert.equal(clean.timeAnomaly, true)
})
