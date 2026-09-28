/**
 * 跨标签页"轻量 dirty 提示"通道（设计 4.4）。
 *
 * 消息只带 { type:'dirty', campaignId, cardId, rev }，绝不携带 seed/prize/
 * 信封内容；收到提示的标签页调用 GET /api/state 拉取服务端公开视图对齐。
 *
 * 优先 BroadcastChannel（不触盘、即时）；不可用时退化为 storage 事件：
 * 往一个无业务语义的提示键写一条脏标记。该键内容只含 rev 等非秘密字段，
 * 属于白名单中的提示用途；其他标签页收到后同样只触发 GET /state。
 */

export const DIRTY_CHANNEL_NAME = 'scratch:v1:dirty'
const DIRTY_STORAGE_KEY = 'scratch:v1:dirty-marker'

function defaultBroadcastCtor() {
  try {
    return typeof BroadcastChannel === 'function' ? BroadcastChannel : null
  } catch {
    return null
  }
}

export function createDirtyChannel({
  name = DIRTY_CHANNEL_NAME,
  storageKey = DIRTY_STORAGE_KEY,
  BroadcastChannelCtor = defaultBroadcastCtor(),
  storageFactory,
} = {}) {
  const listeners = new Set()
  let bc = null
  let storageListener = null
  let lastStorageValue = null
  let seq = 0

  function dispatch(message) {
    for (const fn of listeners) {
      try {
        fn(message)
      } catch {
        // 单个订阅者异常不影响通道
      }
    }
  }

  if (BroadcastChannelCtor) {
    try {
      bc = new BroadcastChannelCtor(name)
      bc.onmessage = (event) => {
        const message = sanitize(event?.data)
        if (message) dispatch(message)
      }
    } catch {
      bc = null
    }
  }

  function getStorage() {
    if (!storageFactory) return null
    try {
      return storageFactory()
    } catch {
      return null
    }
  }

  if (!bc && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    storageListener = (event) => {
      if (!event || event.key !== storageKey) return
      if (event.newValue === lastStorageValue) return
      lastStorageValue = event.newValue
      let parsed = null
      try {
        parsed = JSON.parse(event.newValue)
      } catch {
        parsed = null
      }
      const message = sanitize(parsed)
      if (message) dispatch(message)
    }
    window.addEventListener('storage', storageListener)
  }

  function sanitize(raw) {
    if (!raw || raw.type !== 'dirty') return null
    return {
      type: 'dirty',
      campaignId: typeof raw.campaignId === 'string' ? raw.campaignId : null,
      cardId: typeof raw.cardId === 'string' ? raw.cardId : null,
      rev: typeof raw.rev === 'number' ? raw.rev : null,
    }
  }

  return {
    get available() {
      return Boolean(bc || storageListener)
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** 仅广播 dirty 提示（不含任何结果字段）；本页不会收到自己的广播 */
    postDirty({ campaignId = null, cardId = null, rev = null } = {}) {
      const message = sanitize({ type: 'dirty', campaignId, cardId, rev })
      if (!message) return
      if (bc) {
        try {
          bc.postMessage(message)
          return
        } catch {
          // 序列化失败：退化 storage 标记
        }
      }
      const storage = getStorage()
      if (storage) {
        try {
          seq += 1
          const value = JSON.stringify({ ...message, seq })
          lastStorageValue = value
          storage.setItem(storageKey, value)
        } catch {
          // 存储禁用：跨页提示不可用，轮询/visibility 仍兜底
        }
      }
    },
    destroy() {
      listeners.clear()
      if (bc) {
        try {
          bc.close()
        } catch {
          // 忽略
        }
      }
      if (storageListener && typeof window !== 'undefined') {
        window.removeEventListener('storage', storageListener)
      }
    },
  }
}
