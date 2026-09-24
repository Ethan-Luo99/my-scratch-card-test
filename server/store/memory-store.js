/**
 * 内存存储（接口可注入替换）：sessions / days / cards / idempotency /
 * claimsLedger / migrationDedup，可选 JSONL 事件日志（dev 重启回放用）。
 * 所有写路径经 withSessionLock 串行化，保证"读—改—写"临界区原子性。
 */
import fs from 'node:fs'
import path from 'node:path'

export function createMemoryStore({ journalFile = null } = {}) {
  const state = {
    sessions: new Map(), // sid -> { sid, createdAt, lastSeenAt }
    days: new Map(), // sid#campaignId#day -> { chancesUsed, createdAt, updatedAt }
    cards: new Map(), // sid#campaignId#cardId -> CardRecord（含秘密，永不出服务端）
    idempotency: new Map(), // scope#key -> { response, at }
    claimsLedger: new Map(), // dedupKey -> { claimRef, at }
    migrationDedup: new Set(), // 迁移去重键
    events: [], // 追加式事件日志（内存镜像）
    clockAnomalies: [], // 时钟回拨记录
  }

  if (journalFile) replayJournal(state, journalFile)

  const tails = new Map() // sid -> Promise，按会话串行

  const store = {
    state,

    /** 按会话分片的 async 互斥：同 sid 的写操作严格串行 */
    withSessionLock(sid, fn) {
      const key = String(sid)
      const prev = tails.get(key) || Promise.resolve()
      const next = Promise.resolve(prev).then(fn)
      tails.set(
        key,
        next.then(
          () => {},
          () => {},
        ),
      )
      return next
    },

    /** 追加事件（内存 + 可选 JSONL 文件，一行一事件）；存快照防后续变异污染历史 */
    appendEvent(event) {
      const snapshot = structuredClone(event)
      state.events.push(snapshot)
      if (journalFile) {
        fs.appendFileSync(journalFile, `${JSON.stringify(snapshot)}\n`, 'utf8')
      }
    },

    getSession(sid) {
      return state.sessions.get(sid) || null
    },
    putSession(session) {
      state.sessions.set(session.sid, session)
    },

    dayKey(sid, campaignId, day) {
      return `${sid}#${campaignId}#${day}`
    },
    getDay(sid, campaignId, day) {
      return state.days.get(store.dayKey(sid, campaignId, day)) || null
    },
    putDay(sid, campaignId, day, record) {
      state.days.set(store.dayKey(sid, campaignId, day), record)
    },

    cardKey(sid, campaignId, cardId) {
      return `${sid}#${campaignId}#${cardId}`
    },
    getCard(sid, campaignId, cardId) {
      return state.cards.get(store.cardKey(sid, campaignId, cardId)) || null
    },
    putCard(record) {
      state.cards.set(store.cardKey(record.sid, record.campaignId, record.cardId), record)
    },
    listCards(sid, campaignId = null) {
      const out = []
      for (const card of state.cards.values()) {
        if (card.sid !== sid) continue
        if (campaignId && card.campaignId !== campaignId) continue
        out.push(card)
      }
      return out
    },

    idemKey(scope, key) {
      return `${scope}#${key}`
    },
    getIdempotent(scope, key, { ttlMs, nowMs }) {
      const entry = state.idempotency.get(store.idemKey(scope, key))
      if (!entry) return null
      if (Number.isFinite(ttlMs) && nowMs - entry.at > ttlMs) {
        state.idempotency.delete(store.idemKey(scope, key))
        return null
      }
      return entry
    },
    putIdempotent(scope, key, response, at) {
      state.idempotency.set(store.idemKey(scope, key), { response, at })
    },

    getClaim(dedupKey) {
      return state.claimsLedger.get(dedupKey) || null
    },
    putClaim(dedupKey, entry) {
      state.claimsLedger.set(dedupKey, entry)
    },
    claimCount() {
      return state.claimsLedger.size
    },

    hasMigrationDedup(key) {
      return state.migrationDedup.has(key)
    },
    putMigrationDedup(key) {
      state.migrationDedup.add(key)
    },

    recordClockAnomaly(entry) {
      state.clockAnomalies.push(entry)
      store.appendEvent({ type: 'clock-anomaly', ...entry })
    },
  }

  return store
}

function replayJournal(state, journalFile) {
  try {
    if (!fs.existsSync(journalFile)) {
      fs.mkdirSync(path.dirname(journalFile), { recursive: true })
      return
    }
    const lines = fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      const event = JSON.parse(line)
      state.events.push(event)
      if (event.type === 'session-created' && event.sid) {
        state.sessions.set(event.sid, {
          sid: event.sid,
          createdAt: event.at,
          lastSeenAt: event.at,
        })
      } else if (event.type === 'card-upsert' && event.card) {
        state.cards.set(
          `${event.card.sid}#${event.card.campaignId}#${event.card.cardId}`,
          event.card,
        )
      } else if (event.type === 'day-upsert' && event.day) {
        state.days.set(
          `${event.sid}#${event.day.campaignId}#${event.day.day}`,
          event.day.record,
        )
      } else if (event.type === 'claim' && event.dedupKey) {
        state.claimsLedger.set(event.dedupKey, event.entry)
      } else if (event.type === 'migrate-dedup' && event.dedupKey) {
        state.migrationDedup.add(event.dedupKey)
      } else if (event.type === 'clock-anomaly') {
        state.clockAnomalies.push(event)
      }
    }
  } catch {
    // 日志损坏时按空账本启动（dev 模拟实现，非信任边界）
  }
}
