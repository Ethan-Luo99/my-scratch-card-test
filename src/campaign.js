/**
 * 活动实例引擎（一个活动一个实例，可在同一页面实例化多个）。
 *
 * 职责边界：本模块不直接实现业务规则，规则全部来自纯逻辑模块（src/lib/），
 * 自己只做"内存快照 + 存储信封 + 跨标签页同步 + 订阅分发"的编排；
 * 不引用 DOM / Canvas / window 的全局单例（全部通过 config 注入），
 * 因此同一进程内可并行存在多个完全隔离的活动实例，模块级无可变全局状态。
 *
 * 跨标签页正确性：
 * - 写路径在排他锁（Web Locks，缺 API 时退化本地 Promise 链）内执行
 *   "读最新快照 -> 纯迁移 -> 版本号 CAS 写回"，锁保证序列化，CAS 兜底
 *   所有锁失效场景（如不同源分片 / 锁不可用 / 测试桩），重试到冲突消失；
 * - 同步通道（BroadcastChannel，退化 storage 事件）只广播 { rev } 提示，
 *   接收方回存储拉取新信封，rev 严格递增从而天然避免回环风暴；
 * - claim 与扣次数共用同一 CAS 串行区，并发下状态迁移只有一方成功
 *   （先到先得），失败方拿到 invalid-state 由 UI 提示。
 */
import { migrateData, STORAGE_VERSION, LEGACY_KEY } from './lib/migration.js'
import {
  CARD_STATE,
  createDailyState,
  applyRollover,
  normalizeAfterReload,
  transitionBegin,
  transitionReveal,
  transitionClaim,
  sanitizeDailyState,
} from './lib/state-machine.js'
import { generateSeed, fnv1aHex, mulberry32, drawPrizeIndex } from './lib/randomness.js'
import { localDateString, resolveDay } from './lib/time.js'

export { CARD_STATE }

