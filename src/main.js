/**
 * 页面入口 / 装配层。
 * 职责边界：只负责把各模块组装成页面——创建活动实例、渲染卡片列表、
 * 结果弹窗与提示条；不包含刮擦、覆盖率、状态机的具体实现。
 */
import './style.css'
import { createStore } from './storage.js'
import { createCampaign } from './campaign.js'
import { createScratchCard } from './card.js'

const CARD_IDS = ['card-1', 'card-2', 'card-3']
const DAILY_CHANCES = 3

// 中奖结果在"开始刮"那一刻按权重抽取并锁定持久化，刷新不重抽
const PRIZES = [
  { name: '88元 现金红包', weight: 5, win: true },
  { name: '免费咖啡一杯', weight: 10, win: true },
  { name: '8.8元 优惠券', weight: 15, win: true },
  { name: '谢谢参与', weight: 70, win: false },
]

const store = createStore('scratch-campaign-v1')
const campaign = createCampaign({
  store,
  cardIds: CARD_IDS,
  prizes: PRIZES,
  dailyChances: DAILY_CHANCES,
})

document.querySelector('#app').innerHTML = `
  <header class="site-header">
    <h1>幸运刮刮卡</h1>
    <p class="subtitle">每日 ${DAILY_CHANCES} 次机会，刮开涂层赢好礼</p>
    <p class="chances" id="chances" aria-live="polite"></p>
    <p class="storage-hint" id="storage-hint" hidden>当前环境不支持本地存储，刷新后进度不会保存</p>
  </header>
  <main class="cards" id="cards"></main>
  <div class="modal-backdrop" id="modal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title"></h2>
      <p id="modal-desc"></p>
      <div class="modal-actions">
        <button type="button" class="btn-primary" id="modal-claim"></button>
        <button type="button" class="btn-ghost" id="modal-close">稍后再说</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
`

const chancesEl = document.querySelector('#chances')
const storageHint = document.querySelector('#storage-hint')
const modal = document.querySelector('#modal')
const modalTitle = document.querySelector('#modal-title')
const modalDesc = document.querySelector('#modal-desc')
const modalClaim = document.querySelector('#modal-claim')
const modalClose = document.querySelector('#modal-close')
const toast = document.querySelector('#toast')

let toastTimer = null
function notify(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600)
}

let modalCardId = null
function openResultModal(cardId) {
  const card = campaign.getCard(cardId)
  if (!card || !card.prize) return
  modalCardId = cardId
  modalTitle.textContent = card.prize.win ? '🎉 恭喜中奖！' : '谢谢参与'
  modalDesc.textContent = card.prize.win
    ? `你获得了「${card.prize.name}」，领取后可在我的奖品中查看。`
    : '很遗憾这次没有中奖，明天再来试试手气吧。'
  modalClaim.textContent = card.prize.win ? '立即领取' : '知道了'
  modal.hidden = false
  modalClaim.focus()
}

function closeModal() {
  modal.hidden = true
  modalCardId = null
}

modalClaim.addEventListener('click', () => {
  if (modalCardId) campaign.claim(modalCardId)
  closeModal()
})
modalClose.addEventListener('click', closeModal)
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal()
})

const cards = CARD_IDS.map((id) =>
  createScratchCard({ id, campaign, notify, onRevealed: openResultModal }),
)
const cardsContainer = document.querySelector('#cards')
for (const card of cards) cardsContainer.appendChild(card.el)

function render() {
  const left = campaign.getChancesLeft()
  chancesEl.textContent = `今日剩余次数：${left} / ${DAILY_CHANCES}`
  chancesEl.classList.toggle('is-empty', left === 0)
  storageHint.hidden = store.isPersistent
  for (const card of cards) card.update()
}

campaign.onChange(render)
render()
