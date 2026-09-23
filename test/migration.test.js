import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateData, STORAGE_VERSION, LEGACY_KEY } from '../src/lib/migration.js'
import { createDailyState, sanitizeDailyState } from '../src/lib/state-machine.js'

const CARD_IDS = ['c1', 'c2', 'c3']
const ctx = (overrides = {}) => ({
  date: '2026-09-23',
  cardIds: CARD_IDS,
  maxChances: 3,
  createDailyStateFn: createDailyState,
  sanitizeFn: sanitizeDailyState,
  ...overrides,
})

test('旧格式无损迁移：次数 / 锁定奖品 / 已刮开未领取 / 日期全部保留', () => {
  const legacy = {
    date: '2026-09-23',
    chancesUsed: 2,
    cards: {
      c1: {
        state: 'claimed',
        chanceSpent: true,
        prize: { name: '88元 现金红包', win: true },
      },
      c2: {
        state: 'revealed',
        chanceSpent: true,
        prize: { name: '免费咖啡一杯', win: true },
      },
      c3: { state: 'idle', chanceSpent: false, prize: null },
    },
  }
  const { envelope, migrated } = migrateData(legacy, ctx())
  assert.equal(migrated, true)
  assert.equal(envelope.version, STORAGE_VERSION)
  assert.equal(envelope.state.chancesUsed, 2, '次数不得重置')
  assert.equal(envelope.state.date, '2026-09-23', '日期字段保留')
  assert.equal(envelope.state.lastDate, '2026-09-23')
  assert.equal(envelope.state.cards.c1.state, 'claimed')
  assert.deepEqual(envelope.state.cards.c1.prize, {
    name: '88元 现金红包',
    win: true,
  })
  assert.equal(envelope.state.cards.c2.state, 'revealed', '已刮开未领取中间态保留')
  assert.deepEqual(envelope.state.cards.c2.prize, { name: '免费咖啡一杯', win: true })
  assert.equal(envelope.state.cards.c3.state, 'idle')
  assert.equal(envelope.state.cards.c3.prize, null)
})

test('迁移：scratching 中间态归一为 idle，但已扣次数与奖品保留', () => {
  const legacy = {
    date: '2026-09-23',
    chancesUsed: 1,
    cards: {
      c1: {
        state: 'scratching',
        chanceSpent: true,
        prize: { name: '8.8元 优惠券', win: true },
      },
      c2: { state: 'idle', chanceSpent: false, prize: null },
      c3: { state: 'idle', chanceSpent: false, prize: null },
    },
  }
  const { envelope } = migrateData(legacy, ctx())
  assert.equal(envelope.state.cards.c1.state, 'idle')
  assert.equal(envelope.state.cards.c1.chanceSpent, true)
  assert.deepEqual(envelope.state.cards.c1.prize, { name: '8.8元 优惠券', win: true })
})

test('迁移容错：缺字段 / 类型错误 / 垃圾值不崩溃且产出可用状态', () => {
  for (const garbage of [null, undefined, 42, 'str', [], {}]) {
    const { envelope } = migrateData(garbage, ctx())
    assert.equal(envelope.version, STORAGE_VERSION)
    assert.equal(envelope.state.chancesUsed, 0)
    assert.deepEqual(Object.keys(envelope.state.cards).sort(), [...CARD_IDS].sort())
  }
  const broken = {
    date: 42,
    chancesUsed: 'abc',
    cards: { c1: { state: 'wat', chanceSpent: 'yes', prize: 'x' } },
  }
  const { envelope, migrated } = migrateData(broken, ctx())
  assert.equal(migrated, true)
  assert.equal(envelope.state.chancesUsed, 0, '非法次数回退 0')
  assert.equal(envelope.state.cards.c1.state, 'idle', '非法状态回退 idle')
  assert.equal(envelope.state.cards.c1.chanceSpent, true)
})

test('未知 / 更高版本号：不信任结构，按当日新状态处理', () => {
  const future = { version: 99, rev: 5, state: { chancesUsed: 99 } }
  const { envelope, migrated } = migrateData(future, ctx())
  assert.equal(migrated, false)
  assert.equal(envelope.version, STORAGE_VERSION)
  assert.equal(envelope.rev, 0)
  assert.equal(envelope.state.chancesUsed, 0)
})

test('当前版本：rev 保留，非法 rev 回退 0，次数按 maxChances 封顶（5 次 / 4 卡）', () => {
  const v2 = {
    version: STORAGE_VERSION,
    rev: 7,
    state: {
      date: '2026-09-23',
      lastDate: '2026-09-23',
      chancesUsed: 5,
      cards: {
        w1: { state: 'idle', chanceSpent: true, prize: { name: 'A', win: true } },
      },
    },
  }
  const { envelope, migrated } = migrateData(
    v2,
    ctx({ cardIds: ['w1', 'w2', 'w3', 'w4'], maxChances: 5 }),
  )
  assert.equal(migrated, false)
  assert.equal(envelope.rev, 7)
  assert.equal(envelope.state.chancesUsed, 5)
})

test('LEGACY_KEY 常量保持旧 key 名，保证真实旧数据能被读到', () => {
  assert.equal(LEGACY_KEY, 'scratch-campaign-v1')
})
