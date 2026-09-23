import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mulberry32,
  fnv1aHex,
  drawPrize,
  drawPrizeIndex,
  generateSeed,
} from '../src/lib/randomness.js'

const PRIZES = [
  { name: 'A', weight: 1, win: true },
  { name: 'B', weight: 3, win: true },
  { name: 'C', weight: 6, win: false },
]

test('mulberry32：同一 seed 产生完全相同的序列', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  for (let i = 0; i < 100; i++) assert.equal(a(), b())
})

test('mulberry32：不同 seed 序列不同，输出落在 [0,1)', () => {
  const a = mulberry32(1)
  const b = mulberry32(2)
  let differ = false
  for (let i = 0; i < 10; i++) {
    const v = a()
    assert.ok(v >= 0 && v < 1)
    if (v !== b()) differ = true
  }
  assert.ok(differ)
})

test('fnv1aHex：已知测试向量', () => {
  assert.equal(fnv1aHex(''), '811c9dc5')
  assert.equal(fnv1aHex('hello'), '4f9f2cab')
  assert.equal(fnv1aHex('123'), fnv1aHex(String(123)))
})

test('drawPrize：同一 seed 必然开出同一奖品（可复现验证）', () => {
  for (const seed of [0, 1, 42, 2 ** 31, 4294967295]) {
    assert.deepEqual(drawPrize(PRIZES, seed), drawPrize(PRIZES, seed))
  }
})

test('drawPrizeIndex：按权重区间选择，边界明确', () => {
  assert.equal(drawPrizeIndex(PRIZES, () => 0), 0) // 最小 roll -> 第一项
  assert.equal(drawPrizeIndex(PRIZES, () => 0.999999), 2) // 最大 roll -> 末项
  assert.equal(drawPrizeIndex(PRIZES, () => 0.05), 0) // 0.05*10=0.5 落在 A(1)
  assert.equal(drawPrizeIndex(PRIZES, () => 0.5), 2) // 5 落在 C(4..10)
})

test('drawPrizeIndex：权重全 0 / 非法时回退末项，不抛错', () => {
  const zero = [
    { name: 'X', weight: 0 },
    { name: 'Y', weight: -1 },
  ]
  assert.equal(drawPrizeIndex(zero, () => 0.5), 1)
})

test('generateSeed：返回 uint32，crypto 缺失时兜底也不抛错', () => {
  const fakeCrypto = {
    getRandomValues(view) {
      view[0] = 123456789
      return view
    },
  }
  assert.equal(generateSeed(fakeCrypto), 123456789)
  const fallback = generateSeed(null)
  assert.ok(Number.isInteger(fallback) && fallback >= 0 && fallback <= 0xffffffff)
})
