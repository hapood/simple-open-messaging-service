#!/usr/bin/env node
// Package the web SPA as a downloadable, SHA-256-integrity-checked bundle for the Tauri shell
// dynamic-update flow. The shell ships WITHOUT the main web bundled; it fetches this tarball from
// `GET /api/v1/shell/web-bundle`, recomputes its SHA-256, and refuses to install on mismatch BEFORE
// extracting/executing a byte. Transport integrity + authenticity come from TLS (https origins); the
// SHA-256 catches transport corruption, partial downloads, and manifest/bundle version drift. IP/http
// origins are not guaranteed secure by policy.
//
// Produces under shell-bundle/:
//   soms-web-<webVersion>.tar.gz   — gzip tarball of web/dist/web/browser
//   manifest.json                  — { webVersion, sha256 }
//
// This is a BUILD artifact, not runtime state. In production the Dockerfile bakes shell-bundle/ read-only
// into the image at /app/shell-bundle — OUTSIDE the bind-mounted /app/data volume — so the bundle is
// immutable per image and never drifts into operator-writable state. Locally it writes
// ./shell-bundle/ at the repo root (gitignored).
//
// (downloadUrl is NOT stored here — the backend merges it in at serve time from a fixed route path.
// The shell owns version compatibility via a hard-coded backend-version upper bound in its Cargo source,
// so there is no server-side shell floor to store. See src/shell/shell.service.ts.)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webPkg = JSON.parse(
  readFileSync(resolve(root, 'web/package.json'), 'utf8'),
);
const webVersion = webPkg.version;
if (!webVersion) {
  console.error('package-web-bundle: web/package.json has no version');
  process.exit(1);
}

const browserDir = resolve(root, 'web/dist/web/browser');
if (!existsSync(browserDir)) {
  console.error(
    `package-web-bundle: web build output not found at ${browserDir} — run "npm --prefix web run build" first`,
  );
  process.exit(1);
}

const outDir = resolve(root, 'shell-bundle');
mkdirSync(outDir, { recursive: true });
const tarball = resolve(outDir, `soms-web-${webVersion}.tar.gz`);

// tar+gzip the browser build (content of dist/web/browser, not the dist root) via the system tar
// (available in the node image + every dev host). -C chdirs in so the archive root IS the browser dir.
execFileSync('tar', ['-czf', tarball, '-C', browserDir, '.'], {
  stdio: 'inherit',
});

const bytes = readFileSync(tarball);
const sha256 = createHash('sha256').update(bytes).digest('hex');

const manifest = { webVersion, sha256 };
writeFileSync(
  resolve(outDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

console.log(
  `package-web-bundle: wrote shell-bundle/soms-web-${webVersion}.tar.gz (${bytes.length} bytes) + manifest.json`,
);
console.log(`  webVersion=${webVersion} sha256=${sha256.slice(0, 16)}…`);
