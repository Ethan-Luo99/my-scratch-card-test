/**
 * H 类持久化与防篡改审计验收（设计补充章节：FileStore + WAL + 哈希链 + 快照）：
 * H1  写 N 条后同日志文件重建 FileStore，内存状态逐字段一致；
 * H2  尾行截断 / 注入损坏行：停在最后有效记录、truncation-anomaly、后续写入正常；
 * H3  重启后旧 Idempotency-Key 重放 begin：首次响应、不重复扣费；
 * H4  篡改中间记录：/api/audit/verify 报首个断点 seq；
 * H5  两个崩溃窗口（日志 durable 后 ack 丢失 / 内存推进后日志未 durable）恢复后
 *     无重复扣费、无丢失承诺（WAL redo 语义）；
 * H6  存储工厂抛错/运行期磁盘故障：退化内存继续服务，isPersistent=false 可观测；
 * H7  快照截断后哈希链从新创世重建，verify 全量可校验，状态与日志一致；
 * H8  边界：承诺事件先于任何含 seed 的记录；claimsLedger 不丢；回拨基线不回退；
 *     快照/日志轮换中途崩溃（快照在、旧日志未轮换）可恢复。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createServerApp } from '../../server/http/app.js'
import { createSigner } from '../../server/core/rng.js'
import { createDefaultConfig } from '../../server/core/config.js'
import { FileStore } from '../../server/store/file.js'
import { MemoryStore } from '../../server/store/memory.js'
import { createStore } from '../../server/store/factory.js'

const START_MS = Date.UTC(2026, 8, 24, 2, 0, 0)

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'scratch-persist-'))
}

/**
 * 可重启的持久化 harness：同一个 dir 反复构造 FileStore + HTTP app，
 * 模拟 dev server 重启；signer/config 保持一致（密钥等价延续）。
 */
function makePersistentHarness(dir, { clock: injectedClock, storeOptions = {} } = {}) {
  let current = START_MS
  const clock = injectedClock ?? { now: () => current, set: (ms) => { current = ms } }
  const signer = createSigner()
  const config = createDefaultConfig()
  const faults = []
  const logs = []

  function boot(extra = {}) {
    const store = new FileStore({
      dir,
      onFault: (kind, detail) => faults.push({ kind, detail }),
      ...storeOptions,
      ...extra,
    })
    const handler = createServerApp({
      clock: clock.now,
      store,
      signer,
      config,
      logger: (entry) => logs.push(entry),
    })
    const server = createServer(handler)
    return {
      store,
      handler,
      server,
      listen: () =>
        new Promise((resolve) => {
          server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
        }),
      close: () =>
        new Promise((resolve) => {
          server.close(() => {
            store.close()
            resolve()
          })
        }),
    }
  }

  let node = boot()
  let basePromise

  async function request(method, path, { body, headers = {}, raw } = {}) {
    const base = await (basePromise ??= node.listen())
    const hasPayload = method !== 'GET' && (raw !== undefined || body !== undefined)
    const result = await fetch(new URL(path, base), {
      method,
      headers: { ...(hasPayload ? { 'content-type': 'application/json' } : {}), ...headers },
      body: hasPayload ? (raw ?? JSON.stringify(body)) : undefined,
    })
    const text = await result.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: result.status, headers: result.headers, body: json }
  }

  async function restart(extra = {}) {
    await new Promise((resolve) => node.server.close(resolve))
    node.store.close()
    basePromise = null
    node = boot(extra)
  }

  async function createSession() {
    const response = await request('POST', '/api/session', { body: {} })
    const cookie = response.headers.get('set-cookie')
    const sid = /(?:^| )sid=([^;]+)/.exec(cookie)[1]
    return { sid, cookie: `sid=${sid}`, body: response.body }
  }

  const uuidCounter = { n: 0 }
  function idemKey() {
    uuidCounter.n += 1
    return `key-${uuidCounter.n}`
  }

  return {
    dir,
    clock,
    signer,
    config,
    faults,
    logs,
    boot,
    request,
    restart,
    createSession,
    idemKey,
    get store() {
      return node.store
    },
    async shutdown() {
      await new Promise((resolve) => node.server.close(resolve))
      node.store.close()
    },
  }
}

function stableDump(store) {
  return {
    sessions: Object.fromEntries(store.sessions),
    days: Object.fromEntries(store.days),
    cards: Object.fromEntries(store.cards),
    idempotency: Object.fromEntries(store.idempotency),
    claimsLedger: [...store.claimsLedger].sort(),
    meta: Object.fromEntries(store.meta),
    events: store.events,
  }
}

