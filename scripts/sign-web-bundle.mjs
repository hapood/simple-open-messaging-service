#!/usr/bin/env node
// Sign + package the web SPA as a downloadable, integrity-verified bundle for the Tauri shell
// dynamic-update flow. The shell ships WITHOUT the main web bundled; it fetches this tarball from
// `GET /api/v1/shell/web-bundle`, recomputes its SHA-256, and Ed25519-verifies it against a pubkey
// pinned in the shell BEFORE extracting/executing a single byte. (For IP/http origins the signature
// is the only integrity guarantee — TLS is skipped there.)
//
// Produces under data/shell/:
//   soms-web-<webVersion>.tar.gz   — gzip tarball of web/dist/web/browser
//   manifest.json                  — { webVersion, sha256, signature(base64) }
//
// (minShellVersion + downloadUrl are NOT stored here — the backend merges them from SHELL_COMPAT at
// serve time, so the manifest can never drift from the compat decision. See src/shell/shell.service.ts.)
//
// Signing key: base64 of a 32-byte Ed25519 seed, read from $SHOMS_WEB_SIGNING_KEY. When unset (local
// dev builds) it falls back to a deterministic DEV seed with a loud warning — bundles signed with the
// dev seed only verify against a shell that bakes the matching DEV pubkey (the Rust fallback). RELEASE
// builds MUST set SHOMS_WEB_SIGNING_KEY (CI secret) and bake the matching release pubkey via
// SOMS_WEB_PUBKEY_B64 in the shell build.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webPkg = JSON.parse(readFileSync(resolve(root, 'web/package.json'), 'utf8'));
const webVersion = webPkg.version;
if (!webVersion) {
  console.error('sign-web-bundle: web/package.json has no version');
  process.exit(1);
}

const browserDir = resolve(root, 'web/dist/web/browser');
if (!existsSync(browserDir)) {
  console.error(`sign-web-bundle: web build output not found at ${browserDir} — run "npm --prefix web run build" first`);
  process.exit(1);
}

const outDir = resolve(root, 'data/shell');
mkdirSync(outDir, { recursive: true });
const tarball = resolve(outDir, `soms-web-${webVersion}.tar.gz`);

// Deterministic dev seed: SHA-256 of a fixed marker (32 bytes). Any local build without
// SHOMS_WEB_SIGNING_KEY signs with this; the matching pubkey is the Rust fallback (see src-tauri).
const DEV_SEED = createHash('sha256').update('soms-dev-web-signing-key-v1').digest(); // 32 bytes

const seedB64 = process.env.SHOMS_WEB_SIGNING_KEY;
let seed;
if (seedB64) {
  seed = Buffer.from(seedB64, 'base64');
  if (seed.length !== 32) {
    console.error(`sign-web-bundle: SHOMS_WEB_SIGNING_KEY must decode to 32 bytes, got ${seed.length}`);
    process.exit(1);
  }
} else {
  // No env key: try the BuildKit secret mount (Dockerfile mounts the seed at /run/secrets/signing-key).
  let secretB64 = null;
  try {
    const s = readFileSync('/run/secrets/signing-key', 'utf8').trim();
    if (s) secretB64 = s;
  } catch {
    /* not mounted — fall through to dev seed */
  }
  if (secretB64) {
    seed = Buffer.from(secretB64, 'base64');
    if (seed.length !== 32) {
      console.error(`sign-web-bundle: signing-key secret must decode to 32 bytes, got ${seed.length}`);
      process.exit(1);
    }
  } else {
    seed = DEV_SEED;
    const pubHex = Buffer.from(ed25519.getPublicKey(DEV_SEED)).toString('hex');
    console.warn(
      `\n  ⚠️  sign-web-bundle: SHOMS_WEB_SIGNING_KEY unset — signing with the DETERMINISTIC DEV seed.\n` +
        `      This bundle only verifies in a shell that bakes the DEV pubkey (the Rust fallback).\n` +
        `      RELEASE builds MUST set SHOMS_WEB_SIGNING_KEY to the release seed.\n` +
        `      DEV pubkey (hex): ${pubHex}\n`,
    );
  }
}

// tar+gzip the browser build (content of dist/web/browser, not the dist root) via the system tar
// (available in the node image + every dev host). -C chdirs in so the archive root IS the browser dir.
execFileSync('tar', ['-czf', tarball, '-C', browserDir, '.'], { stdio: 'inherit' });

const bytes = readFileSync(tarball);
const sha256 = createHash('sha256').update(bytes).digest('hex');
// Ed25519 signs the full bundle bytes (ed25519-dalek on the shell signs the same — keep them aligned).
const signature = Buffer.from(ed25519.sign(bytes, seed)).toString('base64');

const manifest = { webVersion, sha256, signature };
writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`sign-web-bundle: wrote data/shell/soms-web-${webVersion}.tar.gz (${bytes.length} bytes) + manifest.json`);
console.log(`  webVersion=${webVersion} sha256=${sha256.slice(0, 16)}… sig=${signature.slice(0, 16)}…`);
