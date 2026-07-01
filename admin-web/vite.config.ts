import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // Prod is served under /admin/ (single-image, path-prefix deploy); dev stays at root for the vite dev server.
  base: command === 'build' ? '/admin/' : '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    // Fail hard if the port is taken, so the access URL is deterministic.
    strictPort: true,
    // Bind 0.0.0.0 so LAN/other devices can reach it (matches the C-end ng serve host:0.0.0.0).
    host: true,
    proxy: {
      // In dev, proxy /api to the backend :3000 (avoids hard-coding the host; prod is same-origin).
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
}))
