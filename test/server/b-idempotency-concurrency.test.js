/**
 * 设计第 7 节 · B 类（幂等 / 并发 / 记账原子性），验收项 9-15。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, internalCard } from './helpers.js'

test('B9 begin 同幂等键重试：承诺/rev 相同，只扣 1 次', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const key = h.idemKey()
  const first = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  const second = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(first.body.ok, true)
  assert.equal(second.body.ok, true)
  assert.equal(second.body.card.commitment, first.body.card.commitment)
  assert.equal(second.body.card.rev, first.body.card.rev)
  const state = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  const daily = state.body.campaigns[0]
  assert.equal(daily.chancesLeft, 2)
  const dayRecord = [...h.store.days.values()].find((d) => d)
  assert.equal(dayRecord.chancesUsed, 1)
  void sid
})

test('B10 双页并发 begin（同卡不同键）：仅 1 个 pending、扣 1 次，其余 already-pending 同承诺', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      h.request('POST', '/api/campaigns/daily/scratch/begin', {
        body: { cardId: 'daily-1' },
        headers: { cookie, 'idempotency-key': h.idemKey() },
      }),
    ),
  )
  const okCount = results.filter((r) => r.body.ok === true).length
  const pendingCount = results.filter((r) => r.body.reason === 'already-pending').length
  assert.equal(okCount, 1)
  assert.equal(pendingCount, 7)
  const commitments = new Set(results.map((r) => r.body.card?.commitment))
  assert.equal(commitments.size, 1)
  const state = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  assert.equal(state.body.campaigns[0].chancesLeft, 2)
})

test('B11 次数用满：no-chances，不建卡、不增 chancesUsed', async () => {
  const h = makeHarness({
    configOverrides: {
      campaigns: [
        {
          campaignId: 'mini',
          title: '迷你卡',
          subtitle: '每日 1 次，2 个卡位',
          dailyChances: 1,
          cardIds: ['mini-1', 'mini-2'],
          weightsVersion: 'v1',
        },
      ],
      weightsVersions: {
        'mini/v1': [
          { name: '小奖', weight: 50, win: true },
          { name: '谢谢参与', weight: 50, win: false },
        ],
      },
    },
  })
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const first = await h.request('POST', '/api/campaigns/mini/scratch/begin', {
    body: { cardId: 'mini-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(first.body.ok, true)
  assert.equal(first.body.chancesLeft, 0)

  // 另一张全新卡位（不是 already-pending）：额度判定先触发
  const overflow = await h.request('POST', '/api/campaigns/mini/scratch/begin', {
    body: { cardId: 'mini-2' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(overflow.body.ok, false)
  assert.equal(overflow.body.reason, 'no-chances')
  assert.equal(overflow.body.chancesLeft, 0)
  assert.equal(overflow.body.card, undefined)

  const record = h.store.latestCards(sid, 'mini', 'mini-2').get('mini-2') ?? null
  assert.equal(record, null, '不得创建卡记录')
  const day = h.store.getDay(sid, 'mini', '2026-09-24')
  assert.equal(day.chancesUsed, 1)
})

test('B12 reveal 幂等（同键/异键）：prize/receipt 完全相同，只产生一次 revealed 事件', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const key = h.idemKey()
  const first = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  const secondSameKey = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  const thirdOtherKey = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  for (const repeat of [secondSameKey, thirdOtherKey]) {
    assert.deepEqual(repeat.body.card.receipt, first.body.card.receipt)
    assert.deepEqual(repeat.body.card.prize, first.body.card.prize)
    assert.equal(repeat.body.card.rev, first.body.card.rev)
  }
  const revealedEvents = h.store.events.filter((e) => e.type === 'card-revealed')
  assert.equal(revealedEvents.length, 1)
})

test('B13/B14 claim 先到先得并发 + 同键重放同 claimRef，ledger 仅一条', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      h.request('POST', '/api/campaigns/daily/prizes/claim', {
        body: { cardId: 'daily-1' },
        headers: { cookie, 'idempotency-key': h.idemKey() },
      }),
    ),
  )
  assert.equal(results.filter((r) => r.body.ok === true).length, 1)
  assert.equal(results.filter((r) => r.body.reason === 'already-claimed').length, 3)
  const record = internalCard(h.store, sid, 'daily', 'daily-1')
  assert.equal(record.status, 'claimed')

  const key = h.idemKey()
  const first = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': key },
  })
  // daily-2 未 begin/reveal，先拿 invalid-state；改为完整流转后验证 claimRef 幂等
  assert.equal(first.body.reason, 'invalid-state')
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const claimKey = h.idemKey()
  const claim1 = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': claimKey },
  })
  const claim2 = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': claimKey },
  })
  assert.equal(claim1.body.ok, true)
  assert.equal(claim2.body.card.claimRef, claim1.body.card.claimRef)
  const claimEvents = h.store.events.filter((e) => e.type === 'card-claimed')
  assert.equal(claimEvents.length, 2)
  // ledger 恰为两张卡各一条
  const normalLedger = [...h.store.claimsLedger].filter((key2) => !key2.startsWith('migrate#'))
  assert.equal(normalLedger.length, 2)
})

test('B15 非法状态迁移：idle reveal/claim、revealed begin、claimed reveal 无新结果', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const idleReveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(idleReveal.body.ok, false)
  assert.equal(idleReveal.body.reason, 'invalid-state')
  const idleClaim = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(idleClaim.body.reason, 'invalid-state')

  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const beginAgain = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(beginAgain.body.ok, false)
  assert.equal(beginAgain.body.reason, 'invalid-state')
  const beforeRecord = internalCard(h.store, sid, 'daily', 'daily-1')
  const seedBefore = beforeRecord.seedHex

  await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const claimedReveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(claimedReveal.body.ok, true)
  assert.equal(claimedReveal.body.card.status, 'claimed')
  assert.equal(claimedReveal.body.card.receipt.seedHex, seedBefore)
})

test('B-extra 同幂等键不同请求体返回 409 conflict', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const key = h.idemKey()
  const first = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(first.body.ok, true)
  const conflict = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error, 'conflict')
})

test('B-extra 写操作缺少 Idempotency-Key 返回 400', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const response = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie },
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'bad-request')
})
