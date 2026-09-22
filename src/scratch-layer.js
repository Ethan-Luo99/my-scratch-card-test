/**
 * 刮层渲染 / 擦除引擎。
 * 职责边界：只负责"涂层长什么样、怎么被刮掉"，不理解活动规则；
 * 通过 onStrokeStart / onSegment 回调与外部协作。
 *
 * 关键设计：
 * - 涂层绘制在固定逻辑分辨率（320x180）的离屏 canvas 上，擦除也作用于它；
 *   显示 canvas 每帧只是把它按当前 CSS 尺寸 + DPR 缩放绘制出来。
 *   因此窗口 resize / 容器尺寸变化只需重绘缩放，已刮进度天然保留；
 * - DPR 处理：canvas 物理像素 = CSS 像素 * devicePixelRatio，
 *   ctx.setTransform(dpr,0,0,dpr,0,0) 后以 CSS 像素作画；
 *   指针坐标先换算为 CSS 像素、再按比例映射到逻辑坐标系擦除，
 *   保证 DPR != 1 或卡片被 CSS 缩放时刮痕与指针精确对齐；
 * - 刮痕连续性：pointermove 中取 getCoalescedEvents() 补全快速划动丢掉的点，
 *   相邻点之间用圆头直线（destination-out）插值，刮痕是连续线段而非离散点；
 * - 状态粘滞防护：pointerdown 时 setPointerCapture，指针拖出卡片/窗口仍持续
 *   收到事件且 pointerup 必定送达；pointercancel / lostpointercapture /
 *   window blur 都会终止当前笔画，不会出现"未按下也在刮"。
 */

const NOISE_SIZE = 128

