/**
 * 单张刮刮卡组件（DOM 组装与事件接线，可任意实例化复用）。
 * 组合刮层引擎、覆盖率检测与活动实例引擎；自身不实现任何业务规则。
 *
 * 结算路径唯一：无论"刮满 60%"还是点击"直接揭开"按钮，
 * 都走同一个 settle() -> campaign.reveal() -> 涂层淡出 -> 结果弹窗。
 * beginScratch / reveal / claim 均为异步（跨标签页锁 + CAS 提交），
 * 等待授权期间涂层不做任何擦除，防止"先擦后失败"的乐观 UI 回滚。
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

  /** 跨标签页远程更新可能把本卡推进到 revealed/claimed：若尚未结算则补上呈现 */
  function syncSettled() {
    const card = campaign.getCard(id)
    const revealed =
      card && (card.state === CARD_STATE.REVEALED || card.state === CARD_STATE.CLAIMED)
    if (revealed && !settled) {
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
    onStrokeStart() {
      // 开始刮的那一刻：锁内扣次数、生成 seed 并锁定奖品（幂等：重刮不重复扣）
      return campaign.beginScratch(id).then((result) => {
        if (!result.ok) {
          if (result.reason === 'no-chances') {
            notify('今日刮卡次数已用完，明天再来吧')
          }
          return false
        }
        return true
      })
    },
    onSegment(x0, y0, x1, y1) {
      tracker.stampSegment(x0, y0, x1, y1)
      if (!settled && tracker.ratio() >= REVEAL_THRESHOLD) {
        void settle()
      }
    },
  })

  /** 唯一结算入口：状态机推进 + 涂层淡出 + 结果弹窗 */
  async function settle() {
    if (settled) return
    const result = await campaign.reveal(id)
    if (!result.ok) {
      // 竞争失败（如被其他标签页抢先刮开）：同步远端呈现后弹出结果
      syncSettled()
      if (campaign.getCard(id)?.state === CARD_STATE.REVEALED) onRevealed(id)
      return
    }
    settled = true
    layer.fadeOut()
    onRevealed(id)
  }

  // "直接揭开"按钮：键盘可达的无障碍路径，与手动刮开走完全相同的流转
  revealBtn.addEventListener('click', async () => {
    const card = campaign.getCard(id)
    if (!card) return
    if (card.state === CARD_STATE.IDLE || card.state === CARD_STATE.SCRATCHING) {
      const begin = await campaign.beginScratch(id)
      if (!begin.ok) {
        if (begin.reason === 'no-chances') notify('今日刮卡次数已用完，明天再来吧')
        return
      }
      await settle()
    } else if (card.state === CARD_STATE.REVEALED) {
      onRevealed(id) // 已刮开未领取：重新打开结果弹窗去领取
    }
  })

  /** 根据状态机快照同步 UI（幂等，可反复调用，含远程更新） */
  function update() {
    const card = campaign.getCard(id)
    if (!card) return
    el.dataset.state = card.state

    // 在线跨天（rollover 定时器）或远程重置后回到 idle：
    // 复位涂层与覆盖率，卡片恢复可刮
    if (card.state === CARD_STATE.IDLE && settled) {
      settled = false
      tracker.reset()
      layer.reset()
    }

    if (card.prize) {
      prizeResult.textContent = card.prize.win ? '🎉 恭喜中奖' : '谢谢参与'
      prizeResult.classList.toggle('is-win', card.prize.win)
      prizeName.textContent = card.prize.win ? card.prize.name : '好运正在路上'
    } else {
      prizeResult.textContent = '幸运大奖'
      prizeResult.classList.remove('is-win')
      prizeName.textContent = '刮开涂层揭晓'
    }

    syncSettled()

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
