import { Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { dataDirectory } from '../common/data-directory.js';

/**
 * Persistence root for auto-generated secrets. Same directory the S2S keypair lives in
 * (`./data/soms-s2s-key.json`), so a deployment persistent enough to
 * keep its federation identity is automatically persistent enough to keep these keys.
 */
/** Paths minted during this boot (env unset AND no existing file). Read once by reportGeneratedSecrets(). */
const generatedPaths: string[] = [];

/**
 * Resolve an application-owned secret from its fixed file, generating it on first boot. Application
 * keys deliberately have no env or path override: one conventional data directory is the backup and
 * restore boundary, and an accidental deployment-variable change can never rotate server identity.
 */
export function resolveFileSecret(filename: string): string {
  const path = dataDirectory(filename);

  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (!existing) throw new Error(`managed secret file is empty: ${path}`);
    return existing;
  }

  const generated = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generated, { mode: 0o600 });
  generatedPaths.push(path);
  return generated;
}

export interface ManagedSecretStatus {
  configured: boolean;
  valid: boolean;
  fingerprint?: string;
  createdAt?: string;
  permissionsSecure?: boolean;
}

/** Read-only metadata for Admin. Secret material never leaves this module. */
export function getManagedSecretStatus(filename: string): ManagedSecretStatus {
  const path = dataDirectory(filename);
  if (!existsSync(path)) return { configured: false, valid: false };
  try {
    const material = readFileSync(path, 'utf8').trim();
    const stat = statSync(path);
    return {
      configured: true,
      valid: material.length > 0,
      fingerprint: createHash('sha256')
        .update(material)
        .digest('hex')
        .slice(0, 16),
      createdAt: stat.birthtime.toISOString(),
      permissionsSecure: (stat.mode & 0o077) === 0,
    };
  } catch {
    return { configured: true, valid: false };
  }
}

/**
 * Surface first-boot auto-generation as a SINGLE operational warning — no-op when every secret came
 * from env or an existing file. Call once after all resolvePersistentSecret() calls so a clean first
 * boot produces one line, not several. The persistence caveat is the same one already documented for
 * the S2S keypair: losing ./data logs out every user/admin (JWT secret) AND makes existing 2FA secrets
 * undecryptable (admins must re-enroll) on the next boot.
 */
export function reportGeneratedSecrets(): void {
  if (generatedPaths.length === 0) return;
  new Logger('Secret').warn(
    `Auto-generated ${generatedPaths.length} persistent secret(s): ${generatedPaths.join(', ')}. ` +
      'Persist ./data across restarts — losing these files logs out every user/admin on the next boot ' +
      '(JWT secret) and/or forces admins to re-enroll 2FA (2FA key); same requirement as ' +
      'soms-s2s-key.json.',
  );
}
