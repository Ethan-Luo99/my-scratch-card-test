import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createPrivateKey } from 'node:crypto'
import { createServerApp } from '../../server/http/app.js'
import { createSigner } from '../../server/core/rng.js'
import { createDefaultConfig } from '../../server/core/config.js'
import { FileStore } from '../../server/store/file.js'
import { fakeClock } from './helpers.js'

const START_MS = Date.UTC(2026, 8, 24, 2, 0, 0)

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function stableSignerFactory() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  return () => createSigner({ privateKey: createPrivateKey(pem) })
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

function makeInstance(dir, signerFactory, startMs = START_MS, restorePackage = null) {
  const clockControl = fakeClock(startMs)
  const store = new FileStore(dir, {
    snapshotEveryLines: 1_000_000,
    snapshotEveryBytes: 1_000_000_000,
    ...(restorePackage ? { restorePackage } : {}),
  })
  const app = createServerApp({
    clock: clockControl.now,
    store,
    signer: signerFactory(),
    config: createDefaultConfig(),
  })
  return { clockControl, store, server: createServer(app) }
}

async function postJson(base, path, { cookie, key, body = {} }) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function getJson(base, path, headers = {}) {
  const response = await fetch(`${base}${path}`, { headers })
  return { status: response.status, body: await response.json() }
}

async function createSession(base) {
  const response = await fetch(`${base}/api/session`, { method: 'POST', body: '{}' })
  const sid = /(?:^| )sid=([^;]+)/.exec(response.headers.get('set-cookie'))[1]
  return { sid, cookie: `sid=${sid}` }
}

