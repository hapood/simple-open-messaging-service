import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig(() => ({
  // Served under /admin/ in BOTH dev and prod — the dev access path is identical to the single-image
  // prod deploy (src/bootstrap.ts ADMIN_PREFIX = '/admin'), and the web dev server
  // (web/proxy.conf.json) reverse-proxies /admin to this vite server so asset URLs line up.
  // CONVENTION, not configuration — this prefix mirrors the server's ADMIN_PREFIX mount point
  // ('/admin') in src/bootstrap.ts (registerStaticServing); vite requires the trailing slash, hence
  // '/admin/'. The React Router basename reads import.meta.env.BASE_URL, so it tracks this value
  // automatically. Keep the two in sync; do not parameterize.
  base: '/admin/',
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
