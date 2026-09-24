/**
 * 设计第 7 节 · F 类工程约束，验收项 30-32：
 * - 30 服务端仅用 node: 内置模块，package.json 不新增运行时依赖；
 * - 31 src/** 不 import server/**，服务端模块可脱离 DOM/Vite 独立 import；
 * - 32 vite build 成功且产物不含服务端代码；dev 经真实 HTTP（Vite 中间件）可跑全链路。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build, createServer as createViteServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const serverDir = join(root, 'server')
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

const importPattern = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g

test('F30 服务端代码零第三方运行时依赖：import 仅 node: 内置或相对路径', () => {
  const files = walk(serverDir)
  assert.ok(files.length >= 8)
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${file.replace(root, '')} 存在非内置/非相对依赖：${specifier}`,
      )
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined, '不得新增运行时 dependencies')
})

test('F31 前后端隔离：src 不引用 server；server 不引用 src；服务端模块可独立 import', async () => {
  for (const file of walk(srcDir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      assert.ok(!/(^|\/)server\//.test(match[1]), `${file} 不得 import 服务端模块`)
    }
    assert.ok(!source.includes('/api/'), '本轮前端不接 API（src/ 保持不动）')
  }
  for (const file of walk(serverDir)) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!/from\s+['"][^'"]*\/src\//.test(source), '服务端不得依赖前端 src/')
  }
  const mod = await import(pathToFileURL(join(serverDir, 'http', 'app.js')).href)
  assert.equal(typeof mod.createServerApp, 'function')
})

test('F32a dev：Vite configureServer 中间件下真实 HTTP 完成 begin→reveal→claim 全链路', async () => {
  const vite = await createViteServer({
    root,
    logLevel: 'silent',
    server: { middlewareMode: true },
    configFile: join(root, 'vite.config.js'),
  })
  const httpServer = createServer(vite.middlewares)
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  after(async () => {
    await new Promise((resolve) => httpServer.close(resolve))
    await vite.close()
  })
  const base = `http://127.0.0.1:${port}`

  const health = await fetch(`${base}/api/healthz`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)

  const session = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(session.status, 200)
  const setCookie = session.headers.get('set-cookie')
  assert.match(setCookie, /sid=[0-9a-f]{32}/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  const sessionBody = await session.json()
  assert.ok(sessionBody.campaigns.find((c) => c.campaignId === 'daily'))

  const jsonPost = (path, body, key) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: setCookie, 'idempotency-key': key },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))

  const begin = await jsonPost('/api/campaigns/daily/scratch/begin', { cardId: 'daily-1' }, crypto.randomUUID())
  assert.equal(begin.body.ok, true)
  assert.equal(begin.body.card.status, 'pending')

  const reveal = await jsonPost('/api/campaigns/daily/scratch/reveal', { cardId: 'daily-1' }, crypto.randomUUID())
  assert.equal(reveal.body.card.status, 'revealed')
  assert.ok(reveal.body.card.receipt.signature)

  const claim = await jsonPost('/api/campaigns/daily/prizes/claim', { cardId: 'daily-1' }, crypto.randomUUID())
  assert.equal(claim.body.card.status, 'claimed')

  // 前端页面仍由 Vite 正常提供
  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.ok((await index.text()).includes('幸运刮刮卡'))
})

test('F32b build：vite build 成功，且产物不含服务端代码', async () => {
  const result = await build({ root, logLevel: 'silent', configFile: join(root, 'vite.config.js') })
  assert.ok(Array.isArray(result) ? result.length >= 1 : result)
  const distDir = join(root, 'dist')
  assert.ok(existsSync(distDir))
  const bundles = walk(distDir).filter((file) => file.endsWith('.js'))
  assert.ok(bundles.length >= 1)
  for (const file of bundles) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!source.includes('mulberry32-sha256-commit-v1'), '构建产物混入服务端算法常量')
    assert.ok(!source.includes('commitment-created'), '构建产物混入服务端事件')
    assert.ok(!source.includes('/api/migrate/import'), '构建产物混入服务端路由')
    assert.ok(!source.includes('server/core'), '构建产物混入 server 模块路径')
  }
})
