/**
 * 前端 API 客户端：前端与权威服务端的唯一交互通道。
 *
 * 安全约束（设计第 1、4 节）：
 * - 所有结果只来自服务端响应；本模块不含任何摇奖/由 seed 推奖品的逻辑；
 * - 每个写动作携带稳定的 Idempotency-Key（localStorage 不可用时内存生成），
 *   网络失败可安全用同一键重试，服务端按 (sid, scope, key) 幂等裁决；
 * - 会话 cookie 由服务端 Set-Cookie（HttpOnly）下发，JS 不读不存 sid；
 * - 所有卡视图经 view.js 白名单过滤后才交给上层（纵深防御）。
 *
 * transport 可注入（测试用），生产默认 window.fetch + 20s 超时。
 */
import { sanitizeCardView, sanitizeFullView, CARD_STATUS } from './view.js'

export const API_BASE = '/api'
export const REQUEST_TIMEOUT_MS = 20_000

/** 网络层失败（不可达 / 超时 / 非 2xx 协议错误） */
export class ApiNetworkError extends Error {
  constructor(message, { status = null } = {}) {
    super(message)
    this.name = 'ApiNetworkError'
    this.status = status
  }
}

/** 服务端 4xx/5xx 协议错误体 */
export class ApiProtocolError extends Error {
  constructor(error, message, status) {
    super(message ?? error)
    this.name = 'ApiProtocolError'
    this.error = error
    this.status = status
  }
}

function defaultTransport(path, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  return fetch(`${API_BASE}${path}`, {
    ...options,
    signal: controller.signal,
    credentials: 'same-origin',
  }).finally(() => clearTimeout(timer))
}

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function createApiClient({ transport = defaultTransport } = {}) {
  async function request(method, path, body, { idempotencyKey = null } = {}) {
    const headers = {}
    let payload
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey

    let response
    try {
      response = await transport(path, { method, headers, body: payload })
    } catch (error) {
      if (error?.name === 'AbortError') throw new ApiNetworkError('请求超时')
      throw new ApiNetworkError('网络不可用，请求未送达服务端')
    }

    const text = await response.text().catch(() => '')
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    if (!response.ok) {
      if (json && typeof json.error === 'string') {
        throw new ApiProtocolError(json.error, json.message, response.status)
      }
      throw new ApiNetworkError(`服务端异常（${response.status}）`, { status: response.status })
    }
    return json ?? {}
  }

  const post = (path, body, options) => request('POST', path, body, options)
  const get = (path) => request('GET', path)

  /** 建立会话；sid 只在 HttpOnly cookie 中，响应只含展示元数据 */
  async function createSession() {
    const body = await post('/session', {})
    return {
      serverTime: body.serverTime ?? null,
      day: body.day ?? null,
      campaigns: Array.isArray(body.campaigns) ? body.campaigns : [],
    }
  }

  /** GET /state（?campaign= 可选）：多标签页/回前台/轮询的唯一真相源 */
  async function getState(campaignId = null) {
    const query = campaignId ? `?campaign=${encodeURIComponent(campaignId)}` : ''
    const body = await get(`/state${query}`)
    const view = sanitizeFullView(body)
    if (!view) throw new ApiNetworkError('服务端返回了无法识别的状态视图')
    return view
  }

  /** POST /recover：刷新/崩溃恢复，等价于重建页面所需的全量公开视图 */
  async function recover() {
    const body = await post('/recover', {})
    const view = sanitizeFullView(body)
    if (!view) throw new ApiNetworkError('服务端返回了无法识别的状态视图')
    return view
  }

  async function health() {
    return get('/healthz')
  }

  async function getVerificationKey() {
    return get('/verification-key')
  }

  function normalizeCardOutcome(body) {
    const card = sanitizeCardView(body.card)
    return {
      ok: Boolean(body.ok),
      reason: typeof body.reason === 'string' ? body.reason : null,
      card,
      chancesLeft: typeof body.chancesLeft === 'number' ? body.chancesLeft : null,
      day: typeof body.day === 'string' ? body.day : null,
      serverTime: typeof body.serverTime === 'string' ? body.serverTime : null,
      commitSig: typeof body.commitSig === 'string' ? body.commitSig : null,
    }
  }

  /**
   * 开始刮卡（占用一次机会）。
   * @param {string} key 该动作稳定幂等键（调用方持久化，重试必须复用）
   */
  async function begin(campaignId, cardId, key = newIdempotencyKey()) {
    const body = await post(
      `/campaigns/${encodeURIComponent(campaignId)}/scratch/begin`,
      { cardId },
      { idempotencyKey: key },
    )
    return { ...normalizeCardOutcome(body), idempotencyKey: key }
  }

  /** 揭晓（60% 与"直接揭开"走同一入口）；重试复用同一幂等键 */
  async function reveal(campaignId, cardId, key = newIdempotencyKey(), expectedRev = null) {
    const payload = { cardId }
    if (expectedRev != null) payload.expectedRev = expectedRev
    const body = await post(
      `/campaigns/${encodeURIComponent(campaignId)}/scratch/reveal`,
      payload,
      { idempotencyKey: key },
    )
    return { ...normalizeCardOutcome(body), idempotencyKey: key }
  }

  async function claim(campaignId, cardId, key = newIdempotencyKey()) {
    const body = await post(
      `/campaigns/${encodeURIComponent(campaignId)}/prizes/claim`,
      { cardId },
      { idempotencyKey: key },
    )
    return { ...normalizeCardOutcome(body), idempotencyKey: key }
  }

  /** 旧本地信封迁移导入（见 src/app/migration.js） */
  async function migrateImport({ payload, payloadHash, key }) {
    const body = await post(
      '/migrate/import',
      { payload, payloadHash },
      { idempotencyKey: key },
    )
    return body
  }

  return {
    createSession,
    getState,
    recover,
    health,
    getVerificationKey,
    begin,
    reveal,
    claim,
    migrateImport,
    newIdempotencyKey,
  }
}

export { CARD_STATUS }
