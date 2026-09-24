/**
 * 验收 E 类（服务端可测部分）：pending 恢复 / 迁移幂等 / 防重领 / idle 不污染。
 * 对应设计文档第 7 节条目 25/26/27/29（24/28 为前端条目，本轮不测）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createHarness, serverCard } from './helpers.js'

function legacyEnvelope(cards, date = '2026-09-20') {
  return {
    version: 2,
    rev: 7,
    state: { date, lastDate: date, timeAnomaly: false, chancesUsed: 1, cards },
  }
}

async function importPayload(h, sid, payload, key, extra = {}) {
  return h.api('POST', '/api/migrate/import', {
    sid,
    idemKey: key,
    body: { payload, campaignId: 'daily', ...extra },
  })
}

test('E25: pending 恢复——recover 后承诺一致、机会已扣；reveal 结果与 begin 时一致', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const begin = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'e25', body: { cardId: 'daily-1' },
  })
  const recordAtBegin = { ...serverCard(h.store, sid, 'daily', 'daily-1') }

  // 模拟刷新：recover 重建公开状态
  const recover = await h.api('POST', '/api/recover', { sid, body: {} })
  const card = recover.json.campaigns
    .find((c) => c.campaignId === 'daily')
    .cards.find((c) => c.cardId === 'daily-1')
  assert.equal(card.status, 'pending')
  assert.equal(card.commitment, begin.json.card.commitment, '承诺一致')
  assert.ok(!card.prize && !card.receipt && !card.seedHex)
  const chances = recover.json.campaigns.find((c) => c.campaignId === 'daily').chancesLeft
  assert.equal(chances, 2, '机会已扣不退还')

  const reveal = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'e25r', body: { cardId: 'daily-1' },
  })
  assert.equal(reveal.json.card.prize.name, recordAtBegin.prize.name, '不重摇')
  assert.equal(reveal.json.card.receipt.seedHex, recordAtBegin.seedHex)
  await h.close()
})

test('E26: 迁移幂等——同一信封同键导入两次，claimsLedger 只新增一次', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const payload = legacyEnvelope({
    'daily-1': { state: 'claimed', chanceSpent: true, prize: { name: '免费咖啡一杯', win: true }, seed: 1, seedHash: 'x' },
  })
  const first = await importPayload(h, sid, payload, 'mig-1')
  assert.equal(first.json.ok, true)
  assert.equal(first.json.imported.claimed.length, 1)
  const ledgerSize = h.store.claimCount()
  const second = await importPayload(h, sid, payload, 'mig-1')
  assert.deepEqual(second.json, first.json, '同键重放返回首次响应')
  assert.equal(h.store.claimCount(), ledgerSize, '账本不重复登记')
  await h.close()
})

test('E27: 迁移防重领——导入 revealed 中奖→领取→再导入，不能第二次领取', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const payload = legacyEnvelope({
    'daily-1': { state: 'revealed', chanceSpent: true, prize: { name: '88元 现金红包', win: true }, seed: 42, seedHash: 'y' },
  })
  const imported = await importPayload(h, sid, payload, 'mig-a')
  assert.equal(imported.json.imported.revealed.length, 1)

  const claim = await h.api('POST', '/api/campaigns/daily/prizes/claim', {
    sid, idemKey: 'mig-c', body: { cardId: 'daily-1' },
  })
  assert.equal(claim.json.ok, true)
  assert.equal(claim.json.card.status, 'claimed')

  // 换浏览器/改数据后再导入同一份（不同幂等键）
  const again = await importPayload(h, sid, payload, 'mig-b')
  assert.equal(again.json.imported.revealed.length, 0, '去重命中，不产生新待领')
  assert.ok(again.json.deduped.some((d) => d.cardId === 'daily-1'))

  const reclaim = await h.api('POST', '/api/campaigns/daily/prizes/claim', {
    sid, idemKey: 'mig-c2', body: { cardId: 'daily-1' },
  })
  assert.equal(reclaim.json.reason, 'already-claimed')
  assert.equal(h.store.claimCount(), 1, '领奖总数为 1')
  await h.close()
})

test('E27b: 迁移的 claimed 记录只登记不补发；本地已开奖未揭晓数据作废（策略 B）', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const payload = legacyEnvelope({
    'daily-1': { state: 'claimed', chanceSpent: true, prize: { name: '免费咖啡一杯', win: true }, seed: 1, seedHash: 'a' },
    'daily-2': { state: 'scratching', chanceSpent: true, prize: { name: '8.8元 优惠券', win: true }, seed: 2, seedHash: 'b' },
    'daily-3': { state: 'idle', chanceSpent: false, prize: null, seed: null, seedHash: null },
  })
  const res = await importPayload(h, sid, payload, 'mig-c')
  assert.equal(res.json.imported.claimed.length, 1)
  assert.equal(res.json.discarded.spentUnrevealed.length, 1, '本地已开奖未揭晓作废')
  assert.equal(res.json.discarded.spentUnrevealed[0].cardId, 'daily-2')
  // claimed 只登记：服务端无可领记录
  assert.equal(serverCard(h.store, sid, 'daily', 'daily-1'), null)
  // 作废卡不产生任何服务端记录（不可继续刮、不退次）
  assert.equal(serverCard(h.store, sid, 'daily', 'daily-2'), null)
  // 当日次数不受迁移影响
  const state = await h.api('GET', '/api/state?campaign=daily', { sid })
  assert.equal(state.json.campaigns[0].chancesLeft, 3)
  await h.close()
})

test('E29: 未消费 idle 卡迁移后不产生任何可玩结果/额度', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const payload = legacyEnvelope({
    'daily-1': { state: 'idle', chanceSpent: false, prize: null, seed: null, seedHash: null },
    'daily-2': { state: 'idle', chanceSpent: false, prize: null, seed: null, seedHash: null },
  })
  const res = await importPayload(h, sid, payload, 'mig-d')
  assert.equal(res.json.imported.claimed.length, 0)
  assert.equal(res.json.imported.revealed.length, 0)
  assert.equal(res.json.discarded.idle.length, 2)
  assert.equal(h.store.listCards(sid).length, 0, '无 pending/任何卡记录')
  assert.equal(h.store.claimCount(), 0)
  const state = await h.api('GET', '/api/state?campaign=daily', { sid })
  assert.equal(state.json.campaigns[0].chancesLeft, 3, '不发放额度')
  await h.close()
})

test('E-附属: payloadHash 校验与 v1 旧信封导入', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const payload = legacyEnvelope({
    'daily-1': { state: 'claimed', chanceSpent: true, prize: { name: '谢谢参与', win: false }, seed: 9, seedHash: 'z' },
  })
  const badHash = await importPayload(h, sid, payload, 'mig-e', { payloadHash: 'deadbeef' })
  assert.equal(badHash.json.reason, 'bad-request')
  const goodHash = await importPayload(h, sid, payload, 'mig-f', {
    payloadHash: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
  })
  assert.equal(goodHash.json.ok, true)

  // v1 单 key 旧格式（无 version 字段）
  const v1 = { date: '2026-09-19', chancesUsed: 1, cards: {
    'daily-2': { state: 'claimed', prize: { name: '免费咖啡一杯', win: true }, chanceSpent: true },
  } }
  const v1Res = await importPayload(h, sid, v1, 'mig-g')
  assert.equal(v1Res.json.ok, true)
  assert.equal(v1Res.json.imported.claimed.length, 1)
  await h.close()
})
