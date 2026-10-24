import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** 生产构建注入 CSP。AI 供应商由用户自选（OpenRouter/英伟达/自定义 OpenAI 兼容端点，
 *  含本地 LLM 服务），connect-src 相应放宽为 https: + 本机 http；仅 ai 边界层代码会
 *  发起外联，且只在用户显式触发「AI 转化/测试连接」时（默认零上传不变，见基线 §10）。 */
function cspForProd(): Plugin {
  return {
    name: 'csp-for-prod',
    apply: 'build',
    transformIndexHtml(html) {
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "font-src 'self'",
        "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; ')
      return html.replace(
        '</head>',
        `  <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`,
      )
    },
  }
}

/** 英伟达 NIM 同源代理：浏览器直连 integrate.api.nvidia.com 被 CORS 拦截（实测），
 *  dev 与 preview 均经本机服务端转发，应用内 baseUrl 用 '/nim'。 */
const nimProxy = {
  '/nim': {
    target: 'https://integrate.api.nvidia.com',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/nim/, '/v1'),
  },
}

export default defineConfig({
  plugins: [react(), cspForProd()],
  server: { proxy: nimProxy },
  preview: { proxy: nimProxy },
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
