/**
 * 持久化与防篡改审计验收（FileStore）：
 * 1 回放逐字段一致；2 尾截断/注入损坏容错；3 重启后旧幂等键不重复扣费；
 * 4 篡改中间记录 verify 报首个断点 seq；5 两个崩溃窗口无重复扣费/无丢失承诺；
 * 6 工厂构造失败优雅降级；7 快照压缩后哈希链全量校验；8 既有语义不变量保持。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createPrivateKey } from 'node:crypto'
import { createServer } from 'node:http'
import { createServerApp } from '../../server/http/app.js'
import { createSigner } from '../../server/core/rng.js'
import { createDefaultConfig } from '../../server/core/config.js'
import { FileStore, SimulatedCrash } from '../../server/store/file.js'
import { MemoryStore } from '../../server/store/memory.js'
import { createStore } from '../../server/store/factory.js'
import { fakeClock } from './helpers.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'scratch-wal-'))
}

function stableSigner() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  return () => createSigner({ privateKey: createPrivateKey(pem) })
}

function makeApp(dir, { faults, snapshotEveryLines, clockStart, signerFactory } = {}) {
  const clockControl = fakeClock(clockStart)
  const store = new FileStore(dir, {
    faults,
    snapshotEveryLines: snapshotEveryLines ?? 1_000_000,
    snapshotEveryBytes: 1_000_000_000,
  })
  const makeSigner = signerFactory ?? stableSigner()
  const app = createServerApp({
    clock: clockControl.now,
    store,
    signer: makeSigner(),
    config: createDefaultConfig(),
  })
  const server = createServer(app)
  return { clockControl, store, app, makeSigner, server }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

async function bootAndBegin(dir, { faults, snapshotEveryLines } = {}) {
  const harness = makeApp(dir, { faults, snapshotEveryLines })
  const base = await listen(harness.server)
  const session = await fetch(`${base}/api/session`, { method: 'POST', body: '{}' }).then(async (r) => ({
    status: r.status,
    cookie: r.headers.get('set-cookie'),
    body: await r.json(),
  }))
  assert.equal(session.status, 200)
  const sid = /(?:^| )sid=([^;]+)/.exec(session.cookie)[1]
  const beginKey = 'idem-begin-1'
  const beginRes = await fetch(`${base}/api/campaigns/daily/scratch/begin`, {
    method: 'POST',
    headers: { cookie: `sid=${sid}`, 'idempotency-key': beginKey, 'content-type': 'application/json' },
    body: JSON.stringify({ cardId: 'daily-1' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))
  return { harness, base, sid, cookie: `sid=${sid}`, beginKey, beginRes }
}

async function post(base, path, cookie, key, body = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, 'idempotency-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))
}

function dumpState(store, nowMs) {
  return store._dumpState(nowMs)
}

function logLines(dir) {
  return readFileSync(join(dir, 'events.log'), 'utf8').split('\n').filter((line) => line.length > 0)
}

/** 解析一条日志记录（去掉行尾 |checksum） */
function parseLogLine(line) {
  return JSON.parse(line.slice(0, line.lastIndexOf('|')))
}

/** 破坏指定行（保持行长不变）的 checksum，返回该行 seq */
function corruptLineChecksum(dir, lineIndex) {
  const lines = logLines(dir)
  const line = lines[lineIndex]
  const bar = line.lastIndexOf('|')
  const checksum = line.slice(bar + 1)
  const flipped = checksum[0] === '0' ? `1${checksum.slice(1)}` : `0${checksum.slice(1)}`
  lines[lineIndex] = `${line.slice(0, bar + 1)}${flipped}`
  writeFileSync(join(dir, 'events.log'), lines.join('\n') + '\n')
  return parseLogLine(line).seq
}

