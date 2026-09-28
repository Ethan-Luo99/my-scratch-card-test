/**
 * 设计 4.3，验收 B5/B28：localStorage 白名单。
 * - begin(pending) 后全量扫描任何值都不含 seedHex/奖品名；
 * - 只有 revealed/claimed 公开视图落盘；
 * - 旧 v1/v2 key 扫描/删除；存储禁用退化为内存（仍不落未揭晓秘密）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientCache, CACHE_PREFIX, LEGACY_V1_KEY, LEGACY_V2_PREFIX } from '../../src/client/cache.js'

const SEED_HEX = 'a'.repeat(32)
const COMMITMENT = 'b'.repeat(64)
const PRIZE_NAMES = ['88元 现金红包', '免费咖啡一杯', '8.8元 优惠券', '谢谢参与', 'iPhone 抽奖券', '20 元红包']

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
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

function pendingCard() {
  return {
    cardId: 'daily-1',
    campaignId: 'daily',
    status: 'pending',
    rev: 1,
    commitment: COMMITMENT,
    expiresAt: '2026-09-24T02:15:00.000Z',
  }
}

test('B5 begin 后全量 localStorage 扫描不含 seedHex 与任何奖品名', () => {
  const storage = memoryStorage()
  const cache = createClientCache({ storageFactory: () => storage })

  cache.saveCommitment('daily', 'daily-1', {
    commitment: COMMITMENT,
    commitSig: 'sig',
    weightsVersion: 'v1',
    day: '2026-09-24',
    rev: 1,
  })
  // pending 视图绝不落盘
  cache.saveCardView(pendingCard())

  const values = cache.snapshotAllValues()
  assert.ok(values.length >= 1, '承诺存档应已写入')
  const blob = values.join('\n')
  assert.ok(!blob.includes(SEED_HEX), '任何缓存值都不得含 seedHex')
  for (const name of PRIZE_NAMES) assert.ok(!blob.includes(name), `缓存泄漏奖品名：${name}`)
})

test('纵深防御：即便 saveCardView 被传入带 prize 的 pending 卡也拒绝落盘', () => {
  const storage = memoryStorage()
  const cache = createClientCache({ storageFactory: () => storage })
  cache.saveCardView({ ...pendingCard(), prize: { name: '88元 现金红包', win: true }, receipt: { seedHex: SEED_HEX } })
  const blob = Array.from(storage.dump().values()).join('\n')
  assert.ok(!blob.includes(SEED_HEX))
  assert.ok(!blob.includes('88元 现金红包'))
})

test('revealed/claimed 公开视图可缓存（离线只读），claimed 不回退', () => {
  const storage = memoryStorage()
  const cache = createClientCache({ storageFactory: () => storage })
  const revealed = {
    cardId: 'daily-1',
    campaignId: 'daily',
    status: 'revealed',
    rev: 2,
    prize: { name: '免费咖啡一杯', win: true },
    receipt: { seedHex: SEED_HEX, commitment: COMMITMENT, signature: 's', algorithm: 'a', weightsVersion: 'v1', serverTime: 't' },
  }
  cache.saveCardView(revealed)
  const loaded = cache.loadViews('daily')['daily-1']
  assert.equal(loaded.prize.name, '免费咖啡一杯')
  assert.equal(loaded.receipt.seedHex, SEED_HEX)

  // 更旧的 rev 不得覆盖较新视图
  cache.saveCardView({ ...revealed, rev: 1 })
  assert.equal(cache.loadViews('daily')['daily-1'].rev, 2)

  cache.saveCardView({ ...revealed, status: 'claimed', rev: 3, claimRef: 'claim_1' })
  assert.equal(cache.loadViews('daily')['daily-1'].status, 'claimed')
})

test('幂等键稳定复用（重试同键），按日区分', () => {
  const cache = createClientCache({ storageFactory: () => memoryStorage() })
  const first = cache.getIdempotencyKey('begin', 'daily', 'daily-1', '2026-09-24')
  assert.equal(cache.getIdempotencyKey('begin', 'daily', 'daily-1', '2026-09-24'), first)
  const nextDay = cache.getIdempotencyKey('begin', 'daily', 'daily-1', '2026-09-25')
  assert.notEqual(nextDay, first)
})

test('B28 旧 v1/v2 key 扫描与删除', () => {
  const v2 = {
    version: 2,
    rev: 1,
    state: {
      date: '2026-09-23',
      lastDate: '2026-09-23',
      timeAnomaly: false,
      chancesUsed: 1,
      cards: {
        'daily-1': { state: 'revealed', chanceSpent: true, prize: { name: '88元 现金红包', win: true }, seed: 1, seedHash: 'ab' },
      },
    },
  }
  const v1 = { date: '2026-09-22', chancesUsed: 1, cards: { 'daily-1': { state: 'claimed', chanceSpent: true, prize: { name: '谢谢参与', win: false } } } }
  const storage = memoryStorage({
    [LEGACY_V1_KEY]: JSON.stringify(v1),
    [`${LEGACY_V2_PREFIX}daily`]: JSON.stringify(v2),
    [`${CACHE_PREFIX}prefs`]: JSON.stringify({}),
  })
  const cache = createClientCache({ storageFactory: () => storage })
  const found = cache.scanLegacy()
  assert.equal(found.length, 2)
  const campaigns = found.map((item) => item.campaignId).sort()
  assert.deepEqual(campaigns, ['daily', 'daily'])

  cache.removeLegacyKey(LEGACY_V1_KEY)
  cache.removeLegacyKey(`${LEGACY_V2_PREFIX}daily`)
  assert.equal(storage.getItem(LEGACY_V1_KEY), null)
  assert.equal(storage.getItem(`${LEGACY_V2_PREFIX}daily`), null)
})

test('localStorage 不可用：退化为内存，已揭晓缓存只在本会话可见，仍拒绝 pending 落盘', () => {
  const cache = createClientCache({ storageFactory: () => null })
  assert.equal(cache.isPersistent, false)
  cache.saveCardView({
    cardId: 'daily-1',
    campaignId: 'daily',
    status: 'pending',
    rev: 1,
    commitment: COMMITMENT,
  })
  assert.deepEqual(cache.loadViews('daily'), {})
  assert.equal(typeof cache.getIdempotencyKey('reveal', 'daily', 'daily-1', 'd'), 'string')
})

test('损坏 JSON / 非法承诺：读取时容错跳过', () => {
  const storage = memoryStorage({
    [`${CACHE_PREFIX}commitments:daily`]: '{bad json',
  })
  const cache = createClientCache({ storageFactory: () => storage })
  assert.deepEqual(cache.loadCommitments('daily'), {})
})
