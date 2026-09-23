/**
 * 跨标签页集成测试（共享内存后端 = 同一浏览器同源多标签页）。
 * 覆盖：并发原子扣次数、锁内双写冲突 CAS 重试、claim 先到先得、
 * 远程同步、旧格式迁移、时间回拨、多实例隔离、降级。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCampaign } from '../src/campaign.js'
import {
  createSharedBackends,
  createSharedLocks,
  createClock,
  createSeedGen,
  createInProcessBus,
  PRIZES,
} from './helpers.js'
import { createSyncChannel, createSenderId } from '../src/storage/sync.js'
import { createKvBackend } from '../src/storage/backend.js'

const CARD_IDS = ['c1', 'c2', 'c3', 'c4']

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond, timeout = 2000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor 超时')
    await delay(10)
  }
}

function makeCampaign({
  backend,
  locks,
  clock,
  seedGen,
  id = 'daily',
  channel = null,
  dailyChances = 3,
  cardIds = CARD_IDS,
  prizes = PRIZES,
  beforeCasAttempt,
  legacyKey = null,
}) {
  return createCampaign({
    id,
    key: `scratch-campaign:v2:${id}`,
    cardIds,
    prizes,
    dailyChances,
    backend,
    locks,
    syncChannel: channel,
    legacyKey,
    now: clock.now,
    generateSeedFn: seedGen,
    beforeCasAttempt,
  })
}

test('并发原子扣次数：N 个标签页同时开始刮，总扣减绝不超过每日上限', async () => {
  const { a, b } = createSharedBackends()
  const { a: lockA, b: lockB } = createSharedLocks()
  const clock = createClock()
  const seedA = createSeedGen(1000)
  const seedB = createSeedGen(2000)

  const campA = makeCampaign({ backend: a, locks: lockA, clock, seedGen: seedA })
  const campB = makeCampaign({ backend: b, locks: lockB, clock, seedGen: seedB })
  await Promise.all([campA.init(), campB.init()])

  // 两个标签页各拿 4 张卡，几乎同时发起 begin（每日上限 3）
  const attempts = []
  for (const id of ['c1', 'c2', 'c3', 'c4']) {
    attempts.push(campA.beginScratch(id))
    attempts.push(campB.beginScratch(id))
  }
  const results = await Promise.all(attempts)
  // 同一卡在另一标签页"恢复刮"会成功但不扣次数；真正的安全指标是总扣减数
  assert.equal(results.length, 8)
  assert.ok(results.some((r) => !r.ok && r.reason === 'no-chances'), '存在被拒的请求')

  const stored = JSON.parse(a.getItem('scratch-campaign:v2:daily'))
  assert.equal(stored.state.chancesUsed, 3, '存储中总扣减恰好为上限，绝不超扣')
  const paidCards = Object.values(stored.state.cards).filter((c) => c.chanceSpent).length
  assert.equal(paidCards, 3, '恰好 3 张卡消耗过机会')
  assert.equal(campA.getChancesLeft(), 0)
  assert.equal(campB.getChancesLeft(), 0)
})

test('双写冲突：CAS 在写回瞬间发现另一标签页已写入 -> 基于新快照重放而非覆盖', async () => {
  const { a, b, map } = createSharedBackends()
  // 不给 a 真正的跨标签页锁：强制走纯 CAS 兜底路径
  const { b: lockB } = createSharedLocks()
  const noLocks = { supported: false, withLock: (_n, fn) => fn() }
  const clock = createClock()

  const campA = makeCampaign({
    backend: a,
    locks: noLocks,
    clock,
    seedGen: createSeedGen(1000),
    // 在 a 的首次 CAS 写回前，模拟"另一标签页 b"已经成功扣掉 1 次
    beforeCasAttempt: async ({ attempt }) => {
      if (attempt === 0) {
        const rival = makeCampaign({
          backend: b,
          locks: lockB,
          clock,
          seedGen: createSeedGen(5000),
        })
        await rival.init()
        await rival.beginScratch('c2')
        assert.equal(JSON.parse(map.get('scratch-campaign:v2:daily')).state.chancesUsed, 1)
      }
    },
  })
  await campA.init()
  const res = await campA.beginScratch('c1')
  assert.equal(res.ok, true, 'CAS 冲突后基于新快照重试成功')
  const stored = JSON.parse(a.getItem('scratch-campaign:v2:daily'))
  assert.equal(stored.state.chancesUsed, 2, '对手的扣减被保留，自己的也生效，互不覆盖')
  assert.equal(stored.state.cards.c1.chanceSpent, true)
  assert.equal(stored.state.cards.c2.chanceSpent, true)
})

test('CAS 连续冲突超过重试上限返回 busy 且不写脏数据', async () => {
  const { a, b, map } = createSharedBackends()
  const { b: lockB } = createSharedLocks()
  const noLocks = { supported: false, withLock: (_n, fn) => fn() }
  const clock = createClock()
  let writes = 0
  const rival = makeCampaign({
    backend: b,
    locks: lockB,
    clock,
    seedGen: createSeedGen(5000),
  })
  const campA = makeCampaign({
    backend: a,
    locks: noLocks,
    clock,
    seedGen: createSeedGen(1),
    beforeCasAttempt: async () => {
      writes += 1
      if (writes === 1) {
        await rival.init()
        await rival.beginScratch('c2') // 制造首个更新版本
      } else {
        // 之后每次只抬 rev（内容不变），制造持续冲突
        const cur = JSON.parse(map.get('scratch-campaign:v2:daily'))
        map.set('scratch-campaign:v2:daily', JSON.stringify({ ...cur, rev: cur.rev + 1 }))
      }
    },
  })
  await campA.init()
  const res = await campA.beginScratch('c1')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'busy')
  assert.ok(writes >= 8, `实际重试 ${writes} 次`)
  const stored = JSON.parse(map.get('scratch-campaign:v2:daily'))
  assert.equal(stored.state.chancesUsed, 1, '只保留对手的 1 次合法扣减')
  assert.ok(!stored.state.cards.c1.chanceSpent, 'A 自己的卡在 busy 后不得落盘')
  assert.equal(stored.state.cards.c2.chanceSpent, true)
})

test('claim 先到先得：并发领取只成功一次，失败方拿到 invalid-state 且最终状态一致', async () => {
  const { a, b } = createSharedBackends()
  const { a: lockA, b: lockB } = createSharedLocks()
  const clock = createClock()
  const bus = createInProcessBus()
  const campA = makeCampaign({
    backend: a,
    locks: lockA,
    clock,
    seedGen: createSeedGen(1),
    channel: createSyncChannel({ name: 'claim-sync', backend: a, senderId: 'tab-A', channelFactory: bus.channelFactory.bind(bus) }),
  })
  const campB = makeCampaign({
    backend: b,
    locks: lockB,
    clock,
    seedGen: createSeedGen(2),
    channel: createSyncChannel({ name: 'claim-sync', backend: b, senderId: 'tab-B', channelFactory: bus.channelFactory.bind(bus) }),
  })
  await Promise.all([campA.init(), campB.init()])

  await campA.beginScratch('c1')
  await campA.reveal('c1')
  // B 在领取前先看到 A 刮开的结果（远程同步）
  await waitFor(() => campB.getCard('c1')?.state === 'revealed')

  const [r1, r2] = await Promise.all([campA.claim('c1'), campB.claim('c1')])
  const oks = [r1, r2].filter((r) => r.ok)
  const fails = [r1, r2].filter((r) => !r.ok)
  assert.equal(oks.length, 1, '恰好一方领取成功')
  assert.equal(fails.length, 1)
  assert.equal(fails[0].reason, 'invalid-state')

  await waitFor(() => campB.getCard('c1')?.state === 'claimed')
  assert.equal(campA.getCard('c1').state, 'claimed')
  assert.equal(campB.getCard('c1').state, 'claimed')
  campA.destroy()
  campB.destroy()
})

test('远程同步：A 刮开后 B 不刷新页面即看到卡片状态与剩余次数更新', async () => {
  const { a, b } = createSharedBackends()
  const { a: lockA, b: lockB } = createSharedLocks()
  const clock = createClock()
  const bus = createInProcessBus()
  const chA = createSyncChannel({
    name: 'test-sync-daily',
    backend: a,
    senderId: 'tab-A',
    channelFactory: bus.channelFactory.bind(bus),
  })
  const chB = createSyncChannel({
    name: 'test-sync-daily',
    backend: b,
    senderId: 'tab-B',
    channelFactory: bus.channelFactory.bind(bus),
  })
  const campA = makeCampaign({
    backend: a,
    locks: lockA,
    clock,
    seedGen: createSeedGen(1),
    channel: chA,
  })
  const campB = makeCampaign({
    backend: b,
    locks: lockB,
    clock,
    seedGen: createSeedGen(2),
    channel: chB,
  })
  await Promise.all([campA.init(), campB.init()])

  let remoteEvents = 0
  campB.onChange((_s, meta) => {
    if (meta.source === 'remote') remoteEvents += 1
  })

  await campA.beginScratch('c1')
  await campA.reveal('c1')

  await waitFor(() => campB.getCard('c1')?.state === 'revealed')
  assert.equal(campB.getChancesLeft(), 2, 'B 的剩余次数同步为 2')
  assert.ok(remoteEvents >= 1, 'B 收到至少一次远程变更通知')
  campA.destroy()
  campB.destroy()
})

test('公平性：begin 之前 seed/奖品不存在于任何可读位置；begin 后可验证重算一致', async () => {
  const { a } = createSharedBackends()
  const { a: lockA } = createSharedLocks()
  const clock = createClock()
  const camp = makeCampaign({ backend: a, locks: lockA, clock, seedGen: createSeedGen(4242) })
  await camp.init()
  assert.equal(camp.getCard('c1').seed, null)
  assert.equal(camp.getCard('c1').prize, null)
  const rawBefore = a.getItem('scratch-campaign:v2:daily')
  assert.ok(rawBefore === null || !rawBefore.includes('"seed"'), '存储里无 seed')

  await camp.beginScratch('c1')
  const card = camp.getCard('c1')
  assert.equal(typeof card.seed, 'number')
  assert.match(card.seedHash, /^[0-9a-f]{8}$/)

  const report = camp.verify('c1')
  assert.equal(report.hashMatches, true)
  assert.equal(report.prizeMatches, true)
  assert.equal(report.lockedPrize.name, report.prize.name)
  camp.destroy()
})

test('存储迁移全链路：旧 key 数据被活动实例无损接管，旧 key 清除且不重复迁移', async () => {
  const { a, b } = createSharedBackends()
  const LEGACY_KEY = 'scratch-campaign-v1'
  b.setItem(
    LEGACY_KEY,
    JSON.stringify({
      date: '2026-09-23',
      chancesUsed: 2,
      cards: {
        c1: { state: 'claimed', chanceSpent: true, prize: { name: '大奖', win: true } },
        c2: { state: 'revealed', chanceSpent: true, prize: { name: '小奖', win: true } },
        c3: { state: 'idle', chanceSpent: false, prize: null },
        c4: { state: 'idle', chanceSpent: false, prize: null },
      },
    }),
  )
  const clock = createClock()
  const { a: lockA, b: lockB } = createSharedLocks()
  const campA = makeCampaign({ backend: a, locks: lockA, clock, seedGen: createSeedGen(1), legacyKey: LEGACY_KEY })
  const campB = makeCampaign({ backend: b, locks: lockB, clock, seedGen: createSeedGen(2), legacyKey: LEGACY_KEY })
  await Promise.all([campA.init(), campB.init()])

  for (const camp of [campA, campB]) {
    assert.equal(camp.getChancesLeft(), 1, '迁移后剩余 1 次，不重置')
    assert.equal(camp.getCard('c1').state, 'claimed')
    assert.equal(camp.getCard('c2').state, 'revealed', '已刮开未领取保留')
    assert.deepEqual(camp.getCard('c2').prize, { name: '小奖', win: true }, '奖品不重摇')
  }
  assert.equal(b.getItem(LEGACY_KEY), null, '旧 key 迁移后清除')
  assert.ok(b.getItem('scratch-campaign:v2:daily'))
  campA.destroy()
  campB.destroy()
})

test('时间回拨防御：改回昨天后次数不重置、状态保留并标记异常', async () => {
  const { a } = createSharedBackends()
  const { a: lockA } = createSharedLocks()
  const clock = createClock('2026-09-23T10:00:00')
  const campA = makeCampaign({ backend: a, locks: lockA, clock, seedGen: createSeedGen(1) })
  await campA.init()
  await campA.beginScratch('c1')
  assert.equal(campA.getChancesLeft(), 2)
  campA.destroy()

  // 模拟用户把系统日期改回昨天后重新打开页面
  clock.set('2026-09-22T09:00:00')
  const campB = makeCampaign({ backend: a, locks: lockA, clock, seedGen: createSeedGen(2) })
  await campB.init()
  assert.equal(campB.getChancesLeft(), 2, '次数延续，未被重置回 3')
  assert.equal(campB.snapshot.timeAnomaly, true, '提示区数据标记异常')
  assert.equal(campB.snapshot.date, '2026-09-23', '沿用已持久化的更晚日期')
  assert.equal(campB.getCard('c1').chanceSpent, true, '已刮状态保留')
  campB.destroy()
})

test('多活动隔离：daily 与 weekend 状态/次数/存储互不影响', async () => {
  const { a } = createSharedBackends()
  const { a: lockA } = createSharedLocks()
  const clock = createClock()
  const daily = makeCampaign({
    backend: a,
    locks: lockA,
    clock,
    id: 'daily',
    seedGen: createSeedGen(1),
    dailyChances: 3,
    cardIds: ['c1', 'c2', 'c3'],
  })
  const weekend = makeCampaign({
    backend: a,
    locks: lockA,
    clock,
    id: 'weekend',
    seedGen: createSeedGen(1),
    dailyChances: 5,
    cardIds: ['w1', 'w2', 'w3', 'w4'],
    prizes: [
      { name: 'iPhone 抽奖券', weight: 2, win: true },
      { name: '20 元红包', weight: 8, win: true },
      { name: '谢谢参与', weight: 90, win: false },
    ],
  })
  await Promise.all([daily.init(), weekend.init()])
  await daily.beginScratch('c1')
  await daily.beginScratch('c2')
  await weekend.beginScratch('w1')

  assert.equal(daily.getChancesLeft(), 1)
  assert.equal(weekend.getChancesLeft(), 4, '周末卡独立 5 次池')
  assert.equal(weekend.getCard('c1'), null, '看不到 daily 的卡')
  assert.equal(daily.getCard('w1'), null)
  assert.ok(a.getItem('scratch-campaign:v2:daily'))
  assert.ok(a.getItem('scratch-campaign:v2:weekend'))
  daily.destroy()
  weekend.destroy()
})

test('降级：localStorage 探测失败 / 配额超限 / 无锁无通道时仍可完成完整流转', async () => {
  // 1) 完全没有可用存储
  const memBackend = createKvBackend(() => {
    throw new Error('SecurityError: localStorage disabled')
  })
  assert.equal(memBackend.isPersistent, false)
  const clock = createClock()
  const camp = makeCampaign({
    backend: memBackend,
    locks: { supported: false, withLock: (_n, fn) => fn() },
    clock,
    seedGen: createSeedGen(1),
    channel: null,
  })
  await camp.init()
  const begin = await camp.beginScratch('c1')
  assert.equal(begin.ok, true)
  await camp.reveal('c1')
  const claim = await camp.claim('c1')
  assert.equal(claim.ok, true)
  assert.equal(camp.getCard('c1').state, 'claimed')
  camp.destroy()

  // 2) 运行中写盘抛 QuotaExceededError：自动切内存，不崩溃
  let failWrites = false
  const quotaStorage = {
    getItem: () => null,
    setItem() {
      if (failWrites) {
        const err = new Error('QuotaExceededError')
        err.name = 'QuotaExceededError'
        throw err
      }
    },
    removeItem() {},
  }
  const quotaBackend = createKvBackend(() => quotaStorage)
  assert.equal(quotaBackend.isPersistent, true)
  failWrites = true
  const camp2 = makeCampaign({
    backend: quotaBackend,
    locks: { supported: false, withLock: (_n, fn) => fn() },
    clock,
    seedGen: createSeedGen(1),
    channel: null,
  })
  await camp2.init()
  assert.equal((await camp2.beginScratch('c1')).ok, true, '配额失败后内存降级继续可用')
  assert.equal(quotaBackend.isPersistent, false)
  camp2.destroy()
})
