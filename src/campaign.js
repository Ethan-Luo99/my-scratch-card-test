/**
 * 活动实例（服务端公开视图的前端镜像）。
 *
 * 本模块不持有任何开奖真相：
 * - 卡状态只有服务端公开视图 idle/pending/revealed/claimed（+ 纯展示态 expired）；
 * - 所有写动作（begin/reveal/claim）只发 HTTP，结果以服务端响应为准，
 *   网络失败只可同幂等键重试，绝不本地推进、绝不本地补结果；
 * - 真相单一来源：init/回前台/跨标签页 dirty/定时轮询都走 GET /api/state；
 * - localStorage 只缓存承诺与"已揭晓"公开视图（离线只读），未揭晓内容不落盘；
 * - 剩余次数只来自服务端 chancesLeft，前端不记账、不按本地时钟跨天。
 *
 * 一个活动一个实例，实例间仅共享缓存后端与 dirty 通道骨架（按活动命名空间），
 * 两个活动的卡片与次数完全隔离。
 */
import { CARD_STATUS, sanitizeCardView, idleCardView } from './lib/view.js'
import { newIdempotencyKey } from './api/client.js'

const POLL_MS = 20000

export { CARD_STATUS }

export function createCampaign(config) {
  const {
    id,
    cardIds,
    api,
    cache,
    dirtyChannel = null,
    pollIntervalMs = POLL_MS,
  } = config

  const listeners = new Set()

  // 服务端镜像（真相）
  let meta = {
    title: config.title ?? '',
    dailyChances: config.dailyChances ?? 0,
    chancesLeft: config.dailyChances ?? 0,
  }
  /** @type {Map<string, object>} cardId -> 公开视图（仅来自服务端，经白名单清洗） */
  const cards = new Map(cardIds.map((cardId) => [cardId, idleCardView(cardId, id)]))
  let serverTime = null
  let day = null
  let clockAnomaly = false

  // 连接状态：offline 时全站只读/锁定
  let offline = false
  let bootstrapped = false

  // 幂等键按"动作+卡+日+当前 rev"稳定复用：
  // - 同一逻辑动作的网络重试（含超时/5xx）始终复用同一键，服务端原样去重；
  // - 跨天（day 变化）或状态推进（rev 变化，如次日新卡）是新动作，换新键，
  //   避免命中服务端 24h 内上一次动作的缓存响应。
  const idemKeys = new Map()
  function keyFor(action, cardId) {
    const card = cards.get(cardId)
    const mapKey = `${action}:${cardId}:${day ?? 'noday'}:${card ? card.rev : 0}`
    let key = idemKeys.get(mapKey)
    if (!key) {
      key = newIdempotencyKey()
      idemKeys.set(mapKey, key)
    }
    return key
  }

  function emit(source) {
    for (const fn of listeners) {
      try {
        fn(snapshot(), { source })
      } catch {
        // 单个订阅者出错不影响引擎
      }
    }
  }

  function snapshot() {
    return {
      id,
      title: meta.title,
      dailyChances: meta.dailyChances,
      chancesLeft: meta.chancesLeft,
      serverTime,
      day,
      clockAnomaly,
      offline,
      bootstrapped,
      cardsById: Object.fromEntries(cards.entries()),
    }
  }

  /** 合并一份全量/单活动视图（已经过白名单清洗）到镜像 */
  function ingestStateView(view, { markOnline = true } = {}) {
    if (!view || !Array.isArray(view.campaigns)) return
    const campaignView = view.campaigns.find((item) => item.campaignId === id)
    if (!campaignView) return
    if (typeof view.serverTime === 'string') serverTime = view.serverTime
    if (typeof view.day === 'string') day = view.day
    if (typeof view.clockAnomaly === 'boolean') clockAnomaly = view.clockAnomaly
    if (typeof campaignView.title === 'string') meta.title = campaignView.title
    if (Number.isFinite(Number(campaignView.dailyChances))) {
      meta.dailyChances = Math.max(0, Math.floor(Number(campaignView.dailyChances)))
    }
    if (Number.isFinite(Number(campaignView.chancesLeft))) {
      meta.chancesLeft = Math.max(0, Math.floor(Number(campaignView.chancesLeft)))
    }
    const revealedToCache = []
    const commitmentsToCache = []
    for (const rawCard of campaignView.cards) {
      const card = sanitizeCardView(rawCard)
      if (!card || !cardIds.includes(card.cardId)) continue
      cards.set(card.cardId, card)
      if (card.status === CARD_STATUS.REVEALED || card.status === CARD_STATUS.CLAIMED) {
        revealedToCache.push({ ...card, day: day ?? undefined })
      } else if (card.status === CARD_STATUS.PENDING && card.commitment) {
        commitmentsToCache.push({
          cardId: card.cardId,
          commitment: card.commitment,
          day: day ?? null,
          rev: card.rev,
        })
      }
    }
    // 在线对齐：按服务端视图整体对账本活动缓存，清除跨天后已失效的旧卡缓存；
    // 离线（markOnline=false）不做对账，保留可离线查看的已揭晓内容
    if (cache && markOnline) {
      cache.replaceRevealedForCampaign(id, revealedToCache)
      cache.replaceCommitmentsForCampaign(id, commitmentsToCache)
    }
    if (markOnline) offline = false
    bootstrapped = true
  }

  /** 白名单缓存：承诺可存；只有 revealed/claimed 才落盘 */
  function persistCardCache(card) {
    if (!cache) return
    if (card.status === CARD_STATUS.PENDING && card.commitment) {
      cache.saveCommitment(id, {
        cardId: card.cardId,
        commitment: card.commitment,
        day: day ?? null,
        rev: card.rev,
      })
    }
    if (card.status === CARD_STATUS.REVEALED || card.status === CARD_STATUS.CLAIMED) {
      cache.saveRevealedCard(id, { ...card, day: day ?? undefined })
    }
  }

  async function refresh() {
    const view = await api.state(id)
    ingestStateView(view)
    return view
  }

  // ---------- 初始化 ----------
  async function init(initialView = null, { forceOffline = false } = {}) {
    if (initialView && forceOffline) {
      // 离线首帧：缓存注水（仅已揭晓内容）后锁定，绝不本地开奖
      hydrateFromCache()
      ingestStateView(initialView, { markOnline: false })
      offline = true
    } else if (initialView) {
      ingestStateView(initialView)
    } else {
      try {
        await refresh()
      } catch {
        // 首屏即离线：用白名单缓存（仅已揭晓内容）注水为只读视图，绝不本地开奖
        hydrateFromCache()
        markOffline()
      }
    }
    if (dirtyChannel) {
      dirtyChannel.onChange(() => {
        void syncSilently()
      })
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onBackOnline)
    }
    startPolling()
    emit('init')
    return this
  }

  function onVisibility() {
    if (typeof document !== 'undefined' && document.hidden) return
    void syncSilently()
  }

  function onBackOnline() {
    void refresh().then(() => emit('online')).catch(markOffline)
  }

  let pollTimer = null
  function startPolling() {
    if (pollTimer || typeof setInterval !== 'function' || pollIntervalMs <= 0) return
    pollTimer = setInterval(() => {
      void syncSilently()
    }, pollIntervalMs)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  /** 静默对齐：成功时自愈上线，失败时保持/进入离线，不弹错 */
  async function syncSilently() {
    try {
      await refresh()
      if (offline) {
        offline = false
        emit('online')
      }
    } catch {
      markOffline()
    }
  }

  /** 离线只读：只载入已揭晓/已领取缓存；未揭晓槽位保持 idle/pending 无结果 */
  function hydrateFromCache() {
    if (!cache) return
    const revealed = cache.loadRevealedCards()
    for (const cardId of cardIds) {
      const cached = revealed[cardId]
      if (cached) {
        const card = sanitizeCardView(cached)
        if (card && (card.status === CARD_STATUS.REVEALED || card.status === CARD_STATUS.CLAIMED)) {
          cards.set(cardId, card)
        }
      }
    }
  }

  function markOffline() {
    if (!offline) {
      offline = true
      emit('offline')
    }
  }

  /** 恢复网络后由外部（迁移向导/重试）调用 */
  async function reconnect() {
    await refresh()
    if (offline) {
      offline = false
      emit('online')
    }
  }

  /**
   * 处理写响应：ok 或业务冲突都合并附带的最新卡视图，并按需重新对齐。
   * 网络错误抛出，由调用方提示且不改变任何本地状态。
   */
  async function syncAfterAction(promise) {
    let body
    try {
      body = await promise
    } catch (error) {
      markOffline()
      throw error
    }
    if (offline) {
      offline = false
    }
    if (body && typeof body === 'object') {
      if (Number.isFinite(Number(body.chancesLeft))) {
        meta.chancesLeft = Math.max(0, Math.floor(Number(body.chancesLeft)))
      }
      if (typeof body.day === 'string') day = body.day
      if (typeof body.serverTime === 'string') serverTime = body.serverTime
      if (body.card) {
        const card = sanitizeCardView(body.card)
        if (card) {
          cards.set(card.cardId, card)
          persistCardCache(card)
        }
      }
      // already-pending / already-claimed / conflict：以服务端最新视图为准
      if (body.ok === false && ['already-pending', 'already-claimed', 'conflict', 'invalid-state'].includes(body.reason)) {
        try {
          await refresh()
        } catch {
          // 对齐失败也返回原响应，不本地裁决
        }
      }
    }
    emit('local')
    postDirty()
    return body
  }

  function postDirty(cardId = null, rev = 0) {
    if (!dirtyChannel) return
    try {
      dirtyChannel.post({ campaignId: id, cardId, rev })
    } catch {
      // 提示通道失败不影响正确性
    }
  }

  // ---------- 写动作（只发请求，不本地开奖；重试复用幂等键） ----------
  function beginScratch(cardId) {
    return syncAfterAction(api.begin(id, cardId, keyFor('begin', cardId)))
  }

  function revealCard(cardId) {
    const card = cards.get(cardId)
    const expectedRev = card ? card.rev : null
    return syncAfterAction(api.reveal(id, cardId, keyFor('reveal', cardId), expectedRev))
  }

  function claimCard(cardId) {
    return syncAfterAction(api.claim(id, cardId, keyFor('claim', cardId)))
  }

  /**
   * 渲染用卡视图：
   * - 在线：直接返回服务端镜像（pending 无奖品，安全）；
   * - 离线：pending/idle 不显示任何结果；已揭晓卡用白名单缓存只读展示。
   */
  function getCard(cardId) {
    const serverCard = cards.get(cardId) ?? idleCardView(cardId, id)
    if (offline && (serverCard.status === CARD_STATUS.IDLE || serverCard.status === CARD_STATUS.PENDING)) {
      // 离线不臆造结果：idle 就是 idle；pending 保持 pending（涂层仍在）
      return serverCard
    }
    return serverCard
  }

  function getCommitment(cardId) {
    if (!cache) return null
    return cache.loadCommitments()[cardId] ?? null
  }

  function destroy() {
    listeners.clear()
    if (pollTimer) clearInterval(pollTimer)
    if (dirtyChannel) dirtyChannel.destroy()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onBackOnline)
    }
  }

  return {
    id,
    cardIds,
    init,
    refresh,
    reconnect,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    get snapshot() {
      return snapshot()
    },
    getCard,
    getCommitment,
    getChancesLeft: () => meta.chancesLeft,
    getDailyChances: () => meta.dailyChances,
    beginScratch,
    reveal: revealCard,
    claim: claimCard,
    destroy,
  }
}
