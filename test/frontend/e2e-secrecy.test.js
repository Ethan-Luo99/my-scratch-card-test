/**
 * 端到端（真实 HTTP + 生产 API 客户端 + 白名单缓存）：
 * 覆盖验收 A1/A2/A5、E25 与"两活动隔离"：
 * - begin 后（pending）：原始响应与全量 localStorage 均不含真实 seedHex/奖品名；
 * - reveal 后才出现奖品，且即 begin 时固定结果（不重摇）；
 * - begin 后"刷新恢复"（重新 init 拉 /state）仍是同一 pending 承诺、机会已扣；
 * - daily 与 weekend 卡/次数完全隔离。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApiClient } from '../../src/api/client.js'
import { createCampaign } from '../../src/campaign.js'
import { createCacheStore } from '../../src/storage/cache.js'
import { createMemoryBackend, dumpStorage } from './helpers.js'
import { makeHarness, internalCard } from '../server/helpers.js'

const DAILY_PRIZES = ['88元 现金红包', '免费咖啡一杯', '8.8元 优惠券', '谢谢参与']
const WEEKEND_PRIZES = ['iPhone 抽奖券', '20 元红包', '谢谢参与']

async function setup(t) {
  const harness = makeHarness()
  const server = createServer(harness.handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  let cookie = ''
  // 注入式 fetch（自带 cookie 罐）：不改动全局 fetch，避免与并行的
  // 服务端/Vite 测试相互污染
  const fetchImpl = async (url, init = {}) => {
    const absolute = new URL(url, base)
    const response = await fetch(absolute, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : '') },
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) {
      const match = /(?:^| )sid=([^;]+)/.exec(setCookie)
      if (match) cookie = `sid=${match[1]}`
    }
    return response
  }

  t.after(async () => {
    await harness.close()
    await new Promise((resolve) => server.close(resolve))
  })

  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  const api = createApiClient({ base: `${base}/api`, fetchImpl })
  await api.createSession()
  return { harness, backend, cache, api, fetchImpl, base }
}

async function makeCampaign(api, cache, id, cardIds, dailyChances) {
  const campaign = createCampaign({
    id,
    title: id,
    cardIds,
    dailyChances,
    api,
    cache,
    dirtyChannel: null,
    pollIntervalMs: 0,
  })
  await campaign.init()
  return campaign
}

function onlySid(harness) {
  return [...harness.store.sessions.keys()][0]
}

test('begin 后 pending：原始响应/localStorage/内存均无 seedHex 与奖品名；reveal 后才公开', async (t) => {
  const { harness, backend, cache, api, fetchImpl, base } = await setup(t)
  const daily = await makeCampaign(api, cache, 'daily', ['daily-1', 'daily-2', 'daily-3'], 3)

  const begin = await daily.beginScratch('daily-1')
  assert.equal(begin.ok, true)
  assert.equal(begin.card.status, 'pending')
  assert.equal(begin.card.prize, undefined)
  assert.equal(begin.card.receipt, undefined)
  assert.ok(begin.card.commitment)

  const sid = onlySid(harness)
  const internal = internalCard(harness.store, sid, 'daily', 'daily-1')
  assert.ok(internal.seedHex)

  const dumpedPending = dumpStorage(backend)
  assert.ok(!dumpedPending.includes(internal.seedHex), 'localStorage 不得含未揭晓 seedHex')
  for (const name of DAILY_PRIZES) {
    assert.ok(!dumpedPending.includes(name), `pending 时 localStorage 不得含奖品名：${name}`)
  }
  assert.equal(daily.getCard('daily-1').prize, undefined, '前端内存镜像无未揭晓奖品')

  // 原始 HTTP 再核一次：GET /state 的 pending 卡也不泄密
  const rawState = await (await fetchImpl(`${base}/api/state?campaign=daily`)).text()
  assert.ok(!rawState.includes(internal.seedHex), '/state 原文不得含 seedHex')
  assert.ok(!rawState.includes(internal.prize.name), '/state 原文不得含该 pending 奖品名')

  const reveal = await daily.reveal('daily-1')
  assert.equal(reveal.ok, true)
  assert.equal(reveal.card.prize.name, internal.prize.name, 'reveal 即 begin 固定结果，不重摇')
  assert.equal(reveal.card.receipt.seedHex, internal.seedHex)

  const dumpedRevealed = dumpStorage(backend)
  assert.ok(dumpedRevealed.includes(internal.prize.name), '揭晓后奖品可缓存（已公开）')
  assert.ok(dumpedRevealed.includes(internal.seedHex), '揭晓后 receipt 可缓存')

  const claim = await daily.claim('daily-1')
  assert.equal(claim.ok, true)
  assert.equal(claim.card.status, 'claimed')
})

test('begin 后刷新恢复：同一 pending 承诺、机会已扣；reveal 得同一结果（不退次不重摇）', async (t) => {
  const { harness, cache, api } = await setup(t)
  const daily = await makeCampaign(api, cache, 'daily', ['daily-1'], 3)
  await daily.beginScratch('daily-1')
  const sid = onlySid(harness)
  const before = internalCard(harness.store, sid, 'daily', 'daily-1')

  const restored = await makeCampaign(api, cache, 'daily', ['daily-1'], 3)
  const card = restored.getCard('daily-1')
  assert.equal(card.status, 'pending')
  assert.equal(card.commitment, before.commitment)
  assert.equal(card.prize, undefined)
  assert.equal(restored.getChancesLeft(), 2)

  const reveal = await restored.reveal('daily-1')
  assert.equal(reveal.ok, true)
  assert.equal(reveal.card.prize.name, before.prize.name)
  assert.equal(reveal.card.receipt.seedHex, before.seedHex)
})

test('两活动隔离：次数/卡互不影响；未揭晓时两活动奖品名均不落盘', async (t) => {
  const { backend, cache, api } = await setup(t)
  const daily = await makeCampaign(api, cache, 'daily', ['daily-1', 'daily-2', 'daily-3'], 3)
  const weekend = await makeCampaign(api, cache, 'weekend', ['weekend-1', 'weekend-2', 'weekend-3', 'weekend-4'], 5)

  assert.equal(daily.getChancesLeft(), 3)
  assert.equal(weekend.getChancesLeft(), 5)

  await daily.beginScratch('daily-1')
  assert.equal(daily.getChancesLeft(), 2)
  assert.equal(weekend.getChancesLeft(), 5, '每日活动扣次不影响周末活动')

  await weekend.beginScratch('weekend-1')
  assert.equal(weekend.getChancesLeft(), 4)
  assert.equal(daily.getChancesLeft(), 2)

  const dumped = dumpStorage(backend)
  for (const name of [...DAILY_PRIZES, ...WEEKEND_PRIZES]) {
    assert.ok(!dumped.includes(name), `未揭晓时奖品名不落盘：${name}`)
  }
})

test('迁移防双领：revealed 中奖卡导入→领取→再次导入不能第二次领取（验收 E27）', async (t) => {
  const { backend, api } = await setup(t)
  const v2Key = 'scratch-campaign:v2:daily'
  const envelopeObj = {
    version: 2,
    rev: 5,
    state: {
      date: '2026-09-20',
      lastDate: '2026-09-20',
      timeAnomaly: false,
      chancesUsed: 1,
      cards: {
        'daily-2': {
          state: 'revealed',
          chanceSpent: true,
          prize: { name: '免费咖啡一杯', win: true },
          seed: 777,
          seedHash: '00000309',
        },
      },
    },
  }
  backend.setItem(v2Key, JSON.stringify(envelopeObj))

  const { runMigration } = await import('../../src/lib/legacy.js')
  const locks = (await import('./helpers.js')).createSharedLocks().a
  const run = () =>
    runMigration({
      backend,
      locks,
      importFn: (payload, payloadHash, idemKey) => api.migrateImport(payload, payloadHash, idemKey),
    })

  const first = await run()
  assert.equal(first.migrated, true)
  assert.ok(first.result.imported.revealed.some((r) => r.cardId === 'daily-2'))
  assert.equal(backend.getItem(v2Key), null, '迁移成功后旧 key 必须删除')

  const claim1 = await api.claim('daily', 'daily-2', crypto.randomUUID())
  assert.equal(claim1.ok, true)
  assert.equal(claim1.card.status, 'claimed')

  // 模拟换浏览器/改本地数据再次导入（新幂等键，绕过键级缓存），
  // 真正检验服务端 claimsLedger 的永久防重领
  const second = await api.migrateImport(
    { envelopes: [{ campaignId: 'daily', envelope: envelopeObj }] },
    null,
    crypto.randomUUID(),
  )
  assert.equal(second.ok, true)
  const ref = second.imported.revealed.find((r) => r.cardId === 'daily-2')
  assert.ok(ref, '应返回该卡的去重登记结果')
  assert.equal(ref.dedup, true, '服务端去重命中，不新建第二张待领卡')

  const claim2 = await api.claim('daily', 'daily-2', crypto.randomUUID())
  assert.equal(claim2.ok, false)
  assert.equal(claim2.reason, 'already-claimed', '不能第二次领取')
})