// ---------- H1：回放后逐字段一致 ----------
test('H1 写入多条业务后用同一日志重建 FileStore，全部内存状态逐字段一致', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir)
  after(() => h.shutdown())

  const { cookie } = await h.createSession()
  const key1 = h.idemKey()
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key1 },
  })
  assert.equal(begin.status, 200)
  assert.equal(begin.body.ok, true)
  const key2 = h.idemKey()
  const reveal = await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key2 },
  })
  assert.equal(reveal.body.card.status, 'revealed')
  const key3 = h.idemKey()
  await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key3 },
  })
  // 第二张卡仍 pending，覆盖不同状态
  const key4 = h.idemKey()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': key4 },
  })

  const before = stableDump(h.store)
  await h.restart()
  const afterState = stableDump(h.store)

  assert.deepEqual(afterState, before, '回放状态必须逐字段一致（含秘密卡记录/幂等缓存/事件）')
  assert.equal(h.store.claimsCount, 1)
  assert.equal(h.store.getDay(h.store.sessions.keys().next().value, 'daily', '2026-09-24').chancesUsed, 2)

  const verify = await h.request('GET', '/api/audit/verify')
  assert.equal(verify.status, 200)
  assert.equal(verify.body.ok, true, '干净重启后审计必须通过')
  assert.equal(verify.body.persistent, true)
  assert.ok(verify.body.entries >= before.events.length)
  assert.deepEqual(verify.body.anomalies, [])
})

// ---------- H2：截断/注入容错 ----------
test('H2a 日志尾行截断：停在最后完整有效记录、标记 truncation-anomaly、后续写入正常追加', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir)
  after(() => h.shutdown())

  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const eventsBefore = h.store.events.length
  await h.shutdown()

  // 砍掉最后若干字节，制造"半行"
  const logPath = join(dir, 'events.log')
  const bytes = readFileSync(logPath)
  writeFileSync(logPath, bytes.subarray(0, bytes.length - 12))

  const h2 = makePersistentHarness(dir)
  after(() => h2.shutdown())
  assert.ok(h2.faults.some((f) => f.kind === 'anomaly'), '截断必须被标记为异常')
  // begin 事务落盘顺序：…commitment-created → day → card → pending-stored
  // → idem。砍掉末 12 字节恰好打断最后一条（idem）：三个事件完整、
  // 幂等缓存缺失——精确停在最后一条完整有效记录。
  assert.deepEqual(
    h2.store.events.map((e) => e.type),
    ['session-created', 'commitment-created', 'pending-stored'],
  )
  assert.ok(eventsBefore === 3)
  assert.equal(h2.store.idempotency.size, 0, '被截断的尾行不回放')

  // 后续写入正常追加，新链连续
  const { cookie: cookie2 } = await h2.createSession()
  const begin = await h2.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie: cookie2, 'idempotency-key': h2.idemKey() },
  })
  assert.equal(begin.status, 200)
  assert.equal(begin.body.ok, true)

  // 再次重启：修复后的日志可干净回放，仅保留一次性的历史异常记录
  await h2.restart()
  const verify = await h2.request('GET', '/api/audit/verify')
  assert.equal(verify.body.ok, true, '修复并续写后审计应恢复为 ok')
  assert.deepEqual(verify.body.anomalies, [])
})

test('H2b 在中间注入垃圾行：回放停在垃圾之前，垃圾之后的有效行被截断，续写后链可继续', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir)
  after(() => h.shutdown())

  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const eventsBefore = h.store.events.length
  await h.shutdown()

  const logPath = join(dir, 'events.log')
  const lines = readFileSync(logPath, 'utf8').split('\n')
  // 在最后一条业务行（pending-stored）之前插入垃圾行：
  // 垃圾之后的所有有效行都必须被视为"尾后内容"截断丢弃
  let lastBusiness = lines.length - 1
  while (lastBusiness > 0 && lines[lastBusiness] === '') lastBusiness -= 1
  assert.ok(lastBusiness > 1)
  lines.splice(lastBusiness, 0, 'GARBAGE-INJECTED-NOT-JSON{"oops":1')
  writeFileSync(logPath, lines.join('\n'))

  const h2 = makePersistentHarness(dir)
  after(() => h2.shutdown())
  assert.equal(h2.store.events.length, eventsBefore, '必须停在垃圾之前最后一条有效记录')
  assert.ok(
    h2.faults.some((f) => f.kind === 'anomaly' && JSON.stringify(f).includes('truncation-anomaly')),
    '标记 truncation-anomaly',
  )

  // 续写一条，重启后全部可回放（垃圾已被原子截断清除）
  const { cookie: cookie2 } = await h2.createSession()
  const begin = await h2.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-2' },
    headers: { cookie: cookie2, 'idempotency-key': h2.idemKey() },
  })
  assert.equal(begin.body.ok, true)
  await h2.restart()
  const verify = await h2.request('GET', '/api/audit/verify')
  assert.equal(verify.body.ok, true)
})

