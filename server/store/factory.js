/**
 * 存储工厂：按配置创建持久化 FileStore；任何构造期失败（目录不可写、
 * 磁盘不可用、日志不可恢复）都自动退化为 MemoryStore，服务照常启动。
 * 零第三方依赖，仅返回 { store, persistent, degradedReason }。
 *
 * 默认数据目录：SCRATCH_PERSIST_DIR，否则 <cwd>/node_modules/.cache/scratch-server
 * （node_modules 已在 .gitignore，会话数据不进版本库；测试显式注入 store 不受影响）。
 */
import { join } from 'node:path'
import { MemoryStore } from './memory.js'
import { FileStore } from './file.js'

export const DEFAULT_DATA_DIR = join(process.cwd(), 'node_modules', '.cache', 'scratch-server')

export function createStore(options = {}) {
  if (options.store) return { store: options.store, persistent: options.store.isPersistent !== false }
  const dir = options.dir ?? process.env.SCRATCH_PERSIST_DIR ?? DEFAULT_DATA_DIR
  if (!dir) return { store: new MemoryStore(), persistent: false }
  const restorePackagePath = options.restorePackagePath ?? process.env.SCRATCH_RESTORE_PACKAGE ?? null
  try {
    const fileStoreOptions = restorePackagePath
      ? { ...options.fileStoreOptions, restorePackage: restorePackagePath }
      : options.fileStoreOptions
    const store = new FileStore(dir, fileStoreOptions)
    return {
      store,
      persistent: store.isPersistent,
      degradedReason: store.degradedReason ?? null,
    }
  } catch (error) {
    if (restorePackagePath && error?.code?.startsWith?.('pitr-')) throw error
    if (options.logger) {
      options.logger({ level: 'warn', event: 'store-factory-fallback', error: String(error?.message ?? error) })
    }
    return { store: new MemoryStore(), persistent: false, degradedReason: String(error?.message ?? error) }
  }
}
