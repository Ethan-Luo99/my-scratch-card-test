/**
 * 持久化层。
 * 职责边界：只负责 campaign 状态的读写与容错，不理解业务字段含义。
 * localStorage 被禁用（隐私模式等）时降级为内存 Map：功能可运行但不持久化，绝不抛错。
 */

const KEY = 'scratch-campaign:v1'
const memoryFallback = new Map()

function backend() {
  try {
    const probe = '__scratch_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}

export function loadState() {
  try {
    const store = backend()
    const raw = store ? store.getItem(KEY) : memoryFallback.get(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveState(state) {
  try {
    const raw = JSON.stringify(state)
    const store = backend()
    if (store) store.setItem(KEY, raw)
    else memoryFallback.set(KEY, raw)
  } catch {
    // 降级：本次不持久化，但不影响页面运行
  }
}
