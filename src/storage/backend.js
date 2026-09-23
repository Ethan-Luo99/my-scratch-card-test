/**
 * 键值后端适配器（仅读写字符串，不懂业务字段）。
 * - localStorage 可用：真实持久化，并通过单一 storage 事件分发器支持跨标签页监听；
 * - localStorage 被禁用 / 写入抛 QuotaExceededError：自动降级为内存 Map，
 *   接口不抛错，退化为单标签页语义（刷新后丢失属预期，页面提示）。
 *
 * 设计为单例后端 + 多命名空间 store：storage 事件只注册一次，按 key 扇出，
 * 避免每个活动实例各自挂监听。
 */

export function createKvBackend(storageFactory = defaultStorage) {
  let backend = safeStorage(storageFactory)
  const listeners = new Set()

  function safeStorage(factory) {
    try {
      const s = factory()
      if (!s) return null
      const probe = '__scratch_probe__'
      s.setItem(probe, '1')
      s.removeItem(probe)
      return s
    } catch {
      return null
    }
  }

  const memory = new Map()
  let persistent = backend !== null
  let storageHandler = null

  if (persistent && typeof window !== 'undefined') {
    storageHandler = (event) => {
      if (!event || typeof event.key !== 'string') return
      for (const fn of listeners) {
        try {
          fn(event.key, event.newValue)
        } catch {
          // 单个监听者出错不影响其他活动实例
        }
      }
    }
    window.addEventListener('storage', storageHandler)
  }

  return {
    /** 当前是否真正落盘 */
    get isPersistent() {
      return persistent
    },
    getItem(key) {
      try {
        return persistent ? backend.getItem(key) : memory.get(key) ?? null
      } catch {
        return memory.get(key) ?? null
      }
    },
    /** 同步写入；失败自动降级内存，返回是否成功落盘 */
    setItem(key, value) {
      if (persistent) {
        try {
          backend.setItem(key, value)
          return true
        } catch {
          // QuotaExceededError / 安全策略 / 运行中被禁用：永久降级内存
          persistent = false
          memory.set(key, value)
          return false
        }
      }
      memory.set(key, value)
      return false
    },
    removeItem(key) {
      try {
        if (persistent) backend.removeItem(key)
      } catch {
        persistent = false
      }
      memory.delete(key)
    },
    /** 订阅其他标签页对同一浏览器的写入（localStorage storage 事件） */
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    destroy() {
      if (storageHandler && typeof window !== 'undefined') {
        window.removeEventListener('storage', storageHandler)
      }
      listeners.clear()
    },
  }
}

function defaultStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}
