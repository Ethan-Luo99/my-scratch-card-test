/**
 * 活动引擎集成测试：用共享内存后端 + 共享锁桩模拟两个标签页。
 * 覆盖：旧数据迁移、并发扣次数原子性、领取冲突、跨标签页同步、
 * 时间回拨、公平性凭证、存储降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCampaign, STORAGE_KEY_PREFIX } from '../src/campaign.js'

const PRIZES = [
  { name: '大奖', weight: 1, win: true },
  { name: '谢谢参与', weight: 99, win: false },
]

function createMemoryBackend() {
  const map = new Map()
  return {
    get isPersistent() {
      return true
    },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      map.set(k, String(v))
      return true
    },
    removeItem(k) {
      map.delete(k)
    },
    subscribe() {
      return () => {}
    },
    _map: map,
  }
}

/** 共享锁桩：模拟 Web Locks 的跨标签页串行化语义 */
function createSharedLocks() {
  const tails = new Map()
  return {
    request(name, _opts, fn) {
      const prev = tails.get(name) || Promise.resolve()
      const next = Promise.resolve(prev).then(() => fn())
      tails.set(name, next.catch(() => {}))
      return next
    },
  }
}

function makeTabs(backend, locks, count, extra = {}) {
  return Array.from({ length: count }, () =>
    createCampaign({
      namespace: 'test',
      cardIds: ['c1', 'c2'],
      prizes: PRIZES,
      dailyChances: 1,
      backend,
      locksApi: locks,
      cryptoObject: null,
      ...extra,
    }),
  )
}

test('首次加载把旧版 v1 数据无损迁移到新 key，并移除旧 key', () => {
  const backend = createMemoryBackend()
  const legacy = {
    date: '2026-09-23',
    chancesUsed: 1,
    cards: {
      c1: { state: 'revealed', prize: { name: '大奖', win: true }, chanceSpent: true },
      c2: { state: 'idle', prize: null, chanceSpent: false },
    },
  }
  backend.setItem('legacy-key', JSON.stringify(legacy))

  const campaign = createCampaign({
    namespace: 'daily',
    cardIds: ['c1', 'c2'],
    prizes: PRIZES,
    dailyChances: 3,
    backend,
    legacyKey: 'legacy-key',
    now: () => new Date(2026, 8, 23),
  })

  assert.equal(campaign.getChancesLeft(), 2) // 次数未被重置
  assert.equal(campaign.getCard('c1').state, 'revealed') // 中间态保留
  assert.deepEqual(campaign.getCard('c1').prize, { name: '大奖', win: true }) // 奖品不重摇
  assert.equal(backend.getItem('legacy-key'), null) // 旧 key 已移除

  const persisted = JSON.parse(backend.getItem(STORAGE_KEY_PREFIX + 'daily'))
  assert.equal(persisted.version, 2)
  assert.equal(persisted.state.chancesUsed, 1)
  campaign.destroy()
})

test('并发扣次数：两个标签页抢最后 1 次机会，只有 1 个成功', async () => {
  const backend = createMemoryBackend()
  const locks = createSharedLocks()
  const [tabA, tabB] = makeTabs(backend, locks, 2)

  const [ra, rb] = await Promise.all([tabA.beginScratch('c1'), tabB.beginScratch('c2')])
  const oks = [ra, rb].filter((r) => r.ok)
  assert.equal(oks.length, 1, '只能有一个标签页扣减成功')
  assert.equal([ra, rb].filter((r) => r.reason === 'no-chances').length, 1)

  const stored = JSON.parse(backend.getItem(STORAGE_KEY_PREFIX + 'test'))
  assert.equal(stored.state.chancesUsed, 1, '落盘次数不得超过上限')
  tabA.destroy()
  tabB.destroy()
})

test('无共享锁的降级路径：落盘次数仍然不超过上限', async () => {
  // 各自独立的本地互斥（模拟无 Web Locks 环境），并发发起
  const backend = createMemoryBackend()
  const [tabA, tabB] = makeTabs(backend, undefined, 2)
  const results = await Promise.all([
    tabA.beginScratch('c1'),
    tabB.beginScratch('c2'),
    tabA.beginScratch('c2'),
    tabB.beginScratch('c1'),
  ])
  const stored = JSON.parse(backend.getItem(STORAGE_KEY_PREFIX + 'test'))
  assert.ok(stored.state.chancesUsed <= 1, '任意操作序列下落盘次数不超上限')
  assert.ok(results.some((r) => r.ok))
  tabA.destroy()
  tabB.destroy()
})

