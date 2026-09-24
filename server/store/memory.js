/**
 * 内存存储实现（单实例模拟）。
 *
 * - 接口可注入：engine 只依赖本文件定义的同步方法集合，生产可替换为带事务的 DB；
 * - 并发：按 sid 分片的异步互斥队列，把每个会话的"读—改—写"串行化；
 * - 幂等键按 (sid, route, key) 去重；
 * - events 是只追加的事件日志（begin 事件不含 seed/prize，保证承诺事件可审计）。
 */
import { randomBytes } from 'node:crypto'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

function cardKey(sid, campaignId, day, cardId) {
  return `${sid}#${campaignId}#${day}#${cardId}`
}

function dayKeyOf(sid, campaignId, day) {
  return `${sid}#${campaignId}#${day}`
}

function idemKey(sid, scope, key) {
  return `${sid}#${scope}#${key}`
}

export function newSessionId(randomFn = randomBytes) {
  return randomFn(16).toString('hex')
}

export class MemoryStore {
  constructor() {
    this.sessions = new Map()
    this.days = new Map()
    this.cards = new Map()
    this.idempotency = new Map()
    this.claimsLedger = new Set()
    this.events = []
    this.meta = new Map()
    this.locks = new Map()
  }

  /** 按 sid 串行执行临界区（Promise 链实现的分片互斥队列） */
  async withSidLock(sid, fn) {
    const prev = this.locks.get(sid) ?? Promise.resolve()
    let release
    const next = new Promise((resolve) => {
      release = resolve
    })
    this.locks.set(sid, prev.then(() => next))
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(sid) === next) this.locks.delete(sid)
    }
  }

  // ---------- sessions ----------
  createSession(nowMs) {
    const sid = newSessionId()
    const session = { sid, createdAt: nowMs, lastSeenAt: nowMs, maxObservedDayKey: null, maxObservedMs: nowMs, clockAnomaly: false }
    this.sessions.set(sid, session)
    return session
  }

  getSession(sid) {
    return this.sessions.get(sid) ?? null
  }

  touchSession(session, nowMs) {
    session.lastSeenAt = nowMs
  }

  noteClock(session, { currentDayKey, nowMs }) {
    if (!session.maxObservedDayKey || currentDayKey > session.maxObservedDayKey) {
      session.maxObservedDayKey = currentDayKey
    }
    // 时间戳回拨即记异常（即便仍处于同一上海自然日）
    if (nowMs < session.maxObservedMs) session.clockAnomaly = true
    if (nowMs > session.maxObservedMs) session.maxObservedMs = nowMs
    session.lastSeenAt = nowMs
  }

  // ---------- day ledgers ----------
  getDay(sid, campaignId, day) {
    return this.days.get(dayKeyOf(sid, campaignId, day)) ?? null
  }

  ensureDay(sid, campaignId, day, nowMs) {
    const key = dayKeyOf(sid, campaignId, day)
    let record = this.days.get(key)
    if (!record) {
      record = { chancesUsed: 0, createdAt: nowMs, updatedAt: nowMs }
      this.days.set(key, record)
    }
    return record
  }

  // ---------- cards ----------
  putCard(record, nowMs) {
    const key = cardKey(record.sid, record.campaignId, record.day, record.cardId)
    record.updatedAt = nowMs
    this.cards.set(key, record)
  }

  getCard(sid, campaignId, day, cardId) {
    return this.cards.get(cardKey(sid, campaignId, day, cardId)) ?? null
  }

  /** 取该会话/活动下每个 cardId 的最新（按 beginAt）记录 */
  latestCards(sid, campaignId) {
    const latest = new Map()
    const prefix = `${sid}#${campaignId}#`
    for (const [key, record] of this.cards) {
      if (!key.startsWith(prefix)) continue
      const current = latest.get(record.cardId)
      if (!current || record.beginAt > current.beginAt) latest.set(record.cardId, record)
    }
    return latest
  }

  /** 按永久去重键找卡记录（迁移防重领用） */
  findCardByDedupKey(dedupKey) {
    for (const record of this.cards.values()) {
      if (record.dedupKey === dedupKey) return record
    }
    return null
  }

  // ---------- idempotency ----------
  getIdempotency(sid, scope, key) {
    const entry = this.idempotency.get(idemKey(sid, scope, key))
    if (!entry) return null
    if (Date.now() - entry.at > IDEMPOTENCY_TTL_MS) {
      this.idempotency.delete(idemKey(sid, scope, key))
      return null
    }
    return entry
  }

  putIdempotency(sid, scope, key, { requestFingerprint, status, body, at }) {
    this.idempotency.set(idemKey(sid, scope, key), { requestFingerprint, status, body, at })
  }

  // ---------- claims ledger / migration dedup ----------
  hasClaim(dedupKey) {
    return this.claimsLedger.has(dedupKey)
  }

  addClaim(dedupKey) {
    this.claimsLedger.add(dedupKey)
  }

  get claimsCount() {
    return this.claimsLedger.size
  }

  getMeta(key, fallback = null) {
    return this.meta.has(key) ? this.meta.get(key) : fallback
  }

  setMeta(key, value) {
    this.meta.set(key, value)
  }

  incrementMeta(key) {
    const next = (this.getMeta(key, 0) ?? 0) + 1
    this.meta.set(key, next)
    return next
  }

  // ---------- append-only event log ----------
  appendEvent(type, payload, nowMs) {
    const event = { seq: this.events.length + 1, type, at: nowMs, ...payload }
    this.events.push(event)
    return event
  }
}
