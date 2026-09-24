/**
 * 纯工厂：createServerApp({ clock, store, signer, ... })。
 * 不监听端口、不依赖 Vite/DOM，可被 node --test 直接 import 调用；
 * 返回的 handler 既可挂进 Vite dev 中间件，也可用 node:http 独立运行。
 */
import { createEngine } from './core/engine.js'
import { createMemoryStore } from './store/memory-store.js'
import { createHttpAdapter } from './http/adapter.js'

export function createServerApp(options = {}) {
  const store = options.store || createMemoryStore(options)
  const engine = createEngine({ ...options, store })
  const handler = createHttpAdapter(engine)
  return { handler, engine, store }
}

export { createEngine } from './core/engine.js'
export { createMemoryStore } from './store/memory-store.js'
export { createSigner } from './core/crypto.js'
export { CAMPAIGNS } from './core/draw.js'
