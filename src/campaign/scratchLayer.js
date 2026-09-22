/**
 * 刮层渲染与擦除引擎。
 * 职责边界：只负责 Canvas 涂层绘制、指针擦除、DPR 适配、尺寸变化时保留刮擦进度；
 * 不理解活动规则，通过回调与外部通信（能否刮、刮开达标）。
 *
 * 实现要点：
 * - 擦除用 globalCompositeOperation = 'destination-out' 的圆头线段，线段插值保证
 *   快速划动时刮痕连续不断裂；优先消费 getCoalescedEvents() 拿到高频采样点；
 * - DPR 处理：canvas 物理像素 = CSS 尺寸 * devicePixelRatio，
 *   ctx.setTransform(dpr,0,0,dpr,0,0) 后全部用 CSS 像素坐标绘制，
 *   指针坐标用 getBoundingClientRect() 换算，天然对齐；
 * - Pointer Events + setPointerCapture：指针拖出卡片/窗口仍能收到事件，
 *   pointercancel / lostpointercapture / window blur 时复位按下状态，避免"未按下也在刮"；
 * - ResizeObserver 监听容器：尺寸变化时把旧位图缩放拷贝到新画布，刮擦进度不丢失。
 */

import { createCoverageTracker } from './coverage.js'

const BRUSH_RADIUS = 22 // CSS 像素

export function createScratchLayer(host, { onScratchStart, onRejected, onReveal, threshold = 0.6 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.className = 'scratch-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  host.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  let cssWidth = 0
  let cssHeight = 0
  let dpr = 1
  let drawing = false
  let activePointerId = null
  let last = null
  let started = false
  let revealed = false
  const tracker = createCoverageTracker()

  function paintCoating() {
    // 银灰渐变底
    const gradient = ctx.createLinearGradient(0, 0, cssWidth, cssHeight)
    gradient.addColorStop(0, '#b8bcc4')
    gradient.addColorStop(0.5, '#e2e5ea')
    gradient.addColorStop(1, '#a9adb6')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, cssWidth, cssHeight)
    // 噪点纹理：128x128 随机灰度 tile，pattern 平铺
    const tile = document.createElement('canvas')
    tile.width = tile.height = 128
    const tileCtx = tile.getContext('2d')
    const img = tileCtx.createImageData(128, 128)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (150 + Math.random() * 80) | 0
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 28
    }
    tileCtx.putImageData(img, 0, 0)
    ctx.fillStyle = ctx.createPattern(tile, 'repeat')
    ctx.fillRect(0, 0, cssWidth, cssHeight)
    // 提示文案
    ctx.fillStyle = 'rgba(90, 94, 102, 0.65)'
    ctx.font = `600 ${Math.round(cssHeight * 0.14)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('刮 一 刮', cssWidth / 2, cssHeight / 2)
  }

  function resize() {
    const rect = host.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    const nextDpr = window.devicePixelRatio || 1
    if (w === cssWidth && h === cssHeight && nextDpr === dpr) return
    // 保留进度：先把当前位图快照，尺寸/DPR 变更后缩放拷回
    let snapshot = null
    if (canvas.width > 0 && canvas.height > 0) {
      snapshot = document.createElement('canvas')
      snapshot.width = canvas.width
      snapshot.height = canvas.height
      snapshot.getContext('2d').drawImage(canvas, 0, 0)
    }
    cssWidth = w
    cssHeight = h
    dpr = nextDpr
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (snapshot) ctx.drawImage(snapshot, 0, 0, snapshot.width, snapshot.height, 0, 0, w, h)
    else paintCoating()
  }

  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()

  function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function eraseSegment(a, b) {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = '#000'
    ctx.strokeStyle = '#000'
    ctx.lineWidth = BRUSH_RADIUS * 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (a.x === b.x && a.y === b.y) {
      ctx.arc(a.x, a.y, BRUSH_RADIUS, 0, Math.PI * 2) // 单点：圆头线段退化为圆
      ctx.fill()
    } else {
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
    const ratio = tracker.stampSegment(a.x, a.y, b.x, b.y, BRUSH_RADIUS, cssWidth, cssHeight)
    if (!revealed && ratio >= threshold) {
      revealed = true
      onReveal?.()
    }
  }

  function onPointerDown(e) {
    if (revealed || drawing) return
    if (!started) {
      // 首次下刮前询问外部（扣次数、锁结果）；不允许则提示且不产生任何刮痕
      if (!onScratchStart?.()) {
        onRejected?.()
        return
      }
      started = true
    }
    drawing = true
    activePointerId = e.pointerId
    canvas.setPointerCapture(e.pointerId)
    last = pointFromEvent(e)
    eraseSegment(last, last)
    e.preventDefault()
  }

  function onPointerMove(e) {
    if (!drawing || e.pointerId !== activePointerId) return
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
    for (const ev of events.length ? events : [e]) {
      const p = pointFromEvent(ev)
      eraseSegment(last, p)
      last = p
    }
  }

  function endStroke(e) {
    if (e && e.pointerId !== activePointerId) return
    drawing = false
    activePointerId = null
  }

  function resetStroke() {
    drawing = false
    activePointerId = null
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', endStroke)
  canvas.addEventListener('pointercancel', endStroke)
  canvas.addEventListener('lostpointercapture', resetStroke)
  window.addEventListener('blur', resetStroke)

  return {
    /** 结算：涂层整体淡出并移除（手动刮满与"直接揭开"共用此入口） */
    reveal() {
      if (revealed && canvas.classList.contains('is-fading')) return
      revealed = true
      canvas.classList.add('is-fading')
      canvas.addEventListener('transitionend', () => canvas.remove(), { once: true })
      setTimeout(() => canvas.remove(), 800) // transitionend 兜底
    },
    isRevealed: () => revealed,
    destroy() {
      observer.disconnect()
      window.removeEventListener('blur', resetStroke)
      canvas.remove()
    },
  }
}
