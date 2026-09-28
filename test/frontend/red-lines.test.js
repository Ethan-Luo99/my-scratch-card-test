/**
 * 一票否决红线（源码级静态审计）：
 * 1. src/** 不得 import server/** 或 node: 内置；
 * 2. 状态链路（campaign/card/api/storage）不得 import 复核模块
 *    （verify/public-weights），即"由 seed 推出奖品"的能力不进状态链路；
 * 3. src 中不得出现本地开奖调用（generateSeed / drawPrize( 业务调用）；
 * 4. localStorage 写入只发生在白名单模块（backend 原语 / cache / dirty 信号）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const srcDir = join(root, 'src')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

const files = walk(srcDir)
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]))
const importPattern = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g

const STATE_CHAIN = [
  'src/campaign.js',
  'src/card.js',
  'src/api/client.js',
  'src/storage/cache.js',
  'src/storage/backend.js',
  'src/storage/sync.js',
  'src/lib/view.js',
  'src/lib/legacy.js',
]

test('红线 1：src 不 import server/** 与 node: 内置', () => {
  for (const [file, source] of sources) {
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      assert.ok(!/(^|\/)server\//.test(specifier), `${relative(root, file)} 不得 import 服务端模块`)
      assert.ok(!/^node:/.test(specifier), `${relative(root, file)} 不得依赖 node: 内置`)
    }
  }
})

test('红线 2：状态链路不得 import 复核模块（无"由 seed 推出奖品"能力）', () => {
  for (const rel of STATE_CHAIN) {
    const file = join(root, rel)
    const source = sources.get(file)
    assert.ok(source, `${rel} 应存在`)
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      assert.ok(!/verify\.js$/.test(specifier), `${rel} 不得 import lib/verify.js`)
      assert.ok(!/public-weights\.js$/.test(specifier), `${rel} 不得 import lib/public-weights.js`)
    }
  }
})

test('红线 3：src 无本地开奖调用（generateSeed / 业务 drawPrize）', () => {
  for (const [file, source] of sources) {
    assert.ok(!/generateSeed\b/.test(source), `${relative(root, file)} 不得出现 generateSeed`)
    assert.ok(!/fnv1a/.test(source), `${relative(root, file)} 不得出现 FNV 承诺`)
  }
  // drawPrize 只允许出现在复核模块 lib/verify.js（且导出名为 redrawPrize）
  for (const [file, source] of sources) {
    if (file.endsWith('lib/verify.js')) continue
    assert.ok(!/drawPrize/.test(source), `${relative(root, file)} 不得引用 drawPrize`)
  }
})

test('红线 4：localStorage 写入只在白名单模块', () => {
  const allowed = new Set(['src/storage/backend.js', 'src/storage/cache.js', 'src/storage/sync.js'])
  for (const [file, source] of sources) {
    const rel = relative(root, file)
    if (allowed.has(rel)) continue
    assert.ok(!/\.setItem\(/.test(source), `${rel} 不得直接写 localStorage`)
    assert.ok(!/window\.localStorage|globalThis\.localStorage|[^.]\blocalStorage\s*[.\[]/.test(source), `${rel} 不得直接引用全局 localStorage`)
  }
})

test('红线 5：迁移/降级路径不引入本地开奖兜底（无"先本地开了以后同步"分支）', () => {
  const legacy = sources.get(join(root, 'src/lib/legacy.js'))
  assert.ok(!/drawPrize|mulberry32|generateSeed/.test(legacy), '迁移模块不得含本地开奖')
  const campaign = sources.get(join(root, 'src/campaign.js'))
  assert.ok(!/mulberry32|drawPrize|generateSeed/.test(campaign), '活动镜像不得含本地开奖')
})
