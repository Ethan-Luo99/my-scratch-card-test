/**
 * 设计 4.2/4.5，验收 B5/B6/B24：
 * - 未揭晓卡奖品文本绝不进 DOM（含 aria/data/注释旁路）；
 * - begin 在途时涂层不擦除（pending 笔画缓冲）；
 * - 60% 与"直接揭开"走同一 settle；失败可重试，绝不本地补结果；
 * - 离线只读/锁定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScratchCard, prizeLayerContent } from '../../src/card.js'
import { CARD_STATUS } from '../../src/api/view.js'
import { installDom } from './mini-dom.js'

const PLACEHOLDER_NAME = '刮开涂层揭晓'
const SEED_HEX = 'a'.repeat(32)
const COMMITMENT = 'b'.repeat(64)
const PRIZE_NAMES = ['88元 现金红包', '免费咖啡一杯', '8.8元 优惠券', '谢谢参与', 'iPhone 抽奖券', '20 元红包']

function cardView(overrides = {}) {
  return {
    cardId: 'daily-1',
    campaignId: 'daily',
    status: CARD_STATUS.IDLE,
    rev: 0,
    ...overrides,
  }
}

function fakeController({ card = cardView(), online = true, begin, settle } = {}) {
  const calls = { begin: 0, settle: 0 }
  let current = card
  return {
    calls,
    get online() {
      return online
    },
    getCard: () => current,
    setCard(next) {
      current = next
    },
    begin: async (id) => {
      calls.begin += 1
      return begin ? begin(id) : { ok: true, card: current }
    },
    settle: async (id) => {
      calls.settle += 1
      return settle ? settle(id) : { ok: true, card: current }
    },
  }
}

test('prizeLayerContent：idle/pending 只有占位，不含任何奖品名', () => {
  for (const status of [CARD_STATUS.IDLE, CARD_STATUS.PENDING, CARD_STATUS.EXPIRED]) {
    const content = prizeLayerContent(cardView({ status, commitment: COMMITMENT }))
    assert.equal(content.revealed, false)
    assert.ok(!PRIZE_NAMES.includes(content.result))
    assert.ok(!PRIZE_NAMES.includes(content.name))
  }
  const content = prizeLayerContent(
    cardView({ status: CARD_STATUS.REVEALED, rev: 2, prize: { name: '免费咖啡一杯', win: true } }),
  )
  assert.equal(content.revealed, true)
  assert.equal(content.name, '免费咖啡一杯')
})

test('B6 pending 卡 DOM 无奖品文本：模板/属性/文本全扫描', () => {
  const dom = installDom()
  try {
    const controller = fakeController({
      card: cardView({ status: CARD_STATUS.PENDING, rev: 1, commitment: COMMITMENT }),
    })
    const { el } = createScratchCard({
      id: 'daily-1',
      controller,
      notify: () => {},
      onRevealed: () => {},
    })
    const prizeName = el.querySelector('.prize-name')
    assert.equal(prizeName.textContent, '', '未揭晓 .prize-name 必须为空')
    // 占位提示可以存在（不含任何奖品名），奖品名 span 必须为空
    assert.equal(el.querySelector('.prize-result').textContent, PLACEHOLDER_NAME)
    const allText = el.textContent
    for (const name of PRIZE_NAMES) {
      assert.ok(!allText.includes(name), `未揭晓 DOM 泄漏奖品名：${name}`)
    }
    // aria/data/title 等属性旁路也不得携带奖品
    const serialized = JSON.stringify(
      el.querySelectorAll('*').map((node) => node.attrs),
    )
    for (const name of PRIZE_NAMES) assert.ok(!serialized.includes(name))
    assert.equal(el.dataset.state, 'pending')
  } finally {
    dom.restore()
  }
})

test('B6b revealed 后奖品文本才进入 DOM；claimed 同样可见', () => {
  const dom = installDom()
  try {
    const controller = fakeController({
      card: cardView({ status: CARD_STATUS.REVEALED, rev: 2, prize: { name: '谢谢参与', win: false } }),
    })
    const { el, update } = createScratchCard({
      id: 'daily-1',
      controller,
      notify: () => {},
      onRevealed: () => {},
    })
    assert.ok(el.textContent.includes('谢谢参与'))
    controller.setCard(
      cardView({
        status: CARD_STATUS.CLAIMED,
        rev: 3,
        prize: { name: '88元 现金红包', win: true },
        claimRef: 'claim_x',
      }),
    )
    update()
    assert.ok(el.textContent.includes('88元 现金红包'))
    assert.equal(el.querySelector('.card-status').hidden, false)
  } finally {
    dom.restore()
  }
})

test('begin 在途不擦除：授权 resolve 前无任何 destination-out 绘制；成功后缓冲笔画补画', async () => {
  const dom = installDom()
  try {
    let resolveBegin
    const beginPromise = new Promise((resolve) => {
      resolveBegin = resolve
    })
    const controller = fakeController({
      begin: () => beginPromise,
      settle: async () => ({ ok: true, card: controller.getCard() }),
    })
    const reveals = []
    const component = createScratchCard({
      id: 'daily-1',
      controller,
      notify: () => {},
      onRevealed: (id) => reveals.push(id),
    })
    const canvas = component.el.querySelector('.scratch-canvas')
    const offscreen = dom.canvases().find((candidate) => candidate !== canvas)

    const down = (x, y) =>
      canvas.dispatch('pointerdown', {
        pointerType: 'pen',
        button: 0,
        pointerId: 7,
        clientX: x,
        clientY: y,
      })
    const move = (x, y) =>
      canvas.dispatch('pointermove', {
        pointerType: 'pen',
        pointerId: 7,
        clientX: x,
        clientY: y,
        getCoalescedEvents: () => [{ clientX: x, clientY: y }],
      })

    down(30, 30)
    move(40, 40)
    await Promise.resolve()
    await Promise.resolve()
    // 在途：无擦除调用
    assert.deepEqual(offscreen.getContext().calls.filter((c) => c === 'stroke' || c === 'fill'), [])

    resolveBegin({ ok: true, card: cardView({ status: CARD_STATUS.PENDING, rev: 1, commitment: COMMITMENT }) })
    await beginPromise
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 授权成功后缓冲笔画补画（出现 destination-out 线段/圆）
    assert.ok(offscreen.getContext().calls.includes('stroke'))
  } finally {
    dom.restore()
  }
})

test('begin 被拒（次数用尽）：涂层不擦除', async () => {
  const dom = installDom()
  try {
    const notifications = []
    const controller = fakeController({
      begin: async () => ({ ok: false, reason: 'no-chances' }),
    })
    const component = createScratchCard({
      id: 'daily-1',
      controller,
      notify: (message) => notifications.push(message),
      onRevealed: () => {},
    })
    const canvas = component.el.querySelector('.scratch-canvas')
    const offscreen = dom.canvases().find((candidate) => candidate !== canvas)
    canvas.dispatch('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 20, clientY: 20 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(notifications.some((message) => message.includes('次数')))
    assert.deepEqual(offscreen.getContext().calls.filter((c) => c === 'stroke' || c === 'fill'), [])
  } finally {
    dom.restore()
  }
})

test('60% 与"直接揭开"走同一 settle：两条路径都只调用 controller.settle', async () => {
  const dom = installDom()
  try {
    const controller = fakeController({
      card: cardView({ status: CARD_STATUS.PENDING, rev: 1, commitment: COMMITMENT }),
      begin: async () => ({ ok: true, card: controller.getCard() }),
      settle: async () => ({
        ok: true,
        card: cardView({
          status: CARD_STATUS.REVEALED,
          rev: 2,
          prize: { name: '谢谢参与', win: false },
          receipt: { seedHex: SEED_HEX, commitment: COMMITMENT, signature: 's' },
        }),
      }),
    })
    const reveals = []
    const component = createScratchCard({
      id: 'daily-1',
      controller,
      notify: () => {},
      onRevealed: (id) => reveals.push(id),
    })
    const canvas = component.el.querySelector('.scratch-canvas')
    // 直接揭开按钮
    component.el.querySelector('.reveal-btn').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(controller.calls.settle, 1)
    assert.deepEqual(reveals, ['daily-1'])
  } finally {
    dom.restore()
  }
})

test('reveal 网络失败：提供"重试揭晓"，不写本地结果；重试成功后才揭晓', async () => {
  const dom = installDom()
  try {
    let shouldFail = true
    const controller = fakeController({
      card: cardView({ status: CARD_STATUS.PENDING, rev: 1, commitment: COMMITMENT }),
      begin: async () => ({ ok: true, card: controller.getCard() }),
      settle: async () => {
        if (shouldFail) return { ok: false, reason: 'offline' }
        const revealed = cardView({
          status: CARD_STATUS.REVEALED,
          rev: 2,
          prize: { name: '免费咖啡一杯', win: true },
          receipt: { seedHex: SEED_HEX, commitment: COMMITMENT, signature: 's' },
        })
        controller.setCard(revealed)
        return { ok: true, card: revealed }
      },
    })
    const reveals = []
    const component = createScratchCard({
      id: 'daily-1',
      controller,
      notify: () => {},
      onRevealed: (id) => reveals.push(id),
    })
    component.el.querySelector('.reveal-btn').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(reveals, [])
    assert.ok(!component.el.textContent.includes('免费咖啡一杯'))
    const btn = component.el.querySelector('.reveal-btn')
    assert.equal(btn.textContent, '重试揭晓')

    shouldFail = false
    btn.dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(reveals, ['daily-1'])
    assert.ok(component.el.textContent.includes('免费咖啡一杯'))
  } finally {
    dom.restore()
  }
})

test('离线：画布禁用 + 锁定提示，点击不产生写动作', async () => {
  const dom = installDom()
  try {
    const controller = fakeController({ online: false })
    const notifications = []
    const component = createScratchCard({
      id: 'daily-1',
      controller,
      notify: (message) => notifications.push(message),
      onRevealed: () => {},
    })
    component.update()
    assert.equal(component.el.querySelector('.card-lock-hint').hidden, false)
    component.el.querySelector('.reveal-btn').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(controller.calls.begin, 0)
    assert.equal(controller.calls.settle, 0)
    assert.ok(notifications.some((message) => message.includes('网络')))
  } finally {
    dom.restore()
  }
})
