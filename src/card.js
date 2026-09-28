/**
 * 单张刮刮卡组件（DOM 组装与事件接线，可任意实例化复用）。
 *
 * 安全门控（核心）：
 * - 未揭晓（idle/pending）时奖品层文本节点保持为空，奖品名/中奖文案不进入
 *   DOM（不含文本、aria、data、注释等任何旁路）；涂层仅做视觉动画，
 *   "遮挡"不承担安全职责——未揭晓时下层本来就没有奖品内容；
 * - 只有 reveal 成功响应到达后才写入 prize 文本。
 *
 * 结算路径唯一：刮满 60% 与"直接揭开"走同一个 settle() -> campaign.reveal()；
 * begin 在途时复用刮层的 pending 笔画缓冲，涂层不产生可见擦除；
 * reveal/claim 网络失败只可同幂等键重试，绝不本地补结果。
 */
import { CARD_STATUS } from './campaign.js'
import { effectiveStatus } from './lib/view.js'
import { createCoverageTracker } from './coverage.js'
import { createScratchLayer } from './scratch-layer.js'

export const CARD_WIDTH = 320
export const CARD_HEIGHT = 180
const REVEAL_THRESHOLD = 0.6

export function createScratchCard({ id, campaign, notify, onRevealed }) {
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
      <span class="card-busy" hidden></span>
    </div>
    <button type="button" class="reveal-btn"></button>
  `
  const canvas = el.querySelector('.scratch-canvas')
  const prizeResult = el.querySelector('.prize-result')
  const prizeName = el.querySelector('.prize-name')
  const statusBadge = el.querySelector('.card-status')
  const busyHint = el.querySelector('.card-busy')
  const revealBtn = el.querySelector('.reveal-btn')

  let settled = false // 涂层是否已淡出（纯表现态，不参与任何裁决）
  let revealing = false // reveal 在途：单防重复提交
  let beginInFlight = false

  const tracker = createCoverageTracker({
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  })

  function currentCard() {
    return campaign.getCard(id)
  }

  function isRevealed(card) {
    return Boolean(card) && (card.status === CARD_STATUS.REVEALED || card.status === CARD_STATUS.CLAIMED)
  }

  /** 远程/他页已揭晓而本页尚未淡出涂层：补上呈现（不产生任何结果） */
  function syncSettled() {
    const card = currentCard()
    if (isRevealed(card) && !settled) {
      settled = true
      layer.setEnabled(false)
      tracker.reset()
      canvas.style.visibility = 'hidden'
      canvas.style.pointerEvents = 'none'
    }
  }

  const layer = createScratchLayer({
    canvas,
    logicalWidth: CARD_WIDTH,
    logicalHeight: CARD_HEIGHT,
    async onStrokeStart() {
      const card = currentCard()
      if (!card) return false
      // 已揭晓/已领取：涂层不可刮
      if (isRevealed(card)) return false
      // 离线锁定：只读，不发起任何写请求
      if (campaign.snapshot.offline) {
        notify('网络不可用，暂时无法刮卡，已揭晓内容仍可离线查看')
        return false
      }
      // 刷新恢复 / 他页已 begin：服务端已有同一 pending，直接允许继续刮，
      // 不重新扣费（结果早已在服务端固定，不会重摇）
      if (card.status === CARD_STATUS.PENDING) return true
      if (beginInFlight) return false
      beginInFlight = true
      try {
        const result = await campaign.beginScratch(id)
        if (!result.ok) {
          if (result.reason === 'already-pending') return true
          if (result.reason === 'no-chances') {
            notify('今日刮卡次数已用完，明天再来吧')
            return false
          }
          // invalid-state：多半已被他页揭晓，刷新视图后拒绝本次擦除
          return false
        }
        return true
      } catch {
        notify('网络不给力，开始刮卡失败，请稍后重试（不会消耗次数）')
        return false
      } finally {
        beginInFlight = false
      }
    },
    onSegment(x0, y0, x1, y1) {
      tracker.stampSegment(x0, y0, x1, y1)
      if (!settled && !revealing && tracker.ratio() >= REVEAL_THRESHOLD) {
        void settle()
      }
    },
  })

  function setBusy(text) {
    busyHint.hidden = !text
    busyHint.textContent = text ?? ''
  }

  /** 唯一结算入口（60% 与直接揭开共用）：成功才淡出涂层、弹窗 */
  async function settle() {
    if (settled || revealing) {
      const card = currentCard()
      if (isRevealed(card)) onRevealed(id)
      return
    }
    const card = currentCard()
    if (isRevealed(card)) {
      settled = true
      layer.fadeOut()
      onRevealed(id)
      return
    }
    if (card.status !== CARD_STATUS.PENDING) {
      // 还未成功 begin：不揭晓
      return
    }
    revealing = true
    setBusy('揭晓中…')
    let result
    try {
      result = await campaign.reveal(id)
    } catch {
      // 网络失败：卡仍是服务端 pending，进度保留，提供重试，绝不本地补结果
      setBusy('揭晓失败，点击此处重试')
      revealing = false
      return
    }
    revealing = false
    if (!result.ok) {
      setBusy(null)
      if (result.reason === 'invalid-state' || result.reason === 'already-claimed') {
        // 他页/重试对齐：以服务端视图为准
        syncSettled()
        const latest = currentCard()
        if (isRevealed(latest)) onRevealed(id)
        return
      }
      if (result.reason === 'conflict') {
        setBusy('状态已在其他标签页更新，点击此处重试揭晓')
        return
      }
      setBusy('揭晓失败，点击此处重试')
      return
    }
    setBusy(null)
    settled = true
    layer.fadeOut()
    onRevealed(id)
  }

  // busy 提示点击 = 用同一幂等键重试揭晓
  busyHint.addEventListener('click', () => {
    if (!busyHint.hidden && !revealing) void settle()
  })

  // "直接揭开"：键盘可达的无障碍路径，与手动刮开走完全相同的流转
  revealBtn.addEventListener('click', async () => {
    const card = currentCard()
    if (!card || campaign.snapshot.offline) {
      notify('网络不可用，暂时无法刮卡')
      return
    }
    if (isRevealed(card)) {
      onRevealed(id) // 已刮开未领取：重新打开结果弹窗去领取
      return
    }
    if (card.status === CARD_STATUS.IDLE) {
      const begin = await campaign.beginScratch(id).catch(() => null)
      if (!begin) {
        notify('网络不给力，开始刮卡失败，请稍后重试（不会消耗次数）')
        return
      }
      if (!begin.ok && begin.reason !== 'already-pending') {
        if (begin.reason === 'no-chances') notify('今日刮卡次数已用完，明天再来吧')
        return
      }
    }
    await settle()
  })

  /** 根据服务端镜像同步 UI（幂等，可反复调用，含远程/离线更新） */
  function update() {
    const card = currentCard()
    if (!card) return
    const offline = Boolean(campaign.snapshot.offline)
    el.dataset.state = effectiveStatus(card)

    if (isRevealed(card) && card.prize) {
      // 奖品文本只在揭晓后写入 DOM
      prizeResult.textContent = card.prize.win ? '🎉 恭喜中奖' : '谢谢参与'
      prizeResult.classList.toggle('is-win', card.prize.win)
      prizeName.textContent = card.prize.win ? card.prize.name : '好运正在路上'
    } else {
      // 未揭晓：文本节点留空，不写任何奖品相关内容（含占位伪装）
      prizeResult.textContent = ''
      prizeResult.classList.remove('is-win')
      prizeName.textContent = ''
    }

    // 跨天重置（服务端视图回到 idle）：复位涂层与覆盖率
    if (card.status === CARD_STATUS.IDLE && settled) {
      settled = false
      tracker.reset()
      layer.reset()
      setBusy(null)
    }

    syncSettled()

    statusBadge.hidden = card.status !== CARD_STATUS.CLAIMED
    statusBadge.textContent = card.status === CARD_STATUS.CLAIMED ? '已领取' : ''

    if (offline && !isRevealed(card)) {
      revealBtn.hidden = true
      layer.setEnabled(false)
      // 设计 5.1：进行中（已 begin 未 reveal）且离线：保持涂层，
      // 明确告知"机会已占用、结果已定，恢复网络后可继续刮开（不会重摇）"
      if (card.status === CARD_STATUS.PENDING) {
        setBusy('已占用本次机会，恢复网络后可继续刮开（结果已定，不会重摇）')
      } else {
        setBusy('网络不可用，暂时无法刮卡')
      }
    } else {
      layer.setEnabled(!settled)
      // 在线时清掉离线提示（揭晓失败重试提示由 settle 自行管理）
      if (!revealing && busyHint.textContent.includes('网络')) setBusy(null)
      if (card.status === CARD_STATUS.IDLE || card.status === CARD_STATUS.PENDING) {
        revealBtn.hidden = false
        revealBtn.textContent = '直接揭开'
        revealBtn.disabled = revealing
      } else if (card.status === CARD_STATUS.REVEALED) {
        revealBtn.hidden = false
        revealBtn.textContent = '领取奖励'
        revealBtn.disabled = false
      } else {
        revealBtn.hidden = true
      }
    }

    // 恢复在线且涂层已刮满阈值：续接同一 settle（同幂等键，结果不会重摇）
    if (
      !offline &&
      !settled &&
      !revealing &&
      card.status === CARD_STATUS.PENDING &&
      tracker.ratio() >= REVEAL_THRESHOLD
    ) {
      void settle()
    }
  }

  update()

  return { el, update }
}
