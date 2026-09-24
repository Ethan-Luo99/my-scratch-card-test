/**
 * 服务端权威引擎（纯逻辑，无 node:http 依赖，可被 node --test 直接调用）。
 *
 * createServerEngine 返回一组动作；每个写动作在会话级互斥临界区内串行执行，
 * 保证"读—改—写"原子（并发不超发）。幂等键命中时原样返回首次响应，绝不二次扣费。
 *
 * 秘密不变量：seedHex/prize 只存在于内部 CardRecord；publicCardView 是唯一
 * 出口，pending 视图只含 commitment，revealed/claimed 才带 prize/receipt。
 */
import { randomUUID, createHash } from 'node:crypto'
import { generateSeedHex, computeCommitment } from './rng.js'
import { drawPrize } from './draw.js'
import { ALGORITHM_ID } from './config.js'
import {
  dayKeyForNow,
  toServerTime,
  resolveEffectiveDay,
} from './time.js'
import {
  normalizeEnvelopes,
  classifyEnvelope,
  migrationDedupKey,
  cardDedupKey,
} from './migrate.js'

export const PENDING_TTL_MS = 15 * 60 * 1000
const MIGRATION_REVEAL_CAP = 50

export class EngineError extends Error {
  constructor(status, error, message) {
    super(message ?? error)
    this.status = status
    this.error = error
  }
}

