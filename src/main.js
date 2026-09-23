/**
 * 页面装配层：只负责把引擎/纯逻辑模块组装成页面，不含任何业务规则。
 * 同一后端单例 + 每活动独立命名空间 key / 通道 / 锁，两个活动状态完全隔离。
 */
import './style.css'
import { createKvBackend } from './storage/backend.js'
import { createSyncChannel, createLockManager, createSenderId } from './storage/sync.js'
import { createCampaign } from './campaign.js'
import { createScratchCard } from './card.js'

const DAILY_PRIZES = [
  { name: '88元 现金红包', weight: 5, win: true },
  { name: '免费咖啡一杯', weight: 10, win: true },
  { name: '8.8元 优惠券', weight: 15, win: true },
  { name: '谢谢参与', weight: 70, win: false },
]

const WEEKEND_PRIZES = [
  { name: 'iPhone 抽奖券', weight: 2, win: true },
  { name: '20 元红包', weight: 8, win: true },
  { name: '谢谢参与', weight: 90, win: false },
]

const CAMPAIGNS_CONFIG = [
  {
    id: 'daily',
    title: '每日刮刮卡',
    subtitle: '每日 3 次机会，刮开涂层赢好礼',
    cardIds: ['daily-1', 'daily-2', 'daily-3'],
    prizes: DAILY_PRIZES,
    dailyChances: 3,
    theme: 'daily',
  },
  {
    id: 'weekend',
    title: '周末狂欢卡',
    subtitle: '周末限定：每日 5 次机会，赢 iPhone 抽奖券',
    cardIds: ['weekend-1', 'weekend-2', 'weekend-3', 'weekend-4'],
    prizes: WEEKEND_PRIZES,
    dailyChances: 5,
    theme: 'weekend',
  },
]

const backend = createKvBackend()
const locks = createLockManager()
const senderId = createSenderId()

document.querySelector('#app').innerHTML = `
  <header class="site-header">
    <h1>幸运刮刮卡</h1>
    <p class="subtitle">多活动同台 · 多标签页共享每日次数 · 开奖可验证</p>
    <p class="storage-hint" id="storage-hint" hidden>
      当前环境不支持本地存储，已切换为单标签页临时模式，刷新后进度不会保存
    </p>
  </header>
  <main id="campaigns"></main>
  <div class="modal-backdrop" id="modal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title"></h2>
      <p id="modal-desc"></p>
      <button type="button" class="verify-toggle" id="verify-toggle" hidden>🔍 公平性验证</button>
      <div class="verify-panel" id="verify-panel" hidden></div>
      <div class="modal-actions">
        <button type="button" class="btn-primary" id="modal-claim"></button>
        <button type="button" class="btn-ghost" id="modal-close">稍后再说</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`

const storageHint = document.querySelector('#storage-hint')
const modal = document.querySelector('#modal')
const modalTitle = document.querySelector('#modal-title')
const modalDesc = document.querySelector('#modal-desc')
const modalClaim = document.querySelector('#modal-claim')
const modalClose = document.querySelector('#modal-close')
const verifyToggle = document.querySelector('#verify-toggle')
const verifyPanel = document.querySelector('#verify-panel')
const toast = document.querySelector('#toast')

let toastTimer = null
function notify(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600)
}

// 单弹窗复用于所有活动：记录当前弹窗归属的活动与卡片
let modalCampaignId = null
let modalCardId = null
const instances = new Map()

function openResultModal(campaignId, cardId) {
  const campaign = instances.get(campaignId)
  const card = campaign.getCard(cardId)
  if (!card || !card.prize) return
  modalCampaignId = campaignId
  modalCardId = cardId
  modalTitle.textContent = card.prize.win ? '🎉 恭喜中奖！' : '谢谢参与'
  modalDesc.textContent = card.prize.win
    ? `你获得了「${card.prize.name}」，领取后可在其他页面查看。`
    : '很遗憾这次没有中奖，明天再来试试手气吧。'
  modalClaim.textContent = card.prize.win ? '立即领取' : '知道了'
  // 旧格式迁移来的卡没有 seed（当时还不是可验证开奖），不展示验证入口
  verifyToggle.hidden = card.seed == null
  verifyToggle.textContent = '🔍 公平性验证'
  verifyPanel.hidden = true
  verifyPanel.innerHTML = ''
  modal.hidden = false
  modalClaim.focus()
}

function closeModal() {
  modal.hidden = true
  modalCampaignId = null
  modalCardId = null
}

