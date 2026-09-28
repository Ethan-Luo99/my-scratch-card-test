/**
 * 渲染门控（验收 B6 / A6）：
 * - begin 成功但未 reveal：.prize-name 文本为空，奖品名不出现在卡片文本；
 * - reveal 成功后才写入 prize 文本；
 * - 离线时未揭晓卡不可刮（begin 不发起），涂层禁用；
 * - 60% 与"直接揭开"走同一 reveal（只调一次且路径一致）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStub, createFakeContext } from './helpers.js'
import { createScratchCard } from '../../src/card.js'

const IDLE = {
  'daily-1': { cardId: 'daily-1', campaignId: 'daily', status: 'idle', rev: 0 },
}
const PENDING = {
  'daily-1': {
    cardId: 'daily-1',
    campaignId: 'daily',
    status: 'pending',
    rev: 1,
    commitment: 'ab'.repeat(32),
    expiresAt: '2999-01-01T00:00:00.000Z',
  },
}

function fakeCampaign({ card = IDLE['daily-1'], offline = false, begin, reveal, claim } = {}) {
  let current = card
  return {
    id: 'daily',
    cardIds: ['daily-1'],
    getCard: () => current,
    _setCard(next) {
      current = next
    },
    snapshot: { offline },
    beginScratch: begin ?? (async () => ({ ok: true, card: PENDING['daily-1'] })),
    reveal: reveal ?? (async () => ({ ok: false })),
    claim: claim ?? (async () => ({ ok: true })),
  }
}

function setupCard(campaign, { onRevealedCalls } = {}) {
  const calls = onRevealedCalls ?? { count: 0 }
  const notifyMessages = []
  const component = createScratchCard({
    id: 'daily-1',
    campaign,
    notify: (message) => notifyMessages.push(message),
    onRevealed: () => {
      calls.count += 1
    },
  })
  return { component, calls, notifyMessages }
}

function prizeEls(component) {
  return {
    name: component.el.querySelector('.prize-name'),
    result: component.el.querySelector('.prize-result'),
  }
}

test('idle/pending：奖品文本节点为空，奖品名不出现在卡片文本', () => {
  const dom = installDomStub()
  try {
    for (const card of [IDLE['daily-1'], PENDING['daily-1']]) {
      const campaign = fakeCampaign({ card })
      const { component } = setupCard(campaign)
      const { name, result } = prizeEls(component)
      assert.equal(name.textContent, '', `${card.status} 卡 .prize-name 必须为空`)
      assert.equal(result.textContent, '', `${card.status} 卡 .prize-result 必须为空`)
      for (const prizeName of ['88元 现金红包', '免费咖啡一杯', '8.8元 优惠券', 'iPhone 抽奖券']) {
        assert.ok(!component.el.textContent.includes(prizeName))
        assert.ok(!component.el.innerHTML.includes(prizeName), 'innerHTML 模板也不得含奖品名')
      }
    }
  } finally {
    dom.restore()
  }
})

test('revealed 后才写入奖品文本', () => {
  const dom = installDomStub()
  try {
    const campaign = fakeCampaign({
      card: {
        cardId: 'daily-1',
        status: 'revealed',
        rev: 2,
        prize: { name: '免费咖啡一杯', win: true },
        receipt: { seedHex: '11'.repeat(16), signature: 'cd'.repeat(32) },
      },
    })
    const { component } = setupCard(campaign)
    assert.equal(prizeEls(component).name.textContent, '免费咖啡一杯')
    assert.ok(prizeEls(component).result.textContent.includes('恭喜中奖'))
  } finally {
    dom.restore()
  }
})

test('未中奖揭晓：奖品层显示"好运正在路上"而非具体奖品', () => {
  const dom = installDomStub()
  try {
    const campaign = fakeCampaign({
      card: {
        cardId: 'daily-1',
        status: 'revealed',
        rev: 2,
        prize: { name: '谢谢参与', win: false },
        receipt: { seedHex: '11'.repeat(16), signature: 'cd'.repeat(32) },
      },
    })
    const { component } = setupCard(campaign)
    assert.equal(prizeEls(component).result.textContent, '谢谢参与')
    assert.equal(prizeEls(component).name.textContent, '好运正在路上')
  } finally {
    dom.restore()
  }
})

test('离线时未揭晓卡：begin 不发起、提示离线、涂层不擦除', async () => {
  const dom = installDomStub()
  try {
    let beginCalls = 0
    const campaign = fakeCampaign({
      card: IDLE['daily-1'],
      offline: true,
      begin: async () => {
        beginCalls += 1
        return { ok: true }
      },
    })
    const { component, notifyMessages } = setupCard(campaign)
    // 模拟首次笔画起点：onStrokeStart 必须拒绝
    // 通过 reveal 按钮（直接揭开）走同一前置校验
    const button = component.el.querySelector('.reveal-btn')
    button.dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(beginCalls, 0, '离线不得发起 begin')
    assert.ok(notifyMessages.some((m) => m.includes('网络不可用')))
    assert.equal(prizeEls(component).name.textContent, '')
  } finally {
    dom.restore()
  }
})

test('60% 与直接揭开走同一 settle：reveal 只在 pending 后调用一次', async () => {
  const dom = installDomStub()
  try {
    let revealCalls = 0
    let beginCalls = 0
    const campaign = {
      id: 'daily',
      cardIds: ['daily-1'],
      snapshot: { offline: false },
      getCard: () => PENDING['daily-1'],
      beginScratch: async () => {
        beginCalls += 1
        return { ok: true, card: PENDING['daily-1'] }
      },
      reveal: async () => {
        revealCalls += 1
        return {
          ok: true,
          card: {
            cardId: 'daily-1',
            status: 'revealed',
            rev: 2,
            prize: { name: '免费咖啡一杯', win: true },
            receipt: { seedHex: '11'.repeat(16), signature: 'cd'.repeat(32) },
          },
        }
      },
      claim: async () => ({ ok: true }),
    }
    const calls = { count: 0 }
    const { component } = setupCard(campaign, { onRevealedCalls: calls })
    // 已 pending：点"直接揭开"-> settle -> reveal
    component.el.querySelector('.reveal-btn').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(revealCalls, 1)
    assert.equal(calls.count, 1)
  } finally {
    dom.restore()
  }
})

test('reveal 网络失败：不写奖品、不淡出，保留可重试状态', async () => {
  const dom = installDomStub()
  try {
    const campaign = {
      id: 'daily',
      cardIds: ['daily-1'],
      snapshot: { offline: false },
      getCard: () => PENDING['daily-1'],
      beginScratch: async () => ({ ok: true }),
      reveal: async () => {
        throw new Error('network')
      },
      claim: async () => ({ ok: true }),
    }
    const { component } = setupCard(campaign)
    component.el.querySelector('.reveal-btn').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(prizeEls(component).name.textContent, '')
    const busy = component.el.querySelector('.card-busy')
    assert.equal(busy.hidden, false, '显示揭晓失败可重试提示')
    assert.match(busy.textContent, /重试/)
  } finally {
    dom.restore()
  }
})
