/**
 * 设计第 7 节 · E 类（迁移 / 恢复）中服务端可测条目：25、26、27、29。
 * 24/28 是 B 类前端断言（src/ 本轮不动），由 f-engineering 的边界测试覆盖工程面。
 */
import { createHash } from 'node:crypto'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, internalCard } from './helpers.js'

/** 与 src/lib/migration.js 注释中 v2 信封结构一致的夹具 */
function v2Envelope(overrides = {}) {
  return {
    version: 2,
    rev: 7,
    state: {
      date: '2026-09-23',
      lastDate: '2026-09-23',
      timeAnomaly: false,
      chancesUsed: 3,
      cards: {},
      ...overrides.state,
    },
  }
}

function v1Envelope(overrides = {}) {
  return { date: '2026-09-23', chancesUsed: 2, cards: {}, ...overrides }
}

test('E25 pending 恢复：刷新后卡为 pending、承诺一致、机会已扣；reveal 不重摇不退次', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const serverRecord = internalCard(h.store, sid, 'daily', 'daily-1')

  const recover = await h.request('POST', '/api/recover', { body: {}, headers: { cookie } })
  assert.equal(recover.status, 200)
  const campaign = recover.body.campaigns.find((item) => item.campaignId === 'daily')
  const card = campaign.cards.find((item) => item.cardId === 'daily-1')
  assert.equal(card.status, 'pending')
  assert.equal(card.commitment, begin.body.card.commitment)
  assert.equal(card.prize, undefined)
  assert.equal(campaign.chancesLeft, 2, '机会已扣，恢复不退还')
  assert.ok(campaign.subtitle, 'recover 合并活动元数据')
  assert.deepEqual(campaign.cardIds, ['daily-1', 'daily-2', 'daily-3'])

  const reveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(reveal.body.ok, true)
  assert.equal(reveal.body.card.receipt.seedHex, serverRecord.seedHex)
  assert.equal(reveal.body.card.prize.name, serverRecord.prize.name)
  const afterState = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  assert.equal(afterState.body.campaigns[0].chancesLeft, 2)
})

test('E26 迁移幂等：同一 payload + 同一迁移键导入两次，只登记一次', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const payload = {
    campaignId: 'daily',
    envelope: v2Envelope({
      state: {
        cards: {
          'daily-1': { state: 'claimed', chanceSpent: true, prize: { name: '88元 现金红包', win: true }, seed: 123456, seedHash: 'aabbccdd' },
          'daily-2': { state: 'revealed', chanceSpent: true, prize: { name: '免费咖啡一杯', win: true }, seed: 789, seedHash: '11223344' },
        },
      },
    }),
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const migrationKey = `migrate:${payloadHash}`

  const first = await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': migrationKey },
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.imported.claimed.length, 1)
  assert.equal(first.body.imported.revealed.length, 1)

  const second = await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': migrationKey },
  })
  assert.deepEqual(second.body.imported, first.body.imported, '同键重放返回首次响应')

  const revealedCard = internalCard(h.store, sid, 'daily', 'daily-2')
  assert.equal(revealedCard.status, 'revealed')
  assert.equal(revealedCard.migrated, true)
  const migrationEvents = h.store.events.filter((event) => event.type === 'migration-revealed-registered')
  assert.equal(migrationEvents.length, 1)
  const claimedEvents = h.store.events.filter((event) => event.type === 'migration-claimed-registered')
  assert.equal(claimedEvents.length, 1)

  // 领取成功后再导入同一份数据（不同迁移键）：去重命中，不能产生第二张待领卡
  await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const reimport = await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(reimport.body.ok, true)
  assert.equal(reimport.body.imported.revealed[0].dedup, true)
  const revealedRecords = [...h.store.cards.values()].filter(
    (record) => record.sid === sid && record.cardId === 'daily-2',
  )
  assert.equal(revealedRecords.length, 1, '不得新建第二张卡')
})

test('E27 迁移防重领：导入 revealed 中奖 → claim → 再导入，不能二次领取，领奖总数为 1', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const payload = {
    campaignId: 'daily',
    envelope: v2Envelope({
      state: {
        cards: {
          'daily-3': { state: 'revealed', chanceSpent: true, prize: { name: '8.8元 优惠券', win: true }, seed: 42, seedHash: 'abababab' },
        },
      },
    }),
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const claim = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-3' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(claim.body.ok, true)
  assert.equal(claim.body.card.status, 'claimed')
  const claimRef = claim.body.card.claimRef
  assert.ok(claimRef)

  const reimport = await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(reimport.body.imported.revealed[0].dedup, true)
  const claimAgain = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-3' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(claimAgain.body.ok, false)
  assert.equal(claimAgain.body.reason, 'already-claimed')
  assert.equal(claimAgain.body.card.claimRef, claimRef)

  const records = [...h.store.cards.values()].filter(
    (record) => record.sid === sid && record.cardId === 'daily-3',
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'claimed')
  const claimEvents = h.store.events.filter((event) => event.type === 'card-claimed')
  assert.equal(claimEvents.length, 1)
})