// ---------- H3：重启后旧 Idempotency-Key 重放 begin ----------
test('H3 重启后用同一 Idempotency-Key 重放 begin：返回首次响应、不重复扣费', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir)
  after(() => h.shutdown())

  const { sid, cookie } = await h.createSession()
  const key = h.idemKey()
  const first = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(first.body.ok, true)
  const firstCommitment = first.body.card.commitment
  const chancesAfterFirst = first.body.chancesLeft
  await h.restart()

  const replay = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.card.commitment, firstCommitment, '重放必须返回首次承诺')
  assert.equal(replay.body.chancesLeft, chancesAfterFirst, '重放绝不二次扣费')
  const day = h.store.getDay(sid, 'daily', '2026-09-24')
  assert.equal(day.chancesUsed, 1, '账本上仍只扣一次')

  // 换一个新 key 再 begin 同一张当日已建卡：已是 pending，复用承诺、也不扣费
  const another = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(another.body.ok, false)
  assert.equal(another.body.reason, 'already-pending')
  assert.equal(h.store.getDay(sid, 'daily', '2026-09-24').chancesUsed, 1)
})

// ---------- H4：篡改中间记录，verify 报首个断点 ----------
test('H4 篡改日志中间任意一条记录：/api/audit/verify 报告首个断点 seq，ok=false', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir)
  after(() => h.shutdown())

  const { cookie } = await h.createSession()
  for (const cardId of ['daily-1', 'daily-2', 'daily-3']) {
    await h.request('POST', '/api/campaigns/daily/scratch/begin', {
      body: { cardId },
      headers: { cookie, 'idempotency-key': h.idemKey() },
    })
  }
  const cleanVerify = await h.request('GET', '/api/audit/verify')
  assert.equal(cleanVerify.body.ok, true)
  const totalEntries = cleanVerify.body.entries

  await h.shutdown()
  const logPath = join(dir, 'events.log')
  const rawLines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)

  // 篡改第 3 条业务记录（索引跳过创世条目）：找到第一条 commitment-created
  const commitIdx = rawLines.findIndex((line) => line.includes('"t":"event"') && line.includes('commitment-created'))
  assert.ok(commitIdx > 0)
  const target = JSON.parse(rawLines[commitIdx])
  target.rec.e.day = '1999-01-01' // 篡改业务字段
  rawLines[commitIdx] = JSON.stringify(target)
  writeFileSync(logPath, rawLines.join('\n') + '\n')

  const h2 = makePersistentHarness(dir)
  after(() => h2.shutdown())
  // 回放在篡改处即停止：承诺事件之前只有 touch/clock/session 事件，
  // 扣费账本、卡记录、幂等缓存都尚未建立
  assert.deepEqual(
    h2.store.events.map((e) => e.type),
    ['session-created'],
    '停在被篡改的 commitment-created 处',
  )
  assert.equal(h2.store.days.size, 0)
  assert.equal(h2.store.cards.size, 0)
  assert.equal(h2.store.idempotency.size, 0)
  const verify = await h2.request('GET', '/api/audit/verify')
  assert.equal(verify.body.ok, false)
  assert.equal(verify.body.firstBrokenSeq, commitIdx, '断点 seq 必须精确指向被篡改记录')
  assert.ok(verify.body.entries < totalEntries)
  assert.ok(
    verify.body.anomalies.some((a) => a.kind === 'truncation-anomaly' || a.kind === 'hash-chain-broken'),
  )
})

