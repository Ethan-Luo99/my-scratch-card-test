/**
 * 活动实例 = 服务端公开视图镜像（验收核心）：
 * - 卡状态/chancesLeft 全部来自服务端响应，前端不记账、不本地推进；
 * - pending 卡镜像绝无 prize；写动作网络失败只同幂等键重试，不本地补结果；
 * - dirty 提示触发 GET /state 对齐；离线只展示已揭晓缓存，未揭晓槽位无结果；
 * - 两活动实例独立（各自卡/次数）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCampaign } from '../../src/campaign.js'
import { createMemoryBackend, dumpStorage } from './helpers.js'
import { createCacheStore } from '../../src/storage/cache.js'
import { NetworkError } from '../../src/api/client.js'

const CARD_IDS = ['daily-1', 'daily-2', 'daily-3']

function stateView({ chancesLeft = 3, cards = [], day = '2026-09-27' }) {
  return {
    serverTime: '2026-09-27T02:00:00.000Z',
    day,
    campaigns: [
      {
        campaignId: 'daily',
        title: '每日刮刮卡',
        dailyChances: 3,
        chancesLeft,
        cards: cards.map((card) => ({ campaignId: 'daily', ...card })),
      },
    ],
  }
}

const pendingCard = (cardId = 'daily-1', rev = 1) => ({
  cardId,
  status: 'pending',
  rev,
  commitment: 'ab'.repeat(32),
  expiresAt: '2999-01-01T00:00:00.000Z',
})

const revealedCard = (cardId = 'daily-1', name = '免费咖啡一杯', win = true, rev = 2) => ({
  cardId,
  status: 'revealed',
  rev,
  prize: { name, win },
  receipt: {
    seedHex: '11'.repeat(16),
    algorithm: 'mulberry32-sha256-commit-v1',
    weightsVersion: 'v1',
    commitment: 'ab'.repeat(32),
    serverTime: '2026-09-27T02:05:00.000Z',
    signature: 'cd'.repeat(32),
  },
})

/** 记录式假 API：按脚本返回，并记录调用参数 */
function scriptedApi(script = {}) {
  const calls = []
  const make = (name, fn) => async (...args) => {
    calls.push({ name, args })
    return fn(...args)
  }
  return {
    calls,
    state: make('state', script.state ?? (() => stateView({}))),
    begin: make('begin', script.begin ?? (() => ({ ok: true }))),
    reveal: make('reveal', script.reveal ?? (() => ({ ok: true }))),
    claim: make('claim', script.claim ?? (() => ({ ok: true }))),
  }
}

async function makeInstance(overrides = {}) {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  const api = overrides.api ?? scriptedApi(overrides.script)
  const campaign = createCampaign({
    id: 'daily',
    title: '每日刮刮卡',
    cardIds: CARD_IDS,
    dailyChances: 3,
    api,
    cache,
    dirtyChannel: overrides.dirtyChannel ?? null,
    pollIntervalMs: 0,
  })
  await campaign.init(overrides.initialView ?? null, overrides.initOptions ?? undefined)
  return { campaign, backend, cache, api }
}

test('初始化镜像 /state：idle 卡无承诺无奖品，次数来自服务端', async () => {
  const { campaign } = await makeInstance({
    script: {
      state: () =>
        stateView({
          chancesLeft: 2,
          cards: [{ cardId: 'daily-1', status: 'idle', rev: 0 }, pendingCard('daily-2')],
        }),
    },
  })
  assert.equal(campaign.getChancesLeft(), 2)
  const idle = campaign.getCard('daily-1')
  assert.equal(idle.status, 'idle')
  assert.equal(idle.prize, undefined)
  const pending = campaign.getCard('daily-2')
  assert.equal(pending.status, 'pending')
  assert.equal(pending.prize, undefined)
  assert.ok(pending.commitment)
})

test('begin 成功：镜像 pending、次数以响应为准，承诺落盘但无奖品落盘', async () => {
  const { campaign, backend } = await makeInstance({
    script: {
      begin: () => ({
        ok: true,
        card: { campaignId: 'daily', ...pendingCard() },
        chancesLeft: 2,
        day: '2026-09-27',
        serverTime: '2026-09-27T02:01:00.000Z',
      }),
    },
  })
  const result = await campaign.beginScratch('daily-1')
  assert.equal(result.ok, true)
  assert.equal(campaign.getCard('daily-1').status, 'pending')
  assert.equal(campaign.getCard('daily-1').prize, undefined)
  assert.equal(campaign.getChancesLeft(), 2)
  const dumped = dumpStorage(backend)
  assert.ok(dumped.includes('ab'.repeat(32)), '承诺允许落盘')
  for (const name of ['88元 现金红包', '免费咖啡一杯', '8.8元 优惠券']) {
    assert.ok(!dumped.includes(name), `未揭晓奖品名严禁落盘：${name}`)
  }
})

test('begin 网络失败：进入离线锁定且不产生任何本地状态变化；重试复用同一幂等键', async () => {
  const beginKeys = []
  let attempt = 0
  const { campaign } = await makeInstance({
    api: {
      state: async () => stateView({}),
      begin: async (_cid, _cardId, key) => {
        beginKeys.push(key)
        attempt += 1
        if (attempt === 1) throw new NetworkError()
        return {
          ok: true,
          card: { campaignId: 'daily', ...pendingCard() },
          chancesLeft: 2,
        }
      },
      reveal: async () => ({ ok: true }),
      claim: async () => ({ ok: true }),
    },
  })
  await assert.rejects(() => campaign.beginScratch('daily-1'), NetworkError)
  assert.equal(campaign.snapshot.offline, true)
  assert.equal(campaign.getCard('daily-1').status, 'idle', '失败不得本地推进到 pending')
  assert.equal(campaign.getCard('daily-1').prize, undefined)

  await campaign.reconnect()
  const retried = await campaign.beginScratch('daily-1')
  assert.equal(retried.ok, true)
  assert.equal(beginKeys[0], beginKeys[1], '重试必须复用同一幂等键')
  assert.equal(campaign.getCard('daily-1').status, 'pending')
})

