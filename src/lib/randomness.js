/**
 * 可复现随机数与可验证公平性（纯逻辑，无 DOM / window 依赖，可直接 Node 单测）。
 *
 * - mulberry32：确定性 32 位 PRNG，同一 seed 必然产生同一序列；
 * - fnv1aHex：FNV-1a 32 位哈希，作为 seed 的指纹展示给用户核对；
 * - drawPrizeIndex / drawPrize：按权重从确定性序列开奖，纯函数；
 * - generateSeed：开始刮那一刻才调用，优先使用 crypto.getRandomValues，
 *   不可用时用时间+计数器兜底（兜底结果仍为 uint32）。
 */

/** mulberry32 PRNG：返回 () => [0,1) 的生成器 */
export function mulberry32(seed) {
  let a = toUint32(seed)
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a 32 位哈希，返回 8 位十六进制字符串 */
export function fnv1aHex(input) {
  let hash = 0x811c9dc5
  const str = String(input)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 按权重选择下标（纯函数，rng 可注入）；权重全 0 / 非法时回退最后一项 */
export function drawPrizeIndex(prizes, rng) {
  const weights = prizes.map((p) =>
    Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0,
  )
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return prizes.length - 1
  let roll = rng() * total
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i]
    if (roll < 0) return i
  }
  return prizes.length - 1
}

/** 以确定性 seed 按权重开出奖品；roll 为实际使用的首个随机数 */
export function drawPrize(prizes, seed) {
  const rng = mulberry32(seed)
  const index = drawPrizeIndex(prizes, rng)
  const prize = prizes[index]
  return { name: prize.name, win: Boolean(prize.win) }
}

/** 生成 32 位随机 seed；cryptoObject 可注入（测试 / 非浏览器环境） */
export function generateSeed(cryptoObject = defaultCrypto()) {
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    const view = new Uint32Array(1)
    cryptoObject.getRandomValues(view)
    return view[0] >>> 0
  }
  const time =
    typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now()
  seedCounter = (seedCounter + 1) | 0
  let h = 0x811c9dc5 ^ (time | 0) ^ seedCounter
  h = Math.imul(h ^ (time >>> 11), 0x01000193)
  h = Math.imul(h ^ ((time + seedCounter) >>> 7), 0x01000193)
  return (h ^ (h >>> 13)) >>> 0
}

let seedCounter = 0

function defaultCrypto() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto) return globalThis.crypto
  } catch {
    return null
  }
  return null
}

function toUint32(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return n >>> 0
}
