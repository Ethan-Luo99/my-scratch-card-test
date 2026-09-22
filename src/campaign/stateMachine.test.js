// 纯逻辑状态机单测：node --test 运行，无需任何第三方依赖
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_STATUS,
  DAILY_ATTEMPTS,
  createCampaignState,
  normalizeState,
  remainingAttempts,
  rollPrize,
  startScratch,
  completeReveal,
  claimPrize,
  todayKey,
} from './stateMachine.js'

const alwaysWin = () => 0 // rng=0 命中第一个奖品
const alwaysLose = () => 0.999 // 命中最后一个（谢谢参与）

test('rollPrize 按权重分布且结果确定', () => {
  assert.equal(rollPrize(alwaysWin).id, 'coupon-5')
  assert.equal(rollPrize(alwaysLose).id, 'none')
  assert.equal(rollPrize(alwaysLose).win, false)
})

test('startScratch 扣减次数并锁定结果', () => {
  const s0 = createCampaignState()
  const r1 = startScratch(s0, 'c1', alwaysWin)
  assert.equal(r1.ok, true)
  assert.equal(remainingAttempts(r1.state), DAILY_ATTEMPTS - 1)
  assert.equal(r1.state.cards.c1.status, CARD_STATUS.SCRATCHING)
  assert.deepEqual(r1.state.cards.c1.prize, r1.prize)
})

test('重复 startScratch 幂等，不重新随机、不重复扣次数', () => {
  const s0 = createCampaignState()
  const r1 = startScratch(s0, 'c1', alwaysWin)
  const r2 = startScratch(r1.state, 'c1', alwaysLose) // 换 rng 也不应改变结果
  assert.equal(r2.ok, true)
  assert.equal(r2.alreadyStarted, true)
  assert.equal(r2.prize.id, 'coupon-5')
  assert.equal(remainingAttempts(r2.state), DAILY_ATTEMPTS - 1)
})

test('次数用完后拒绝开刮', () => {
  let state = createCampaignState()
  for (const id of ['a', 'b', 'c']) state = startScratch(state, id, alwaysLose).state
  const r = startScratch(state, 'd', alwaysLose)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-attempts')
  assert.equal(r.state, state) // 状态不变
})

test('状态机迁移：仅允许 idle->scratching->revealed->claimed', () => {
  const s0 = createCampaignState()
  // 未开始不能 reveal / claim
  assert.equal(completeReveal(s0, 'c1').ok, false)
  assert.equal(claimPrize(s0, 'c1').ok, false)

  const s1 = startScratch(s0, 'c1', alwaysWin).state
  assert.equal(claimPrize(s1, 'c1').ok, false) // scratching 不能直接 claim

  const s2 = completeReveal(s1, 'c1').state
  assert.equal(s2.cards.c1.status, CARD_STATUS.REVEALED)
  assert.equal(completeReveal(s2, 'c1').ok, false) // 不能重复 reveal

  const s3 = claimPrize(s2, 'c1').state
  assert.equal(s3.cards.c1.status, CARD_STATUS.CLAIMED)
  assert.equal(claimPrize(s3, 'c1').ok, false)
})

test('跨天重置次数，但卡片状态保留', () => {
  const yesterday = new Date(2026, 8, 21)
  const today = new Date(2026, 8, 22)
  let state = createCampaignState(yesterday)
  state = startScratch(state, 'c1', alwaysWin).state
  state = completeReveal(state, 'c1').state
  assert.equal(remainingAttempts(state), DAILY_ATTEMPTS - 1)

  const restored = normalizeState(JSON.parse(JSON.stringify(state)), today)
  assert.equal(remainingAttempts(restored), DAILY_ATTEMPTS) // 次数重置
  assert.equal(restored.cards.c1.status, CARD_STATUS.REVEALED) // 中间态保留
  assert.equal(restored.cards.c1.prize.id, 'coupon-5') // 结果不重摇
})

test('normalizeState 容忍脏数据', () => {
  assert.deepEqual(normalizeState(null), createCampaignState())
  assert.deepEqual(normalizeState('junk'), createCampaignState())
  const dirty = {
    day: todayKey(),
    attemptsUsed: 999,
    cards: { bad: { status: '???' }, good: { status: 'claimed', prize: null } },
  }
  const state = normalizeState(dirty)
  assert.equal(state.attemptsUsed, DAILY_ATTEMPTS) // 截断到上限
  assert.equal(state.cards.bad, undefined) // 非法状态被丢弃
  assert.equal(state.cards.good.status, 'claimed')
})
