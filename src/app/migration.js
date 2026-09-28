/**
 * 旧本地数据迁移向导（设计 5.2）。
 *
 * 流程：检测旧 v1/v2 key → 页面只读锁定 → 整包 POST /api/migrate/import
 * （Idempotency-Key = migrate:<sha256(payload)>，重放安全）→ 成功后删除旧 key。
 *
 * 硬约束：
 * - 客户端只是搬运，不依据旧信封开奖、不把旧 seed/prize 纳入任何业务状态；
 * - 失败保留旧 key、维持锁定，允许重试；绝不因失败走本地开奖兜底；
 * - 服务端按去重键防"导入→领取→再导入→再领"；幂等键保证同 payload 只生效一次。
 */
import { createHashHex } from '../verify/hash.js'

export function createMigrationWizard({ api, cache }) {
  let inflight = null

  /** 仅检测是否存在可解析的旧信封（不解析进业务状态） */
  function detectLegacy() {
    try {
      return cache.scanLegacy()
    } catch {
      return []
    }
  }

  /**
   * 执行迁移。多标签页/重复点击单飞：同一 Promise 复用。
   * @returns {Promise<{ok:boolean, imported?:object, discarded?:object, error?:Error, removed:number}>}
   */
  function run() {
    if (inflight) return inflight
    inflight = doRun().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function doRun() {
    const legacy = detectLegacy()
    if (legacy.length === 0) return { ok: true, imported: { claimed: [], revealed: [] }, discarded: {}, removed: 0 }

    const payload = {
      envelopes: legacy.map((item) => ({
        campaignId: item.campaignId,
        envelope: item.envelope,
      })),
    }
    const payloadHash = await createHashHex(JSON.stringify(payload))
    const key = `migrate:${payloadHash}`

    let result
    try {
      result = await api.migrateImport({ payload, payloadHash, key })
    } catch (error) {
      // 网络/协议失败：旧 key 全部保留，页面维持锁定，可重试
      return { ok: false, error, removed: 0 }
    }
    if (!result || result.ok === false) {
      return { ok: false, error: new Error(result?.error ?? '迁移被服务端拒绝'), removed: 0 }
    }

    let removed = 0
    for (const item of legacy) {
      try {
        cache.removeLegacyKey(item.key)
        removed += 1
      } catch {
        // 删除失败：下次进入仍会检测到，服务端幂等保证不重复生效
      }
    }
    return {
      ok: true,
      imported: result.imported ?? { claimed: [], revealed: [] },
      discarded: result.discarded ?? {},
      removed,
    }
  }

  return { detectLegacy, run, get inflight() { return inflight } }
}
