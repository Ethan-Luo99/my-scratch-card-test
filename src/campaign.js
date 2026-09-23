/**
 * 活动引擎（实例化装配层）：把纯逻辑模块（状态机 / 迁移 / 时间判定 / PRNG）
 * 与基础设施（KV 后端 / 跨标签页同步通道 / 互斥锁）组装成一个可独立运行的
 * 活动实例。所有可变状态都闭包在实例内，模块级无任何跨实例共享的可变状态，
 * 因此页面可同时运行多个互不影响的活动。
 *
 * 跨标签页一致性设计：
 * - 每次变更都是一个"读-改-写"临界区：从存储读最新信封 -> 纯函数迁移 ->
 *   rev+1 写回 -> 广播轻量通知（只带 rev，不带状态，接收方回存储取数，
 *   天然避免消息回放旧状态与回环风暴）；
 * - 临界区优先由 Web Locks（navigator.locks）跨标签页串行化，崩溃自动释放；
 *   不可用时退化为标签页内 Promise 链互斥，此时跨标签页并发靠两条不变量兜底：
 *   1) 扣次数只在"读到的值 < 上限"时 +1，落盘值永不超过 dailyChances；
 *   2) sanitizeDailyState 在每次读入时按上限钳制；
 *   因此任意操作序列下，存储中的累计扣减都不可能越过每日上限（防多开刷次数），
 *   代价仅是极端并发下可能出现"丢失更新"（少计次数，属于保守方向），
 *   是可接受的降级语义；
 * - claim 先到先得：两个标签页同时领取同一卡时，后到者在临界区内读到
 *   已 claimed 的快照，迁移返回 invalid-state，调用方据此提示冲突；
 * - 跨天/时间回拨在每个临界区内先做 applyRollover 再迁移，保证所有标签页
 *   对"今天算哪一天"的判定一致。
 */
import { migrateData } from './lib/migration.js'
import {
  CARD_STATE,
  createDailyState,
  sanitizeDailyState,
  applyRollover,
  transitionBegin,
  transitionReveal,
  transitionClaim,
  normalizeAfterReload,
} from './lib/state-machine.js'
import { resolveDay, localDateString } from './lib/time.js'
import { generateSeed, drawPrize, fnv1aHex } from './lib/randomness.js'
import { createSyncChannel, createLockManager, createSenderId } from './storage/sync.js'

export { CARD_STATE }

export const STORAGE_KEY_PREFIX = 'scratch-campaign:v2:'

