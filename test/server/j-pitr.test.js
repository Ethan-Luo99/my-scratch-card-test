/**
 * J 类 · 时间点导出与恢复（PITR）——本文件恰好 2 条断言：
 * J1 导出→恢复往返：写若干笔后取 asOf 中点再写几笔；导出、在新目录恢复，
 *    恢复实例状态与 asOf 时刻逐字段一致、verify ok=true、entries 与 tipHash
 *    与原链该点对账一致（期望值独立从原目录磁盘链计算，不取自备份包）。
 * J2 边界：asOf 指向首笔提交前 → 409 明确报错（含原因/最早提交时刻）；
 *    asOf 指向最新提交 → 恢复后与当前全量逐字段一致、链尖对账一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createPrivateKey } from 'node:crypto'
import { createServer } from 'node:http'
import { createServerApp } from '../../server/http/app.js'
import { createSigner } from '../../server/core/rng.js'
import { createDefaultConfig } from '../../server/core/config.js'
import { FileStore, canonicalJSON, LOG_FILE } from '../../server/store/file.js'
import { fakeClock } from './helpers.js'

const SNAPSHOT_DISABLED = { snapshotEveryLines: 1_000_000, snapshotEveryBytes: 1_000_000_000 }

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function stableSigner() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  return () => createSigner({ privateKey: createPrivateKey(pem) })
}

function makeApp(dir, { clockStart } = {}) {
  const clockControl = fakeClock(clockStart)
  const store = new FileStore(dir, SNAPSHOT_DISABLED)
  const makeSigner = stableSigner()
  const app = createServerApp({
    clock: clockControl.now,
    store,
    signer: makeSigner(),
    config: createDefaultConfig(),
  })
  const server = createServer(app)
  return { clockControl, store, makeSigner, server }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

async function post(base, path, cookie, key, body = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

async function newSession(base) {
  const response = await post(base, '/api/session', null, null, {})
  const sid = /(?:^| )sid=([^;]+)/.exec(response.headers.get('set-cookie'))[1]
  return { sid, cookie: `sid=${sid}` }
}

async function begin(base, cookie, key, cardId) {
  return post(base, '/api/campaigns/daily/scratch/begin', cookie, key, { cardId })
}

async function reveal(base, cookie, key, cardId) {
  return post(base, '/api/campaigns/daily/scratch/reveal', cookie, key, { cardId })
}

async function claim(base, cookie, key, cardId) {
  return post(base, '/api/campaigns/daily/prizes/claim', cookie, key, { cardId })
}

async function exportAt(base, asOf) {
  const response = await fetch(`${base}/api/audit/export?asOf=${asOf}`)
  const body = await response.json()
  return { status: response.status, body }
}

/** 独立解析数据目录日志：返回每个完整 COMMIT 的 {at,hash,entries,validBytes} */
function commitBoundaries(dir) {
  const raw = readFileSync(join(dir, LOG_FILE), 'utf8')
  const lines = raw.split('\n').filter((line) => line.length > 0)
  const commits = []
  let entries = 0
  let pending = { n: 0, at: null }
  for (const line of lines) {
    const rec = JSON.parse(line.slice(0, line.lastIndexOf('|')))
    entries += 1
    if (rec.kind === 'APPLY') {
      pending.n += 1
      const op = rec.data.op
      const candidate =
        op.t === 'session-upsert'
          ? op.session?.lastSeenAt
          : op.t === 'day-upsert'
            ? op.record?.updatedAt
            : op.t === 'card-upsert'
              ? op.record?.updatedAt
              : op.t === 'idem-upsert'
                ? op.entry?.at
                : op.t === 'event'
                  ? op.event?.at
                  : null
      if (typeof candidate === 'number') pending.at = candidate
    } else if (rec.kind === 'COMMIT') {
      commits.push({ at: rec.data.at ?? pending.at, hash: rec.hash, entries })
      pending = { n: 0, at: null }
    }
  }
  return commits
}