modalClaim.addEventListener('click', async () => {
  if (!modalCampaignId) return closeModal()
  const campaign = instances.get(modalCampaignId)
  const card = campaign.getCard(modalCardId)
  // 无论中奖与否都推进 claim（与旧行为一致：'知道了'也会结算为已领取），
  // 保证"已刮开未领取"中间态不会永远悬挂
  const result = await campaign.claim(modalCardId)
  if (!result.ok) {
    if (card && card.prize && card.prize.win) {
      notify('领取失败：该奖品已在其他标签页被领取（先到先得）')
    }
    closeModal()
    return
  }
  if (card && card.prize && card.prize.win) {
    notify('领取成功，可在"我的奖品"中查看')
  }
  closeModal()
})
modalClose.addEventListener('click', closeModal)
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal()
})

verifyToggle.addEventListener('click', () => {
  if (!modalCampaignId) return
  const campaign = instances.get(modalCampaignId)
  const report = campaign.verify(modalCardId)
  if (!report) return
  verifyPanel.hidden = false
  verifyPanel.innerHTML = `
    <dl>
      <dt>随机种子 seed</dt><dd>${report.seed}</dd>
      <dt>FNV-1a 哈希</dt><dd>${report.seedHash}</dd>
      <dt>哈希校验</dt><dd>${report.hashMatches ? '✅ 一致' : '❌ 不一致'}</dd>
      <dt>重算奖品</dt><dd>${report.prize.name}</dd>
      <dt>结果核对</dt><dd>${report.prizeMatches ? '✅ 与锁定奖品一致' : '❌ 不一致'}</dd>
    </dl>
    <p class="verify-note">seed 在你按下刮卡的瞬间才生成并持久化，奖品由 mulberry32(seed)
      按权重确定性开出；任何人都可用同一 seed 重放出完全相同的结果。</p>
  `
  verifyToggle.textContent = '✅ 已验证'
})

function createCampaignInstance(cfg) {
  const key = `scratch-campaign:v2:${cfg.id}`
  const syncChannel = createSyncChannel({
    name: `scratch-campaign:sync:${cfg.id}`,
    storageKey: key,
    backend,
    senderId,
  })
  return createCampaign({
    id: cfg.id,
    title: cfg.title,
    key,
    cardIds: cfg.cardIds,
    prizes: cfg.prizes,
    dailyChances: cfg.dailyChances,
    backend,
    syncChannel,
    locks,
    // 只有原每日刮刮卡（旧 key scratch-campaign-v1）需要无损迁移
    legacyKey: cfg.id === 'daily' ? 'scratch-campaign-v1' : null,
  })
}

async function main() {
  const root = document.querySelector('#campaigns')

  for (const cfg of CAMPAIGNS_CONFIG) {
    const campaign = createCampaignInstance(cfg)
    await campaign.init()
    instances.set(cfg.id, campaign)

    const section = document.createElement('section')
    section.className = 'campaign'
    section.dataset.theme = cfg.theme
    section.innerHTML = `
      <div class="campaign-head">
        <h2>${cfg.title}</h2>
        <p class="campaign-sub">${cfg.subtitle}</p>
        <p class="chances" aria-live="polite"></p>
        <p class="time-anomaly" hidden>⚠️ 检测到系统时间异常，今日次数与状态继续沿用</p>
      </div>
      <div class="cards"></div>
    `
    const chancesEl = section.querySelector('.chances')
    const anomalyEl = section.querySelector('.time-anomaly')
    const grid = section.querySelector('.cards')

    const cards = cfg.cardIds.map((cardId) =>
      createScratchCard({
        id: cardId,
        campaign,
        notify,
        onRevealed: (id) => openResultModal(cfg.id, id),
      }),
    )
    for (const card of cards) grid.appendChild(card.el)
    root.appendChild(section)

    // 每个活动只刷新自己的页头与自己的卡片（订阅在 init 之后注册，
    // 不会收到初始化前的事件；本地/远程变更都走同一条渲染路径）
    campaign.onChange((snapshot) => {
      const left = Math.max(0, cfg.dailyChances - snapshot.chancesUsed)
      chancesEl.textContent = `今日剩余次数：${left} / ${cfg.dailyChances}`
      chancesEl.classList.toggle('is-empty', left === 0)
      anomalyEl.hidden = !snapshot.timeAnomaly
      for (const card of cards) card.update()
    })
    // 首帧
    const firstLeft = campaign.getChancesLeft()
    chancesEl.textContent = `今日剩余次数：${firstLeft} / ${cfg.dailyChances}`
    chancesEl.classList.toggle('is-empty', firstLeft === 0)
    anomalyEl.hidden = !campaign.snapshot.timeAnomaly
  }

  storageHint.hidden = backend.isPersistent
}

main()
