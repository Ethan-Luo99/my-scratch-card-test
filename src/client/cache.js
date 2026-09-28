/**
 * 前端本地缓存（设计 4.3 白名单）。
 *
 * 唯一允许落盘的内容：
 *   1) 承诺存档（commitments）：SHA-256 承诺 + 签名，推不出 seed/奖品；
 *   2) 已揭晓/已领取卡的公开视图（views/<cid>）：含 prize/receipt，
 *      这些在揭晓时已对该用户公开，仅用于离线只读；
 *   3) 会话展示元数据（session-meta）：活动名/卡位数/每日次数，无结果；
 *   4) 验签公钥（verification-key）；
 *   5) 稳定幂等键（idempotency-keys）：随机令牌，无秘密含义；
 *   6) UI 偏好（prefs）。
 *
 * 严禁落盘：未揭晓卡的 seed/prize/receipt、本地摇奖状态、旧 v1/v2 信封
 * （旧 key 仅迁移期临时读取，导入成功即删除）。所有写入口都在本模块，
 * saveView 只接受 sanitizeCardView 产物（由控制器保证，这里再断言一次）。
 *
 * localStorage 不可用（禁用 / 配额 / 安全策略）时自动退化为内存 Map：
 * 在线才能用、无离线只读缓存；任何降级路径都不会本地开奖。
 */

export const CACHE_PREFIX = 'scratch:v1:'
export const LEGACY_V1_KEY = 'scratch-campaign-v1'
export const LEGACY_V2_PREFIX = 'scratch-campaign:v2:'

const K = {
  commitments: (campaignId) => `${CACHE_PREFIX}commitments:${campaignId}`,
  views: (campaignId) => `${CACHE_PREFIX}views:${campaignId}`,
  sessionMeta: () => `${CACHE_PREFIX}session-meta`,
  verificationKey: () => `${CACHE_PREFIX}verification-key`,
  idempotency: (scope, campaignId, cardId, discriminator) =>
    `${CACHE_PREFIX}idem:${scope}:${campaignId}:${cardId}:${discriminator ?? 'na'}`,
  idemIndex: () => `${CACHE_PREFIX}idem-keys`,
  prefs: () => `${CACHE_PREFIX}prefs`,
}

const OPEN_STATUSES = new Set(['revealed', 'claimed'])

function defaultStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

