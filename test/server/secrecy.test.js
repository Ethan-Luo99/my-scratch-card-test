/**
 * 验收 A 类：不提前抵达（核心安全目标）。
 * 对应设计文档第 7 节条目 1/2/3/4/8。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, serverCard, prizeNames } from './helpers.js'

test('A1: begin 响应不含 seed/seedHex/prize/receipt，仅含 64 位 hex 承诺', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const res = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'a1', body: { cardId: 'daily-1' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  const card = res.json.card
  assert.ok(!('seed' in card) && !('seedHex' in card))
  assert.ok(!('prize' in card) && !('receipt' in card))
  assert.match(card.commitment, /^[0-9a-f]{64}$/)
  assert.equal(typeof res.json.commitSig, 'string')
  await h.close()
})

test('A2: pending 状态下 begin/state/recover 原始响应深度扫描无 seed 与奖品名', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const begin = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'a2', body: { cardId: 'daily-1' },
  })
  const record = serverCard(h.store, sid, 'daily', 'daily-1')
  const names = prizeNames('daily')
  const raws = [
    begin.raw,
    (await h.api('GET', '/api/state?campaign=daily', { sid })).raw,
    (await h.api('GET', '/api/state', { sid })).raw,
    (await h.api('POST', '/api/recover', { sid, body: {} })).raw,
  ]
  for (const raw of raws) {
    assert.ok(!raw.includes(record.seedHex), '响应不得包含真实 seedHex')
    for (const name of names) {
      assert.ok(!raw.includes(name), `pending 状态响应不得包含奖品名 ${name}`)
    }
  }
  await h.close()
})

test('A3: GET /state 与 /api/recover 对 pending 卡只暴露 commitment', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'a3', body: { cardId: 'daily-2' },
  })
  for (const res of [
    await h.api('GET', '/api/state?campaign=daily', { sid }),
    await h.api('POST', '/api/recover', { sid, body: {} }),
  ]) {
    const cards = res.json.campaigns.find((c) => c.campaignId === 'daily').cards
    assert.equal(cards.length, 1)
    const card = cards[0]
    assert.equal(card.status, 'pending')
    assert.match(card.commitment, /^[0-9a-f]{64}$/)
    assert.ok(!card.prize && !card.receipt && !card.seedHex && !card.seed)
  }
  await h.close()
})

test('A4: reveal 是结果第一次抵达客户端；prize/seedHex 与服务端记录一致', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'a4', body: { cardId: 'daily-1' },
  })
  const before = await h.api('GET', '/api/state?campaign=daily', { sid })
  assert.ok(!before.raw.includes('prize'))

  const reveal = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'a4r', body: { cardId: 'daily-1' },
  })
  assert.equal(reveal.json.ok, true)
  const record = serverCard(h.store, sid, 'daily', 'daily-1')
  assert.equal(reveal.json.card.prize.name, record.prize.name)
  assert.equal(reveal.json.card.prize.win, record.prize.win)
  assert.equal(reveal.json.card.receipt.seedHex, record.seedHex)
  assert.equal(reveal.json.card.receipt.commitment, record.commitment)
  await h.close()
})

test('A8: 各类错误响应体不含 seedHex/奖品名；运行日志事件不记秘密', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'a8', body: { cardId: 'daily-1' },
  })
  const record = serverCard(h.store, sid, 'daily', 'daily-1')
  const names = prizeNames('daily')

  const errors = [
    await h.api('POST', '/api/campaigns/daily/scratch/begin', { sid, rawBody: '{bad json' }),
    await h.api('POST', '/api/campaigns/daily/scratch/begin', {
      sid, idemKey: 'a8b', body: { cardId: 'no-such-card' },
    }),
    await h.api('POST', '/api/campaigns/ghost/scratch/begin', {
      sid, idemKey: 'a8c', body: { cardId: 'daily-1' },
    }),
    await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
      sid, idemKey: 'a8d', body: { cardId: 'daily-2' },
    }),
    await h.api('GET', '/api/state', {}), // 无会话
  ]
  for (const res of errors) {
    assert.ok(res.status === 200 || (res.status >= 400 && res.status < 600))
    assert.ok(!res.raw.includes(record.seedHex), `错误体不得泄密: ${res.raw}`)
    for (const name of names) assert.ok(!res.raw.includes(name))
  }
  // 运行日志（异常/自检/会话类事件）只记 cardId/status/rev，不记秘密
  const logEvents = h.store.state.events.filter((e) =>
    ['clock-anomaly', 'self-check-failure', 'session-created'].includes(e.type),
  )
  for (const event of logEvents) {
    const text = JSON.stringify(event)
    assert.ok(!text.includes(record.seedHex))
    for (const name of names) assert.ok(!text.includes(name))
  }
  await h.close()
})

test('A-附属: 无会话访问受保护接口返回 401 no-session；Cookie 为 HttpOnly', async () => {
  const h = createHarness()
  const noSid = await h.api('GET', '/api/state', {})
  assert.equal(noSid.status, 401)
  assert.equal(noSid.json.reason, 'no-session')
  const beginNoSid = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    idemKey: 'x', body: { cardId: 'daily-1' },
  })
  assert.equal(beginNoSid.status, 401)
  const { cookie } = await h.newSession()
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\//)
  await h.close()
})
