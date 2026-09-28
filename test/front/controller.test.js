/**
 * 设计 4.1/4.4/5.1，验收 B24/B25：
 * - 控制器只镜像服务端公开视图；离线时写动作一律拒绝（绝不本地开奖）；
 * - begin/reveal/claim 网络失败用同一幂等键重试；
 * - dirty 提示只触发 GET /state 对齐，前端不做本地 CAS；
 * - already-pending/already-claimed 以服务端裁决为准。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCampaignController } from '../../src/app/campaign-controller.js'
import { CARD_STATUS } from '../../src/api/view.js'

const SEED_HEX = 'a'.repeat(32)
const COMMITMENT = 'b'.repeat(64)
const CARD_IDS = ['daily-1', 'daily-2', 'daily-3']

function memoryCache() {
  const map = new Map()
  return {
    map,
    saveCardView() {},
    loadViews: () => ({}),
    saveCommitment() {},
    loadCommitments: () => ({}),
    removeCommitment() {},
    getIdempotencyKey: (scope, cid, cardId, day) => `key-${scope}-${cardId}-${day ?? 'na'}`,
  }
}

function fakeApi({ scripts = {}, stateView = null } = {}) {
  const calls = []
  function call(name, ...args) {
    calls.push([name, ...args])
    const behavior = scripts[name]
    const step = typeof behavior === 'function' ? behavior(...args) : behavior
    if (step instanceof Error) throw step
    return step
  }
  return {
    calls,
    scripts,
    recover: () => call('recover'),
    getState: () => call('getState'),
    begin: (cid, cardId, key) => call('begin', cid, cardId, key),
    reveal: (cid, cardId, key, rev) => call('reveal', cid, cardId, key, rev),
    claim: (cid, cardId, key) => call('claim', cid, cardId, key),
  }
}

function fullView({ status, cardOverrides = {}, chancesLeft = 3 } = {}) {
  return {
    serverTime: '2026-09-24T02:00:00.000Z',
    day: '2026-09-24',
    campaigns: [
      {
        campaignId: 'daily',
        title: '每日刮刮卡',
        subtitle: 's',
        dailyChances: 3,
        chancesLeft,
        cards: [
          { cardId: 'daily-1', campaignId: 'daily', status, rev: status === 'idle' ? 0 : 1, ...cardOverrides },
          { cardId: 'daily-2', campaignId: 'daily', status: 'idle', rev: 0 },
          { cardId: 'daily-3', campaignId: 'daily', status: 'idle', rev: 0 },
        ],
      },
    ],
  }
}

test('boot 成功：镜像服务端 idle 视图，无任何奖品/seed', async () => {
  const api = fakeApi({ scripts: { recover: fullView({ status: 'idle' }) } })
  const controller = createCampaignController({ campaignId: 'daily', cardIds: CARD_IDS, api, cache: memoryCache() })
  const result = await controller.boot()
  assert.equal(result.online, true)
  const card = controller.getCard('daily-1')
  assert.equal(card.status, 'idle')
  assert.equal(card.prize, undefined)
  assert.equal(card.seedHex, undefined)
  assert.equal(controller.getSnapshot().chancesLeft, 3)
})

test('B24 离线：begin/settle/claim 全部拒绝，不产生任何本地结果', async () => {
  const api = fakeApi({ scripts: { recover: new Error('network down') } })
  const controller = createCampaignController({ campaignId: 'daily', cardIds: CARD_IDS, api, cache: memoryCache() })
  const boot = await controller.boot()
  assert.equal(boot.online, false)
  assert.equal((await controller.begin('daily-1')).reason, 'offline')
  assert.equal((await controller.settle('daily-1')).reason, 'offline')
  assert.equal((await controller.claim('daily-1')).reason, 'offline')
  // 没有任何 API 写动作被发出
  assert.deepEqual(api.calls.map((c) => c[0]), ['recover'])
  const card = controller.getCard('daily-1')
  assert.equal(card.prize, undefined)
  assert.equal(card.status, 'idle')
})

test('begin 成功：pending 视图只含 commitment；重试复用同一幂等键', async () => {
  const api = fakeApi()
  let attempts = 0
  api.scripts.begin = (cid, cardId, key) => {
    attempts += 1
    return {
      ok: true,
      reason: null,
      card: { cardId, campaignId: cid, status: 'pending', rev: 1, commitment: COMMITMENT },
      chancesLeft: 2,
      day: '2026-09-24',
      serverTime: 't',
      commitSig: 'csig',
      _idemKey: key,
    }
  }
  const controller = createCampaignController({ campaignId: 'daily', cardIds: CARD_IDS, api, cache: memoryCache() })
  await controller.hydrate(fullView({ status: 'idle', chancesLeft: 3 }))
  const first = await controller.begin('daily-1')
  assert.equal(first.ok, true)
  assert.equal(first.card.commitment, COMMITMENT)
  assert.equal(first.card.prize, undefined)
  const key1 = api.calls.filter((c) => c[0] === 'begin')[0][3]
  await controller.begin('daily-1')
  const key2 = api.calls.filter((c) => c[0] === 'begin')[1][3]
  assert.equal(key2, key1, '同卡同日重试必须复用同一幂等键')
})

test('already-pending：接受服务端复用的承诺，不新增扣费语义（以前端不裁决为准）', async () => {
  const api = fakeApi({
    scripts: {
      begin: {
        ok: false,
        reason: 'already-pending',
        card: { cardId: 'daily-1', campaignId: 'daily', status: 'pending', rev: 1, commitment: COMMITMENT },
        chancesLeft: 2,
        day: '2026-09-24',
        commitSig: 'csig',
      },
    },
  })
  const controller = createCampaignController({ campaignId: 'daily', cardIds: CARD_IDS, api, cache: memoryCache() })
  await controller.hydrate(fullView({ status: 'idle', chancesLeft: 3 }))
  const result = await controller.begin('daily-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'already-pending')
  assert.equal(controller.getCard('daily-1').commitment, COMMITMENT)
})

test('settle 揭晓：revealed 视图带 prize/receipt；网络失败重试不本地推进', async () => {
  const api = fakeApi()
  let failOnce = true
  api.scripts.reveal = (cid, cardId) => {
    if (failOnce) {
      failOnce = false
      throw new Error('network')
    }
    return {
      ok: true,
      card: {
        cardId,
        campaignId: cid,
        status: 'revealed',
        rev: 2,
        prize: { name: '谢谢参与', win: false },
        receipt: { seedHex: SEED_HEX, commitment: COMMITMENT, signature: 's', algorithm: 'a', weightsVersion: 'v1', serverTime: 't' },
      },
      chancesLeft: 2,
    }
  }
  const controller = createCampaignController({ campaignId: 'daily', cardIds: CARD_IDS, api, cache: memoryCache() })
  await controller.hydrate(
    fullView({
      status: CARD_STATUS.PENDING,
      cardOverrides: { commitment: COMMITMENT },
      chancesLeft: 2,
    }),
  )
  await assert.rejects(() => controller.settle('daily-1'), /network/)
  assert.equal(controller.getCard('daily-1').status, 'pending', '失败后仍是 pending，不本地补结果')
  const key1 = api.calls.find((c) => c[0] === 'reveal')[3]
  const result = await controller.settle('daily-1')
  assert.equal(result.ok, true)
  assert.equal(result.card.prize.name, '谢谢参与')
  const key2 = api.calls.filter((c) => c[0] === 'reveal')[1][3]
  assert.equal(key2, key1, '重试必须用同一幂等键')
})

test('claim already-claimed：服务端裁决，refresh 对齐为 claimed', async () => {
  const api = fakeApi({
    scripts: {
      claim: {
        ok: false,
        reason: 'already-claimed',
        card: null,
      },
      getState: fullView({
        status: CARD_STATUS.CLAIMED,
        cardOverrides: {
          rev: 3,
          prize: { name: '免费咖啡一杯', win: true },
          receipt: { seedHex: SEED_HEX, commitment: COMMITMENT, signature: 's', algorithm: 'a', weightsVersion: 'v1', serverTime: 't' },
          claimRef: 'claim_1',
        },
      }),
    },
  })
  const controller = createCampaignController({ campaignId: 'daily', cardIds: CARD_IDS, api, cache: memoryCache() })
  await controller.hydrate(
    fullView({
      status: CARD_STATUS.REVEALED,
      cardOverrides: {
        rev: 2,
        prize: { name: '免费咖啡一杯', win: true },
        receipt: { seedHex: SEED_HEX, commitment: COMMITMENT, signature: 's', algorithm: 'a', weightsVersion: 'v1', serverTime: 't' },
      },
    }),
  )
  const result = await controller.claim('daily-1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'already-claimed')
  assert.equal(controller.getCard('daily-1').status, 'claimed')
})

test('dirty 提示只触发 GET /state；带其他活动 id 的提示被忽略', async () => {
  const api = fakeApi({
    scripts: {
      getState: fullView({
        status: CARD_STATUS.REVEALED,
        cardOverrides: {
          rev: 2,
          prize: { name: '8.8元 优惠券', win: true },
          receipt: { seedHex: SEED_HEX, commitment: COMMITMENT, signature: 's', algorithm: 'a', weightsVersion: 'v1', serverTime: 't' },
        },
      }),
      begin: (cid, cardId) => ({
        ok: true,
        card: { cardId, campaignId: cid, status: 'pending', rev: 1, commitment: COMMITMENT },
        chancesLeft: 2,
        day: '2026-09-24',
        commitSig: 'csig',
      }),
    },
  })
  const dirty = { listeners: new Set(), posted: [] }
  const channel = {
    onChange: (fn) => dirty.listeners.add(fn),
    postDirty: (message) => dirty.posted.push(message),
  }
  const controller = createCampaignController({ campaignId: 'daily', cardIds: CARD_IDS, api, cache: memoryCache(), dirtyChannel: channel })
  await controller.hydrate(fullView({ status: 'idle' }))
  controller.handleDirty({ type: 'dirty', campaignId: 'weekend', cardId: 'weekend-1', rev: 1 })
  assert.equal(api.calls.filter((c) => c[0] === 'getState').length, 0)
  controller.handleDirty({ type: 'dirty', campaignId: 'daily', cardId: 'daily-1', rev: 2 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(api.calls.filter((c) => c[0] === 'getState').length, 1)
  assert.equal(controller.getCard('daily-1').status, 'revealed')
  // 本地写动作广播的 dirty 消息不含结果字段
  await controller.begin('daily-2')
  const message = dirty.posted[0]
  assert.equal(message.type, 'dirty')
  assert.equal(message.campaignId, 'daily')
  assert.equal(message.prize, undefined)
  assert.equal(message.seedHex, undefined)
  assert.equal(message.commitment, undefined, 'dirty 只带 rev 提示，连承诺都不广播')
})