test('J1 导出→恢复往返：asOf 中点状态逐字段一致、verify ok、entries/tipHash 对账', async () => {
  const dir = tempDir('scratch-pitr-leader-')
  const restoreDir = tempDir('scratch-pitr-restore-')
  rmSync(restoreDir, { recursive: true, force: true }) // restore 要求空目录
  const leader = makeApp(dir, { clockStart: Date.UTC(2026, 8, 24, 2, 0, 0) })
  const base = await listen(leader.server)
  const { sid, cookie } = await newSession(base)
  await begin(base, cookie, 'j1-b1', 'daily-1')
  await reveal(base, cookie, 'j1-r1', 'daily-1')
  await claim(base, cookie, 'j1-c1', 'daily-1')

  // asOf 中点：第 3 笔提交（claim）之后；先抓取该时刻期望状态（之后还要再写）
  leader.clockControl.advance(1000)
  await begin(base, cookie, 'j1-b2', 'daily-2')
  const midAsOf = leader.store.events.at(-1).at
  const expectedMidDump = canonicalJSON(leader.store._dumpState(midAsOf))
  const expectedMid = commitBoundaries(dir).find((c) => c.at === midAsOf)

  // 中点之后再写两笔：恢复实例绝不能看到这些
  leader.clockControl.advance(1000)
  await reveal(base, cookie, 'j1-r2', 'daily-2')
  await begin(base, cookie, 'j1-b3', 'daily-3')

  const exported = await exportAt(base, midAsOf)
  const backup = exported.body

  // 在全新空目录恢复（同一签名密钥，receipt 验签口径不变）
  const restored = FileStore.restoreFromBackup(backup, restoreDir)
  const verify = restored.verifyAudit(midAsOf)
  const leaderVerify = leader.store.verifyAudit()
  leader.store.close()
  await closeServer(leader.server)
  restored.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(restoreDir, { recursive: true, force: true })

  assert.deepEqual(
    {
      exportStatus: exported.status,
      backupShape: {
        format: backup.format,
        version: backup.version,
        resolvedAsOf: backup.asOf,
        hasSnapshotField: backup.snapshot === null,
        hasLogPrefix: backup.logLines.length > 0,
        ttlExpiredAtAsOf: backup.idempotency.expiredAtAsOf,
      },
      stateMatchesAsOfExactly: canonicalJSON(restored._dumpState(midAsOf)) === expectedMidDump,
      laterWritesAbsent: !restored.latestCards(sid, 'daily').get('daily-3'),
      verifyOk: verify.ok,
      verifyPersistent: verify.persistent,
      verifyFormat: verify.format,
      verifyAnomalies: verify.anomalies,
      // 对账：entries 数与 tipHash 必须等于原链 asOf 前最后一个 COMMIT
      // （期望值独立从原目录磁盘链计算，非取自备份包，避免自我证明）
      entriesReconcile: verify.entries === expectedMid.entries,
      tipHashReconcile: verify.tipHash === expectedMid.hash,
      backupTargetReconciles:
        backup.target.tipHash === expectedMid.hash && backup.target.entries === expectedMid.entries,
      leaderItselfStillOk: leaderVerify.ok,
    },
    {
      exportStatus: 200,
      backupShape: {
        format: 'scratch-pitr-backup-v1',
        version: 1,
        resolvedAsOf: midAsOf,
        hasSnapshotField: true,
        hasLogPrefix: true,
        ttlExpiredAtAsOf: 0,
      },
      stateMatchesAsOfExactly: true,
      laterWritesAbsent: true,
      verifyOk: true,
      verifyPersistent: true,
      verifyFormat: 2,
      verifyAnomalies: [],
      entriesReconcile: true,
      tipHashReconcile: true,
      backupTargetReconciles: true,
      leaderItselfStillOk: true,
    },
  )
})
test('J2 边界：首笔提交前导出明确报错；asOf=最新提交恢复后与当前全量一致', async () => {
  const dir = tempDir('scratch-pitr-edge-')
  const restoreDir = tempDir('scratch-pitr-edge-restore-')
  rmSync(restoreDir, { recursive: true, force: true })
  const leader = makeApp(dir, { clockStart: Date.UTC(2026, 8, 25, 2, 0, 0) })
  const base = await listen(leader.server)

  // 边界 A：任何业务提交之前（磁盘链只有 GENESIS、没有一个 COMMIT）
  // → 明确不可导出错误，不附最早提交时刻（此刻不存在），绝不猜测
  const tooEarly = await exportAt(base, leader.clockControl.now())

  const { sid, cookie } = await newSession(base)
  leader.clockControl.advance(60_000)
  await begin(base, cookie, 'j2-b1', 'daily-1')
  await reveal(base, cookie, 'j2-r1', 'daily-1')

  // 边界 B：asOf 指向最新提交 → 恢复后与当前全量逐字段一致、链尖对账一致
  const latestAsOf = leader.store.events.at(-1).at
  const expectedFullDump = canonicalJSON(leader.store._dumpState(latestAsOf))
  const expectedTip = leader.store.tipHash
  const expectedEntries = leader.store.totalRecords
  const exported = await exportAt(base, latestAsOf)
  const backup = exported.body

  const restored = FileStore.restoreFromBackup(backup, restoreDir)
  const verify = restored.verifyAudit(latestAsOf)
  const freshRestoredSession = restored.getSession(sid)
  const restoredCard = restored.latestCards(sid, 'daily').get('daily-1')
  restored.close()
  leader.store.close()
  await closeServer(leader.server)
  rmSync(dir, { recursive: true, force: true })
  rmSync(restoreDir, { recursive: true, force: true })

  assert.deepEqual(
    {
      latestExportStatus: exported.status,
      beforeFirstCommit: {
        status: tooEarly.status,
        error: tooEarly.body.error,
        reason: tooEarly.body.reason,
        reportsEarliestCommitAt: typeof tooEarly.body.earliestCommitAt === 'number',
      },
      fullStateMatches: canonicalJSON(restored._dumpState(latestAsOf)) === expectedFullDump,
      sessionRestored: freshRestoredSession !== null && freshRestoredSession.sid === sid,
      cardRestored: restoredCard ? { status: restoredCard.status, rev: restoredCard.rev } : null,
      verifyOk: verify.ok,
      entriesReconcile: verify.entries === expectedEntries,
      tipHashReconcile: verify.tipHash === expectedTip,
      asOfResolved: backup.asOf === latestAsOf,
      ttlPolicyDescribed:
        typeof backup.idempotency.policy === 'string' && backup.idempotency.policy.includes('TTL'),
    },
    {
      latestExportStatus: 200,
      beforeFirstCommit: {
        status: 409,
        error: 'pitr-not-exportable',
        reason: 'no-commit-on-disk',
        reportsEarliestCommitAt: false,
      },
      fullStateMatches: true,
      sessionRestored: true,
      cardRestored: { status: 'revealed', rev: 2 },
      verifyOk: true,
      entriesReconcile: true,
      tipHashReconcile: true,
      asOfResolved: true,
      ttlPolicyDescribed: true,
    },
  )
})
