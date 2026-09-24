/**
 * 设计第 7 节 · D 类（承诺—揭晓与签名），验收项 19-23。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeHarness, internalCard } from './helpers.js'
import {
  computeCommitment,
  canonicalJSON,
} from '../../server/core/rng.js'
import { createDefaultConfig } from '../../server/core/config.js'

async function beginReveal(h, cookie, cardId) {
  const begin = await h.request('POST', `/api/campaigns/daily/scratch/begin`, {
    body: { cardId },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const reveal = await h.request('POST', `/api/campaigns/daily/scratch/begin`, {
    body: { cardId },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  void reveal
  const revealed = await h.request('POST', `/api/campaigns/daily/scratch/reveal`, {
    body: { cardId },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  return { begin, revealed }
}

test('D19 用 seedHex 重算 SHA-256 等于 begin 承诺；篡改上下文则不等', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const { begin, revealed } = await beginReveal(h, cookie, 'daily-1')
  const { seedHex, weightsVersion, commitment } = revealed.body.card.receipt
  assert.equal(weightsVersion, internalCard(h.store, /sid=([^;]+)/.exec(cookie)[1], 'daily', 'daily-1').weightsVersion)
  assert.equal(computeCommitment(seedHex, 'daily', 'daily-1', weightsVersion), begin.body.card.commitment)
  assert.equal(commitment, begin.body.card.commitment)

  assert.notEqual(computeCommitment(seedHex, 'daily', 'daily-2', weightsVersion), commitment)
  assert.notEqual(computeCommitment(seedHex, 'daily', 'daily-1', 'v999'), commitment)
  assert.notEqual(
    createHash('sha256').update(seedHex).digest('hex'),
    commitment,
    '承诺必须绑定上下文，而非裸 seed 哈希',
  )
})

test('D20 回执/承诺 Ed25519 验签通过；篡改 prize/serverTime 后失败', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const { begin, revealed } = await beginReveal(h, cookie, 'daily-1')

  const keyResponse = await h.request('GET', '/api/verification-key')
  assert.equal(keyResponse.body.alg, 'Ed25519')
  assert.match(keyResponse.body.publicKeyHex, /^[0-9a-f]+$/)
  assert.ok(keyResponse.body.keyId)
  assert.ok(keyResponse.body.issuedAt)
  assert.equal(keyResponse.body.publicKeyHex, h.signer.publicKeyDerHex)

  const receipt = revealed.body.card.receipt
  const receiptPayload = {
    campaignId: 'daily',
    cardId: 'daily-1',
    seedHex: receipt.seedHex,
    commitment: receipt.commitment,
    prize: { ...revealed.body.card.prize },
    weightsVersion: receipt.weightsVersion,
    serverTime: receipt.serverTime,
  }
  assert.equal(h.verify(receiptPayload, receipt.signature), true)
  // 篡改后的 prize 必须保证与真实结果不同，否则验签"失败"断言本身不成立
  const tamperedPrize =
    revealed.body.card.prize.name === '88元 现金红包'
      ? { name: '免费咖啡一杯', win: true }
      : { name: '88元 现金红包', win: true }
  assert.notEqual(h.verify({ ...receiptPayload, prize: tamperedPrize }, receipt.signature), true)
  assert.notEqual(h.verify({ ...receiptPayload, serverTime: '2099-01-01T00:00:00.000Z' }, receipt.signature), true)

  // commitSig：对 {campaignId,cardId,commitment,expiresAt,day} 验签
  const commitPayload = {
    campaignId: 'daily',
    cardId: 'daily-1',
    commitment: begin.body.card.commitment,
    expiresAt: begin.body.card.expiresAt,
    day: begin.body.day,
  }
  assert.equal(h.verify(commitPayload, begin.body.commitSig), true)
  assert.notEqual(
    h.verify({ ...commitPayload, commitment: '0'.repeat(64) }, begin.body.commitSig),
    true,
  )
})

test('D21 承诺事件序号严格早于任何含 seed/prize 的下发；begin 响应不含 seed', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(begin.body.card.seedHex, undefined)
  const commitEvent = h.store.events.find((event) => event.type === 'commitment-created')
  const storedEvent = h.store.events.find((event) => event.type === 'pending-stored')
  assert.ok(commitEvent)
  assert.ok(storedEvent)
  assert.ok(commitEvent.seq < storedEvent.seq, '承诺先于记录事件')
  // 承诺事件负载不含秘密
  assert.equal(JSON.stringify(commitEvent).includes('seedHex'), false)
  assert.equal(JSON.stringify(commitEvent).includes('prize'), false)

  await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const revealEvent = h.store.events.find((event) => event.type === 'card-revealed')
  assert.ok(commitEvent.seq < revealEvent.seq)
})

test('D22 seed 为 128bit；引擎直连 1e5 个 seed 无碰撞', async () => {
  const h = makeHarness()
  after(() => h.close())
  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const reveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const seedHex = reveal.body.card.receipt.seedHex
  assert.equal(Buffer.from(seedHex, 'hex').length, 16)

  const { generateSeedHex } = await import('../../server/core/rng.js')
  const seen = new Set()
  for (let i = 0; i < 100000; i += 1) {
    const value = generateSeedHex()
    assert.equal(value.length, 32)
    assert.ok(seen.add(value))
  }
  assert.equal(seen.size, 100000)
  void canonicalJSON
})

test('D23 权重版本固化：切换权重表后，旧卡仍按 begin 时版本揭晓', async () => {
  const config = createDefaultConfig()
  const h = makeHarness({ config })
  after(() => h.close())
  const { cookie, sid } = await h.createSession()
  // 选 daily-1 用固定 RNG 不便；直接 begin 后记录 begin 时权重与结果
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const recordBefore = internalCard(h.store, sid, 'daily', 'daily-1')
  const originalWeights = recordBefore.weightsSnapshot.map((prize) => ({ ...prize }))
  assert.equal(begin.body.card.commitment, recordBefore.commitment)

  // 运行时篡改当前权重表（模拟运营改权重），不碰已固化快照
  config.getWeights = (campaignId, weightsVersion) => {
    if (campaignId === 'daily' && weightsVersion === 'v1') {
      return [{ name: '被篡改的奖品', weight: 100, win: true }]
    }
    return createDefaultConfig().getWeights(campaignId, weightsVersion)
  }

  const reveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(reveal.body.ok, true)
  assert.deepEqual(reveal.body.card.prize, recordBefore.prize)
  assert.ok(originalWeights.some((prize) => prize.name === reveal.body.card.prize.name))
  assert.equal(reveal.body.card.receipt.weightsVersion, 'v1')
})
