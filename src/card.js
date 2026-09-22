/**
 * 单张刮刮卡组件。
 * 职责边界：DOM 组装与事件接线——组合刮层引擎、覆盖率检测与活动状态机，
 * 自身不实现任何业务规则（次数/概率/状态迁移都在 campaign 中）。
 * 通过 createScratchCard 工厂创建，可任意实例化多张复用。
 *
 * 结算路径唯一：无论"刮满 60%"还是点击"直接揭开"按钮，
 * 都走同一个 settle() -> campaign.reveal() -> 涂层淡出 -> 结果弹窗。
 */
import { CARD_STATE } from './campaign.js'
import { createCoverageTracker } from './coverage.js'
import { createScratchLayer } from './scratch-layer.js'

export const CARD_WIDTH = 320
export const CARD_HEIGHT = 180
const REVEAL_THRESHOLD = 0.6

export function createScratchCard({ id, campaign, notify, onRevealed }) {
  const el = document.createElement('div')
  el.className = 'scratch-card'
  el.dataset.state = CARD_STATE.IDLE
  el.innerHTML = `
    <div class="card-frame">
      <div class="prize-layer">
        <span class="prize-result"></span>
        <span class="prize-name"></span>
      </div>
      <canvas class="scratch-canvas" aria-hidden="true"></canvas>
      <span class="card-status" hidden></span>
    </div>
    <button type="button" class="reveal-btn"></button>
  `
  const canvas = el.querySelector('.scratch-canvas')
  const prizeResult = el.querySelector('.prize-result')
  const prizeName = el.querySelector('.prize-name')
  const statusBadge = el.querySelector('.card-status')
  const revealBtn = el.querySelector('.reveal-btn')

  let settled = false // 是否已触发过结算（防止阈值判定重复触发）

  const tracker = createCoverageTracker({
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  })

  const layer = createScratchLayer({
    canvas,
    logicalWidth: CARD_WIDTH,
    logicalHeight: CARD_HEIGHT,
    onStrokeStart() {
      // 开始刮的那一刻：扣次数、锁定奖品（幂等，同一笔划只生效一次）
      const result = campaign.beginScratch(id)
      if (!result.ok) {
        if (result.reason === 'no-chances') {
          notify('今日刮卡次数已用完，明天再来吧')
        }
        return false // 拒绝后本次笔画不生效，涂层刮不开
      }
      return true
    },
    onSegment(x0, y0, x1, y1) {
      tracker.stampSegment(x0, y0, x1, y1)
      if (!settled && tracker.ratio() >= REVEAL_THRESHOLD) {
        settle()
      }
    },
  })

  /** 唯一结算入口：状态机推进 + 涂层淡出 + 结果弹窗 */
  function settle() {
    if (settled) return
    const result = campaign.reveal(id)
    if (!result.ok) return
    settled = true
    layer.fadeOut()
    onRevealed(id)
  }

  // "直接揭开"按钮：键盘可达的无障碍路径，与手动刮开走完全相同的流转
  revealBtn.addEventListener('click', () => {
    const card = campaign.getCard(id)
    if (card.state === CARD_STATE.IDLE) {
      const result = campaign.beginScratch(id)
      if (!result.ok) {
        if (result.reason === 'no-chances') {
          notify('今日刮卡次数已用完，明天再来吧')
        }
        return
      }
      settle()
    } else if (card.state === CARD_STATE.REVEALED) {
      onRevealed(id) // 已刮开未领取：重新打开结果弹窗去领取
    }
  })

  /** 根据状态机快照同步 UI（幂等，可反复调用） */
  function update() {
    const card = campaign.getCard(id)
    el.dataset.state = card.state

    if (card.prize) {
      prizeResult.textContent = card.prize.win ? '🎉 恭喜中奖' : '谢谢参与'
      prizeResult.classList.toggle('is-win', card.prize.win)
      prizeName.textContent = card.prize.win ? card.prize.name : '好运正在路上'
    } else {
      prizeResult.textContent = '幸运大奖'
      prizeResult.classList.remove('is-win')
      prizeName.textContent = '刮开涂层揭晓'
    }

    const revealed = card.state === CARD_STATE.REVEALED || card.state === CARD_STATE.CLAIMED
    if (revealed && !settled) {
      // 刷新恢复：已刮开的卡直接隐藏涂层，不播放动画、不重刮
      settled = true
      layer.setEnabled(false)
      canvas.style.visibility = 'hidden'
      canvas.style.pointerEvents = 'none'
    }

    statusBadge.hidden = card.state !== CARD_STATE.CLAIMED
    statusBadge.textContent = '已领取'

    if (card.state === CARD_STATE.IDLE) {
      revealBtn.hidden = false
      revealBtn.textContent = '直接揭开'
    } else if (card.state === CARD_STATE.REVEALED) {
      revealBtn.hidden = false
      revealBtn.textContent = '领取奖励'
    } else {
      revealBtn.hidden = true
    }
  }

  update()

  return { el, update }
}
