/**
 * 存储工厂：默认尝试在磁盘上开启 FileStore（追加 WAL + 快照），
 * 任何构造/打开失败（配额、权限、目录不可写、锁冲突）都静默退化为
 * MemoryStore，并在 store.isPersistent 上透出 false。
 *
 * 仅依赖 node: 内置模块与本目录实现。
 */
import { MemoryStore } from './memory.js'
import { FileStore, DEFAULT_DATA_DIR } from './file.js'

/**
 * @param {object} [opts]
 * @param {string} [opts.dir] 数据目录（默认 SCRATCH_DATA_DIR 或系统临时目录）
 * @param {number} [opts.snapshotEvery]
 * @param {boolean} [opts.persist=true] 显式 false 时直接用内存（测试/降级）
 * @param {Function} [opts.onFault]
 * @returns {MemoryStore|FileStore}
 */
export function createStore(opts = {}) {
  if (opts.persist === false || process.env.SCRATCH_PERSIST === '0') {
    return new MemoryStore()
  }
  try {
    return new FileStore({
      dir: opts.dir ?? DEFAULT_DATA_DIR,
      snapshotEvery: opts.snapshotEvery,
      onFault: opts.onFault,
      faultBeforeCommit: opts.faultBeforeCommit,
      faultAfterDurable: opts.faultAfterDurable,
      faultInSnapshot: opts.faultInSnapshot,
    })
  } catch (error) {
    if (typeof opts.onFault === 'function') {
      opts.onFault('factory-fallback', String(error?.code ?? error?.message ?? error))
    }
    return new MemoryStore()
  }
}
