import { constants, copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const persistentFiles = [
  'vapid-key.json',
  'jwt-admin.key',
  'password-pepper.key',
  '2fa.key',
  'soms-s2s-key.json',
  'google-services.json',
  'firebase-service-account.json',
];

/** Import legacy credentials once; local configuration is authoritative thereafter. */
export function prepareLabConfig(labDir, nodeName) {
  const directory = join(labDir, 'local', nodeName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const filename of persistentFiles) {
    const target = join(directory, filename);
    try {
      copyFileSync(
        join(labDir, 'runtime', nodeName, 'data', filename),
        target,
        constants.COPYFILE_EXCL,
      );
      chmodSync(target, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST') throw error;
    }
  }
  return directory;
}
