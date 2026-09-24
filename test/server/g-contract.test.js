/**
 * API 契约细节：session cookie、错误码、expectedRev 乐观并发、
 * verification-key / healthz 形态（设计 1.1 / 1.3 / 1.7）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness } from './helpers.js'

test('session：Set-Cookie 属性 + 只含展示元数据', async () => {
  const h = makeHarness()
  after(() => h.close())
  const response = await h.request('POST', '/api/session', { body: {} })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')
  assert.match(cookie, /sid=[0-9a-f]{32}/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\//)
  assert.equal(response.body.day, '2026-09-24')
  assert.match(response.body.serverTime, /^\d{4}-\d{2}-\d{2}T/)
  const daily = response.body.campaigns.find((c) => c.campaignId === 'daily')
  assert.deepEqual(daily.cardIds, ['daily-1', 'daily-2', 'daily-3'])
  assert.equal(daily.dailyChances, 3)
  assert.ok(!('prize' in response.body) && !('seed' in response.body))
})

test('verification-key / healthz 无需会话', async () => {
  const h = makeHarness()
  after(() => h.close())
  const key = await h.request('GET', '/api/verification-key')
  assert.equal(key.status, 200)
  assert.equal(key.body.alg, 'Ed25519')
  const health = await h.request('GET', '/api/healthz')
  assert.equal(health.body.ok, true)
})

test('unknown-campaign / 未知路由 / 错误方法', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const unknown = await h.request('POST', '/api/campaigns/nope/scratch/begin', {
    body: { cardId: 'x' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error, 'unknown-campaign')

  const notFound = await h.request('GET', '/api/whatever', { headers: { cookie } })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.body.error, 'not-found')

  const badMethod = await h.request('DELETE', '/api/session', { headers: { cookie } })
  assert.equal(badMethod.status, 404)
})

test('expectedRev 乐观并发：不匹配返回 conflict 与最新公开视图', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const conflict = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1', expectedRev: 99 },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(conflict.body.ok, false)
  assert.equal(conflict.body.reason, 'conflict')
  assert.equal(conflict.body.card.status, 'pending')
  assert.equal(conflict.body.card.rev, 1)
  assert.equal(conflict.body.card.prize, undefined, 'conflict 视图仍不得泄露结果')

  const ok = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1', expectedRev: 1 },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.card.rev, 2)
})

test('recover 需要会话；无会话 401', async () => {
  const h = makeHarness()
  after(() => h.close())
  const response = await h.request('POST', '/api/recover', { body: {} })
  assert.equal(response.status, 401)
  assert.equal(response.body.error, 'no-session')
})

test('state 包含 idle 占位卡（无记录卡位以 idle 呈现）', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const state = await h.request('GET', '/api/state?campaign=daily', { headers: { cookie } })
  const cards = state.body.campaigns[0].cards
  assert.equal(cards.length, 3)
  assert.ok(cards.every((card) => card.status === 'idle' && card.rev === 0))
})

test('migrate 同键不同 payload（无 payloadHash）返回 409 conflict', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const key = h.idemKey()
  const first = await h.request('POST', '/api/migrate/import', {
    body: { payload: { campaignId: 'daily', envelope: { version: 2, rev: 1, state: { cards: {} } } } },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(first.body.ok, true)
  const conflict = await h.request('POST', '/api/migrate/import', {
    body: { payload: { campaignId: 'daily', envelope: { version: 2, rev: 2, state: { cards: { 'daily-1': { state: 'claimed', chanceSpent: true, prize: { name: 'x', win: true } } } } } } },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error, 'conflict')
})
