/**
 * 跨标签页同步通道与互斥锁（全部带降级，缺能力时退化为单标签页语义）。
 *
 * 通道：优先 BroadcastChannel（同源多标签页，不触盘、消息即时）；
 *       不可用时退化为 window 'storage' 事件（localStorage 后端自带）；
 *       两者都没有（内存降级 / Node 测试）时频道静默失效，不报错。
 * 消息只携带 { rev }（不携带状态本身），接收方回到存储里取最新快照，
 * 天然避免"消息回放旧状态"与回环风暴；发送方不处理自己发的消息。
 *
 * 锁：优先 Web Locks API（navigator.locks.request，跨标签页互斥，
 *     崩溃自动释放，不会死锁）；不可用时退化为本标签页内的 Promise 链互斥
 *     （仅保证同标签页异步互斥；真正的跨标签页正确性由 CAS 兜底）。
 */

export function createSyncChannel({ name, storageKey = null, backend, channelFactory = defaultChannel, senderId }) {
  const listeners = new Set()
  let bc = null
  let unsubscribeBackend = null

  try {
    const Existing = channelFactory(name)
    if (Existing) {
      bc = Existing
      bc.onmessage = (event) => {
        const msg = event && event.data
        if (!msg || msg.senderId === senderId || msg.name !== name) return
        dispatch(msg)
      }
    }
  } catch {
    bc = null
  }

  if (!bc && backend && backend.subscribe && storageKey) {
    // 兜底：localStorage storage 事件只在其他文档触发，天然无回环。
    // 事件回调给的是真实 localStorage key（与 BroadcastChannel 名不同）
    unsubscribeBackend = backend.subscribe((eventKey) => {
      if (eventKey === storageKey) dispatch({ name, rev: null })
    })
  }

  function dispatch(msg) {
    for (const fn of listeners) {
      try {
        fn(msg)
      } catch {
        // 监听者异常不影响同步通道
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
    /** 只广播一个轻量提示；自己收不到（BC 同上下文不回环 / storage 不触发本文档） */
    post(rev) {
      if (bc) {
        try {
          bc.postMessage({ name, rev: Number(rev) || 0, senderId })
        } catch {
          // 序列化失败等：忽略，storage 事件/轮询仍可兜底
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
      ? Math.floor(Math.random() * 0xffffffff)
          .toString(36)
      : '0'
  return `tab-${Date.now().toString(36)}-${idCounter}-${rand}`
}

/**
 * 跨标签页互斥执行器。
 * @param {LockManager|null|undefined} locksApi 通常传 navigator.locks（可注入测试桩）
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
    /** 在名为 name 的排他锁保护下执行 fn，返回 fn 的结果/异常 */
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
