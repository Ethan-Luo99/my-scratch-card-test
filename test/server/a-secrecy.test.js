/**
 * 设计第 7 节 · A 类服务端断言（不提前抵达 / 秘密不泄露 / 日志不泄密）。
 * 对应验收项 1-4、8（5-7 为 B 类前端断言，本轮 src/ 不动，见 bundle 边界测试）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, internalCard } from './helpers.js'

const PRIZE_NAMES = ['88元 现金红包', '免费咖啡一杯', '8.8元 优惠券', '谢谢参与']

test('A1 begin 响应只含承诺，不含 seed/prize/receipt', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const key = h.idemKey()
  const response = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  const card = response.body.card
  assert.equal(card.status, 'pending')
  assert.ok(!('seed' in card))
  assert.ok(!('seedHex' in card))
  assert.ok(!('prize' in card))
  assert.ok(!('receipt' in card))
  assert.match(card.commitment, /^[0-9a-f]{64}$/)
  assert.match(bodyCommitSig(response), /^[0-9a-f]+$/)
})

function bodyCommitSig(response) {
  return response.body.commitSig
}

test('A2 原始 JSON 深度扫描：begin/state/recover 不含 seedHex 与任何奖品名', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const { sid } = parseSid(cookie)
  const record = internalCard(h.store, sid, 'daily', 'daily-1')
  assert.ok(record, '内部记录存在')

  for (const [method, path, body] of [
    ['GET', '/api/state?campaign=daily'],
    ['POST', '/api/recover', {}],
  ]) {
    const response = await h.request(method, path, { headers: { cookie }, body })
    const raw = response.rawText
    assert.ok(!raw.includes(record.seedHex), `${path} 泄露 seedHex`)
    for (const name of PRIZE_NAMES) assert.ok(!raw.includes(name), `${path} 泄露奖品名 ${name}`)
  }

  const beginAgain = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.ok(!beginAgain.rawText.includes(record.seedHex))
  for (const name of PRIZE_NAMES) assert.ok(!beginAgain.rawText.includes(name))
})

test('A3 state/recover 对 pending 卡仅暴露 commitment', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  for (const path of ['/api/state?campaign=daily', '/api/recover']) {
    const response = await h.request(path.startsWith('/api/state') ? 'GET' : 'POST', path, {
      headers: { cookie },
      body: {},
    })
    const campaign = response.body.campaigns.find((item) => item.campaignId === 'daily')
    const card = campaign.cards.find((item) => item.cardId === 'daily-2')
    assert.equal(card.status, 'pending')
    assert.ok(card.commitment)
    assert.equal(card.commitment, begin.body.card.commitment)
    assert.equal(card.prize, undefined)
    assert.equal(card.receipt, undefined)
    assert.equal(card.seedHex, undefined)
  }
})

test('A4 仅 reveal 响应首次包含 prize/receipt，且与内部记录一致', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const { sid } = parseSid(cookie)
  const before = internalCard(h.store, sid, 'daily', 'daily-1')

  const reveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(reveal.status, 200)
  assert.equal(reveal.body.ok, true)
  assert.equal(reveal.body.card.prize.name, before.prize.name)
  assert.equal(reveal.body.card.receipt.seedHex, before.seedHex)
  assert.equal(reveal.body.card.status, 'revealed')
  assert.match(reveal.body.card.receipt.seedHex, /^[0-9a-f]{32}$/)
})

test('A8 错误响应体与服务端日志均不含 seedHex/奖品名', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const { sid } = parseSid(cookie)
  const record = internalCard(h.store, sid, 'daily', 'daily-1')

  const badJson = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    raw: '{not json',
    headers: { cookie, 'idempotency-key': h.idemKey(), 'content-type': 'application/json' },
  })
  assert.equal(badJson.status, 400)
  const unknownCard = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'nope-card' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(unknownCard.status, 400)
  const idleReveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-3' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(idleReveal.body.ok, false)
  assert.equal(idleReveal.body.reason, 'invalid-state')

  for (const response of [badJson, unknownCard, idleReveal]) {
    assert.ok(!response.rawText.includes(record.seedHex), '错误体泄露 seedHex')
    for (const name of PRIZE_NAMES) {
      assert.ok(!response.rawText.includes(name), `错误体泄露奖品名 ${name}`)
    }
  }
  const logText = JSON.stringify(h.logs)
  assert.ok(!logText.includes(record.seedHex), '日志泄露 seedHex')
  for (const name of PRIZE_NAMES) assert.ok(!logText.includes(name), '日志泄露奖品名')
})

test('A8b 无会话访问受保护接口返回 401 no-session', async () => {
  const h = makeHarness()
  after(() => h.close())
  const response = await h.request('GET', '/api/state')
  assert.equal(response.status, 401)
  assert.equal(response.body.error, 'no-session')
})

function parseSid(cookie) {
  return { sid: /sid=([^;]+)/.exec(cookie)[1] }
}
