/**
 * 承诺—揭晓密码学（纯逻辑，仅 node:crypto）。
 * - seed：128bit，crypto.randomBytes(16)，仅在 begin 事务内生成，只存服务端；
 * - commitment：SHA-256(seedHex|campaignId|cardId|weightsVersion)，先于结果固定；
 * - 签名：Ed25519，对规范化 JSON（键序固定）字节签名，公钥经 /api/verification-key 公开。
 */
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'

export const RECEIPT_ALGORITHM = 'mulberry32-sha256-commit-v1'

/** 生成 128bit seed，返回 32 位小写 hex；rng 可注入（测试用确定性源） */
export function generateSeedHex(rng = defaultRng) {
  const bytes = rng(16)
  if (!bytes || bytes.length !== 16) {
    throw new Error('rng must return exactly 16 bytes')
  }
  return Buffer.from(bytes).toString('hex')
}

function defaultRng(n) {
  return randomBytes(n)
}

/** 承诺：SHA-256(seedHex|campaignId|cardId|weightsVersion)，64 位 hex */
export function computeCommitment({ seedHex, campaignId, cardId, weightsVersion }) {
  return createHash('sha256')
    .update(`${seedHex}|${campaignId}|${cardId}|${weightsVersion}`, 'utf8')
    .digest('hex')
}

/** 规范化序列化：对象键排序，保证签名/验签字节一致 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
    .join(',')
  return `{${body}}`
}

/** 生成 Ed25519 密钥对（测试可注入固定种子派生的密钥） */
export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey,
    publicKey,
  }
}

/**
 * 创建签名器。signer 可注入；缺省用生成的密钥对。
 * 返回 { keyId, publicKeyHex, signPayload(payload), verifyPayload(payload, sigHex) }
 */
export function createSigner({ privateKey, publicKey, keyId } = {}) {
  let priv = privateKey
  let pub = publicKey
  if (!priv || !pub) {
    const pair = generateSigningKeyPair()
    priv = pair.privateKey
    pub = pair.publicKey
  }
  const publicKeyHex = pub.export({ type: 'spki', format: 'der' }).toString('hex')
  const id = keyId || createHash('sha256').update(publicKeyHex, 'utf8').digest('hex').slice(0, 16)
  return {
    keyId: id,
    publicKeyHex,
    signPayload(payload) {
      return sign(null, Buffer.from(canonicalize(payload), 'utf8'), priv).toString('hex')
    },
    verifyPayload(payload, signatureHex) {
      try {
        return verify(
          null,
          Buffer.from(canonicalize(payload), 'utf8'),
          pub,
          Buffer.from(String(signatureHex), 'hex'),
        )
      } catch {
        return false
      }
    },
  }
}
