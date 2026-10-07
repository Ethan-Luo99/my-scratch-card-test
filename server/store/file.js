/**
 * FileStore：MemoryStore 的可互换持久化实现（仅用 node: 内置模块）。
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
 *
 * 多实例（leader/follower）：
 * - 同一数据目录用目录锁 leader.lock/ 保证单写者：mkdir 原子占位，锁内
 *   lock.json 心跳（heartbeatAt）。正常 close 释放锁 → 立即可接管；进程死亡
 *   时心跳停摆，超过 lockStaleMs（或 pid 已不存在）后由 takeover 原子
 *   rename 认领（rename 只有一个赢家，防并发接管；认领失败方退为 follower，
 *   绝不双写）。
 * - follower 只读：启动回放一次 + 周期轮询 refresh() 增量跟随 leader 提交；
 *   读路径只读文件、绝不写目录，因此不阻塞 leader 写路径。写操作抛
 *   ReadOnlyStoreError（HTTP 层映射 423 read-only）。
 *
 * 存储格式 v2 与在线迁移：
 * - v2 记录携带 v:2（参与哈希），快照 format=scratch-snapshot-v2；v1 数据
 *   （无 v 字段 / scratch-snapshot-v1）由 leader 启动时自动无损迁移。
 * - 迁移 = 以 v1 链 tip 为锚做一次 v2 快照压缩，并在新链第 2 条写入
 *   MIGRATE 记录（迁移事件进哈希链，事后可审计）；v1 原文件保留为
 *   *.v1.bak 审计轨迹，v2 创世经 prevEpochTip 锚定 v1 链尖。
 * - 崩溃安全：提交点 = events.log 首条记录变为 v2。之前的崩溃留下 tmp 孤儿
 *   （清理即可，仍是纯 v1）；v1 已改名备份而 v2 未落位 → 重启回滚到 v1；
 *   v2 日志已落位而快照未替换 → 重启补装快照完成迁移。任意时刻可裁决，
 *   绝不出现 verify 无法判定的 v1/v2 混杂（replay 对混杂直接报
 *   mixed-format-log / snapshot-log-format-mismatch 且 ok=false）。
 *
 * 时间点导出/恢复（PITR）：
 * - exportAt(asOf) 只从当前快照锚点 + 当前 WAL 的已提交前缀重建状态，并且
 *   asOf 必须精确等于某个 COMMIT 事务时间；未提交尾部、非事务边界、已被
 *   压缩出当前 WAL 的更早状态都明确拒绝，绝不猜测。
 * - follower 导出先等待链尖连续两轮稳定（只读轮询，不获取写锁、不阻塞
 *   leader），因此导出的快照、WAL 前缀、truncation 锚点与 leader 同点一致。
 * - 备份包在全新目录还原为 v2 snapshot.json + 截断到 COMMIT 的 events.log；
 *   asOf 已过期的幂等键只在有效状态比较时按 TTL 剔除，包内 idempotency
 *   字段说明取舍；快照与业务 WAL 均不重写，verify 仍以 v2 链为准。
 */
import { createHash, randomUUID } from 'node:crypto'
import { openSync, writeFileSync, writeSync, renameSync, fsyncSync, closeSync, readFileSync, mkdirSync, ftruncateSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore, IDEMPOTENCY_TTL_MS } from './memory.js'

export const LOG_FILE = 'events.log'
export const SNAPSHOT_FILE = 'snapshot.json'
export const ZERO_HASH = '0'.repeat(64)
export const LOG_FORMAT_VERSION = 2
export const LOCK_DIR = 'leader.lock'
export const LOG_V1_BACKUP = 'events.log.v1.bak'
export const SNAPSHOT_V1_BACKUP = 'snapshot.json.v1.bak'
const TMP_V2_LOG = '.events.log.v2.tmp'
const TMP_V2_SNAPSHOT = '.snapshot.json.v2.tmp'
const PITR_PACKAGE_FORMAT = 'scratch-pitr-v1'
const SNAPSHOT_FORMAT_V1 = 'scratch-snapshot-v1'
const SNAPSHOT_FORMAT_V2 = 'scratch-snapshot-v2'
const SNAPSHOT_FORMATS = new Map([
  [SNAPSHOT_FORMAT_V1, 1],
  [SNAPSHOT_FORMAT_V2, 2],
])
const DEFAULT_SNAPSHOT_EVERY_LINES = 1000
const DEFAULT_SNAPSHOT_EVERY_BYTES = 256 * 1024
const DEFAULT_LOCK_STALE_MS = 5000
const DEFAULT_HEARTBEAT_MS = 1000
const DEFAULT_FOLLOWER_POLL_MS = 1000

/** follower 上的写操作：HTTP 层映射为 423 {error:'read-only'} */
export class ReadOnlyStoreError extends Error {
  constructor() {
    super('store is read-only follower: writes require the leader')
    this.code = 'read-only'
  }
}

export class PitrExportError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
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

