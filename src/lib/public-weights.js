/**
 * 已公开权重表（仅揭晓后公平性复核使用）。
 *
 * 红线：本模块不得被 begin/reveal/claim 等任何状态链路 import；
 * 只有揭晓后的公平性面板（src/main.js verify）可引用它做只读重算。
 * 未揭晓流程不需要权重表——结果永远由服务端决定并固定在承诺里。
 */
export const PUBLIC_WEIGHTS = Object.freeze({
  daily: Object.freeze({
    v1: Object.freeze([
      Object.freeze({ name: '88元 现金红包', weight: 5, win: true }),
      Object.freeze({ name: '免费咖啡一杯', weight: 10, win: true }),
      Object.freeze({ name: '8.8元 优惠券', weight: 15, win: true }),
      Object.freeze({ name: '谢谢参与', weight: 70, win: false }),
    ]),
  }),
  weekend: Object.freeze({
    v1: Object.freeze([
      Object.freeze({ name: 'iPhone 抽奖券', weight: 2, win: true }),
      Object.freeze({ name: '20 元红包', weight: 8, win: true }),
      Object.freeze({ name: '谢谢参与', weight: 90, win: false }),
    ]),
  }),
})

/** 取某活动某版本的公开权重（无版本返回 null） */
export function getPublicWeights(campaignId, weightsVersion) {
  const byCampaign = PUBLIC_WEIGHTS[campaignId]
  if (!byCampaign) return null
  return byCampaign[weightsVersion] ?? null
}