export function createCampaign(config) {
  const {
    id,
    title,
    key,
    cardIds,
    prizes,
    dailyChances = 3,
    backend,
    syncChannel,
    locks,
    legacyKey = null,
    now = () => new Date(),
    generateSeedFn = generateSeed,
  } = config

  /** 本实例的所有可变状态，仅闭包内持有；新建实例互不可见 */
  const listeners = new Set()
  const lockName = `scratch-campaign:lock:${id}`
  let envelope = null
  let syncedRev = 0
  let destroying = false

  function state() {
    return envelope.state
  }

  /**
   * 读取存储里的最新信封，套用迁移 / 跨天（含时间回拨）规则。
   * @param {{persistIfChanged?: boolean}} options
   */
  function readLatest(options = {}) {
    const currentDate = localDateString(now())
    let usedLegacy = false
    let raw = null
    let parsed = null
    try {
      raw = backend.getItem(key)
      // 新命名空间 key 缺失时，只有显式声明 legacyKey 的活动（每日刮刮卡）
      // 才回退读取旧版单 key 数据；周末卡等其他活动绝不误接管
      if (raw === null && legacyKey) {
        raw = backend.getItem(legacyKey)
        usedLegacy = raw !== null
      }
    } catch {
      raw = null
    }
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    if (!parsed) usedLegacy = false

    const migrated = migrateData(parsed, {
      date: currentDate,
      cardIds,
      maxChances: dailyChances,
      createDailyStateFn: createDailyState,
      sanitizeFn: sanitizeDailyState,
    })
    let env = migrated.envelope

    if (migrated.migrated && usedLegacy) {
      // 旧格式无损迁移：清掉旧 key，避免旧页面残留与重复迁移
      try {
        backend.removeItem(LEGACY_KEY)
      } catch {
        // 后端不支持删除也不影响正确性
      }
    }

    const rolled = applyRollover(env.state, {
      cardIds,
      currentDate,
      resolveDayFn: resolveDay,
    })
    if (rolled.changed) {
      const candidate = { ...env, state: rolled.state }
      env = candidate
      if (options.persistIfChanged) {
        // 读路径自愈（典型：本标签页在后台跨过午夜）：bump rev 后 CAS 写回；
        // 竞争失败说明其他标签页已处理，回读采用获胜版本
        const written = casWrite(bump(candidate), candidate.rev)
        env = written || readLatest().envelope
      }
    }
    return { envelope: env, migrated: migrated.migrated, dayChanged: rolled.changed }
  }

  /**
   * 版本号 CAS 写回：expectedRev 与存储当前 rev 相同才覆盖。
   * 不做任何序列化等待（同事件循环内同步判定），保证锁内的读改写不被穿插；
   * 冲突返回 null 由调用方重试。JSON 序列化失败 / 配额不足均安全降级。
   */
  function casWrite(env, expectedRev) {
    let raw
    try {
      raw = JSON.stringify(env)
    } catch {
      return null
    }
    let currentRaw = null
    try {
      currentRaw = backend.getItem(key)
    } catch {
      currentRaw = null
    }
    if (currentRaw !== null) {
      let currentRev = null
      try {
        const currentEnv = JSON.parse(currentRaw)
        if (currentEnv && typeof currentEnv === 'object') {
          const rev = Number(currentEnv.rev)
          currentRev = Number.isFinite(rev) ? Math.max(0, Math.floor(rev)) : null
        }
      } catch {
        currentRev = null
      }
      // 损坏的存储内容 rev 未知：不信任，当作可覆盖（rev 视为 0）
      if (currentRev !== null && currentRev !== expectedRev) return null
    } else if (expectedRev !== 0) {
      // 存储为空但本地基线非 0：其他环境可能清过数据，保守冲突
      return null
    }
    if (backend.setItem(key, raw) === false && !backend.isPersistent) {
      // 已降级内存：存储里没有对应记录属正常，继续在内存内工作
    }
    return env
  }

  function emit(source) {
    for (const fn of listeners) {
      try {
        fn(state(), { source, anomaly: state().timeAnomaly })
      } catch {
        // 单个订阅者出错不影响引擎
      }
    }
  }

  function bump(env) {
    return { ...env, rev: env.rev + 1 }
  }

  /**
   * 在排他锁内执行"读最新 -> 纯迁移 -> CAS 写回"。
   * @param {(env:object) => object|null} mutate 纯迁移：输入信封，返回新信封或 null 表示放弃
   * @param {{seed?:number}} options 开始刮时注入的 seed
   */
  function commitTransition(apply, options = {}) {
    const run = async (attempt) => {
      const { envelope: latest } = readLatest()
      // apply 为纯迁移：返回 { state, result }；业务失败（no-chances 等）
      // 直接透传 result，不写盘、不重试
      const outcome = apply(latest, options)
      if (!outcome.result.ok) {
        // 业务失败（no-chances / invalid-state 等）：内存快照可能落后于
        // 刚读到的最新状态，先收敛再返回，保证无同步通道时 UI 也能对齐
        if (latest.rev !== syncedRev) {
          envelope = latest
          syncedRev = latest.rev
          emit('remote')
        }
        return outcome.result
      }
      const bumped = bump({ ...latest, state: outcome.state })
      if (typeof config.beforeCasAttempt === 'function') {
        try {
          // 钩子可异步：用于在 CAS 前确定性注入并发写（模拟双写冲突）
          await config.beforeCasAttempt({ key, attempt })
        } catch {
          // 测试钩子异常忽略
        }
      }
      const written = casWrite(bumped, latest.rev)
      if (written) {
        envelope = written
        syncedRev = written.rev
        try {
          if (syncChannel) syncChannel.post(written.rev)
        } catch {
          // 通道不可用不影响本标签页正确性
        }
        emit('local')
        return { ok: true, envelope: written }
      }
      if (attempt >= 8) {
        return { ok: false, reason: 'busy' }
      }
      return run(attempt + 1)
    }
    if (locks && locks.supported) {
      return locks.withLock(lockName, () => run(0))
    }
    return run(0)
  }

  function pullRemote() {
    if (destroying) return
    const { envelope: latest, migrated } = readLatest()
    if (latest.rev !== syncedRev || migrated) {
      envelope = latest
      syncedRev = latest.rev
      emit('remote')
    }
  }

  /** 初始化：迁移 + 跨天结算 + 刷新恢复，返回 Promise 以便装配层等待 */
  function init() {
    const { envelope: loaded, migrated, dayChanged } = readLatest()
    let env = loaded
    const normalized = normalizeAfterReload(env.state)
    if (normalized !== env.state) env = { ...env, state: normalized }

    // 仅在确有差异（旧格式迁移 / 读路径跨天自愈 / scratching 归一）时落盘，
    // 避免无意义写入与广播；bump rev 让其他标签页能凭 rev 感知并拉取
    if (migrated || dayChanged || env.state !== loaded.state) {
      const written = casWrite(bump(env), loaded.rev)
      if (written) {
        env = written
      } else {
        // 竞争失败：采用获胜信封，获胜版本若也带 scratching 则在本地归一即可
        env = readLatest().envelope
        const renorm = normalizeAfterReload(env.state)
        if (renorm !== env.state) env = { ...env, state: renorm }
      }
    }
    envelope = env
    syncedRev = env.rev

    if (syncChannel) {
      syncChannel.onChange(() => pullRemote())
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    return Promise.resolve(this)
  }

  function onVisibility() {
    if (!document.hidden) pullRemote()
  }

  /** 后台跨过午夜自愈轮询（同步通道只在变更时通知，跨天无变更需兜底） */
  const rolloverTimer =
    typeof setInterval === 'function'
      ? setInterval(() => {
          const verdict = resolveDay(state().lastDate, localDateString(now()))
          if (verdict.verdict !== 'reset') return
          const { envelope: latest } = readLatest({ persistIfChanged: true })
          if (latest.rev !== syncedRev) {
            envelope = latest
            syncedRev = latest.rev
            emit('remote')
          }
        }, 60000)
      : null
  if (rolloverTimer && typeof rolloverTimer.unref === 'function') {
    rolloverTimer.unref()
  }

  function getChancesLeft() {
    return Math.max(0, dailyChances - state().chancesUsed)
  }

  return {
    init,
    id,
    title,
    cardIds,
    get isPersistent() {
      return Boolean(backend.isPersistent)
    },
    get syncAvailable() {
      return Boolean(syncChannel && syncChannel.available)
    },
    get snapshot() {
      return state()
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getCard: (cardId) => state().cards[cardId] || null,
    getChancesLeft,
    getDailyChances: () => dailyChances,

    /**
     * 开始刮卡（异步：跨标签页互斥提交）。
     * seed 在进入此方法的锁内迁移时才生成，此前不存在于任何可读位置。
     */
    beginScratch(cardId) {
      const seed = generateSeedFn() >>> 0
      return commitTransition(
        (env, options) =>
          transitionBegin(env.state, {
            cardId,
            dailyChances,
            prizes,
            seed: options.seed,
          }),
        { seed },
      ).then((res) => {
        if (res.ok) return { ok: true, card: res.envelope.state.cards[cardId] }
        return res
      })
    },

    reveal(cardId) {
      return commitTransition((env) => transitionReveal(env.state, { cardId })).then(
        (res) => {
          if (res.ok) return { ok: true, card: res.envelope.state.cards[cardId] }
          return res
        },
      )
    },

    /**
     * 领取（先到先得）：并发下 CAS 串行化，只有一方的 revealed -> claimed 成功；
     * 失败方得到 invalid-state，调用方据此提示"已在其他标签页领取"。
     */
    claim(cardId) {
      return commitTransition((env) => transitionClaim(env.state, { cardId })).then(
        (res) => {
          if (res.ok) return { ok: true, card: res.envelope.state.cards[cardId] }
          // 冲突时先把远端最新状态拉回内存，保证 UI 立即反映获胜方结果
          pullRemote()
          return res
        },
      )
    },

    /**
     * 公平性验证（纯重算）：用持久化的 seed 重放 mulberry32 + 权重开奖，
     * 并校验 FNV-1a 哈希，供用户核对"所见奖品 == 既定算法结果"。
     */
    verify(cardId) {
      const card = state().cards[cardId]
      if (!card || card.seed == null) return null
      const seed = card.seed >>> 0
      const rng = mulberry32(seed)
      const index = drawPrizeIndex(prizes, rng)
      return {
        seed,
        seedHash: fnv1aHex(String(seed)),
        hashMatches: fnv1aHex(String(seed)) === card.seedHash,
        prizeIndex: index,
        prize: prizes[index],
        lockedPrize: card.prize,
        prizeMatches:
          Boolean(card.prize) &&
          card.prize.name === prizes[index].name &&
          Boolean(card.prize.win) === Boolean(prizes[index].win),
      }
    },

    destroy() {
      destroying = true
      listeners.clear()
      if (rolloverTimer) clearInterval(rolloverTimer)
      if (syncChannel) syncChannel.destroy()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    },
  }
}
