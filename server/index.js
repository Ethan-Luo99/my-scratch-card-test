/**
 * 独立运行入口（可选，非 dev 中间件形态）：node server/index.js
 * 仅依赖 node: 内置模块。
 */
import { createServer } from 'node:http'
import { createServerApp } from './http/app.js'

const port = Number(process.env.PORT ?? 8787)
const handler = createServerApp({
  clock: () => Date.now(),
  logger: (entry) => {
    if (entry.level === 'error') console.error(JSON.stringify(entry))
  },
})

const server = createServer(handler)
server.listen(port, () => {
  console.log(`scratch-card server listening on http://localhost:${port}`)
})
