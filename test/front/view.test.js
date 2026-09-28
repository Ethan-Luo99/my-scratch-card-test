/**
 * 设计 4.2 / 验收 A1-B7：公开视图白名单过滤（内存门控）。
 * 未揭晓卡视图携带 seed/prize/receipt 属协议错误，整卡更新丢弃。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeCardView,
  sanitizeSnapshot,
  sanitizeFullView,
  CARD_STATUS,
} from '../../src/api/view.js'

const seedHex = 'a'.repeat(32)
const commitment = 'b'.repeat(64)

test('idle 视图：只保留公开字段', () => {
  const view = sanitizeCardView({ cardId: 'daily-1', campaignId: 'daily', status: 'idle', rev: 0 })
  assert.deepEqual(view, { cardId: 'daily-1', campaignId: 'daily', status: 'idle', rev: 0 })
})

test('pending 视图：只允许 commitment，绝不落 prize/seed/receipt', () => {
  const view = sanitizeCardView({
    cardId: 'daily-1',
    campaignId: 'daily',
    status: CARD_STATUS.PENDING,
    rev: 1,
    commitment,
    expiresAt: '2026-09-24T02:15:00.000Z',
  })
  assert.equal(view.commitment, commitment)
  assert.equal(view.prize, undefined)
  assert.equal(view.receipt, undefined)
  assert.equal(view.seedHex, undefined)
})

test('B1 未揭晓卡带 prize：整卡丢弃（纵深防御）', () => {
  const leaked = sanitizeCardView({
    cardId: 'daily-1',
    campaignId: 'daily',
    status: CARD_STATUS.PENDING,
    rev: 1,
    commitment,
    prize: { name: '88元 现金红包', win: true },
  })
  assert.equal(leaked, null)
})

test('B1b 未揭晓卡带 seedHex / receipt：同样丢弃', () => {
  assert.equal(
    sanitizeCardView({ cardId: 'c', campaignId: 'daily', status: 'pending', rev: 1, seedHex }),
    null,
  )
  assert.equal(
    sanitizeCardView({
      cardId: 'c',
      campaignId: 'daily',
      status: 'pending',
      rev: 1,
      receipt: { seedHex },
    }),
    null,
  )
})

test('revealed/claimed 才带 prize + receipt；非法 receipt 结构剔除但卡保留', () => {
  const revealed = sanitizeCardView({
    cardId: 'daily-1',
    campaignId: 'daily',
    status: CARD_STATUS.REVEALED,
    rev: 2,
    prize: { name: '谢谢参与', win: false },
    receipt: {
      seedHex,
      commitment,
      algorithm: 'mulberry32-sha256-commit-v1',
      weightsVersion: 'v1',
      serverTime: '2026-09-24T02:01:00.000Z',
      signature: 'deadbeef',
    },
  })
  assert.equal(revealed.prize.name, '谢谢参与')
  assert.equal(revealed.receipt.seedHex, seedHex)

  const claimed = sanitizeCardView({
    cardId: 'daily-2',
    campaignId: 'daily',
    status: CARD_STATUS.CLAIMED,
    rev: 3,
    prize: { name: '免费咖啡一杯', win: true },
    claimRef: 'claim_1',
  })
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.claimRef, 'claim_1')
})

test('已揭晓卡缺 prize：丢弃（协议不完整）', () => {
  assert.equal(
    sanitizeCardView({ cardId: 'c', campaignId: 'daily', status: 'revealed', rev: 2 }),
    null,
  )
})

test('非法 status / rev / 缺字段：丢弃', () => {
  assert.equal(sanitizeCardView({ cardId: 'c', campaignId: 'daily', status: 'nope', rev: 1 }), null)
  assert.equal(sanitizeCardView({ cardId: 'c', campaignId: 'daily', status: 'idle', rev: -1 }), null)
  assert.equal(sanitizeCardView({ status: 'idle', rev: 0 }), null)
})

test('sanitizeSnapshot / sanitizeFullView：剔除坏卡，结构完整', () => {
  const snapshot = sanitizeSnapshot({
    campaignId: 'daily',
    chancesLeft: 2,
    dailyChances: 3,
    cards: [
      { cardId: 'daily-1', campaignId: 'daily', status: 'idle', rev: 0 },
      { cardId: 'daily-2', campaignId: 'daily', status: 'pending', rev: 1, prize: { name: 'x', win: true } },
    ],
  })
  assert.equal(snapshot.cards.length, 1)
  assert.equal(snapshot.cards[0].cardId, 'daily-1')
  assert.equal(snapshot.chancesLeft, 2)

  const full = sanitizeFullView({ serverTime: 't', day: '2026-09-24', campaigns: [snapshot] })
  assert.equal(full.day, '2026-09-24')
  assert.equal(full.campaigns.length, 1)
  assert.equal(sanitizeFullView({ campaigns: null }), null)
})
