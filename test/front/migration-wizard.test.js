/**
 * 设计 5.2，验收 E26/E27/E28（前端侧）：
 * - 检测旧数据 → 整包 import（Idempotency-Key = migrate:<sha256(payload)>）；
 * - 成功后删除旧 key；失败保留可重试，重试仍用同一键（服务端去重）；
 * - 客户端只搬运，不据此开奖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMigrationWizard } from '../../src/app/migration.js'
import { CACHE_PREFIX, LEGACY_V1_KEY, LEGACY_V2_PREFIX } from '../../src/client/cache.js'

function storageWithLegacy() {
  const map = new Map()
  map.set(
    LEGACY_V1_KEY,
    JSON.stringify({ date: '2026-09-22', chancesUsed: 1, cards: {} }),
  )
  map.set(
    `${LEGACY_V2_PREFIX}daily`,
    JSON.stringify({
      version: 2,
      rev: 3,
      state: {
        date: '2026-09-23',
        lastDate: '2026-09-23',
        timeAnomaly: false,
        chancesUsed: 1,
        cards: {
          'daily-1': { state: 'revealed', chanceSpent: true, prize: { name: '免费咖啡一杯', win: true }, seed: 9, seedHash: '09' },
        },
      },
    }),
  )
  map.set(`${CACHE_PREFIX}prefs`, '{}')
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size
    },
  }
}

function fakeCache(storage) {
  return {
    storage,
    scanLegacy() {
      const found = []
      for (const key of Array.from(storage.map.keys())) {
        if (key === LEGACY_V1_KEY) {
          found.push({ key, campaignId: 'daily', envelope: JSON.parse(storage.getItem(key)) })
        } else if (key.startsWith(LEGACY_V2_PREFIX)) {
          found.push({ key, campaignId: key.slice(LEGACY_V2_PREFIX.length), envelope: JSON.parse(storage.getItem(key)) })
        }
      }
      return found
    },
    removeLegacyKey(key) {
      storage.removeItem(key)
    },
  }
}

test('无旧数据：直接成功，不发请求', async () => {
  const requests = []
  const storage = { map: new Map(), getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }
  const api = { migrateImport: async (args) => requests.push(args) }
  const wizard = createMigrationWizard({ api, cache: fakeCache(storage) })
  const result = await wizard.run()
  assert.equal(result.ok, true)
  assert.equal(requests.length, 0)
})

test('成功迁移：整包 POST，幂等键=migrate:<sha256(payload)>，旧 key 全部删除', async () => {
  const storage = storageWithLegacy()
  const requests = []
  const api = {
    migrateImport: async (args) => {
      requests.push(args)
      return { ok: true, imported: { claimed: ['c'], revealed: ['r'] }, discarded: {} }
    },
  }
  const wizard = createMigrationWizard({ api, cache: fakeCache(storage) })
  const result = await wizard.run()
  assert.equal(result.ok, true)
  assert.equal(result.removed, 2)
  assert.equal(requests.length, 1)
  const expectedHash = createHash('sha256').update(JSON.stringify(requests[0].payload)).digest('hex')
  assert.equal(requests[0].key, `migrate:${expectedHash}`)
  assert.equal(requests[0].payloadHash, expectedHash)
  assert.equal(storage.getItem(LEGACY_V1_KEY), null)
  assert.equal(storage.getItem(`${LEGACY_V2_PREFIX}daily`), null)
  // 非旧数据 key 保留
  assert.equal(storage.getItem(`${CACHE_PREFIX}prefs`), '{}')
})

test('E28 网络失败：旧 key 保留、可重试；重试复用同一幂等键', async () => {
  const storage = storageWithLegacy()
  const requests = []
  let shouldFail = true
  const api = {
    migrateImport: async (args) => {
      requests.push(args)
      if (shouldFail) throw new Error('network')
      return { ok: true, imported: { claimed: [], revealed: [] }, discarded: {} }
    },
  }
  const wizard = createMigrationWizard({ api, cache: fakeCache(storage) })
  const first = await wizard.run()
  assert.equal(first.ok, false)
  assert.ok(storage.getItem(LEGACY_V1_KEY), '失败时旧 v1 key 必须保留')
  assert.ok(storage.getItem(`${LEGACY_V2_PREFIX}daily`), '失败时旧 v2 key 必须保留')

  shouldFail = false
  const second = await wizard.run()
  assert.equal(second.ok, true)
  assert.equal(requests[0].key, requests[1].key, '重试必须复用同一迁移幂等键')
  assert.equal(storage.getItem(LEGACY_V1_KEY), null)
})

test('并发调用单飞：同一 Promise，不重复提交', async () => {
  const storage = storageWithLegacy()
  let resolveImport
  const api = {
    migrateImport: () =>
      new Promise((resolve) => {
        resolveImport = resolve
      }),
  }
  const wizard = createMigrationWizard({ api, cache: fakeCache(storage) })
  const p1 = wizard.run()
  const p2 = wizard.run()
  assert.equal(p1, p2)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(typeof resolveImport, 'function')
  resolveImport({ ok: true, imported: { claimed: [], revealed: [] }, discarded: {} })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
})
