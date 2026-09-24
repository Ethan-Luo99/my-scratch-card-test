/**
 * 验收 D 类：承诺—揭晓与签名。
 * 对应设计文档第 7 节条目 19/20/21/22/23。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createHarness, serverCard } from './helpers.js'
import { generateSeedHex, computeCommitment, canonicalize } from '../../server/core/crypto.js'

const DAILY_PRIZES = [
  { name: '88元 现金红包', weight: 5, win: true },
  { name: '免费咖啡一杯', weight: 10, win: true },
  { name: '8.8元 优惠券', weight: 15, win: true },
  { name: '谢谢参与', weight: 70, win: false },
]

async function beginAndReveal(h, sid, cardId = 'daily-1') {
  const begin = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: `b-${cardId}`, body: { cardId },
  })
  const reveal = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: `r-${cardId}`, body: { cardId },
  })
  return { begin: begin.json, reveal: reveal.json }
}

test('D19: 承诺绑定——reveal 的 seedHex 重算 SHA-256 等于 begin 承诺；篡改上下文不等', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const { begin, reveal } = await beginAndReveal(h, sid)
  const receipt = reveal.card.receipt
  const recomputed = computeCommitment({
    seedHex: receipt.seedHex,
    campaignId: 'daily',
    cardId: 'daily-1',
    weightsVersion: receipt.weightsVersion,
  })
  assert.equal(recomputed, begin.card.commitment)
  assert.equal(receipt.commitment, begin.card.commitment)
  const tamperedCard = computeCommitment({
    seedHex: receipt.seedHex,
    campaignId: 'daily',
    cardId: 'daily-2',
    weightsVersion: receipt.weightsVersion,
  })
  const tamperedVersion = computeCommitment({
    seedHex: receipt.seedHex,
    campaignId: 'daily',
    cardId: 'daily-1',
    weightsVersion: 'v2',
  })
  assert.notEqual(tamperedCard, begin.card.commitment)
  assert.notEqual(tamperedVersion, begin.card.commitment)
  await h.close()
})

test('D20: 回执验签——verification-key 公钥可验，篡改 prize 验签失败', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const { reveal } = await beginAndReveal(h, sid)
  const keyRes = await h.api('GET', '/api/verification-key', {})
  assert.equal(keyRes.json.alg, 'Ed25519')
  const publicKey = createPublicKey({
    key: Buffer.from(keyRes.json.publicKeyHex, 'hex'),
    type: 'spki',
    format: 'der',
  })
  const receipt = reveal.card.receipt
  const payload = {
    campaignId: 'daily',
    cardId: 'daily-1',
    seedHex: receipt.seedHex,
    commitment: receipt.commitment,
    prize: { name: reveal.card.prize.name, win: reveal.card.prize.win },
    weightsVersion: receipt.weightsVersion,
    serverTime: receipt.serverTime,
  }
  const bytes = Buffer.from(canonicalize(payload), 'utf8')
  const signature = Buffer.from(receipt.signature, 'hex')
  assert.equal(verify(null, bytes, publicKey, signature), true)
  const tampered = Buffer.from(
    canonicalize({ ...payload, prize: { name: '88元 现金红包', win: true } }),
    'utf8',
  )
  assert.equal(verify(null, tampered, publicKey, signature), false, '篡改 prize 验签失败')
  await h.close()
})

test('D21: 承诺先于结果——首个含 seed 的响应是 reveal，且 begin 更早给出承诺', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const raws = []
  const begin = await h.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'ord-1', body: { cardId: 'daily-1' },
  })
  raws.push(begin.raw)
  raws.push((await h.api('GET', '/api/state', { sid })).raw)
  raws.push((await h.api('POST', '/api/recover', { sid, body: {} })).raw)
  const record = serverCard(h.store, sid, 'daily', 'daily-1')
  const reveal = await h.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'ord-2', body: { cardId: 'daily-1' },
  })
  raws.push(reveal.raw)
  raws.push((await h.api('GET', '/api/state', { sid })).raw)

  const firstSeedIndex = raws.findIndex((raw) => raw.includes(record.seedHex))
  const firstCommitIndex = raws.findIndex((raw) => raw.includes(record.commitment))
  assert.equal(firstCommitIndex, 0, 'begin 响应即含承诺')
  assert.ok(firstSeedIndex > firstCommitIndex, '承诺事件严格早于任何含 seed 的下发')
  assert.equal(firstSeedIndex, 3, 'reveal 响应是第一个含 seed 的响应')
  assert.ok(!begin.raw.includes(record.seedHex), 'begin 响应不含 seed')
  await h.close()
})

test('D22: seed 强度——128bit 且大批量生成无重复', async () => {
  const h = createHarness()
  const { sid } = await h.newSession()
  const { reveal } = await beginAndReveal(h, sid)
  const seedHex = reveal.card.receipt.seedHex
  assert.equal(Buffer.from(seedHex, 'hex').length, 16, '128bit')
  const seen = new Set()
  for (let i = 0; i < 100000; i++) seen.add(generateSeedHex())
  assert.equal(seen.size, 100000, '1e5 个 seed 无碰撞')
  await h.close()
})

test('D23: 权重版本固化——切换权重表后旧卡 reveal 仍按 begin 时版本结算', async () => {
  // 固定 seed 使结果确定；v1 权重必出"甲"，v2 权重必出"乙"
  const fixedSeed = Buffer.alloc(16, 7)
  const rng = () => fixedSeed
  const base = {
    campaignId: 'daily',
    title: 't', subtitle: '',
    dailyChances: 3,
    cardIds: ['daily-1'],
  }
  const prizesV1 = [
    { name: '甲', weight: 1, win: true },
    { name: '乙', weight: 0, win: false },
  ]
  const prizesV2 = [
    { name: '甲', weight: 0, win: true },
    { name: '乙', weight: 1, win: false },
  ]
  // 第一引擎（v1 权重）begin
  const h1 = createHarness({ campaigns: [{ ...base, weightsVersion: 'v1', prizes: prizesV1 }], rng })
  const { sid } = await h1.newSession()
  const begin = await h1.api('POST', '/api/campaigns/daily/scratch/begin', {
    sid, idemKey: 'w1', body: { cardId: 'daily-1' },
  })
  assert.equal(begin.json.ok, true)
  const record = serverCard(h1.store, sid, 'daily', 'daily-1')
  assert.equal(record.weightsVersion, 'v1')
  assert.equal(record.prize.name, '甲')

  // 第二引擎（v2 权重 + v1 快照注册表）共享同一 store，reveal 旧卡
  const h2 = createHarness({
    campaigns: [{ ...base, weightsVersion: 'v2', prizes: prizesV2 }],
    store: h1.store,
    weightsRegistry: { 'daily#v1': prizesV1 },
  })
  const reveal = await h2.api('POST', '/api/campaigns/daily/scratch/reveal', {
    sid, idemKey: 'w2', body: { cardId: 'daily-1' },
  })
  assert.equal(reveal.json.ok, true, '自检按 begin 时版本通过')
  assert.equal(reveal.json.card.prize.name, '甲', '结果与旧权重一致')
  assert.equal(reveal.json.card.receipt.weightsVersion, 'v1')
  const expected = createHash('sha256')
    .update(`${fixedSeed.toString('hex')}|daily|daily-1|v1`, 'utf8')
    .digest('hex')
  assert.equal(reveal.json.card.receipt.commitment, expected)
  await h1.close()
  await h2.close()
})
