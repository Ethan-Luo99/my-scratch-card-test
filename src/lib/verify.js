/**
 * 公平性只读核验（仅揭晓后可用）。
 *
 * 本模块是设计文档第 3 节允许保留的"复核用纯函数"集合：
 * - 不被任何状态迁移/开奖路径调用（begin/reveal/claim 链路绝不 import 本模块）；
 * - 只在卡片已 revealed/claimed、receipt 已公开后，由公平性面板调用；
 * - 做三件事：重算承诺 SHA-256、Ed25519 验签、用公开权重重算奖品。
 *
 * mulberry32 与服务端 server/core/draw.js 同算法（取 seedHex 高 32bit），
 * 使任何人可用同一 seedHex 复放出完全相同的结果。
 */

/** mulberry32 PRNG（与服务端逐位一致） */
export function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 按权重选择下标（与服务端口径一致；权重全 0 回退最后一项） */
export function drawPrizeIndex(prizes, rng) {
  const weights = prizes.map((prize) =>
    Number.isFinite(prize.weight) && prize.weight > 0 ? prize.weight : 0,
  )
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0) return prizes.length - 1
  let roll = rng() * total
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i]
    if (roll < 0) return i
  }
  return prizes.length - 1
}

/** 揭晓后复核：用 seedHex 高 32bit 重算奖品 */
export function redrawPrize(prizes, seedHex) {
  if (typeof seedHex !== 'string' || seedHex.length < 8) return null
  const seed32 = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0
  const index = drawPrizeIndex(prizes, mulberry32(seed32))
  const prize = prizes[index]
  return { name: prize.name, win: Boolean(prize.win) }
}

/** 确定性 JSON：对象键按字典序递归排序（须与服务端 canonicalJSON 一致） */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
    .join(',')}}`
}

function defaultSubtle() {
  try {
    return typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle
      ? globalThis.crypto.subtle
      : null
  } catch {
    return null
  }
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 重算承诺：SHA-256(seedHex|campaignId|cardId|weightsVersion) */
export async function recomputeCommitment(seedHex, campaignId, cardId, weightsVersion, subtle = defaultSubtle()) {
  if (!subtle) return null
  try {
    const data = new TextEncoder().encode(`${seedHex}|${campaignId}|${cardId}|${weightsVersion}`)
    const digest = await subtle.digest('SHA-256', data)
    return bytesToHex(digest)
  } catch {
    return null
  }
}

/** 导入服务端 Ed25519 SPKI 公钥（DER hex） */
export async function importEd25519PublicKey(publicKeyDerHex, subtle = defaultSubtle()) {
  const bytes = hexToBytes(publicKeyDerHex)
  if (!subtle || !bytes) return null
  try {
    return await subtle.importKey('spki', bytes, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    return null
  }
}

/** 验签：对 canonicalJSON(value) 的 Ed25519 签名 */
export async function verifyEd25519(publicKeyDerHex, value, signatureHex, subtle = defaultSubtle()) {
  const key = await importEd25519PublicKey(publicKeyDerHex, subtle)
  const signature = hexToBytes(signatureHex)
  if (!key || !signature) return false
  try {
    return await subtle.verify(
      key.algorithm.name === 'Ed25519' ? { name: 'Ed25519' } : null,
      key,
      signature,
      new TextEncoder().encode(canonicalJSON(value)),
    )
  } catch {
    return false
  }
}

/**
 * 执行一次完整复核。
 * @param {object} args
 * @param {object} args.card 已揭晓卡公开视图（含 prize/receipt）
 * @param {string} args.campaignId
 * @param {Array<{name:string,win:boolean,weight:number}>} args.weights
 * @param {string|null} args.commitment begin 时缓存的承诺（无则跳过承诺比对）
 * @param {string} args.publicKeyHex /api/verification-key 公钥
 */
export async function verifyCard({ card, campaignId, weights, commitment = null, publicKeyHex = null }) {
  const receipt = card?.receipt
  const report = {
    available: false,
    seedHex: null,
    weightsVersion: null,
    commitmentExpected: commitment ?? receipt?.commitment ?? null,
    commitmentMatches: null,
    signatureValid: null,
    redraw: null,
    prizeMatches: null,
    note: null,
  }
  if (!receipt || typeof receipt.seedHex !== 'string') {
    report.note = '该卡为旧版本地数据迁移而来，无服务端凭证，不参与密码学复核。'
    return report
  }
  report.available = true
  report.seedHex = receipt.seedHex
  report.weightsVersion = receipt.weightsVersion ?? null

  if (receipt.weightsVersion) {
    const recomputed = await recomputeCommitment(
      receipt.seedHex,
      campaignId,
      card.cardId,
      receipt.weightsVersion,
    )
    report.commitmentMatches =
      recomputed !== null &&
      Boolean(report.commitmentExpected) &&
      recomputed === report.commitmentExpected
  }

  if (publicKeyHex && typeof receipt.signature === 'string') {
    const payload = {
      campaignId,
      cardId: card.cardId,
      seedHex: receipt.seedHex,
      commitment: receipt.commitment,
      prize: { name: card.prize.name, win: Boolean(card.prize.win) },
      weightsVersion: receipt.weightsVersion,
      serverTime: receipt.serverTime,
    }
    report.signatureValid = await verifyEd25519(publicKeyHex, payload, receipt.signature)
  }

  if (Array.isArray(weights) && weights.length > 0) {
    const drawn = redrawPrize(weights, receipt.seedHex)
    if (drawn) {
      report.redraw = drawn
      report.prizeMatches =
        drawn.name === card.prize.name && Boolean(drawn.win) === Boolean(card.prize.win)
    }
  }
  return report
}