// ---------- H5：两个崩溃窗口 ----------
test('H5a 窗口A：日志已 durable、ack 丢失——重启 redo，重试原 key 返回首次响应、不重复扣费', async () => {
  const dir = tempDir()
  // 仅在第一次 begin 的落盘完成后注入一次"ack 丢失"（抛错给客户端）
  let injected = false
  const h = makePersistentHarness(dir, {
    storeOptions: {
      faultAfterDurable: (ops) => {
        if (!injected && ops.some((op) => op.t === 'event' && op.e?.type === 'pending-stored')) {
          injected = true
          return new Error('SIMULATED ack lost after fsync')
        }
        return null
      },
    },
  })
  after(() => h.shutdown())

  const { sid, cookie } = await h.createSession()
  const key = h.idemKey()
  const first = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  // 客户端只看到 500（ack 丢失），但服务端日志已 durable
  assert.equal(first.status, 500)

  // 重启：WAL redo 重建幂等缓存 + 承诺 + 扣费账本
  await h.restart()
  assert.equal(h.store.getDay(sid, 'daily', '2026-09-24').chancesUsed, 1, 'redo 后扣费存在且仅一次')
  const card = h.store.latestCards(sid, 'daily').get('daily-1')
  assert.equal(card.status, 'pending')
  assert.ok(card.commitment, '承诺没有丢失')

  // 客户端用同一幂等键重试：拿到首次响应，不重复扣费
  const replay = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.card.commitment, card.commitment)
  assert.equal(h.store.getDay(sid, 'daily', '2026-09-24').chancesUsed, 1, '绝不重复扣费')

  const verify = await h.request('GET', '/api/audit/verify')
  assert.equal(verify.body.ok, true, 'redo 后日志链仍完整')
})

test('H5b 窗口B：内存已推进、日志写入失败——降级内存继续服务，不拒绝业务', async () => {
  const dir = tempDir()
  let injected = false
  const h = makePersistentHarness(dir, {
    storeOptions: {
      faultBeforeCommit: (ops) => {
        if (!injected && ops.some((op) => op.t === 'event' && op.e?.type === 'pending-stored')) {
          injected = true
          return Object.assign(new Error('SIMULATED disk quota ENOSPC'), { code: 'ENOSPC' })
        }
        return null
      },
    },
  })
  after(() => h.shutdown())

  const { cookie } = await h.createSession()
  // begin 在写日志前注入 ENOSPC：该请求仍应在降级内存模式下成功（绝不拒绝业务）
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(begin.status, 200, '磁盘故障不得拒绝业务请求')
  assert.equal(begin.body.ok, true)
  assert.equal(h.store.isPersistent, false, '已降级为内存模式')

  const health = await h.request('GET', '/api/healthz')
  assert.equal(health.body.isPersistent, false, 'healthz 透出 isPersistent=false')
  const recover = await h.request('POST', '/api/recover', { body: {}, headers: { cookie } })
  assert.equal(recover.status, 200)
  assert.equal(recover.body.isPersistent, false, '/api/recover 透出 isPersistent=false')

  // 同进程内继续业务，内存幂等缓存仍在：同 key 重放不重复扣费
  const key = h.idemKey()
  const second = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(second.body.ok, true)
  const replay = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': key },
  })
  assert.equal(replay.body.card.commitment, second.body.card.commitment, '同键重放首次响应')
})

// ---------- H6：工厂抛错/目录不可写 → 内存降级 ----------
test('H6 存储工厂在不可写目录抛错时返回内存 store，服务全程可用且 isPersistent=false', () => {
  // EROFS/权限：把一个已存在的普通文件当目录用，mkdir/打开必然失败
  const filePath = join(tempDir(), 'not-a-dir')
  writeFileSync(filePath, 'blocker')
  const store = createStore({ dir: filePath })
  assert.ok(store instanceof MemoryStore, '工厂必须捕获并回退 MemoryStore')
  assert.equal(store.isPersistent, false)
})

test('H6b FileStore 直接对不可写目录构造：自身降级，接口仍完全可用', async () => {
  const dir = join(tempDir(), 'data')
  mkdirSync(dir)
  const store = new FileStore({ dir })
  assert.equal(store.isPersistent, true)
  store.close()
  // 把目录变成只读，模拟运行期权限被撤（root 下 chmod 可能被绕过，仅尽力）
  chmodSync(dir, 0o000)
  try {
    const degraded = new FileStore({ dir })
    // 若以 root 运行仍可写，则跳过断言运行期故障；构造降级路径已由 H6 覆盖
    if (degraded.isPersistent) {
      degraded.close()
    } else {
      assert.equal(degraded.isPersistent, false)
      const session = degraded.createSession(Date.now())
      assert.ok(session.sid, '降级后 createSession 仍工作')
    }
  } finally {
    chmodSync(dir, 0o755)
  }
})

