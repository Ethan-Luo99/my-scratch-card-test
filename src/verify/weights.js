/**
 * 公开权重快照（仅揭晓后复核使用）。
 *
 * 这些权重本来就是公开信息；关键是：本模块只被公平性面板在"已揭晓"后
 * 动态 import，不进入 begin/刮擦链路，绝不存在"收到 seed → 本地 draw
 * 决定状态/结果"的业务调用。真正的开奖与记账永远在服务端。
 *
 * 版本键与服务端 server/core/config.js 的 `<campaignId>/<weightsVersion>` 对齐。
 */
export const PUBLIC_WEIGHTS = Object.freeze({
  'daily/v1': [
    { name: '88元 现金红包', weight: 5, win: true },
    { name: '免费咖啡一杯', weight: 10, win: true },
    { name: '8.8元 优惠券', weight: 15, win: true },
    { name: '谢谢参与', weight: 70, win: false },
  ],
  'weekend/v1': [
    { name: 'iPhone 抽奖券', weight: 2, win: true },
    { name: '20 元红包', weight: 8, win: true },
    { name: '谢谢参与', weight: 90, win: false },
  ],
})

export function getReviewWeights(campaignId, weightsVersion) {
  const key = `${campaignId}/${weightsVersion}`
  return Object.prototype.hasOwnProperty.call(PUBLIC_WEIGHTS, key)
    ? PUBLIC_WEIGHTS[key]
    : null
}
