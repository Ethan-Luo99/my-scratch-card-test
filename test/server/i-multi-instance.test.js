/**
 * I 类 · 多实例并发安全 + 存储格式 v2 迁移（本文件恰好 3 条断言，每条对应一项需求）：
 * I1 一写一读：同一数据目录第二实例为只读 follower，不重启即可读到 leader
 *    全部提交，且其写请求被明确拒绝（423 read-only）；leader 写路径不受阻。
 * I2 锁接管：leader 正常 close 释放锁后，新实例立即接管为 leader 并可写、可审计。
 * I3 v1→v2 迁移往返：测试夹具（formatVersion:1）生成 v1 数据集，新实例启动即
 *    在线迁移；状态逐字段一致、verify ok=true、迁移事件在哈希链上可查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createPrivateKey } from 'node:crypto'
import { createServer } from 'node:http'
import { createServerApp } from '../../server/http/app.js'
import { createSigner } from '../../server/core/rng.js'
import { createDefaultConfig } from '../../server/core/config.js'
import { FileStore, canonicalJSON, LOG_FILE, LOG_V1_BACKUP } from '../../server/store/file.js'
import { fakeClock } from './helpers.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'scratch-multi-'))
}

function stableSigner() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  return () => createSigner({ privateKey: createPrivateKey(pem) })
}

function makeApp(dir, { fileStoreOptions, clockStart } = {}) {
  const clockControl = fakeClock(clockStart)
  const store = new FileStore(dir, {
    snapshotEveryLines: 1_000_000,
    snapshotEveryBytes: 1_000_000_000,
    ...fileStoreOptions,
  })
  const makeSigner = stableSigner()
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
test('I1 一写一读：follower 读到 leader 全部提交，follower 写请求被只读拒绝', async () => {
  const dir = tempDir()
  const leader = makeApp(dir)
  const base = await listen(leader.server)
  const session = await post(base, '/api/session', null, null, {})
  const sid = /(?:^| )sid=([^;]+)/.exec(session.headers.get('set-cookie'))[1]
  const cookie = `sid=${sid}`
  await post(base, '/api/campaigns/daily/scratch/begin', cookie, 'i1-b1', { cardId: 'daily-1' })
  await post(base, '/api/campaigns/daily/scratch/reveal', cookie, 'i1-r1', { cardId: 'daily-1' })

  // 同一数据目录再开第二个实例：必须退为只读 follower，绝不双写
  const follower = makeApp(dir)
  const followerBase = await listen(follower.server)
  follower.store.refresh() // 不重启，主动跟随 leader 新提交（另有周期轮询兜底）

  const leaderView = await fetch(`${base}/api/state?campaign=daily`, { headers: { cookie } }).then((r) => r.json())
  const followerView = await fetch(`${followerBase}/api/state?campaign=daily`, { headers: { cookie } }).then((r) => r.json())
  const followerWrite = await post(followerBase, '/api/session', null, null, {})
  const leaderStillWrites = await post(base, '/api/campaigns/daily/scratch/begin', cookie, 'i1-b2', { cardId: 'daily-2' })

  assert.deepEqual(
    {
      followerRole: follower.store.role,
      followerSeesAllLeaderCommits: canonicalJSON(followerView.campaigns) === canonicalJSON(leaderView.campaigns),
      followerSeesRevealedCard: followerView.campaigns[0].cards.find((c) => c.cardId === 'daily-1')?.status,
      writeStatus: followerWrite.status,
      writeError: followerWrite.body.error,
      leaderWriteOk: leaderStillWrites.status === 200 && leaderStillWrites.body.ok === true,
    },
    {
      followerRole: 'follower',
      followerSeesAllLeaderCommits: true,
      followerSeesRevealedCard: 'revealed',
      writeStatus: 423,
      writeError: 'read-only',
      leaderWriteOk: true,
    },
  )

  follower.store.close()
  await closeServer(follower.server)
  leader.store.close()
  await closeServer(leader.server)
  rmSync(dir, { recursive: true, force: true })
})

test('I2 锁接管：leader 正常 close 后新实例立即接管为 leader', async () => {
  const dir = tempDir()
  const first = new FileStore(dir, { snapshotEveryLines: 1_000_000, snapshotEveryBytes: 1_000_000_000 })
  const firstRole = first.role
  const firstSession = first.createSession(Date.now())
  first.flushPending()
  first.close() // 正常释放锁

  // 不等待、不注入故障：构造函数内同步完成接管
  const second = new FileStore(dir, { snapshotEveryLines: 1_000_000, snapshotEveryBytes: 1_000_000_000 })
  const secondSession = second.createSession(Date.now())
  second.flushPending()
  const verify = second.verifyAudit()

  assert.deepEqual(
    {
      firstRole,
      secondRole: second.role,
      seesFirstLeadersCommit: second.getSession(firstSession.sid) !== null,
      takeoverWritable: second.getSession(secondSession.sid) !== null,
      verifyOk: verify.ok,
    },
    {
      firstRole: 'leader',
      secondRole: 'leader',
      seesFirstLeadersCommit: true,
      takeoverWritable: true,
      verifyOk: true,
    },
  )

  second.close()
  rmSync(dir, { recursive: true, force: true })
})

test('I3 v1→v2 迁移往返：状态逐字段一致、verify ok、迁移事件在链上可查', async () => {
  const dir = tempDir()
  // 测试夹具：formatVersion:1 的实例生成纯 v1 数据集（v1 日志、无快照）
  const v1 = makeApp(dir, { fileStoreOptions: { formatVersion: 1 } })
  const base = await listen(v1.server)
  const session = await post(base, '/api/session', null, null, {})
  const sid = /(?:^| )sid=([^;]+)/.exec(session.headers.get('set-cookie'))[1]
  const cookie = `sid=${sid}`
  await post(base, '/api/campaigns/daily/scratch/begin', cookie, 'i3-b1', { cardId: 'daily-1' })
  await post(base, '/api/campaigns/daily/scratch/reveal', cookie, 'i3-r1', { cardId: 'daily-1' })
  const nowMs = Date.now()
  const expectedDump = canonicalJSON(v1.store._dumpState(nowMs))
  v1.store.close()
  await closeServer(v1.server)

  // 新实例打开同一目录：启动即无损在线迁移 v1→v2，无需人工干预
  const migrated = new FileStore(dir, { snapshotEveryLines: 1_000_000, snapshotEveryBytes: 1_000_000_000 })
  const verify = migrated.verifyAudit()
  const logKinds = readFileSync(join(dir, LOG_FILE), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line.slice(0, line.lastIndexOf('|'))).kind)

  assert.deepEqual(
    {
      stateIdentical: canonicalJSON(migrated._dumpState(nowMs)) === expectedDump,
      verifyOk: verify.ok,
      verifyFormat: verify.format,
      migrationsInChain: verify.migrations.map((m) => `${m.from}->${m.to}`),
      migrateRecordInLog: logKinds.includes('MIGRATE'),
      v1BackupKept: existsSync(join(dir, LOG_V1_BACKUP)),
      role: migrated.role,
    },
    {
      stateIdentical: true,
      verifyOk: true,
      verifyFormat: 2,
      migrationsInChain: ['1->2'],
      migrateRecordInLog: true,
      v1BackupKept: true,
      role: 'leader',
    },
  )

  migrated.close()
  rmSync(dir, { recursive: true, force: true })
})
