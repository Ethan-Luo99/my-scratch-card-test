/**
 * 服务端权威 API 客户端（前端访问服务端的唯一通道）。
 *
 * 红线：
 * - 本模块只做 HTTP 通信与响应形态校验，绝不本地摇奖、不本地推进状态；
 * - 网络错误 / 5xx / 超时统一抛出 NetworkError，调用方据此进入只读锁定；
 * - 所有写接口携带 Idempotency-Key，超时重放必须复用同一个 key（由调用方保证）；
 * - 卡片对象经 lib/view.js 白名单清洗后才返回（纵深防御：即便服务端误带
 *   seed/prize 到未揭晓视图，也不会进入前端内存视图）。
 */
import { sanitizeStateView, sanitizeCardView } from '../lib/view.js'

export const API_BASE = '/api'
export const REQUEST_TIMEOUT_MS = 12000

export class NetworkError extends Error {
  constructor(message = 'network-unavailable') {
    super(message)
    this.name = 'NetworkError'
    this.code = 'network-unavailable'
  }
}

export class ApiError extends Error {
  constructor(status, error, message) {
    super(message ?? error)
    this.name = 'ApiError'
    this.status = status
    this.code = error
  }
}

export function createApiClient({
  base = API_BASE,
  fetchImpl = defaultFetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  onUnauthorized = null,
} = {}) {
  async function request(method, path, options = {}, retried = false) {
    const { body = undefined, idempotencyKey = null } = options
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        credentials: 'same-origin',
      })
    } catch (error) {
      throw new NetworkError(error?.name === 'AbortError' ? 'request-timeout' : 'network-unavailable')
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text().catch(() => '')
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }

    if (response.status >= 502 && response.status <= 504) {
      throw new NetworkError(`bad-gateway-${response.status}`)
    }
    if (response.status >= 400) {
      // 会话过期/丢失：经外部钩子重建会话后原样重试一次（写请求幂等键不变）
      if (response.status === 401 && !retried && typeof onUnauthorized === 'function') {
        await onUnauthorized()
        return request(method, path, options, true)
      }
      throw new ApiError(response.status, parsed?.error ?? 'error', parsed?.message)
    }
    return parsed ?? {}
  }

  const post = (path, payload, idempotencyKey) =>
    request('POST', path, { body: payload ?? {}, idempotencyKey })

  return {
    /** 幂等建会话：cookie 已存在时服务端同样下发新 sid，故仅在无会话/401 时调用 */
    createSession: () => post('/session', {}),
    health: () => request('GET', '/healthz'),
    verificationKey: () => request('GET', '/verification-key'),
    state: async (campaignId = null) => {
      const query = campaignId ? `?campaign=${encodeURIComponent(campaignId)}` : ''
      const view = await request('GET', `/state${query}`)
      return sanitizeStateView(view)
    },
    recover: async () => sanitizeStateView(await post('/recover', {})),
    begin: async (campaignId, cardId, idempotencyKey) => {
      const body = await post(
        `/campaigns/${encodeURIComponent(campaignId)}/scratch/begin`,
        { cardId },
        idempotencyKey,
      )
      return normalizeActionBody(body)
    },
    reveal: async (campaignId, cardId, idempotencyKey, expectedRev = null) => {
      const payload = { cardId }
      if (expectedRev != null) payload.expectedRev = expectedRev
      const body = await post(
        `/campaigns/${encodeURIComponent(campaignId)}/scratch/reveal`,
        payload,
        idempotencyKey,
      )
      return normalizeActionBody(body)
    },
    claim: async (campaignId, cardId, idempotencyKey) => {
      const body = await post(
        `/campaigns/${encodeURIComponent(campaignId)}/prizes/claim`,
        { cardId },
        idempotencyKey,
      )
      return normalizeActionBody(body)
    },
    migrateImport: (payload, payloadHash, idempotencyKey) =>
      post('/migrate/import', { payload, payloadHash }, idempotencyKey),
  }
}

/** begin/reveal/claim 的 {ok,card,...} 体：card 同样过白名单清洗 */
function normalizeActionBody(body) {
  if (body && typeof body === 'object' && body.card && typeof body.card === 'object') {
    return { ...body, card: sanitizeCardView(body.card) }
  }
  return body
}

function defaultFetch(input, init) {
  return fetch(input, init)
}

/** 去重令牌：仅用于服务端幂等，无秘密含义 */
export function newIdempotencyKey(randomUuid = defaultUuid) {
  return randomUuid()
}

function defaultUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}
