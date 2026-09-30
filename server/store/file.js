/**
 * 追加式事件日志持久化存储（FileStore）——零第三方依赖，仅用 node: 内置模块。
 *
 * 与 MemoryStore 接口完全可互换：所有引擎写操作（均在 withSidLock 会话临界区
 * 内同步执行）被收录进"事务缓冲"，临界区结束时一次性按原始顺序批量落盘。
 *
 * 写入顺序（write-ahead + redo 语义）：
 *   1) 业务在内存推进的同时，只把"操作描述"追加进内存事务缓冲（不落业务盘）；
 *   2) 临界区返回前：先 appendFileSync 整批 WAL 行 + fsync（日志先 durable），
 *      再把控制权交还引擎；内存与日志同为最新（同一事件循环、同步 I/O）；
 *   3) 重启只信日志：快照 + 事件日志顺序回放重建内存（redo，天然幂等）。
 *
 * 崩溃窗口取舍：
 *   - "日志已 durable、ack 未到"：重启后 redo——幂等键/承诺都在日志里，
 *     客户端用原 Idempotency-Key 重试得首次响应，绝不重复扣费（承诺不丢）。
 *   - 内存已推进、日志写失败：视为本盘已坏，立即降级为纯内存模式
 *     （isPersistent=false）：同进程内继续正常服务（幂等缓存仍在，不重复
 *     扣费），绝不因磁盘问题拒绝业务；重启后该盘上事务视为未发生。
 *
 * 审计：每行 JSON 为 {rec:{...}, hash}，hash = sha256(prevHash + '\n' +
 *   canonicalJSON(rec))；创世条目 prevHash 固定常量。篡改任一字段即断链。
 *
 * 容错：回放停在最后一条完整且校验通过的记录，截断坏尾、记录
 * truncation-anomaly、后续写入继续追加，绝不整文件拒绝启动。
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { MemoryStore, IDEMPOTENCY_TTL_MS } from './memory.js'

const GENESIS_PREV_HASH = 'GENESIS-scratch-card-hash-chain-v1'
const LOG_FILENAME = 'events.log'
const SNAPSHOT_FILENAME = 'snapshot.json'
const LOCK_FILENAME = 'store.lock'
const TMP_SUFFIX = '.tmp'

export const DEFAULT_DATA_DIR =
  process.env.SCRATCH_DATA_DIR ?? join(tmpdir(), 'scratch-card-server-data')

export const DEFAULT_SNAPSHOT_EVERY = 200

const STABLE_STATE_KEYS = ['sessions', 'days', 'cards', 'idempotency', 'claimsLedger', 'meta', 'events']

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`
}

function recordHash(prevHash, rec) {
  return createHash('sha256').update(`${prevHash}\n${canonicalJSON(rec)}`).digest('hex')
}

/**
 * 快照内容摘要：对除 fileHash 字段以外的确定性 JSON 求 SHA-256。
 * 写入与校验共用同一口径，快照文件自身不含自引用哈希。
 */
function snapshotPayloadHash(payload) {
  return createHash('sha256').update(canonicalJSON(payload)).digest('hex')
}

function encodeLine(prevHash, rec) {
  return JSON.stringify({ rec, hash: recordHash(prevHash, rec) }) + '\n'
}

function dayKey(sid, campaignId, day) {
  return `${sid}#${campaignId}#${day}`
}

function cardKey(sid, campaignId, day, cardId) {
  return `${sid}#${campaignId}#${day}#${cardId}`
}

function idemKey(sid, scope, key) {
  return `${sid}#${scope}#${key}`
}

