/**
 * 持久化适配器。
 * 职责边界：只负责状态的读写与容错，不理解任何业务字段。
 * localStorage 被禁用（隐私模式 / 用户拒绝）时自动降级为内存存储，
 * 接口保持不变，调用方无感知、不抛错；页面刷新后降级数据丢失属预期行为。
 */
export function createStore(key, backend = defaultBackend()) {
  const memoryFallback = new Map()
  let persistent = backend !== null

  return {
    /** 当前是否真正落盘（false 表示运行在降级模式） */
    get isPersistent() {
      return persistent
    },
    load() {
      try {
        const raw = persistent ? backend.getItem(key) : memoryFallback.get(key)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null // 数据损坏 / 读取失败都视为无历史状态
      }
    },
    save(data) {
      let raw
      try {
        raw = JSON.stringify(data)
      } catch {
        return
      }
      try {
        if (persistent) {
          backend.setItem(key, raw)
        } else {
          memoryFallback.set(key, raw)
        }
      } catch {
        // 写入失败（如运行中途被禁用）：切换为内存降级，后续不再尝试落盘
        persistent = false
        memoryFallback.set(key, raw)
      }
    },
  }
}

function defaultBackend() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const probe = '__scratch_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}