test('reveal 成功才出现奖品；失败不本地补结果', async () => {
  const { campaign } = await makeInstance({
    initialView: stateView({ chancesLeft: 2, cards: [pendingCard()] }),
    script: {
      reveal: () => ({
        ok: true,
        card: { campaignId: 'daily', ...revealedCard() },
        chancesLeft: 2,
      }),
    },
  })
  assert.equal(campaign.getCard('daily-1').prize, undefined, 'reveal 前无奖品')
  const result = await campaign.reveal('daily-1')
  assert.equal(result.ok, true)
  assert.equal(campaign.getCard('daily-1').prize.name, '免费咖啡一杯')
})

test('reveal 网络失败：卡仍 pending（服务端真相不变），可同键重试', async () => {
  const revealKeys = []
  let calls = 0
  const { campaign } = await makeInstance({
    initialView: stateView({ chancesLeft: 2, cards: [pendingCard()] }),
    api: {
      state: async () => stateView({ chancesLeft: 2, cards: [pendingCard()] }),
      begin: async () => ({ ok: true }),
      reveal: async (_cid, _cardId, key) => {
        revealKeys.push(key)
        calls += 1
        if (calls === 1) throw new NetworkError()
        return { ok: true, card: { campaignId: 'daily', ...revealedCard() }, chancesLeft: 2 }
      },
      claim: async () => ({ ok: true }),
    },
  })
  await assert.rejects(() => campaign.reveal('daily-1'), NetworkError)
  assert.equal(campaign.getCard('daily-1').status, 'pending')
  assert.equal(campaign.getCard('daily-1').prize, undefined)
  const retry = await campaign.reveal('daily-1')
  assert.equal(retry.ok, true)
  assert.equal(campaign.getCard('daily-1').status, 'revealed')
  assert.equal(revealKeys[0], revealKeys[1], '重试复用同一幂等键')
})

test('already-claimed/conflict：以服务端 /state 最新视图对齐，不本地裁决', async () => {
  const { campaign, api } = await makeInstance({
    initialView: stateView({ cards: [revealedCard('daily-1', '88元 现金红包')] }),
    script: {
      claim: () => ({ ok: false, reason: 'already-claimed' }),
      state: () =>
        stateView({
          cards: [
            {
              ...revealedCard('daily-1', '88元 现金红包'),
              status: 'claimed',
              rev: 3,
              claimRef: 'claim_1',
            },
          ],
        }),
    },
  })
  const result = await campaign.claim('daily-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'already-claimed')
  assert.equal(campaign.getCard('daily-1').status, 'claimed', '已对齐服务端裁决')
  assert.ok(api.calls.some((c) => c.name === 'state'), '冲突后回拉 /state')
})

test('离线首屏：仅已揭晓缓存可见，未揭晓槽位无结果', async () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  cache.saveRevealedCard('daily', { campaignId: 'daily', ...revealedCard('daily-1') })
  const api = {
    state: async () => {
      throw new NetworkError()
    },
    begin: async () => ({ ok: true }),
    reveal: async () => ({ ok: true }),
    claim: async () => ({ ok: true }),
  }
  const campaign = createCampaign({
    id: 'daily',
    title: '每日刮刮卡',
    cardIds: CARD_IDS,
    dailyChances: 3,
    api,
    cache,
    dirtyChannel: null,
    pollIntervalMs: 0,
  })
  await campaign.init()
  assert.equal(campaign.snapshot.offline, true)
  assert.equal(campaign.getCard('daily-1').status, 'revealed', '已揭晓缓存离线可见')
  assert.equal(campaign.getCard('daily-1').prize.name, '免费咖啡一杯')
  assert.equal(campaign.getCard('daily-2').prize, undefined, '未揭晓槽位离线无结果')
  assert.equal(campaign.getCard('daily-2').status, 'idle')
})

test('dirty 通道提示 -> GET /state 对齐他页结果', async () => {
  const listeners = new Set()
  const dirtyChannel = {
    onChange: (fn) => listeners.add(fn),
    post() {},
    destroy() {},
  }
  let serverCards = [pendingCard('daily-1')]
  const api = {
    state: async () => stateView({ chancesLeft: 2, cards: serverCards }),
    begin: async () => ({ ok: true }),
    reveal: async () => ({ ok: true }),
    claim: async () => ({ ok: true }),
  }
  const { campaign } = await makeInstance({ api, dirtyChannel })
  assert.equal(campaign.getCard('daily-1').status, 'pending')
  // 模拟他页揭晓：下一次 /state 返回 revealed
  serverCards = [{ ...revealedCard('daily-1'), status: 'revealed' }]
  for (const fn of listeners) fn({ campaignId: 'daily', cardId: 'daily-1', rev: 2 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(campaign.getCard('daily-1').status, 'revealed')
  assert.equal(campaign.getCard('daily-1').prize.name, '免费咖啡一杯')
})