test('E27b 领取前重复导入也不会产生第二张待领卡', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const payload = {
    campaignId: 'daily',
    envelope: v1Envelope({
      cards: {
        'daily-1': { state: 'revealed', chanceSpent: true, prize: { name: '免费咖啡一杯', win: true } },
      },
    }),
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': 'mig-key-1' },
  })
  await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': 'mig-key-2' },
  })
  const records = [...h.store.cards.values()].filter(
    (record) => record.sid === sid && record.cardId === 'daily-1',
  )
  assert.equal(records.length, 1)
  const claim = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(claim.body.ok, true)
})

test('E29 未消费 idle 卡不产生任何可玩结果/额度；已扣费未揭晓按策略 B 作废', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const payload = {
    campaignId: 'daily',
    envelope: v2Envelope({
      state: {
        chancesUsed: 4,
        cards: {
          // idle 未扣费：直接丢弃
          'daily-1': { state: 'idle', chanceSpent: false, prize: null, seed: null, seedHash: null },
          // scratching 刷新归一 idle，但已扣费（本地开奖已破功）：策略 B 作废
          'daily-2': { state: 'scratching', chanceSpent: true, prize: { name: '88元 现金红包', win: true }, seed: 555, seedHash: 'ccccdddd' },
          // pending 态本地不存在，若有 chanceSpent 同样作废
          'daily-3': { state: 'idle', chanceSpent: true, prize: { name: '谢谢参与', win: false }, seed: 666, seedHash: 'eeeeffff' },
        },
      },
    }),
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const result = await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(result.body.ok, true)
  assert.deepEqual(result.body.imported.claimed, [])
  assert.deepEqual(result.body.imported.revealed, [])
  const discardedIds = result.body.discarded.spentUnrevealed.map((item) => item.cardId).sort()
  assert.deepEqual(discardedIds, ['daily-2', 'daily-3'])
  const idleIds = result.body.discarded.idleUnspent.map((item) => item.cardId)
  assert.deepEqual(idleIds, ['daily-1'])

  // 服务端无对应可玩卡记录，且不发放任何迁移额度（当日仍是满额 3 次）
  for (const cardId of ['daily-1', 'daily-2', 'daily-3']) {
    const record = h.store.latestCards(sid, 'daily', cardId).get(cardId) ?? null
    assert.equal(record, null, `${cardId} 不应有卡记录`)
  }
  const state = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  assert.equal(state.body.campaigns[0].chancesLeft, 3)
})

test('E-extra 迁移中奖总量封顶：第 51 条起仅作历史、不可领取', async () => {
  const cardIds = Array.from({ length: 60 }, (_, i) => `big-${String(i + 1).padStart(2, '0')}`)
  const h = makeHarness({
    configOverrides: {
      campaigns: [
        {
          campaignId: 'big',
          title: '大容量卡',
          subtitle: '封顶测试',
          dailyChances: 100,
          cardIds,
          weightsVersion: 'v1',
        },
      ],
      weightsVersions: {
        'big/v1': [{ name: '大奖', weight: 100, win: true }],
      },
    },
  })
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  const cards = {}
  for (const cardId of cardIds) {
    cards[cardId] = {
      state: 'revealed',
      chanceSpent: true,
      prize: { name: '大奖', win: true },
      seed: 1,
      seedHash: '00000000',
    }
  }
  const payload = { campaignId: 'big', envelope: v2Envelope({ state: { cards } }) }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const result = await h.request('POST', '/api/migrate/import', {
    body: { payload, payloadHash },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(result.body.imported.revealed.length, 50, '每会话最多承认 50 条迁移待领')
  assert.equal(result.body.discarded.capped.length, 10)

  const playable = [...h.store.cards.values()].filter(
    (record) => record.sid === sid && record.campaignId === 'big' && record.status === 'revealed',
  )
  assert.equal(playable.length, 50)

  const cappedId = result.body.discarded.capped[0].cardId
  const cappedClaim = await h.request('POST', '/api/campaigns/big/prizes/claim', {
    body: { cardId: cappedId },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(cappedClaim.body.ok, false)
  assert.equal(cappedClaim.body.reason, 'invalid-state')
})
