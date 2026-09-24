/**
 * 服务端权威摇奖（纯函数）。
 *
 * 抽签熵来自 128bit seed（crypto.randomBytes(16)）；为保留可复算性，
 * 取 seedHex 前 8 个 hex 字符（高 32bit）喂 mulberry32 做加权选择。
 * 与前端 src/lib/randomness.js 的 mulberry32/drawPrizeIndex 同算法，
 * 使揭晓后任何人可用同一 seedHex 重放出同一结果。
 */
import { ALGORITHM_ID } from './config.js'

export function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 按权重选择下标；权重全 0 / 非法时回退最后一项（与前端口径一致） */
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

/**
 * 按权威权重表对 128bit seed 开奖。
 * @param {Array<{name:string,win:boolean,weight:number}>} prizes
 * @param {string} seedHex 32 字符 hex（128bit）
 * @returns {{name:string, win:boolean}}
 */
export function drawPrize(prizes, seedHex) {
  const seed32 = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0
  const rng = mulberry32(seed32)
  const index = drawPrizeIndex(prizes, rng)
  const prize = prizes[index]
  return { name: prize.name, win: Boolean(prize.win) }
}

export { ALGORITHM_ID }
