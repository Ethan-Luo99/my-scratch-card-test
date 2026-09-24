/**
 * 服务端测试工具：注入式假时钟 + 内存 store + 测试签名密钥，
 * 直接对 createServerApp 发真实 HTTP 请求（node:http 临时端口），
 * 不需要 DOM / Vite / 第三方依赖。
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createServerApp } from '../../server/http/app.js'
import { createSigner, verifyObjectSignature } from '../../server/core/rng.js'
import { MemoryStore } from '../../server/store/memory.js'
import { createDefaultConfig } from '../../server/core/config.js'

export function fakeClock(startMs = Date.UTC(2026, 8, 24, 2, 0, 0)) {
  let current = startMs
  return {
    now: () => current,
    set: (ms) => {
      current = ms
    },
    advance: (ms) => {
      current += ms
    },
  }
}

export function makeHarness(options = {}) {
  const clockControl = fakeClock(options.startMs)
  const store = new MemoryStore()
  const signer = createSigner()
  const logs = []
  const config = options.config ?? createDefaultConfig(options.configOverrides)
  const handler = createServerApp({
    clock: clockControl.now,
    store,
    signer,
    config,
    logger: (entry) => logs.push(entry),
  })
  const server = createServer(handler)

  async function listen() {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${server.address().port}`
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve))
  }

  async function request(method, path, { body, headers = {}, raw, baseUrl } = {}) {
    const url = new URL(path, baseUrl ?? (await listenOnce()))
    const hasPayload = method !== 'GET' && method !== 'HEAD' && (raw !== undefined || body !== undefined)
    const payload = !hasPayload ? undefined : raw !== undefined ? raw : JSON.stringify(body)
    const result = await fetch(url, {
      method,
      headers: {
        ...(hasPayload ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: payload,
    })
    const text = await result.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    return { status: result.status, headers: result.headers, body: json, rawText: text }
  }

  let basePromise
  function listenOnce() {
    if (!basePromise) basePromise = listen()
    return basePromise
  }

  async function createSession() {
    const response = await request('POST', '/api/session', { body: {} })
    const cookie = response.headers.get('set-cookie')
    const sid = /(?:^| )sid=([^;]+)/.exec(cookie)[1]
    return { sid, cookie: `sid=${sid}`, body: response.body }
  }

  function idemKey() {
    return randomUUID()
  }

  return {
    clock: clockControl,
    store,
    signer,
    config,
    logs,
    handler,
    close,
    request,
    createSession,
    idemKey,
    verify: (value, signatureHex) =>
      verifyObjectSignature(signer.publicKeyDerHex, value, signatureHex),
  }
}

/** 从 store 取该会话某卡的内部记录（含 seedHex/prize） */
export function internalCard(store, sid, campaignId, cardId) {
  return store.latestCards(sid, campaignId).get(cardId) ?? null
}
