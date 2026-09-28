/**
 * localStorage 白名单缓存（设计文档 4.3 的唯一落盘出口）。
 *
 * 只允许以下四类数据，且全部经过白名单清洗后才写入：
 * 1. 承诺存档（commitments）：{campaignId,cardId,commitment,commitSig,
 *    weightsVersion,day,rev} —— 承诺不可推出 seed/奖品；
 * 2. 已揭晓/已领取卡的公开视图缓存（revealed）：含 prize/receipt，
 *    这些内容对该用户已公开，用于离线只读展示；
 * 3. 验证公钥缓存（verification-key）；
 * 4. 会话无关的 UI 偏好（prefs）。
 *
 * 一票否决：任何路径都不得把未揭晓卡的 seed/seedHex/prize 写入本模块；
 * sanitize 层对 revealed 缓存做 status 校验，pending/idle 卡一律不落盘。
 */
import { sanitizeCardView, CARD_STATUS } from '../lib/view.js'

export const CACHE_KEYS = Object.freeze({
  commitments: 'scratch-card:v3:commitments',
  revealed: 'scratch-card:v3:revealed',
  verificationKey: 'scratch-card:v3:verification-key',
  prefs: 'scratch-card:v3:prefs',
})

/** 迁移流程需要识别并清理的旧 key（迁移成功前只读，成功后删除） */
export const LEGACY_KEYS = Object.freeze(['scratch-campaign-v1', 'scratch-campaign:v2:'])

