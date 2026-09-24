/**
 * 服务端权威配置：活动元数据与按版本固化的权重表。
 *
 * 权重表按 campaignId + weightsVersion 版本化：一旦某张卡 begin，
 * 其 weightsVersion 固化在卡记录上，即便之后切换权重表，旧卡 reveal
 * 仍按 begin 时的版本开奖/复核，使历史承诺永不失效。
 */
export const ALGORITHM_ID = 'mulberry32-sha256-commit-v1'

export const WEIGHTS_VERSIONS = Object.freeze({
  'daily/v1': [
    { name: '88元 现金红包', weight: 5, win: true },
    { name: '免费咖啡一杯', weight: 10, win: true },
    { name: '8.8元 优惠券', weight: 15, win: true },
    { name: '谢谢参与', weight: 70, win: false },
  ],
  'daily/v2': [
    { name: '88元 现金红包', weight: 20, win: true },
    { name: '免费咖啡一杯', weight: 30, win: true },
    { name: '8.8元 优惠券', weight: 20, win: true },
    { name: '谢谢参与', weight: 30, win: false },
  ],
  'weekend/v1': [
    { name: 'iPhone 抽奖券', weight: 2, win: true },
    { name: '20 元红包', weight: 8, win: true },
    { name: '谢谢参与', weight: 90, win: false },
  ],
})

export const CAMPAIGNS = Object.freeze([
  {
    campaignId: 'daily',
    title: '每日刮刮卡',
    subtitle: '每日 3 次机会，刮开涂层赢好礼',
    dailyChances: 3,
    cardIds: ['daily-1', 'daily-2', 'daily-3'],
    weightsVersion: 'v1',
  },
  {
    campaignId: 'weekend',
    title: '周末狂欢卡',
    subtitle: '周末限定：每日 5 次机会，赢 iPhone 抽奖券',
    dailyChances: 5,
    cardIds: ['weekend-1', 'weekend-2', 'weekend-3', 'weekend-4'],
    weightsVersion: 'v1',
  },
])

/** 默认权威配置工厂（campaigns/weights 可整体注入，便于单测切版本） */
export function createDefaultConfig(overrides = {}) {
  const campaigns = overrides.campaigns ?? CAMPAIGNS
  const weightsVersions = overrides.weightsVersions ?? WEIGHTS_VERSIONS
  return {
    campaigns,
    getCampaign(campaignId) {
      return campaigns.find((campaign) => campaign.campaignId === campaignId) ?? null
    },
    getWeights(campaignId, weightsVersion) {
      const key = `${campaignId}/${weightsVersion}`
      return Object.prototype.hasOwnProperty.call(weightsVersions, key)
        ? weightsVersions[key]
        : null
    },
  }
}
