/**
 * 服务端权威引擎（纯逻辑，无 HTTP / 无 DOM）。
 * 职责：会话、begin/reveal/claim 状态机、每日次数原子记账、
 * 承诺—揭晓（SHA-256 + Ed25519）、幂等键去重、跨天/回拨、迁移导入。
 * 所有写操作在 store.withSessionLock 临界区内完成"读—改—写"。
 */
import { randomBytes, createHash } from 'node:crypto'
import { isoTime, createMonotonicClock } from './time.js'
import { generateSeedHex, computeCommitment, createSigner, RECEIPT_ALGORITHM } from './crypto.js'
import { CAMPAIGNS, drawPrize, findCampaign } from './draw.js'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const PENDING_TTL_MS = 15 * 60 * 1000
const MIGRATION_WIN_CLAIM_CAP = 100
const LEGACY_WEIGHTS_VERSION = 'legacy-import'

export function createEngine({
  clock = () => Date.now(),
  store,
  signer = null,
  rng = null,
  campaigns = CAMPAIGNS,
  timezoneOffsetMinutes = 8 * 60,
  pendingTtlMs = PENDING_TTL_MS,
  idempotencyTtlMs = IDEMPOTENCY_TTL_MS,
  migrationWinClaimCap = MIGRATION_WIN_CLAIM_CAP,
  weightsRegistry = {},
} = {}) {
  if (!store) throw new Error('createEngine: store is required')
  const signerImpl = signer || createSigner()
  const monotonic = createMonotonicClock(clock)
  const seedRng = rng || ((n) => randomBytes(n))
  // 权重版本注册表：campaignId#weightsVersion -> 奖池快照。
  // 旧卡 reveal 自检按 begin 时固化的版本结算，切换权重表不影响历史承诺。
  const registry = new Map()
  for (const campaign of campaigns) {
    registry.set(`${campaign.campaignId}#${campaign.weightsVersion}`, campaign.prizes)
  }
  for (const [key, prizes] of Object.entries(weightsRegistry)) {
    registry.set(key, prizes)
  }

  function tick() {
    const { nowMs, dayKey, clockAnomaly } = monotonic.observe(timezoneOffsetMinutes)
    if (clockAnomaly) {
      store.recordClockAnomaly({
        at: isoTime(nowMs),
        observedMs: Number(clock()),
        baselineMs: nowMs,
      })
    }
    return { nowMs, dayKey }
  }

  function newSid() {
    return randomBytes(16).toString('hex')
  }

  function newClaimRef() {
    return `claim_${randomBytes(12).toString('hex')}`
  }

  function newImportRef() {
    return `import_${randomBytes(12).toString('hex')}`
  }

  function sha256Hex(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }

  /** 卡片公开视图：未揭晓绝不含 seed/prize/receipt（保密不变量唯一出口） */
  function publicCard(card) {
    const view = {
      cardId: card.cardId,
      campaignId: card.campaignId,
      status: card.status,
      rev: card.rev,
    }
    if (card.status === 'pending') {
      view.commitment = card.commitment
      view.expiresAt = card.expiresAt
    }
    if (card.status === 'revealed' || card.status === 'claimed') {
      view.prize = { name: card.prize.name, win: card.prize.win }
      view.receipt = card.receipt
    }
    if (card.status === 'claimed') {
      view.claimRef = card.claimRef
    }
    return view
  }

  function getOrCreateDay(sid, campaignId, dayKey, nowMs) {
    let record = store.getDay(sid, campaignId, dayKey)
    if (!record) {
      record = { chancesUsed: 0, createdAt: isoTime(nowMs), updatedAt: isoTime(nowMs) }
      store.putDay(sid, campaignId, dayKey, record)
    }
    return record
  }

  function persistDay(sid, campaignId, dayKey, record) {
    store.putDay(sid, campaignId, dayKey, record)
    store.appendEvent({
      type: 'day-upsert',
      sid,
      day: { campaignId, day: dayKey, record },
    })
  }

  function persistCard(card) {
    store.putCard(card)
    store.appendEvent({ type: 'card-upsert', card })
  }

  function chancesLeftOf(campaign, dayRecord) {
    return Math.max(0, campaign.dailyChances - dayRecord.chancesUsed)
  }

  function idemScope(route, sid, campaignId) {
    return `${route}#${sid}#${campaignId}`
  }

  function fingerprint(route, campaignId, body) {
    return sha256Hex(JSON.stringify({ route, campaignId, body: body ?? null }))
  }

  /** 命中幂等缓存：指纹一致返回缓存响应；同键不同体返回冲突 */
  function checkIdempotent(scope, key, fp, nowMs) {
    if (!key) return { hit: false }
    const entry = store.getIdempotent(scope, key, { ttlMs: idempotencyTtlMs, nowMs })
    if (!entry) return { hit: false }
    if (entry.response.fp !== fp) {
      return { conflict: true }
    }
    return { hit: true, response: entry.response.body }
  }

  function saveIdempotent(scope, key, fp, body, nowMs) {
    if (!key) return
    store.putIdempotent(scope, key, { fp, body }, nowMs)
  }

  function requireSession(sid) {
    if (!sid) return null
    const session = store.getSession(sid)
    if (!session) return null
    session.lastSeenAt = isoTime(tick().nowMs)
    store.putSession(session)
    return session
  }

  function campaignCardsView(sid, campaign) {
    const records = store.listCards(sid, campaign.campaignId)
    const byId = new Map(records.map((r) => [r.cardId, r]))
    const cards = []
    for (const cardId of campaign.cardIds) {
      const record = byId.get(cardId)
      if (record) cards.push(publicCard(record))
    }
    return cards
  }

  function campaignMeta(campaign) {
    return {
      campaignId: campaign.campaignId,
      title: campaign.title,
      subtitle: campaign.subtitle,
      dailyChances: campaign.dailyChances,
      cardIds: [...campaign.cardIds],
    }
  }

  function stateView(sid, campaignId) {
    const { nowMs, dayKey } = tick()
    const selected = campaignId
      ? campaigns.filter((c) => c.campaignId === campaignId)
      : campaigns
    const view = {
      serverTime: isoTime(nowMs),
      day: dayKey,
      campaigns: selected.map((campaign) => {
        const dayRecord = getOrCreateDay(sid, campaign.campaignId, dayKey, nowMs)
        return {
          campaignId: campaign.campaignId,
          chancesLeft: chancesLeftOf(campaign, dayRecord),
          dailyChances: campaign.dailyChances,
          cards: campaignCardsView(sid, campaign),
        }
      }),
    }
    return view
  }

  function createSession() {
    const { nowMs, dayKey } = tick()
    const sid = newSid()
    store.putSession({ sid, createdAt: isoTime(nowMs), lastSeenAt: isoTime(nowMs) })
    store.appendEvent({ type: 'session-created', sid, at: isoTime(nowMs) })
    const body = {
      sessionRef: sha256Hex(sid).slice(0, 16),
      serverTime: isoTime(nowMs),
      day: dayKey,
      campaigns: campaigns.map(campaignMeta),
    }
    return { sid, body }
  }

  /**
   * begin：占用一次机会。原子事务：校验 → 判次数 → 生成 128bit seed →
   * 摇奖（仅服务端）→ 承诺 → 写 pending → 扣 1 次。响应只含承诺。
   */
  async function begin(sid, campaignId, body, idemKey) {
    const session = requireSession(sid)
    if (!session) return { ok: false, reason: 'no-session' }
    return store.withSessionLock(sid, async () => {
      const { nowMs, dayKey } = tick()
      const serverTime = isoTime(nowMs)
      const campaign = findCampaign(campaigns, campaignId)
      if (!campaign) return { ok: false, reason: 'unknown-campaign' }
      const cardId = body && typeof body.cardId === 'string' ? body.cardId : null
      if (!cardId || !campaign.cardIds.includes(cardId)) {
        return { ok: false, reason: 'unknown-card' }
      }
      const scope = idemScope('begin', sid, campaignId)
      const fp = fingerprint('begin', campaignId, { cardId })
      const idem = checkIdempotent(scope, idemKey, fp, nowMs)
      if (idem.conflict) return { ok: false, reason: 'conflict' }
      if (idem.hit) return idem.response

      const dayRecord = getOrCreateDay(sid, campaignId, dayKey, nowMs)
      const existing = store.getCard(sid, campaignId, cardId)
      let result
      if (existing && existing.status === 'pending') {
        result = {
          ok: false,
          reason: 'already-pending',
          card: publicCard(existing),
          chancesLeft: chancesLeftOf(campaign, dayRecord),
          day: dayKey,
          serverTime,
        }
      } else if (existing) {
        result = { ok: false, reason: 'invalid-state', card: publicCard(existing) }
      } else if (dayRecord.chancesUsed >= campaign.dailyChances) {
        result = { ok: false, reason: 'no-chances', chancesLeft: 0, day: dayKey, serverTime }
      } else {
        const seedHex = generateSeedHex(seedRng)
        const weightsVersion = campaign.weightsVersion
        const prize = drawPrize(campaign.prizes, seedHex)
        const commitment = computeCommitment({ seedHex, campaignId, cardId, weightsVersion })
        const expiresAt = isoTime(nowMs + pendingTtlMs)
        const card = {
          sid,
          campaignId,
          cardId,
          status: 'pending',
          rev: 1,
          day: dayKey,
          weightsVersion,
          seedHex,
          prize,
          commitment,
          beginAt: serverTime,
          expiresAt,
        }
        dayRecord.chancesUsed += 1
        dayRecord.updatedAt = serverTime
        persistDay(sid, campaignId, dayKey, dayRecord)
        persistCard(card)
        const commitSig = signerImpl.signPayload({
          campaignId,
          cardId,
          commitment,
          expiresAt,
          day: dayKey,
        })
        result = {
          ok: true,
          card: publicCard(card),
          chancesLeft: chancesLeftOf(campaign, dayRecord),
          day: dayKey,
          serverTime,
          commitSig,
        }
      }
      saveIdempotent(scope, idemKey, fp, result, nowMs)
      return result
    })
  }

  function buildReceipt(card, serverTime) {
    const receipt = {
      seedHex: card.seedHex,
      algorithm: RECEIPT_ALGORITHM,
      weightsVersion: card.weightsVersion,
      commitment: card.commitment,
      serverTime,
    }
    receipt.signature = signerImpl.signPayload({
      campaignId: card.campaignId,
      cardId: card.cardId,
      seedHex: card.seedHex,
      commitment: card.commitment,
      prize: { name: card.prize.name, win: card.prize.win },
      weightsVersion: card.weightsVersion,
      serverTime,
    })
    return receipt
  }

  /** 服务端自检：承诺与摇奖结果必须可重算一致（防服务端自身 bug） */
  function selfCheck(card) {
    if (card.seedHex === null) return true // 迁移导入的历史卡无 seed，跳过
    const recomputed = computeCommitment({
      seedHex: card.seedHex,
      campaignId: card.campaignId,
      cardId: card.cardId,
      weightsVersion: card.weightsVersion,
    })
    if (recomputed !== card.commitment) return false
    const prizes =
      registry.get(`${card.campaignId}#${card.weightsVersion}`) ||
      findCampaign(campaigns, card.campaignId).prizes
    const redrawn = drawPrize(prizes, card.seedHex)
    return redrawn.name === card.prize.name && redrawn.win === card.prize.win
  }

  /**
   * reveal：pending -> revealed，此刻才生成可下发的 receipt，
   * 是结果第一次可以抵达客户端的时刻。重复 reveal 幂等返回同一结果。
   */
  async function reveal(sid, campaignId, body, idemKey) {
    const session = requireSession(sid)
    if (!session) return { ok: false, reason: 'no-session' }
    return store.withSessionLock(sid, async () => {
      const { nowMs, dayKey } = tick()
      const serverTime = isoTime(nowMs)
      const campaign = findCampaign(campaigns, campaignId)
      if (!campaign) return { ok: false, reason: 'unknown-campaign' }
      const cardId = body && typeof body.cardId === 'string' ? body.cardId : null
      if (!cardId || !campaign.cardIds.includes(cardId)) {
        return { ok: false, reason: 'unknown-card' }
      }
      const expectedRev =
        body && Number.isFinite(Number(body.expectedRev)) ? Number(body.expectedRev) : null
      const scope = idemScope('reveal', sid, campaignId)
      const fp = fingerprint('reveal', campaignId, { cardId, expectedRev })
      const idem = checkIdempotent(scope, idemKey, fp, nowMs)
      if (idem.conflict) return { ok: false, reason: 'conflict' }
      if (idem.hit) return idem.response

      const card = store.getCard(sid, campaignId, cardId)
      const dayRecord = getOrCreateDay(sid, campaignId, dayKey, nowMs)
      const chancesLeft = chancesLeftOf(campaign, dayRecord)
      let result
      if (!card) {
        result = { ok: false, reason: 'invalid-state' }
      } else if (expectedRev !== null && expectedRev !== card.rev) {
        result = { ok: false, reason: 'conflict', card: publicCard(card) }
      } else if (card.status === 'pending') {
        if (!selfCheck(card)) {
          store.appendEvent({
            type: 'self-check-failure',
            campaignId,
            cardId,
            rev: card.rev,
            at: serverTime,
          })
          result = { ok: false, reason: 'internal' }
        } else {
          card.status = 'revealed'
          card.rev += 1
          card.revealedAt = serverTime
          card.receipt = buildReceipt(card, serverTime)
          persistCard(card)
          result = {
            ok: true,
            card: publicCard(card),
            chancesLeft,
            serverTime,
          }
        }
      } else if (card.status === 'revealed' || card.status === 'claimed') {
        // 幂等：同一结果与同一 receipt，不改变状态、不产生第二事件
        result = { ok: true, card: publicCard(card), chancesLeft, serverTime }
      } else {
        result = { ok: false, reason: 'invalid-state', card: publicCard(card) }
      }
      saveIdempotent(scope, idemKey, fp, result, nowMs)
      return result
    })
  }

  function claimDedupKey(card) {
    if (card.claimDedupKey) return card.claimDedupKey
    return `${card.sid}#${card.campaignId}#${card.cardId}#${card.weightsVersion}#${card.seedHex}`
  }

  /**
   * claim：revealed -> claimed（终态）。先到先得，服务端原子裁决；
   * 幂等重试返回同一 claimRef，不重复发奖。
   */
  async function claim(sid, campaignId, body, idemKey) {
    const session = requireSession(sid)
    if (!session) return { ok: false, reason: 'no-session' }
    return store.withSessionLock(sid, async () => {
      const { nowMs } = tick()
      const serverTime = isoTime(nowMs)
      const campaign = findCampaign(campaigns, campaignId)
      if (!campaign) return { ok: false, reason: 'unknown-campaign' }
      const cardId = body && typeof body.cardId === 'string' ? body.cardId : null
      if (!cardId || !campaign.cardIds.includes(cardId)) {
        return { ok: false, reason: 'unknown-card' }
      }
      const scope = idemScope('claim', sid, campaignId)
      const fp = fingerprint('claim', campaignId, { cardId })
      const idem = checkIdempotent(scope, idemKey, fp, nowMs)
      if (idem.conflict) return { ok: false, reason: 'conflict' }
      if (idem.hit) return idem.response

      const card = store.getCard(sid, campaignId, cardId)
      let result
      if (!card) {
        result = { ok: false, reason: 'invalid-state' }
      } else if (card.status === 'revealed') {
        const dedupKey = claimDedupKey(card)
        if (store.getClaim(dedupKey)) {
          result = { ok: false, reason: 'already-claimed', card: publicCard(card) }
        } else {
          card.status = 'claimed'
          card.rev += 1
          card.claimedAt = serverTime
          card.claimRef = newClaimRef()
          persistCard(card)
          const entry = { claimRef: card.claimRef, at: serverTime, source: 'play' }
          store.putClaim(dedupKey, entry)
          store.appendEvent({ type: 'claim', dedupKey, entry })
          result = { ok: true, card: publicCard(card), serverTime }
        }
      } else if (card.status === 'claimed') {
        result = { ok: false, reason: 'already-claimed', card: publicCard(card) }
      } else {
        result = { ok: false, reason: 'invalid-state', card: publicCard(card) }
      }
      saveIdempotent(scope, idemKey, fp, result, nowMs)
      return result
    })
  }

  function getState(sid, campaignId) {
    const session = requireSession(sid)
    if (!session) return { ok: false, reason: 'no-session' }
    if (campaignId && !findCampaign(campaigns, campaignId)) {
      return { ok: false, reason: 'unknown-campaign' }
    }
    return { ok: true, ...stateView(sid, campaignId || null) }
  }

  function recover(sid) {
    const session = requireSession(sid)
    if (!session) return { ok: false, reason: 'no-session' }
    const view = stateView(sid, null)
    const metaById = new Map(campaigns.map((c) => [c.campaignId, campaignMeta(c)]))
    return {
      ok: true,
      ...view,
      campaigns: view.campaigns.map((c) => ({ ...metaById.get(c.campaignId), ...c })),
    }
  }

  function verificationKey() {
    const { nowMs } = tick()
    return {
      alg: 'Ed25519',
      publicKeyHex: signerImpl.publicKeyHex,
      keyId: signerImpl.keyId,
      issuedAt: isoTime(nowMs),
    }
  }

  function healthz() {
    const { nowMs } = tick()
    return { ok: true, serverTime: isoTime(nowMs) }
  }

  /**
   * 迁移导入（仅服务端逻辑）。信任边界：客户端自报数据默认可伪造。
   * - claimed：只登记进 claimsLedger（去重），不补发任何可领额度；
   * - revealed：登记为该会话 revealed 待领记录（可正常 claim），
   *   中奖记录受总量封顶，超出按"历史展示，不可领取"；
   * - chanceSpent 未揭晓（本地带 seed/prize）：策略 B——作废为只读历史，
   *   不导入可玩结果、不退次、不重摇；
   * - idle 未消费：直接丢弃。
   */
  async function migrateImport(sid, body, idemKey) {
    const session = requireSession(sid)
    if (!session) return { ok: false, reason: 'no-session' }
    return store.withSessionLock(sid, async () => {
      const { nowMs, dayKey } = tick()
      const serverTime = isoTime(nowMs)
      const payload = body && typeof body === 'object' ? body.payload : null
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, reason: 'bad-request' }
      }
      if (body.payloadHash !== undefined) {
        const digest = sha256Hex(JSON.stringify(payload))
        if (digest !== body.payloadHash) return { ok: false, reason: 'bad-request' }
      }
      const campaignId =
        typeof body.campaignId === 'string' ? body.campaignId : 'daily'
      const campaign = findCampaign(campaigns, campaignId)
      if (!campaign) return { ok: false, reason: 'unknown-campaign' }

      const scope = idemScope('migrate', sid, campaignId)
      const fp = fingerprint('migrate', campaignId, { payload })
      const idem = checkIdempotent(scope, idemKey, fp, nowMs)
      if (idem.conflict) return { ok: false, reason: 'conflict' }
      if (idem.hit) return idem.response

      const envelopeState =
        payload.version === 2 && payload.state && typeof payload.state === 'object'
          ? payload.state
          : payload
      const legacyCards =
        envelopeState.cards && typeof envelopeState.cards === 'object'
          ? envelopeState.cards
          : {}
      const legacyDay =
        typeof envelopeState.date === 'string' ? envelopeState.date : dayKey

      const imported = { claimed: [], revealed: [] }
      const discarded = { spentUnrevealed: [], idle: [], unknown: [], unclaimable: [] }
      const deduped = []

      const migrationWinCount = () =>
        store
          .listCards(sid, campaignId)
          .filter((c) => c.migrated && c.prize && c.prize.win).length

      for (const [cardId, raw] of Object.entries(legacyCards)) {
        if (!campaign.cardIds.includes(cardId) || !raw || typeof raw !== 'object') {
          discarded.unknown.push({ cardId })
          continue
        }
        const prize =
          raw.prize && typeof raw.prize === 'object' && typeof raw.prize.name === 'string'
            ? { name: raw.prize.name, win: Boolean(raw.prize.win) }
            : null
        const dedupKey = `migrate#${campaignId}#${cardId}#${legacyDay}#${
          prize ? prize.name : 'unknown'
        }`
        const alreadyRegistered =
          store.getClaim(dedupKey) !== null || store.hasMigrationDedup(dedupKey)

        if (raw.state === 'claimed') {
          if (alreadyRegistered) {
            deduped.push({ cardId })
          } else {
            const entry = {
              claimRef: newImportRef(),
              at: serverTime,
              source: 'migrate',
              claimable: false,
            }
            store.putClaim(dedupKey, entry)
            store.appendEvent({ type: 'claim', dedupKey, entry })
            store.putMigrationDedup(dedupKey)
            store.appendEvent({ type: 'migrate-dedup', dedupKey })
            imported.claimed.push({ cardId })
          }
          continue
        }

        if (raw.state === 'revealed' && prize) {
          if (alreadyRegistered || store.getCard(sid, campaignId, cardId)) {
            deduped.push({ cardId })
            continue
          }
          if (prize.win && migrationWinCount() >= migrationWinClaimCap) {
            discarded.unclaimable.push({ cardId })
            continue
          }
          const card = {
            sid,
            campaignId,
            cardId,
            status: 'revealed',
            rev: 1,
            day: legacyDay,
            weightsVersion: LEGACY_WEIGHTS_VERSION,
            seedHex: null,
            prize,
            commitment: null,
            beginAt: serverTime,
            expiresAt: null,
            revealedAt: serverTime,
            migrated: true,
            claimDedupKey: dedupKey,
          }
          card.receipt = buildReceipt(card, serverTime)
          persistCard(card)
          store.putMigrationDedup(dedupKey)
          store.appendEvent({ type: 'migrate-dedup', dedupKey })
          imported.revealed.push({ cardId })
          continue
        }

        if (raw.chanceSpent) {
          // 策略 B：本地已开奖的未揭晓数据作废，不导入、不退次、不重摇
          discarded.spentUnrevealed.push({ cardId })
          continue
        }
        discarded.idle.push({ cardId })
      }

      const result = { ok: true, imported, discarded, deduped, serverTime }
      saveIdempotent(scope, idemKey, fp, result, nowMs)
      return result
    })
  }

  return {
    createSession,
    begin,
    reveal,
    claim,
    getState,
    recover,
    migrateImport,
    verificationKey,
    healthz,
    /** 测试/调试钩子：引擎内部组件只读访问 */
    internals: { store, signer: signerImpl, monotonic },
  }
}