function parseLog(dir) {
  return readFileSync(join(dir, 'events.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(0, line.lastIndexOf('|'))))
}

function opsCommitTime(ops) {
  let at = 0
  for (const op of ops) {
    at = Math.max(
      at,
      op.event?.at ?? 0,
      op.session?.lastSeenAt ?? 0,
      op.record?.updatedAt ?? 0,
      op.entry?.at ?? 0,
    )
  }
  return at
}

function findCommit(records, ordinal) {
  let count = 0
  let pending = null
  let commitOrdinal = 0
  for (const record of records) {
    count += 1
    if (record.kind === 'APPLY') {
      pending ??= []
      pending.push(record.data.op)
    }
    if (record.kind === 'COMMIT') {
      commitOrdinal += 1
      if (commitOrdinal === ordinal) return { entries: count, seq: record.seq, hash: record.hash, asOf: opsCommitTime(pending) }
      pending = []
    }
  }
  throw new Error('COMMIT not found')
}

function latestCommit(records) {
  let pending = null
  let result = null
  for (const record of records) {
    if (record.kind === 'APPLY') {
      pending ??= []
      pending.push(record.data.op)
    }
    if (record.kind === 'COMMIT') {
      result = { entries: records.indexOf(record) + 1, seq: record.seq, hash: record.hash, asOf: opsCommitTime(pending) }
      pending = []
    }
  }
  return result
}

test('J1 follower 导出中点，新目录恢复后逐字段复现且 v2 链对账', async () => {
  const sourceDir = tempDir('scratch-pitr-source-')
  const restoredDir = tempDir('scratch-pitr-restore-')
  const backupDir = tempDir('scratch-pitr-package-')
  const backupPath = join(backupDir, 'backup.json')
  const signerFactory = stableSignerFactory()
  const leader = makeInstance(sourceDir, signerFactory)
  const base = await listen(leader.server)
  const { cookie } = await createSession(base)

  await postJson(base, '/api/campaigns/daily/scratch/begin', { cookie, key: 'j1-begin-1', body: { cardId: 'daily-1' } })
  leader.clockControl.advance(1_000)
  await postJson(base, '/api/campaigns/daily/scratch/reveal', { cookie, key: 'j1-reveal-1', body: { cardId: 'daily-1' } })
  leader.clockControl.advance(1_000)

  const midpoint = findCommit(parseLog(sourceDir), 3)
  const expectedMidState = JSON.stringify(leader.store._dumpState(midpoint.asOf))

  await postJson(base, '/api/campaigns/daily/prizes/claim', { cookie, key: 'j1-claim-1', body: { cardId: 'daily-1' } })
  leader.clockControl.advance(1_000)
  await postJson(base, '/api/campaigns/daily/scratch/begin', { cookie, key: 'j1-begin-2', body: { cardId: 'daily-2' } })
  leader.clockControl.advance(1_000)

  const follower = makeInstance(sourceDir, signerFactory)
  const followerBase = await listen(follower.server)
  await follower.store.waitForLeaderCatchUp(2_000)
  const exported = await getJson(followerBase, `/api/audit/export?asOf=${midpoint.asOf}`, { cookie })
  const leaderExport = await getJson(base, `/api/audit/export?asOf=${midpoint.asOf}`, { cookie })
  writeFileSync(backupPath, JSON.stringify(exported.body))

  const restored = makeInstance(restoredDir, signerFactory, START_MS, backupPath)
  const restoredAudit = restored.store.verifyAudit(midpoint.asOf)
  const restoredState = JSON.stringify(restored.store._dumpState(midpoint.asOf))

  assert.deepEqual(
    {
      exportStatus: exported.status,
      followerExportMatchesLeader: JSON.stringify(exported.body) === JSON.stringify(leaderExport.body),
      restoredState: restoredState,
      verifyOk: restoredAudit.ok,
      verifyFormat: restoredAudit.format,
      verifyEntries: restoredAudit.entries,
      verifyTipHash: restoredAudit.tipHash,
      exportedEntries: exported.body.truncation.entries,
      exportedTipHash: exported.body.truncation.tipHash,
    },
    {
      exportStatus: 200,
      followerExportMatchesLeader: true,
      restoredState: expectedMidState,
      verifyOk: true,
      verifyFormat: 2,
      verifyEntries: midpoint.entries,
      verifyTipHash: midpoint.hash,
      exportedEntries: midpoint.entries,
      exportedTipHash: midpoint.hash,
    },
  )

  follower.store.close()
  restored.store.close()
  leader.store.close()
  await closeServer(follower.server)
  await closeServer(restored.server)
  await closeServer(leader.server)
  rmSync(sourceDir, { recursive: true, force: true })
  rmSync(restoredDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

test('J2 首笔提交前不可导出；最新提交恢复后与当前全量一致', async () => {
  const sourceDir = tempDir('scratch-pitr-latest-source-')
  const restoredDir = tempDir('scratch-pitr-latest-restore-')
  const backupDir = tempDir('scratch-pitr-latest-package-')
  const backupPath = join(backupDir, 'backup.json')
  const signerFactory = stableSignerFactory()
  const leader = makeInstance(sourceDir, signerFactory)
  const base = await listen(leader.server)

  const beforeFirst = await getJson(base, `/api/audit/export?asOf=${START_MS - 1}`)
  await createSession(base)
  const { cookie } = await createSession(base)
  await postJson(base, '/api/campaigns/daily/scratch/begin', { cookie, key: 'j2-begin', body: { cardId: 'daily-1' } })
  leader.clockControl.advance(1_000)
  await postJson(base, '/api/campaigns/daily/scratch/reveal', { cookie, key: 'j2-reveal', body: { cardId: 'daily-1' } })
  leader.clockControl.advance(1_000)

  const latest = latestCommit(parseLog(sourceDir))
  const exported = await getJson(base, `/api/audit/export?asOf=${latest.asOf}`, { cookie })
  writeFileSync(backupPath, JSON.stringify(exported.body))
  const expectedState = JSON.stringify(leader.store._dumpState(latest.asOf))

  const restored = makeInstance(restoredDir, signerFactory, START_MS, backupPath)
  const restoredAudit = restored.store.verifyAudit(latest.asOf)

  assert.deepEqual(
    {
      beforeFirstStatus: beforeFirst.status,
      beforeFirstError: beforeFirst.body.error,
      latestExportStatus: exported.status,
      restoredState: JSON.stringify(restored.store._dumpState(latest.asOf)),
      verifyOk: restoredAudit.ok,
      verifyEntries: restoredAudit.entries,
      verifyTipHash: restoredAudit.tipHash,
    },
    {
      beforeFirstStatus: 422,
      beforeFirstError: 'pitr-before-first-commit',
      latestExportStatus: 200,
      restoredState: expectedState,
      verifyOk: true,
      verifyEntries: latest.entries,
      verifyTipHash: latest.hash,
    },
  )

  restored.store.close()
  leader.store.close()
  await closeServer(restored.server)
  await closeServer(leader.server)
  rmSync(sourceDir, { recursive: true, force: true })
  rmSync(restoredDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})
