import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** 生产构建注入 CSP（本地零外联；开发模式豁免以保证 Vite HMR）。
 *  唯一外联例外：openrouter.ai——仅当用户在「AI 转化/AI 设置」中显式操作时才发起请求。 */
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
        "connect-src 'self' https://openrouter.ai",
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

export default defineConfig({
  plugins: [react(), cspForProd()],
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
