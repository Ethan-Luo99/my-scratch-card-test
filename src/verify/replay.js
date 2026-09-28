/**
 * 揭晓后的可复算演示（与服务端 server/core/draw.js 同算法）。
 *
 * 仅在用户对一张"已揭晓"卡点"公平性验证"时被调用：输入是服务端 reveal
 * 响应里公开的 seedHex，输出应与服务端下发的 prize 一致。该函数不在任何
 * 未揭晓链路上，不决定卡片状态，不写存储。
 */

/** mulberry32 PRNG（复核用纯函数） */
export function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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

/** 用公开的 128bit seedHex 重放开奖结果（仅复核） */
export function replayDraw(prizes, seedHex) {
  if (!/^[0-9a-f]{32}$/.test(seedHex)) return null
  const seed32 = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0
  const index = drawPrizeIndex(prizes, mulberry32(seed32))
  const prize = prizes[index]
  return { name: prize.name, win: Boolean(prize.win), index }
}
