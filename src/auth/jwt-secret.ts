import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Persistence root for auto-generated secrets. Same directory the S2S keypair lives in
 * (SOMS_S2S_KEY_PATH defaults to ./data/soms-s2s-key.json), so a deployment persistent enough to
 * keep its federation identity is automatically persistent enough to keep these keys.
 */
const SECRET_DIR = resolve('data');

/** Paths minted during this boot (env unset AND no existing file). Read once by reportGeneratedJwtSecrets(). */
const generatedPaths: string[] = [];

/**
 * Resolve a long-lived HMAC signing secret with three-tier precedence:
 *   1. Explicit env var — operator-managed; REQUIRED for multi-instance deployments (every replica
 *      must share the same value), for rotation, and for external secret managers. Always wins.
 *   2. A file persisted under ./data on a prior first boot — lets restarts keep every existing
 *      token valid instead of mass-logging-out the whole user base on each boot.
 *   3. Neither → mint a 256-bit key (matches the documented `openssl rand -hex 32`), persist it
 *      mode 0600, and use it. Recorded so reportGeneratedJwtSecrets() can name it once.
 *
 * Why disk and not the DB: a signing key in the application DB would turn every DB backup into
 * token-forging material, blurring the data/secrets boundary that env-or-file keeps clean. This
 * mirrors the node-local-auto-generated-secret-on-disk pattern of KeypairService
 * (src/federation/keypair.service.ts).
 *
 * @param envName  the override env var, e.g. JWT_ACCESS_SECRET.
 * @param filename the on-disk filename under ./data, e.g. 'jwt-access.key'.
 */
export function resolveJwtSecret(envName: string, filename: string): string {
  // (1) Operator-managed env wins — explicit configuration always takes precedence.
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const path = resolve(SECRET_DIR, filename);

  // (2) Reuse the secret persisted on a prior first boot (guard against an empty/stale file).
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }

  // (3) First boot: mint + persist mode 0600 (same handling as soms-s2s-key.json).
  const generated = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generated, { mode: 0o600 });
  generatedPaths.push(path);
  return generated;
}

/**
 * Surface first-boot auto-generation as a SINGLE operational warning — no-op when every secret came
 * from env or an existing file. Call once after all resolveJwtSecret() calls so a clean first boot
 * produces one line, not three. The persistence caveat is the same one already documented for the
 * S2S keypair: losing ./data logs out every user/admin on the next boot.
 */
export function reportGeneratedJwtSecrets(): void {
  if (generatedPaths.length === 0) return;
  new Logger('JwtSecret').warn(
    `Auto-generated ${generatedPaths.length} JWT signing secret(s): ${generatedPaths.join(', ')}. ` +
      'Persist ./data across restarts — losing these files logs out every user/admin on the next ' +
      'boot (same requirement as soms-s2s-key.json). To manage them explicitly (multi-instance, ' +
      'rotation, external secret store), set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET / ' +
      'JWT_ADMIN_SECRET instead.',
  );
}
