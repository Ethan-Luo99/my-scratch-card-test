/**
 * 多实例并发安全 + 存储格式 v2 迁移验收：
 * I1 一写一读：follower 读到 leader 全部提交，写请求被明确拒绝（503 read-only）；
 * I2 锁接管：leader 正常 close 释放锁后，新实例立即接管为 leader 且可写；
 * I3 v1→v2 迁移往返：夹具生成 v1 数据集，打开后状态逐字段一致、
 *    verify ok=true、迁移事件在链上可查（MIGRATE 记录 + verify.migrations）。
 * 每个测试恰好一个断言（deepEqual 整体比对），全部确定性通过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, createPrivateKey } from 'node:crypto'
import { createServer } from 'node:http'
import { createServerApp } from '../../server/http/app.js'
import { createSigner } from '../../server/core/rng.js'
import { createDefaultConfig } from '../../server/core/config.js'
import { FileStore, canonicalJSON, ZERO_HASH } from '../../server/store/file.js'
import { fakeClock } from './helpers.js'

const STORE_OPTS = { snapshotEveryLines: 1_000_000, snapshotEveryBytes: 1_000_000_000 }

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'scratch-multi-'))
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function stableSigner() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  return createSigner({ privateKey: createPrivateKey(pem) })
}

function makeApp(store, clock) {
  const app = createServerApp({
    clock: clock.now,
    store,
    signer: stableSigner(),
    config: createDefaultConfig(),
  })
  return createServer(app)
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

async function post(base, path, { cookie, key, body = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

/** v1 记录编码（无 v 字段）：与 v1 时代 file.js 逐字节同构 */
function v1Record(rec) {
  const hash = sha256Hex(
    canonicalJSON({ seq: rec.seq, kind: rec.kind, prevHash: rec.prevHash, epoch: rec.epoch, data: rec.data }),
  )
  const line = JSON.stringify({
    seq: rec.seq,
    kind: rec.kind,
    prevHash: rec.prevHash,
    hash,
    epoch: rec.epoch,
    data: rec.data,
  })
  return { line: `${line}|${sha256Hex(line)}\n`, hash }
}

test('I1 一写一读：follower 读到 leader 全部提交，写请求被拒绝', async () => {
  const dir = tempDir()
  const clock = fakeClock()
  const leaderStore = new FileStore(dir, STORE_OPTS)
  const leaderServer = makeApp(leaderStore, clock)
  const leaderBase = await listen(leaderServer)

  const session = await post(leaderBase, '/api/session')
  const sid = /(?:^| )sid=([^;]+)/.exec(session.headers.get('set-cookie'))[1]
  const cookie = `sid=${sid}`
  await post(leaderBase, '/api/campaigns/daily/scratch/begin', { cookie, key: 'i1-k1', body: { cardId: 'daily-1' } })
  await post(leaderBase, '/api/campaigns/daily/scratch/begin', { cookie, key: 'i1-k2', body: { cardId: 'daily-2' } })

  const followerStore = new FileStore(dir, STORE_OPTS)
  const followerServer = makeApp(followerStore, clock)
  const followerBase = await listen(followerServer)

  const leaderHealth = await fetch(`${leaderBase}/api/healthz`).then((r) => r.json())
  const followerHealth = await fetch(`${followerBase}/api/healthz`).then((r) => r.json())
  const state = await fetch(`${followerBase}/api/state?campaign=daily`, { headers: { cookie } }).then((r) => r.json())
  const writeSession = await post(followerBase, '/api/session')
  const writeBegin = await post(followerBase, '/api/campaigns/daily/scratch/begin', {
    cookie,
    key: 'i1-k3',
    body: { cardId: 'daily-3' },
  })
  const followerVerify = await fetch(`${followerBase}/api/audit/verify`).then((r) => r.json())

  assert.deepEqual(
    {
      leaderRole: leaderHealth.role,
      followerRole: followerHealth.role,
      chancesLeft: state.campaigns[0].chancesLeft,
      cards: state.campaigns[0].cards.map((card) => `${card.cardId}:${card.status}`),
      writeSessionStatus: writeSession.status,
      writeSessionError: writeSession.body.error,
      writeBeginStatus: writeBegin.status,
      writeBeginError: writeBegin.body.error,
      followerVerifyOk: followerVerify.ok,
      followerVerifyRole: followerVerify.role,
    },
    {
      leaderRole: 'leader',
      followerRole: 'follower',
      chancesLeft: 1, // 3 次日额度 - leader 的 2 笔 begin，follower 全部可见
      cards: ['daily-1:pending', 'daily-2:pending', 'daily-3:idle'],
      writeSessionStatus: 503,
      writeSessionError: 'read-only',
      writeBeginStatus: 503,
      writeBeginError: 'read-only',
      followerVerifyOk: true,
      followerVerifyRole: 'follower',
    },
  )

  await closeServer(followerServer)
  await closeServer(leaderServer)
  followerStore.close()
  leaderStore.close()
  rmSync(dir, { recursive: true, force: true })
})

test('I2 锁接管：leader 正常 close 后新实例立即接管为 leader', async () => {
  const dir = tempDir()
  const first = new FileStore(dir, STORE_OPTS)
  first.createSession(1000)
  first.flushPending()

  // leader 持锁期间：同目录第二实例只能为 follower（绝不双写者）
  const concurrent = new FileStore(dir, STORE_OPTS)
  const concurrentRole = concurrent.role
  concurrent.close()

  first.close() // 正常释放锁
  const second = new FileStore(dir, STORE_OPTS)
  second.createSession(2000) // 接管后立即可写
  second.flushPending()
  const verify = second.verifyAudit()

  assert.deepEqual(
    {
      concurrentRole,
      secondRole: second.role,
      secondWriteSessions: [...second.sessions.keys()].length,
      secondVerifyOk: verify.ok,
    },
    {
      concurrentRole: 'follower',
      secondRole: 'leader',
      secondWriteSessions: 2, // 接管回放 1 + 新写 1
      secondVerifyOk: true,
    },
  )

  second.close()
  rmSync(dir, { recursive: true, force: true })
})

