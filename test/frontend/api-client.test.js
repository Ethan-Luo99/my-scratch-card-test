/**
 * API 客户端：
 * - 写接口带 Idempotency-Key、请求体 JSON；
 * - 卡响应经过白名单清洗（begin 响应夹带 prize 会被剥离为 null）；
 * - 网络错误 / 502 / abort 统一抛 NetworkError；4xx 抛 ApiError；
 * - 绝不本地补结果（客户端不做任何状态推导）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient, ApiError, NetworkError, newIdempotencyKey } from '../../src/api/client.js'

function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init })
    return handler(url, init)
  }
  return { fetchImpl, calls }
}

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

test('begin 请求路径与幂等头正确，pending 卡无 prize', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(200, {
      ok: true,
      card: { cardId: 'daily-1', campaignId: 'daily', status: 'pending', rev: 1, commitment: 'ab'.repeat(32) },
      chancesLeft: 2,
      day: '2026-09-27',
      serverTime: '2026-09-27T02:00:00.000Z',
      commitSig: 'cd'.repeat(32),
    }),
  )
  const api = createApiClient({ fetchImpl })
  const body = await api.begin('daily', 'daily-1', 'key-1')
  assert.equal(body.ok, true)
  assert.equal(body.card.status, 'pending')
  assert.equal(body.card.prize, undefined)
  assert.equal(calls[0].url, '/api/campaigns/daily/scratch/begin')
  assert.equal(calls[0].headers['idempotency-key'], 'key-1')
  assert.equal(JSON.parse(calls[0].body).cardId, 'daily-1')
})

test('纵深防御：begin 响应若夹带 prize/receipt，卡更新被丢弃（card=null）', async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse(200, {
      ok: true,
      card: {
        cardId: 'daily-1',
        status: 'pending',
        rev: 1,
        commitment: 'ab'.repeat(32),
        prize: { name: '88元 现金红包', win: true },
      },
    }),
  )
  const api = createApiClient({ fetchImpl })
  const body = await api.begin('daily', 'daily-1', 'key-1')
  assert.equal(body.card, null, '未揭晓夹带秘密必须被整卡丢弃')
})

test('state/recover 走白名单清洗', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(200, {
      day: '2026-09-27',
      campaigns: [
        {
          campaignId: 'daily',
          chancesLeft: 3,
          dailyChances: 3,
          cards: [{ cardId: 'daily-1', status: 'idle', rev: 0 }],
        },
      ],
    }),
  )
  const api = createApiClient({ fetchImpl })
  const view = await api.state('daily')
  assert.equal(view.campaigns[0].cards[0].status, 'idle')
  assert.match(calls[0].url, /state\?campaign=daily$/)
})

test('网络失败（fetch reject）抛 NetworkError', async () => {
  const api = createApiClient({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch')
    },
  })
  await assert.rejects(() => api.state(), NetworkError)
})

test('502/503/504 视为服务端不可达 -> NetworkError（进入只读锁定）', async () => {
  for (const status of [502, 503, 504]) {
    const api = createApiClient({ fetchImpl: async () => jsonResponse(status, { error: 'bad-gateway' }) })
    await assert.rejects(() => api.health(), NetworkError)
  }
})

test('4xx 抛 ApiError 且带 status/code', async () => {
  const api = createApiClient({ fetchImpl: async () => jsonResponse(401, { error: 'no-session' }) })
  await assert.rejects(
    () => api.state(),
    (error) => error instanceof ApiError && error.status === 401 && error.code === 'no-session',
  )
})

test('reveal/claim/migrate 路径与负载', async () => {
  const seen = []
  const api = createApiClient({
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body })
      return jsonResponse(200, { ok: true, card: { cardId: 'c1', status: 'claimed', rev: 3 } })
    },
  })
  // claimed 无 prize 会被清洗为 null，但仅用于路径断言
  await api.reveal('daily', 'daily-1', 'rk', 1)
  assert.match(seen[0].url, /scratch\/reveal$/)
  assert.equal(JSON.parse(seen[0].body).expectedRev, 1)
  assert.equal(seen[0].headers['idempotency-key'], 'rk')

  const api2 = createApiClient({
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body })
      return jsonResponse(200, { ok: true })
    },
  })
  await api2.migrateImport({ envelopes: [] }, 'hash123', 'mk')
  assert.match(seen[1].url, /migrate\/import$/)
  assert.equal(JSON.parse(seen[1].body).payloadHash, 'hash123')
  assert.equal(seen[1].headers['idempotency-key'], 'mk')
})

test('newIdempotencyKey 生成唯一令牌（去重令牌，无秘密含义）', () => {
  const keys = new Set(Array.from({ length: 100 }, () => newIdempotencyKey()))
  assert.equal(keys.size, 100)
})
