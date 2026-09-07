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
import { configDirectory } from '../common/data-directory.js';

/** Paths minted during this boot. Read once by reportGeneratedSecrets(). */
const generatedPaths: string[] = [];

/**
 * Resolve an application-owned secret from its fixed file, generating it on first boot. Application
 * keys share one configuration directory for backup and restore; individual keys have no overrides.
 */
export function resolveFileSecret(filename: string): string {
  const path = configDirectory(filename);

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
  createdAt?: number;
  permissionsSecure?: boolean;
}

/** Read-only metadata for Admin. Secret material never leaves this module. */
export function getManagedSecretStatus(filename: string): ManagedSecretStatus {
  const path = configDirectory(filename);
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
      createdAt: stat.birthtimeMs,
      permissionsSecure: (stat.mode & 0o077) === 0,
    };
  } catch {
    return { configured: true, valid: false };
  }
}

/**
 * Report first-boot generation once. Preserve the configuration directory across restarts:
 * losing its keys invalidates admin sessions and makes existing 2FA secrets undecryptable.
 */
export function reportGeneratedSecrets(): void {
  if (generatedPaths.length === 0) return;
  new Logger('Secret').warn(
    `Auto-generated ${generatedPaths.length} persistent secret(s): ${generatedPaths.join(', ')}. ` +
      'Persist the configuration directory across restarts — losing these files logs out every user/admin on the next boot ' +
      '(JWT secret) and/or forces admins to re-enroll 2FA (2FA key); same requirement as ' +
      'soms-s2s-key.json.',
  );
}
