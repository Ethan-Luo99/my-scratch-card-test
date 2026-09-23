import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDay, isValidDateString, localDateString, DAY_VERDICT } from '../src/lib/time.js'

test('正常跨天：当前日期晚于已持久化日期 -> 重置', () => {
  const r = resolveDay('2026-09-22', '2026-09-23')
  assert.equal(r.verdict, DAY_VERDICT.RESET)
  assert.equal(r.date, '2026-09-23')
  assert.equal(r.anomaly, false)
})

test('同一天：不重置、无异常', () => {
  const r = resolveDay('2026-09-23', '2026-09-23')
  assert.equal(r.verdict, DAY_VERDICT.SAME)
  assert.equal(r.anomaly, false)
})

test('时间回拨：当前日期早于已持久化日期 -> 视为同一天延续并告警', () => {
  const r = resolveDay('2026-09-23', '2026-09-22')
  assert.equal(r.verdict, DAY_VERDICT.SAME)
  assert.equal(r.date, '2026-09-23') // 沿用较新的持久化日期，次数不重置
  assert.equal(r.anomaly, true)
})

test('回拨跨月/跨年同样成立', () => {
  const r = resolveDay('2027-01-01', '2026-12-31')
  assert.equal(r.verdict, DAY_VERDICT.SAME)
  assert.equal(r.date, '2027-01-01')
  assert.equal(r.anomaly, true)
})

test('无持久化日期（首日使用）：按当前日期重置且不告警', () => {
  const r = resolveDay(null, '2026-09-23')
  assert.equal(r.verdict, DAY_VERDICT.RESET)
  assert.equal(r.anomaly, false)
})

test('持久化日期损坏：按当前日期重新开始，不告警', () => {
  const r = resolveDay('not-a-date', '2026-09-23')
  assert.equal(r.verdict, DAY_VERDICT.RESET)
  assert.equal(r.date, '2026-09-23')
  assert.equal(r.anomaly, false)
})

test('isValidDateString：校验格式与真实日历', () => {
  assert.ok(isValidDateString('2026-09-23'))
  assert.ok(isValidDateString('2024-02-29')) // 闰年
  assert.ok(!isValidDateString('2026-02-30'))
  assert.ok(!isValidDateString('2026-13-01'))
  assert.ok(!isValidDateString('2026-9-3'))
  assert.ok(!isValidDateString(123))
})

test('localDateString：输出 YYYY-MM-DD', () => {
  assert.equal(localDateString(new Date(2026, 8, 3)), '2026-09-03')
})
