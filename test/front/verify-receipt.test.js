/**
 * 设计第 3 节：揭晓后的承诺—签名—权重重算复核（真实 Ed25519 密钥，
 * 与服务端签名实现交叉验证；测试可以引用 server/，src/ 仍不允许）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSigner, canonicalJSON as serverCanonical } from '../../server/core/rng.js'
import { drawPrize } from '../../server/core/draw.js'
import { verifyRevealedCard } from '../../src/verify/verify-receipt.js'
import { replayDraw, mulberry32, drawPrizeIndex } from '../../src/verify/replay.js'
import { createHashHex } from '../../src/verify/hash.js'
import { canonicalJSON } from '../../src/verify/canonical.js'

const signer = createSigner()
const publicKey = { alg: 'Ed25519', publicKeyHex: signer.publicKeyDerHex, keyId: signer.keyId }

const SEED_HEX = '0123456789abcdef0123456789abcdef'
const WEIGHTS_VERSION = 'v1'
const CAMPAIGN_ID = 'daily'
const CARD_ID = 'daily-1'

async function buildCommitment() {
  return createHashHex(`${SEED_HEX}|${CAMPAIGN_ID}|${CARD_ID}|${WEIGHTS_VERSION}`)
}

async function makeRevealedCard({ commitment, seedHex = SEED_HEX, prizeOverride = null, signature = undefined } = {}) {
  const weights = (await import('../../server/core/config.js')).WEIGHTS_VERSIONS[`${CAMPAIGN_ID}/${WEIGHTS_VERSION}`]
  const prize = prizeOverride ?? drawPrize(weights, seedHex)
  const serverTime = '2026-09-24T02:05:00.000Z'
  const payload = {
    campaignId: CAMPAIGN_ID,
    cardId: CARD_ID,
    seedHex,
    commitment,
    prize,
    weightsVersion: WEIGHTS_VERSION,
    serverTime,
  }
  const sig = signature === undefined ? signer.signObject(payload) : signature
  return {
    card: {
      cardId: CARD_ID,
      campaignId: CAMPAIGN_ID,
      status: 'revealed',
      rev: 2,
      prize,
      receipt: { seedHex, algorithm: 'mulberry32-sha256-commit-v1', weightsVersion: WEIGHTS_VERSION, commitment, serverTime, signature: sig },
    },
    prize,
  }
}

test('客户端 canonicalJSON 与服务端字节级一致（验签前提）', () => {
  const value = { b: 1, a: { z: [1, 2], y: 'x' }, c: true }
  assert.equal(canonicalJSON(value), serverCanonical(value))
})

test('复核纯函数：replayDraw 与服务端 drawPrize 同 seedHex 同结果', () => {
  const weights = [
    { name: 'A', weight: 5, win: true },
    { name: 'B', weight: 95, win: false },
  ]
  for (const seed of ['00000000000000000000000000000001', 'ffffffffffffffffffffffffffffffff', '1234abcd5678ef901234abcd5678ef90']) {
    const replayed = replayDraw(weights, seed)
    const serverResult = drawPrize(weights, seed)
    assert.equal(replayed.name, serverResult.name)
    assert.equal(replayed.win, serverResult.win)
  }
  assert.equal(replayDraw(weights, 'bad'), null)
  assert.equal(typeof mulberry32(1)(), 'number')
  assert.equal(drawPrizeIndex([{ weight: 0 }, { weight: 0 }], () => 0.5), 1)
})

test('正常揭晓卡：承诺一致 + 验签通过 + 重算一致', async () => {
  const commitment = await buildCommitment()
  const { card } = await makeRevealedCard({ commitment })
  const report = await verifyRevealedCard({ card, commitment, publicKey })
  assert.equal(report.available, true)
  assert.equal(report.commitmentCheck.status, 'pass')
  assert.equal(report.signatureCheck.status, 'pass')
  assert.equal(report.replayCheck.status, 'pass')
  assert.equal(report.allPassed, true)
})

test('未揭晓卡：复核不可用（面板入口本身也不会出现）', async () => {
  const report = await verifyRevealedCard({
    card: { cardId: 'c', campaignId: CAMPAIGN_ID, status: 'pending', rev: 1, commitment: 'x'.repeat(64) },
    publicKey,
  })
  assert.equal(report.available, false)
})

test('篡改 prize：验签失败且重算不一致', async () => {
  const commitment = await buildCommitment()
  const { card } = await makeRevealedCard({ commitment })
  card.prize = { name: '88元 现金红包', win: true }
  const report = await verifyRevealedCard({ card, commitment, publicKey })
  assert.equal(report.signatureCheck.status, 'fail')
  assert.equal(report.replayCheck.status, 'fail')
  assert.equal(report.allPassed, false)
})

test('begin 存档承诺与回执不一致：承诺核对失败', async () => {
  const commitment = await buildCommitment()
  const { card } = await makeRevealedCard({ commitment })
  const report = await verifyRevealedCard({ card, commitment: 'c'.repeat(64), publicKey })
  assert.equal(report.commitmentCheck.status, 'fail')
  assert.equal(report.signatureCheck.status, 'pass')
  assert.equal(report.allPassed, false)
})

test('迁移历史卡（无承诺存档，receipt.commitment=null）：承诺项 skipped，仍可验签', async () => {
  const { card } = await makeRevealedCard({ commitment: null })
  const report = await verifyRevealedCard({ card, commitment: null, publicKey })
  assert.equal(report.commitmentCheck.status, 'skipped')
  assert.equal(report.signatureCheck.status, 'pass')
  assert.equal(report.replayCheck.status, 'pass')
})

test('公钥不可用：签名项 skipped，不阻塞其他核对', async () => {
  const commitment = await buildCommitment()
  const { card } = await makeRevealedCard({ commitment })
  const report = await verifyRevealedCard({ card, commitment, publicKey: null })
  assert.equal(report.signatureCheck.status, 'skipped')
  assert.equal(report.commitmentCheck.status, 'pass')
  assert.equal(report.replayCheck.status, 'pass')
})
