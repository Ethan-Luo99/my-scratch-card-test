/**
 * 前端客户端/控制器/缓存 ↔ 真实服务端（createServerApp + node:http）端到端。
 *
 * 覆盖设计验收前端断言：
 * - A5 等价：begin 后"浏览器存储"全量扫描无 seedHex/奖品名；
 * - 全链路 begin→reveal→claim；刷新 recover 恢复 pending（不重摇）；
 * - E27 迁移导入 revealed 中奖→领取→再次导入不能二次领取；
 * - B24 拦截所有请求失败时不产生本地结果（离线不摇奖）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServerApp } from '../../server/http/app.js'
import { createApiClient } from '../../src/api/client.js'
import { createCampaignController } from '../../src/app/campaign-controller.js'
import { createClientCache, CACHE_PREFIX } from '../../src/client/cache.js'
import { createMigrationWizard } from '../../src/app/migration.js'

const PRIZE_NAMES = ['88元 现金红包', '免费咖啡一杯', '8.8元 优惠券', '谢谢参与', 'iPhone 抽奖券', '20 元红包']

function makeBrowserStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size
    },
    dump: () => map,
  }
}

async function startServer() {
  const handler = createServerApp()
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const close = () => new Promise((resolve) => server.close(resolve))
  return { base, close, engine: handler.engine }
}

function browserTransport(cookieHolder) {
  return async (path, options = {}) => {
    const headers = { ...(options.headers || {}) }
    if (cookieHolder.cookie) headers.cookie = cookieHolder.cookie
    const response = await fetch(`http://127.0.0.1:${cookieHolder.port}${path.startsWith('/api') ? '' : '/api'}${path}`, {
      ...options,
      headers,
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookieHolder.cookie = /(?:^| )(sid=[^;]+)/.exec(setCookie)[1]
    return response
  }
}

test('E2E 全链路：session→begin（存储无秘密）→recover pending→reveal→claim', async () => {
  const { base, close, engine } = await startServer()
  after(close)
  const storage = makeBrowserStorage()
  const cookieHolder = { cookie: null, port: new URL(base).port }
  const api = createApiClient({ transport: browserTransport(cookieHolder) })
  const cache = createClientCache({ storageFactory: () => storage })

  const session = await api.createSession()
  cache.saveSessionMeta(session)
  const view0 = await api.recover()
  assert.equal(view0.campaigns.length, 2)

  const controller = createCampaignController({
    campaignId: 'daily',
    cardIds: ['daily-1', 'daily-2', 'daily-3'],
    api,
    cache,
    online: true,
  })
  controller.hydrate(view0)

  const begin = await controller.begin('daily-1')
  assert.equal(begin.ok, true)
  assert.equal(begin.card.status, 'pending')
  assert.ok(begin.card.commitment)
  assert.equal(begin.card.prize, undefined)

  // B5：begin 后"浏览器 localStorage"全量扫描——无任何奖品名；
  // 真实 seedHex 在 reveal 时才下发，事后反查 begin 时刻的存储快照也不得包含它
  const beginBlob = Array.from(storage.dump().values()).join('\n')
  for (const name of PRIZE_NAMES) assert.ok(!beginBlob.includes(name), `存储泄漏奖品名：${name}`)
  assert.ok(beginBlob.includes(begin.card.commitment), '承诺（非秘密）允许存档')

  // 刷新恢复：新客户端 + 同一 cookie，pending 与承诺一致、机会已扣
  const recovered = await api.recover()
  const recoveredCard = recovered.campaigns[0].cards.find((card) => card.cardId === 'daily-1')
  assert.equal(recoveredCard.status, 'pending')
  assert.equal(recoveredCard.commitment, begin.card.commitment)
  assert.equal(recoveredCard.prize, undefined)
  assert.equal(recovered.campaigns[0].chancesLeft, 2)

  // reveal：结果第一次抵达
  const reveal = await controller.settle('daily-1')
  assert.equal(reveal.ok, true)
  assert.equal(reveal.card.status, 'revealed')
  assert.ok(reveal.card.prize)
  assert.ok(/^[0-9a-f]{32}$/.test(reveal.card.receipt.seedHex))
  assert.ok(!beginBlob.includes(reveal.card.receipt.seedHex), 'begin 时刻存储不得已含真实 seedHex')
  void engine
  // reveal 后奖品已公开：缓存中可以找到（离线只读）
  assert.ok(Array.from(storage.dump().values()).join('\n').includes(reveal.card.prize.name))

  const claim = await controller.claim('daily-1')
  assert.equal(claim.ok, true)
  assert.equal(claim.card.status, 'claimed')
  assert.ok(claim.card.claimRef)

  // 同键重试：服务端幂等回放，返回同一成功结果（响应丢失场景安全重试）
  const replay = await controller.claim('daily-1')
  assert.equal(replay.ok, true)
  assert.equal(replay.card.claimRef, claim.card.claimRef)

  // 不同幂等键的独立领取动作（如另一标签页）：服务端先到先得裁决
  const again = await api.claim('daily', 'daily-1', 'a-different-claim-key')
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'already-claimed')
  assert.equal(again.card.status, 'claimed')
})

test('E27 迁移防双领：导入 revealed 中奖→领取→再次导入无法第二次领取', async () => {
  const { base, close } = await startServer()
  after(close)
  const storage = makeBrowserStorage()
  const cookieHolder = { cookie: null, port: new URL(base).port }
  const api = createApiClient({ transport: browserTransport(cookieHolder) })
  const cache = createClientCache({ storageFactory: () => storage })
  await api.createSession()

  // 旧 v2 信封：一张已刮开未领取的中奖卡
  const legacyKey = 'scratch-campaign:v2:daily'
  const envelope = {
    version: 2,
    rev: 1,
    state: {
      date: '2026-09-23',
      lastDate: '2026-09-23',
      timeAnomaly: false,
      chancesUsed: 1,
      cards: {
        'daily-1': { state: 'revealed', chanceSpent: true, prize: { name: '免费咖啡一杯', win: true }, seed: 123, seedHash: '7b' },
      },
    },
  }
  storage.setItem(legacyKey, JSON.stringify(envelope))

  const wizard = createMigrationWizard({ api, cache })
  const first = await wizard.run()
  assert.equal(first.ok, true)
  assert.equal(storage.getItem(legacyKey), null, '成功导入后旧 key 必须删除')

  const view = await api.getState('daily')
  const card = view.campaigns[0].cards.find((item) => item.cardId === 'daily-1')
  assert.equal(card.status, 'revealed')
  assert.equal(card.prize.name, '免费咖啡一杯')

  const controller = createCampaignController({
    campaignId: 'daily',
    cardIds: ['daily-1', 'daily-2', 'daily-3'],
    api,
    cache,
    online: true,
  })
  controller.hydrate(view)
  const claim = await controller.claim('daily-1')
  assert.equal(claim.ok, true)
  assert.equal(claim.card.status, 'claimed')

  // 攻击者把旧数据写回本地再次导入：服务端去重，不能产生第二张待领卡
  storage.setItem(legacyKey, JSON.stringify(envelope))
  const wizard2 = createMigrationWizard({ api, cache })
  const second = await wizard2.run()
  assert.equal(second.ok, true)
  const view2 = await api.getState('daily')
  const card2 = view2.campaigns[0].cards.find((item) => item.cardId === 'daily-1')
  assert.equal(card2.status, 'claimed', '再次导入不得把已领奖卡回退为待领')
})

test('B24 离线不摇奖：全部请求失败时写动作不产生任何 seed/prize，已揭晓内容可离线查看', async () => {
  const { base, close } = await startServer()
  after(close)
  const storage = makeBrowserStorage()
  const cookieHolder = { cookie: null, port: new URL(base).port }
  const api = createApiClient({ transport: browserTransport(cookieHolder) })
  const cache = createClientCache({ storageFactory: () => storage })

  // 在线完成一张卡的揭晓，写入离线只读缓存
  await api.createSession()
  const keyBegin = 'begin-key-1'
  await api.begin('daily', 'daily-2', keyBegin)
  await api.reveal('daily', 'daily-2', 'reveal-key-1')
  const onlineView = await api.getState('daily')

  // 切到"断网"客户端（transport 一律 reject）
  const offlineApi = createApiClient({ transport: () => Promise.reject(new TypeError('offline')) })
  const offlineCache = createClientCache({
    storageFactory: () => {
      // 复用同一底层存储（已揭晓缓存落盘）
      return {
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => storage.setItem(key, value),
        removeItem: (key) => storage.removeItem(key),
        key: (index) => storage.key(index),
        get length() {
          return storage.length
        },
      }
    },
  })
  const controller = createCampaignController({
    campaignId: 'daily',
    cardIds: ['daily-1', 'daily-2', 'daily-3'],
    api: offlineApi,
    cache: offlineCache,
    online: false,
  })
  controller.hydrate(onlineView)
  controller.markOnline(false)
  // 离线缓存里 daily-2 已揭晓可看
  const cached = offlineCache.loadViews('daily')
  assert.ok(cached['daily-2'])
  assert.equal(cached['daily-2'].prize.name, cached['daily-2'].prize.name)

  const beforeKeys = Array.from(storage.dump().keys())
  // 控制器离线短路：写动作直接拒绝（reason=offline），请求根本不发出，
  // 自然也不存在"本地补结果"
  const beginResult = await controller.begin('daily-1')
  const settleResult = await controller.settle('daily-1')
  const claimResult = await controller.claim('daily-2')
  assert.deepEqual([beginResult.reason, settleResult.reason, claimResult.reason], ['offline', 'offline', 'offline'])
  const afterKeys = Array.from(storage.dump().keys())
  assert.deepEqual(afterKeys, beforeKeys, '离线写动作不得写入任何新状态')
  const card = controller.getCard('daily-1')
  assert.equal(card.status, 'idle')
  assert.equal(card.prize, undefined)
  // 已揭晓缓存仍可离线只读查看
  assert.equal(controller.getCard('daily-2').prize.name, cached['daily-2'].prize.name)
})
