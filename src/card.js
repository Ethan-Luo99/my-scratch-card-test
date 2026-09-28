/**
 * 单张刮刮卡组件（DOM 组装与事件接线）。
 *
 * 渲染门控（设计 4.2，一票否决）：
 * - 未揭晓（idle/pending/expired）时奖品层只有固定占位文案，
 *   不创建、不填充任何奖品文本（含 aria/data/注释旁路）；
 * - 只有服务端 reveal 成功（status=revealed/claimed）后才把奖品写入 DOM；
 * - 公平性入口只在已揭晓卡上出现（由结果弹窗负责）。
 *
 * 交互（设计 4.5）：
 * - "先授权后擦除"：pointerdown 先 await begin，在途期间复用刮层 pending
 *   笔画缓冲且不产生可见擦除；成功才允许刮，失败提示且不擦除；
 * - 刮满 60% 与"直接揭开"走同一个 settle()；
 * - reveal/claim 网络失败用同一幂等键重试（控制器 + 缓存保证），
 *   绝不本地补结果；离线只读/锁定。
 */
import { CARD_STATUS } from './api/view.js'
import { createCoverageTracker } from './coverage.js'
import { createScratchLayer } from './scratch-layer.js'

export const CARD_WIDTH = 320
export const CARD_HEIGHT = 180
const REVEAL_THRESHOLD = 0.6

const PLACEHOLDER_RESULT = '幸运大奖'
const PLACEHOLDER_NAME = '刮开涂层揭晓'
const OFFLINE_HINT = '网络不可用，暂时无法刮卡'

/**
 * 纯展示决策（无 DOM 依赖，便于单测/验收断言）：
 * 根据公开视图返回奖品层应渲染的文本。未揭晓永远返回占位，不含奖品名。
 */
export function prizeLayerContent(card) {
  if (card && (card.status === CARD_STATUS.REVEALED || card.status === CARD_STATUS.CLAIMED) && card.prize) {
    return {
      result: card.prize.win ? '🎉 恭喜中奖' : '谢谢参与',
      name: card.prize.win ? card.prize.name : '好运正在路上',
      win: Boolean(card.prize.win),
      revealed: true,
    }
  }
  // 设计 4.2：未揭晓时只有固定占位，.prize-name 必须留空（涂层 canvas
  // 自身已绘制"刮开涂层 揭晓好礼"提示；此处不依赖 CSS 遮挡承担安全职责）
  return { result: PLACEHOLDER_NAME, name: '', win: false, revealed: false }
}