/** 回放/校验共享：把一条业务 op 作用到目标 store（redo，幂等可重放） */
function applyOp(store, op) {
  switch (op.t) {
    case 'session': {
      const { sid, createdAt, lastSeenAt, maxObservedDayKey, maxObservedMs, clockAnomaly } = op
      store.sessions.set(sid, { sid, createdAt, lastSeenAt, maxObservedDayKey, maxObservedMs, clockAnomaly })
      return
    }
    case 'clock': {
      const session = store.sessions.get(op.sid)
      if (!session) return
      if (!session.maxObservedDayKey || op.currentDayKey > session.maxObservedDayKey) {
        session.maxObservedDayKey = op.currentDayKey
      }
      if (op.nowMs < session.maxObservedMs) session.clockAnomaly = true
      if (op.nowMs > session.maxObservedMs) session.maxObservedMs = op.nowMs
      session.lastSeenAt = op.nowMs
      return
    }
    case 'touch': {
      const session = store.sessions.get(op.sid)
      if (session) session.lastSeenAt = op.nowMs
      return
    }
    case 'day': {
      const key = dayKey(op.sid, op.campaignId, op.day)
      store.days.set(key, { chancesUsed: op.chancesUsed, createdAt: op.createdAt, updatedAt: op.updatedAt })
      return
    }
    case 'card': {
      const key = cardKey(op.r.sid, op.r.campaignId, op.r.day, op.r.cardId)
      store.cards.set(key, op.r)
      return
    }
    case 'idem': {
      store.idempotency.set(idemKey(op.sid, op.scope, op.key), {
        requestFingerprint: op.requestFingerprint,
        status: op.status,
        body: op.body,
        at: op.at,
      })
      return
    }
    case 'idem-del': {
      store.idempotency.delete(idemKey(op.sid, op.scope, op.key))
      return
    }
    case 'claim': {
      store.claimsLedger.add(op.dedupKey)
      return
    }
    case 'meta': {
      store.meta.set(op.key, op.value)
      return
    }
    case 'event': {
      store.events.push(op.e)
      return
    }
    default:
      throw new Error(`unknown op: ${op.t}`)
  }
}

