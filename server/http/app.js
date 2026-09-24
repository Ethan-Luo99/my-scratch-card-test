/**
 * 极薄 HTTP 适配层：路由 / JSON 解析 / Cookie / 幂等头，业务全部在 core/engine。
 *
 * createServerApp 返回兼容 Node http.createServer 与 Vite/Connect 中间件的
 * 处理函数 (req, res, next?)：
 * - 独立运行（server/index.js / node:http）时路径为完整 /api/...；
 * - 经 vite.config.js 的 middlewares.use('/api', handler) 挂载时 req.url
 *   已被去掉 /api 前缀，内部两种形态都能匹配。
 */
import { createServerEngine, EngineError } from '../core/engine.js'
import { MemoryStore } from '../store/memory.js'
import { createSigner } from '../core/rng.js'
import { createDefaultConfig } from '../core/config.js'

const API_PREFIX = '/api'
const SESSION_COOKIE = 'sid'

function matchPath(pathname, path) {
  return pathname === path || pathname === `${API_PREFIX}${path}`
}

function readJsonBody(req, { limitBytes = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new EngineError(413, 'bad-request', 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        reject(new EngineError(400, 'bad-request', 'invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function parseCookies(req) {
  const header = req.headers.cookie
  if (!header) return {}
  const out = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

export function createServerApp(options = {}) {
  const clock = options.clock ?? (() => Date.now())
  const store = options.store ?? new MemoryStore()
  const signer = options.signer ?? createSigner()
  const config = options.config ?? createDefaultConfig()
  const logger = options.logger
  const engine = options.engine ?? createServerEngine({ clock, store, signer, config, logger })

  function sendJson(res, { status = 200, body, headers }) {
    const raw = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(headers ?? {}),
    })
    res.end(raw)
  }

  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method.toUpperCase()
    const cookies = parseCookies(req)
    const sid = cookies[SESSION_COOKIE] || null

    const idempotencyKey = req.headers['idempotency-key']
      ? String(req.headers['idempotency-key']).slice(0, 200)
      : null

    const writeRequiresKey = (path) =>
      method === 'POST' &&
      path !== '/session' &&
      !idempotencyKey &&
      (path.includes('/scratch/') || path.includes('/prizes/claim') || path === '/migrate/import')

    try {
      const body = method === 'POST' ? await readJsonBody(req) : {}

      // GET
      if (method === 'GET' && matchPath(pathname, '/healthz')) {
        return sendJson(res, { status: 200, body: engine.health() })
      }
      if (method === 'GET' && matchPath(pathname, '/verification-key')) {
        return sendJson(res, { status: 200, body: engine.verificationKey() })
      }
      if (method === 'GET' && matchPath(pathname, '/state')) {
        const campaignId = url.searchParams.get('campaign')
        const result = await engine.state(sid, campaignId)
        return sendJson(res, { status: 200, body: result })
      }

      // POST
      if (method === 'POST' && matchPath(pathname, '/session')) {
        const { setCookieSid, body: responseBody } = engine.createSession()
        const cookie = [
          `${SESSION_COOKIE}=${encodeURIComponent(setCookieSid)}`,
          'HttpOnly',
          'SameSite=Lax',
          'Path=/',
          'Max-Age=2592000',
        ].join('; ')
        return sendJson(res, { status: 200, body: responseBody, headers: { 'set-cookie': cookie } })
      }

      const beginMatch = pathname.match(/(?:^|\/api)\/campaigns\/([^/]+)\/scratch\/begin$/)
      if (method === 'POST' && beginMatch) {
        const path = `/campaigns/${beginMatch[1]}/scratch/begin`
        if (writeRequiresKey(path)) throw new EngineError(400, 'bad-request', 'Idempotency-Key required')
        const result = await engine.begin(sid, {
          campaignId: decodeURIComponent(beginMatch[1]),
          cardId: body.cardId,
          idempotencyKey,
        })
        return sendJson(res, { status: 200, body: result })
      }

      const revealMatch = pathname.match(/(?:^|\/api)\/campaigns\/([^/]+)\/scratch\/reveal$/)
      if (method === 'POST' && revealMatch) {
        const path = `/campaigns/${revealMatch[1]}/scratch/reveal`
        if (writeRequiresKey(path)) throw new EngineError(400, 'bad-request', 'Idempotency-Key required')
        const result = await engine.reveal(sid, {
          campaignId: decodeURIComponent(revealMatch[1]),
          cardId: body.cardId,
          expectedRev: body.expectedRev,
          idempotencyKey,
        })
        return sendJson(res, { status: 200, body: result })
      }

      const claimMatch = pathname.match(/(?:^|\/api)\/campaigns\/([^/]+)\/prizes\/claim$/)
      if (method === 'POST' && claimMatch) {
        const path = `/campaigns/${claimMatch[1]}/prizes/claim`
        if (writeRequiresKey(path)) throw new EngineError(400, 'bad-request', 'Idempotency-Key required')
        const result = await engine.claim(sid, {
          campaignId: decodeURIComponent(claimMatch[1]),
          cardId: body.cardId,
          idempotencyKey,
        })
        return sendJson(res, { status: 200, body: result })
      }

      if (method === 'POST' && matchPath(pathname, '/migrate/import')) {
        if (!idempotencyKey) throw new EngineError(400, 'bad-request', 'Idempotency-Key required')
        const result = await engine.migrateImport(sid, {
          payload: body.payload,
          payloadHash: body.payloadHash,
          idempotencyKey,
        })
        return sendJson(res, { status: 200, body: result })
      }

      if (method === 'POST' && matchPath(pathname, '/recover')) {
        const result = await engine.recover(sid)
        return sendJson(res, { status: 200, body: result })
      }

      return sendJson(res, { status: 404, body: { error: 'not-found' } })
    } catch (error) {
      if (error instanceof EngineError) {
        return sendJson(res, { status: error.status, body: { error: error.error, message: error.message } })
      }
      if (logger) logger({ level: 'error', event: 'unhandled', message: String(error?.message ?? error) })
      return sendJson(res, { status: 500, body: { error: 'internal-error' } })
    }
  }

  const handler = (req, res, next) => {
    dispatch(req, res).catch((error) => {
      if (typeof next === 'function') return next(error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal-error' }))
      }
    })
  }
  handler.engine = engine
  return handler
}
