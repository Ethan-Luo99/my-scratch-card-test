/**
 * 跨标签页"轻量 dirty 提示"通道与迁移互斥锁。
 *
 * 服务端权威化后，真相只在服务端：
 * - 通道消息只带 { campaignId, cardId?, rev }（不含任何结果字段），
 *   收到提示的标签页调用 GET /api/state 对齐公开视图；
 * - 不再有任何"回 localStorage 拉业务信封"的路径；
 * - 优先 BroadcastChannel，退化 storage 事件（写一个仅含 rev 的信号 key），
 *   两者皆无（内存降级/Node）时频道静默失效，轮询与回前台拉取兜底。
 *
 * 锁只用于迁移向导的跨标签页单飞，业务并发裁决全部在服务端。
 */
const DIRTY_SIGNAL_KEY = 'scratch-card:v3:dirty-signal'

export function createDirtyChannel({
  name,
  backend = null,
  senderId,
  channelFactory = defaultChannel,
}) {
  const listeners = new Set()
  let bc = null
  let unsubscribeBackend = null

  try {
    const existing = channelFactory(name)
    if (existing) {
      bc = existing
      bc.onmessage = (event) => {
        const msg = event && event.data
        if (!msg || msg.senderId === senderId || msg.name !== name) return
        dispatch(msg)
      }
    }
  } catch {
    bc = null
  }

  if (!bc && backend && backend.subscribe) {
    // storage 事件只在其他文档触发，天然无回环；信号值只含 rev，不含结果
    unsubscribeBackend = backend.subscribe((eventKey, newValue) => {
      if (eventKey !== DIRTY_SIGNAL_KEY) return
      let msg = null
      if (newValue) {
        try {
          msg = JSON.parse(newValue)
        } catch {
          msg = null
        }
      }
      if (msg && msg.name === name && msg.senderId !== senderId) dispatch(msg)
    })
  }

  function dispatch(msg) {
    for (const fn of listeners) {
      try {
        fn(msg)
      } catch {
        // 单个监听者异常不影响通道
      }
    }
  }

  return {
    get available() {
      return Boolean(bc || unsubscribeBackend)
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** 广播 dirty 提示；自己收不到（BC 不回环 / storage 不触发本文档） */
    post(message = {}) {
      const msg = {
        name,
        senderId,
        campaignId: message.campaignId ?? null,
        cardId: message.cardId ?? null,
        rev: Number(message.rev) || 0,
        at: Date.now(),
      }
      if (bc) {
        try {
          bc.postMessage(msg)
          return
        } catch {
          // 落到 storage 信号兜底
        }
      }
      if (backend) {
        try {
          backend.setItem(DIRTY_SIGNAL_KEY, JSON.stringify(msg))
        } catch {
          // 通道不可用不影响正确性：回前台/轮询仍会拉 /state
        }
      }
    },
    destroy() {
      listeners.clear()
      if (unsubscribeBackend) unsubscribeBackend()
      try {
        if (bc) bc.close()
      } catch {
        // 忽略
      }
    },
  }
}

function defaultChannel(name) {
  try {
    if (typeof BroadcastChannel === 'function') return new BroadcastChannel(name)
  } catch {
    return null
  }
  return null
}

let idCounter = 0
export function createSenderId() {
  idCounter += 1
  const rand =
    typeof Math !== 'undefined'
      ? Math.floor(Math.random() * 0xffffffff).toString(36)
      : '0'
  return `tab-${Date.now().toString(36)}-${idCounter}-${rand}`
}

/**
 * 跨标签页互斥执行器（仅迁移向导单飞使用；业务并发由服务端幂等裁决）。
 */
export function createLockManager(locksApi = defaultLocksApi()) {
  const localChains = new Map()

  function withLocalMutex(name, fn) {
    const prev = localChains.get(name) || Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(
      () => {},
      () => {},
    )
    localChains.set(name, tail)
    tail.then(() => {
      if (localChains.get(name) === tail) localChains.delete(name)
    })
    return next
  }

  return {
    get supported() {
      return Boolean(locksApi && typeof locksApi.request === 'function')
    },
    withLock(name, fn) {
      if (locksApi && typeof locksApi.request === 'function') {
        try {
          return Promise.resolve(locksApi.request(name, { mode: 'exclusive' }, () => fn()))
        } catch {
          // 个别环境声明了 API 却调用失败：退化为本地互斥
        }
      }
      return withLocalMutex(name, fn)
    },
  }
}

function defaultLocksApi() {
  try {
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks
  } catch {
    return null
  }
  return null
}
