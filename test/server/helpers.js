/**
 * 服务端测试设施：可拨时钟 + 内存 store + 真实 HTTP（node:http 起临时端口，
 * 按 vite.config.js 同款方式把 handler 挂到 /api），零第三方依赖。
 */
import { createServer } from 'node:http'
import { createServerApp } from '../../server/app.js'
import { CAMPAIGNS } from '../../server/core/draw.js'

export const DAY1 = Date.UTC(2026, 8, 24, 2, 0, 0) // 2026-09-24 10:00 +08
export const DAY1_KEY = '2026-09-24'
export const DAY2 = DAY1 + 24 * 60 * 60 * 1000
export const DAY2_KEY = '2026-09-25'

export function createHarness(options = {}) {
  let now = options.now ?? DAY1
  const app = createServerApp({ clock: () => now, ...options })
  const { engine, store, handler } = app

  const server = createServer((req, res) => {
    if (req.url && req.url.startsWith('/api')) {
      req.url = req.url.slice('/api'.length) || '/'
      return handler(req, res)
    }
    res.writeHead(404).end()
  })

  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = () => `http://127.0.0.1:${server.address().port}`

  /** 真实 HTTP 调用；返回 { status, json, raw, headers } */
  async function api(method, path, { body, sid, idemKey, rawBody } = {}) {
    await ready
    const headers = {}
    if (sid) headers.cookie = `sid=${sid}`
    if (idemKey) headers['idempotency-key'] = idemKey
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${base()}${path}`, {
      method,
      headers,
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    })
    const raw = await res.text()
    let json = null
    try { json = JSON.parse(raw) } catch { /* 非 JSON */ }
    return { status: res.status, json, raw, headers: res.headers }
  }

  async function newSession() {
    const res = await api('POST', '/api/session', { body: {} })
    const cookie = res.headers.get('set-cookie') || ''
    const sid = /sid=([0-9a-f]+)/.exec(cookie)?.[1]
    return { sid, cookie, body: res.json }
  }

  return {
    engine,
    store,
    api,
    newSession,
    setNow(ms) { now = ms },
    getNow: () => now,
    async close() {
      await ready
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
    campaigns: CAMPAIGNS,
  }
}

/** 服务端某卡内部记录（含秘密，仅测试断言用） */
export function serverCard(store, sid, campaignId, cardId) {
  return store.getCard(sid, campaignId, cardId)
}

export function prizeNames(campaignId = 'daily') {
  const campaign = CAMPAIGNS.find((c) => c.campaignId === campaignId)
  return campaign.prizes.map((p) => p.name)
}
