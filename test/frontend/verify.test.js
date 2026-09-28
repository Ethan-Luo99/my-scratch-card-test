/**
 * 揭晓后公平性只读核验：
 * - 用 seedHex 高 32bit 重算奖品与服务端口径一致；
 * - 承诺 SHA-256 重算；
 * - Ed25519 验签（签名来自服务端测试密钥，WebCrypto 验）；
 * - 篡改奖品后验签失败；未揭晓（无 receipt）返回不可用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  redrawPrize,
  canonicalJSON,
  recomputeCommitment,
  verifyEd25519,
  verifyCard,
} from '../../src/lib/verify.js'
import { getPublicWeights } from '../../src/lib/public-weights.js'
import { createSigner, computeCommitment } from '../../server/core/rng.js'

const subtle = globalThis.crypto.subtle
const signer = createSigner()

const SEED_HEX = '0123456789abcdef0123456789abcdef'
const CARD_ID = 'daily-1'

function makeReceipt(seedHex = SEED_HEX, prizeName = '谢谢参与', win = false) {
  const prize = { name: prizeName, win }
  const payload = {
    campaignId: 'daily',
    cardId: CARD_ID,
    seedHex,
    commitment: computeCommitment(seedHex, 'daily', CARD_ID, 'v1'),
    prize,
    weightsVersion: 'v1',
    serverTime: '2026-09-27T02:05:00.000Z',
  }
  const signature = signer.signReceipt(payload)
  return {
    card: {
      cardId: CARD_ID,
      status: 'revealed',
      rev: 2,
      prize,
      receipt: {
        seedHex,
        algorithm: 'mulberry32-sha256-commit-v1',
        weightsVersion: 'v1',
        commitment: payload.commitment,
        serverTime: payload.serverTime,
        signature,
      },
    },
    payload,
  }
}

test('canonicalJSON：键按字典序递归排序', () => {
  assert.equal(canonicalJSON({ b: 1, a: { z: 2, y: 3 } }), '{"a":{"y":3,"z":2},"b":1}')
})

test('redrawPrize：与服务端 drawPrize 同口径（取 seedHex 高 32bit）', async () => {
  const { drawPrize } = await import('../../server/core/draw.js')
  const weights = getPublicWeights('daily', 'v1')
  for (const seed of [SEED_HEX, 'ffffffff000000000000000000000000', 'deadbeef'.padEnd(32, '0')]) {
    assert.deepEqual(redrawPrize(weights, seed), drawPrize(weights, seed))
  }
})

test('recomputeCommitment：与服务端 computeCommitment 一致', async () => {
  const expected = computeCommitment(SEED_HEX, 'daily', CARD_ID, 'v1')
  const actual = await recomputeCommitment(SEED_HEX, 'daily', CARD_ID, 'v1', subtle)
  assert.equal(actual, expected)
})

test('Ed25519 验签：有效签名通过；篡改奖品后失败', async () => {
  const { payload } = makeReceipt(SEED_HEX, '谢谢参与', false)
  const signature = signer.signReceipt(payload)
  const valid = await verifyEd25519(signer.publicKeyDerHex, payload, signature, subtle)
  assert.equal(valid, true)
  const tampered = { ...payload, prize: { name: '88元 现金红包', win: true } }
  const invalid = await verifyEd25519(signer.publicKeyDerHex, tampered, signature, subtle)
  assert.equal(invalid, false)
})

test('verifyCard：承诺/签名/权重复算全部一致', async () => {
  const { card } = makeReceipt(SEED_HEX, '谢谢参与', false)
  const weights = getPublicWeights('daily', 'v1')
  const expectedDraw = redrawPrize(weights, SEED_HEX)
  const report = await verifyCard({
    card,
    campaignId: 'daily',
    weights,
    commitment: card.receipt.commitment,
    publicKeyHex: signer.publicKeyDerHex,
  })
  assert.equal(report.available, true)
  assert.equal(report.commitmentMatches, true)
  assert.equal(report.signatureValid, true)
  assert.equal(report.prizeMatches, expectedDraw.name === card.prize.name)
})

test('verifyCard：无 receipt（迁移旧卡）返回不可用且不暴露任何结果', async () => {
  const report = await verifyCard({
    card: { cardId: CARD_ID, status: 'revealed', prize: { name: '谢谢参与', win: false } },
    campaignId: 'daily',
    weights: getPublicWeights('daily', 'v1'),
  })
  assert.equal(report.available, false)
  assert.ok(report.note)
})
