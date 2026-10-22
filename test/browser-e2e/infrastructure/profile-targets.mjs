import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertProfileTarget } from './targets.mjs';

export function profileTarget(root, name, requested) {
  if (
    typeof name !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)
  )
    throw new Error('Invalid profile name.');
  const metadataRoot = join(root, '.targets');
  const file = join(metadataRoot, `${name}.json`);
  let existing;
  try {
    existing = JSON.parse(readFileSync(file, 'utf8')).target;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Existing unlabelled profiles belong to the original federation-only driver. Never migrate or wipe them.
  if (!existing && existsSync(join(root, name))) existing = 'federation';
  const target = assertProfileTarget(existing, requested ?? existing);
  mkdirSync(metadataRoot, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, JSON.stringify({ target }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assertProfileTarget(JSON.parse(readFileSync(file, 'utf8')).target, target);
  }
  return target;
}

export function profileDirectory(root, name, target) {
  // Retain existing federation paths so currently retained sessions remain usable.
  return target === 'playground'
    ? join(root, '.playground', name)
    : join(root, name);
}
