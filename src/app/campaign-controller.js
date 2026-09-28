/**
 * 单个活动的前端编排器（服务端权威）。
 *
 * 与旧 createCampaign 的根本区别：本模块不持有任何开奖真相。
 * - 内存状态只是服务端"公开视图"的镜像（idle/pending/revealed/claimed/expired），
 *   外加纯 UI 态（busy/offline/coverage 等，不持久秘密）；
 * - begin/reveal/claim 全部走 API 客户端；网络失败用同一幂等键重试，
 *   任何错误路径都不会本地推进状态、不会本地摇奖；
 * - 离线时只读/锁定：可看缓存中已揭晓内容，写动作一律拒绝；
 * - 跨标签页只收 dirty 提示，收到后 GET /api/state 对齐，不做本地 CAS 裁决。
 */
import { CARD_STATUS } from '../api/view.js'

const PLACEHOLDER_IDLE = Object.freeze({
  status: CARD_STATUS.IDLE,
  rev: 0,
})

export function createCampaignController({
  campaignId,
  cardIds,
  api,
  cache,
  dirtyChannel = null,
  online: initialOnline = true,
}) {
  const listeners = new Set()

  const cards = new Map()
  for (const cardId of cardIds) cards.set(cardId, { ...PLACEHOLDER_IDLE, cardId, campaignId })

  let chancesLeft = null
  let dailyChances = null
  let title = null
  let subtitle = null
  let serverTime = null
  let day = null
  let clockAnomaly = false
  let online = initialOnline
  const busy = new Map() // cardId -> 'begin'|'reveal'|'claim'

  function setBusy(cardId, value) {
    if (value) busy.set(cardId, value)
    else busy.delete(cardId)
  }

  function emit(source) {
    for (const fn of listeners) {
      try {
        fn(getSnapshot(), { source })
      } catch {
        // 订阅者异常不影响控制器
      }
    }
  }

  function mergeServerCard(view) {
    if (!view || cardIds.includes(view.cardId) === false) return
    cards.set(view.cardId, view)
    // 只缓存白名单允许的内容（revealed/claimed 公开视图）；
    // saveCardView 内部对 idle/pending 直接拒绝落盘
    try {
      cache.saveCardView(view)
    } catch {
      // 缓存写入失败（配额等）不影响在线流程
    }
  }

  function applySnapshot(snapshot, { source = 'server' } = {}) {
    if (!snapshot) return
    if (typeof snapshot.chancesLeft === 'number') chancesLeft = snapshot.chancesLeft
    if (typeof snapshot.dailyChances === 'number') dailyChances = snapshot.dailyChances
    if (typeof snapshot.title === 'string') title = snapshot.title
    if (typeof snapshot.subtitle === 'string') subtitle = snapshot.subtitle
    if (typeof snapshot.serverTime === 'string') serverTime = snapshot.serverTime
    if (typeof snapshot.day === 'string') day = snapshot.day
    for (const view of snapshot.cards) mergeServerCard(view)
    emit(source)
  }

  function applyFullView(fullView, { source = 'server' } = {}) {
    if (!fullView) return
    if (typeof fullView.serverTime === 'string') serverTime = fullView.serverTime
    if (typeof fullView.day === 'string') day = fullView.day
    if (typeof fullView.clockAnomaly === 'boolean') clockAnomaly = fullView.clockAnomaly
    const snapshot = fullView.campaigns.find((item) => item.campaignId === campaignId)
    if (snapshot) applySnapshot(snapshot, { source })
  }

  /**
   * 启动：优先用服务端全量视图；服务端不可达时用本地已揭晓缓存只读呈现。
   * @returns {Promise<{online:boolean}>}
   */
  async function boot() {
    try {
      const view = await api.recover()
      applyFullView(view)
      setOnline(true)
      return { online: true }
    } catch (error) {
      loadOfflineCache()
      setOnline(false)
      return { online: false, error }
    }
  }

  /** 离线只读：只把缓存中 revealed/claimed 卡放进镜像，其余保持占位 */
  function loadOfflineCache() {
    let cached = {}
    try {
      cached = cache.loadViews(campaignId)
    } catch {
      cached = {}
    }
    for (const [cardId, view] of Object.entries(cached)) {
      if (cardIds.includes(cardId)) cards.set(cardId, view)
    }
    emit('offline-cache')
  }

  /** 拉服务端公开视图对齐（dirty 提示 / 回前台 / 轮询 / 业务冲突后） */
  async function refresh() {
    try {
      const view = await api.getState(campaignId)
      const snapshot = view.campaigns.find((item) => item.campaignId === campaignId)
      if (snapshot) applySnapshot(snapshot, { source: 'refresh' })
      setOnline(true)
      return true
    } catch {
      setOnline(false)
      loadOfflineCache()
      return false
    }
  }

  function setOnline(value) {
    const next = Boolean(value)
    if (next === online) return
    online = next
    emit(next ? 'online' : 'offline')
  }

  function persistCommitment(cardId, card, outcome) {
    try {
      cache.saveCommitment(campaignId, cardId, {
        commitment: card.commitment ?? null,
        commitSig: outcome.commitSig ?? null,
        weightsVersion: null,
        day: outcome.day ?? null,
        rev: card.rev,
      })
    } catch {
      // 承诺存档失败不阻断主流程（在线仍可完成，验签面板在刷新后由 /state 承诺重建入口）
    }
  }

  /**
   * 开始刮卡。幂等键从缓存取（刷新/重试稳定复用）。
   * 成功（含 already-pending 复用）返回 { ok:true, card }；
   * 业务拒绝返回 { ok:false, reason }；网络错误抛出由 UI 提示。
   */
  async function begin(cardId) {
    if (!online) return { ok: false, reason: 'offline' }
    if (busy.has(cardId)) return { ok: false, reason: 'busy' }
    const key = cache.getIdempotencyKey('begin', campaignId, cardId, day ?? 'boot')
    setBusy(cardId, 'begin')
    emit('busy')
    try {
      const outcome = await api.begin(campaignId, cardId, key)
      if (outcome.ok) {
        mergeServerCard(outcome.card)
        persistCommitment(cardId, outcome.card, outcome)
        if (typeof outcome.chancesLeft === 'number') chancesLeft = outcome.chancesLeft
        if (outcome.day) day = outcome.day
        dirtyChannel?.postDirty({ type: 'dirty', campaignId, cardId, rev: outcome.card.rev })
        emit('local')
        return { ok: true, card: outcome.card }
      }
      // already-pending / no-chances / invalid-state：以服务端返回的视图对齐，
      // 前端不做任何本地裁决
      if (outcome.card) {
        mergeServerCard(outcome.card)
        persistCommitment(cardId, outcome.card, outcome)
      }
      if (typeof outcome.chancesLeft === 'number') chancesLeft = outcome.chancesLeft
      emit('server-decision')
      return { ok: false, reason: outcome.reason, card: outcome.card ?? null }
    } finally {
      setBusy(cardId, null)
      emit('busy')
    }
  }

  /**
   * 揭晓（60% 与直接揭开的唯一 settle 入口）。
   * 重试复用同一幂等键；服务端已处理时幂等返回同一 prize/receipt。
   */
  async function settle(cardId) {
    if (!online) return { ok: false, reason: 'offline' }
    if (busy.has(cardId)) return { ok: false, reason: 'busy' }
    const key = cache.getIdempotencyKey('reveal', campaignId, cardId, day ?? 'boot')
    const current = cards.get(cardId)
    setBusy(cardId, 'reveal')
    emit('busy')
    try {
      const outcome = await api.reveal(campaignId, cardId, key, current?.rev ?? null)
      if (outcome.ok) {
        mergeServerCard(outcome.card)
        if (typeof outcome.chancesLeft === 'number') chancesLeft = outcome.chancesLeft
        // begin 承诺存档保留（设计 4.3 允许落盘）：公平性面板用它与回执中的
        // 承诺逐字节比对，证明"刮开前即已固定"；它推不出 seed/奖品
        dirtyChannel?.postDirty({ type: 'dirty', campaignId, cardId, rev: outcome.card.rev })
        emit('local')
        return { ok: true, card: outcome.card }
      }
      if (outcome.reason === 'conflict') {
        await refresh()
      } else if (outcome.card) {
        mergeServerCard(outcome.card)
        emit('server-decision')
      }
      return { ok: false, reason: outcome.reason, card: outcome.card ?? null }
    } finally {
      setBusy(cardId, null)
      emit('busy')
    }
  }

  async function claim(cardId) {
    if (!online) return { ok: false, reason: 'offline' }
    if (busy.has(cardId)) return { ok: false, reason: 'busy' }
    const key = cache.getIdempotencyKey('claim', campaignId, cardId, day ?? 'boot')
    setBusy(cardId, 'claim')
    emit('busy')
    try {
      const outcome = await api.claim(campaignId, cardId, key)
      if (outcome.ok) {
        mergeServerCard(outcome.card)
        dirtyChannel?.postDirty({ type: 'dirty', campaignId, cardId, rev: outcome.card.rev })
        emit('local')
        return { ok: true, card: outcome.card }
      }
      // already-claimed / invalid-state：拉齐服务端视图（先到先得由服务端裁决）
      await refresh()
      return { ok: false, reason: outcome.reason, card: getCard(cardId) }
    } finally {
      setBusy(cardId, null)
      emit('busy')
    }
  }

  /** 其他标签页发生变更：只收 dirty 提示，回服务端拉公开视图 */
  function handleDirty(message) {
    if (!message || message.type !== 'dirty') return
    if (message.campaignId && message.campaignId !== campaignId) return
    if (online) void refresh()
  }

  if (dirtyChannel) {
    dirtyChannel.onChange(handleDirty)
  }

  function getCard(cardId) {
    const card = cards.get(cardId)
    if (!card) return null
    return busy.has(cardId) ? { ...card, busy: busy.get(cardId) } : card
  }

  function getSnapshot() {
    return {
      campaignId,
      cardIds,
      title,
      subtitle,
      chancesLeft,
      dailyChances,
      serverTime,
      day,
      clockAnomaly,
      online,
      cards: Object.fromEntries(Array.from(cards.entries())),
    }
  }

  return {
    campaignId,
    boot,
    /** 用已拿到的全量视图注水（main 统一建会话后调用） */
    hydrate: (view) => applyFullView(view),
    /** 离线只读注水：仅载入本地已揭晓缓存 */
    hydrateOffline: () => {
      setOnline(false)
      loadOfflineCache()
    },
    markOnline: (value) => setOnline(value),
    refresh,
    begin,
    settle,
    claim,
    handleDirty,
    setOnline,
    onChange: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getCard,
    getSnapshot,
    get online() {
      return online
    },
    get busyCardIds() {
      return new Set(busy.keys())
    },
  }
}
