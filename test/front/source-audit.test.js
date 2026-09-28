/**
 * 前端源码红线审计（设计硬性约束 / 验收 B7）：
 * - src/** 不 import server/**，不出现 node: 内置模块；
 * - "由 seed 推出奖品"的函数只允许存在于揭晓后复核模块（src/verify/），
 *   且不得被 begin/reveal/状态迁移等业务链路引用；
 * - localStorage 只能经白名单缓存（cache.js）与 dirty 通道（dirty-channel.js）
 *   访问，其余模块不得直接触碰 window.localStorage；
 * - 不存在旧信封/本地摇奖真相字段（chancesUsed 本地记账、seedHash FNV 等）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', '..', 'src')

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
const importPattern = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g
const dynamicImportPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/g

test('src 不引用 server/，不依赖 node: 内置，不引入第三方裸模块', () => {
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of [importPattern, dynamicImportPattern]) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]
        assert.ok(!/(^|\/)server\//.test(specifier), `${file} 引用了 server/：${specifier}`)
        assert.ok(!specifier.includes('../server'), `${file} 相对引用 server：${specifier}`)
        assert.ok(!specifier.startsWith('node:'), `${file} 依赖 node: 内置：${specifier}`)
        if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
          assert.fail(`${file} 引入第三方/裸模块依赖：${specifier}`)
        }
      }
    }
  }
})

test('seed→奖品 推演函数只存在于揭晓后复核模块，且不被业务链路引用', () => {
  for (const file of files) {
    const relative = file.slice(srcDir.length + 1)
    const source = readFileSync(file, 'utf8')
    const definesDraw = /export\s+function\s+(replayDraw|mulberry32|drawPrizeIndex)\b/.test(source)
    if (definesDraw) {
      assert.ok(
        relative.startsWith('verify/'),
        `摇奖/PRNG 函数只能定义在 src/verify/ 复核模块，违规：${relative}`,
      )
    }
  }

  // 业务链路（api/client/app/card/main 等）不得 import verify 的推演函数
  const businessDirs = ['api', 'client', 'app', 'card.js', 'main.js', 'coverage.js', 'scratch-layer.js']
  for (const file of files) {
    const relative = file.slice(srcDir.length + 1)
    if (!businessDirs.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue
    const source = readFileSync(file, 'utf8')
    assert.ok(!/verify\/replay/.test(source), `${relative} 不得引用复核用推演函数`)
    // verify/replay（seed→奖品）严禁进入业务链路；verify/hash 仅是 SHA-256
    // 工具（迁移 payload 指纹），无推演能力，允许使用
    assert.ok(
      !/from\s+['"][^'"]*verify\/(replay|weights|verify-receipt|canonical)/.test(source),
      `${relative} 业务链路不得引入复核推演模块`,
    )
  }
})

test('localStorage 只能经白名单缓存与 dirty 通道访问', () => {
  for (const file of files) {
    const relative = file.slice(srcDir.length + 1)
    if (relative === 'client/cache.js' || relative === 'client/dirty-channel.js') continue
    const source = readFileSync(file, 'utf8')
    assert.ok(!/window\.localStorage/.test(source), `${relative} 不得直接访问 localStorage`)
    assert.ok(!/[^.]localStorage\s*[.\[]/.test(source), `${relative} 不得直接访问 localStorage`)
    assert.ok(!/sessionStorage/.test(source), `${relative} 不得使用 sessionStorage`)
  }
})

test('旧本地权威机制已移除：无 FNV 承诺/本地 seed 生成/本地 chancesUsed 真相/旧信封迁移', () => {
  const cacheSource = readFileSync(join(srcDir, 'client', 'cache.js'), 'utf8')
  const blob = files
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
    .replace(/['"]scratch-campaign-v1['"]/g, '')
    .replace(/['"]scratch-campaign:v2:['"]/g, '')
  assert.ok(!/fnv1a/i.test(blob), 'FNV-1a 本地承诺必须移除')
  assert.ok(!/getRandomValues/.test(blob), '前端不得再生成开奖 seed（幂等键用 randomUUID）')
  assert.ok(!/generateSeed/.test(blob), '本地 generateSeed 必须移除')
  assert.ok(!/scratch-campaign:v2:?/.test(blob), '旧 v2 信封 key 只允许作为迁移常量')
  assert.ok(!/scratch-campaign-v1/.test(blob), '旧 v1 信封 key 只允许作为迁移常量')
  // 旧 key 字面量只允许出现在 cache.js 的迁移常量中
  assert.ok(cacheSource.includes('scratch-campaign-v1'))
  assert.ok(cacheSource.includes('scratch-campaign:v2:'))
})

test('未揭晓秘密字段不得作为前端状态字段名出现（seed/seedHash/chanceSpent 本地真相）', () => {
  // cache.js 在迁移扫描旧信封时需要容忍这些字段，但不得在新缓存结构中使用
  for (const file of files) {
    const relative = file.slice(srcDir.length + 1)
    if (relative === 'client/cache.js') continue
    const source = readFileSync(file, 'utf8')
    assert.ok(!/\.chanceSpent/.test(source), `${relative} 不得保留本地 chanceSpent 真相`)
    assert.ok(!/seedHash/.test(source), `${relative} 不得保留本地 seedHash`)
  }
})
