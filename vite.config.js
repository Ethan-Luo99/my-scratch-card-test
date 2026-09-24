/**
 * 仅在 dev 下把服务端权威 API 挂载到 /api（真实 HTTP，经 Vite 中间件）。
 * 该文件由 Node/Vite 配置加载，不进入前端 bundle；前端不 import server/**。
 * 生产构建（vite build）不包含任何服务端代码。
 */
import { defineConfig } from 'vite'
import { createServerApp } from './server/app.js'

export default defineConfig({
  plugins: [
    {
      name: 'scratch-card-server-authoritative-api',
      configureServer(server) {
        const { handler } = createServerApp({
          journalFile: new URL('./.scratch-server.jsonl', import.meta.url).pathname,
        })
        server.middlewares.use('/api', handler)
      },
    },
  ],
})