// ---------- H7：周期快照 + 哈希链从新创世重建 ----------
test('H7 触发快照压缩：日志从锚定快照的新创世重建，重启全量校验通过、状态无损', async () => {
  const dir = tempDir()
  // createSession 落 3 条，每次 begin 事务落 7 条：阈值 11 → 第二张卡
  // begin 后（累计 17）恰好触发一次压缩；之后 reveal 的 5 条作为增量日志
  const h = makePersistentHarness(dir, { storeOptions: { snapshotEvery: 11 } })
  after(() => h.shutdown())

  const { sid, cookie } = await h.createSession()
  for (const cardId of ['daily-1', 'daily-2']) {
    await h.request('POST', '/api/campaigns/daily/scratch/begin', {
      body: { cardId },
      headers: { cookie, 'idempotency-key': h.idemKey() },
    })
  }
  const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))
  const logLines1 = readFileSync(join(dir, 'events.log'), 'utf8').trim().split('\n')
  assert.equal(logLines1.length, 1, '压缩后日志仅保留新创世一条')
  const genesis = JSON.parse(logLines1[0])
  assert.equal(genesis.rec.t, 'snapshot-genesis')
  assert.equal(genesis.rec.baseHash, snapshot.fileHash, '新创世锚定快照文件 hash')
  assert.ok(snapshot.baseSeq >= 17, '快照记录压缩点全局 seq')

  await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })

  const before = stableDump(h.store)
  await h.restart()
  const afterState = stableDump(h.store)
  assert.deepEqual(afterState, before, '快照+增量日志回放后状态逐字段一致')

  const verify = await h.request('GET', '/api/audit/verify')
  assert.equal(verify.body.ok, true, '快照截断后 verify 仍可全量校验')
  assert.equal(verify.body.entries, snapshot.baseSeq + 5, 'entries 跨快照全局连续')

  // 快照后继续业务并再次跨压缩点：多次轮换幂等安全
  await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  for (const cardId of ['daily-3', 'daily-2']) {
    if (cardId === 'daily-2') {
      await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
        body: { cardId },
        headers: { cookie, 'idempotency-key': h.idemKey() },
      })
    } else {
      await h.request('POST', '/api/campaigns/daily/scratch/begin', {
        body: { cardId },
        headers: { cookie, 'idempotency-key': h.idemKey() },
      })
    }
  }
  await h.restart()
  assert.equal(h.store.claimsCount, 1)
  assert.equal(h.store.latestCards(sid, 'daily').get('daily-1').status, 'claimed')
  const verify2 = await h.request('GET', '/api/audit/verify')
  assert.equal(verify2.body.ok, true)
})

test('H7b 篡改快照文件本身：verify 报告 snapshot-corrupt，ok=false', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir, { storeOptions: { snapshotEvery: 8 } })
  after(() => h.shutdown())
  const { cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-2' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  await h.shutdown()

  const snapPath = join(dir, 'snapshot.json')
  const tampered = JSON.parse(readFileSync(snapPath, 'utf8'))
  tampered.state.chancesUsed = 999 // 无关字段：确保字节变化即可
  tampered.state.meta = { ...tampered.state.meta, evil: 1 }
  writeFileSync(snapPath, JSON.stringify(tampered))

  const h2 = makePersistentHarness(dir, { storeOptions: { snapshotEvery: 8 } })
  after(() => h2.shutdown())
  const verify = await h2.request('GET', '/api/audit/verify')
  assert.equal(verify.body.ok, false)
  assert.ok(verify.body.anomalies.some((a) => a.kind === 'snapshot-corrupt'))
})

// ---------- H8：回放语义不变量 ----------
test('H8a 承诺事件在日志顺序上严格先于任何含 seedHex 的记录', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir)
  after(() => h.shutdown())
  const { cookie } = await h.createSession()
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const seed = begin.body.card // 响应不含 seed；seed 取自服务端内部记录
  assert.ok(!seed.seedHex, '响应不得泄露 seed')

  const sid = h.store.sessions.keys().next().value
  const internal = h.store.latestCards(sid, 'daily').get('daily-1')
  const lines = readFileSync(join(dir, 'events.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const seedPos = lines.findIndex((l) => JSON.stringify(l.rec).includes(internal.seedHex))
  const commitPos = lines.findIndex(
    (l) => l.rec.t === 'event' && l.rec.e?.type === 'commitment-created' && l.rec.e?.cardId === 'daily-1',
  )
  assert.ok(commitPos >= 0)
  assert.ok(seedPos > commitPos, '含 seed 的卡记录必须晚于承诺事件')
})

