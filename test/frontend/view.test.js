/**
 * 公开视图白名单清洗（验收 A5/B6 的内存侧）：
 * - 未揭晓卡携带 prize/receipt/seed/seedHex 一律判协议错误（整卡丢弃）；
 * - revealed/claimed 才允许 prize/receipt，且字段按白名单裁剪；
 * - state 视图整体清洗；expired 是纯展示派生态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_STATUS,
  sanitizeCardView,
  sanitizeStateView,
  effectiveStatus,
  idleCardView,
} from '../../src/lib/view.js'

test('pending 视图：只保留承诺字段', () => {
  const view = sanitizeCardView({
    cardId: 'daily-1',
    campaignId: 'daily',
    status: 'pending',
    rev: 1,
    commitment: 'ab'.repeat(32),
    expiresAt: '2026-09-27T10:00:00.000Z',
  })
  assert.equal(view.status, 'pending')
  assert.equal(view.commitment, 'ab'.repeat(32))
  assert.equal('prize' in view, false)
  assert.equal('receipt' in view, false)
})

test('未揭晓卡夹带 prize/receipt/seed/seedHex：判协议错误，整卡丢弃', () => {
  for (const leak of [
    { prize: { name: 'x', win: true } },
    { receipt: { seedHex: 'aa', signature: 'bb' } },
    { seed: 12345 },
    { seedHex: 'ff'.repeat(16) },
  ]) {
    for (const status of ['idle', 'pending']) {
      const view = sanitizeCardView({ cardId: 'c1', status, rev: 1, ...leak })
      assert.equal(view, null, `${status} 携带 ${Object.keys(leak)} 必须丢弃`)
    }
  }
})

test('revealed/claimed：允许 prize+receipt，未知字段被裁剪', () => {
  const view = sanitizeCardView({
    cardId: 'daily-1',
    status: 'revealed',
    rev: 2,
    prize: { name: '免费咖啡一杯', win: true, extra: 'drop-me' },
    receipt: {
      seedHex: 'ff'.repeat(16),
      algorithm: 'mulberry32-sha256-commit-v1',
      weightsVersion: 'v1',
      commitment: 'ab'.repeat(32),
      serverTime: '2026-09-27T10:00:00.000Z',
      signature: 'cd'.repeat(32),
      serverSecret: 'must-be-dropped',
    },
  })
  assert.equal(view.prize.name, '免费咖啡一杯')
  assert.equal('extra' in view.prize, false)
  assert.equal('serverSecret' in view.receipt, false)

  const claimed = sanitizeCardView({
    cardId: 'daily-1',
    status: 'claimed',
    rev: 3,
    prize: { name: '免费咖啡一杯', win: true },
    claimRef: 'claim_123',
  })
  assert.equal(claimed.claimRef, 'claim_123')
})

test('非法形态：未知状态 / 负 rev / 缺 cardId 一律拒绝', () => {
  assert.equal(sanitizeCardView({ cardId: 'c1', status: 'scratching', rev: 1 }), null)
  assert.equal(sanitizeCardView({ cardId: 'c1', status: 'pending', rev: -1 }), null)
  assert.equal(sanitizeCardView({ status: 'pending', rev: 1 }), null)
  assert.equal(sanitizeCardView(null), null)
  assert.equal(sanitizeCardView('pending'), null)
})

test('revealed 缺 prize 判协议错误（已揭晓必须有公开奖品）', () => {
  assert.equal(sanitizeCardView({ cardId: 'c1', status: 'revealed', rev: 2 }), null)
})

test('sanitizeStateView：清洗活动数组并保留元数据', () => {
  const view = sanitizeStateView({
    serverTime: '2026-09-27T02:00:00.000Z',
    day: '2026-09-27',
    clockAnomaly: true,
    campaigns: [
      {
        campaignId: 'daily',
        title: '每日刮刮卡',
        dailyChances: 3,
        chancesLeft: 2,
        cards: [
          { cardId: 'daily-1', status: 'pending', rev: 1, commitment: 'ab'.repeat(32) },
          // 泄密卡被丢弃
          { cardId: 'daily-2', status: 'pending', rev: 1, prize: { name: 'x', win: true } },
        ],
      },
    ],
  })
  assert.equal(view.day, '2026-09-27')
  assert.equal(view.clockAnomaly, true)
  assert.equal(view.campaigns[0].chancesLeft, 2)
  assert.equal(view.campaigns[0].cards.length, 1)
  assert.equal(view.campaigns[0].cards[0].cardId, 'daily-1')
})

test('effectiveStatus：pending 过期派生 expired，其余原样', () => {
  const pending = { status: 'pending', expiresAt: '2020-01-01T00:00:00.000Z' }
  assert.equal(effectiveStatus(pending, Date.now()), CARD_STATUS.EXPIRED)
  const fresh = { status: 'pending', expiresAt: '2999-01-01T00:00:00.000Z' }
  assert.equal(effectiveStatus(fresh, Date.now()), CARD_STATUS.PENDING)
  assert.equal(effectiveStatus({ status: 'revealed' }, Date.now()), 'revealed')
  assert.equal(effectiveStatus(null), 'idle')
})

test('idleCardView：空槽位无承诺无奖品', () => {
  const view = idleCardView('daily-1', 'daily')
  assert.deepEqual(Object.keys(view).sort(), ['campaignId', 'cardId', 'rev', 'status'])
})
