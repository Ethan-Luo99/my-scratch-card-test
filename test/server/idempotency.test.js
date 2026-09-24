/**
 * 验收 B 类：幂等 / 并发 / 记账原子性。
 * 对应设计文档第 7 节条目 9/10/11/12/13/14/15。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, serverCard } from './helpers.js'

async function beginOk(h, sid, cardId, key) {
  const res = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: key, body: { cardId },
  })
  assert.equal(res.json.ok, true, `begin ${cardId} 应成功`)
  return res.json
}

test('B9: begin 幂等——同键重放返回同一 commitment/rev，只扣 1 次', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const first = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'b9', body: { cardId: 'daily-1' },
  })
  const replay = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'b9', body: { cardId: 'daily-1' },
  })
  assert.equal(replay.json.ok, true)
  assert.equal(replay.json.card.commitment, first.json.card.commitment)
  assert.equal(replay.json.card.rev, first.json.card.rev)
  assert.equal(replay.json.chancesLeft, first.json.chancesLeft)
  const day = h.store.getDay(sid, 'daily', first.json.day)
  assert.equal(day.chancesUsed, 1)
  await h.close()
})

test('B-附属: 同一幂等键配不同请求体返回冲突', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  await beginOk(h, sid, 'daily-1', 'same-key')
  const conflict = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'same-key', body: { cardId: 'daily-2' },
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.json.ok, false)
  assert.equal(conflict.json.reason, 'conflict')
  const day = h.store.getDay(sid, 'daily', '2026-09-24')
  assert.equal(day.chancesUsed, 1, '冲突不得扣次')
  await h.close()
})

test('B10: 双页并发 begin（同卡不同键）——恰 1 次成功，其余 already-pending 复用承诺', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      h.api('POST', '/api/campaigns/daily/scratch/begin', {
        sid, idemKey: `b10-${i}`, body: { cardId: 'daily-1' },
      }),
    ),
  )
  const created = results.filter((r) => r.json.ok === true)
  const reused = results.filter((r) => r.json.reason === 'already-pending')
  assert.equal(created.length, 1)
  assert.equal(reused.length, 4)
  for (const r of reused) {
    assert.equal(r.json.card.commitment, created[0].json.card.commitment)
  }
  const day = h.store.getDay(sid, 'daily', created[0].json.day)
  assert.equal(day.chancesUsed, 1, '并发最多扣一次')
  await h.close()
})

test('B11: 次数上限——用满后 begin 返回 no-chances，不建卡不扣次', async () => {
  // 测试专用活动：3 卡位 / 每日 2 次，使"次数先于卡位耗尽"可达
  const mini = [{
    campaignId: 'mini',
    title: '测试活动',
    subtitle: '',
    dailyChances: 2,
    cardIds: ['mini-1', 'mini-2', 'mini-3'],
    weightsVersion: 'v1',
    prizes: [{ name: '测试奖', weight: 1, win: true }],
  }]
  const h = createHarness({ campaigns: mini })
  const { sid } = await h.newSession()
  for (const [cardId, key] of [['mini-1', 'n1'], ['mini-2', 'n2']]) {
    const res = await h.api('POST', '/api/campaigns/mini/scratch/begin', {
      sid, idemKey: key, body: { cardId },
    })
    assert.equal(res.json.ok, true)
  }
  const denied = await h.api('POST', '/api/campaigns/mini/scratch/begin', {
    sid, idemKey: 'n3', body: { cardId: 'mini-3' },
  })
  assert.equal(denied.json.ok, false)
  assert.equal(denied.json.reason, 'no-chances')
  assert.equal(denied.json.chancesLeft, 0)
  assert.equal(serverCard(h.store, sid, 'mini', 'mini-3'), null, '不创建卡记录')
  const day = h.store.getDay(sid, 'mini', '2026-09-24')
  assert.equal(day.chancesUsed, 2, '不超发')
  await h.close()
})

test('B12: reveal 幂等——两次（不同键）返回同一 prize/receipt，只产生一次 revealed 事件', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  await beginOk(h, sid, 'daily-1', 'b12')
  const first = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'b12-r1', body: { cardId: 'daily-1' },
  })
  const second = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'b12-r2', body: { cardId: 'daily-1' },
  })
  assert.equal(second.json.ok, true)
  assert.deepEqual(second.json.card.prize, first.json.card.prize)
  assert.deepEqual(second.json.card.receipt, first.json.card.receipt)
  assert.equal(second.json.card.status, 'revealed')
  const revealedEvents = h.store.state.events.filter(
    (e) => e.type === 'card-upsert' && e.card.cardId === 'daily-1' && e.card.status === 'revealed',
  )
  assert.equal(revealedEvents.length, 1, '该卡只有一次 revealed 事件')
  await h.close()
})

test('B13: 双页并发 claim——恰一个成功，另一个 already-claimed，账本恰一条', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  await beginOk(h, sid, 'daily-1', 'b13')
  await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'b13-r', body: { cardId: 'daily-1' },
  })
  const results = await Promise.all(
    ['b13-c1', 'b13-c2'].map((key) =>
      h.api('POST', '/api/campaigns/daily/prizes/claim', {
        sid, idemKey: key, body: { cardId: 'daily-1' },
      }),
    ),
  )
  const wins = results.filter((r) => r.json.ok === true)
  const loses = results.filter((r) => r.json.reason === 'already-claimed')
  assert.equal(wins.length, 1)
  assert.equal(loses.length, 1)
  assert.equal(loses[0].json.card.status, 'claimed')
  assert.equal(serverCard(h.store, sid, 'daily', 'daily-1').status, 'claimed')
  assert.equal(h.store.claimCount(), 1)
  await h.close()
})

test('B14: claim 响应丢失后同键重放——同一 claimRef，不重复发奖', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  await beginOk(h, sid, 'daily-1', 'b14')
  await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'b14-r', body: { cardId: 'daily-1' },
  })
  const first = await h.api('POST', '/api/campaigns/daily/prizes/claim', {
    sid, idemKey: 'b14-c', body: { cardId: 'daily-1' },
  })
  const replay = await h.api('POST', '/api/campaigns/daily/prizes/claim', {
    sid, idemKey: 'b14-c', body: { cardId: 'daily-1' },
  })
  assert.equal(replay.json.ok, true)
  assert.equal(replay.json.card.claimRef, first.json.card.claimRef)
  assert.equal(h.store.claimCount(), 1)
  await h.close()
})

test('B15: 非法状态迁移被拒绝且不改变 seed/prize/次数', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  // idle（无记录）调 reveal / claim
  const revealIdle = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'b15-1', body: { cardId: 'daily-1' },
  })
  assert.equal(revealIdle.json.reason, 'invalid-state')
  const claimIdle = await h.api('POST', '/api/campaigns/daily/prizes/claim', {
    sid, idemKey: 'b15-2', body: { cardId: 'daily-1' },
  })
  assert.equal(claimIdle.json.reason, 'invalid-state')
  // pending 调 claim
  await beginOk(h, sid, 'daily-1', 'b15-3')
  const claimPending = await h.api('POST', '/api/campaigns/daily/prizes/claim', {
    sid, idemKey: 'b15-4', body: { cardId: 'daily-1' },
  })
  assert.equal(claimPending.json.reason, 'invalid-state')
  // revealed 再 begin
  await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'b15-5', body: { cardId: 'daily-1' },
  })
  const beginRevealed = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'b15-6', body: { cardId: 'daily-1' },
  })
  assert.equal(beginRevealed.json.reason, 'invalid-state')
  // claimed 再 reveal：返回当前 claimed 视图，seed/prize 不变
  const before = serverCard(h.store, sid, 'daily', 'daily-1')
  const seedBefore = before.seedHex
  const prizeBefore = { ...before.prize }
  await h.api('POST', '/api/campaigns/daily/prizes/claim', {
    sid, idemKey: 'b15-7', body: { cardId: 'daily-1' },
  })
  const revealClaimed = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'b15-8', body: { cardId: 'daily-1' },
  })
  assert.equal(revealClaimed.json.card.status, 'claimed')
  const after = serverCard(h.store, sid, 'daily', 'daily-1')
  assert.equal(after.seedHex, seedBefore)
  assert.deepEqual(after.prize, prizeBefore)
  const day = h.store.getDay(sid, 'daily', '2026-09-24')
  assert.equal(day.chancesUsed, 1, '非法迁移不扣次')
  await h.close()
})

test('B-附属: expectedRev 乐观并发——不匹配返回 conflict 与最新公开视图', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  await beginOk(h, sid, 'daily-1', 'rev-1')
  const stale = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'rev-2', body: { cardId: 'daily-1', expectedRev: 99 },
  })
  assert.equal(stale.json.ok, false)
  assert.equal(stale.json.reason, 'conflict')
  assert.equal(stale.json.card.status, 'pending')
  assert.match(stale.json.card.commitment, /^[0-9a-f]{64}$/)
  assert.ok(!stale.json.card.prize, '冲突视图同样不泄密')
  const ok = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'rev-3', body: { cardId: 'daily-1', expectedRev: 1 },
  })
  assert.equal(ok.json.ok, true)
  await h.close()
})
