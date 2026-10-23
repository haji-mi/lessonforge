import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** 生产构建注入 CSP（本地零外联；开发模式豁免以保证 Vite HMR） */
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
        "connect-src 'self'",
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