export function createScratchCard({ id, controller, notify, onRevealed }) {
  const el = document.createElement('div')
  el.className = 'scratch-card'
  el.dataset.state = CARD_STATUS.IDLE
  el.innerHTML = `
    <div class="card-frame">
      <div class="prize-layer">
        <span class="prize-result"></span>
        <span class="prize-name"></span>
      </div>
      <canvas class="scratch-canvas" aria-hidden="true"></canvas>
      <span class="card-status" hidden></span>
      <p class="card-lock-hint" hidden>${OFFLINE_HINT}</p>
    </div>
    <button type="button" class="reveal-btn"></button>
    <p class="card-action-hint" hidden></p>
  `
  const canvas = el.querySelector('.scratch-canvas')
  const prizeResult = el.querySelector('.prize-result')
  const prizeName = el.querySelector('.prize-name')
  const statusBadge = el.querySelector('.card-status')
  const lockHint = el.querySelector('.card-lock-hint')
  const revealBtn = el.querySelector('.reveal-btn')
  const actionHint = el.querySelector('.card-action-hint')

  let settled = false // 本涂层是否已完成"揭开呈现"（防止 60% 重复触发）
  let revealing = false // settle 请求在途（"揭晓中…"，涂层不淡出）

  const tracker = createCoverageTracker({ width: CARD_WIDTH, height: CARD_HEIGHT })

  /** 远程（其他标签页 / 刷新）已把本卡揭晓：本地补做呈现 */
  function syncSettled() {
    const card = controller.getCard(id)
    const revealed =
      card && (card.status === CARD_STATUS.REVEALED || card.status === CARD_STATUS.CLAIMED)
    if (revealed && !settled) {
      settled = true
      layer.setEnabled(false)
      tracker.reset()
      canvas.style.visibility = 'hidden'
      canvas.style.pointerEvents = 'none'
      return true
    }
    return false
  }

  const layer = createScratchLayer({
    canvas,
    logicalWidth: CARD_WIDTH,
    logicalHeight: CARD_HEIGHT,
    onStrokeStart() {
      return beginThenAllow()
    },
    onSegment(x0, y0, x1, y1) {
      tracker.stampSegment(x0, y0, x1, y1)
      if (!settled && !revealing && tracker.ratio() >= REVEAL_THRESHOLD) {
        void settle()
      }
    },
  })

  /** 首次落笔/直接揭开时的授权：begin 成功前涂层不做可见擦除 */
  async function beginThenAllow() {
    const card = controller.getCard(id)
    if (!card) return false
    if (!controller.online) {
      notify(OFFLINE_HINT)
      return false
    }
    if (card.status === CARD_STATUS.REVEALED || card.status === CARD_STATUS.CLAIMED) return true
    if (card.status === CARD_STATUS.PENDING || card.status === CARD_STATUS.EXPIRED) return true
    let result
    try {
      result = await controller.begin(id)
    } catch {
      notify('网络异常，请稍后重试')
      return false
    }
    if (!result.ok) {
      if (result.reason === 'no-chances') notify('今日刮卡次数已用完，明天再来吧')
      else if (result.reason === 'already-pending') return true
      else if (result.reason === 'offline') notify(OFFLINE_HINT)
      else if (result.reason !== 'busy') notify('暂时无法开始刮卡，请稍后重试')
      return result.reason === 'already-pending'
    }
    return true
  }

  /** 唯一结算入口（60% 与直接揭开共用）：成功前不淡出涂层、不弹结果 */
  async function settle() {
    if (settled || revealing) return
    const card = controller.getCard(id)
    if (card && (card.status === CARD_STATUS.REVEALED || card.status === CARD_STATUS.CLAIMED)) {
      presentRevealed()
      update()
      onRevealed(id)
      return
    }
    if (!controller.online) {
      notify('已占用本次机会，恢复网络后可继续刮开（结果已定，不会重摇）')
      return
    }
    revealing = true
    actionHint.hidden = false
    actionHint.textContent = '揭晓中…'
    try {
      const result = await controller.settle(id)
      if (!result.ok) {
        if (result.reason === 'offline') {
          actionHint.textContent = '网络中断，恢复后点击"重试揭晓"（结果已定，不会重摇）'
        } else {
          actionHint.textContent = '揭晓失败，点击"重试揭晓"（同一结果，不会重复扣次）'
        }
        revealBtn.hidden = false
        revealBtn.textContent = '重试揭晓'
        return
      }
      presentRevealed()
      update()
      onRevealed(id)
    } catch {
      actionHint.textContent = '网络异常，点击"重试揭晓"（同一结果，不会重复扣次）'
      revealBtn.hidden = false
      revealBtn.textContent = '重试揭晓'
    } finally {
      revealing = false
    }
  }

  function presentRevealed() {
    if (settled) return
    settled = true
    actionHint.hidden = true
    layer.fadeOut()
  }

  revealBtn.addEventListener('click', async () => {
    const card = controller.getCard(id)
    if (!card) return
    if (card.status === CARD_STATUS.REVEALED) {
      onRevealed(id)
      return
    }
    if (card.status === CARD_STATUS.CLAIMED) return
    if (!controller.online) {
      notify(OFFLINE_HINT)
      return
    }
    if (card.status === CARD_STATUS.IDLE) {
      const allowed = await beginThenAllow()
      if (!allowed) return
    }
    await settle()
  })

  /** 同步 UI（幂等，可反复调用；所有变更都来自控制器的服务端镜像） */
  function update() {
    const card = controller.getCard(id)
    if (!card) return
    const status = card.status
    el.dataset.state = status

    const content = prizeLayerContent(card)
    prizeResult.textContent = content.result
    prizeResult.classList.toggle('is-win', content.win)
    prizeName.textContent = content.name
    prizeName.classList.toggle('is-win', content.win)

    // 跨天/远程重置回 idle：复位涂层与覆盖率（未揭晓，下层仍只有占位）
    if (status === CARD_STATUS.IDLE && (settled || tracker.ratio() > 0)) {
      settled = false
      revealing = false
      tracker.reset()
      layer.reset()
    }

    const opened = status === CARD_STATUS.REVEALED || status === CARD_STATUS.CLAIMED
    if (opened) {
      syncSettled()
    } else if (!revealing) {
      actionHint.hidden = true
    }

    statusBadge.hidden = status !== CARD_STATUS.CLAIMED
    statusBadge.textContent = '已领取'

    const online = controller.online
    const busy = Boolean(card.busy)
    lockHint.hidden = online
    if (!online && (status === CARD_STATUS.PENDING || status === CARD_STATUS.EXPIRED)) {
      lockHint.textContent = '已占用本次机会，恢复网络后可继续刮开（结果已定，不会重摇）'
    } else {
      lockHint.textContent = OFFLINE_HINT
    }
    if (!online && !opened) {
      canvas.style.pointerEvents = 'none'
      layer.setEnabled(false)
    } else if (!opened && !busy) {
      canvas.style.pointerEvents = ''
      layer.setEnabled(true)
    }

    if (busy) {
      revealBtn.hidden = true
      return
    }

    if (status === CARD_STATUS.IDLE) {
      revealBtn.hidden = false
      revealBtn.textContent = online ? '直接揭开' : '网络不可用'
      revealBtn.disabled = !online
    } else if (status === CARD_STATUS.PENDING || status === CARD_STATUS.EXPIRED) {
      revealBtn.hidden = false
      revealBtn.textContent = online ? '直接揭开' : '网络不可用'
      revealBtn.disabled = !online
    } else if (status === CARD_STATUS.REVEALED) {
      revealBtn.hidden = false
      revealBtn.textContent = '领取奖励'
      revealBtn.disabled = false
    } else {
      revealBtn.hidden = true
    }
  }

  update()

  return { el, update }
}
