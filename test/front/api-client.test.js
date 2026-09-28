/**
 * API 客户端：Idempotency-Key 头、错误分类（网络 vs 协议）、白名单过滤。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient, ApiNetworkError, ApiProtocolError } from '../../src/api/client.js'

const SEED_HEX = 'a'.repeat(32)

function makeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

test('写动作带 Idempotency-Key 头与 JSON body', async () => {
  const seen = []
  const api = createApiClient({
    transport: (path, options) => {
      seen.push({ path, options })
      return makeResponse(200, {
        ok: true,
        card: { cardId: 'daily-1', campaignId: 'daily', status: 'pending', rev: 1, commitment: 'c'.repeat(64) },
        chancesLeft: 2,
        day: '2026-09-24',
        commitSig: 's',
      })
    },
  })
  const result = await api.begin('daily', 'daily-1', 'fixed-key')
  assert.equal(result.ok, true)
  assert.equal(seen[0].path, '/campaigns/daily/scratch/begin')
  assert.equal(seen[0].options.headers['idempotency-key'], 'fixed-key')
  assert.equal(result.idempotencyKey, 'fixed-key')
  assert.equal(JSON.parse(seen[0].options.body).cardId, 'daily-1')
})

test('getState：白名单过滤，未揭晓带 prize 的卡被剔除', async () => {
  const api = createApiClient({
    transport: () =>
      makeResponse(200, {
        serverTime: 't',
        day: '2026-09-24',
        campaigns: [
          {
            campaignId: 'daily',
            chancesLeft: 2,
            dailyChances: 3,
            cards: [
              { cardId: 'daily-1', campaignId: 'daily', status: 'pending', rev: 1, commitment: 'c'.repeat(64), prize: { name: 'X', win: true } },
              { cardId: 'daily-2', campaignId: 'daily', status: 'idle', rev: 0 },
            ],
          },
        ],
      }),
  })
  const view = await api.getState('daily')
  const cards = view.campaigns[0].cards
  assert.equal(cards.length, 1)
  assert.equal(cards[0].cardId, 'daily-2')
})

test('网络层失败 → ApiNetworkError（可同键重试）', async () => {
  const api = createApiClient({
    transport: () => Promise.reject(new TypeError('Failed to fetch')),
  })
  await assert.rejects(() => api.begin('daily', 'daily-1', 'k'), ApiNetworkError)
})

test('4xx 业务/协议错误 → ApiProtocolError 携带 error 码', async () => {
  const api = createApiClient({
    transport: () => makeResponse(401, { error: 'no-session', message: 'x' }),
  })
  await assert.rejects(
    () => api.recover(),
    (error) => error instanceof ApiProtocolError && error.error === 'no-session' && error.status === 401,
  )
})

test('begin 返回业务拒绝 ok:false：透传 reason，不抛异常', async () => {
  const api = createApiClient({
    transport: () =>
      makeResponse(200, {
        ok: false,
        reason: 'no-chances',
        chancesLeft: 0,
        day: '2026-09-24',
      }),
  })
  const result = await api.begin('daily', 'daily-1', 'k')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-chances')
  assert.equal(result.chancesLeft, 0)
})

test('reveal 成功响应携带 receipt.seedHex（结果第一次抵达客户端的唯一时机）', async () => {
  const api = createApiClient({
    transport: () =>
      makeResponse(200, {
        ok: true,
        card: {
          cardId: 'daily-1',
          campaignId: 'daily',
          status: 'revealed',
          rev: 2,
          prize: { name: '谢谢参与', win: false },
          receipt: {
            seedHex: SEED_HEX,
            commitment: 'b'.repeat(64),
            algorithm: 'mulberry32-sha256-commit-v1',
            weightsVersion: 'v1',
            serverTime: 't',
            signature: 'deadbeef',
          },
        },
      }),
  })
  const result = await api.reveal('daily', 'daily-1', 'k')
  assert.equal(result.card.receipt.seedHex, SEED_HEX)
  assert.equal(result.card.prize.name, '谢谢参与')
})