test('I3 v1→v2 迁移往返：状态逐字段一致、verify ok、迁移在链', async () => {
  const dir = tempDir()
  // ---- 测试夹具：手工构造 v1 数据集（v1 快照 epoch1 + v1 日志一组已提交事务） ----
  const ev1 = { seq: 1, type: 'session-created', at: 1000, sid: 'sid-fixture', day: '2026-10-06' }
  const ev2 = { seq: 2, type: 'claim-recorded', at: 1001, sid: 'sid-fixture', campaignId: 'daily', cardId: 'daily-1' }
  const sessionRecord = {
    sid: 'sid-fixture',
    createdAt: 1000,
    lastSeenAt: 1000,
    maxObservedDayKey: '2026-10-06',
    maxObservedMs: 1000,
    clockAnomaly: false,
  }
  const oldTip = 'ab'.repeat(32)
  const genesis = v1Record({
    seq: 1,
    kind: 'GENESIS',
    prevHash: ZERO_HASH,
    epoch: 1,
    data: { t: 'genesis', epoch: 1, snapshotId: 'snap-1-fixture', prevEpochTip: oldTip, prevEpochRecords: 7 },
  })
  const apply1 = v1Record({
    seq: 2,
    kind: 'APPLY',
    prevHash: genesis.hash,
    epoch: 1,
    data: { group: 2, op: { t: 'meta-set', key: 'k2', value: 'v2' } },
  })
  const apply2 = v1Record({
    seq: 3,
    kind: 'APPLY',
    prevHash: apply1.hash,
    epoch: 1,
    data: { group: 2, op: { t: 'event', event: ev2 } },
  })
  const commit = v1Record({
    seq: 4,
    kind: 'COMMIT',
    prevHash: apply2.hash,
    epoch: 1,
    data: { group: 2, n: 2 },
  })
  writeFileSync(join(dir, 'events.log'), genesis.line + apply1.line + apply2.line + commit.line)
  const v1Snapshot = {
    format: 'scratch-snapshot-v1',
    epoch: 1,
    snapshotId: 'snap-1-fixture',
    createdAt: 1000,
    tipHash: oldTip,
    records: 7,
    genesisHash: genesis.hash,
    state: {
      sessions: { 'sid-fixture': sessionRecord },
      days: {},
      cards: {},
      idempotency: {},
      claimsLedger: ['dedup-1'],
      meta: { 'migrated-legacy': true },
      events: [ev1],
    },
  }
  writeFileSync(
    join(dir, 'snapshot.json'),
    `${canonicalJSON(v1Snapshot)}\n${sha256Hex(canonicalJSON(v1Snapshot))}\n`,
  )

  // ---- 新实例打开：应自动完成 v1→v2 在线迁移 ----
  const store = new FileStore(dir, STORE_OPTS)
  const verify = store.verifyAudit()
  const dump = store._dumpState()
  const logRecords = readFileSync(join(dir, 'events.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line.slice(0, line.lastIndexOf('|'))))
  const snapshotAfter = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8').split('\n')[0])
  const leftovers = readdirSync(dir).filter((name) => name.includes('v1bak') || name.includes('migrating'))
  const migrationEvent = dump.events[2]
  const migrationAtValid = Number.isInteger(migrationEvent.at) && migrationEvent.at > 0
  migrationEvent.at = '<ts>' // 时间戳归一化后整体比对

  assert.deepEqual(
    {
      role: store.role,
      verifyOk: verify.ok,
      verifyFormat: verify.format,
      verifyEntries: verify.entries, // 11（v1 链）+ 新创世 + MIGRATE
      verifyMigrations: verify.migrations.map((m) => ({
        from: m.from,
        to: m.to,
        sourceRecords: m.sourceRecords,
        sourceTip: m.sourceTip,
      })),
      dump,
      logKinds: logRecords.map((rec) => rec.kind),
      logVersion: logRecords[0].v,
      migrateEventInChain: logRecords[1].data.event.type,
      snapshotFormat: snapshotAfter.format,
      migrationAtValid,
      leftovers,
    },
    {
      role: 'leader',
      verifyOk: true,
      verifyFormat: 2,
      verifyEntries: 13,
      verifyMigrations: [{ from: 1, to: 2, sourceRecords: 11, sourceTip: commit.hash }],
      dump: {
        sessions: { 'sid-fixture': sessionRecord },
        days: {},
        cards: {},
        idempotency: {},
        claimsLedger: ['dedup-1'],
        meta: { 'migrated-legacy': true, k2: 'v2' },
        events: [
          ev1,
          ev2,
          {
            seq: 3,
            type: 'format-migrated',
            at: '<ts>',
            from: 1,
            to: 2,
            sourceEpoch: 1,
            sourceTip: commit.hash,
            sourceRecords: 11,
          },
        ],
      },
      logKinds: ['GENESIS', 'MIGRATE'],
      logVersion: 2,
      migrateEventInChain: 'format-migrated',
      snapshotFormat: 'scratch-snapshot-v2',
      migrationAtValid: true,
      leftovers: [],
    },
  )

  store.close()
  rmSync(dir, { recursive: true, force: true })
})
