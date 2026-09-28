/**
 * 旧本地数据迁移（设计文档 5.2 的客户端侧）。
 *
 * 流程：检测旧 key -> 页面只读锁定 -> 整包 POST /api/migrate/import
 * （客户端只是搬运，不据旧数据开奖）-> 成功后删除旧 key -> GET /state 对齐。
 * 失败：保留旧 key、维持锁定、允许重试；绝不因迁移失败走本地开奖兜底。
 *
 * 多标签页：用 Web Locks（缺失时退化本地 Promise 链）做单飞，未抢到锁的
 * 标签页轮询等待，旧 key 消失（经 storage 事件）后重新走正常初始化。
 */

export const LEGACY_V1_KEY = 'scratch-campaign-v1'
export const LEGACY_V2_PREFIX = 'scratch-campaign:v2:'
export const MIGRATION_LOCK_NAME = 'scratch-card:migration-lock'

/** 扫描存储后端中的旧 key（v1 单 key + v2 命名空间 key） */
export function detectLegacyKeys(backend) {
  const found = []
  let keys = []
  try {
    keys = typeof backend.keys === 'function' ? backend.keys() : []
  } catch {
    keys = []
  }
  for (const key of keys) {
    if (key === LEGACY_V1_KEY || key.startsWith(LEGACY_V2_PREFIX)) found.push(key)
  }
  return found
}

/**
 * 读取旧 key 的原始内容并组装迁移 payload（原样搬运，不解析业务字段）。
 * @returns {{payload:object, keys:string[]}|null}
 */
export function readLegacyPayload(backend, keys) {
  const envelopes = []
  const readableKeys = []
  for (const key of keys) {
    let raw = null
    try {
      raw = backend.getItem(key)
    } catch {
      raw = null
    }
    if (!raw) continue
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object') continue
    const campaignId = key === LEGACY_V1_KEY
      ? 'daily'
      : key.slice(LEGACY_V2_PREFIX.length)
    envelopes.push({ campaignId, envelope: parsed })
    readableKeys.push(key)
  }
  if (envelopes.length === 0) return null
  return { payload: { envelopes }, keys: readableKeys }
}

/** SHA-256 hex（迁移幂等键用；无 WebCrypto 时退化为 null，由服务端兜底） */
export async function sha256Hex(text, subtle = defaultSubtle()) {
  if (!subtle) return null
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function defaultSubtle() {
  try {
    return typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null
  } catch {
    return null
  }
}

/** 迁移幂等键：同一 payload 稳定同键，天然防重复导入 */
export async function migrationIdempotencyKey(payload, subtle) {
  const hash = await sha256Hex(JSON.stringify(payload), subtle)
  return hash ? `migrate:${hash}` : null
}

/** 迁移成功后删除旧 key */
export function removeLegacyKeys(backend, keys) {
  for (const key of keys) {
    try {
      backend.removeItem(key)
    } catch {
      // 删除失败不影响服务端侧已完成的迁移；下次启动会重试清理
    }
  }
}

/**
 * 执行迁移（跨标签页安全）：
 * - Web Locks 把多标签页串行化，每个标签页进锁后重新扫描旧 key，
 *   先到者导入并删 key，后到者看到空直接完成；
 * - 同一 payload 的幂等键稳定（内容哈希），即便多页并发也只生效一次；
 * - 服务端拒绝 / 网络失败：保留旧 key、返回失败，页面维持锁定可重试。
 * @returns {Promise<{migrated:boolean, result?:object, reason?:string}>}
 */
export async function runMigration({ backend, locks, importFn, onKeysRemoved }) {
  const attempt = async () => {
    const keys = detectLegacyKeys(backend)
    if (keys.length === 0) return { migrated: false }
    const legacy = readLegacyPayload(backend, keys)
    if (!legacy) {
      // key 存在但内容不可解析：视为垃圾数据，直接清理避免永久锁定
      removeLegacyKeys(backend, keys)
      return { migrated: false }
    }
    const payloadHash = await sha256Hex(JSON.stringify(legacy.payload))
    const idempotencyKey = await migrationIdempotencyKey(legacy.payload)
    let result
    try {
      result = await importFn(legacy.payload, payloadHash, idempotencyKey)
    } catch {
      // 网络/服务端失败：保留旧 key，返回失败态，页面维持锁定可重试
      return { migrated: false, reason: 'import-failed' }
    }
    if (!result || result.ok !== true) {
      return { migrated: false, reason: 'server-rejected', result }
    }
    removeLegacyKeys(backend, legacy.keys)
    return { migrated: true, result }
  }

  const run = async () => {
    const outcome = await attempt()
    if (!outcome.migrated && detectLegacyKeys(backend).length === 0) {
      if (typeof onKeysRemoved === 'function') await onKeysRemoved()
    }
    return outcome
  }

  if (locks && locks.supported) {
    return locks.withLock(MIGRATION_LOCK_NAME, run)
  }
  return run()
}