export function createServerEngine({ clock, store, signer, config, logger } = {}) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function')
  if (!store) throw new TypeError('store is required')
  if (!signer) throw new TypeError('signer is required')
  if (!config) throw new TypeError('config is required')
  const log = logger ?? (() => {})
  const keyIssuedAtMs = clock()

  function now() {
    return clock()
  }

  function requireCampaign(campaignId) {
    const campaign = config.getCampaign(campaignId)
    if (!campaign) throw new EngineError(404, 'unknown-campaign')
    return campaign
  }

  function requireSession(sid) {
    const session = sid ? store.getSession(sid) : null
    if (!session) throw new EngineError(401, 'no-session')
    return session
  }

  /** 当前有效记账日（UTC+8 + 回拨防护），并更新单调基线 */
  function effectiveDay(session) {
    const nowMs = now()
    const current = dayKeyForNow(nowMs)
    const resolved = resolveEffectiveDay(session.maxObservedDayKey, current)
    const anomaly = resolved.anomaly || nowMs < (session.maxObservedMs ?? nowMs)
    store.noteClock(session, { currentDayKey: current, nowMs })
    return { dayKey: resolved.dayKey, anomaly, nowMs }
  }

  function chancesLeftFor(campaign, sid, dayKey) {
    const record = store.getDay(sid, campaign.campaignId, dayKey)
    const used = record ? record.chancesUsed : 0
    return Math.max(0, campaign.dailyChances - used)
  }

  function findCard(sid, campaignId, cardId) {
    const latest = store.latestCards(sid, campaignId)
    const record = latest.get(cardId) ?? null
    return record
  }

  /** 唯一对外卡片视图：pending 只暴露 commitment，绝不泄露 seed/prize */
  function publicCardView(record) {
    const view = {
      cardId: record.cardId,
      campaignId: record.campaignId,
      status: record.status === 'pending-expired' ? 'pending' : record.status,
      rev: record.rev,
      commitment: record.commitment,
      expiresAt: record.expiresAt,
    }
    if (record.status === 'revealed' || record.status === 'claimed') {
      view.prize = { name: record.prize.name, win: Boolean(record.prize.win) }
      view.receipt = record.receipt
    }
    if (record.status === 'claimed') view.claimRef = record.claimRef
    return view
  }

  function buildReceipt(record, serverTime) {
    const prize = { name: record.prize.name, win: Boolean(record.prize.win) }
    const payload = {
      campaignId: record.campaignId,
      cardId: record.cardId,
      seedHex: record.seedHex,
      commitment: record.commitment,
      prize,
      weightsVersion: record.weightsVersion,
      serverTime,
    }
    return {
      seedHex: record.seedHex,
      algorithm: ALGORITHM_ID,
      weightsVersion: record.weightsVersion,
      commitment: record.commitment,
      serverTime,
      signature: signer.signReceipt(payload),
    }
  }

  function campaignSnapshot(campaign, sid, dayKey) {
    const latest = store.latestCards(sid, campaign.campaignId)
    const cards = campaign.cardIds.map((cardId) => {
      const record = latest.get(cardId)
      return record
        ? publicCardView(record)
        : { cardId, campaignId: campaign.campaignId, status: 'idle', rev: 0 }
    })
    return {
      campaignId: campaign.campaignId,
      title: campaign.title,
      dailyChances: campaign.dailyChances,
      chancesLeft: chancesLeftFor(campaign, sid, dayKey),
      cards,
    }
  }

  function fullView(sid, dayKey) {
    return {
      serverTime: toServerTime(now()),
      day: dayKey,
      campaigns: config.campaigns.map((campaign) => campaignSnapshot(campaign, sid, dayKey)),
    }
  }

  async function withSession(sid, fn) {
    const session = requireSession(sid)
    return store.withSidLock(session.sid, () => {
      store.touchSession(session, now())
      return fn(session)
    })
  }

  /** 幂等包裹：命中返回首次响应；同键不同体返回 409 冲突 */
  function idempotent(session, scope, key, fingerprint, producer) {
    if (!key) throw new EngineError(400, 'bad-request', 'Idempotency-Key required')
    const cached = store.getIdempotency(session.sid, scope, key)
    if (cached) {
      if (cached.requestFingerprint !== fingerprint) {
        throw new EngineError(409, 'conflict', 'idempotency key reused with a different request')
      }
      return { ...cached.body, __idempotentReplay: true }
    }
    const body = producer()
    store.putIdempotency(session.sid, scope, key, {
      requestFingerprint: fingerprint,
      status: 200,
      body,
      at: Date.now(),
    })
    return body
  }

  // ---------- session ----------
  function createSession() {
    const nowMs = now()
    const session = store.createSession(nowMs)
    const dayKey = dayKeyForNow(nowMs)
    store.noteClock(session, { currentDayKey: dayKey, nowMs })
    store.appendEvent('session-created', { sid: session.sid, day: dayKey }, nowMs)
    return {
      setCookieSid: session.sid,
      body: {
        sessionRef: session.sid,
        serverTime: toServerTime(nowMs),
        day: dayKey,
        campaigns: config.campaigns.map((campaign) => ({
          campaignId: campaign.campaignId,
          title: campaign.title,
          subtitle: campaign.subtitle,
          dailyChances: campaign.dailyChances,
          cardIds: [...campaign.cardIds],
        })),
      },
    }
  }

  // ---------- begin ----------
  async function begin(sid, { campaignId, cardId, idempotencyKey }) {
    return withSession(sid, (session) => {
      const campaign = requireCampaign(campaignId)
      if (!campaign.cardIds.includes(cardId)) throw new EngineError(400, 'unknown-card')
      const fingerprint = `${campaignId}|${cardId}`
      return idempotent(session, 'begin', idempotencyKey, fingerprint, () => {
        const { dayKey, nowMs } = effectiveDay(session)
        // 当日记录按日记账本键隔离：次日同一 cardId 是一次全新刮卡
        const sameDay = store.getCard(session.sid, campaignId, dayKey, cardId)
        if (sameDay && (sameDay.status === 'revealed' || sameDay.status === 'claimed')) {
          // 当日已揭晓/已领取：不扣费、不重摇
          return { ok: false, reason: 'invalid-state', card: publicCardView(sameDay) }
        }
        if (sameDay && sameDay.status.startsWith('pending')) {
          // 多标签页/不同键：复用同一 pending 与承诺，不新增扣费
          return {
            ok: false,
            reason: 'already-pending',
            card: publicCardView(sameDay),
            chancesLeft: chancesLeftFor(campaign, session.sid, dayKey),
            day: dayKey,
            serverTime: toServerTime(nowMs),
            commitSig: sameDay.commitSig,
          }
        }
        // 跨天未完成的 pending 仍归属原卡（设计 2.6：不退次、不重摇），
        // 同一天只允许一个进行中的 pending
        const existing = sameDay ?? findCard(session.sid, campaignId, cardId)
        if (existing && existing.status.startsWith('pending') && existing.day !== dayKey) {
          return {
            ok: false,
            reason: 'already-pending',
            card: publicCardView(existing),
            chancesLeft: chancesLeftFor(campaign, session.sid, dayKey),
            day: dayKey,
            serverTime: toServerTime(nowMs),
            commitSig: existing.commitSig,
          }
        }
        if (chancesLeftFor(campaign, session.sid, dayKey) <= 0) {
          return { ok: false, reason: 'no-chances', chancesLeft: 0, day: dayKey, serverTime: toServerTime(nowMs) }
        }

        const weightsVersion = campaign.weightsVersion
        const weights = config.getWeights(campaignId, weightsVersion)
        if (!weights) throw new EngineError(500, 'bad-request', 'weights table missing')
        const seedHex = generateSeedHex()
        const prize = drawPrize(weights, seedHex)
        const commitment = computeCommitment(seedHex, campaignId, cardId, weightsVersion)
        const expiresAt = toServerTime(nowMs + PENDING_TTL_MS)

        const record = {
          sid: session.sid,
          campaignId,
          cardId,
          status: 'pending',
          rev: 1,
          day: dayKey,
          weightsVersion,
          weightsSnapshot: weights.map((prize) => ({ ...prize })),
          seedHex,
          prize,
          commitment,
          beginAt: nowMs,
          expiresAt,
          commitSig: null,
          receipt: null,
          revealedAt: null,
          claimedAt: null,
          claimRef: null,
        }
        const commitSig = signer.signCommitment({
          campaignId,
          cardId,
          commitment,
          expiresAt,
          day: dayKey,
        })
        record.commitSig = commitSig

        // 承诺事件（不含 seed/prize）先于任何含秘密的记录/下发事件落盘
        store.appendEvent(
          'commitment-created',
          { sid: session.sid, campaignId, cardId, day: dayKey, rev: 1, commitment, weightsVersion },
          nowMs,
        )
        const day = store.ensureDay(session.sid, campaignId, dayKey, nowMs)
        day.chancesUsed += 1
        day.updatedAt = nowMs
        store.putCard(record, nowMs)
        store.appendEvent(
          'pending-stored',
          { sid: session.sid, campaignId, cardId, day: dayKey, rev: 1 },
          nowMs,
        )
        log({ level: 'info', event: 'begin', sid: session.sid, campaignId, cardId, day: dayKey, rev: 1 })

        return {
          ok: true,
          card: publicCardView(record),
          chancesLeft: chancesLeftFor(campaign, session.sid, dayKey),
          day: dayKey,
          serverTime: toServerTime(nowMs),
          commitSig,
        }
      })
    })
  }

  // ---------- reveal ----------
  async function reveal(sid, { campaignId, cardId, expectedRev, idempotencyKey }) {
    return withSession(sid, (session) => {
      const campaign = requireCampaign(campaignId)
      if (!campaign.cardIds.includes(cardId)) throw new EngineError(400, 'unknown-card')
      const fingerprint = `${campaignId}|${cardId}`
      return idempotent(session, 'reveal', idempotencyKey, fingerprint, () => {
        const { dayKey, nowMs } = effectiveDay(session)
        const record = findCard(session.sid, campaignId, cardId)
        if (!record) return { ok: false, reason: 'invalid-state', serverTime: toServerTime(nowMs) }
        if (record.status === 'claimed') {
          return {
            ok: true,
            card: publicCardView(record),
            chancesLeft: chancesLeftFor(campaign, session.sid, dayKey),
            serverTime: toServerTime(nowMs),
          }
        }
        if (record.status === 'revealed') {
          // 网络重试（可能换 key）：幂等返回同一结果与同一 receipt
          return {
            ok: true,
            card: publicCardView(record),
            chancesLeft: chancesLeftFor(campaign, session.sid, dayKey),
            serverTime: toServerTime(nowMs),
          }
        }
        if (!record.status.startsWith('pending')) {
          return { ok: false, reason: 'invalid-state', card: publicCardView(record), serverTime: toServerTime(nowMs) }
        }
        if (expectedRev != null && Number(expectedRev) !== record.rev) {
          return { ok: false, reason: 'conflict', card: publicCardView(record), serverTime: toServerTime(nowMs) }
        }

        // 响应前自检：承诺一致 + 结果可由 seed 复算（防服务端自身 bug）。
        // 权重按 begin 时快照固化：之后切换权重表不影响历史卡（验收 D23）。
        const weights = record.weightsSnapshot ?? config.getWeights(record.campaignId, record.weightsVersion)
        const recomputedCommitment = computeCommitment(
          record.seedHex,
          record.campaignId,
          record.cardId,
          record.weightsVersion,
        )
        if (recomputedCommitment !== record.commitment) {
          log({ level: 'error', event: 'commitment-self-check-failed', cardId, campaignId, rev: record.rev })
          throw new EngineError(500, 'invalid-state', 'server self-check failed')
        }
        if (weights) {
          const recomputedPrize = drawPrize(weights, record.seedHex)
          if (recomputedPrize.name !== record.prize.name || recomputedPrize.win !== Boolean(record.prize.win)) {
            log({ level: 'error', event: 'prize-self-check-failed', cardId, campaignId, rev: record.rev })
            throw new EngineError(500, 'invalid-state', 'server self-check failed')
          }
        }

        const revealedAt = toServerTime(nowMs)
        record.status = 'revealed'
        record.rev += 1
        record.revealedAt = revealedAt
        record.receipt = buildReceipt(record, revealedAt)
        store.putCard(record, nowMs)
        store.appendEvent(
          'card-revealed',
          {
            sid: session.sid,
            campaignId,
            cardId,
            day: record.day,
            rev: record.rev,
          },
          nowMs,
        )
        log({ level: 'info', event: 'reveal', sid: session.sid, campaignId, cardId, rev: record.rev })

        return {
          ok: true,
          card: publicCardView(record),
          chancesLeft: chancesLeftFor(campaign, session.sid, dayKey),
          serverTime: toServerTime(nowMs),
        }
      })
    })
  }

  // ---------- claim ----------
  async function claim(sid, { campaignId, cardId, idempotencyKey }) {
    return withSession(sid, (session) => {
      const campaign = requireCampaign(campaignId)
      if (!campaign.cardIds.includes(cardId)) throw new EngineError(400, 'unknown-card')
      const fingerprint = `${campaignId}|${cardId}`
      return idempotent(session, 'claim', idempotencyKey, fingerprint, () => {
        const { nowMs } = effectiveDay(session)
        const record = findCard(session.sid, campaignId, cardId)
        if (!record) return { ok: false, reason: 'invalid-state', serverTime: toServerTime(nowMs) }
        if (record.status === 'claimed') {
          return { ok: false, reason: 'already-claimed', card: publicCardView(record), serverTime: toServerTime(nowMs) }
        }
        if (record.status !== 'revealed') {
          return { ok: false, reason: 'invalid-state', card: publicCardView(record), serverTime: toServerTime(nowMs) }
        }

        // 状态机（会话级临界区 + revealed 前驱校验）已保证先到先得；
        // dedupKey 在领取成功后永久落 ledger，供迁移防重领核对
        const dedupKey = record.dedupKey ?? cardDedupKey(
          session.sid,
          record.campaignId,
          record.cardId,
          record.weightsVersion,
          record.seedHex,
        )

        const claimRef = record.claimRef ?? `claim_${randomUUID()}`
        record.status = 'claimed'
        record.rev += 1
        record.claimRef = claimRef
        record.claimedAt = toServerTime(nowMs)
        store.addClaim(dedupKey)
        store.putCard(record, nowMs)
        store.appendEvent(
          'card-claimed',
          { sid: session.sid, campaignId, cardId, day: record.day, rev: record.rev },
          nowMs,
        )
        log({ level: 'info', event: 'claim', sid: session.sid, campaignId, cardId, rev: record.rev })

        return { ok: true, card: publicCardView(record), serverTime: toServerTime(nowMs) }
      })
    })
  }

  // ---------- read-only ----------
  async function state(sid, campaignId) {
    return withSession(sid, (session) => {
      const { dayKey } = effectiveDay(session)
      if (campaignId) {
        const campaign = requireCampaign(campaignId)
        const view = fullView(session.sid, dayKey)
        view.campaigns = view.campaigns.filter((item) => item.campaignId === campaign.campaignId)
        return view
      }
      return fullView(session.sid, dayKey)
    })
  }

  async function recover(sid) {
    return withSession(sid, (session) => {
      const { dayKey, anomaly } = effectiveDay(session)
      const view = fullView(session.sid, dayKey)
      view.clockAnomaly = anomaly
      view.campaigns = view.campaigns.map((snapshot) => {
        const meta = config.getCampaign(snapshot.campaignId)
        return {
          ...snapshot,
          subtitle: meta.subtitle,
          cardIds: [...meta.cardIds],
        }
      })
      return view
    })
  }

  function verificationKey() {
    return {
      alg: signer.alg,
      publicKeyHex: signer.publicKeyDerHex,
      keyId: signer.keyId,
      issuedAt: toServerTime(keyIssuedAtMs),
    }
  }

  function health() {
    return { ok: true, serverTime: toServerTime(now()) }
  }

  // ---------- migration import（本轮只实现服务端逻辑，不接前端） ----------
  async function migrateImport(sid, { payload, payloadHash, idempotencyKey }) {
    return withSession(sid, (session) =>
      idempotent(
        session,
        'migrate',
        idempotencyKey,
        payloadHash ?? createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex'),
        () => {
        const { dayKey, nowMs } = effectiveDay(session)
        const envelopes = normalizeEnvelopes(payload)
        const imported = { claimed: [], revealed: [] }
        const discarded = { spentUnrevealed: [], idleUnspent: [], unknownCampaign: [], capped: [], unknownCard: [] }
        let revealableImported = store.getMeta(`migrate-reveal-count#${session.sid}`, 0) ?? 0

        for (const { campaignId, envelope } of envelopes) {
          const campaign = config.getCampaign(campaignId)
          if (!campaign) {
            discarded.unknownCampaign.push(campaignId)
            continue
          }
          const classified = classifyEnvelope(campaignId, envelope)
          const recordDay = /^\d{4}-\d{2}-\d{2}$/.test(classified.day ?? '') ? classified.day : dayKey

          for (const item of classified.claimed) {
            if (!campaign.cardIds.includes(item.cardId)) {
              discarded.unknownCard.push({ campaignId, cardId: item.cardId })
              continue
            }
            const dedupKey = migrationDedupKey(session.sid, campaignId, recordDay, item.cardId)
            if (store.hasClaim(dedupKey)) {
              imported.claimed.push({ campaignId, cardId: item.cardId, dedup: true })
              continue
            }
            store.addClaim(dedupKey)
            store.appendEvent(
              'migration-claimed-registered',
              { sid: session.sid, campaignId, cardId: item.cardId, day: recordDay },
              nowMs,
            )
            imported.claimed.push({ campaignId, cardId: item.cardId })
          }

          for (const item of classified.revealed) {
            if (!campaign.cardIds.includes(item.cardId)) {
              discarded.unknownCard.push({ campaignId, cardId: item.cardId })
              continue
            }
            const dedupKey = migrationDedupKey(session.sid, campaignId, recordDay, item.cardId)
            if (store.hasClaim(dedupKey)) {
              // 已领取（或 claimed 历史登记）：永久去重，不产生第二张待领卡
              imported.revealed.push({ campaignId, cardId: item.cardId, dedup: true })
              continue
            }
            if (store.findCardByDedupKey(dedupKey)) {
              // 同一份数据在领取前被二次导入：复用已登记的 revealed 卡，不新建
              imported.revealed.push({ campaignId, cardId: item.cardId, dedup: true })
              continue
            }
            if (revealableImported >= MIGRATION_REVEAL_CAP) {
              discarded.capped.push({ campaignId, cardId: item.cardId })
              continue
            }
            const weightsVersion = campaign.weightsVersion
            // 旧 32bit seed 仅作历史重算线索；该结果在客户端早已可知，不再视为未揭晓秘密
            const seedHex = item.seedHex ?? null
            const record = {
              sid: session.sid,
              campaignId,
              cardId: item.cardId,
              status: 'revealed',
              rev: 1,
              day: recordDay,
              weightsVersion,
              seedHex,
              prize: item.prize,
              commitment: null,
              beginAt: nowMs,
              expiresAt: null,
              commitSig: null,
              receipt: null,
              revealedAt: toServerTime(nowMs),
              claimedAt: null,
              claimRef: null,
              dedupKey,
              migrated: true,
            }
            record.receipt = buildReceipt(record, record.revealedAt)
            store.putCard(record, nowMs)
            revealableImported = store.incrementMeta(`migrate-reveal-count#${session.sid}`)
            store.appendEvent(
              'migration-revealed-registered',
              { sid: session.sid, campaignId, cardId: item.cardId, day: recordDay },
              nowMs,
            )
            imported.revealed.push({ campaignId, cardId: item.cardId })
          }

          for (const item of classified.spentUnrevealed) {
            // 策略 B：已扣费未揭晓的本地开奖数据作废为只读历史，不退次、不重摇
            discarded.spentUnrevealed.push({ campaignId, cardId: item.cardId })
            store.appendEvent(
              'migration-spent-unrevealed-discarded',
              { sid: session.sid, campaignId, cardId: item.cardId, day: recordDay },
              nowMs,
            )
          }
          for (const item of classified.idleUnspent) {
            discarded.idleUnspent.push({ campaignId, cardId: item.cardId })
          }
        }

        log({ level: 'info', event: 'migrate-import', sid: session.sid, day: dayKey })
        return { ok: true, imported, discarded }
        },
      ),
    )
  }

  return {
    clock,
    signer,
    config,
    createSession,
    begin,
    reveal,
    claim,
    state,
    recover,
    verificationKey,
    health,
    migrateImport,
  }
}
