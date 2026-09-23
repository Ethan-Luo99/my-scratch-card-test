import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mulberry32,
  fnv1aHex,
  drawPrizeIndex,
  drawPrize,
  generateSeed,
} from '../src/lib/randomness.js'

const PRIZES = [
  { name: 'iPhone 抽奖券', weight: 2, win: true },
  { name: '20 元红包', weight: 8, win: true },
  { name: '谢谢参与', weight: 90, win: false },
]

test('mulberry32 确定性：同一 seed 产出完全相同序列', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  const seqA = Array.from({ length: 1000 }, a)
  const seqB = Array.from({ length: 1000 }, b)
  assert.deepEqual(seqA, seqB)
  assert.notDeepEqual(
    Array.from({ length: 10 }, mulberry32(1)),
    Array.from({ length: 10 }, mulberry32(2)),
    '不同 seed 序列不同',
  )
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, '值域 [0,1)')
  }
})

test('mulberry32 处理非整数 / 非法 seed 不崩溃', () => {
  assert.doesNotThrow(() => mulberry32('x')())
  assert.doesNotThrow(() => mulberry32(undefined)())
  assert.equal(typeof mulberry32(0xffffffff + 1)(), 'number')
})

test('drawPrize 按 seed 可复现，且结果在奖池内', () => {
  const r1 = drawPrize(PRIZES, 12345)
  const r2 = drawPrize(PRIZES, 12345)
  assert.deepEqual(r1, r2)
  assert.ok(PRIZES.some((p) => p.name === r1.name))
})

test('权重分布近似符合权重（2/8/90），且完全可由 seed 重放', () => {
  const counts = [0, 0, 0]
  const N = 20000
  for (let seed = 1; seed <= N; seed++) {
    const rng = mulberry32(seed)
    counts[drawPrizeIndex(PRIZES, rng)]++
  }
  const ratio = counts.map((c) => c / N)
  assert.ok(Math.abs(ratio[0] - 0.02) < 0.008, `iPhone 比例 ${ratio[0]}`)
  assert.ok(Math.abs(ratio[1] - 0.08) < 0.012, `红包比例 ${ratio[1]}`)
  assert.ok(Math.abs(ratio[2] - 0.9) < 0.015, `谢谢参与比例 ${ratio[2]}`)
})

test('权重全 0 / 非法权重回退最后一项', () => {
  const bad = [
    { name: 'a', weight: 0 },
    { name: 'b', weight: -3 },
    { name: 'fallback', weight: NaN },
  ]
  assert.equal(drawPrizeIndex(bad, () => 0.1), 2)
})

test('FNV-1a 哈希：稳定且对不同输入敏感', () => {
  assert.equal(fnv1aHex('12345'), fnv1aHex('12345'))
  assert.match(fnv1aHex('12345'), /^[0-9a-f]{8}$/)
  assert.notEqual(fnv1aHex('1'), fnv1aHex('2'))
  assert.notEqual(fnv1aHex('12'), fnv1aHex('21'))
})

test('generateSeed：注入 crypto 时使用其随机值，缺 crypto 时仍产出 uint32', () => {
  const fakeCrypto = {
    getRandomValues(view) {
      view[0] = 0xdeadbeef
      return view
    },
  }
  assert.equal(generateSeed(fakeCrypto), 0xdeadbeef)
  const fallback = generateSeed(null)
  assert.ok(Number.isInteger(fallback) && fallback >= 0 && fallback <= 0xffffffff)
})