function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function fsyncFile(path) {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncDir(dir) {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // 目录 fsync 在个别平台不可用：文件内容已 fsync，忽略
  }
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

/** 记录内容哈希：固定字段顺序，hash 字段本身不参与；v 仅在显式携带时入哈希（v1 旧链哈希不变） */
function hashRecord(rec) {
  const payload = {
    seq: rec.seq,
    kind: rec.kind,
    prevHash: rec.prevHash,
    epoch: rec.epoch,
    data: rec.data,
  }
  if (rec.v != null) payload.v = rec.v
  return sha256Hex(canonicalJSON(payload))
}

function encodeRecord(rec) {
  const body = {
    seq: rec.seq,
    kind: rec.kind,
    prevHash: rec.prevHash,
    hash: rec.hash,
    epoch: rec.epoch,
    data: rec.data,
  }
  if (rec.v != null) body.v = rec.v
  const line = JSON.stringify(body)
  const checksum = sha256Hex(line)
  return `${line}|${checksum}\n`
}

/** 解析一行（不含换行）；任何不合法都抛错（调用方据此标记 truncation-anomaly） */
function decodeLine(rawLine) {
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
  if (rec.v !== undefined && rec.v !== 1 && rec.v !== 2) {
    throw new Error('malformed record: unsupported format version')
  }
  if (hashRecord(rec) !== rec.hash) throw new Error('hash mismatch')
  return rec
}

function genesisRecord(epoch, extra = {}, version = 1) {
  const data = { t: 'genesis', epoch, ...extra }
  const rec = { seq: 1, kind: 'GENESIS', prevHash: ZERO_HASH, hash: null, epoch, data }
  if (version >= 2) rec.v = version
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
  const version = snapshot ? SNAPSHOT_FORMATS.get(snapshot.format) : undefined
  if (
    !snapshot ||
    version === undefined ||
    !/^[0-9a-f]{64}$/.test(checksum) ||
    sha256Hex(canonicalJSON(snapshot)) !== checksum
  ) {
    return { status: 'corrupt', reason: 'snapshot checksum/shape mismatch' }
  }
  return { status: 'ok', snapshot, version }
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

function stateToObject(state, nowMs = Date.now(), pruneTtl = true) {
  const idempotency = {}
  for (const [key, entry] of state.idempotency) {
    if (!pruneTtl || nowMs - entry.at <= IDEMPOTENCY_TTL_MS) idempotency[key] = entry
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

function commitTimeOfOps(ops) {
  let at = null
  for (const op of ops) {
    const candidates = [
      op.event?.at,
      op.session?.lastSeenAt ?? op.session?.createdAt,
      op.record?.updatedAt ?? op.record?.createdAt ?? op.record?.beginAt,
      op.entry?.at,
      op.value,
    ]
    for (const value of candidates) {
      if (typeof value === 'number' && Number.isFinite(value) && (at === null || value > at)) at = value
    }
  }
  return at
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
  let snapshotVersion = null
  if (snapshotInfo.status === 'corrupt') {
    anomalies.push({ code: 'snapshot-corrupt', detail: snapshotInfo.reason })
  } else if (snapshotInfo.status === 'ok') {
    snapshot = snapshotInfo.snapshot
    snapshotVersion = snapshotInfo.version
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
  let validBytes = 0 // 最后一条完整且校验通过（已提交）记录之后的字节偏移
  let lastLineEndedWithNewline = true
  let firstBrokenSeq
  let truncated = false
  let formatConflict = false
  let offset = 0
  let logVersion = null // 日志内全部记录必须同版本；混杂即 mixed-format-log
  const migrations = [] // 链上 MIGRATE 记录（格式迁移事件，可审计）
  let lastCommitAt = null

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
      rec = decodeLine(rawLine)
    } catch {
      stop('corrupt or truncated tail record', expectedSeq)
      break
    }

    const nextOffset = hasNewline ? lineEnd + 1 : lineEnd
    const recVersion = rec.v ?? 1
    if (logVersion === null) logVersion = recVersion
    else if (recVersion !== logVersion) {
      stop('mixed-format log: v1/v2 records interleaved', rec.seq)
      break
    }

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
      lastCommitAt = commitTimeOfOps(groupOps.ops)
      groupOps = null
      offset = nextOffset
      continue
    }

    if (rec.kind === 'MIGRATE') {
      // 格式迁移事件：纯链记录（无业务 ops），必须出现在组外且为 v2
      const d = rec.data ?? {}
      if (
        groupOps ||
        recVersion !== 2 ||
        d.t !== 'format-migration' ||
        d.from !== 1 ||
        d.to !== 2 ||
        typeof d.at !== 'number'
      ) {
        stop('malformed MIGRATE record', rec.seq)
        break
      }
      migrations.push({
        seq: rec.seq,
        at: d.at,
        from: d.from,
        to: d.to,
        v1TipHash: d.v1TipHash ?? null,
        v1Records: d.v1Records ?? null,
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

  // 快照与日志格式版本必须一致（v1 快照 + v2 日志只可能出现在迁移崩溃窗口，
  // 由启动裁决修复；到达这里即不可服务的混杂态，verify 判负而非猜）
  if (snapshot && logVersion !== null && snapshotVersion !== logVersion) {
    formatConflict = true
    anomalies.push({
      code: 'snapshot-log-format-mismatch',
      detail: `snapshot v${snapshotVersion} vs log v${logVersion}`,
    })
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
    formatConflict,
    firstBrokenSeq,
    entries,
    epoch,
    tipHash: prevHash,
    validBytes,
    lastLineEndedWithNewline,
    logSize: buffer.length,
    logVersion,
    snapshotVersion,
    migrations,
    lastCommitAt,
  }
}

function readExportPoint(dir, asOfMs, ttlMs = IDEMPOTENCY_TTL_MS) {
  const disk = replayFromDisk(dir)
  const committedPrefixOnly =
    !disk.formatConflict &&
    disk.truncated &&
    disk.anomalies.length > 0 &&
    disk.anomalies.every((anomaly) => anomaly.code === 'truncation-anomaly')
  if (disk.formatConflict || (!committedPrefixOnly && disk.anomalies.length > 0)) {
    throw new PitrExportError(409, 'pitr-store-anomaly', 'audit chain is not currently clean enough for export')
  }

  const diskVersion = disk.logVersion ?? disk.snapshotVersion ?? null
  const migration = disk.migrations.find((item) => item.from === 1 && item.to === 2)
  if (diskVersion !== null && diskVersion < 2) {
    throw new PitrExportError(
      422,
      'pitr-before-retained-history',
      'asOf points into v1 history; retained v2 history starts after online migration',
    )
  }
  if (migration && asOfMs <= migration.at) {
    throw new PitrExportError(
      422,
      'pitr-before-retained-history',
      'asOf points into v1 history; the v1 prefix is anchored but removed during migration',
    )
  }

  let buffer
  try {
    buffer = readFileSync(join(dir, LOG_FILE))
    if (committedPrefixOnly) buffer = buffer.subarray(0, disk.validBytes)
  } catch (error) {
    throw new PitrExportError(500, 'pitr-read-failed', String(error.message))
  }

  const records = []
  let offset = 0
  while (offset < buffer.length) {
    const lineStart = offset
    const newlineAt = buffer.indexOf(0x0a, offset)
    const lineEnd = newlineAt === -1 ? buffer.length : newlineAt
    const nextOffset = newlineAt === -1 ? lineEnd : newlineAt + 1
    const rawLine = buffer.slice(lineStart, lineEnd).toString('utf8')
    const rec = decodeLine(rawLine)
    records.push({ rec, bytes: nextOffset, start: lineStart, end: nextOffset })
    offset = nextOffset
  }

  let groupOps = null
  let firstCommitAt = null
  let matchingCommit = null
  let matchingCommitAt = null
  let entriesBefore = disk.snapshot ? disk.snapshot.records : 0

  for (const item of records) {
    const { rec } = item
    if (rec.kind === 'GENESIS') {
      entriesBefore += 1
      groupOps = null
      continue
    }
    if (rec.kind === 'MIGRATE') {
      entriesBefore += 1
      continue
    }
    if (rec.kind === 'APPLY') {
      if (!groupOps) groupOps = { ops: [], entriesBefore }
      groupOps.ops.push(rec.data.op)
      entriesBefore += 1
      continue
    }
    if (rec.kind !== 'COMMIT') {
      throw new PitrExportError(500, 'pitr-read-failed', `unexpected record kind ${rec.kind}`)
    }
    const commitAt = commitTimeOfOps(groupOps?.ops ?? [])
    if (commitAt === null) throw new PitrExportError(500, 'pitr-read-failed', 'commit has no timestamp')
    firstCommitAt ??= commitAt
    entriesBefore += 1
    if (commitAt === asOfMs) {
      if (matchingCommit) {
        throw new PitrExportError(409, 'pitr-ambiguous-commit-boundary', 'multiple committed transactions share this timestamp')
      }
      matchingCommit = item
      matchingCommitAt = commitAt
    }
    groupOps = null
  }

  if (matchingCommit === null) {
    if (firstCommitAt === null || asOfMs < firstCommitAt) {
      const code = migration || disk.snapshot ? 'pitr-before-retained-history' : 'pitr-before-first-commit'
      const message = migration
        ? 'asOf points into v1 history; retained v2 history starts after online migration'
        : disk.snapshot
          ? 'asOf predates the retained WAL start; the older prefix was compacted'
          : 'asOf points before the first committed transaction'
      throw new PitrExportError(422, code, message)
    }
    throw new PitrExportError(422, 'pitr-not-commit-boundary', 'asOf does not equal a committed transaction boundary')
  }

  const state = disk.snapshot ? stateFromSnapshot(disk.snapshot) : freshState()
  let entries = disk.snapshot ? disk.snapshot.records : 0
  let pendingOps = null
  for (const item of records) {
    const { rec } = item
    if (rec.kind === 'GENESIS' || rec.kind === 'MIGRATE') {
      entries += 1
      continue
    }
    if (rec.kind === 'APPLY') {
      pendingOps ??= []
      pendingOps.push(rec.data.op)
      entries += 1
      continue
    }
    if (rec.kind === 'COMMIT') {
      applyOps(state, pendingOps ?? [])
      entries += 1
      pendingOps = null
      if (item === matchingCommit) break
    }
  }

  const expiredIdempotencyKeys = []
  for (const [key, entry] of state.idempotency) {
    if (asOfMs - entry.at > ttlMs) expiredIdempotencyKeys.push(key)
  }
  const snapshot = disk.snapshot ? JSON.parse(JSON.stringify(disk.snapshot)) : null
  const exportedState = stateToObject(state, asOfMs, true)
  const genesis = records.find((item) => item.rec.kind === 'GENESIS')?.rec ?? null

  return {
    format: PITR_PACKAGE_FORMAT,
    packageVersion: 1,
    asOf: matchingCommitAt,
    ttlMs,
    snapshot,
    snapshotChecksum: snapshot ? sha256Hex(canonicalJSON(snapshot)) : null,
    log: buffer.slice(0, matchingCommit.bytes).toString('utf8'),
    anchor: {
      epoch: disk.epoch,
      genesisHash: genesis?.hash ?? null,
      prevEpochTip: disk.snapshot?.tipHash ?? ZERO_HASH,
      prevEpochRecords: disk.snapshot?.records ?? 0,
    },
    truncation: {
      entries,
      tipHash: matchingCommit.rec.hash,
      commitSeq: matchingCommit.rec.seq,
      group: matchingCommit.rec.data.group,
      logBytes: matchingCommit.bytes,
    },
    state: exportedState,
    idempotency: {
      ttlMs,
      expiredAtAsOf: expiredIdempotencyKeys.sort(),
      policy: 'expired idempotency records are excluded from effective state by TTL but are not rewritten out of the v2 chain',
    },
  }
}

function validateAndReplayBackup(pkg) {
  if (!pkg || typeof pkg !== 'object' || pkg.format !== PITR_PACKAGE_FORMAT) {
    throw new PitrExportError(400, 'pitr-invalid-package', 'unsupported PITR backup format')
  }
  if (pkg.packageChecksum) {
    const copy = { ...pkg }
    delete copy.packageChecksum
    if (sha256Hex(canonicalJSON(copy)) !== pkg.packageChecksum) {
      throw new PitrExportError(400, 'pitr-invalid-package', 'backup package checksum is invalid')
    }
  }
  if (typeof pkg.asOf !== 'number' || !Number.isFinite(pkg.asOf)) {
    throw new PitrExportError(400, 'pitr-invalid-package', 'PITR backup asOf is invalid')
  }
  if (typeof pkg.log !== 'string' || pkg.log.length === 0) {
    throw new PitrExportError(400, 'pitr-invalid-package', 'PITR backup log is missing')
  }
  const ttlMs = typeof pkg.ttlMs === 'number' ? pkg.ttlMs : IDEMPOTENCY_TTL_MS
  const state = pkg.snapshot ? stateFromSnapshot(pkg.snapshot) : freshState()
  let expectedSeq = 1
  let expectedHash = ZERO_HASH
  let entries = pkg.snapshot ? pkg.snapshot.records : 0
  let epoch = pkg.snapshot ? pkg.snapshot.epoch : 0
  let pendingOps = null
  let commitCount = 0
  let lastCommit = null

  const rawLines = pkg.log.split('\n')
  const lines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
  for (const line of lines) {
    const rec = decodeLine(line)
    if ((rec.v ?? 1) !== 2 || rec.seq !== expectedSeq || rec.prevHash !== expectedHash || rec.epoch !== epoch) {
      throw new PitrExportError(400, 'pitr-invalid-package', 'backup log hash chain or anchor is invalid')
    }
    if (rec.kind === 'GENESIS') {
      if (entries !== (pkg.snapshot ? pkg.snapshot.records : 0)) {
        throw new PitrExportError(400, 'pitr-invalid-package', 'GENESIS is not at the exported segment start')
      }
      if (pkg.snapshot) {
        if (
          rec.data.snapshotId !== pkg.snapshot.snapshotId ||
          rec.data.prevEpochTip !== pkg.snapshot.tipHash ||
          rec.data.prevEpochRecords !== pkg.snapshot.records
        ) {
          throw new PitrExportError(400, 'pitr-invalid-package', 'GENESIS does not anchor to the snapshot')
        }
      } else if (rec.data.epoch !== 0 || rec.data.snapshotId !== undefined) {
        throw new PitrExportError(400, 'pitr-invalid-package', 'primal GENESIS is invalid')
      }
    } else if (rec.kind === 'APPLY') {
      pendingOps ??= []
      pendingOps.push(rec.data.op)
    } else if (rec.kind === 'COMMIT') {
      if (!pendingOps || rec.data.n !== pendingOps.length || rec.data.n === 0) {
        throw new PitrExportError(400, 'pitr-invalid-package', 'COMMIT group is incomplete')
      }
      applyOps(state, pendingOps)
      pendingOps = null
      commitCount += 1
      lastCommit = rec
    } else if (rec.kind === 'MIGRATE') {
      if (!pkg.snapshot || rec.data.from !== 1 || rec.data.to !== 2) {
        throw new PitrExportError(400, 'pitr-invalid-package', 'MIGRATE anchor is invalid')
      }
    } else {
      throw new PitrExportError(400, 'pitr-invalid-package', `unsupported record kind ${rec.kind}`)
    }
    entries += 1
    expectedSeq = rec.seq + 1
    expectedHash = rec.hash
  }

  if (!lastCommit || commitCount === 0 || lastCommit.hash !== pkg.truncation?.tipHash) {
    throw new PitrExportError(400, 'pitr-invalid-package', 'backup does not end at a COMMIT boundary')
  }
  if (pkg.truncation.entries !== entries || pkg.truncation.commitSeq !== lastCommit.seq) {
    throw new PitrExportError(400, 'pitr-invalid-package', 'backup truncation anchor is invalid')
  }
  const expectedState = stateToObject(state, pkg.asOf, true)
  if (pkg.state && canonicalJSON(pkg.state) !== canonicalJSON(expectedState)) {
    throw new PitrExportError(400, 'pitr-invalid-package', 'backup state is not reproducible from its log')
  }
  return { state: expectedState, entries, tipHash: lastCommit.hash, ttlMs }
}

export function restorePackageIntoDir(dir, packageInput, { allowExisting = false } = {}) {
  let pkg
  try {
    pkg = typeof packageInput === 'string' ? JSON.parse(readFileSync(packageInput, 'utf8')) : packageInput
  } catch (error) {
    throw new PitrExportError(400, 'pitr-invalid-package', `backup package is not valid JSON: ${error.message}`)
  }
  const replay = validateAndReplayBackup(pkg)
  mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir).filter((name) => name !== LOCK_DIR)
  if (!allowExisting && existing.length > 0) {
    throw new PitrExportError(409, 'pitr-restore-dir-not-empty', 'restore requires a new empty data directory')
  }
  let writtenSnapshot = pkg.snapshot
  if (pkg.snapshot) {
    const checksum = sha256Hex(canonicalJSON(pkg.snapshot))
    if (pkg.snapshotChecksum && pkg.snapshotChecksum !== checksum) {
      throw new PitrExportError(400, 'pitr-invalid-package', 'snapshot checksum is invalid')
    }
    if (pkg.snapshot.format !== SNAPSHOT_FORMAT_V2) {
      throw new PitrExportError(400, 'pitr-invalid-package', 'restored snapshot must be v2')
    }
    const snapshotFile = `${canonicalJSON(pkg.snapshot)}\n${checksum}\n`
    writeFileSync(join(dir, SNAPSHOT_FILE), snapshotFile)
  }
  writeFileSync(join(dir, LOG_FILE), pkg.log)
  fsyncFile(join(dir, LOG_FILE))
  if (pkg.snapshot) fsyncFile(join(dir, SNAPSHOT_FILE))
  fsyncDir(dir)
  return replay
}

export class FileStore extends MemoryStore {
  /**
   * @param {string} dir 数据目录（不存在则创建）
   * @param {object} [opts]
   * @param {number} [opts.snapshotEveryLines] 日志每多少行触发一次快照压缩
   * @param {number} [opts.snapshotEveryBytes] 日志累计写字节触发阈值
   * @param {number} [opts.formatVersion] 写入格式版本（默认 2；1 仅用于测试夹具生成 v1 数据）
   * @param {'auto'|'leader'|'follower'} [opts.role] auto=能拿锁则 leader 否则 follower
   * @param {number} [opts.lockStaleMs] 心跳停摆多久后锁可被接管
   * @param {number} [opts.heartbeatMs] leader 心跳间隔
   * @param {number} [opts.followerPollMs] follower 轮询跟随间隔
   * @param {function} [opts.logger]
   * @param {object} [opts.faults] 测试故障注入（命中一次即失效）
   */
  constructor(dir, opts = {}) {
    super()
    this.dir = dir
    this.logPath = join(dir, LOG_FILE)
    this.snapshotPath = join(dir, SNAPSHOT_FILE)
    this.tmpSnapshotPath = join(dir, `.${SNAPSHOT_FILE}.tmp`)
    this.lockDirPath = join(dir, LOCK_DIR)
    this.snapshotEveryLines = opts.snapshotEveryLines ?? DEFAULT_SNAPSHOT_EVERY_LINES
    this.snapshotEveryBytes = opts.snapshotEveryBytes ?? DEFAULT_SNAPSHOT_EVERY_BYTES
    this.formatVersion = opts.formatVersion ?? LOG_FORMAT_VERSION
    this.requestedRole = opts.role ?? 'auto'
    this.lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.followerPollMs = opts.followerPollMs ?? DEFAULT_FOLLOWER_POLL_MS
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
    this.lastCommitAt = null
    this.fd = null
    this.role = 'follower'
    this.diskVersion = null // 磁盘数据当前的格式版本（1|2）
    this.migrations = [] // 链上格式迁移事件（来自 replay / 本实例迁移）
    this.lockToken = null
    this.lockAcquiredAt = null
    this.heartbeatTimer = null
    this.pollTimer = null

    mkdirSync(dir, { recursive: true })
    if (opts.restorePackage) {
      restorePackageIntoDir(dir, opts.restorePackage, { allowExisting: opts.allowRestoreIntoExisting === true })
    }
    if (this.requestedRole !== 'follower' && this._tryAcquireLock()) {
      this.role = 'leader'
      this._adjudicateMigration()
      this._recover()
      if (this.persistent && this.formatVersion >= 2 && this.diskVersion === 1) {
        // v1 旧数据：启动即在线迁移为 v2（崩溃安全见 _adjudicateMigration）
        this._migrateToV2()
      }
    } else {
      if (this.requestedRole === 'leader') {
        throw new Error('leader lock is held by another instance')
      }
      this.role = 'follower'
      this._recoverFollower()
    }
  }

  get isPersistent() {
    return this.persistent
  }

  get readOnly() {
    return this.role === 'follower'
  }

  close() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.role !== 'leader') return // follower 不持有任何写资源
    this._flush()
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd)
      } catch {
        // fd 可能已在降级时关闭
      }
      closeSync(this.fd)
      this.fd = null
    }
    this._releaseLock()
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

  // ---------- 单写者锁（目录锁 + 心跳） ----------
  /**
   * mkdir 原子占位：成功者唯一。已存在则读 lock.json 判断陈旧：
   * 心跳停摆超 lockStaleMs 或 pid 已死亡 → rename 原子认领（认领动作本身
   * 只有一个赢家），随后重试 mkdir；mkdir 仍失败说明被他人抢先，退 follower。
   */
  _tryAcquireLock() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(this.lockDirPath)
        this.lockToken = randomUUID()
        this.lockAcquiredAt = Date.now()
        this._writeLockMeta()
        this.heartbeatTimer = setInterval(() => this._writeLockMeta(), this.heartbeatMs)
        if (this.heartbeatTimer.unref) this.heartbeatTimer.unref()
        return true
      } catch (error) {
        if (error.code !== 'EEXIST') {
          // 目录不可写等：auto 模式退为只读 follower（读路径不需要锁）
          if (this.requestedRole === 'leader') throw error
          this._logWarn('lock-unavailable', { error: String(error?.message ?? error) })
          return false
        }
        if (attempt === 0 && this._tryTakeoverStaleLock()) continue
        return false
      }
    }
    return false
  }

  _writeLockMeta() {
    if (!this.lockToken) return
    try {
      const meta = {
        pid: process.pid,
        token: this.lockToken,
        acquiredAt: this.lockAcquiredAt,
        heartbeatAt: Date.now(),
      }
      const tmpPath = join(this.lockDirPath, `.lock.json.${process.pid}.tmp`)
      writeFileSync(tmpPath, JSON.stringify(meta))
      renameSync(tmpPath, join(this.lockDirPath, 'lock.json'))
    } catch {
      // 心跳失败不致命（锁目录被外部清理等）：下次心跳再试
    }
  }

  _readLockMeta() {
    try {
      const meta = JSON.parse(readFileSync(join(this.lockDirPath, 'lock.json'), 'utf8'))
      if (meta && typeof meta.heartbeatAt === 'number') return meta
    } catch {
      // 锁目录存在但元数据缺失/损坏：交由调用方按目录年龄裁决
    }
    return null
  }

  _tryTakeoverStaleLock() {
    const now = Date.now()
    const meta = this._readLockMeta()
    let stale
    if (meta) {
      stale = now - meta.heartbeatAt > this.lockStaleMs || !pidAlive(meta.pid)
    } else {
      // 无有效元数据：可能是他人 mkdir 后尚未写 lock.json 的窗口，
      // 只有目录本身也超过 lockStaleMs 未更新才允许认领，防误杀新 leader
      try {
        stale = now - statSync(this.lockDirPath).mtimeMs > this.lockStaleMs
      } catch {
        stale = false
      }
    }
    if (!stale) return false
    // rename 原子认领：并发接管者只有一个成功；输家下次循环看到新锁退 follower
    const orphanPath = `${this.lockDirPath}.orphan-${process.pid}-${now}`
    try {
      renameSync(this.lockDirPath, orphanPath)
    } catch {
      return false
    }
    try {
      rmSync(orphanPath, { recursive: true, force: true })
    } catch {
      // 孤儿清理失败不影响锁获取
    }
    return true
  }

  _releaseLock() {
    // 只释放自己持有的锁（token 匹配）：锁被他人接管后不得误删新锁
    try {
      const meta = this._readLockMeta()
      if (meta && meta.token !== this.lockToken) return
      if (!meta) return
      rmSync(this.lockDirPath, { recursive: true, force: true })
    } catch {
      // 释放失败留下的是陈旧锁，由 stale 接管路径兜底
    }
    this.lockToken = null
  }

  /** 模拟进程当场死亡：停心跳、释放锁、丢 fd（真实崩溃的进程内模拟） */
  _simulateProcessDeath() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    try {
      rmSync(this.lockDirPath, { recursive: true, force: true })
    } catch {
      // 忽略
    }
    this.lockToken = null
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // fd 可能已失效
      }
      this.fd = null
    }
    this.staged = []
  }

  // ---------- follower：只读回放 + 轮询跟随 ----------
  _recoverFollower() {
    try {
      this._adoptDiskState(replayFromDisk(this.dir))
    } catch (error) {
      // 磁盘暂不可读（leader 迁移窗口等）：以空状态启动，轮询自愈
      this._logWarn('follower-initial-replay-failed', { error: String(error?.message ?? error) })
    }
    this.pollTimer = setInterval(() => this.refresh(), this.followerPollMs)
    if (this.pollTimer.unref) this.pollTimer.unref()
  }

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
    this.lastCommitAt = disk.lastCommitAt
    this.logBytes = disk.validBytes
    this.migrations = disk.migrations
  }

  /**
   * follower 增量跟随：重放磁盘并在链尖前进时热切换内存态。
   * 读到撕裂/混杂（leader 正在写或迁移）时跳过本轮，下轮收敛；
   * 全程只读文件，绝不阻塞 leader 写路径。
   */
  refresh() {
    if (this.role !== 'follower') return false
    let disk
    try {
      disk = replayFromDisk(this.dir)
    } catch {
      return false
    }
    if (disk.truncated || disk.formatConflict || disk.anomalies.length > 0) return false
    if (disk.tipHash === this.tipHash && disk.entries === this.totalRecords) return false
    this._adoptDiskState(disk)
    return true
  }

  async exportAt(asOfMs, { catchUpTimeoutMs = 2_000 } = {}) {
    if (!this.persistent) {
      throw new PitrExportError(409, 'pitr-persistence-unavailable', 'point-in-time export requires a persistent store')
    }
    if (typeof asOfMs !== 'number' || !Number.isFinite(asOfMs)) {
      throw new PitrExportError(400, 'pitr-invalid-as-of', 'asOf must be a millisecond timestamp')
    }

    if (this.role === 'follower') await this.waitForLeaderCatchUp(catchUpTimeoutMs)
    const backup = readExportPoint(this.dir, asOfMs)
    const checksum = sha256Hex(canonicalJSON(backup))
    return { ...backup, packageChecksum: checksum }
  }

  async waitForLeaderCatchUp(timeoutMs = 2_000) {
    if (this.role !== 'follower') return true
    const deadline = Date.now() + timeoutMs
    let previousTip = null
    for (;;) {
      this.refresh()
      let disk
      try {
        disk = replayFromDisk(this.dir)
      } catch {
        disk = null
      }
      const stable =
        disk &&
        !disk.truncated &&
        !disk.formatConflict &&
        disk.anomalies.length === 0 &&
        disk.tipHash !== ZERO_HASH &&
        disk.tipHash === this.tipHash &&
        disk.tipHash === previousTip
      if (stable) return true
      previousTip = disk?.tipHash ?? null
      if (Date.now() >= deadline) {
        throw new PitrExportError(503, 'pitr-follower-behind', 'follower has not caught up with the leader')
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
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

    // 混杂态只能由 _adjudicateMigration 先行修复；到这里仍混杂 = 无法裁决，拒绝启动
    if (disk.formatConflict) {
      throw new Error('log recovery failed: snapshot/log format version conflict')
    }
    const diskVersion = disk.logVersion ?? disk.snapshotVersion ?? null
    if (diskVersion !== null && diskVersion > this.formatVersion) {
      throw new Error(`log recovery failed: format v${diskVersion} is newer than supported v${this.formatVersion}`)
    }
    this.diskVersion = diskVersion ?? this.formatVersion

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
        // 有快照时创世版本与快照一致（迁移会随后整体升级），否则按本实例写入版本
        const genesisVersion = disk.snapshot ? disk.snapshotVersion : this.formatVersion
        const genesis = disk.snapshot
          ? genesisRecord(disk.epoch, {
              snapshotId: disk.snapshot.snapshotId,
              prevEpochTip: disk.snapshot.tipHash,
              prevEpochRecords: disk.snapshot.records,
            }, genesisVersion)
          : genesisRecord(0, {}, genesisVersion)
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
  _stage(op) {
    this.staged.push(op)
  }

  _assertWritable() {
    if (this.readOnly) throw new ReadOnlyStoreError()
  }

  /** 临界区末尾钩子（MemoryStore 无此方法 → 无副作用） */
  afterCriticalSection() {
    if (this.readOnly) return
    this._flush()
  }

  /** createSession 不在 withSidLock 内（sid 尚不存在），由 app 层显式调用 */
  flushPending() {
    if (this.readOnly) return
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
    super.touchSession(session, nowMs)
    // follower：会话触碰属临时元数据，只更新内存、不落盘（读请求不算写）
    if (!this.readOnly) this._stage({ t: 'session-upsert', sid: session.sid, session: clone(session) })
  }

  noteClock(session, { currentDayKey, nowMs }) {
    // 与 MemoryStore.noteClock 逐分支一致，但在活工作副本上变更后整体暂存
    if (!session.maxObservedDayKey || currentDayKey > session.maxObservedDayKey) {
      session.maxObservedDayKey = currentDayKey
    }
    if (nowMs < session.maxObservedMs) session.clockAnomaly = true
    if (nowMs > session.maxObservedMs) session.maxObservedMs = nowMs
    session.lastSeenAt = nowMs
    if (!this.readOnly) this._stage({ t: 'session-upsert', sid: session.sid, session: clone(session) })
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
      }
      if (this.formatVersion >= 2) applyRec.v = this.formatVersion
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
    }
    if (this.formatVersion >= 2) commitRec.v = this.formatVersion
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
      // 模拟进程死亡：释放锁与 fd（旧实例不再参与任何后续写），避免该
      // 实例被测试继续使用时重复 flush 同一条事务或继续持有 leader 锁。
      this._simulateProcessDeath()
      throw new SimulatedCrash('log-written-memory-not-committed')
    }

    this.seq = chainSeq
    this.tipHash = commitRec.hash
    this.lastCommitAt = commitTimeOfOps(ops)
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
    const nextEpoch = this.epoch + 1
    const snapshotId = `snap-${nextEpoch}-${this.tipHash.slice(0, 16)}`
    const snapshot = {
      format: this.formatVersion >= 2 ? SNAPSHOT_FORMAT_V2 : SNAPSHOT_FORMAT_V1,
      epoch: nextEpoch,
      snapshotId,
      createdAt: Date.now(),
      tipHash: this.tipHash,
      tipKind: 'commit',
      tipAt: this.lastCommitAt ?? null,
      records: this.totalRecords,
      genesisHash: null,
      state: this._dumpState(Date.now(), false),
    }
    const genesis = genesisRecord(nextEpoch, {
      snapshotId,
      prevEpochTip: this.tipHash,
      prevEpochRecords: this.totalRecords,
    }, this.formatVersion)
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
      this._simulateProcessDeath()
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

  // ---------- 存储格式 v1 → v2 在线迁移 ----------
  /**
   * 迁移 = 以 v1 链尖为锚的 v2 快照压缩 + 链上 MIGRATE 记录：
   *   snapshot.json(v2, tipHash=v1Tip) + events.log(v2: GENESIS, MIGRATE)
   * 提交点 = events.log 首条记录变为 v2；v1 原文件保留为 *.v1.bak 审计轨迹。
   * 崩溃窗口全部由 _adjudicateMigration 在下次启动裁决（回滚 v1 或补完 v2）。
   */
  _migrateToV2() {
    const v1Epoch = this.epoch
    const v1Tip = this.tipHash
    const v1Records = this.totalRecords
    const nextEpoch = v1Epoch + 1
    const snapshotId = `snap-${nextEpoch}-${v1Tip.slice(0, 16)}`
    const genesis = genesisRecord(nextEpoch, {
      snapshotId,
      prevEpochTip: v1Tip,
      prevEpochRecords: v1Records,
    }, 2)
    const migrateRec = {
      v: 2,
      seq: 2,
      kind: 'MIGRATE',
      prevHash: genesis.hash,
      hash: null,
      epoch: nextEpoch,
      data: {
        t: 'format-migration',
        from: 1,
        to: 2,
        at: Date.now(),
        v1Epoch,
        v1TipHash: v1Tip,
        v1Records,
      },
    }
    migrateRec.hash = hashRecord(migrateRec)
    const snapshot = {
      format: SNAPSHOT_FORMAT_V2,
      epoch: nextEpoch,
      snapshotId,
      createdAt: Date.now(),
      tipHash: v1Tip,
      tipKind: 'v1-commit',
      tipAt: this.lastCommitAt,
      records: v1Records,
      genesisHash: genesis.hash,
      state: this._dumpState(Date.now(), false),
    }
    const snapshotFile = `${canonicalJSON(snapshot)}\n${sha256Hex(canonicalJSON(snapshot))}\n`
    const logFile = encodeRecord(genesis) + encodeRecord(migrateRec)

    const tmpLog = join(this.dir, TMP_V2_LOG)
    const tmpSnapshot = join(this.dir, TMP_V2_SNAPSHOT)
    // 迁移期间不追加：先关 fd，完成后以新日志重开
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // fd 失效不阻断迁移
      }
      this.fd = null
    }
    writeFileSync(tmpSnapshot, snapshotFile)
    fsyncFile(tmpSnapshot)
    writeFileSync(tmpLog, logFile)
    fsyncFile(tmpLog)
    // 提交序列：v1 改名备份 → v2 落位（任何中间点崩溃都可裁决，见类注释）
    renameSync(this.logPath, join(this.dir, LOG_V1_BACKUP))
    try {
      renameSync(this.snapshotPath, join(this.dir, SNAPSHOT_V1_BACKUP))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    renameSync(tmpLog, this.logPath)
    renameSync(tmpSnapshot, this.snapshotPath)
    fsyncDir(this.dir)
    this.fd = openSync(this.logPath, 'a')
    fsyncSync(this.fd)

    this.epoch = nextEpoch
    this.seq = 2
    this.tipHash = migrateRec.hash
    this.totalRecords = v1Records + 2
    this.logBytes = Buffer.byteLength(logFile)
    this.diskVersion = 2
    this.migrations = [{
      seq: 2,
      at: migrateRec.data.at,
      from: 1,
      to: 2,
      v1TipHash: v1Tip,
      v1Records,
    }]
    this._logWarn('format-migrated', { from: 1, to: 2, v1TipHash: v1Tip, v1Records })
  }

  /**
   * 启动裁决（leader 拿锁后、_recover 前）：把迁移崩溃窗口收敛到可判定状态。
   * - events.log 缺失但 v1 备份在 → 崩溃于“v1 已改名、v2 未落位”：完整回滚 v1；
   * - events.log 已是 v2 → 已越过提交点：补装 v2 快照（若尚未替换）即完成；
   * - 其余（纯 v1 / 全新目录）→ 清理未遂临时文件，交给正常恢复/迁移流程。
   */
  _adjudicateMigration() {
    const logBackup = join(this.dir, LOG_V1_BACKUP)
    const snapshotBackup = join(this.dir, SNAPSHOT_V1_BACKUP)
    const tmpLog = join(this.dir, TMP_V2_LOG)
    const tmpSnapshot = join(this.dir, TMP_V2_SNAPSHOT)
    if (!existsSync(this.logPath) && existsSync(logBackup)) {
      try {
        renameSync(logBackup, this.logPath)
      } catch {
        // 回滚失败则保持现状：replay 按空日志 + 快照处理，verify 会报异常
      }
      if (!existsSync(this.snapshotPath) && existsSync(snapshotBackup)) {
        try {
          renameSync(snapshotBackup, this.snapshotPath)
        } catch {
          // 同上
        }
      }
      rmSync(tmpLog, { force: true })
      rmSync(tmpSnapshot, { force: true })
      return
    }
    if (existsSync(this.logPath) && this._logHeadVersion() === 2) {
      if (existsSync(tmpSnapshot)) {
        const current = readSnapshot(this.snapshotPath)
        if (current.status !== 'ok' || current.version !== 2) {
          try {
            renameSync(tmpSnapshot, this.snapshotPath)
          } catch {
            // 补装失败：replay 会报 snapshot-log-format-mismatch，verify 判负可裁决
          }
        } else {
          rmSync(tmpSnapshot, { force: true })
        }
      }
      rmSync(tmpLog, { force: true })
      return
    }
    rmSync(tmpLog, { force: true })
    rmSync(tmpSnapshot, { force: true })
  }

  /** 日志首条记录的格式版本（无法解析视为 v1；空/缺失返回 null） */
  _logHeadVersion() {
    try {
      const buffer = readFileSync(this.logPath)
      const lineEnd = buffer.indexOf(0x0a)
      if (lineEnd <= 0) return null
      const rec = decodeLine(buffer.slice(0, lineEnd).toString('utf8'))
      return rec.v ?? 1
    } catch {
      return null
    }
  }

  // ---------- 审计 ----------
  /** 规范化可比较状态（剔除已过期幂等键，避免 TTL 造成伪分叉） */
  _dumpState(nowMs = Date.now(), pruneTtl = true) {
    const idempotency = {}
    for (const [key, entry] of this.idempotency) {
      if (!pruneTtl || nowMs - entry.at <= IDEMPOTENCY_TTL_MS) idempotency[key] = entry
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
    // follower 先跟上 leader 最新提交再校验（不重启观察新提交的审计语义）
    if (this.role === 'follower') this.refresh()
    if (!this.persistent) {
      // 降级态：磁盘不再追加，无法持续审计；明确透出而非伪装 ok
      return {
        ok: false,
        persistent: false,
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
    let ok = !disk.truncated && !disk.formatConflict
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
      entries: disk.entries,
      tipHash: disk.tipHash,
      firstBrokenSeq: disk.firstBrokenSeq,
      anomalies,
      format: disk.logVersion ?? disk.snapshotVersion ?? this.diskVersion ?? this.formatVersion,
      migrations: disk.migrations,
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