test('H8b claim 去重账本重启后不丢：重复 claim 返回 already-claimed 且只登记一次', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir)
  after(() => h.shutdown())
  const { sid, cookie } = await h.createSession()
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  await h.request('POST', '/api/campaigns/daily/scratch/reveal', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  const claimKey = h.idemKey()
  const claim = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': claimKey },
  })
  assert.equal(claim.body.card.status, 'claimed')
  const claimRef = claim.body.card.claimRef
  const ledgerBefore = h.store.claimsCount

  await h.restart()
  assert.equal(h.store.claimsCount, ledgerBefore, 'claimsLedger 完整恢复')

  // 同一幂等键：返回首次响应（ok:true + 同一 claimRef），不重复登记
  const replay = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': claimKey },
  })
  assert.equal(replay.body.ok, true, '同键重放返回首次成功响应')
  assert.equal(replay.body.card.claimRef, claimRef, '同一 claimRef')

  // 换一个新键：状态机裁决 already-claimed
  const again = await h.request('POST', '/api/campaigns/daily/prizes/claim', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(again.body.ok, false)
  assert.equal(again.body.reason, 'already-claimed')
  assert.equal(h.store.claimsCount, ledgerBefore, '绝不重复登记')
})

test('H8c 时钟回拨：重启后单调基线不回退，沿用更晚记账日并标记异常', async () => {
  const dir = tempDir()
  const h = makePersistentHarness(dir)
  after(() => h.shutdown())
  const { cookie } = await h.createSession()
  const DAY2 = Date.UTC(2026, 8, 25, 2, 0, 0)
  h.clock.set(DAY2)
  await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  // 回拨到前一天
  h.clock.set(Date.UTC(2026, 8, 24, 2, 0, 0))
  const rolledBack = await h.request('POST', '/api/recover', { body: {}, headers: { cookie } })
  assert.equal(rolledBack.body.day, '2026-09-25', '不回退到更早的账日')
  assert.equal(rolledBack.body.clockAnomaly, true)

  await h.restart()
  const afterRestart = await h.request('POST', '/api/recover', { body: {}, headers: { cookie } })
  assert.equal(afterRestart.body.day, '2026-09-25', '回拨基线持久化、重启不回退')
  assert.equal(afterRestart.body.clockAnomaly, true)
})

test('H8d 快照轮换中途崩溃（快照已 rename、日志未轮换）：重启自愈，状态以快照为准无重复', async () => {
  const dir = tempDir()
  let fired = false
  const h = makePersistentHarness(dir, {
    storeOptions: {
      snapshotEvery: 7,
      faultInSnapshot: (phase) => {
        if (!fired && phase === 'after-snapshot-rename') {
          fired = true
          return new Error('SIMULATED crash between snapshot rename and log rotation')
        }
        return null
      },
    },
  })
  after(() => h.shutdown())

  const { sid, cookie } = await h.createSession()
  const begin = await h.request('POST', '/api/campaigns/daily/scratch/begin', {
    body: { cardId: 'daily-1' },
    headers: { cookie, 'idempotency-key': h.idemKey() },
  })
  assert.equal(begin.status, 200, '快照是尽力而为压缩，失败不得影响已落盘业务')
  assert.ok(fired)
  await h.shutdown()

  // 重启时刻：snapshot.json 已存在，events.log 仍是旧链（含旧 genesis）
  const h2 = makePersistentHarness(dir, { storeOptions: { snapshotEvery: 1000 } })
  after(() => h2.shutdown())
  assert.ok(h2.faults.some((f) => JSON.stringify(f).includes('snapshot-rotation-recovered')))
  assert.equal(h2.store.getDay(sid, 'daily', '2026-09-24').chancesUsed, 1, '快照内扣费恢复一次')
  assert.equal(h2.store.latestCards(sid, 'daily').get('daily-1').status, 'pending')
  assert.equal(h2.store.events.length, 3, '旧日志覆盖范围内事件不重复回放')

  // 自愈后的同一实例审计报告一次可恢复异常；再重启后全链干净
  const verify1 = await h2.request('GET', '/api/audit/verify')
  assert.ok(verify1.body.anomalies.some((a) => a.kind === 'snapshot-rotation-recovered'))
  await h2.restart()
  const verify2 = await h2.request('GET', '/api/audit/verify')
  assert.equal(verify2.body.ok, true)
})
