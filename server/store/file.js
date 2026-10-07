/**
 * FileStore：MemoryStore 的可互换持久化实现（仅用 node: 内置模块）。
 *
 * 多实例（leader/follower）：
 * - 数据目录内 leader.lock 为互斥锁：wx 原子创建，内容 {pid,token,heartbeatAt}，
 *   leader 周期心跳（tmp+rename 原子替换）；创建失败且锁未过期 → 只读 follower。
 * - follower 读走本地回放（refresh 按 mtime/size 变化重放，不阻塞 leader 写），
 *   业务写抛 ReadOnlyError；锁消失/过期时 follower 在 refresh 中懒接管为 leader。
 * - 接管防竞态：过期判定二次确认 + rename 原子抢占（同名目标只有一个胜者），
 *   正常 close 主动删锁 → 新实例立即接管，异常死亡 ≤ staleMs 后可接管。
 *
 * 存储格式 v2：
 * - 每条日志记录携带 v:2（参与哈希），创世 data.format=2；快照 format=v2。
 * - 启动遇 v1 自动在线迁移：tmp 写 v2 快照+新日志（创世锚定旧 tip + MIGRATE
 *   记录把迁移事件进链），按 "bak 备份 → 新文件就位 → 日志 rename 提交点" 顺序
 *   落盘；任意时刻崩溃，重启按文件在场性裁决：未提交完整回滚 v1，已提交收尾。
 *
 * 崩溃一致性模型 —— 分组事务 WAL（write-ahead log 的 redo 语义）：
 * - 引擎一次业务动作（begin/reveal/claim/migrate）在会话锁临界区内同步完成；
 *   该动作产生的全部变更先暂存在 this.staged，临界区末尾由 _flush() 用一次
 *   writeSync 原子落盘：
 *     APPLY,APPLY,...,COMMIT   （同一时刻只有一个事务组在写，无交错）
 * - APPLY 携带变更后的完整实体（session/day/card/idem/claim/meta/event）；
 *   回放时先缓冲，见到同一组 COMMIT 才整体 apply——一组要么全有、要么全无，
 *   因此“日志已写、内存未提交”的窗口由 redo 收尾，且不存在组内半应用。
 * - 磁盘写入失败（配额/权限）时自动退化为纯内存模式（persistent=false），
 *   本次请求照常成功；此后内存状态继续按读改写提供服务，绝不拒绝业务。
 *
 * 防篡改：
 * - 每行一条 JSON 记录，含 prevHash/hash（SHA-256，prevHash 链 + 本行内容）、
 *   行内 checksum；创世条目固定（ZERO_HASH 前链 + 固定 genesis 体）。
 * - verifyAudit() 从磁盘独立重建哈希链并重放状态，与当前内存逐项比对。
 * - 快照压缩后链从新创世重建（genesis 携带 epoch/snapshotId 与前链 tip 锚点），
 *   verify 仍可跨“快照状态 + 当前日志”全量校验。
 */
import { createHash } from 'node:crypto'
import { randomBytes } from 'node:crypto'
import { openSync, writeFileSync, writeSync, renameSync, fsyncSync, closeSync, readFileSync, mkdirSync, ftruncateSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore, IDEMPOTENCY_TTL_MS } from './memory.js'

export const LOG_FILE = 'events.log'
export const SNAPSHOT_FILE = 'snapshot.json'
export const ZERO_HASH = '0'.repeat(64)
export const LOCK_FILE = 'leader.lock'
export const LOG_FORMAT_V1 = 1
export const LOG_FORMAT_V2 = 2
const SNAPSHOT_FORMAT_V1 = 'scratch-snapshot-v1'
const SNAPSHOT_FORMAT_V2 = 'scratch-snapshot-v2'
// 迁移过程文件（提交点协议）：tmp → v1bak → 正式；任一点崩溃可按在场性裁决
const MIGRATING_LOG = 'events.log.migrating'
const MIGRATING_SNAPSHOT = 'snapshot.json.migrating'
const V1BAK_LOG = 'events.log.v1bak'
const V1BAK_SNAPSHOT = 'snapshot.json.v1bak'
const DEFAULT_SNAPSHOT_EVERY_LINES = 1000
const DEFAULT_SNAPSHOT_EVERY_BYTES = 256 * 1024
const DEFAULT_HEARTBEAT_MS = 1000
const DEFAULT_LOCK_STALE_MS = 5000

/** follower 上的业务写：明确只读错误（HTTP 层映射 503 read-only） */
export class ReadOnlyError extends Error {
  constructor(message = 'store is a read-only follower') {
    super(message)
    this.code = 'read-only'
  }
}

/** 确定性 JSON（键字典序递归），保证跨进程哈希/比对稳定 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function cardKeyOf(sid, campaignId, day, cardId) {
  return `${sid}#${campaignId}#${day}#${cardId}`
}

function dayKeyOf(sid, campaignId, day) {
  return `${sid}#${campaignId}#${day}`
}

function idemKeyOf(sid, scope, key) {
  return `${sid}#${scope}#${key}`
}

/** 记录内容哈希：固定字段集合（canonicalJSON 键序确定），hash 字段本身不参与；
 *  v2 记录的 v 字段参与哈希，v1 记录无 v —— 同一函数兼容两代 */
function hashRecord(rec) {
  return sha256Hex(
    canonicalJSON({
      seq: rec.seq,
      kind: rec.kind,
      prevHash: rec.prevHash,
      epoch: rec.epoch,
      data: rec.data,
      ...(rec.v === undefined ? {} : { v: rec.v }),
    }),
  )
}

function encodeRecord(rec) {
  const body = {
    seq: rec.seq,
    kind: rec.kind,
    prevHash: rec.prevHash,
    hash: rec.hash,
    epoch: rec.epoch,
    data: rec.data,
    ...(rec.v === undefined ? {} : { v: rec.v }),
  }
  const line = JSON.stringify(body)
  const checksum = sha256Hex(line)
  return `${line}|${checksum}\n`
}

/** 解析一行（不含换行）；任何不合法都抛错（调用方据此标记 truncation-anomaly）。
 *  expectedVersion 缺省 = 宽容（首行探测用）；指定后强制该代格式（v1 无 v、v2 必须 v:2） */
function decodeLine(rawLine, expectedVersion) {
  const bar = rawLine.lastIndexOf('|')
  if (bar <= 0) throw new Error('malformed record: no checksum')
  const line = rawLine.slice(0, bar)
  const checksum = rawLine.slice(bar + 1)
  if (!/^[0-9a-f]{64}$/.test(checksum) || sha256Hex(line) !== checksum) {
    throw new Error('checksum mismatch')
  }
  const rec = JSON.parse(line)
  if (
    typeof rec.seq !== 'number' ||
    typeof rec.kind !== 'string' ||
    typeof rec.prevHash !== 'string' ||
    typeof rec.hash !== 'string' ||
    typeof rec.epoch !== 'number'
  ) {
    throw new Error('malformed record: shape')
  }
  if (rec.v !== undefined && rec.v !== LOG_FORMAT_V2) throw new Error('unknown format version')
  if (expectedVersion === LOG_FORMAT_V2 && rec.v !== LOG_FORMAT_V2) throw new Error('format version mismatch')
  if (expectedVersion === LOG_FORMAT_V1 && rec.v !== undefined) throw new Error('format version mismatch')
  if (hashRecord(rec) !== rec.hash) throw new Error('hash mismatch')
  return rec
}