export function createCacheStore(backend) {
  function readJson(key) {
    let raw = null
    try {
      raw = backend.getItem(key)
    } catch {
      raw = null
    }
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function writeJson(key, value) {
    try {
      backend.setItem(key, JSON.stringify(value))
    } catch {
      // 存储降级/配额失败：缓存写失败不影响在线正确性
    }
  }

  // ---------- 承诺存档 ----------
  function loadCommitments() {
    const raw = readJson(CACHE_KEYS.commitments)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [cardId, entry] of Object.entries(raw)) {
      const clean = sanitizeCommitmentEntry(entry)
      if (clean) out[cardId] = clean
    }
    return out
  }

  function saveCommitment(campaignId, entry) {
    const clean = sanitizeCommitmentEntry(entry)
    if (!clean) return
    const all = loadCommitments()
    all[entry.cardId] = { ...clean, campaignId }
    writeJson(CACHE_KEYS.commitments, all)
  }

  function pruneCommitments(keepCardIds) {
    const all = loadCommitments()
    const keep = new Set(keepCardIds)
    let changed = false
    for (const cardId of Object.keys(all)) {
      if (!keep.has(cardId)) {
        delete all[cardId]
        changed = true
      }
    }
    if (changed) writeJson(CACHE_KEYS.commitments, all)
  }

  // ---------- 已揭晓/已领取卡缓存（离线只读展示用） ----------
  function loadRevealedCards() {
    const raw = readJson(CACHE_KEYS.revealed)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [cardId, entry] of Object.entries(raw)) {
      const clean = sanitizeRevealedEntry(entry)
      if (clean) out[cardId] = clean
    }
    return out
  }

  function saveRevealedCard(campaignId, card) {
    const clean = sanitizeRevealedEntry(card)
    if (!clean) return
    const all = loadRevealedCards()
    all[clean.cardId] = { ...clean, campaignId }
    writeJson(CACHE_KEYS.revealed, all)
  }

  function pruneRevealedCards(keepCardIds) {
    const all = loadRevealedCards()
    const keep = new Set(keepCardIds)
    let changed = false
    for (const cardId of Object.keys(all)) {
      if (!keep.has(cardId)) {
        delete all[cardId]
        changed = true
      }
    }
    if (changed) writeJson(CACHE_KEYS.revealed, all)
  }

  /**
   * 按活动对账：用服务端当前视图中 revealed/claimed 卡整体替换该活动的缓存，
   * 服务端已回到 idle/pending（如跨天新卡）的旧已揭晓缓存会被清除。
   * 只操作带同一 campaignId 标记的条目，不影响其他活动（cardId 全局唯一）。
   */
  function replaceRevealedForCampaign(campaignId, cards) {
    const all = loadRevealedCards()
    let changed = false
    for (const cardId of Object.keys(all)) {
      if (all[cardId].campaignId === campaignId) {
        delete all[cardId]
        changed = true
      }
    }
    for (const card of cards) {
      const clean = sanitizeRevealedEntry(card)
      if (clean) {
        all[clean.cardId] = { ...clean, campaignId }
        changed = true
      }
    }
    if (changed) writeJson(CACHE_KEYS.revealed, all)
  }

  /** 承诺对账：只保留服务端当前 pending 卡的承诺 */
  function replaceCommitmentsForCampaign(campaignId, entries) {
    const all = loadCommitments()
    let changed = false
    for (const cardId of Object.keys(all)) {
      if (all[cardId].campaignId === campaignId) {
        delete all[cardId]
        changed = true
      }
    }
    for (const entry of entries) {
      const clean = sanitizeCommitmentEntry(entry)
      if (clean) {
        all[clean.cardId] = { ...clean, campaignId }
        changed = true
      }
    }
    if (changed) writeJson(CACHE_KEYS.commitments, all)
  }

  // ---------- 验证公钥缓存 ----------
  function loadVerificationKey() {
    const raw = readJson(CACHE_KEYS.verificationKey)
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.publicKeyHex !== 'string' || typeof raw.alg !== 'string') return null
    return {
      alg: raw.alg,
      publicKeyHex: raw.publicKeyHex,
      keyId: typeof raw.keyId === 'string' ? raw.keyId : null,
      issuedAt: typeof raw.issuedAt === 'string' ? raw.issuedAt : null,
    }
  }

  function saveVerificationKey(keyInfo) {
    if (!keyInfo || typeof keyInfo.publicKeyHex !== 'string') return
    writeJson(CACHE_KEYS.verificationKey, {
      alg: String(keyInfo.alg ?? ''),
      publicKeyHex: keyInfo.publicKeyHex,
      keyId: typeof keyInfo.keyId === 'string' ? keyInfo.keyId : null,
      issuedAt: typeof keyInfo.issuedAt === 'string' ? keyInfo.issuedAt : null,
    })
  }

  // ---------- UI 偏好 ----------
  function loadPrefs() {
    const raw = readJson(CACHE_KEYS.prefs)
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  }

  function savePrefs(patch) {
    writeJson(CACHE_KEYS.prefs, { ...loadPrefs(), ...patch })
  }

  return {
    get isPersistent() {
      return Boolean(backend.isPersistent)
    },
    loadCommitments,
    saveCommitment,
    pruneCommitments,
    loadRevealedCards,
    saveRevealedCard,
    pruneRevealedCards,
    replaceRevealedForCampaign,
    replaceCommitmentsForCampaign,
    loadVerificationKey,
    saveVerificationKey,
    loadPrefs,
    savePrefs,
  }
}

function sanitizeCommitmentEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.cardId !== 'string' || typeof entry.commitment !== 'string') return null
  const out = { cardId: entry.cardId, commitment: entry.commitment }
  if (typeof entry.campaignId === 'string') out.campaignId = entry.campaignId
  for (const field of ['commitSig', 'weightsVersion', 'day']) {
    if (typeof entry[field] === 'string') out[field] = entry[field]
  }
  const rev = Number(entry.rev)
  if (Number.isFinite(rev) && rev >= 0) out.rev = Math.floor(rev)
  return out
}

/** 已揭晓缓存：status 必须是 revealed/claimed，且经过公开视图白名单 */
function sanitizeRevealedEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (entry.status !== CARD_STATUS.REVEALED && entry.status !== CARD_STATUS.CLAIMED) return null
  const clean = sanitizeCardView(entry)
  if (!clean) return null
  if (typeof entry.day === 'string') clean.day = entry.day
  return clean
}
