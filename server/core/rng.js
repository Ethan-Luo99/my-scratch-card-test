/**
 * 密码学随机、承诺与签名（仅用 node:crypto，无第三方依赖）。
 *
 * - seed：128bit（16 字节），hex 编码后 32 字符；仅在服务端 begin 事务内生成；
 * - commitment：SHA-256(seedHex | campaignId | cardId | weightsVersion)；
 * - 签名：Ed25519 对确定性规范化 JSON（键字典序）签名。
 */
import {
  randomBytes,
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
} from 'node:crypto'

export const SEED_BYTES = 16

/** 生成 128bit seed 的 hex 字符串（RNG 可注入，生产默认 crypto.randomBytes） */
export function generateSeedHex(randomFn = randomBytes) {
  return randomFn(SEED_BYTES).toString('hex')
}

/**
 * 承诺：SHA-256(seedHex || '|' || campaignId || '|' || cardId || '|' || weightsVersion)。
 * seedHex 作为规范形态参与哈希，保证 reveal 后任何人可重算核对。
 */
export function computeCommitment(seedHex, campaignId, cardId, weightsVersion) {
  return createHash('sha256')
    .update(`${seedHex}|${campaignId}|${cardId}|${weightsVersion}`)
    .digest('hex')
}

/** 确定性 JSON：对象键按字典序递归排序，签名/验签双方用同一字节串 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`
}

/**
 * 构造一个 Ed25519 签名器。
 * @param {object} [opts]
 * @param {import('node:crypto').KeyObject} [opts.privateKey] 注入私钥（测试用）
 * @param {string} [opts.keyId] 密钥 id（默认取公钥指纹）
 */
export function createSigner(opts = {}) {
  const pair = opts.privateKey
    ? { privateKey: opts.privateKey, publicKey: createPublicKey(opts.privateKey) }
    : generateKeyPairSync('ed25519')
  const publicKeyHex = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex')
  const keyId =
    opts.keyId ?? `ed25519-${createHash('sha256').update(publicKeyHex).digest('hex').slice(0, 16)}`

  function signObject(obj) {
    const data = Buffer.from(canonicalJSON(obj), 'utf8')
    return cryptoSign(null, data, pair.privateKey).toString('hex')
  }

  /** 对承诺上下文签名：{campaignId,cardId,commitment,expiresAt,day} */
  function signCommitment({ campaignId, cardId, commitment, expiresAt, day }) {
    return signObject({ campaignId, cardId, commitment, expiresAt, day })
  }

  /** 对揭晓回执签名：{campaignId,cardId,seedHex,commitment,prize,weightsVersion,serverTime} */
  function signReceipt({ campaignId, cardId, seedHex, commitment, prize, weightsVersion, serverTime }) {
    return signObject({
      campaignId,
      cardId,
      seedHex,
      commitment,
      prize: { name: prize.name, win: Boolean(prize.win) },
      weightsVersion,
      serverTime,
    })
  }

  return {
    alg: 'Ed25519',
    keyId,
    publicKeyDerHex: publicKeyHex,
    signObject,
    signCommitment,
    signReceipt,
  }
}

/** 用 SPKI DER hex 公钥验签（canonicalJSON 字节串），返回 boolean */
export function verifyObjectSignature(publicKeyDerHex, value, signatureHex) {
  const key = createPublicKey({
    key: Buffer.from(publicKeyDerHex, 'hex'),
    format: 'der',
    type: 'spki',
  })
  return cryptoVerify(
    undefined,
    Buffer.from(canonicalJSON(value), 'utf8'),
    key,
    Buffer.from(signatureHex, 'hex'),
  )
}
