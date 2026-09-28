/**
 * 迁移向导（验收 E26/E27/E28 + 设计 5.2）：
 * - 检测旧 v1/v2 key；成功导入后删除旧 key；失败保留旧 key；
 * - 同一 payload 幂等键稳定（防重复导入）；
 * - 多标签页经共享锁串行：只导入一次；
 * - 客户端只搬运旧信封，不据其开奖（本测试不引用任何本地 draw）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectLegacyKeys,
  readLegacyPayload,
  runMigration,
  LEGACY_V1_KEY,
} from '../../src/lib/legacy.js'
import { createMemoryBackend, createSharedLocks } from './helpers.js'

const V2_KEY = 'scratch-campaign:v2:daily'

function seedLegacy(backend) {
  backend.setItem(
    LEGACY_V1_KEY,
    JSON.stringify({
      date: '2026-09-20',
      chancesUsed: 1,
      cards: {
        'daily-1': { state: 'claimed', chanceSpent: true, prize: { name: '88元 现金红包', win: true } },
      },
    }),
  )
  backend.setItem(
    V2_KEY,
    JSON.stringify({
      version: 2,
      rev: 3,
      state: {
        date: '2026-09-21',
        lastDate: '2026-09-21',
        timeAnomaly: false,
        chancesUsed: 1,
        cards: {
          'daily-2': {
            state: 'revealed',
            chanceSpent: true,
            prize: { name: '免费咖啡一杯', win: true },
            seed: 12345,
            seedHash: 'abcdef12',
          },
        },
      },
    }),
  )
}

test('检测旧 v1/v2 key；v3 白名单 key 不视为旧数据', () => {
  const { backend } = createMemoryBackend()
  seedLegacy(backend)
  backend.setItem('scratch-card:v3:prefs', '{}')
  const keys = detectLegacyKeys(backend)
  assert.ok(keys.includes(LEGACY_V1_KEY))
  assert.ok(keys.includes(V2_KEY))
  assert.equal(keys.some((k) => k.startsWith('scratch-card:v3:')), false)
})

test('readLegacyPayload：v1 归到 daily，v2 按命名空间取 campaignId', () => {
  const { backend } = createMemoryBackend()
  seedLegacy(backend)
  const legacy = readLegacyPayload(backend, detectLegacyKeys(backend))
  assert.equal(legacy.payload.envelopes.length, 2)
  const v1 = legacy.payload.envelopes.find((e) => e.campaignId === 'daily' && e.envelope.chancesUsed === 1 && !('version' in e.envelope))
  assert.ok(v1)
  const v2 = legacy.payload.envelopes.find((e) => e.envelope.version === 2)
  assert.equal(v2.campaignId, 'daily')
})

test('成功导入：服务端 ok 后旧 key 被删除（验收 E28）', async () => {
  const { backend } = createMemoryBackend()
  const locks = createSharedLocks().a
  seedLegacy(backend)
  const seenKeys = []
  const outcome = await runMigration({
    backend,
    locks,
    importFn: async (_payload, payloadHash, idemKey) => {
      seenKeys.push({ payloadHash, idemKey })
      return { ok: true, imported: { claimed: [], revealed: [] }, discarded: {} }
    },
  })
  assert.equal(outcome.migrated, true)
  assert.equal(backend.getItem(LEGACY_V1_KEY), null)
  assert.equal(backend.getItem(V2_KEY), null)
  assert.ok(seenKeys[0].idemKey.startsWith('migrate:'), '幂等键应为内容哈希')
  assert.ok(seenKeys[0].payloadHash, 'payloadHash 非空')
})

test('导入失败（网络/拒绝）：旧 key 保留、migrated=false，可重试（验收 E28）', async () => {
  const { backend } = createMemoryBackend()
  const locks = createSharedLocks().a
  seedLegacy(backend)
  const outcome = await runMigration({
    backend,
    locks,
    importFn: async () => {
      throw new Error('network down')
    },
  })
  assert.equal(outcome.migrated, false)
  assert.equal(outcome.reason, 'import-failed')
  assert.ok(backend.getItem(LEGACY_V1_KEY), '失败时 v1 key 必须保留')
  assert.ok(backend.getItem(V2_KEY), '失败时 v2 key 必须保留')

  // 恢复后重试同一 payload：幂等键保持稳定
  const keys = []
  const retry = await runMigration({
    backend,
    locks,
    importFn: async (_p, _h, idemKey) => {
      keys.push(idemKey)
      return { ok: true, imported: { claimed: [], revealed: [] }, discarded: {} }
    },
  })
  assert.equal(retry.migrated, true)
  assert.ok(keys[0].startsWith('migrate:'))
  assert.equal(backend.getItem(LEGACY_V1_KEY), null)
})

test('多标签页并发：共享锁串行，先到者导入并删 key，后到者空跑（只生效一次）', async () => {
  const { backend } = createMemoryBackend()
  const { a: locksA, b: locksB } = createSharedLocks()
  seedLegacy(backend)
  let importCalls = 0
  const importFn = async () => {
    importCalls += 1
    return { ok: true, imported: { claimed: [], revealed: [] }, discarded: {} }
  }
  const [ra, rb] = await Promise.all([
    runMigration({ backend, locks: locksA, importFn }),
    runMigration({ backend, locks: locksB, importFn }),
  ])
  const migratedCount = [ra, rb].filter((r) => r.migrated).length
  assert.equal(migratedCount, 1, '只有一个标签页真正导入')
  assert.equal(importCalls, 1, 'import 只调用一次')
  assert.equal(backend.getItem(LEGACY_V1_KEY), null)
})

test('损坏的旧 key（不可解析）：直接清理，不发送迁移请求', async () => {
  const { backend } = createMemoryBackend()
  const locks = createSharedLocks().a
  backend.setItem(LEGACY_V1_KEY, '{broken json')
  let called = 0
  const outcome = await runMigration({
    backend,
    locks,
    importFn: async () => {
      called += 1
      return { ok: true }
    },
  })
  assert.equal(called, 0)
  assert.equal(outcome.migrated, false)
  assert.equal(backend.getItem(LEGACY_V1_KEY), null)
})
