/**
 * 公平性复核（设计第 3 节）：只对已揭晓卡提供只读核验，不触碰未揭晓数据。
 *
 * 三项核验：
 * 1) 承诺一致：SHA256(seedHex|campaignId|cardId|weightsVersion) === begin 时留存的 commitment；
 * 2) 回执验签：用 /api/verification-key 的 Ed25519 公钥验 receipt.signature；
 * 3) 权重重算：用公开权重快照 replayDraw(seedHex) === 下发 prize。
 * 迁移历史卡（无承诺）第 1 项标记 skipped，仍可做 2/3（若有回执）。
 */
import { createHashHex } from './hash.js'
import { canonicalJSON } from './canonical.js'
import { replayDraw } from './replay.js'
import { getReviewWeights } from './weights.js'

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function importEd25519PublicKey(publicKeyDerHex) {
  return crypto.subtle.importKey(
    'spki',
    hexToBytes(publicKeyDerHex),
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
}

async function verifySignature(publicKeyDerHex, canonicalValue, signatureHex) {
  const key = await importEd25519PublicKey(publicKeyDerHex)
  const data = new TextEncoder().encode(canonicalJSON(canonicalValue))
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    hexToBytes(signatureHex),
    data,
  )
}

/**
 * @param {object} args
 * @param {object} args.card 已揭晓卡公开视图（含 prize/receipt）
 * @param {string|null} args.commitment begin 时本地留存的承诺（迁移卡可能没有）
 * @param {{publicKeyHex:string}} args.publicKey 验签公钥信息
 */
export async function verifyRevealedCard({ card, commitment = null, publicKey }) {
  const receipt = card?.receipt
  const report = {
    available: false,
    commitmentCheck: { status: 'skipped', expected: null, actual: receipt?.commitment ?? null },
    signatureCheck: { status: 'skipped' },
    replayCheck: { status: 'skipped', expected: null, actual: card?.prize?.name ?? null },
    seedHex: receipt?.seedHex ?? null,
    weightsVersion: receipt?.weightsVersion ?? null,
  }
  if (!card || (card.status !== 'revealed' && card.status !== 'claimed') || !receipt) {
    return report
  }
  report.available = true

  // 1) 承诺一致
  const expectedCommitment = commitment || null
  if (expectedCommitment) {
    const actual = await createHashHex(
      `${receipt.seedHex}|${card.campaignId}|${card.cardId}|${receipt.weightsVersion}`,
    )
    report.commitmentCheck = {
      status: actual === expectedCommitment && actual === receipt.commitment ? 'pass' : 'fail',
      expected: expectedCommitment,
      actual,
    }
  } else if (receipt.commitment) {
    const actual = await createHashHex(
      `${receipt.seedHex}|${card.campaignId}|${card.cardId}|${receipt.weightsVersion}`,
    )
    report.commitmentCheck = {
      status: actual === receipt.commitment ? 'pass' : 'fail',
      expected: receipt.commitment,
      actual,
    }
  }

  // 2) 回执验签
  if (publicKey?.publicKeyHex && receipt.signature) {
    try {
      const canonical = {
        campaignId: card.campaignId,
        cardId: card.cardId,
        seedHex: receipt.seedHex,
        commitment: receipt.commitment,
        prize: { name: card.prize.name, win: Boolean(card.prize.win) },
        weightsVersion: receipt.weightsVersion,
        serverTime: receipt.serverTime,
      }
      const valid = await verifySignature(
        publicKey.publicKeyHex,
        canonical,
        receipt.signature,
      )
      report.signatureCheck = { status: valid ? 'pass' : 'fail' }
    } catch {
      report.signatureCheck = { status: 'fail' }
    }
  }

  // 3) 公开权重重算
  const weights = getReviewWeights(card.campaignId, receipt.weightsVersion)
  if (weights) {
    const replayed = replayDraw(weights, receipt.seedHex)
    report.replayCheck = {
      status:
        replayed &&
        replayed.name === card.prize.name &&
        replayed.win === Boolean(card.prize.win)
          ? 'pass'
          : 'fail',
      expected: replayed ? replayed.name : null,
      actual: card.prize.name,
    }
  }

  report.allPassed =
    (report.commitmentCheck.status === 'pass' || report.commitmentCheck.status === 'skipped') &&
    (report.signatureCheck.status === 'pass' || report.signatureCheck.status === 'skipped') &&
    (report.replayCheck.status === 'pass' || report.replayCheck.status === 'skipped') &&
    !(
      report.commitmentCheck.status === 'fail' ||
      report.signatureCheck.status === 'fail' ||
      report.replayCheck.status === 'fail'
    )
  return report
}

/** 承诺签名核验（begin 存档的 commitSig，可选展示） */
export async function verifyCommitmentSignature({
  campaignId,
  cardId,
  commitment,
  expiresAt,
  day,
  commitSig,
  publicKey,
}) {
  if (!publicKey?.publicKeyHex || !commitSig) return false
  try {
    return verifySignature(
      publicKey.publicKeyHex,
      { campaignId, cardId, commitment, expiresAt, day },
      commitSig,
    )
  } catch {
    return false
  }
}