test('领取冲突：先到先得，后到者失败且状态收敛为已领取', async () => {
  const backend = createMemoryBackend()
  const locks = createSharedLocks()
  const [tabA, tabB] = makeTabs(backend, locks, 2, { dailyChances: 2 })

  assert.ok((await tabA.beginScratch('c1')).ok)
  assert.ok((await tabA.reveal('c1')).ok)

  const [ca, cb] = await Promise.all([tabA.claim('c1'), tabB.claim('c1')])
  const results = [ca, cb]
  assert.equal(results.filter((r) => r.ok).length, 1, '只能领取成功一次')
  assert.equal(results.filter((r) => r.reason === 'invalid-state').length, 1)

  // 失败方本地快照已收敛为 claimed（commit 内会采用最新快照）
  assert.equal(tabA.getCard('c1').state, 'claimed')
  assert.equal(tabB.getCard('c1').state, 'claimed')
  tabA.destroy()
  tabB.destroy()
})

test('跨标签页同步：A 刮开后 B 不刷新即看到次数与卡片状态更新', async () => {
  const backend = createMemoryBackend()
  const locks = createSharedLocks()
  const [tabA, tabB] = makeTabs(backend, locks, 2, { dailyChances: 3 })

  const seen = new Promise((resolve) => {
    tabB.onChange(() => {
      if (tabB.getChancesLeft() === 2) resolve()
    })
  })
  assert.ok((await tabA.beginScratch('c1')).ok)
  await Promise.race([
    seen,
    new Promise((_, reject) => setTimeout(() => reject(new Error('同步超时')), 2000)),
  ])
  assert.equal(tabB.getCard('c1').state, 'scratching')
  tabA.destroy()
  tabB.destroy()
})

test('时间回拨：当前日期早于持久化日期时按同一天延续并告警', () => {
  const backend = createMemoryBackend()
  backend.setItem(
    STORAGE_KEY_PREFIX + 'test',
    JSON.stringify({
      version: 2,
      rev: 3,
      state: {
        date: '2026-09-23',
        lastDate: '2026-09-23',
        timeAnomaly: false,
        chancesUsed: 1,
        cards: {
          c1: { state: 'claimed', prize: { name: '大奖', win: true }, chanceSpent: true, seed: 5, seedHash: 'x' },
          c2: { state: 'idle', prize: null, chanceSpent: false, seed: null, seedHash: null },
        },
      },
    }),
  )
  const campaign = createCampaign({
    namespace: 'test',
    cardIds: ['c1', 'c2'],
    prizes: PRIZES,
    dailyChances: 3,
    backend,
    locksApi: createSharedLocks(),
    cryptoObject: null,
    now: () => new Date(2026, 8, 22), // 系统时间被改回昨天
  })
  assert.equal(campaign.isTimeAnomaly(), true)
  assert.equal(campaign.getChancesLeft(), 2, '次数不重置')
  assert.equal(campaign.getCard('c1').state, 'claimed', '卡片状态保留')
  campaign.destroy()
})

test('公平性凭证：seed 在开刮前不存在，开刮后可验证且重算一致', async () => {
  const backend = createMemoryBackend()
  const campaign = createCampaign({
    namespace: 'test',
    cardIds: ['c1', 'c2'],
    prizes: PRIZES,
    dailyChances: 3,
    backend,
    locksApi: createSharedLocks(),
    cryptoObject: null,
  })
  assert.equal(campaign.getFairnessProof('c1'), null, '开刮前无 seed 可读')
  assert.equal(campaign.getCard('c1').seed, null)

  assert.ok((await campaign.beginScratch('c1')).ok)
  const proof = campaign.getFairnessProof('c1')
  assert.ok(proof)
  assert.ok(Number.isInteger(proof.seed))
  assert.match(proof.seedHash, /^[0-9a-f]{8}$/)
  assert.equal(proof.hashMatches, true)
  assert.deepEqual(proof.recomputed, campaign.getCard('c1').prize, '重算奖品与锁定奖品一致')
  campaign.destroy()
})

test('localStorage 不可用：内存降级可完整跑完流程，不崩溃', async () => {
  const memoryOnly = {
    get isPersistent() {
      return false
    },
    _m: new Map(),
    getItem(k) {
      return this._m.get(k) ?? null
    },
    setItem(k, v) {
      this._m.set(k, String(v))
      return false
    },
    removeItem(k) {
      this._m.delete(k)
    },
    subscribe() {
      return () => {}
    },
  }
  const campaign = createCampaign({
    namespace: 'test',
    cardIds: ['c1', 'c2'],
    prizes: PRIZES,
    dailyChances: 2,
    backend: memoryOnly,
    locksApi: null,
    cryptoObject: null,
    channelFactory: () => null, // BroadcastChannel 也不可用
  })
  assert.equal(campaign.isPersistent, false)
  assert.ok((await campaign.beginScratch('c1')).ok)
  assert.ok((await campaign.reveal('c1')).ok)
  assert.ok((await campaign.claim('c1')).ok)
  assert.equal(campaign.getChancesLeft(), 1)
  campaign.destroy()
})