test('P1 写入多条事务后用同日志新建 FileStore：内存状态逐字段一致', async () => {
  const dir = tempDir()
  const harness = makeApp(dir)
  const base = await listen(harness.server)
  const session = await fetch(`${base}/api/session`, { method: 'POST', body: '{}' })
  const cookie = session.headers.get('set-cookie')

  await post(base, '/api/campaigns/daily/scratch/begin', cookie, 'k1', { cardId: 'daily-1' })
  await post(base, '/api/campaigns/daily/scratch/begin', cookie, 'k2', { cardId: 'daily-2' })
  await post(base, '/api/campaigns/daily/scratch/reveal', cookie, 'k3', { cardId: 'daily-1' })
  await post(base, '/api/campaigns/daily/scratch/begin', cookie, 'k4', { cardId: 'daily-3' })
  await post(base, '/api/campaigns/daily/prizes/claim', cookie, 'k5', { cardId: 'daily-1' })

  const nowMs = Date.now()
  const before = dumpState(harness.store, nowMs)
  harness.store.close()
  await close(harness.server)

  const reopened = new FileStore(dir)
  const after = dumpState(reopened, nowMs)
  assert.deepEqual(after, before)

  // 关键业务字段抽查
  assert.equal(reopened.sessions.size, 1)
  const sid = [...reopened.sessions.keys()][0]
  const day = reopened.days.get([...reopened.days.keys()][0])
  assert.equal(day.chancesUsed, 3)
  const cards = reopened.latestCards(sid, 'daily')
  assert.equal(cards.get('daily-1').status, 'claimed')
  assert.equal(cards.get('daily-1').claimRef?.startsWith('claim_'), true)
  assert.equal(cards.get('daily-2').status, 'pending')
  assert.equal(cards.get('daily-3').status, 'pending')
  assert.equal(reopened.claimsCount, 1)
  assert.equal(reopened.events.length, before.events.length)
  assert.ok(reopened.events.some((e) => e.type === 'commitment-created'))

  const audit = reopened.verifyAudit()
  assert.equal(audit.ok, true)
  assert.equal(audit.anomalies.length, 0)
  assert.equal(audit.entries, reopened.totalRecords)
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test('P2 尾行截断/半行/注入垃圾：停在最后有效记录、标记异常、后续写入正常', async () => {
  const dir = tempDir()
  const { harness, base, sid } = await bootAndBegin(dir)
  await post(base, '/api/campaigns/daily/scratch/reveal', `sid=${sid}`, 'k-reveal', { cardId: 'daily-1' })
  const validLines = logLines(dir).length
  harness.store.close()
  await close(harness.server)

  // (a) 注入一整段无换行垃圾
  const logPath = join(dir, 'events.log')
  appendFileSync(logPath, 'this is injected garbage, no newline at all')
  let reopened = new FileStore(dir)
  let audit = reopened.verifyAudit()
  assert.equal(audit.ok, true, '已恢复的尾截断不判负')
  assert.ok(audit.anomalies.some((a) => a.code === 'truncation-anomaly'))
  assert.equal(logLines(dir).length, validLines, '垃圾尾已被物理切除')

  // 重启后后续写入正常追加（新事务提交、verify 仍干净）
  const app2 = createServerApp({
    clock: () => Date.now(),
    store: reopened,
    signer: harness.makeSigner(),
    config: createDefaultConfig(),
  })
  const server2 = createServer(app2)
  const base2 = await listen(server2)
  const claim = await post(base2, '/api/campaigns/daily/prizes/claim', `sid=${sid}`, 'k-claim', {
    cardId: 'daily-1',
  })
  assert.equal(claim.body.card.status, 'claimed')
  const appended = logLines(dir).slice(validLines)
  assert.ok(appended.length >= 2, '新事务至少 APPLY+COMMIT 两行')
  assert.equal(parseLogLine(appended[appended.length - 1]).kind, 'COMMIT')
  assert.ok(appended.slice(0, -1).every((line) => parseLogLine(line).kind === 'APPLY'))
  assert.equal(reopened.verifyAudit().ok, true)
  reopened.close()
  await close(server2)

  // (b) 半行：只保留末行前若干字节（保留完整日志副本供 (c) 独立使用）
  const intactLog = readFileSync(logPath)
  const bytes = intactLog
  const lineStart = bytes.lastIndexOf(0x0a, bytes.length - 2) + 1
  writeFileSync(logPath, bytes.slice(0, lineStart + 3)) // COMMIT 行只剩 3 字节、无换行
  reopened = new FileStore(dir)
  audit = reopened.verifyAudit()
  assert.ok(audit.anomalies.some((a) => a.code === 'truncation-anomaly'))
  assert.equal(audit.ok, true)
  // claim 事务整组丢失：卡回到 revealed（无半应用）
  assert.equal(reopened.latestCards(sid, 'daily').get('daily-1').status, 'revealed')
  reopened.close()

  // (c) 完整尾行但 checksum 损坏：同样停在其之前（claim 事务整组不生效）
  const raw = intactLog.toString('utf8').split('\n').filter(Boolean)
  raw[raw.length - 1] = raw[raw.length - 1].replace(/.$/, (c) => (c === '0' ? '1' : '0'))
  writeFileSync(logPath, raw.join('\n') + '\n')
  reopened = new FileStore(dir)
  assert.ok(reopened.anomalies.some((a) => a.code === 'truncation-anomaly'))
  assert.equal(reopened.latestCards(sid, 'daily').get('daily-1').status, 'revealed')
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test('P3 重启后旧 Idempotency-Key 重放 begin：返回首次响应、不重复扣费', async () => {
  const dir = tempDir()
  const { harness, base, sid, beginKey, beginRes } = await bootAndBegin(dir)
  assert.equal(beginRes.status, 200)
  assert.equal(beginRes.body.ok, true)
  assert.equal(beginRes.body.chancesLeft, 2)
  harness.store.close()
  await close(harness.server)

  const store2 = new FileStore(dir)
  const app2 = createServerApp({
    clock: () => Date.now(),
    store: store2,
    signer: harness.makeSigner(),
    config: createDefaultConfig(),
  })
  const server2 = createServer(app2)
  const base2 = await listen(server2)

  const replay = await post(base2, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, beginKey, {
    cardId: 'daily-1',
  })
  assert.equal(replay.body.ok, true)
  assert.equal(replay.body.__idempotentReplay, true)
  assert.equal(replay.body.card.commitment, beginRes.body.card.commitment)
  assert.equal(replay.body.card.rev, beginRes.body.card.rev)
  assert.equal(replay.body.chancesLeft, 2, '重放不得二次扣费')

  const dayRecord = [...store2.days.values()][0]
  assert.equal(dayRecord.chancesUsed, 1)
  const audit = store2.verifyAudit()
  assert.equal(audit.ok, true)
  store2.close()
  await close(server2)
  rmSync(dir, { recursive: true, force: true })
})

test('P4 篡改日志中间任意一条：/api/audit/verify 报首个断点 seq、ok=false', async () => {
  const dir = tempDir()
  const { harness, base, sid } = await bootAndBegin(dir)
  await post(base, '/api/campaigns/daily/scratch/reveal', `sid=${sid}`, 'k2', { cardId: 'daily-1' })
  await post(base, '/api/campaigns/daily/prizes/claim', `sid=${sid}`, 'k3', { cardId: 'daily-1' })
  const lines = logLines(dir)
  assert.ok(lines.length >= 8)
  // 选中间一条 APPLY 行（避开创世与首个事务）
  const targetIndex = 4
  const brokenSeq = corruptLineChecksum(dir, targetIndex)

  const audit = await fetch(`${base}/api/audit/verify`).then(async (r) => ({ status: r.status, body: await r.json() }))
  assert.equal(audit.status, 200)
  assert.equal(audit.body.ok, false)
  assert.equal(audit.body.persistent, true)
  assert.equal(audit.body.firstBrokenSeq, brokenSeq)
  assert.ok(audit.body.anomalies.some((a) => a.code === 'truncation-anomaly'))
  // 业务请求仍可继续服务（verify 只读，不拒绝业务）
  const state = await fetch(`${base}/api/state?campaign=daily`, { headers: { cookie: `sid=${sid}` } })
  assert.equal(state.status, 200)
  harness.store.close()
  await close(harness.server)
  rmSync(dir, { recursive: true, force: true })
})

test('P5a 崩溃窗口 A（日志已写、内存未提交）：恢复后重放不重复扣费、不丢承诺', async () => {
  const dir = tempDir()
  // 干净会话；故障在下一个 begin 事务的 fsync 之后、临界区提交返回点触发
  const harness = makeApp(dir, { faults: { crashAfterWrite: 2 } })
  const base = await listen(harness.server)
  const session = await fetch(`${base}/api/session`, { method: 'POST', body: '{}' })
  const sid = /(?:^| )sid=([^;]+)/.exec(session.headers.get('set-cookie'))[1]
  const beginKey = 'idem-begin-crash-a'
  const res = await post(base, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, beginKey, {
    cardId: 'daily-1',
  })
  assert.equal(res.status, 500, '模拟进程在提交返回前死亡：客户端看到失败')
  await close(harness.server)
  // 旧实例不再使用（进程已“死亡”），不调 close，避免重复写

  // 新进程打开同一份日志：redo 该事务，扣费/承诺/卡全部恢复
  const store2 = new FileStore(dir)
  const app2 = createServerApp({
    clock: () => Date.now(),
    store: store2,
    signer: harness.makeSigner(),
    config: createDefaultConfig(),
  })
  const server2 = createServer(app2)
  const base2 = await listen(server2)

  const replay = await post(base2, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, beginKey, {
    cardId: 'daily-1',
  })
  assert.equal(replay.body.ok, true)
  assert.equal(replay.body.reason, undefined)
  assert.equal(replay.body.chancesLeft, 2, 'redo 只扣一次费')
  assert.equal([...store2.days.values()][0].chancesUsed, 1)
  const card = store2.latestCards(sid, 'daily').get('daily-1')
  assert.equal(card.status, 'pending')
  assert.ok(replay.body.card.commitment)
  assert.equal(replay.body.card.commitment, card.commitment)
  assert.equal(store2.verifyAudit().ok, true)
  store2.close()
  await close(server2)
  rmSync(dir, { recursive: true, force: true })
})

test('P5b 崩溃窗口 B（内存已提交、日志写失败）：降级继续服务、不重复扣费/承诺不丢', async () => {
  const dir = tempDir()
  // 故障在下一个 begin 事务的磁盘写点触发；请求仍必须成功
  const harness = makeApp(dir, { faults: { failWrite: 2 } })
  const base = await listen(harness.server)
  const session = await fetch(`${base}/api/session`, { method: 'POST', body: '{}' })
  const sid = /(?:^| )sid=([^;]+)/.exec(session.headers.get('set-cookie'))[1]

  const res = await post(base, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, 'idem-b', {
    cardId: 'daily-1',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(harness.store.isPersistent, false, '写失败立即降级')

  // healthz / recover 均可观测 isPersistent=false
  const health = await fetch(`${base}/api/healthz`).then((r) => r.json())
  assert.equal(health.isPersistent, false)
  const recover = await fetch(`${base}/api/recover`, {
    method: 'POST',
    headers: { cookie: `sid=${sid}` },
  }).then((r) => r.json())
  assert.equal(recover.isPersistent, false)

  // 同键立即重放（同一降级进程）：幂等语义不变，不重复扣费
  const replay = await post(base, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, 'idem-b', {
    cardId: 'daily-1',
  })
  assert.equal(replay.body.__idempotentReplay, true)
  assert.equal(replay.body.chancesLeft, 2)
  assert.equal([...harness.store.days.values()][0].chancesUsed, 1)

  // 降级后 reveal/claim 全程可用
  const revealed = await post(base, '/api/campaigns/daily/scratch/reveal', `sid=${sid}`, 'idem-r', {
    cardId: 'daily-1',
  })
  assert.equal(revealed.body.card.status, 'revealed')
  const claimed = await post(base, '/api/campaigns/daily/prizes/claim', `sid=${sid}`, 'idem-c', {
    cardId: 'daily-1',
  })
  assert.equal(claimed.body.card.status, 'claimed')

  await close(harness.server)
  rmSync(dir, { recursive: true, force: true })
})

test('P6 存储工厂构造抛错：退化 MemoryStore 继续服务，isPersistent=false', () => {
  const dir = tempDir()
  // 在数据目录放一个同名普通文件，mkdir 成功但日志恢复读到目录型路径异常/
  // 或直接指向一个“文件充当目录”的路径，FileStore 构造必失败
  const filePath = join(dir, 'not-a-dir')
  writeFileSync(filePath, 'x')
  const result = createStore({ dir: filePath })
  assert.equal(result.persistent, false)
  assert.ok(result.degradedReason)
  assert.ok(result.store instanceof MemoryStore)
  assert.equal(result.store.isPersistent, false)

  // 降级 store 仍可跑完整业务（引擎层面）
  result.store.createSession(Date.now())
  assert.equal(result.store.sessions.size, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('P6b 运行期真实磁盘写失败（fd 失效）自动降级，业务不中断', async () => {
  const dir = tempDir()
  const { harness, base, sid } = await bootAndBegin(dir)
  // 关闭底层 fd 模拟磁盘/句柄失效；下一次 flush 写失败 → 降级
  const { closeSync } = await import('node:fs')
  closeSync(harness.store.fd)
  harness.store.fd = -999 // 非法 fd，writeSync 必抛
  const res = await post(base, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, 'idem-x', {
    cardId: 'daily-2',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(harness.store.isPersistent, false)
  const health = await fetch(`${base}/api/healthz`).then((r) => r.json())
  assert.equal(health.isPersistent, false)
  await close(harness.server)
  rmSync(dir, { recursive: true, force: true })
})

test('P7 快照压缩后哈希链从新创世重建：verify 全量校验、状态无丢失', async () => {
  const dir = tempDir()
  // session 事务 5 行（seq 到 5）；阈值 6 → 首个 begin 事务（8 行）提交后必压缩
  const harness = makeApp(dir, { snapshotEveryLines: 6 })
  const base = await listen(harness.server)
  const session = await fetch(`${base}/api/session`, { method: 'POST', body: '{}' })
  const sid = /(?:^| )sid=([^;]+)/.exec(session.headers.get('set-cookie'))[1]
  const begin1 = await post(base, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, 'k1', {
    cardId: 'daily-1',
  })
  assert.equal(begin1.body.ok, true)
  assert.equal(harness.store.epoch, 1, 'begin 事务后触发压缩')
  harness.store.snapshotEveryLines = 1_000_000 // 后续不再压缩，专注验证压缩后追加与回放

  // 快照已生成，日志只剩锚定的新创世
  const snapshotFile = readFileSync(join(dir, 'snapshot.json'), 'utf8').replace(/\s+$/, '')
  const snapshot = JSON.parse(snapshotFile.slice(0, snapshotFile.lastIndexOf('\n')))
  assert.equal(snapshot.format, 'scratch-snapshot-v1')
  assert.equal(snapshot.epoch, 1)
  const lines = logLines(dir)
  assert.equal(lines.length, 1)
  const genesis = parseLogLine(lines[0])
  assert.equal(genesis.kind, 'GENESIS')
  assert.equal(genesis.epoch, 1)
  assert.equal(genesis.data.snapshotId, snapshot.snapshotId)
  assert.equal(genesis.data.prevEpochTip, snapshot.tipHash)

  const auditLive = harness.store.verifyAudit()
  assert.equal(auditLive.ok, true)
  assert.equal(auditLive.entries, snapshot.records + 1)

  // 压缩后继续追加事务，新链仍可校验
  await post(base, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, 'k2', { cardId: 'daily-2' })
  assert.equal(harness.store.verifyAudit().ok, true)
  harness.store.close()
  await close(harness.server)

  // 重开：快照状态 + 新日志回放，逐字段一致、无丢失
  const store2 = new FileStore(dir, { snapshotEveryLines: 1_000_000 })
  assert.equal(store2.epoch, 1)
  const cards = store2.latestCards(sid, 'daily')
  assert.equal(cards.get('daily-1').status, 'pending')
  assert.equal(cards.get('daily-2').status, 'pending')
  assert.equal([...store2.days.values()][0].chancesUsed, 2)
  const audit = store2.verifyAudit()
  assert.equal(audit.ok, true)
  assert.equal(audit.anomalies.length, 0)

  // 再做 reveal + claim 全链路，确认压缩不改变任何业务时序
  const app2 = createServerApp({
    clock: () => Date.now(),
    store: store2,
    signer: harness.makeSigner(),
    config: createDefaultConfig(),
  })
  const server2 = createServer(app2)
  const base2 = await listen(server2)
  const revealed = await post(base2, '/api/campaigns/daily/scratch/reveal', `sid=${sid}`, 'k3', {
    cardId: 'daily-1',
  })
  assert.equal(revealed.body.card.status, 'revealed')
  const claimed = await post(base2, '/api/campaigns/daily/prizes/claim', `sid=${sid}`, 'k4', {
    cardId: 'daily-1',
  })
  assert.equal(claimed.body.card.status, 'claimed')
  assert.equal(store2.claimsCount, 1)
  assert.equal(store2.verifyAudit().ok, true)
  store2.close()
  await close(server2)
  rmSync(dir, { recursive: true, force: true })
})

test('P7b 压缩崩溃窗口（快照已 fsync、未 rename）：旧日志全量回放，不丢数据', async () => {
  const dir = tempDir()
  const harness = makeApp(dir, {
    snapshotEveryLines: 6,
    faults: { crashAfterSnapshotWrite: true },
  })
  const base = await listen(harness.server)
  const session = await fetch(`${base}/api/session`, { method: 'POST', body: '{}' })
  const sid = /(?:^| )sid=([^;]+)/.exec(session.headers.get('set-cookie'))[1]
  // begin 提交 fsync 成功，随后压缩在 rename 快照前“死亡”：客户端收 500
  const begin = await post(base, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, 'k1', {
    cardId: 'daily-1',
  })
  assert.equal(begin.status, 500)
  await close(harness.server)

  // 正式快照不存在（tmp 为孤儿），旧日志 epoch 0 完整
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(join(dir, 'snapshot.json')), false)
  assert.ok(existsSync(join(dir, '.snapshot.json.tmp')))

  const store2 = new FileStore(dir, { snapshotEveryLines: 1_000_000 })
  assert.equal(existsSync(join(dir, '.snapshot.json.tmp')), false, '孤儿 tmp 启动时清理')
  assert.equal(store2.epoch, 0)
  const card = store2.latestCards(sid, 'daily').get('daily-1')
  assert.equal(card.status, 'pending', 'begin 事务未丢')
  assert.equal([...store2.days.values()][0].chancesUsed, 1)
  assert.equal(store2.verifyAudit().ok, true)
  store2.close()
  rmSync(dir, { recursive: true, force: true })
})

test('P8 语义不变量：claim 去重账本 + 回拨基线 + 承诺先于 seed，回放后仍成立', async () => {
  const dir = tempDir()
  const clockControl = fakeClock()
  const store = new FileStore(dir)
  const signer = createSigner()
  const app = createServerApp({ clock: clockControl.now, store, signer, config: createDefaultConfig() })
  const server = createServer(app)
  const base = await listen(server)
  const sessionRes = await fetch(`${base}/api/session`, { method: 'POST', body: '{}' })
  const sid = /(?:^| )sid=([^;]+)/.exec(sessionRes.headers.get('set-cookie'))[1]
  await post(base, '/api/campaigns/daily/scratch/begin', `sid=${sid}`, 'b1', { cardId: 'daily-1' })
  await post(base, '/api/campaigns/daily/scratch/reveal', `sid=${sid}`, 'r1', { cardId: 'daily-1' })
  await post(base, '/api/campaigns/daily/prizes/claim', `sid=${sid}`, 'c1', { cardId: 'daily-1' })

  // 时钟大幅回拨：只记异常，单调基线不回退
  clockControl.set(Date.UTC(2020, 0, 1, 2, 0, 0))
  const backState = await fetch(`${base}/api/state?campaign=daily`, { headers: { cookie: `sid=${sid}` } }).then((r) => r.json())
  assert.equal(backState.day, '2026-09-24')
  assert.equal(backState.campaigns[0].chancesLeft, 2)
  const recover = await fetch(`${base}/api/recover`, { method: 'POST', headers: { cookie: `sid=${sid}` } }).then((r) => r.json())
  assert.equal(recover.clockAnomaly, true)
  clockControl.set(Date.UTC(2026, 8, 24, 3, 0, 0))

  store.close()
  await close(server)

  const store2 = new FileStore(dir)
  // claim 账本恢复：dedupKey 仍在
  assert.ok(store2.claimsCount >= 1)
  // 回拨单调基线不回退
  const session = store2.getSession(sid)
  assert.equal(session.maxObservedDayKey, '2026-09-24')
  assert.equal(session.clockAnomaly, true)
  // 承诺事件严格早于 pending-stored（含 seed 的持久记录对应的下发事件）
  const commitSeq = store2.events.find((e) => e.type === 'commitment-created').seq
  const pendingSeq = store2.events.find((e) => e.type === 'pending-stored').seq
  assert.ok(commitSeq < pendingSeq)
  assert.equal(store2.verifyAudit().ok, true)
  store2.close()
  rmSync(dir, { recursive: true, force: true })
})
