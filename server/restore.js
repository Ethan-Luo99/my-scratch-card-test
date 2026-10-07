/**
 * PITR 备份恢复 CLI（零第三方依赖）：
 *   node server/restore.js <backup.json> <new-data-dir>
 *
 * 备份包由 GET /api/audit/export?asOf=<ts> 返回（单文件 JSON）。
 * 在一个全新（空）数据目录中恢复出 asOf 时刻的已提交状态：产物为自洽的
 * v2 哈希链，随后以 leader 身份打开并立即 verify；可用
 *   SCRATCH_PERSIST_DIR=<new-data-dir> node server/index.js
 * 起实例对外服务。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FileStore } from './store/file.js'

function main() {
  const [backupPathArg, targetDirArg] = process.argv.slice(2)
  if (!backupPathArg || !targetDirArg) {
    console.error('usage: node server/restore.js <backup.json> <new-data-dir>')
    process.exitCode = 2
    return
  }
  const backupPath = resolve(backupPathArg)
  const targetDir = resolve(targetDirArg)

  let backup
  try {
    backup = JSON.parse(readFileSync(backupPath, 'utf8'))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, stage: 'read-backup', error: error.message }))
    process.exitCode = 1
    return
  }

  try {
    const store = FileStore.restoreFromBackup(backup, targetDir)
    const verify = store.verifyAudit()
    console.log(
      JSON.stringify(
        {
          ok: verify.ok,
          dataDir: targetDir,
          asOf: backup.asOf,
          entries: verify.entries,
          tipHash: verify.tipHash,
          expectedTipHash: backup.target.tipHash,
          format: verify.format,
          anomalies: verify.anomalies,
          next: `SCRATCH_PERSIST_DIR=${targetDir} node server/index.js`,
        },
        null,
        2,
      ),
    )
    if (!verify.ok || verify.tipHash !== backup.target.tipHash) process.exitCode = 1
    store.close()
  } catch (error) {
    console.error(
      JSON.stringify({ ok: false, stage: 'restore', error: error.message, code: error.code ?? null }),
    )
    process.exitCode = 1
  }
}

main()