/** 当前代（v2）创世：data.format 与记录级 v 双显式标记 */
function genesisRecord(epoch, extra = {}) {
  const data = { t: 'genesis', epoch, format: LOG_FORMAT_V2, ...extra }
  const rec = { seq: 1, kind: 'GENESIS', prevHash: ZERO_HASH, hash: null, epoch, data, v: LOG_FORMAT_V2 }
  rec.hash = hashRecord(rec)
  return rec
}

/** 测试可注入的模拟崩溃（区别于真实磁盘错误） */
export class SimulatedCrash extends Error {
  constructor(windowName) {
    super(`simulated crash: ${windowName}`)
    this.window = windowName
  }
}

function readSnapshot(snapshotPath) {
  let raw
  try {
    raw = readFileSync(snapshotPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent' }
    throw error
  }
  // 文件形如：<canonical JSON>\n<sha256 checksum>\n
  const trimmed = raw.replace(/\s+$/, '')
  const splitAt = trimmed.lastIndexOf('\n')
  if (splitAt <= 0) return { status: 'corrupt', reason: 'snapshot missing checksum line' }
  const jsonPart = trimmed.slice(0, splitAt)
  const checksum = trimmed.slice(splitAt + 1)
  let snapshot
  try {
    snapshot = JSON.parse(jsonPart)
  } catch {
    return { status: 'corrupt', reason: 'snapshot not JSON' }
  }
  if (
    !snapshot ||
    (snapshot.format !== SNAPSHOT_FORMAT_V1 && snapshot.format !== SNAPSHOT_FORMAT_V2) ||
    !/^[0-9a-f]{64}$/.test(checksum) ||
    sha256Hex(canonicalJSON(snapshot)) !== checksum
  ) {
    return { status: 'corrupt', reason: 'snapshot checksum/shape mismatch' }
  }
  return { status: 'ok', snapshot }
}

function freshState() {
  return {
    sessions: new Map(),
    days: new Map(),
    cards: new Map(),
    idempotency: new Map(),
    claimsLedger: new Set(),
    meta: new Map(),
    events: [],
  }
}

function stateFromSnapshot(snapshot) {
  const state = freshState()
  const s = snapshot.state
  for (const [key, value] of Object.entries(s.sessions ?? {})) state.sessions.set(key, value)
  for (const [key, value] of Object.entries(s.days ?? {})) state.days.set(key, value)
  for (const [key, value] of Object.entries(s.cards ?? {})) state.cards.set(key, value)
  for (const [key, value] of Object.entries(s.idempotency ?? {})) state.idempotency.set(key, value)
  for (const value of s.claimsLedger ?? []) state.claimsLedger.add(value)
  for (const [key, value] of Object.entries(s.meta ?? {})) state.meta.set(key, value)
  state.events = Array.isArray(s.events) ? [...s.events] : []
  return state
}

/** 把一条已提交事务的全部 ops 重放进内存态 */
function applyOps(state, ops) {
  for (const op of ops) {
    switch (op.t) {
      case 'session-upsert':
        state.sessions.set(op.sid, clone(op.session))
        break
      case 'day-upsert':
        state.days.set(dayKeyOf(op.sid, op.campaignId, op.day), clone(op.record))
        break
      case 'card-upsert':
        state.cards.set(cardKeyOf(op.sid, op.campaignId, op.day, op.cardId), clone(op.record))
        break
      case 'idem-upsert':
        state.idempotency.set(idemKeyOf(op.sid, op.scope, op.key), clone(op.entry))
        break
      case 'claim-add':
        state.claimsLedger.add(op.dedupKey)
        break
      case 'meta-set':
        state.meta.set(op.key, clone(op.value))
        break
      case 'event':
        state.events.push(clone(op.event))
        break
      default:
        throw new Error(`unknown op: ${op.t}`)
    }
  }
}

/**
 * 从磁盘独立扫描快照 + 日志，重建哈希链与内存态（verifyAudit 与启动恢复共用）。
 * 不触碰任何活 store 的内存。链游标只在整条事务组（到 COMMIT）校验通过后推进，
 * 因此未提交的尾部 APPLY 整组作废、不影响"最后有效位置"。
 */
function replayFromDisk(dir) {
  const logPath = join(dir, LOG_FILE)
  const snapshotPath = join(dir, SNAPSHOT_FILE)
  const anomalies = []
  let snapshotInfo = readSnapshot(snapshotPath)
  let snapshot = null
  if (snapshotInfo.status === 'corrupt') {
    anomalies.push({ code: 'snapshot-corrupt', detail: snapshotInfo.reason })
  } else if (snapshotInfo.status === 'ok') {
    snapshot = snapshotInfo.snapshot
  }

  let buffer
  try {
    buffer = readFileSync(logPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    buffer = Buffer.alloc(0)
  }

  const state = snapshot ? stateFromSnapshot(snapshot) : freshState()
  let epoch = snapshot ? snapshot.epoch : 0
  let expectedSeq = 1
  let prevHash = snapshot ? snapshot.genesisHash : ZERO_HASH
  let entries = snapshot ? snapshot.records : 0
  let fileVersion = null // 由首条成功解码的记录确定（无 v 字段 = v1）
  const migrations = [] // 链上 MIGRATE 记录（格式迁移审计）
  let validBytes = 0 // 最后一条完整且校验通过（已提交）记录之后的字节偏移
  let lastLineEndedWithNewline = true
  let firstBrokenSeq
  let truncated = false
  let offset = 0

  // 当前进行中的事务组：ops + 组开始前的链游标/字节位置
  let groupOps = null

  function stop(reason, seq) {
    truncated = true
    if (firstBrokenSeq === undefined && seq !== undefined) firstBrokenSeq = seq
    anomalies.push({ code: 'truncation-anomaly', detail: reason })
  }

  while (offset < buffer.length) {
    const lineStart = offset
    let lineEnd = buffer.indexOf(0x0a, offset)
    const hasNewline = lineEnd !== -1
    if (!hasNewline) lineEnd = buffer.length
    const rawLine = buffer.slice(lineStart, lineEnd).toString('utf8')

    let rec
    if (rawLine.length === 0) {
      stop('empty line injected', expectedSeq)
      break
    }
    try {
      rec = decodeLine(rawLine, fileVersion ?? undefined)
    } catch {
      stop('corrupt or truncated tail record', expectedSeq)
      break
    }
    if (fileVersion === null) fileVersion = rec.v ?? LOG_FORMAT_V1

    const nextOffset = hasNewline ? lineEnd + 1 : lineEnd

    if (rec.kind === 'GENESIS') {
      if (groupOps || entries !== (snapshot ? snapshot.records : 0) || rec.seq !== 1) {
        stop('unexpected genesis position', rec.seq)
        break
      }
      if (rec.epoch !== epoch || rec.seq !== 1 || rec.prevHash !== ZERO_HASH) {
        stop('bad genesis', 1)
        break
      }
      if (snapshot) {
        if (
          rec.data.snapshotId !== snapshot.snapshotId ||
          rec.data.prevEpochTip !== snapshot.tipHash ||
          rec.data.prevEpochRecords !== snapshot.records
        ) {
          stop('genesis does not anchor to snapshot', 1)
          break
        }
      } else if (rec.data.epoch !== 0 || rec.data.snapshotId !== undefined) {
        stop('primal genesis must be fixed', 1)
        break
      }
      // 创世行：直接提交游标
      entries += 1
      expectedSeq = 2
      prevHash = rec.hash
      validBytes = nextOffset
      lastLineEndedWithNewline = hasNewline
      offset = nextOffset
      continue
    }

    if (rec.seq !== expectedSeq || rec.prevHash !== prevHash || rec.epoch !== epoch) {
      stop('hash chain broken', rec.seq)
      break
    }

    if (rec.kind === 'APPLY') {
      if (!rec.data.op || typeof rec.data.group !== 'number') {
        stop('malformed APPLY', rec.seq)
        break
      }
      if (!groupOps) {
        groupOps = { ops: [], cursor: { expectedSeq, prevHash }, bytes: validBytes, newlines: lastLineEndedWithNewline }
      }
      groupOps.ops.push(rec.data.op)
      entries += 1
      expectedSeq = rec.seq + 1
      prevHash = rec.hash
      lastLineEndedWithNewline = hasNewline
      offset = nextOffset
      continue
    }

    if (rec.kind === 'COMMIT') {
      if (!groupOps) {
        stop('commit without apply group', rec.seq)
        break
      }
      const group = rec.data.group
      const nOps = rec.data.n
      if (typeof group !== 'number' || typeof nOps !== 'number' || nOps !== groupOps.ops.length || nOps === 0) {
        stop('commit group mismatch', rec.seq)
        break
      }
      const eventOps = groupOps.ops.filter((op) => op.t === 'event')
      const expectedGroup = state.events.length + 1
      if (group !== expectedGroup || eventOps.some((op, i) => op.event.seq !== group + i)) {
        stop('commit group seq mismatch', rec.seq)
        break
      }
      let applyError = null
      try {
        applyOps(state, groupOps.ops)
      } catch (error) {
        applyError = error
      }
      if (applyError) {
        stop(applyError.message, rec.seq)
        break
      }
      entries += 1
      expectedSeq = rec.seq + 1
      prevHash = rec.hash
      validBytes = nextOffset
      lastLineEndedWithNewline = hasNewline
      groupOps = null
      offset = nextOffset
      continue
    }

    if (rec.kind === 'MIGRATE') {
      // 格式迁移事件：独立链记录（不在事务组内），迁移事实进链可审计
      if (fileVersion !== LOG_FORMAT_V2) {
        stop('migrate record in v1 log', rec.seq)
        break
      }
      if (groupOps) {
        stop('migrate record inside transaction group', rec.seq)
        break
      }
      const d = rec.data ?? {}
      const event = d.event
      if (
        d.t !== 'format-migration' ||
        d.from !== LOG_FORMAT_V1 ||
        d.to !== LOG_FORMAT_V2 ||
        typeof d.at !== 'number' ||
        !event ||
        event.type !== 'format-migrated' ||
        event.seq !== state.events.length + 1
      ) {
        stop('malformed migrate record', rec.seq)
        break
      }
      state.events.push(clone(event))
      migrations.push({
        seq: rec.seq,
        epoch: rec.epoch,
        at: d.at,
        from: d.from,
        to: d.to,
        sourceEpoch: d.sourceEpoch ?? null,
        sourceTip: d.sourceTip ?? null,
        sourceRecords: d.sourceRecords ?? null,
      })
      entries += 1
      expectedSeq = rec.seq + 1
      prevHash = rec.hash
      validBytes = nextOffset
      lastLineEndedWithNewline = hasNewline
      offset = nextOffset
      continue
    }

    stop(`unknown record kind ${rec.kind}`, rec.seq)
    break
  }

  if (groupOps) {
    // 只有 APPLY 没有 COMMIT（崩溃/截断在组尾）：整组不生效，游标回退到组前
    truncated = true
    if (firstBrokenSeq === undefined) firstBrokenSeq = groupOps.cursor.expectedSeq
    anomalies.push({ code: 'truncation-anomaly', detail: 'uncommitted transaction group at tail' })
    expectedSeq = groupOps.cursor.expectedSeq
    prevHash = groupOps.cursor.prevHash
    entries -= groupOps.ops.length
    validBytes = groupOps.bytes
    lastLineEndedWithNewline = groupOps.newlines
  }

  // 承诺顺序不变量（D21 语义的磁盘侧复核）：同一卡 commitment 事件生效序号
  // 必须严格早于任何携带 seed 的 card-upsert（pending-stored）生效序号。
  const eventSeqOf = new Map()
  for (const event of state.events) {
    eventSeqOf.set(`${event.type}|${event.sid}|${event.campaignId}|${event.cardId}`, event.seq)
  }
  for (const card of state.cards.values()) {
    if (card.seedHex == null) continue
    const key = (type) => `${type}|${card.sid}|${card.campaignId}|${card.cardId}`
    const commitSeq = eventSeqOf.get(key('commitment-created'))
    const pendingSeq = eventSeqOf.get(key('pending-stored'))
    if (commitSeq === undefined || (pendingSeq !== undefined && commitSeq >= pendingSeq)) {
      anomalies.push({ code: 'commitment-order-violation', cardId: card.cardId })
    }
  }

  return {
    state,
    snapshot,
    anomalies,
    truncated,
    firstBrokenSeq,
    entries,
    epoch,
    tipHash: prevHash,
    validBytes,
    lastLineEndedWithNewline,
    logSize: buffer.length,
    migrations,
    // 日志有记录 → 以首条记录为准；空日志 → 看快照代别；皆无 → 当前代（v2）
    formatVersion: fileVersion ?? (snapshot && snapshot.format === SNAPSHOT_FORMAT_V1 ? LOG_FORMAT_V1 : LOG_FORMAT_V2),
  }
}
export class FileStore extends MemoryStore {
  /**
   * @param {string} dir 数据目录（不存在则创建）
   * @param {object} [opts]
   * @param {number} [opts.snapshotEveryLines] 日志每多少行触发一次快照压缩
   * @param {number} [opts.snapshotEveryBytes] 日志累计写字节触发阈值
   * @param {function} [opts.logger]
   * @param {object} [opts.faults] 测试故障注入（命中一次即失效）
   */
  constructor(dir, opts = {}) {
    super()
    this.dir = dir
    this.logPath = join(dir, LOG_FILE)
    this.snapshotPath = join(dir, SNAPSHOT_FILE)
    this.tmpSnapshotPath = join(dir, `.${SNAPSHOT_FILE}.tmp`)
    this.lockPath = join(dir, LOCK_FILE)
    this.snapshotEveryLines = opts.snapshotEveryLines ?? DEFAULT_SNAPSHOT_EVERY_LINES
    this.snapshotEveryBytes = opts.snapshotEveryBytes ?? DEFAULT_SNAPSHOT_EVERY_BYTES
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.logger = opts.logger ?? null
    this.faults = opts.faults ?? null
    this.faultCounts = new Map()
    this.persistent = true
    this.degradedReason = null
    this.anomalies = []
    this.staged = []
    this.epoch = 0
    this.seq = 0
    this.tipHash = null
    this.logBytes = 0
    this.totalRecords = 0 // 跨快照累计的哈希链记录条数（审计 entries）
    this.fd = null
    this.closed = false
    this.lockToken = `${process.pid}-${randomBytes(6).toString('hex')}`
    this.heartbeatTimer = null
    this.formatVersion = LOG_FORMAT_V2
    this.migrations = []
    this._diskSig = null

    mkdirSync(dir, { recursive: true })
    if (this._tryAcquireLock()) {
      this._initLeader()
    } else {
      this.role = 'follower'
      this._loadReadOnly()
    }
  }

  get isPersistent() {
    return this.persistent
  }

  get isReadOnly() {
    return this.role !== 'leader'
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.role === 'leader') {
      this._flush()
      if (this.fd !== null) {
        try {
          fsyncSync(this.fd)
        } catch {
          // fd 可能已在降级时关闭
        }
        try {
          closeSync(this.fd)
        } catch {
          // 忽略
        }
        this.fd = null
      }
      this._releaseLock()
      return
    }
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // 忽略
      }
      this.fd = null
    }
  }

  // ---------- 多实例：leader 锁 ----------
  /** 读锁内容；不可解析时以 mtime 兜底（心跳原子替换，不会读到半文件） */
  _readLock() {
    let raw
    try {
      raw = readFileSync(this.lockPath, 'utf8')
    } catch {
      return null
    }
    let mtimeMs = 0
    try {
      mtimeMs = statSync(this.lockPath).mtimeMs
    } catch {
      // 读取间隙被删除：视为无锁
      return null
    }
    try {
      const info = JSON.parse(raw)
      if (typeof info.heartbeatAt !== 'number') info.heartbeatAt = mtimeMs
      return info
    } catch {
      return { pid: null, token: null, heartbeatAt: mtimeMs }
    }
  }

  _isStale(info) {
    return Date.now() - info.heartbeatAt > this.lockStaleMs
  }

  _writeLockFile() {
    const tmp = `${this.lockPath}.${this.lockToken}.tmp`
    const body = JSON.stringify({
      pid: process.pid,
      token: this.lockToken,
      heartbeatAt: Date.now(),
    })
    writeFileSync(tmp, body)
    renameSync(tmp, this.lockPath) // 原子替换：读者只见完整新旧两态
  }

  /**
   * 尝试成为 leader：wx 原子创建；锁在场且未过期 → false（follower）；
   * 锁过期 → 二次确认后 rename 原子抢占（同名目标只一个胜者），再重试创建。
   */
  _tryAcquireLock() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockPath, 'wx')
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken, heartbeatAt: Date.now() }))
        } finally {
          closeSync(fd)
        }
        return true
      } catch (error) {
        if (error.code !== 'EEXIST') return false // 目录不可写等：降级为 follower
        const info = this._readLock()
        if (!info || !this._isStale(info)) return false
        if (!this._stealStaleLock(info)) return false
      }
    }
    return false
  }

  /** 抢占过期锁：二次确认仍过期后 rename 独占认领（防陈旧误杀与并发接管） */
  _stealStaleLock(info) {
    const again = this._readLock()
    if (!again || again.token !== info.token || !this._isStale(again)) return false
    const claimPath = `${this.lockPath}.stale.${info.token ?? 'unknown'}`
    try {
      renameSync(this.lockPath, claimPath)
    } catch {
      return false // 被其他实例抢先 / 锁已刷新
    }
    try {
      rmSync(claimPath, { force: true })
    } catch {
      // 清理失败无碍：认领已成功
    }
    return true
  }

  _releaseLock() {
    try {
      const info = this._readLock()
      if (info && info.token === this.lockToken) rmSync(this.lockPath, { force: true })
    } catch {
      // 锁释放失败：staleMs 后仍可被接管
    }
  }

  _startHeartbeat() {
    if (this.heartbeatTimer !== null) return
    this.heartbeatTimer = setInterval(() => {
      try {
        this._writeLockFile()
      } catch (error) {
        this._logWarn('lock-heartbeat-failed', { error: String(error?.message ?? error) })
      }
    }, this.heartbeatMs)
    this.heartbeatTimer.unref()
  }

  /** leader 初始化：迁移残留裁决 →（必要时）v1→v2 迁移 → 常规恢复 → 心跳 */
  _initLeader() {
    this.role = 'leader'
    this._resolveMigrationLeftovers()
    const disk = replayFromDisk(this.dir)
    if (disk.formatVersion === LOG_FORMAT_V1) {
      this._migrateToV2(disk)
    }
    this._recover()
    this._startHeartbeat()
  }

  // ---------- 降级 ----------
  _degrade(reason, error) {
    if (this.persistent) {
      this.persistent = false
      this.degradedReason = reason
      this._logWarn('persistence-degraded', { reason, error: String(error?.message ?? error) })
    }
    this.staged = []
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // 忽略：fd 可能已失效
      }
      this.fd = null
    }
  }

  _logWarn(event, extra) {
    if (this.logger) this.logger({ level: 'warn', event, ...extra })
  }

  /** SimulatedCrash = 进程即刻死亡：停心跳、关 fd、释放锁、标记关闭。
   *  真实进程死亡时锁文件残留、靠心跳过期被接管；模拟死亡主动放锁，
   *  让“死亡后重开”的测试路径与真实重启同样立即可接管。 */
  _simulateDeath() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // 忽略：进程已死
      }
      this.fd = null
    }
    this._releaseLock()
    this.closed = true
  }

  _markAnomaly(code, detail) {
    this.anomalies.push({ code, ...(detail ? { detail } : {}) })
    this._logWarn(code, detail ? { detail } : undefined)
  }

  _fault(name) {
    const faults = this.faults
    if (!faults || !Object.prototype.hasOwnProperty.call(faults, name)) return null
    const value = faults[name]
    if (typeof value === 'number') {
      // 数字 n 表示在第 n 次检查时触发（session flush=1、首个 begin flush=2 …）
      const next = (this.faultCounts.get(name) ?? 0) + 1
      this.faultCounts.set(name, next)
      if (next !== value) return null
    }
    delete faults[name] // 命中一次即失效
    return value
  }

  // ---------- 启动回放 ----------
  /** 把一次磁盘回放结果采纳为活内存态（leader 恢复与 follower 加载/刷新共用） */
  _adoptDiskState(disk) {
    this.sessions = disk.state.sessions
    this.days = disk.state.days
    this.cards = disk.state.cards
    this.idempotency = disk.state.idempotency
    this.claimsLedger = disk.state.claimsLedger
    this.meta = disk.state.meta
    this.events = disk.state.events
    this.epoch = disk.epoch
    this.tipHash = disk.tipHash
    this.totalRecords = disk.entries
    this.logBytes = disk.validBytes
    this.formatVersion = disk.formatVersion
    this.migrations = disk.migrations
  }

  /** follower 只读加载：不建锁、不开写 fd、不写任何文件 */
  _loadReadOnly() {
    let disk
    try {
      disk = replayFromDisk(this.dir)
    } catch (error) {
      // 只读回放失败：空态继续服务（读得到多少是多少，绝不写盘）
      this._markAnomaly('follower-replay-failed', String(error.message))
      return
    }
    this._adoptDiskState(disk)
    this.seq = 1
    this._diskSig = this._diskSignature()
  }

  _diskSignature() {
    const stat = (path) => {
      try {
        const s = statSync(path)
        return `${s.size}:${s.mtimeMs}`
      } catch {
        return 'absent'
      }
    }
    return `${stat(this.logPath)}|${stat(this.snapshotPath)}`
  }

  /**
   * follower 刷新（每个请求入口由 HTTP 层调用；leader/降级态为空操作）：
   * 机制 = 轮询式文件尾增量——按 mtime/size 签名变化才整段重放。
   * 取舍：不引 fs.watch（跨平台事件丢失/抖动），读路径纯只读、绝不阻塞
   * leader 写；一致性为请求级最终一致（同一请求内先刷新再服务）。
   * 锁消失/过期时懒接管为 leader（无需重启即可继续写）。
   */
  refresh() {
    if (this.closed) return
    if (this.role === 'follower') {
      const info = this._readLock()
      if ((!info || this._isStale(info)) && this._tryAcquireLock()) {
        // 接管：按 leader 流程完整初始化（含迁移裁决与恢复）
        try {
          this._initLeader()
        } catch (error) {
          this._markAnomaly('takeover-failed', String(error?.message ?? error))
        }
        return
      }
      const sig = this._diskSignature()
      if (sig === this._diskSig) return
      try {
        const disk = replayFromDisk(this.dir)
        this._adoptDiskState(disk)
        this._diskSig = sig
      } catch {
        // 读到 leader 写入中途的瞬态：保留上一份一致状态，下次再试
      }
    }
  }

  // ---------- v1 → v2 在线迁移 ----------
  /**
   * 崩溃恢复裁决（leader 启动第一步）：
   * - v1bak 在场且 events.log 为 v2 → 提交点已过：收尾（装快照、清残留）；
   * - v1bak 在场但 events.log 缺失/非 v2 → 未提交：完整回滚 v1（可重新迁移）；
   * - 仅 migrating tmp 在场 → 崩溃于备份前：清 tmp，维持 v1。
   */
  _resolveMigrationLeftovers() {
    const migratingLog = join(this.dir, MIGRATING_LOG)
    const migratingSnapshot = join(this.dir, MIGRATING_SNAPSHOT)
    const bakLog = join(this.dir, V1BAK_LOG)
    const bakSnapshot = join(this.dir, V1BAK_SNAPSHOT)
    const hasBakLog = existsSync(bakLog)
    const hasBakSnapshot = existsSync(bakSnapshot)
    const hasLog = existsSync(this.logPath)

    const cleanupTmps = () => {
      rmSync(migratingLog, { force: true })
      rmSync(migratingSnapshot, { force: true })
    }

    if (!hasBakLog && !hasBakSnapshot) {
      cleanupTmps()
      return
    }

    const committed = hasBakLog && hasLog && this._peekLogVersion() === LOG_FORMAT_V2
    if (committed) {
      // 已提交：确保 v2 快照就位，然后清残留
      if (!existsSync(this.snapshotPath) && existsSync(migratingSnapshot)) {
        renameSync(migratingSnapshot, this.snapshotPath)
      }
      rmSync(bakLog, { force: true })
      rmSync(bakSnapshot, { force: true })
      cleanupTmps()
    } else {
      // 未提交/不可裁决：完整回滚到 v1（v1bak 是迁移前原子的完整代）
      if (hasBakLog) {
        rmSync(this.logPath, { force: true })
        renameSync(bakLog, this.logPath)
      }
      if (hasBakSnapshot) {
        rmSync(this.snapshotPath, { force: true })
        renameSync(bakSnapshot, this.snapshotPath)
      }
      cleanupTmps()
    }
    this._fsyncDir()
  }

  /** 读日志首行判代（v 字段缺省 = v1；不可解析 = null） */
  _peekLogVersion() {
    try {
      const buffer = readFileSync(this.logPath)
      const end = buffer.indexOf(0x0a)
      const rawLine = buffer.slice(0, end === -1 ? buffer.length : end).toString('utf8')
      const rec = decodeLine(rawLine)
      return rec.v ?? LOG_FORMAT_V1
    } catch {
      return null
    }
  }

  _fsyncDir() {
    try {
      const dfd = openSync(this.dir, 'r')
      try {
        fsyncSync(dfd)
      } finally {
        closeSync(dfd)
      }
    } catch {
      // 目录 fsync 在个别平台不可用：文件内容已 fsync，忽略
    }
  }

  /**
   * v1 → v2 无损在线迁移（仅 leader、启动期同步执行，业务不中断）：
   * 全量状态压入 v2 快照（epoch+1，锚定旧链 tip），新日志 = v2 创世 +
   * MIGRATE 记录（迁移事件进链，事后可审计）。提交点 = 新日志 rename 就位；
   * 之前的崩溃回滚 v1，之后的崩溃按 v2 收尾——无 v1/v2 混杂中间态。
   */
  _migrateToV2(disk) {
    const at = Date.now()
    const nextEpoch = disk.epoch + 1
    const snapshotId = `snap-${nextEpoch}-${disk.tipHash.slice(0, 16)}`
    const genesis = genesisRecord(nextEpoch, {
      snapshotId,
      prevEpochTip: disk.tipHash,
      prevEpochRecords: disk.entries,
    })
    const migrationEvent = {
      seq: disk.state.events.length + 1,
      type: 'format-migrated',
      at,
      from: LOG_FORMAT_V1,
      to: LOG_FORMAT_V2,
      sourceEpoch: disk.epoch,
      sourceTip: disk.tipHash,
      sourceRecords: disk.entries,
    }
    const migrateRec = {
      seq: 2,
      kind: 'MIGRATE',
      prevHash: genesis.hash,
      hash: null,
      epoch: nextEpoch,
      data: {
        t: 'format-migration',
        from: LOG_FORMAT_V1,
        to: LOG_FORMAT_V2,
        at,
        sourceEpoch: disk.epoch,
        sourceTip: disk.tipHash,
        sourceRecords: disk.entries,
        event: clone(migrationEvent),
      },
      v: LOG_FORMAT_V2,
    }
    migrateRec.hash = hashRecord(migrateRec)

    const snapshot = {
      format: SNAPSHOT_FORMAT_V2,
      epoch: nextEpoch,
      snapshotId,
      createdAt: at,
      tipHash: disk.tipHash,
      records: disk.entries,
      genesisHash: genesis.hash,
      state: dumpOf(disk.state, at),
    }
    const snapshotFile = `${canonicalJSON(snapshot)}\n${sha256Hex(canonicalJSON(snapshot))}\n`
    const logFile = encodeRecord(genesis) + encodeRecord(migrateRec)

    const migratingLog = join(this.dir, MIGRATING_LOG)
    const migratingSnapshot = join(this.dir, MIGRATING_SNAPSHOT)
    const bakLog = join(this.dir, V1BAK_LOG)
    const bakSnapshot = join(this.dir, V1BAK_SNAPSHOT)

    // 1) tmp 落盘并 fsync（此时正式文件未动，崩溃 = 维持 v1）
    writeFileSync(migratingLog, logFile)
    writeFileSync(migratingSnapshot, snapshotFile)
    for (const tmp of [migratingLog, migratingSnapshot]) {
      const tfd = openSync(tmp, 'r+')
      try {
        fsyncSync(tfd)
      } finally {
        closeSync(tfd)
      }
    }
    // 2) v1 备份（rename 原子）；3) 新快照就位；4) 新日志 rename = 提交点
    if (existsSync(this.logPath)) renameSync(this.logPath, bakLog)
    if (existsSync(this.snapshotPath)) renameSync(this.snapshotPath, bakSnapshot)
    renameSync(migratingSnapshot, this.snapshotPath)
    renameSync(migratingLog, this.logPath)
    this._fsyncDir()
    // 5) 提交完成：清理 v1 备份（链上 MIGRATE + 创世锚点已保留可审计线索）
    rmSync(bakLog, { force: true })
    rmSync(bakSnapshot, { force: true })
    this._fsyncDir()
    this._logWarn('format-migrated', { from: LOG_FORMAT_V1, to: LOG_FORMAT_V2, epoch: nextEpoch })
  }

  _recover() {
    // 上次压缩在 rename 前死亡会留下 tmp 孤儿：它从未成为正式快照，直接清理
    try {
      rmSync(this.tmpSnapshotPath, { force: true })
    } catch {
      // 清理失败不阻断启动（正式快照与日志均不依赖 tmp）
    }
    let disk
    try {
      disk = replayFromDisk(this.dir)
    } catch (error) {
      // 目录可读但日志结构无法解析（非尾损坏）：抛出由工厂决定降级，绝不静默清零
      throw new Error(`log recovery failed: ${error.message}`)
    }

    this._adoptDiskState(disk)
    this.seq = 1 // 每代创世恒为 seq=1；真正末条游标在日志重开后按磁盘末行确定
    for (const anomaly of disk.anomalies) this.anomalies.push(anomaly)

    // 日志缺失/为空，或整条日志没有任何有效提交记录（首行即垃圾）：
    // 必须（重新）写创世；有快照时创世与快照锚定，否则写固定原初创世。
    const needsGenesis = disk.logSize === 0 || disk.validBytes === 0

    // 尾行没有换行（崩溃于 write 中途的最幸运情况：行内容完整但 \n 未落）：
    // 物理截断到 validBytes 后必须补一个换行，否则下次追加会并到上一行尾。
    const needsNewline =
      disk.validBytes > 0 &&
      !needsGenesis &&
      disk.lastLineEndedWithNewline === false

    if (needsGenesis) {
      try {
        const genesis = disk.snapshot
          ? genesisRecord(disk.epoch, {
              snapshotId: disk.snapshot.snapshotId,
              prevEpochTip: disk.snapshot.tipHash,
              prevEpochRecords: disk.snapshot.records,
            })
          : genesisRecord(0)
        // 整文件重写：既覆盖“首行即垃圾”（validBytes=0），也覆盖空/缺失文件
        const encoded = encodeRecord(genesis)
        writeFileSync(this.logPath, encoded)
        this.tipHash = genesis.hash
        this.seq = 1
        this.totalRecords += 1
        this.logBytes = Buffer.byteLength(encoded)
        this.fd = openSync(this.logPath, 'a')
      } catch (error) {
        // 连创世都写不进去：退化为纯内存（目录不可写/权限问题）
        this._degrade('genesis-write-failed', error)
        this._markAnomaly('genesis-write-failed', String(error.message))
        return
      }
    } else if (disk.truncated || needsNewline) {
      try {
        // 截掉尾部垃圾/半行/未提交组；validBytes>0 时文件必已存在
        const rfd = openSync(this.logPath, 'r+')
        try {
          ftruncateSync(rfd, disk.validBytes)
          if (needsNewline) writeFileSync(this.logPath, '\n', { flag: 'a' })
          fsyncSync(rfd)
        } finally {
          closeSync(rfd)
        }
        this.seq = this._tailSeqFromLog()
        if (needsNewline) this.logBytes = disk.validBytes + 1
        this.fd = openSync(this.logPath, 'a')
      } catch (error) {
        // 连截断/重开都做不到：退化为纯内存，已回放状态仍可继续服务
        this._degrade('recovery-rewrite-failed', error)
        this._markAnomaly('recovery-rewrite-failed', String(error.message))
        return
      }
    } else {
      this.seq = this._tailSeqFromLog()
      try {
        this.fd = openSync(this.logPath, 'a')
      } catch (error) {
        this._degrade('log-open-failed', error)
        this._markAnomaly('log-open-failed', String(error.message))
      }
    }
  }

  /** 读日志末行取 seq（仅在无截断时使用；失败默认 1） */
  _tailSeqFromLog() {
    try {
      const buffer = readFileSync(this.logPath)
      let end = buffer.length
      while (end > 0 && buffer[end - 1] === 0x0a) end -= 1
      const start = buffer.lastIndexOf(0x0a, end - 1) + 1
      const rawLine = buffer.slice(start, end).toString('utf8')
      const rec = decodeLine(rawLine)
      return rec.seq
    } catch {
      return 1
    }
  }

  // ---------- 变更暂存（redo 日志的内存工作区） ----------
  /** follower 业务写闸门：引擎写动作必经下列 mutator，统一在此拒绝 */
  _assertWritable() {
    if (this.role !== 'leader') throw new ReadOnlyError()
  }

  _stage(op) {
    this._assertWritable()
    this.staged.push(op)
  }

  /** 临界区末尾钩子（MemoryStore 无此方法 → 无副作用） */
  afterCriticalSection() {
    this._flush()
  }

  /** createSession 不在 withSidLock 内（sid 尚不存在），由 app 层显式调用 */
  flushPending() {
    this._flush()
  }

  // ---------- sessions ----------
  createSession(nowMs) {
    this._assertWritable()
    const sid = super.createSession(nowMs).sid
    // 复用父类构造的对象作为活工作副本（同进程立即可见）；落盘以事务末尾克隆为准
    const session = this.sessions.get(sid)
    this._stage({ t: 'session-upsert', sid, session: clone(session) })
    return session
  }

  touchSession(session, nowMs) {
    if (this.role !== 'leader') return // follower 的读路径记账：静默跳过（非业务写）
    super.touchSession(session, nowMs)
    this._stage({ t: 'session-upsert', sid: session.sid, session: clone(session) })
  }

  noteClock(session, { currentDayKey, nowMs }) {
    if (this.role !== 'leader') return // 同上：只读实例不改内存、不落盘
    // 与 MemoryStore.noteClock 逐分支一致，但在活工作副本上变更后整体暂存
    if (!session.maxObservedDayKey || currentDayKey > session.maxObservedDayKey) {
      session.maxObservedDayKey = currentDayKey
    }
    if (nowMs < session.maxObservedMs) session.clockAnomaly = true
    if (nowMs > session.maxObservedMs) session.maxObservedMs = nowMs
    session.lastSeenAt = nowMs
    this._stage({ t: 'session-upsert', sid: session.sid, session: clone(session) })
  }

  // ---------- day ledgers ----------
  ensureDay(sid, campaignId, day, nowMs) {
    this._assertWritable()
    const key = dayKeyOf(sid, campaignId, day)
    let record = this.days.get(key)
    if (!record) record = { chancesUsed: 0, createdAt: nowMs, updatedAt: nowMs }
    else record = clone(record)
    // 先放活 map：引擎拿到的工作副本即此对象，临界区内会继续原地
    // chancesUsed += 1；此处暂存引用，由 _flush 在落盘瞬间深拷贝，
    // 避免把变更前快照写进日志。
    this.days.set(key, record)
    this._stage({ t: 'day-upsert', sid, campaignId, day, record })
    return record
  }

  // ---------- cards ----------
  putCard(record, nowMs) {
    this._assertWritable()
    record.updatedAt = nowMs
    const stored = clone(record)
    this.cards.set(cardKeyOf(record.sid, record.campaignId, record.day, record.cardId), stored)
    this._stage({
      t: 'card-upsert',
      sid: record.sid,
      campaignId: record.campaignId,
      day: record.day,
      cardId: record.cardId,
      record: clone(stored),
    })
  }

  getCard(sid, campaignId, day, cardId) {
    const record = super.getCard(sid, campaignId, day, cardId)
    // 返回深拷贝：引擎在工作副本上 rev/status 变更，只有 putCard 才进入日志，
    // 避免“绕过 mutator 的原地修改”污染已提交内存。
    return record ? clone(record) : null
  }

  latestCards(sid, campaignId) {
    const latest = super.latestCards(sid, campaignId)
    return new Map([...latest].map(([cardId, record]) => [cardId, clone(record)]))
  }

  findCardByDedupKey(dedupKey) {
    const record = super.findCardByDedupKey(dedupKey)
    return record ? clone(record) : null
  }

  // ---------- idempotency ----------
  putIdempotency(sid, scope, key, entry) {
    this._assertWritable()
    const stored = clone(entry)
    this.idempotency.set(idemKeyOf(sid, scope, key), stored)
    this._stage({ t: 'idem-upsert', sid, scope, key, entry: clone(stored) })
  }

  // ---------- claims / meta ----------
  addClaim(dedupKey) {
    this._assertWritable()
    if (!this.claimsLedger.has(dedupKey)) {
      this.claimsLedger.add(dedupKey)
      this._stage({ t: 'claim-add', dedupKey })
    }
  }

  setMeta(key, value) {
    this._assertWritable()
    this.meta.set(key, clone(value))
    this._stage({ t: 'meta-set', key, value: clone(value) })
  }

  incrementMeta(key) {
    const next = (this.getMeta(key, 0) ?? 0) + 1
    this.setMeta(key, next)
    return next
  }

  // ---------- event log ----------
  appendEvent(type, payload, nowMs) {
    this._assertWritable()
    const event = { seq: this.events.length + 1, type, at: nowMs, ...payload }
    this.events.push(event)
    this._stage({ t: 'event', event: clone(event) })
    return event
  }

  // ---------- 事务提交（write-ahead，redo） ----------
  /**
   * 把当前临界区暂存的全部变更编成一个事务组，单次 writeSync 原子追加：
   * APPLY...COMMIT。写盘成功后才不再需要 staged（活内存在 mutator 阶段已
   * 同步更新，崩溃于“写后/返回前”时由下次启动 replay 该组 redo，效果幂等）。
   */
  _flush() {
    if (this.staged.length === 0) return
    this._assertWritable()
    if (!this.persistent || this.fd === null) {
      // 已降级：内存工作区即全部状态，清空暂存继续服务
      this.staged = []
      return
    }

    const ops = this.staged
    const group = this.events.length - ops.filter((op) => op.t === 'event').length + 1
    let chainSeq = this.seq
    let prev = this.tipHash
    const encoded = []
    for (const op of ops) {
      chainSeq += 1
      const applyRec = {
        seq: chainSeq,
        kind: 'APPLY',
        prevHash: prev,
        hash: null,
        epoch: this.epoch,
        data: { group, op: clone(op) },
        v: LOG_FORMAT_V2,
      }
      applyRec.hash = hashRecord(applyRec)
      prev = applyRec.hash
      encoded.push(encodeRecord(applyRec))
    }
    chainSeq += 1
    const commitRec = {
      seq: chainSeq,
      kind: 'COMMIT',
      prevHash: prev,
      hash: null,
      epoch: this.epoch,
      data: { group, n: ops.length },
      v: LOG_FORMAT_V2,
    }
    commitRec.hash = hashRecord(commitRec)
    encoded.push(encodeRecord(commitRec))
    const payload = encoded.join('')

    // 窗口 B 注入点：模拟“内存已提交、日志未写”（磁盘写失败）→ 必须优雅降级
    if (this._fault('failWrite')) {
      this._degrade('simulated-write-failure', new Error('injected write failure'))
      this.staged = []
      return
    }

    try {
      writeSync(this.fd, payload, null, 'utf8')
      fsyncSync(this.fd)
    } catch (error) {
      // 真实配额/权限错误：降级内存，本次业务请求不失败
      this._degrade('log-write-failed', error)
      this.staged = []
      return
    }

    // 窗口 A 注入点：日志已 write+fsync，但进程在内存事务“提交返回”前死亡
    if (this._fault('crashAfterWrite')) {
      // 模拟进程死亡：丢弃工作暂存（旧实例不再参与任何后续写），避免该
      // 实例被测试继续使用时重复 flush 同一条事务。
      this.staged = []
      this._simulateDeath()
      throw new SimulatedCrash('log-written-memory-not-committed')
    }

    this.seq = chainSeq
    this.tipHash = commitRec.hash
    this.totalRecords += encoded.length
    this.logBytes += Buffer.byteLength(payload)
    this.staged = []

    if (
      this.seq >= this.snapshotEveryLines ||
      this.logBytes >= this.snapshotEveryBytes
    ) {
      try {
        this._compact()
      } catch (error) {
        // 注入的模拟崩溃必须穿透（语义=进程即刻死亡，不降级、不吞错）；
        // 真实压缩失败不影响已 fsync 的日志，降级即可。
        if (error instanceof SimulatedCrash) throw error
        this._degrade('snapshot-compaction-failed', error)
      }
    }
  }

  // ---------- 周期快照压缩 ----------
  /**
   * 临时文件 + fsync + 原子 rename；与日志替换的顺序保证并发写入不丢事件：
   * 1) flush 只在会话临界区末尾（单线程同步）调用，压缩期间不可能有别的写；
   * 2) 先落快照（含 tipHash/records 锚点），再重写日志为锚定新创世；
   * 3) 任一步崩溃：旧日志仍在 → 全量回放（新快照成为孤儿，下次压缩覆盖）。
   */
  _compact() {
    this._assertWritable()
    const nextEpoch = this.epoch + 1
    const snapshotId = `snap-${nextEpoch}-${this.tipHash.slice(0, 16)}`
    const snapshot = {
      format: SNAPSHOT_FORMAT_V2,
      epoch: nextEpoch,
      snapshotId,
      createdAt: Date.now(),
      tipHash: this.tipHash,
      records: this.totalRecords,
      genesisHash: null,
      state: this._dumpState(),
    }
    const genesis = genesisRecord(nextEpoch, {
      snapshotId,
      prevEpochTip: this.tipHash,
      prevEpochRecords: this.totalRecords,
    })
    snapshot.genesisHash = genesis.hash
    const checksum = sha256Hex(canonicalJSON(snapshot))
    const snapshotFile = `${canonicalJSON(snapshot)}\n${checksum}\n`

    writeFileSync(this.tmpSnapshotPath, snapshotFile)
    const tfd = openSync(this.tmpSnapshotPath, 'r+')
    try {
      fsyncSync(tfd)
    } finally {
      closeSync(tfd)
    }
    // 测试窗口：临时快照已 fsync、尚未 rename（真实进程在此死亡时，
    // snapshot.json 仍不存在、旧日志完整，tmp 为可清理的孤儿）
    if (this._fault('crashAfterSnapshotWrite')) {
      this._simulateDeath()
      throw new SimulatedCrash('snapshot-written-not-swapped')
    }
    renameSync(this.tmpSnapshotPath, this.snapshotPath)

    // 日志重写为新创世（单文件原子 replace：此刻没有并发写）
    const newLog = encodeRecord(genesis)
    writeFileSync(this.logPath, newLog)
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // 旧 fd 关闭失败无妨：立刻以新文件重开
      }
    }
    this.fd = openSync(this.logPath, 'a')
    fsyncSync(this.fd)
    try {
      const dfd = openSync(this.dir, 'r')
      try {
        fsyncSync(dfd)
      } finally {
        closeSync(dfd)
      }
    } catch {
      // 目录 fsync 在个别平台不可用：文件内容已 fsync，忽略
    }

    this.epoch = nextEpoch
    this.seq = 1
    this.tipHash = genesis.hash
    this.totalRecords += 1
    this.logBytes = Buffer.byteLength(newLog)
  }

  // ---------- 审计 ----------
  /** 规范化可比较状态（剔除已过期幂等键，避免 TTL 造成伪分叉） */
  _dumpState(nowMs = Date.now()) {
    const idempotency = {}
    for (const [key, entry] of this.idempotency) {
      if (nowMs - entry.at <= IDEMPOTENCY_TTL_MS) idempotency[key] = entry
    }
    return {
      sessions: Object.fromEntries(this.sessions),
      days: Object.fromEntries(this.days),
      cards: Object.fromEntries(this.cards),
      idempotency,
      claimsLedger: [...this.claimsLedger],
      meta: Object.fromEntries(this.meta),
      events: this.events,
    }
  }

  verifyAudit(nowMs = Date.now()) {
    if (!this.persistent) {
      // 降级态：磁盘不再追加，无法持续审计；明确透出而非伪装 ok
      return {
        ok: false,
        persistent: false,
        role: this.role,
        format: this.formatVersion,
        migrations: this.migrations,
        entries: this.totalRecords,
        firstBrokenSeq: undefined,
        anomalies: [{ code: 'persistence-degraded', detail: this.degradedReason ?? 'unknown' }],
      }
    }

    let disk
    try {
      disk = replayFromDisk(this.dir)
    } catch (error) {
      return {
        ok: false,
        persistent: true,
        role: this.role,
        format: this.formatVersion,
        migrations: this.migrations,
        entries: 0,
        anomalies: [{ code: 'audit-read-failed', detail: String(error.message) }],
      }
    }

    // 合并启动回放时已自愈（物理切除脏尾）的生命周期异常：异常事实保留在
    // 审计结果中，但磁盘已干净时不判负；磁盘此刻仍坏（被再次外部改写）才判负。
    const anomalies = [...disk.anomalies]
    const seen = new Set(anomalies.map((item) => `${item.code}:${item.detail ?? ''}`))
    for (const item of this.anomalies) {
      const marker = `${item.code}:${item.detail ?? ''}`
      if (!seen.has(marker)) {
        seen.add(marker)
        anomalies.push(item)
      }
    }
    let ok = !disk.truncated
    if (disk.firstBrokenSeq !== undefined && disk.truncated) ok = false

    const liveDump = canonicalJSON(this._dumpState(nowMs))
    const diskDump = canonicalJSON(dumpOf(disk.state, nowMs))
    if (liveDump !== diskDump) {
      ok = false
      anomalies.push({ code: 'state-diverged' })
    }

    // 链锚点也必须与活游标一致
    if (disk.epoch !== this.epoch || disk.tipHash !== this.tipHash) {
      ok = false
      anomalies.push({ code: 'chain-tip-mismatch' })
    }

    return {
      ok,
      persistent: true,
      role: this.role,
      format: disk.formatVersion,
      migrations: disk.migrations,
      entries: disk.entries,
      firstBrokenSeq: disk.firstBrokenSeq,
      anomalies,
    }
  }
}

/** 供审计比较：把 replayFromDisk 的 state 规整成与 _dumpState 同形 */
function dumpOf(state, nowMs) {
  const idempotency = {}
  for (const [key, entry] of state.idempotency) {
    if (nowMs - entry.at <= IDEMPOTENCY_TTL_MS) idempotency[key] = entry
  }
  return {
    sessions: Object.fromEntries(state.sessions),
    days: Object.fromEntries(state.days),
    cards: Object.fromEntries(state.cards),
    idempotency,
    claimsLedger: [...state.claimsLedger],
    meta: Object.fromEntries(state.meta),
    events: state.events,
  }
}
