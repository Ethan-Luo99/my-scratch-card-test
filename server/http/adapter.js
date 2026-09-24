/**
 * 极薄 HTTP 适配层：把 Node (req,res) 映射到引擎纯函数调用。
 * 不含任何业务规则；只负责路由、JSON 解析、Cookie、状态码映射。
 */

const REASON_STATUS = {
  'no-session': 401,
  'unknown-campaign': 404,
  'unknown-card': 404,
  'bad-request': 400,
  conflict: 409,
  internal: 500,
}

const MAX_BODY_BYTES = 1024 * 1024

function statusFor(body) {
  if (body && body.ok === false && REASON_STATUS[body.reason]) {
    return REASON_STATUS[body.reason]
  }
  return 200
}

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseCookies(req) {
  const header = req.headers.cookie
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

function parseJson(text) {
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

/**
 * 把引擎挂载为 (req,res,next?) 处理器。假定已按 /api 前缀挂载
 * （connect 中间件会剥离前缀；独立运行时由 server/index.js 剥离）。
 */
export function createHttpAdapter(engine) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method || 'GET'
    const cookies = parseCookies(req)
    const sid = cookies.sid || null
    const idemKey = req.headers['idempotency-key'] || null

    try {
      if (method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, engine.healthz())
      }
      if (method === 'GET' && path === '/verification-key') {
        return sendJson(res, 200, engine.verificationKey())
      }
      if (method === 'POST' && path === '/session') {
        const { sid: newSid, body } = engine.createSession()
        return sendJson(res, 200, body, {
          'set-cookie': `sid=${newSid}; HttpOnly; SameSite=Lax; Path=/`,
        })
      }
      if (method === 'GET' && path === '/state') {
        const body = engine.getState(sid, url.searchParams.get('campaign'))
        return sendJson(res, statusFor(body), body)
      }
      if (method === 'POST' && path === '/recover') {
        const body = engine.recover(sid)
        return sendJson(res, statusFor(body), body)
      }
      if (method === 'POST' && path === '/migrate/import') {
        const parsed = parseJson(await readBody(req))
        if (!parsed.ok) return sendJson(res, 400, { ok: false, reason: 'bad-request' })
        const body = await engine.migrateImport(sid, parsed.value, idemKey)
        return sendJson(res, statusFor(body), body)
      }

      const scratchMatch = path.match(
        /^\/campaigns\/([^/]+)\/scratch\/(begin|reveal)$/,
      )
      if (method === 'POST' && scratchMatch) {
        const parsed = parseJson(await readBody(req))
        if (!parsed.ok) return sendJson(res, 400, { ok: false, reason: 'bad-request' })
        const [, campaignId, action] = scratchMatch
        const body =
          action === 'begin'
            ? await engine.begin(sid, campaignId, parsed.value, idemKey)
            : await engine.reveal(sid, campaignId, parsed.value, idemKey)
        return sendJson(res, statusFor(body), body)
      }

      const claimMatch = path.match(/^\/campaigns\/([^/]+)\/prizes\/claim$/)
      if (method === 'POST' && claimMatch) {
        const parsed = parseJson(await readBody(req))
        if (!parsed.ok) return sendJson(res, 400, { ok: false, reason: 'bad-request' })
        const body = await engine.claim(sid, claimMatch[1], parsed.value, idemKey)
        return sendJson(res, statusFor(body), body)
      }

      return sendJson(res, 404, { ok: false, reason: 'bad-request' })
    } catch {
      // 错误体不得带出任何秘密字段
      return sendJson(res, 500, { ok: false, reason: 'internal' })
    }
  }
}
