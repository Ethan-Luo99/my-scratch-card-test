/**
 * 单张刮刮卡组件（无单例状态，可在任意活动实例内复用）。
 * 职责边界：DOM 组装与事件接线——组合刮层引擎、覆盖率检测与活动引擎，
 * 自身不实现任何业务规则（次数/概率/状态迁移都在纯逻辑模块中）。
 *
 * 与引擎的协作是异步的（跨标签页互斥锁）：
 * - 指针按下时先用 canBegin() 同步预检决定是否允许起笔（涂层能否被刮开），
 *   同时异步派发 beginScratch()（锁内真正扣次数、生成 seed、锁定奖品）；
 * - 结算（刮满 60% 或"直接揭开"）统一 await 该异步结果后再 reveal，
 *   预检与锁内判定不一致（极端并发下他标签页刚好用完次数）时给出提示。
 *
 * 防泄露：只有进入 scratching 及之后的状态才显示奖品；idle 即使带已锁定奖品
 * （其他标签页刚开刮 / 本页刷新恢复）也只显示默认文案，涂层下无任何信息。
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
  let beginPromise = null // 进行中的 beginScratch（锁内异步）

  /** 幂等派发开刮；失败（如并发下次数被他页刚好用完）时清零以便重试 */
  function ensureBegin() {
    if (beginPromise) return
    const p = campaign.beginScratch(id)
    beginPromise = p
    p.then(
      (r) => {
        if (beginPromise === p && (!r || !r.ok)) beginPromise = null
      },
      () => {
        if (beginPromise === p) beginPromise = null
      },
    )
  }

  const tracker = createCoverageTracker({
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  })

  const layer = createScratchLayer({
    canvas,
    logicalWidth: CARD_WIDTH,
    logicalHeight: CARD_HEIGHT,
    onStrokeStart() {
      // 同步预检：次数用完/状态不对则拒绝起笔，涂层刮不开
      const check = campaign.canBegin(id)
      if (!check.ok) {
        if (check.reason === 'no-chances') {
          notify('今日刮卡次数已用完，明天再来吧')
        } else if (check.reason === 'invalid-state') {
          notify('这张卡已经刮开了')
        }
        return false
      }
      // 真正的扣减/锁定在锁内异步完成；结算路径会 await 它
      ensureBegin()
      return true
    },
    onSegment(x0, y0, x1, y1) {
      tracker.stampSegment(x0, y0, x1, y1)
      if (!settled && tracker.ratio() >= REVEAL_THRESHOLD) {
        settle()
      }
    },
  })

  /** 唯一结算入口：等待开刮落账 -> reveal -> 涂层淡出 -> 结果弹窗 */
  async function settle() {
    if (settled) return
    try {
      if (beginPromise) {
        const beginResult = await beginPromise
        beginPromise = null
        if (!beginResult || !beginResult.ok) {
          if (beginResult && beginResult.reason === 'no-chances') {
            notify('今日刮卡次数已用完，明天再来吧')
          }
          return
        }
      }
      const result = await campaign.reveal(id)
      if (!result.ok) {
        // 多为其他标签页已先行刮开/领取：以其快照为准，update() 会收敛 UI
        if (result.reason !== 'invalid-state') {
          notify('操作未成功，请稍后再试')
        }
        return
      }
      settled = true
      layer.fadeOut()
      onRevealed(id)
    } catch {
      // 锁/存储异常不应导致页面崩溃
      notify('操作未成功，请稍后再试')
    }
  }

  // "直接揭开"：键盘可达的无障碍路径，与手动刮开走完全相同的流转
  revealBtn.addEventListener('click', () => {
    const card = campaign.getCard(id)
    if (card.state === CARD_STATE.REVEALED) {
      onRevealed(id) // 已刮开未领取：重新打开结果弹窗去领取
      return
    }
    if (card.state === CARD_STATE.CLAIMED) return
    const check = campaign.canBegin(id)
    if (!check.ok) {
      if (check.reason === 'no-chances') {
        notify('今日刮卡次数已用完，明天再来吧')
      }
      return
    }
    ensureBegin()
    settle()
  })

  /** 根据状态机快照同步 UI（幂等，可反复调用，含跨标签页更新） */
  function update() {
    const card = campaign.getCard(id)
    el.dataset.state = card.state

    if (card.state === CARD_STATE.IDLE && settled) {
      // 跨天重置（本地或他标签页触发）：涂层复原、进度清零，可重新刮
      settled = false
      beginPromise = null
      tracker.reset()
      layer.reset()
    }

    // 防泄露：未进入刮卡流程的卡（含他页已锁定但本页涂层完好的情况）不显示奖品
    const started = card.state !== CARD_STATE.IDLE
    if (started && card.prize) {
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
      // 刷新恢复 / 他标签页刮开：直接隐藏涂层，不播放动画、不可重刮
      settled = true
      beginPromise = null
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