export function createScratchLayer({
  canvas,
  logicalWidth = 320,
  logicalHeight = 180,
  brushRadius = 18,
  onStrokeStart = () => true,
  onSegment = () => {},
}) {
  // 离屏逻辑涂层：擦除操作的唯一真实数据源
  const offscreen = document.createElement('canvas')
  offscreen.width = logicalWidth
  offscreen.height = logicalHeight
  const offCtx = offscreen.getContext('2d')

  const ctx = canvas.getContext('2d')
  let dpr = 1
  let cssWidth = 0
  let cssHeight = 0
  let enabled = true
  let destroyed = false
  let activePointerId = null
  let lastPoint = null

  paintCoating()

  function paintCoating() {
    offCtx.save()
    offCtx.globalCompositeOperation = 'source-over'
    offCtx.clearRect(0, 0, logicalWidth, logicalHeight)

    const gradient = offCtx.createLinearGradient(0, 0, logicalWidth, logicalHeight)
    gradient.addColorStop(0, '#c9c9cf')
    gradient.addColorStop(0.35, '#a9a9b2')
    gradient.addColorStop(0.6, '#cfcfd6')
    gradient.addColorStop(1, '#9d9da7')
    offCtx.fillStyle = gradient
    offCtx.fillRect(0, 0, logicalWidth, logicalHeight)

    // 噪点纹理：一次性生成小噪声图，平铺覆盖，半透明叠加
    offCtx.globalAlpha = 0.22
    offCtx.fillStyle = offCtx.createPattern(makeNoiseTile(), 'repeat')
    offCtx.fillRect(0, 0, logicalWidth, logicalHeight)
    offCtx.globalAlpha = 1

    offCtx.fillStyle = 'rgba(255, 255, 255, 0.75)'
    offCtx.font = `600 ${Math.round(logicalHeight * 0.14)}px system-ui, sans-serif`
    offCtx.textAlign = 'center'
    offCtx.textBaseline = 'middle'
    offCtx.fillText('刮开涂层 揭晓好礼', logicalWidth / 2, logicalHeight / 2)
    offCtx.restore()
  }

  function makeNoiseTile() {
    const tile = document.createElement('canvas')
    tile.width = NOISE_SIZE
    tile.height = NOISE_SIZE
    const tileCtx = tile.getContext('2d')
    const image = tileCtx.createImageData(NOISE_SIZE, NOISE_SIZE)
    for (let i = 0; i < image.data.length; i += 4) {
      const v = 120 + Math.floor(Math.random() * 120)
      image.data[i] = v
      image.data[i + 1] = v
      image.data[i + 2] = v
      image.data[i + 3] = 255
    }
    tileCtx.putImageData(image, 0, 0)
    return tile
  }

  /** 按当前 CSS 尺寸与 DPR 重设物理像素并重绘（进度不丢失） */
  function resize() {
    cssWidth = canvas.clientWidth
    cssHeight = canvas.clientHeight
    if (cssWidth === 0 || cssHeight === 0) return
    dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round(cssHeight * dpr)
    render()
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssWidth, cssHeight)
    ctx.drawImage(offscreen, 0, 0, logicalWidth, logicalHeight, 0, 0, cssWidth, cssHeight)
  }

  /** 指针事件坐标 -> 逻辑涂层坐标 */
  function toLogical(e) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: ((e.clientX - rect.left) / rect.width) * logicalWidth,
      y: ((e.clientY - rect.top) / rect.height) * logicalHeight,
    }
  }

  /** 在逻辑涂层上擦除一段圆头线段 */
  function eraseSegment(from, to) {
    offCtx.save()
    offCtx.globalCompositeOperation = 'destination-out'
    offCtx.strokeStyle = '#000'
    offCtx.fillStyle = '#000'
    offCtx.lineWidth = brushRadius * 2
    offCtx.lineCap = 'round'
    offCtx.lineJoin = 'round'
    offCtx.beginPath()
    offCtx.moveTo(from.x, from.y)
    offCtx.lineTo(to.x, to.y)
    offCtx.stroke()
    // 终点补圆，避免折线拐角处出现未擦净的尖角
    offCtx.beginPath()
    offCtx.arc(to.x, to.y, brushRadius, 0, Math.PI * 2)
    offCtx.fill()
    offCtx.restore()
  }

  function handlePointerDown(e) {
    if (!enabled || activePointerId !== null || destroyed) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 询问外部是否允许开始（如次数已用完则拒绝，涂层不可刮）
    if (onStrokeStart() === false) return
    e.preventDefault()
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      // 某些环境不支持捕获，退化为普通监听，仍可靠 pointerup 结束
    }
    activePointerId = e.pointerId
    const point = toLogical(e)
    lastPoint = point
    if (point) {
      eraseSegment(point, point)
      onSegment(point.x, point.y, point.x, point.y)
      render()
    }
  }

  function handlePointerMove(e) {
    if (activePointerId === null || e.pointerId !== activePointerId) return
    // 合并事件补全快速划动期间的中间点，防止刮痕断裂
    const events =
      typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length > 0
        ? e.getCoalescedEvents()
        : [e]
    for (const ev of events) {
      const point = toLogical(ev)
      if (!point || !lastPoint) continue
      eraseSegment(lastPoint, point)
      onSegment(lastPoint.x, lastPoint.y, point.x, point.y)
      lastPoint = point
    }
    render()
  }

  function endStroke(e) {
    if (activePointerId === null) return
    if (e && e.pointerId !== undefined && e.pointerId !== activePointerId) return
    activePointerId = null
    lastPoint = null
  }

  canvas.addEventListener('pointerdown', handlePointerDown)
  canvas.addEventListener('pointermove', handlePointerMove)
  canvas.addEventListener('pointerup', endStroke)
  canvas.addEventListener('pointercancel', endStroke)
  canvas.addEventListener('lostpointercapture', endStroke)
  window.addEventListener('blur', endStroke)

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  window.addEventListener('resize', resize)
  resize()

  return {
    /** 禁用后涂层不再响应刮擦（如次数用完、已结算） */
    setEnabled(value) {
      enabled = Boolean(value)
      if (!enabled) endStroke()
    },
    /** 结算动画：涂层整体淡出，返回 Promise；与手动刮开共用 */
    fadeOut(duration = 600) {
      endStroke()
      enabled = false
      return new Promise((resolve) => {
        canvas.style.transition = `opacity ${duration}ms ease`
        canvas.style.opacity = '0'
        window.setTimeout(() => {
          canvas.style.visibility = 'hidden'
          canvas.style.pointerEvents = 'none'
          resolve()
        }, duration + 50)
      })
    },
    /** 恢复完整涂层（如新一天重置） */
    reset() {
      paintCoating()
      canvas.style.transition = ''
      canvas.style.opacity = '1'
      canvas.style.visibility = 'visible'
      canvas.style.pointerEvents = ''
      enabled = true
      render()
    },
    destroy() {
      destroyed = true
      resizeObserver.disconnect()
      window.removeEventListener('resize', resize)
      window.removeEventListener('blur', endStroke)
    },
  }
}
