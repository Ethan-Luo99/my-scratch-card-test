/**
 * localStorage 白名单（验收 E24 + A5）：
 * - 承诺可存（不可推出结果）；
 * - 已揭晓/已领取视图可缓存（含 prize/receipt）；
 * - pending/idle 卡严禁落盘（连键值都不能写）；
 * - 全量扫描：任何缓存值都不含未揭晓卡的 seedHex/奖品名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryBackend, dumpStorage } from './helpers.js'
import { createCacheStore, CACHE_KEYS } from '../../src/storage/cache.js'
import { getPublicWeights } from '../../src/lib/public-weights.js'

const ALL_PRIZE_NAMES = Object.values(getPublicWeights('daily', 'v1'))
  .map((p) => p.name)
  .concat(Object.values(getPublicWeights('weekend', 'v1')).map((p) => p.name))

test('承诺存档：可写入/读取，且值中无 seedHex/奖品名', () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  cache.saveCommitment('daily', {
    cardId: 'daily-1',
    commitment: 'ab'.repeat(32),
    commitSig: 'cd'.repeat(32),
    weightsVersion: 'v1',
    day: '2026-09-27',
    rev: 1,
  })
  const stored = cache.loadCommitments()['daily-1']
  assert.equal(stored.commitment, 'ab'.repeat(32))
  const dumped = dumpStorage(backend)
  for (const name of ALL_PRIZE_NAMES) {
    assert.ok(!dumped.includes(name), `承诺缓存不得包含奖品名 ${name}`)
  }
  assert.ok(!dumped.includes('seedHex'))
})

test('非法承诺（无 commitment）不写', () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  cache.saveCommitment('daily', { cardId: 'daily-1' })
  assert.deepEqual(cache.loadCommitments(), {})
  assert.equal(backend.getItem(CACHE_KEYS.commitments), null)
})

test('已揭晓/已领取卡可缓存；pending/idle 一律拒绝落盘', () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  cache.saveRevealedCard('daily', {
    cardId: 'daily-1',
    status: 'revealed',
    rev: 2,
    prize: { name: '免费咖啡一杯', win: true },
    receipt: {
      seedHex: '11'.repeat(16),
      algorithm: 'mulberry32-sha256-commit-v1',
      weightsVersion: 'v1',
      commitment: 'ab'.repeat(32),
      serverTime: '2026-09-27T03:00:00.000Z',
      signature: 'cd'.repeat(32),
    },
  })
  assert.ok(cache.loadRevealedCards()['daily-1'])

  cache.saveRevealedCard('daily', {
    cardId: 'daily-2',
    status: 'pending',
    rev: 1,
    commitment: 'ab'.repeat(32),
    prize: { name: '88元 现金红包', win: true },
  })
  assert.equal(cache.loadRevealedCards()['daily-2'], undefined)

  cache.saveRevealedCard('daily', { cardId: 'daily-3', status: 'idle', rev: 0 })
  assert.equal(cache.loadRevealedCards()['daily-3'], undefined)

  const dumped = dumpStorage(backend)
  assert.ok(dumped.includes('免费咖啡一杯'), '已揭晓奖品允许缓存')
  assert.ok(!dumped.includes('88元 现金红包'), '未揭晓卡奖品严禁落盘')
})

test('损坏的缓存 JSON 安全回退为空，不抛错', () => {
  const { backend } = createMemoryBackend()
  backend.setItem(CACHE_KEYS.commitments, '{not json')
  backend.setItem(CACHE_KEYS.revealed, 'null')
  const cache = createCacheStore(backend)
  assert.deepEqual(cache.loadCommitments(), {})
  assert.deepEqual(cache.loadRevealedCards(), {})
})

test('prune：按保留卡集清理过期缓存', () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  cache.saveRevealedCard('daily', {
    cardId: 'daily-1',
    status: 'claimed',
    rev: 3,
    prize: { name: '谢谢参与', win: false },
    receipt: { seedHex: '22'.repeat(16), signature: 'cd'.repeat(32) },
  })
  cache.pruneRevealedCards(['daily-2'])
  assert.deepEqual(Object.keys(cache.loadRevealedCards()), [])
})

test('验证公钥缓存：字段校验', () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  assert.equal(cache.loadVerificationKey(), null)
  cache.saveVerificationKey({ alg: 'Ed25519', publicKeyHex: 'aa' })
  assert.equal(cache.loadVerificationKey().publicKeyHex, 'aa')
  cache.saveVerificationKey({ alg: 'Ed25519' })
  assert.equal(cache.loadVerificationKey().publicKeyHex, 'aa', '非法写入不覆盖已有公钥')
})

test('偏好存取', () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  cache.savePrefs({ theme: 'dark' })
  assert.equal(cache.loadPrefs().theme, 'dark')
})

test('按活动对账：服务端跨天视图替换旧缓存；其他活动不受影响', () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  const receipt = { seedHex: '11'.repeat(16), signature: 'cd'.repeat(32) }
  // daily-1 昨天 revealed（缓存），weekend-1 也缓存
  cache.replaceRevealedForCampaign('daily', [
    { cardId: 'daily-1', status: 'claimed', rev: 3, prize: { name: '谢谢参与', win: false }, receipt },
  ])
  cache.replaceRevealedForCampaign('weekend', [
    { cardId: 'weekend-1', status: 'revealed', rev: 2, prize: { name: '20 元红包', win: true }, receipt },
  ])
  // 次日 daily 全部回到 idle（对账数组为空）：daily-1 缓存清除
  cache.replaceRevealedForCampaign('daily', [])
  assert.equal(cache.loadRevealedCards()['daily-1'], undefined, '跨天后旧卡缓存被清除')
  assert.ok(cache.loadRevealedCards()['weekend-1'], '周末活动缓存不受影响')

  // 新一天 daily-1 再次 revealed：新缓存写入
  cache.replaceRevealedForCampaign('daily', [
    { cardId: 'daily-1', status: 'revealed', rev: 2, prize: { name: '免费咖啡一杯', win: true }, receipt },
  ])
  assert.equal(cache.loadRevealedCards()['daily-1'].prize.name, '免费咖啡一杯')
})

test('承诺对账：只保留服务端当前 pending 卡承诺', () => {
  const { backend } = createMemoryBackend()
  const cache = createCacheStore(backend)
  cache.replaceCommitmentsForCampaign('daily', [
    { cardId: 'daily-1', commitment: 'aa'.repeat(32), rev: 1, day: '2026-09-27' },
  ])
  cache.replaceCommitmentsForCampaign('daily', [
    { cardId: 'daily-2', commitment: 'bb'.repeat(32), rev: 1, day: '2026-09-27' },
  ])
  const stored = cache.loadCommitments()
  assert.equal(stored['daily-1'], undefined)
  assert.equal(stored['daily-2'].commitment, 'bb'.repeat(32))
})
