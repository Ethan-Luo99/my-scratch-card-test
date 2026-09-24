/**
 * 服务端权威摇奖（纯逻辑）。
 * 奖池/权重按 campaignId + weightsVersion 版本化固化：begin 时快照版本，
 * 之后即使切换权重表，旧卡 reveal 仍按 begin 时版本结算。
 * 可复算性：取 128bit seed 的前 32bit 喂 mulberry32 做加权选择；
 * 真实熵来自 128bit seed 本身（见设计文档 2.7 / 第 3 节）。
 */

export const WEIGHTS_VERSION = 'v1'

/** 服务端权威活动配置（前端不再持有权重副本用于开奖） */
export const CAMPAIGNS = [
  {
    campaignId: 'daily',
    title: '每日刮刮卡',
    subtitle: '每日 3 次机会，刮开涂层赢好礼',
    dailyChances: 3,
    cardIds: ['daily-1', 'daily-2', 'daily-3'],
    weightsVersion: WEIGHTS_VERSION,
    prizes: [
      { name: '88元 现金红包', weight: 5, win: true },
      { name: '免费咖啡一杯', weight: 10, win: true },
      { name: '8.8元 优惠券', weight: 15, win: true },
      { name: '谢谢参与', weight: 70, win: false },
    ],
  },
  {
    campaignId: 'weekend',
    title: '周末狂欢卡',
    subtitle: '周末限定：每日 5 次机会，赢 iPhone 抽奖券',
    dailyChances: 5,
    cardIds: ['weekend-1', 'weekend-2', 'weekend-3', 'weekend-4'],
    weightsVersion: WEIGHTS_VERSION,
    prizes: [
      { name: 'iPhone 抽奖券', weight: 2, win: true },
      { name: '20 元红包', weight: 8, win: true },
      { name: '谢谢参与', weight: 90, win: false },
    ],
  },
]

/** mulberry32：与前端公开算法一致的确定性 PRNG（用于事后可复算） */
export function mulberry32(seed32) {
  let a = seed32 >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 取 128bit seedHex 的前 32bit 作为可复算 PRNG 种子 */
export function seed32FromHex(seedHex) {
  return Number.parseInt(String(seedHex).slice(0, 8), 16) >>> 0
}

/** 按权重开奖（纯函数）：draw(weightsVersion 固化的奖池, seed) */
export function drawPrize(prizes, seedHex) {
  const weights = prizes.map((p) =>
    Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0,
  )
  const total = weights.reduce((sum, w) => sum + w, 0)
  const rng = mulberry32(seed32FromHex(seedHex))
  let roll = rng() * total
  let index = prizes.length - 1
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i]
    if (roll < 0) {
      index = i
      break
    }
  }
  const prize = prizes[index]
  return { name: prize.name, win: Boolean(prize.win) }
}

export function findCampaign(campaigns, campaignId) {
  return campaigns.find((c) => c.campaignId === campaignId) || null
}
