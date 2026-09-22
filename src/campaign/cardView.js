/**
 * 卡片视图。
 * 职责边界：DOM 组装、结果弹窗、按钮文案与状态展示；
 * 把用户操作翻译成控制器调用，自身不持有业务规则。
 *
 * 关键约束：手动刮满 60% 与"直接揭开"按钮都汇入同一个 reveal() 入口，
 * 走完全相同的状态机迁移（idle/scratching -> revealed -> claimed），无第二条结算路径。
 */

import { CARD_STATUS, REVEAL_THRESHOLD } from './stateMachine.js'
import { createScratchLayer } from './scratchLayer.js'
import { showToast } from './toast.js'

const STATUS_TEXT = {
  [CARD_STATUS.IDLE]: '未开始',
  [CARD_STATUS.SCRATCHING]: '刮刮中',
  [CARD_STATUS.REVEALED]: '待领取',
  [CARD_STATUS.CLAIMED]: '已领取',
}

const NO_ATTEMPTS_HINT = '今日刮卡次数已用完，明天再来吧'

export function createCardView(controller, cardId) {
  const root = document.createElement('article')
  root.className = 'card'

  const stage = document.createElement('div')
  stage.className = 'card-stage'

  const prizeLayer = document.createElement('div')
  prizeLayer.className = 'prize-layer'
  const prizeResult = document.createElement('p')
  prizeResult.className = 'prize-result'
  const prizeName = document.createElement('p')
  prizeName.className = 'prize-name'
  prizeLayer.append(prizeResult, prizeName)
  stage.appendChild(prizeLayer)

  const footer = document.createElement('div')
  footer.className = 'card-footer'
  const statusEl = document.createElement('span')
  statusEl.className = 'card-status'
  const actionBtn = document.createElement('button')
  actionBtn.type = 'button'
  actionBtn.className = 'card-action'
  footer.append(statusEl, actionBtn)

  root.append(stage, footer)

  const initialStatus = controller.getState().cards[cardId]?.status ?? CARD_STATUS.IDLE
  const needsCoating = initialStatus === CARD_STATUS.IDLE || initialStatus === CARD_STATUS.SCRATCHING

  let revealing = false

  // 已刮开/已领取的卡不再创建涂层（刷新后涂层不会回来）
  const layer = needsCoating
    ? createScratchLayer(stage, {
        threshold: REVEAL_THRESHOLD,
        onScratchStart: () => controller.startScratch(cardId).ok,
        onRejected: () => showToast(NO_ATTEMPTS_HINT),
        onReveal: () => reveal(),
      })
    : null

  /** 唯一结算入口：锁定结果（如未开始）-> 置为已刮开 -> 涂层淡出 -> 弹窗 */
  function reveal() {
    if (revealing) return
    const status = controller.getState().cards[cardId]?.status ?? CARD_STATUS.IDLE
    if (status === CARD_STATUS.IDLE) {
      if (!controller.startScratch(cardId).ok) {
        showToast(NO_ATTEMPTS_HINT)
        return
      }
    }
    if (!controller.completeReveal(cardId).ok) return
    revealing = true
    layer?.reveal()
    setTimeout(openDialog, 550) // 等涂层淡出动画播完再弹窗
  }

  function openDialog() {
    const card = controller.getState().cards[cardId]
    if (!card?.prize) return
    const dialog = document.createElement('dialog')
    dialog.className = 'result-dialog'
    dialog.setAttribute('aria-label', '刮卡结果')

    const result = document.createElement('p')
    result.className = 'dialog-result'
    result.textContent = card.prize.win ? '🎉 恭喜中奖' : '很遗憾，未中奖'

    const prize = document.createElement('p')
    prize.className = 'dialog-prize'
    prize.textContent = card.prize.name

    const form = document.createElement('form')
    form.method = 'dialog'
    const claimBtn = document.createElement('button')
    claimBtn.className = 'dialog-claim'
    claimBtn.value = 'claim'
    claimBtn.textContent = card.prize.win ? '领取奖励' : '知道了'
    form.appendChild(claimBtn)
    form.addEventListener('submit', () => controller.claim(cardId))

    dialog.append(result, prize, form)
    dialog.addEventListener('close', () => dialog.remove())
    document.body.appendChild(dialog)
    dialog.showModal()
  }

  actionBtn.addEventListener('click', () => {
    const status = controller.getState().cards[cardId]?.status ?? CARD_STATUS.IDLE
    if (status === CARD_STATUS.REVEALED) controller.claim(cardId)
    else reveal()
  })

  function render(state) {
    const card = state.cards[cardId]
    const status = card?.status ?? CARD_STATUS.IDLE
    statusEl.textContent = STATUS_TEXT[status]

    if (card?.prize) {
      prizeResult.textContent = card.prize.win ? '恭喜中奖' : '谢谢参与'
      prizeName.textContent = card.prize.name
      prizeLayer.classList.toggle('is-win', card.prize.win)
    } else {
      prizeResult.textContent = '刮开涂层'
      prizeName.textContent = '揭晓惊喜'
    }

    if (status === CARD_STATUS.REVEALED) {
      actionBtn.disabled = false
      actionBtn.textContent = card.prize?.win ? '领取奖励' : '知道了'
    } else if (status === CARD_STATUS.CLAIMED) {
      actionBtn.disabled = true
      actionBtn.textContent = '已领取'
    } else {
      actionBtn.disabled = false
      actionBtn.textContent = '直接揭开'
    }
  }

  const unsubscribe = controller.subscribe(render)
  render(controller.getState())

  root.destroy = () => {
    unsubscribe()
    layer?.destroy()
  }
  return root
}