export function createClientCache({ storageFactory = defaultStorage } = {}) {
  // 故障转移包装：localStorage 初始可用，但运行中写入抛错（配额/策略变更）时，
  // 后续写入转入内存；读取先看内存覆盖层再回真实 localStorage，旧数据仍可读。
  let real = null
  const memory = new Map()
  let persistent = false

  try {
    real = storageFactory()
    if (real) {
      const probe = '__scratch_probe__'
      real.setItem(probe, '1')
      real.removeItem(probe)
      persistent = true
    }
  } catch {
    real = null
    persistent = false
  }

  if (!real) {
    real = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      key: () => null,
      length: 0,
    }
  }

  const backend = {
    getItem(key) {
      if (memory.has(key)) return memory.get(key)
      try {
        return real.getItem(key)
      } catch {
        return memory.get(key) ?? null
      }
    },
    setItem(key, value) {
      if (persistent) {
        try {
          real.setItem(key, value)
          return
        } catch {
          persistent = false
        }
      }
      memory.set(key, String(value))
    },
    removeItem(key) {
      memory.delete(key)
      try {
        real.removeItem(key)
      } catch {
        persistent = false
      }
    },
    key(index) {
      const realKeys = []
      try {
        for (let i = 0; i < (real.length ?? 0); i += 1) {
          const key = real.key(i)
          if (key != null) realKeys.push(key)
        }
      } catch {
        // 真实存储不可枚举：只暴露内存键
      }
      const all = Array.from(new Set([...realKeys, ...memory.keys()]))
      return all[index] ?? null
    },
    get length() {
      const seen = new Set(memory.keys())
      try {
        for (let i = 0; i < (real.length ?? 0); i += 1) {
          const key = real.key(i)
          if (key != null) seen.add(key)
        }
      } catch {
        // 忽略
      }
      return seen.size
    },
  }

  function readJson(key, fallback = null) {
    try {
      const raw = backend.getItem(key)
      if (raw == null) return fallback
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  function writeJson(key, value) {
    try {
      backend.setItem(key, JSON.stringify(value))
    } catch {
      // 运行中存储失效（backend 内部已故障转移到内存）：不抛出
      persistent = false
    }
  }

  function remove(key) {
    backend.removeItem(key)
  }

  // ---------- 已揭晓公开视图缓存 ----------
  function loadViews(campaignId) {
    const data = readJson(K.views(campaignId), {})
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out = {}
    for (const [cardId, card] of Object.entries(data)) {
      if (card && typeof card === 'object' && OPEN_STATUSES.has(card.status) && card.prize) {
        out[cardId] = card
      }
    }
    return out
  }

  /**
   * 合并一个服务端卡视图进缓存。
   * 只有 revealed/claimed 落盘；idle/pending/expired 绝不落盘（防未揭晓秘密）。
   */
  function saveCardView(card) {
    if (!card || typeof card !== 'object') return
    if (!OPEN_STATUSES.has(card.status)) {
      // 进行中卡：反而要清掉可能残留的旧缓存（正常不会有，纵深防御）
      removeCardView(card.campaignId, card.cardId)
      return
    }
    if (!card.prize || typeof card.prize.name !== 'string') return
    const campaignId = card.campaignId
    const views = loadViews(campaignId)
    const previous = views[card.cardId]
    // 终态/较新 rev 覆盖；claimed 不回退到 revealed
    if (
      !previous ||
      card.rev >= previous.rev ||
      (card.status === 'claimed' && previous.status !== 'claimed')
    ) {
      const safe = {
        cardId: card.cardId,
        campaignId,
        status: card.status,
        rev: card.rev,
        prize: { name: card.prize.name, win: Boolean(card.prize.win) },
      }
      if (card.receipt) safe.receipt = card.receipt
      if (card.claimRef) safe.claimRef = card.claimRef
      views[card.cardId] = safe
      writeJson(K.views(campaignId), views)
    }
  }

  function removeCardView(campaignId, cardId) {
    const views = loadViews(campaignId)
    if (views[cardId]) {
      delete views[cardId]
      writeJson(K.views(campaignId), views)
    }
  }

  // ---------- 承诺存档 ----------
  function loadCommitments(campaignId) {
    const data = readJson(K.commitments(campaignId), {})
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out = {}
    for (const [cardId, entry] of Object.entries(data)) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.commitment === 'string' &&
        /^[0-9a-f]{64}$/.test(entry.commitment)
      ) {
        out[cardId] = entry
      }
    }
    return out
  }

  function saveCommitment(campaignId, cardId, entry) {
    if (!entry || typeof entry.commitment !== 'string') return
    const all = loadCommitments(campaignId)
    all[cardId] = {
      campaignId,
      cardId,
      commitment: entry.commitment,
      commitSig: typeof entry.commitSig === 'string' ? entry.commitSig : null,
      weightsVersion:
        typeof entry.weightsVersion === 'string' ? entry.weightsVersion : null,
      day: typeof entry.day === 'string' ? entry.day : null,
      rev: typeof entry.rev === 'number' ? entry.rev : null,
    }
    writeJson(K.commitments(campaignId), all)
  }

  function removeCommitment(campaignId, cardId) {
    const all = loadCommitments(campaignId)
    if (all[cardId]) {
      delete all[cardId]
      writeJson(K.commitments(campaignId), all)
    }
  }

  // ---------- 会话元数据 ----------
  function saveSessionMeta(meta) {
    if (!meta || typeof meta !== 'object') return
    // 只持久化离线渲染卡位所需的最小元数据；标题/副标题等展示文案可能包含
    // 奖池名称（公开的营销文案），不进存储，以满足"存储值不含任何奖品名"的
    // 严格扫描；在线时这些字段一律来自服务端视图
    const campaigns = (Array.isArray(meta.campaigns) ? meta.campaigns : [])
      .filter((item) => item && typeof item.campaignId === 'string')
      .map((item) => ({
        campaignId: item.campaignId,
        cardIds: Array.isArray(item.cardIds) ? item.cardIds.filter((id) => typeof id === 'string') : [],
      }))
    writeJson(K.sessionMeta(), {
      day: typeof meta.day === 'string' ? meta.day : null,
      campaigns,
    })
  }

  function loadSessionMeta() {
    return readJson(K.sessionMeta(), null)
  }

  // ---------- 验签公钥 ----------
  function saveVerificationKey(keyInfo) {
    if (!keyInfo || typeof keyInfo.publicKeyHex !== 'string') return
    writeJson(K.verificationKey(), keyInfo)
  }

  function loadVerificationKey() {
    return readJson(K.verificationKey(), null)
  }

  // ---------- 幂等键（重试复用同一键） ----------
  function loadIdemIndex() {
    const data = readJson(K.idemIndex(), {})
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }

  function getIdempotencyKey(scope, campaignId, cardId, discriminator = null) {
    const index = loadIdemIndex()
    const id = K.idempotency(scope, campaignId, cardId, discriminator)
    if (typeof index[id] === 'string') return index[id]
    const key =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    index[id] = key
    writeJson(K.idemIndex(), index)
    return key
  }

  // ---------- UI 偏好 ----------
  function savePrefs(prefs) {
    if (!prefs || typeof prefs !== 'object') return
    writeJson(K.prefs(), prefs)
  }

  function loadPrefs() {
    const data = readJson(K.prefs(), {})
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }

  // ---------- 旧 v1/v2 信封：迁移期临时读取 ----------
  /**
   * 扫描旧信封。返回 [{ key, campaignId, envelope }]；
   * v1 无命名空间归属 daily，v2 从 key 后缀取 campaignId。
   * 读取只在迁移向导中发生，不进入任何业务状态。
   */
  function scanLegacy() {
    const found = []
    const visit = (key) => {
      if (typeof key !== 'string') return
      let raw = null
      try {
        raw = backend.getItem(key)
      } catch {
        raw = null
      }
      if (raw == null) return
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        return
      }
      if (!parsed || typeof parsed !== 'object') return
      if (key === LEGACY_V1_KEY) {
        found.push({ key, campaignId: 'daily', envelope: parsed })
      } else if (key.startsWith(LEGACY_V2_PREFIX)) {
        found.push({
          key,
          campaignId: key.slice(LEGACY_V2_PREFIX.length),
          envelope: parsed,
        })
      }
    }

    visit(LEGACY_V1_KEY)
    if (typeof backend.length === 'number' && typeof backend.key === 'function') {
      for (let i = 0; i < backend.length; i += 1) {
        const key = backend.key(i)
        if (key && key.startsWith(LEGACY_V2_PREFIX)) visit(key)
      }
    }
    return found
  }

  function removeLegacyKey(key) {
    if (key === LEGACY_V1_KEY || key.startsWith(LEGACY_V2_PREFIX)) remove(key)
  }

  /** 全量扫描当前存储值（验收：任何值都不含未揭晓 seed/奖品名） */
  function snapshotAllValues() {
    const values = []
    if (typeof backend.length === 'number' && typeof backend.key === 'function') {
      for (let i = 0; i < backend.length; i += 1) {
        const key = backend.key(i)
        if (key == null) continue
        try {
          const value = backend.getItem(key)
          if (value != null) values.push(String(value))
        } catch {
          // 跳过不可读项
        }
      }
    }
    return values
  }

  return {
    get isPersistent() {
      return Boolean(persistent)
    },
    saveCardView,
    loadViews,
    removeCardView,
    saveCommitment,
    loadCommitments,
    removeCommitment,
    saveSessionMeta,
    loadSessionMeta,
    saveVerificationKey,
    loadVerificationKey,
    getIdempotencyKey,
    savePrefs,
    loadPrefs,
    scanLegacy,
    removeLegacyKey,
    snapshotAllValues,
  }
}
