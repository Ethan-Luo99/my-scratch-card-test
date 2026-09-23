/**
 * 测试工具：内存后端（多实例共享同一 Map，模拟同源多标签页）、
 * 共享锁（真实串行化，模拟 Web Locks）、可控时钟与确定性 seed。
 */
import { createKvBackend } from '../src/storage/backend.js'
import { createLockManager } from '../src/storage/sync.js'

/** 共享底层 Map 的"两个标签页"后端 */
export function createSharedBackends() {
  const map = new Map()
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
  return {
    map,
    a: createKvBackend(() => storage),
    b: createKvBackend(() => storage),
  }
}

/** 共享锁管理器：同一 name 的请求按到达顺序串行（模拟 navigator.locks） */
export function createSharedLocks() {
  const tails = new Map()
  const api = {
    request(name, _options, fn) {
      const prev = tails.get(name) || Promise.resolve()
      const next = Promise.resolve(prev).then(fn)
      tails.set(
        name,
        next.then(
          () => {},
          () => {},
        ),
      )
      return next
    },
  }
  return {
    a: createLockManager(api),
    b: createLockManager(api),
  }
}

/** 固定时钟：返回可推进的 now() */
export function createClock(startISO = '2026-09-23T10:00:00') {
  let current = new Date(startISO)
  return {
    now: () => new Date(current),
    set(iso) {
      current = new Date(iso)
    },
  }
}

/** 确定性 seed 发生器（递增，便于断言） */
export function createSeedGen(start = 1000) {
  let seed = start
  return () => (seed += 1)
}

export const PRIZES = [
  { name: '大奖', weight: 10, win: true },
  { name: '谢谢参与', weight: 90, win: false },
]

/**
 * 确定性进程内消息总线：模拟同源 BroadcastChannel（同进程多标签页），
 * 避免依赖 Node 内置 BroadcastChannel 的句柄与异步时序。
 * 同一 name 的 fake channel 互相收发，自己 post 的消息自己也会收到
 * （与真实 BroadcastChannel 行为一致），由 syncChannel 用 senderId 过滤。
 */
export function createInProcessBus() {
  const groups = new Map()
  return {
    channelFactory(name) {
      if (!groups.has(name)) groups.set(name, new Set())
      const peers = groups.get(name)
      const channel = {
        postMessage(data) {
          for (const peer of [...peers]) {
            if (peer === channel) continue
            Promise.resolve().then(() => {
              if (peer.onmessage) peer.onmessage({ data })
            })
          }
        },
        onmessage: null,
        close() {
          peers.delete(channel)
        },
      }
      peers.add(channel)
      return channel
    },
  }
}
