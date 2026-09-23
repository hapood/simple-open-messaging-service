import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

function automationBuildStatusPlugin(enabled: boolean): Plugin {
  const statusDirectory = resolve(
    process.env.SOMS_HMR_STATUS_DIR || '/tmp/soms-browser-e2e/status',
  );
  const statusPath = resolve(statusDirectory, 'admin.json');
  let buildId = 0;
  let startedAt = new Date().toISOString();
  const sessionId = process.env.SOMS_HMR_SESSION_ID || null;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;

  const writeStatus = (
    state: 'building' | 'success' | 'failure',
    error?: Error,
  ) => {
    mkdirSync(statusDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${statusPath}.${process.pid}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        {
          service: 'admin',
          state,
          sessionId,
          buildId,
          observerPid: process.pid,
          childPid: process.pid,
          pid: process.pid,
          startedAt,
          updatedAt: new Date().toISOString(),
          ...(state === 'building'
            ? {}
            : { finishedAt: new Date().toISOString() }),
          diagnostics: error ? [error.message] : [],
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryPath, statusPath);
  };

  return {
    name: 'automation-build-status',
    apply: 'serve',
    buildStart() {
      if (!enabled) return;
      buildId += 1;
      startedAt = new Date().toISOString();
      writeStatus('building');
    },
    buildEnd(error) {
      if (!enabled) return;
      writeStatus(error ? 'failure' : 'success', error ?? undefined);
    },
    configureServer(server) {
      if (!enabled) return;
      server.httpServer?.once('listening', () => {
        writeStatus('success');
        recoveryTimer = setInterval(() => {
          if (!existsSync(statusPath)) {
            // An erased status record cannot attest to the last successful
            // build. Require a real Vite build before returning to success.
            writeStatus('building');
          }
        }, 2_000);
        recoveryTimer.unref();
      });
      server.httpServer?.once('close', () => {
        if (recoveryTimer) clearInterval(recoveryTimer);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  return {
    // Served under /admin/ in BOTH dev and prod — the dev access path is identical to the single-image
    // prod deploy (src/bootstrap.ts ADMIN_PREFIX = '/admin'), and the web dev server
    // (web/proxy.conf.json) reverse-proxies /admin to this vite server so asset URLs line up.
    // CONVENTION, not configuration — this prefix mirrors the server's ADMIN_PREFIX mount point
    // ('/admin') in src/bootstrap.ts (registerStaticServing); vite requires the trailing slash, hence
    // '/admin/'. The React Router basename reads import.meta.env.BASE_URL, so it tracks this value
    // automatically. Keep the two in sync; do not parameterize.
    base: '/admin/',
    plugins: [
      react(),
      tailwindcss(),
      automationBuildStatusPlugin(command === 'serve'),
    ],
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
  };
});
