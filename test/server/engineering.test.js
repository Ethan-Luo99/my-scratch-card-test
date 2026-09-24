/**
 * 验收 F 类：工程约束。
 * 对应设计文档第 7 节条目 30/31/32（服务端可测部分）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createServerApp } from '../../server/app.js'

function listJsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

function importSpecifiers(file) {
  const src = readFileSync(file, 'utf8')
  const specs = []
  for (const match of src.matchAll(/(?:\bfrom\b|\bimport\b)\s*\(?\s*['"]([^'"\s]+)['"]/g)) {
    specs.push(match[1])
  }
  return specs
}

test('F30: 服务端零第三方运行时依赖——server/** 仅 import node: 内置或相对路径', () => {
  const files = listJsFiles('server')
  assert.ok(files.length > 0)
  for (const file of files) {
    for (const spec of importSpecifiers(file)) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('.'),
        `${file} 引入了非内置依赖: ${spec}`,
      )
    }
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    'package.json 不得新增运行时 dependencies')
})

test('F31: 前后端隔离——src/** 不 import server/**；服务端可脱离 DOM/Vite 运行', async () => {
  for (const file of listJsFiles('src')) {
    for (const spec of importSpecifiers(file)) {
      assert.ok(!/(^|\/)server\//.test(spec), `${file} 不得 import 服务端模块: ${spec}`)
    }
  }
  // 服务端模块已被本测试文件直接 import（无 DOM / 无 Vite），并可纯工厂调用
  const app = createServerApp({ clock: () => 0 })
  assert.equal(typeof app.handler, 'function')
  assert.equal(typeof app.engine.begin, 'function')
})

test('F32: 真实 HTTP 全链路——session→begin→reveal→claim→state 一次走通', async () => {
  const { handler } = createServerApp({ clock: () => Date.UTC(2026, 8, 24, 2, 0, 0) })
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api')) {
      req.url = req.url.slice('/api'.length) || '/'
      return handler(req, res)
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const session = await fetch(`${base}/api/session`, { method: 'POST' })
    assert.equal(session.status, 200)
    const cookie = session.headers.get('set-cookie').split(';')[0]
    const meta = await session.json()
    assert.equal(meta.campaigns.length, 2)

    const call = (path, key, body) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'idempotency-key': key },
        body: JSON.stringify(body),
      }).then((r) => r.json())

    const begin = await call('/api/campaigns/daily/scratch/begin', 'f32-1', { cardId: 'daily-1' })
    assert.equal(begin.ok, true)
    assert.match(begin.card.commitment, /^[0-9a-f]{64}$/)

    const reveal = await call('/api/campaigns/daily/scratch/reveal', 'f32-2', { cardId: 'daily-1' })
    assert.equal(reveal.ok, true)
    assert.ok(reveal.card.prize && reveal.card.receipt.seedHex)

    const claim = await call('/api/campaigns/daily/prizes/claim', 'f32-3', { cardId: 'daily-1' })
    assert.equal(claim.ok, true)
    assert.equal(claim.card.status, 'claimed')

    const state = await fetch(`${base}/api/state?campaign=daily`, { headers: { cookie } })
    const view = await state.json()
    const card = view.campaigns[0].cards.find((c) => c.cardId === 'daily-1')
    assert.equal(card.status, 'claimed')
    assert.equal(view.campaigns[0].chancesLeft, 2)

    const health = await fetch(`${base}/api/healthz`).then((r) => r.json())
    assert.equal(health.ok, true)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('F32b: vite dev 中间件集成——configureServer 挂载 /api 后可真实访问', async () => {
  const { createServer: createViteServer } = await import('vite')
  const server = await createViteServer({
    configFile: 'vite.config.js',
    server: { port: 0, strictPort: false },
    logLevel: 'silent',
  })
  await server.listen()
  try {
    const address = server.httpServer.address()
    const base = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${base}/api/healthz`).then((r) => r.json())
    assert.equal(health.ok, true)
    const session = await fetch(`${base}/api/session`, { method: 'POST' })
    assert.equal(session.status, 200)
    const cookie = session.headers.get('set-cookie').split(';')[0]
    const begin = await fetch(`${base}/api/campaigns/daily/scratch/begin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'vite-1' },
      body: JSON.stringify({ cardId: 'daily-1' }),
    }).then((r) => r.json())
    assert.equal(begin.ok, true)
    assert.match(begin.card.commitment, /^[0-9a-f]{64}$/)
    assert.ok(!('prize' in begin.card) && !('seedHex' in begin.card))
  } finally {
    await server.close()
  }
})
