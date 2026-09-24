/**
 * 设计第 7 节 · C 类（时钟 / 跨天 / 回拨），验收项 16-18。
 * 服务端固定 UTC+8 记账；客户端时间完全不参与授权。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, internalCard } from './helpers.js'

// fakeClock 默认 2026-09-24T02:00:00Z == 上海时间 10:00
const DAY1 = Date.UTC(2026, 8, 24, 2, 0, 0)
const DAY2 = Date.UTC(2026, 8, 24, 17, 0, 0) // 上海时间 2026-09-25 01:00
const ROLLED_BACK = Date.UTC(2026, 8, 23, 18, 0, 0) // 上海时间仍是 2026-09-24 02:00

async function fullFlow(h, cookie, cardId) {
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  return h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
}

test('C16 跨天按服务端 UTC+8 开新账本：次数恢复，前日 claimed 卡仍为 claimed', async () => {
  const h = makeHarness({ startMs: DAY1 })
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const claimed = await fullFlow(h, cookie, 'daily-1')
  assert.equal(claimed.body.card.status, 'claimed')
  let state = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  assert.equal(state.body.day, '2026-09-24')
  assert.equal(state.body.campaigns[0].chancesLeft, 2)

  h.clock.set(DAY2)
  state = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  assert.equal(state.body.day, '2026-09-25', '跨天')
  assert.equal(state.body.campaigns[0].chancesLeft, 3, '次日次数恢复')
  const oldCard = state.body.campaigns[0].cards.find((card) => card.cardId === 'daily-1')
  assert.equal(oldCard.status, 'claimed', '前日 claimed 不回退')
  assert.equal(oldCard.claimRef, claimed.body.card.claimRef)

  // 次日同一 cardId 可全新 begin（独立日记账）
  const beginNextDay = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(beginNextDay.body.ok, true)
  assert.equal(beginNextDay.body.day, '2026-09-25')
  assert.equal(beginNextDay.body.chancesLeft, 2)

  // UTC 23:30（上海次日 07:30）确认按 UTC+8 而非 UTC 切日
  assert.equal(h.store.getDay(sid, 'daily', '2026-09-24').chancesUsed, 1)
  assert.equal(h.store.getDay(sid, 'daily', '2026-09-25').chancesUsed, 1)
})

test('C17 请求体内伪造客户端时间完全无效，授权只随服务端时钟变化', async () => {
  const h = makeHarness({ startMs: DAY1 })
  after(() => h.close())
  const { cookie } = await h.createSession()
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1', localTime: '2000-01-01T00:00:00', clientDate: '1999-12-31' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(begin.body.ok, true)
  assert.equal(begin.body.day, '2026-09-24')
  assert.equal(begin.body.chancesLeft, 2)

  // 即便请求声称"明天"，也不提前发次数
  const state = await h.request('GET', '/api/state?campaign=daily&clientDate=2030-01-01', {
    headers: { cookie },
  })
  assert.equal(state.body.day, '2026-09-24')
  assert.equal(state.body.campaigns[0].chancesLeft, 2)

  // 只有拨服务端时钟才会跨天
  h.clock.set(DAY2)
  const state2 = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  assert.equal(state2.body.day, '2026-09-25')
  assert.equal(state2.body.campaigns[0].chancesLeft, 3)
})

test('C18 服务端时钟回拨：日账本不回退、次数不恢复、记 clockAnomaly，pending 仍可 reveal', async () => {
  const h = makeHarness({ startMs: DAY1 })
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const before = internalCard(h.store, sid, 'daily', 'daily-1')

  // 回拨到上海时间 2026-09-24 凌晨（同一天早些时候）——次数不应恢复
  h.clock.set(ROLLED_BACK)
  const recover = await h.request('POST', '/api/recover', { body: {}, headers: { cookie } })
  assert.equal(recover.body.day, '2026-09-24', '沿用更晚已记账日')
  assert.equal(recover.body.clockAnomaly, true)
  assert.equal(recover.body.campaigns[0].chancesLeft, 2, '已用次数不恢复')

  // 回拨一整天到 2026-09-23：日账本仍停在 24 日
  h.clock.set(Date.UTC(2026, 8, 23, 1, 0, 0))
  const state = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  assert.equal(state.body.day, '2026-09-24')
  assert.equal(state.body.campaigns[0].chancesLeft, 2)

  // pending 卡仍可用原 seed 完成 reveal（不退次、不重摇）
  h.clock.set(ROLLED_BACK)
  const reveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(reveal.body.ok, true)
  assert.equal(reveal.body.card.receipt.seedHex, before.seedHex)
  assert.equal(reveal.body.card.prize.name, before.prize.name)
})
