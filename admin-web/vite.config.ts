import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    // 端口被占直接报错而非静默切换，保证访问地址确定
    strictPort: true,
    // 绑定 0.0.0.0，局域网/其他设备可访问（与 C 端 ng serve host:0.0.0.0 一致）
    host: true,
    proxy: {
      // dev 下 /api 转发到后端 :3000，避免硬编码 host + 生产同源
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
