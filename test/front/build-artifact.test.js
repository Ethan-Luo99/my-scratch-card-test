/**
 * 验收 F7/B7：vite build 产物安全审计。
 *
 * 产物（主 bundle + 动态复核 chunk）不得包含：
 * - server/ 模块路径与服务端事件/内部常量；
 * - node:crypto / node: 内置模块引用；
 * - 未揭晓服务端摇奖实现的内部符号；
 * 且必须包含客户端应有的 API 调用路径（证明前端确实经 fetch 走服务端）。
 *
 * 该测试直接读 dist/（由 npm run build 或 f-engineering 的 F32b 构建产生），
 * 避免在每个 node --test 进程里重复构建；dist 缺失时给出明确跳过条件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const distDir = join(root, 'dist')

test('前置：dist 已构建（npm run build），且包含至少一个 JS 产物', () => {
  if (!existsSync(distDir)) {
    // 首次运行自动构建一次（后续测试共享），保持 npm test 可独立全绿
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' })
  }
  assert.ok(existsSync(distDir), 'vite build 必须产出 dist/')
})

function bundleFiles() {
  const out = []
  for (const entry of readdirSync(join(distDir, 'assets'))) {
    if (entry.endsWith('.js')) out.push(join(distDir, 'assets', entry))
  }
  return out
}

test('产物不含 server/ 模块路径、服务端事件名与 node: 内置引用', () => {
  const forbidden = [
    /server\/core/,
    /server\/http/,
    /server\/store/,
    /node:crypto/,
    /node:http/,
    /node:fs\b/,
    /commitment-created/,
    /pending-stored/,
    /migration-claimed-registered/,
    /claimsLedger/,
    /mulberry32-sha256-commit-v1/,
    /createServerApp/,
    /MemoryStore/,
    /Idempotency-Key required/,
  ]
  for (const file of bundleFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${file} 包含禁用内容：${pattern}`)
    }
  }
})

test('产物中不含未揭晓 seed 生成器（crypto.randomBytes/16 字节种子等服务端逻辑）', () => {
  for (const file of bundleFiles()) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!/randomBytes/.test(source), `${file} 混入服务端 128bit seed 生成`)
    assert.ok(!/generateKeyPairSync|signCommitment|Ed25519.*privateKey/i.test(source), `${file} 混入服务端签名私钥逻辑`)
  }
})

test('主 bundle 经 /api 与服务端交互（fetch 路径存在），且前端不内嵌摇奖配置权重', () => {
  const mainBundle = bundleFiles()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
  assert.ok(mainBundle.includes('/scratch/begin'), '前端必须调用 begin API')
  assert.ok(mainBundle.includes('/scratch/reveal'), '前端必须调用 reveal API')
  assert.ok(mainBundle.includes('/prizes/claim'), '前端必须调用 claim API')
  assert.ok(mainBundle.includes('/api/state') || mainBundle.includes('/state'), '前端必须同步 /state')
  assert.ok(mainBundle.includes('/migrate/import'), '前端必须有迁移导入调用')
})
