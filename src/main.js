/**
 * 页面入口 / 装配层（无业务规则，只做组装与 DOM 接线）。
 * 同页运行两个完全隔离的活动实例，共用一个 KV 后端与一套卡片/刮层组件，
 * 各自拥有独立命名空间存储、奖池、次数与状态。
 */
import './style.css'
import { createKvBackend } from './storage/backend.js'
import { createCampaign, CARD_STATE } from './campaign.js'
import { createScratchCard } from './card.js'
import { LEGACY_KEY } from './lib/migration.js'

// ---------- 活动配置（纯数据，加活动只需加一份配置 + 一个区块） ----------

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

const CAMPAIGN_DEFS = [
  {
    namespace: 'daily',
    title: '每日刮刮卡',
    subtitle: '每日 3 次机会，刮开涂层赢好礼',
    cardIds: ['card-1', 'card-2', 'card-3'],
    prizes: DAILY_PRIZES,
    dailyChances: 3,
    tone: 'tone-daily',
    legacyKey: LEGACY_KEY, // 仅原单实例活动承接旧格式数据迁移
  },
  {
    namespace: 'weekend',
    title: '周末狂欢卡',
    subtitle: '周末限定：每日 5 次，iPhone 抽奖券等你拿',
    cardIds: ['card-1', 'card-2', 'card-3', 'card-4'],
    prizes: WEEKEND_PRIZES,
    dailyChances: 5,
    tone: 'tone-weekend',
  },
]

// 单一后端：storage 事件只注册一次，按 key 扇出给两个活动实例
const backend = createKvBackend()

// ---------- 页面骨架 ----------

document.querySelector('#app').innerHTML = `
  <header class="site-header">
    <h1>幸运刮刮卡</h1>
    <p class="subtitle">多活动同时进行，每个活动独立计次、独立奖池</p>
    <p class="storage-hint" id="storage-hint" hidden>
      当前环境不支持本地存储或跨标签页同步，进度可能不会保存或共享
    </p>
  </header>
  <main id="campaigns"></main>
  <div class="modal-backdrop" id="modal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title"></h2>
      <p id="modal-desc"></p>
      <div class="fairness" id="fairness" hidden>
        <button type="button" class="btn-link" id="fairness-toggle">验证公平性</button>
        <dl class="fairness-panel" id="fairness-panel" hidden>
          <dt>随机种子 seed</dt><dd id="fairness-seed"></dd>
          <dt>种子哈希 (FNV-1a)</dt><dd id="fairness-hash"></dd>
          <dt>重算奖品</dt><dd id="fairness-prize"></dd>
          <dt>校验结果</dt><dd id="fairness-check"></dd>
        </dl>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-primary" id="modal-claim"></button>
        <button type="button" class="btn-ghost" id="modal-close">稍后再说</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`

const storageHint = document.querySelector('#storage-hint')
const campaignsRoot = document.querySelector('#campaigns')
const modal = document.querySelector('#modal')
const modalTitle = document.querySelector('#modal-title')
const modalDesc = document.querySelector('#modal-desc')
const modalClaim = document.querySelector('#modal-claim')
const modalClose = document.querySelector('#modal-close')
const fairnessBox = document.querySelector('#fairness')
const fairnessToggle = document.querySelector('#fairness-toggle')
const fairnessPanel = document.querySelector('#fairness-panel')
const fairnessSeed = document.querySelector('#fairness-seed')
const fairnessHash = document.querySelector('#fairness-hash')
const fairnessPrize = document.querySelector('#fairness-prize')
const fairnessCheck = document.querySelector('#fairness-check')
const toast = document.querySelector('#toast')

let toastTimer = null
function notify(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600)
}

// ---------- 结果弹窗（所有活动共用，靠 modalContext 区分来源实例） ----------

let modalContext = null // { campaign, cardId }

function openResultModal(campaign, cardId) {
  const card = campaign.getCard(cardId)
  if (!card || !card.prize) return
  modalContext = { campaign, cardId }
  modalTitle.textContent = card.prize.win ? '🎉 恭喜中奖！' : '谢谢参与'
  modalDesc.textContent = card.prize.win
    ? `你获得了「${card.prize.name}」，领取后可在我的奖品中查看。`
    : '很遗憾这次没有中奖，明天再来试试手气吧。'
  modalClaim.hidden = card.state !== CARD_STATE.REVEALED
  modalClaim.textContent = card.prize.win ? '立即领取' : '知道了'

  const proof = campaign.getFairnessProof(cardId)
  fairnessBox.hidden = !proof
  fairnessPanel.hidden = true
  fairnessToggle.textContent = '验证公平性'
  if (proof) {
    fairnessSeed.textContent = String(proof.seed)
    fairnessHash.textContent = proof.seedHash
    fairnessPrize.textContent = `${proof.recomputed.name}（${proof.recomputed.win ? '中奖' : '未中奖'}）`
    fairnessCheck.textContent = proof.hashMatches
      ? '哈希一致，重算奖品与刮开结果相同 ✓'
      : '哈希不一致 ✗'
  }
  modal.hidden = false
  modalClaim.focus()
}

fairnessToggle.addEventListener('click', () => {
  fairnessPanel.hidden = !fairnessPanel.hidden
  fairnessToggle.textContent = fairnessPanel.hidden ? '验证公平性' : '收起验证信息'
})

function closeModal() {
  modal.hidden = true
  modalContext = null
}

modalClaim.addEventListener('click', async () => {
  if (!modalContext) {
    closeModal()
    return
  }
  const { campaign, cardId } = modalContext
  const result = await campaign.claim(cardId)
  if (!result.ok) {
    // 先到先得：其他标签页已领取（或状态已变化）
    notify('手慢一步，该奖品已在其他标签页被领取')
  } else if (result.card && result.card.prize && result.card.prize.win) {
    notify('领取成功，奖品已存入我的奖品')
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

// ---------- 实例化两个活动（区块、卡片、渲染全部按实例复用） ----------

for (const def of CAMPAIGN_DEFS) {
  const campaign = createCampaign({
    namespace: def.namespace,
    cardIds: def.cardIds,
    prizes: def.prizes,
    dailyChances: def.dailyChances,
    backend,
    legacyKey: def.legacyKey ?? null,
  })

  const section = document.createElement('section')
  section.className = `campaign-block ${def.tone}`
  section.innerHTML = `
    <div class="campaign-head">
      <h2>${def.title}</h2>
      <p class="campaign-sub">${def.subtitle}</p>
      <p class="chances" aria-live="polite"></p>
      <p class="time-warn" hidden>⚠️ 检测到系统时间异常，今日次数与进度继续沿用</p>
    </div>
    <div class="cards"></div>
  `
  const chancesEl = section.querySelector('.chances')
  const timeWarnEl = section.querySelector('.time-warn')
  const cardsContainer = section.querySelector('.cards')

  const cards = def.cardIds.map((cardId) =>
    createScratchCard({
      id: cardId,
      campaign,
      notify,
      onRevealed: (id) => openResultModal(campaign, id),
    }),
  )
  for (const card of cards) cardsContainer.appendChild(card.el)

  campaign.onChange(() => render())

  function render() {
    const left = campaign.getChancesLeft()
    chancesEl.textContent = `今日剩余次数：${left} / ${def.dailyChances}`
    chancesEl.classList.toggle('is-empty', left === 0)
    timeWarnEl.hidden = !campaign.isTimeAnomaly()
    for (const card of cards) card.update()
  }

  render()
  campaignsRoot.appendChild(section)
}

storageHint.hidden = backend.isPersistent
