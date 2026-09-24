/**
 * 验收 C 类：时钟 / 跨天 / 回拨一律以服务端为准。
 * 对应设计文档第 7 节条目 16/17/18。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, serverCard, DAY1, DAY1_KEY, DAY2, DAY2_KEY } from './helpers.js'

test('C16: 服务端跨天——次日 begin 用新账本，次数恢复，历史 claimed 不变', async () => {
  const h = createHarness({ now: DAY1 })
  const { sid } = await h.newSession()
  // day1 用满 3 次
  for (const [cardId, key] of [['daily-1', 'd1'], ['daily-2', 'd2'], ['daily-3', 'd3']]) {
    const res = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
      sid, idemKey: key, body: { cardId },
    })
    assert.equal(res.json.ok, true)
  }
  // day1 一张卡走完全流程到 claimed
  await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'd1r', body: { cardId: 'daily-1' },
  })
  await h.api('POST', '/api/campaigns/daily/prizes/claim', {
    sid, idemKey: 'd1c', body: { cardId: 'daily-1' },
  })
  const day1 = h.store.getDay(sid, 'daily', DAY1_KEY)
  assert.equal(day1.chancesUsed, 3)

  // 拨到次日：新账本，次数恢复
  h.setNow(DAY2)
  const state = await h.api('GET', '/api/state?campaign=daily', { sid })
  assert.equal(state.json.day, DAY2_KEY)
  assert.equal(state.json.campaigns[0].chancesLeft, 3)
  const claimed = state.json.campaigns[0].cards.find((c) => c.cardId === 'daily-1')
  assert.equal(claimed.status, 'claimed', '前一天 claimed 卡仍为 claimed')

  const begin = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'd2-1', body: { cardId: 'daily-2' },
  })
  // daily-2 在 day1 是 pending（未揭晓），次日仍复用同一承诺（不退次不重摇）
  assert.equal(begin.json.reason, 'already-pending')
  const fresh = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'd2-2', body: { cardId: 'daily-1' },
  })
  // daily-1 已 claimed（终态），不可再 begin
  assert.equal(fresh.json.reason, 'invalid-state')
  const day2 = h.store.getDay(sid, 'daily', DAY2_KEY)
  assert.equal(day2.chancesUsed, 0, '新账本未被误扣')
  await h.close()
})

test('C16b: 跨天后 pending 卡仍可用原 seed 完成 reveal，不占用新一天次数', async () => {
  const h = createHarness({ now: DAY1 })
  const { sid } = await h.newSession()
  await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'x1', body: { cardId: 'daily-1' },
  })
  const recordBefore = serverCard(h.store, sid, 'daily', 'daily-1')
  h.setNow(DAY2)
  const reveal = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'x2', body: { cardId: 'daily-1' },
  })
  assert.equal(reveal.json.ok, true)
  assert.equal(reveal.json.card.receipt.seedHex, recordBefore.seedHex, '同一 seed 不重摇')
  const day2 = h.store.getDay(sid, 'daily', DAY2_KEY)
  assert.equal(!day2 || day2.chancesUsed === 0, true, '不占用新一天次数')
  await h.close()
})

test('C17: 请求体伪造本地时间无效——授权只看服务端注入时钟', async () => {
  const h = createHarness({ now: DAY1 })
  const { sid } = await h.newSession()
  for (const [cardId, key] of [['daily-1', 't1'], ['daily-2', 't2'], ['daily-3', 't3']]) {
    await h.api('POST', '/api/campaigns/daily/scratch/begin', {
      sid, idemKey: key, body: { cardId },
    })
  }
  // 客户端谎称"已经是明天"，服务端不应发放新次数
  const forged = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid,
    idemKey: 't4',
    body: { cardId: 'daily-1', clientTime: '2026-09-25T00:00:01+08:00', date: DAY2_KEY },
  })
  assert.equal(forged.json.reason, 'already-pending')
  const state = await h.api('GET', '/api/state?campaign=daily', { sid })
  assert.equal(state.json.day, DAY1_KEY, 'day 由服务端时钟决定')
  assert.equal(state.json.campaigns[0].chancesLeft, 0)
  const day1 = h.store.getDay(sid, 'daily', DAY1_KEY)
  assert.equal(day1.chancesUsed, 3)
  assert.equal(h.store.getDay(sid, 'daily', DAY2_KEY), null, '伪造日期不产生新账本')
  await h.close()
})

test('C18: 服务端时钟回拨——不恢复次数、账本不回退、记录 clockAnomaly、pending 可揭晓', async () => {
  const h = createHarness({ now: DAY1 })
  const { sid } = await h.newSession()
  await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'r1', body: { cardId: 'daily-1' },
  })
  await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'r2', body: { cardId: 'daily-2' },
  })
  const record = serverCard(h.store, sid, 'daily', 'daily-1')

  // 回拨 20 小时（落到前一自然日）
  h.setNow(DAY1 - 20 * 60 * 60 * 1000)
  const state = await h.api('GET', '/api/state?campaign=daily', { sid })
  assert.equal(state.json.day, DAY1_KEY, 'day 账本不回退（沿用更晚已记账日）')
  assert.equal(state.json.campaigns[0].chancesLeft, 1, '不恢复已用次数')
  assert.ok(h.store.state.clockAnomalies.length >= 1, '记录 clockAnomaly')

  // 回拨期间 begin 仍记入原账本（单调基线）
  const begin = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'r3', body: { cardId: 'daily-3' },
  })
  assert.equal(begin.json.ok, true)
  assert.equal(begin.json.day, DAY1_KEY)
  const day1 = h.store.getDay(sid, 'daily', DAY1_KEY)
  assert.equal(day1.chancesUsed, 3)
  assert.equal(h.store.getDay(sid, 'daily', '2026-09-23'), null, '不回退到前一天账本')

  // pending 卡仍可用原 seed 完成 reveal
  const reveal = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'r4', body: { cardId: 'daily-1' },
  })
  assert.equal(reveal.json.ok, true)
  assert.equal(reveal.json.card.receipt.seedHex, record.seedHex)
  await h.close()
})
