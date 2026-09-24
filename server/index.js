/**
 * 独立运行入口（可选）：node server/index.js [port]
 * 真实部署时以独立进程提供 /api；dev 下通常走 vite.config.js 中间件。
 */
import { createServer } from 'node:http'
import { createServerApp } from './app.js'

const port = Number(process.argv[2]) || 8787
const { handler } = createServerApp({
  journalFile: new URL('../.scratch-server.jsonl', import.meta.url).pathname,
})

const server = createServer((req, res) => {
  if (req.url && req.url.startsWith('/api')) {
    req.url = req.url.slice('/api'.length) || '/'
    return handler(req, res)
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, reason: 'bad-request' }))
})

server.listen(port, () => {
  console.log(`scratch-card server listening on http://localhost:${port}/api`)
})
