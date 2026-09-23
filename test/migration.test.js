import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateData, STORAGE_VERSION } from '../src/lib/migration.js'
import { createDailyState, sanitizeDailyState } from '../src/lib/state-machine.js'

const CTX = {
  date: '2026-09-23',
  cardIds: ['c1', 'c2', 'c3'],
  dailyChances: 3,
  createDailyStateFn: createDailyState,
  sanitizeFn: sanitizeDailyState,
}

const legacyV1 = {
  date: '2026-09-23',
  chancesUsed: 2,
  cards: {
    c1: { state: 'claimed', prize: { name: '88元 现金红包', win: true }, chanceSpent: true },
    c2: { state: 'revealed', prize: { name: '谢谢参与', win: false }, chanceSpent: true },
    c3: { state: 'scratching', prize: { name: '免费咖啡一杯', win: true }, chanceSpent: true },
  },
}

test('v1 -> v2 无损迁移：次数、奖品、中间态、日期全部保留', () => {
  const { envelope, migrated } = migrateData(structuredClone(legacyV1), CTX)
  assert.equal(migrated, true)
  assert.equal(envelope.version, STORAGE_VERSION)

  const s = envelope.state
  assert.equal(s.chancesUsed, 2) // 次数不重置
  assert.equal(s.date, '2026-09-23') // 日期字段保留
  assert.equal(s.lastDate, '2026-09-23')

  assert.equal(s.cards.c1.state, 'claimed')
  assert.deepEqual(s.cards.c1.prize, { name: '88元 现金红包', win: true })

  // "已刮开未领取"中间态保留，奖品不重摇
  assert.equal(s.cards.c2.state, 'revealed')
  assert.deepEqual(s.cards.c2.prize, { name: '谢谢参与', win: false })

  // 刮到一半刷新：回退 idle，但次数/奖品保留（重刮不重抽）
  assert.equal(s.cards.c3.state, 'idle')
  assert.equal(s.cards.c3.chanceSpent, true)
  assert.deepEqual(s.cards.c3.prize, { name: '免费咖啡一杯', win: true })
})

test('缺字段 / 类型错误：容错为安全默认，不抛错', () => {
  const broken = {
    chancesUsed: 'abc',
    date: 12345,
    cards: {
      c1: { state: 'bogus', prize: 'not-an-object', chanceSpent: 'yes' },
      c2: null,
    },
  }
  const { envelope, migrated } = migrateData(broken, CTX)
  assert.equal(migrated, true)
  const s = envelope.state
  assert.equal(s.chancesUsed, 0)
  assert.equal(s.date, CTX.date) // 非法日期回退为今天
  assert.equal(s.cards.c1.state, 'idle')
  assert.equal(s.cards.c1.prize, null)
  assert.equal(s.cards.c2.state, 'idle')
})

test('chanceSpent=false 的卡不允许携带奖品（防伪造）', () => {
  const forged = {
    date: '2026-09-23',
    chancesUsed: 0,
    cards: { c1: { state: 'revealed', prize: { name: 'x', win: true }, chanceSpent: false } },
  }
  const { envelope } = migrateData(forged, CTX)
  assert.equal(envelope.state.cards.c1.state, 'idle')
  assert.equal(envelope.state.cards.c1.prize, null)
})

test('chancesUsed 超出每日上限时按上限钳制', () => {
  const over = { date: '2026-09-23', chancesUsed: 99, cards: {} }
  const { envelope } = migrateData(over, CTX)
  assert.equal(envelope.state.chancesUsed, 3)
})

test('垃圾输入（null / 字符串 / 数组 / 数字）：产出全新信封', () => {
  for (const junk of [null, undefined, 'junk', 42, [], true]) {
    const { envelope, migrated } = migrateData(junk, CTX)
    assert.equal(migrated, false)
    assert.equal(envelope.version, STORAGE_VERSION)
    assert.equal(envelope.state.chancesUsed, 0)
    assert.deepEqual(Object.keys(envelope.state.cards), CTX.cardIds)
  }
})

test('未知版本号（含更高版本）：不信任结构，按全新一天处理', () => {
  for (const v of [1, 3, 99, -1]) {
    const { envelope, migrated } = migrateData({ version: v, state: { chancesUsed: 2 } }, CTX)
    assert.equal(migrated, false)
    assert.equal(envelope.state.chancesUsed, 0)
  }
})

test('v2 信封：字段清洗后保留 rev 与合法数据', () => {
  const v2 = {
    version: 2,
    rev: 7,
    state: {
      date: '2026-09-23',
      lastDate: '2026-09-23',
      chancesUsed: 1,
      cards: {
        c1: { state: 'revealed', prize: { name: 'A', win: true }, chanceSpent: true, seed: 42, seedHash: 'abcd1234' },
        unknownCard: { state: 'claimed' },
      },
    },
  }
  const { envelope, migrated } = migrateData(v2, CTX)
  assert.equal(migrated, false)
  assert.equal(envelope.rev, 7)
  assert.equal(envelope.state.chancesUsed, 1)
  assert.equal(envelope.state.cards.c1.seed, 42)
  assert.equal(envelope.state.cards.c1.seedHash, 'abcd1234')
  assert.equal(envelope.state.cards.unknownCard, undefined) // 未知卡剔除
})
