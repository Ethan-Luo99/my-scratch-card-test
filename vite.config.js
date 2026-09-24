/**
 * Vite 配置：仅在 dev server 把服务端权威 API 挂载到 /api（真实 HTTP）。
 *
 * 该文件由 Node/Vite 加载，不属于前端 bundle；src/** 不 import server/**。
 * 生产构建 vite build 不包含任何服务端代码。
 */
import { defineConfig } from 'vite'
import { createServerApp } from './server/http/app.js'

function scratchApiPlugin() {
  return {
    name: 'scratch-card-server-api',
    configureServer(viteServer) {
      const apiHandler = createServerApp()
      viteServer.middlewares.use('/api', (req, res, next) => {
        // connect 挂载在 /api 时 req.url 已去掉前缀；补回以便统一路由匹配
        req.url = `/api${req.url === '/' ? '' : req.url}`
        apiHandler(req, res, next)
      })
    },
  }
}

export default defineConfig({
  plugins: [scratchApiPlugin()],
})