export class FileStore extends MemoryStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir] 数据目录（含 events.log / snapshot.json / lock）
   * @param {number} [opts.snapshotEvery] 累计多少条业务记录触发一次快照压缩
   * @param {Function} [opts.onFault] 降级/异常回调 (kind, detail) => void
   * @param {Function} [opts.faultBeforeCommit] 注入故障：日志写入前抛错（窗口B）
   * @param {Function} [opts.faultAfterDurable] 注入故障：日志 fsync 后/返回前抛错（窗口A）
   * @param {Function} [opts.faultInSnapshot] 注入故障：快照轮换各阶段（'after-snapshot-rename'）
   */
  constructor(opts = {}) {
    super()
    this.dir = opts.dir ?? DEFAULT_DATA_DIR
    this.snapshotEvery = opts.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY
    this.onFault = opts.onFault ?? (() => {})
    this.faultBeforeCommit = opts.faultBeforeCommit ?? null
    this.faultAfterDurable = opts.faultAfterDurable ?? null
    this.faultInSnapshot = opts.faultInSnapshot ?? null

    this.persistent = true
    this.degradedReason = null
    this.anomalies = []
    this.firstBrokenSeq = null
    this.txn = null
    this.businessSeq = 0 // 快照压缩点之后的业务记录计数（达到阈值即再压缩）
    this.logicalSeq = 0 // 跨快照全局连续的业务记录序号（审计 seq）
    this.chainHash = GENESIS_PREV_HASH
    this.fd = null
    this.lockFd = null
    this.logPath = join(this.dir, LOG_FILENAME)
    this.snapshotPath = join(this.dir, SNAPSHOT_FILENAME)
    this.lockPath = join(this.dir, LOCK_FILENAME)

    this._open()
  }

  get isPersistent() {
    return this.persistent
  }

  // ---------- open / lock / replay ----------
  _open() {
    try {
      mkdirSync(this.dir, { recursive: true })
      this._acquireLock()
      this._replay()
      this.fd = openSync(this.logPath, 'a')
    } catch (error) {
      this._failOpen(error)
    }
  }

  _acquireLock() {
    // 尽力而为的单实例锁（O_EXCL）；持有者进程不在即视为陈旧锁可回收。
    const token = `${process.pid}#${Date.now()}`
    try {
      this.lockFd = openSync(this.lockPath, 'wx')
      writeSync(this.lockFd, token)
      fsyncSync(this.lockFd)
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let owner = ''
    try {
      owner = readFileSync(this.lockPath, 'utf8')
    } catch {
      owner = ''
    }
    const ownerPid = Number(owner.split('#')[0])
    let alive = false
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0)
        alive = true
      } catch {
        alive = false
      }
    }
    if (alive) throw new Error(`store locked by live pid ${ownerPid}`)
    try {
      unlinkSync(this.lockPath)
    } catch {
      /* 并发回收时忽略，下一次 O_EXCL 再裁决 */
    }
    this.lockFd = openSync(this.lockPath, 'wx')
    writeSync(this.lockFd, token)
    fsyncSync(this.lockFd)
  }

  _failOpen(error) {
    // 任何磁盘/权限/锁错误：退化为纯内存，绝不拒绝业务
    this.persistent = false
    this.degradedReason = String(error?.code ?? error?.message ?? error)
    try {
      if (this.lockFd != null) closeSync(this.lockFd)
    } catch {
      /* ignore */
    }
    this.lockFd = null
    this.fd = null
    this.onFault('degrade', this.degradedReason)
  }

  _parseLogFile(content) {
    // 逐条解析：不完整半行/校验失败即视为日志尾部损坏，停在最后有效记录
    const parsed = []
    let prevHash = GENESIS_PREV_HASH
    let broken = null
    let validBytes = 0
    let lineStart = 0
    for (let i = 0; i < content.length; i += 1) {
      if (content[i] !== 0x0a) continue
      const text = content.subarray(lineStart, i).toString('utf8')
      let entry = null
      if (text) {
        try {
          entry = JSON.parse(text)
        } catch {
          broken = { reason: 'unparseable-line' }
        }
        if (!broken && (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string' || !entry.rec)) {
          broken = { reason: 'malformed-line' }
        }
        if (!broken && entry.hash !== recordHash(prevHash, entry.rec)) {
          broken = {
            reason: entry.rec && entry.rec.t === 'genesis' ? 'genesis-mismatch' : 'hash-chain-broken',
          }
        }
      }
      if (broken) break
      if (entry) {
        parsed.push(entry)
        prevHash = entry.hash
      }
      // 空行是良性的，其字节仍计入"已验证干净"前缀
      validBytes = i + 1
      lineStart = i + 1
    }
    if (!broken && lineStart < content.length) {
      // 最后一行没有换行符：必然是截断/半行
      broken = { reason: 'truncated-tail' }
    }
    return { parsed, broken, validBytes }
  }

  _replay() {
    let snap = null
    let expectedBase = null // 若快照存在，新日志创世必须锚定快照 hash
    if (existsSync(this.snapshotPath)) {
      try {
        snap = JSON.parse(readFileSync(this.snapshotPath, 'utf8'))
        if (!snap || snap.v !== 1 || !snap.state) throw new Error('bad snapshot body')
        const { fileHash: digest, ...payload } = snap
        if (digest !== snapshotPayloadHash(payload)) throw new Error('snapshot hash mismatch')
      } catch (error) {
        this._anomaly('snapshot-corrupt', String(error.message ?? error))
        snap = null
      }
    }

    const content = existsSync(this.logPath) ? readFileSync(this.logPath) : Buffer.alloc(0)

    if (snap) {
      this._loadState(snap.state)
      this.logicalSeq = Number.isInteger(snap.baseSeq) ? snap.baseSeq : 0
      this.businessSeq = 0
      expectedBase = snap.fileHash
    }

    const { parsed, broken, validBytes } = this._parseLogFile(content)
    let applied = 0
    let sawGenesis = false
    for (const entry of parsed) {
      const rec = entry.rec
      if (rec.t === 'genesis') {
        sawGenesis = true
        if (snap) {
          // 快照已在：日志不应再含旧链创世——
          // 典型于"快照已 rename、日志尚未轮换"的崩溃点。旧日志在快照
          // 覆盖范围内，截断丢弃，以快照为准重建锚定创世。
          this._anomaly('snapshot-rotation-recovered')
          this._truncateLog(0)
          this.chainHash = GENESIS_PREV_HASH
          this._appendGenesisNow({ t: 'snapshot-genesis', baseHash: snap.fileHash, at: 0 })
          this.logicalSeq = Number.isInteger(snap.baseSeq) ? snap.baseSeq : 0
          this.businessSeq = 0
          return
        }
        this.chainHash = entry.hash
        continue
      }
      if (rec.t === 'snapshot-genesis') {
        // 快照后的新创世：重置基线（压缩点之后的链独立开始）
        this.chainHash = entry.hash
        this.businessSeq = 0
        continue
      }
      applyOp(this, rec)
      this.businessSeq += 1
      this.logicalSeq += 1
      this.chainHash = entry.hash
      applied += 1
    }

    const sawSnapshotGenesis = parsed.some((entry) => entry.rec.t === 'snapshot-genesis')
    if (broken) {
      // 断点 seq（全局业务记录序号，从 1 起）：被篡改/损坏的就是下一条待处理记录
      const brokenSeq = this.logicalSeq + 1
      this.firstBrokenSeq = brokenSeq
      this._anomaly('truncation-anomaly', { reason: broken.reason, seq: brokenSeq })
      // 截断坏尾，保证后续 append 从干净换行边界开始
      this._truncateLog(validBytes)
    }

    // 保证链头存在：全新文件 / 被截空的坏日志 / 快照在日志缺失，
    // 都补一条锚定当前基线的创世
    if (!broken && applied === 0 && !sawGenesis && !sawSnapshotGenesis && validBytes === 0) {
      if (snap) {
        this.chainHash = GENESIS_PREV_HASH
        this._appendGenesisNow({ t: 'snapshot-genesis', baseHash: snap.fileHash, at: 0 })
        this.businessSeq = 0
        if (content.length > 0) this._anomaly('log-missing-after-snapshot')
      } else if (content.length === 0) {
        this.chainHash = GENESIS_PREV_HASH
        this._appendGenesisNow({ t: 'genesis', at: 0 })
      }
    }
    if (!broken && applied === 0 && !sawGenesis && content.length > 0 && !snap) {
      // 全是坏行（被 _parseLogFile 计入空行的极端情况）：整段弃用
      this._anomaly('truncation-anomaly', 'all-lines-invalid')
      this._truncateLog(0)
      this.chainHash = GENESIS_PREV_HASH
      this._appendGenesisNow({ t: 'genesis', at: 0 })
    }
  }

  /** 以"临时文件 + fsync + 原子 rename"把日志截到 byteLength 字节 */
  _truncateLog(byteLength) {
    try {
      const content = existsSync(this.logPath) ? readFileSync(this.logPath) : Buffer.alloc(0)
      const clean = content.subarray(0, Math.min(byteLength, content.length))
      const tmp = `${this.logPath}${TMP_SUFFIX}`
      const tfd = openSync(tmp, 'w')
      writeSync(tfd, clean)
      fsyncSync(tfd)
      closeSync(tfd)
      renameSync(tmp, this.logPath)
    } catch (error) {
      this._anomaly('truncate-repair-failed', String(error.message ?? error))
    }
  }

  /** 追加一条创世记录（仅回放/修复路径调用） */
  _appendGenesisNow(rec) {
    const line = encodeLine(this.chainHash, rec)
    const fd = openSync(this.logPath, 'a')
    writeSync(fd, line)
    fsyncSync(fd)
    closeSync(fd)
    this.chainHash = recordHash(this.chainHash, rec)
  }

  _loadState(state) {
    this.sessions = new Map(Object.entries(state.sessions ?? {}))
    this.days = new Map(Object.entries(state.days ?? {}))
    this.cards = new Map(Object.entries(state.cards ?? {}))
    this.idempotency = new Map(
      Object.entries(state.idempotency ?? {}).map(([key, entry]) => [key, { ...entry, body: entry.body }]),
    )
    this.claimsLedger = new Set(state.claimsLedger ?? [])
    this.meta = new Map(Object.entries(state.meta ?? {}))
    this.events = Array.isArray(state.events) ? state.events : []
  }

  _dumpState() {
    return {
      sessions: Object.fromEntries(this.sessions),
      days: Object.fromEntries(this.days),
      cards: Object.fromEntries(this.cards),
      idempotency: Object.fromEntries(this.idempotency),
      claimsLedger: [...this.claimsLedger],
      meta: Object.fromEntries(this.meta),
      events: this.events,
    }
  }

  _anomaly(kind, detail = null) {
    this.anomalies.push({ kind, detail, at: new Date().toISOString() })
    this.onFault('anomaly', { kind, detail })
  }

  // ---------- 事务缓冲：覆盖 MemoryStore 的所有写接口 ----------
  _push(op) {
    if (!this.persistent || this.txn === null) {
      // 降级模式 / 临界区外（createSession 路径）：直接单条提交
      if (this.persistent) this._commit([op])
      return
    }
    this.txn.push(op)
  }

  async withSidLock(sid, fn) {
    const run = () => {
      this.txn = []
      try {
        const result = fn()
        if (result && typeof result.then === 'function') {
          throw new TypeError('FileStore 临界区内业务必须同步完成')
        }
        const ops = this._normalizeOps(this.txn)
        this.txn = null
        this._commit(ops)
        return result
      } catch (error) {
        // 业务异常：丢弃本事务缓冲（内存回滚由引擎不返回结果自然实现，
        // 缓冲里是"操作描述"而非内存副本——缓冲丢弃即可，无脏落盘）
        this.txn = null
        throw error
      }
    }
    return super.withSidLock(sid, run)
  }

  /**
   * 事务归并：引擎对 day/card 的后续字段变更（如 chancesUsed += 1）直接
   * 发生在返回的记录对象上。提交前按 key 去重并从内存取最终值，保证
   * 落盘的是临界区结束时的完整状态（redo 幂等所需）。
   */
  _normalizeOps(ops) {
    const lastIndex = new Map()
    ops.forEach((op, index) => {
      if (op.t === 'day' || op.t === 'card') {
        const key =
          op.t === 'day'
            ? dayKey(op.sid, op.campaignId, op.day)
            : cardKey(op.r.sid, op.r.campaignId, op.r.day, op.r.cardId)
        lastIndex.set(`${op.t}:${key}`, index)
      }
    })
    return ops.map((op, index) => {
      if (op.t === 'day') {
        const key = dayKey(op.sid, op.campaignId, op.day)
        if (lastIndex.get(`day:${key}`) !== index) return null
        const record = this.days.get(key)
        return {
          t: 'day',
          sid: op.sid,
          campaignId: op.campaignId,
          day: op.day,
          chancesUsed: record.chancesUsed,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }
      }
      if (op.t === 'card') {
        const key = cardKey(op.r.sid, op.r.campaignId, op.r.day, op.r.cardId)
        if (lastIndex.get(`card:${key}`) !== index) return null
        return { t: 'card', r: { ...this.cards.get(key) } }
      }
      return op
    }).filter(Boolean)
  }

  // ---------- sessions ----------
  createSession(nowMs) {
    const session = super.createSession(nowMs)
    this._push({
      t: 'session',
      sid: session.sid,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      maxObservedDayKey: session.maxObservedDayKey,
      maxObservedMs: session.maxObservedMs,
      clockAnomaly: session.clockAnomaly,
    })
    return session
  }

  touchSession(session, nowMs) {
    super.touchSession(session, nowMs)
    this._push({ t: 'touch', sid: session.sid, nowMs })
  }

  noteClock(session, { currentDayKey, nowMs }) {
    super.noteClock(session, { currentDayKey, nowMs })
    this._push({ t: 'clock', sid: session.sid, currentDayKey, nowMs })
  }

  // ---------- days ----------
  ensureDay(sid, campaignId, day, nowMs) {
    const record = super.ensureDay(sid, campaignId, day, nowMs)
    this._pushDay(sid, campaignId, day)
    return record
  }

  _pushDay(sid, campaignId, day) {
    const record = this.days.get(dayKey(sid, campaignId, day))
    this._push({
      t: 'day',
      sid,
      campaignId,
      day,
      chancesUsed: record.chancesUsed,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
  }

  // ---------- cards ----------
  putCard(record, nowMs) {
    super.putCard(record, nowMs)
    this._push({ t: 'card', r: { ...record } })
  }

  // ---------- idempotency ----------
  getIdempotency(sid, scope, key) {
    const entry = this.idempotency.get(idemKey(sid, scope, key))
    if (!entry) return null
    if (Date.now() - entry.at > IDEMPOTENCY_TTL_MS) {
      this.idempotency.delete(idemKey(sid, scope, key))
      this._push({ t: 'idem-del', sid, scope, key })
      return null
    }
    return entry
  }

  putIdempotency(sid, scope, key, { requestFingerprint, status, body, at }) {
    super.putIdempotency(sid, scope, key, { requestFingerprint, status, body, at })
    this._push({ t: 'idem', sid, scope, key, requestFingerprint, status, body, at })
  }

  // ---------- claims ledger ----------
  addClaim(dedupKey) {
    if (this.claimsLedger.has(dedupKey)) return
    super.addClaim(dedupKey)
    this._push({ t: 'claim', dedupKey })
  }

  // ---------- meta ----------
  setMeta(key, value) {
    super.setMeta(key, value)
    this._push({ t: 'meta', key, value })
  }

  incrementMeta(key) {
    const next = super.incrementMeta(key)
    this._push({ t: 'meta', key, value: next })
    return next
  }

  // ---------- event log ----------
  appendEvent(type, payload, nowMs) {
    const event = super.appendEvent(type, payload, nowMs)
    this._push({ t: 'event', e: event })
    return event
  }

  // ---------- commit (WAL append) ----------
  _commit(ops) {
    if (!this.persistent) return
    if (this.faultBeforeCommit) {
      const injected = this.faultBeforeCommit(ops)
      if (injected) this._degrade(injected instanceof Error ? injected : new Error(String(injected)))
    }
    if (!this.persistent) return

    const lines = []
    let prev = this.chainHash
    for (const op of ops) {
      const rec = op
      const hash = recordHash(prev, rec)
      lines.push(JSON.stringify({ rec, hash }) + '\n')
      prev = hash
    }
    const buffer = Buffer.from(lines.join(''), 'utf8')
    try {
      if (this.fd === null) this.fd = openSync(this.logPath, 'a')
      writeSync(this.fd, buffer)
      fsyncSync(this.fd)
    } catch (error) {
      // 窗口 B：内存已推进、日志没 durable —— 本盘不再可信，降级继续服务
      this._degrade(error)
      return
    }
    // 到此处：日志已 durable，内存早已推进（redo 语义成立）
    this.chainHash = prev
    this.businessSeq += ops.length
    this.logicalSeq += ops.length

    if (this.faultAfterDurable) {
      const injected = this.faultAfterDurable(ops)
      if (injected) {
        // 窗口 A 注入：日志已落盘但对调用方模拟"ack 丢失"（重启即 redo）
        throw injected instanceof Error ? injected : new Error(String(injected))
      }
    }

    if (this.businessSeq >= this.snapshotEvery) {
      try {
        this._rotateSnapshot()
      } catch (error) {
        this._anomaly('snapshot-failed', String(error.message ?? error))
      }
    }
  }

  _degrade(error) {
    if (!this.persistent) return
    this.persistent = false
    this.degradedReason = String(error?.code ?? error?.message ?? error)
    try {
      if (this.fd != null) closeSync(this.fd)
    } catch {
      /* ignore */
    }
    this.fd = null
    this._anomaly('persistence-degraded', this.degradedReason)
  }

  // ---------- snapshot：临时文件 + fsync + 原子 rename，然后压缩日志 ----------
  _rotateSnapshot() {
    // 1) 快照内容 = 当前全部内存状态
    const state = this._dumpState()
    const at = Date.now()
    const baseSeq = this.logicalSeq
    const fileHashDigest = snapshotPayloadHash({ v: 1, at, baseSeq, state })
    const finalBody = JSON.stringify({ v: 1, at, baseSeq, state, fileHash: fileHashDigest })

    // 2) 临时文件 + fsync + 原子 rename
    const tmpSnapshot = `${this.snapshotPath}${TMP_SUFFIX}`
    let sfd = openSync(tmpSnapshot, 'w')
    writeSync(sfd, finalBody)
    fsyncSync(sfd)
    closeSync(sfd)
    renameSync(tmpSnapshot, this.snapshotPath)
    if (this.faultInSnapshot) {
      const injected = this.faultInSnapshot('after-snapshot-rename')
      if (injected) throw injected instanceof Error ? injected : new Error(String(injected))
    }

    // 3) 用一条 snapshot-genesis 重开日志（锚定快照文件 hash）
    const rec = { t: 'snapshot-genesis', baseHash: fileHashDigest, at: Date.now() }
    const newLine = encodeLine(GENESIS_PREV_HASH, rec)
    const tmpLog = `${this.logPath}${TMP_SUFFIX}`
    let lfd = openSync(tmpLog, 'w')
    writeSync(lfd, newLine)
    fsyncSync(lfd)
    closeSync(lfd)

    // 4) 原子替换日志；任何此刻在临界区外的写入都在单线程同步点之外，不丢事件
    if (this.fd != null) {
      try {
        closeSync(this.fd)
      } catch {
        /* ignore */
      }
      this.fd = null
    }
    renameSync(tmpLog, this.logPath)
    this.fd = openSync(this.logPath, 'a')
    fsyncSync(this.fd)
    this.chainHash = recordHash(GENESIS_PREV_HASH, rec)
    this.businessSeq = 0
  }

  // ---------- audit ----------
  /**
   * 全量审计：重放快照+日志，校验哈希链，并把重放出的状态与当前内存逐项比对。
   * @returns {{ok:boolean, entries:number, firstBrokenSeq?:number, anomalies:object[]}}
   */
  verify() {
    const anomalies = this.anomalies.map((item) => ({ ...item }))
    let entries = 0
    let firstBrokenSeq = this.firstBrokenSeq

    const probe = new MemoryStore()
    let expectedBase = null

    if (existsSync(this.snapshotPath)) {
      try {
        const bytes = readFileSync(this.snapshotPath)
        const snap = JSON.parse(bytes.toString('utf8'))
        if (!snap || snap.v !== 1 || !snap.state) throw new Error('bad snapshot body')
        const { fileHash: _omitted, ...payload } = snap
        if (snap.fileHash !== snapshotPayloadHash(payload)) throw new Error('snapshot hash mismatch')
        this._applySnapshotTo(probe, snap.state)
        expectedBase = snap.fileHash
        entries += Number.isInteger(snap.baseSeq) ? snap.baseSeq : 0
      } catch (error) {
        anomalies.push({ kind: 'snapshot-corrupt', detail: String(error.message ?? error) })
        firstBrokenSeq = firstBrokenSeq ?? 0
      }
    }

    const content = existsSync(this.logPath) ? readFileSync(this.logPath) : Buffer.alloc(0)
    const { parsed, broken } = this._parseLogFile(content)
    let prev = GENESIS_PREV_HASH
    let seqInLog = 0
    let staleLog = false
    for (const entry of parsed) {
      if (entry.rec.t === 'genesis' && expectedBase !== null) {
        // 快照已在但日志仍是旧链（轮换窗口崩溃后尚未被任何进程修复）：
        // 不把旧链当业务事件重放，报告一次可恢复异常
        staleLog = true
        anomalies.push({ kind: 'snapshot-rotation-recovered' })
        break
      }
      if (entry.hash !== recordHash(prev, entry.rec)) {
        anomalies.push({ kind: 'hash-chain-broken', seq: entries + seqInLog + 1 })
        firstBrokenSeq = firstBrokenSeq ?? entries + seqInLog + 1
        break
      }
      prev = entry.hash
      if (entry.rec.t === 'genesis' || entry.rec.t === 'snapshot-genesis') continue
      applyOp(probe, entry.rec)
      seqInLog += 1
    }
    entries += seqInLog

    if (broken && !staleLog) {
      anomalies.push({ kind: 'truncation-anomaly', detail: broken.reason, seq: entries + 1 })
    }

    // 事件日志与内存状态一致性（仅当链完整可重放时比对）
    if (!firstBrokenSeq && !staleLog) {
      const divergence = this._diffState(probe)
      if (divergence.length > 0) {
        anomalies.push({ kind: 'state-divergence', detail: divergence })
      }
    }

    const ok = anomalies.length === 0 && !firstBrokenSeq
    return {
      ok,
      entries,
      persistent: this.persistent,
      ...(firstBrokenSeq != null ? { firstBrokenSeq } : {}),
      anomalies,
    }
  }

  _applySnapshotTo(probe, state) {
    probe.sessions = new Map(Object.entries(state.sessions ?? {}))
    probe.days = new Map(Object.entries(state.days ?? {}))
    probe.cards = new Map(Object.entries(state.cards ?? {}))
    probe.idempotency = new Map(Object.entries(state.idempotency ?? {}))
    probe.claimsLedger = new Set(state.claimsLedger ?? [])
    probe.meta = new Map(Object.entries(state.meta ?? {}))
    probe.events = Array.isArray(state.events) ? state.events : []
  }

  _diffState(replayed) {
    const diffs = []
    for (const key of STABLE_STATE_KEYS) {
      const a = this._statePart(key)
      const b = key === 'claimsLedger' ? [...replayed.claimsLedger] : this._mapPart(replayed, key)
      const aj = canonicalJSON(a)
      const bj = canonicalJSON(b)
      if (aj !== bj) diffs.push(key)
    }
    return diffs
  }

  _statePart(key) {
    if (key === 'claimsLedger') return [...this.claimsLedger]
    if (key === 'events') return this.events
    return this._mapPart(this, key)
  }

  _mapPart(store, key) {
    if (key === 'events') return store.events
    const value = store[key]
    if (value instanceof Map) return Object.fromEntries(value)
    return value
  }

  close() {
    try {
      if (this.fd != null) {
        fsyncSync(this.fd)
        closeSync(this.fd)
      }
    } catch {
      /* ignore */
    }
    this.fd = null
    try {
      if (this.lockFd != null) closeSync(this.lockFd)
      unlinkSync(this.lockPath)
    } catch {
      /* ignore */
    }
    this.lockFd = null
  }
}
