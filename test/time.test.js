import test from 'node:test'
import assert from 'node:assert/strict'
import { localDateString, isValidDateString, resolveDay, DAY_VERDICT } from '../src/lib/time.js'

test('localDateString 输出本地 YYYY-MM-DD', () => {
  assert.equal(localDateString(new Date(2026, 0, 5)), '2026-01-05')
  assert.equal(localDateString(new Date(2026, 11, 31)), '2026-12-31')
})

test('isValidDateString 拒绝非法 / 不存在的日期', () => {
  assert.equal(isValidDateString('2026-02-29'), false, '2026 非闰年')
  assert.equal(isValidDateString('2024-02-29'), true, '2024 闰年')
  assert.equal(isValidDateString('2026-13-01'), false)
  assert.equal(isValidDateString('2026-00-01'), false)
  assert.equal(isValidDateString('2026-1-1'), false)
  assert.equal(isValidDateString('not-a-date'), false)
  assert.equal(isValidDateString(null), false)
})

test('正常跨天：current > last -> reset，无异常', () => {
  assert.deepEqual(resolveDay('2026-09-22', '2026-09-23'), {
    verdict: DAY_VERDICT.RESET,
    date: '2026-09-23',
    anomaly: false,
  })
})

test('同一天：current == last -> same 延续', () => {
  assert.deepEqual(resolveDay('2026-09-23', '2026-09-23'), {
    verdict: DAY_VERDICT.SAME,
    date: '2026-09-23',
    anomaly: false,
  })
})

test('时间回拨：current < last -> 沿用 lastDate 延续且标记 anomaly（次数不重置）', () => {
  assert.deepEqual(resolveDay('2026-09-23', '2026-09-22'), {
    verdict: DAY_VERDICT.SAME,
    date: '2026-09-23',
    anomaly: true,
  })
  assert.deepEqual(resolveDay('2026-09-25', '2026-09-20'), {
    verdict: DAY_VERDICT.SAME,
    date: '2026-09-25',
    anomaly: true,
  })
})

test('首次使用（无 lastDate）：reset 且不告警', () => {
  assert.deepEqual(resolveDay(null, '2026-09-23'), {
    verdict: DAY_VERDICT.RESET,
    date: '2026-09-23',
    anomaly: false,
  })
  assert.deepEqual(resolveDay(undefined, '2026-09-23'), {
    verdict: DAY_VERDICT.RESET,
    date: '2026-09-23',
    anomaly: false,
  })
})

test('回拨后再拨回真实日期：因 current 仍 <= lastDate，继续沿用更晚的日期不重置', () => {
  // 昨天(9/22) 刷过 -> 拨回今天(9/23) 仍判定为同一天延续，防止跨天刷次数
  const afterRollback = resolveDay('2026-09-23', '2026-09-22')
  assert.equal(afterRollback.verdict, DAY_VERDICT.SAME)
  assert.equal(afterRollback.date, '2026-09-23')
})

test('非法 lastDate 视为第一天；非法当前日期保守延续', () => {
  assert.equal(resolveDay('garbage', '2026-09-23').verdict, DAY_VERDICT.RESET)
  const badCurrent = resolveDay('2026-09-23', 'garbage')
  assert.equal(badCurrent.verdict, DAY_VERDICT.SAME)
  assert.equal(badCurrent.anomaly, true)
  assert.equal(badCurrent.date, '2026-09-23')
})