export function createCampaign({
  namespace,
  cardIds,
  prizes,
  dailyChances,
  backend,
  legacyKey = null,
  locksApi,
  channelFactory,
  now = () => new Date(),
  cryptoObject,
}) {
  const key = STORAGE_KEY_PREFIX + namespace
  const senderId = createSenderId()
  const lockManager = createLockManager(locksApi)
  const channel = createSyncChannel({ name: key, backend, channelFactory, senderId })
  const listeners = new Set()

  const migrateCtx = {
    cardIds,
    dailyChances,
    createDailyStateFn: createDailyState,
    sanitizeFn: sanitizeDailyState,
  }

  let envelope = loadInitial()

  channel.onChange(() => reloadFromStorage())

  function currentDate() {
    return localDateString(now())
  }

  /** 从存储读最新信封（含版本迁移与字段清洗；不处理跨天，由调用方决定） */
  function readEnvelope() {
    let parsed = null
    try {
      const raw = backend.getItem(key)
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    return migrateData(parsed, { date: currentDate(), ...migrateCtx }).envelope
  }

  function writeEnvelope(env) {
    try {
      backend.setItem(key, JSON.stringify(env))
    } catch {
      // 序列化失败不应崩溃；后端自身已处理降级
    }
  }

  /** 跨天/回拨结算；有变化时落盘并广播（所有标签页判定结果一致） */
  function rolloverIfNeeded(env) {
    const rolled = applyRollover(env.state, {
      cardIds,
      currentDate: currentDate(),
      resolveDayFn: resolveDay,
    })
    if (rolled.changed) {
      env.state = rolled.state
      env.rev = (Number(env.rev) || 0) + 1
      writeEnvelope(env)
      channel.post(env.rev)
    }
    return env
  }

  /** 首次加载：读新 key -> 无则尝试旧版 key 无损迁移 -> 刷新恢复 -> 跨天结算 */
  function loadInitial() {
    let raw = null
    try {
      raw = backend.getItem(key)
    } catch {
      raw = null
    }
    let migrated = false
    if (raw == null && legacyKey) {
      try {
        const legacyRaw = backend.getItem(legacyKey)
        if (legacyRaw != null) {
          raw = legacyRaw
          migrated = true
        }
      } catch {
        // 旧数据读不到就当没有，不影响主流程
      }
    }
    let parsed = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    const { envelope: env } = migrateData(parsed, { date: currentDate(), ...migrateCtx })
    // 刷新恢复：进行中的 scratching 回退 idle（次数不退、奖品不重摇）
    env.state = normalizeAfterReload(env.state)
    env.rev = (Number(env.rev) || 0) + 1
    writeEnvelope(env)
    if (migrated) {
      // 迁移成功后移除旧 key，避免下次加载重复迁移覆盖新数据
      try {
        backend.removeItem(legacyKey)
      } catch {
        // 删不掉就留着，下次迁移结果相同，幂等
      }
    }
    rolloverIfNeeded(env)
    channel.post(env.rev)
    return env
  }

  /** 采用新快照：内容有变化才通知订阅者（避免无意义重渲染） */
  function adoptEnvelope(env) {
    const changed = JSON.stringify(env.state) !== JSON.stringify(envelope.state)
    envelope = env
    if (changed) {
      for (const fn of listeners) {
        try {
          fn(envelope.state)
        } catch {
          // 单个订阅者异常不影响引擎
        }
      }
    }
  }

  /** 其他标签页有写入：回存储取最新快照并收敛本地状态（只读，不写不回广播） */
  function reloadFromStorage() {
    const env = rolloverIfNeeded(readEnvelope())
    adoptEnvelope(env)
  }

  /**
   * 所有状态变更的唯一入口：在互斥锁内执行 读最新 -> 纯迁移 -> 写回 -> 广播。
   * transition 是纯函数 (state) => { state, result }，失败则不落盘。
   */
  function commit(transition) {
    const run = () => {
      const env = rolloverIfNeeded(readEnvelope())
      const { state, result } = transition(env.state)
      if (result.ok) {
        env.state = state
        env.rev = (Number(env.rev) || 0) + 1
        writeEnvelope(env)
        channel.post(env.rev)
      }
      // 无论成败都采用本次读到的快照：失败通常意味着本地状态落后于
      // 其他标签页（如已被领取），借此收敛 UI
      adoptEnvelope(env)
      return result
    }
    return Promise.resolve(lockManager.withLock(key, run))
  }

  return {
    namespace,
    dailyChances,
    prizes,
    /** 当前是否真正落盘（false = 内存降级，单标签页语义） */
    get isPersistent() {
      return backend.isPersistent
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getSnapshot: () => envelope.state,
    getCard: (id) => envelope.state.cards[id],
    getChancesLeft: () => Math.max(0, dailyChances - envelope.state.chancesUsed),
    isTimeAnomaly: () => Boolean(envelope.state.timeAnomaly),

    /**
     * 同步预检（基于本地快照的快速路径，供指针事件同步决策）；
     * 真正的校验在 commit 临界区内基于最新快照重做。
     */
    canBegin(id) {
      const card = envelope.state.cards[id]
      if (!card) return { ok: false, reason: 'unknown-card' }
      if (card.state !== CARD_STATE.IDLE && card.state !== CARD_STATE.SCRATCHING) {
        return { ok: false, reason: 'invalid-state' }
      }
      if (!card.chanceSpent && envelope.state.chancesUsed >= dailyChances) {
        return { ok: false, reason: 'no-chances' }
      }
      return { ok: true }
    },

    /** idle -> scratching：首次扣次数、生成 seed 并锁定奖品（异步，锁内完成） */
    beginScratch(id) {
      return commit((state) =>
        transitionBegin(state, {
          cardId: id,
          dailyChances,
          prizes,
          seed: generateSeed(cryptoObject),
        }),
      )
    },

    /** scratching -> revealed（异步，锁内完成） */
    reveal(id) {
      return commit((state) => transitionReveal(state, { cardId: id }))
    },

    /** revealed -> claimed：先到先得，冲突方收到 invalid-state */
    claim(id) {
      return commit((state) => transitionClaim(state, { cardId: id }))
    },

    /** 可验证公平性凭证：seed + FNV-1a 哈希 + 用同一 seed 重算的奖品 */
    getFairnessProof(id) {
      const card = envelope.state.cards[id]
      if (!card || card.seed == null || !card.seedHash) return null
      return {
        seed: card.seed,
        seedHash: card.seedHash,
        recomputed: drawPrize(prizes, card.seed),
        hashMatches: fnv1aHex(String(card.seed)) === card.seedHash,
      }
    },

    destroy() {
      channel.destroy()
      listeners.clear()
    },
  }
}
