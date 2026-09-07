import { afterEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { configDirectory, dataDirectory } from './data-directory.js';

afterEach(() => vi.unstubAllEnvs());

describe('configuration directory', () => {
  it('preserves the default deployment data path', () => {
    vi.stubEnv('SOMS_CONFIG_DIR', '');
    vi.stubEnv('SOMS_DATA_DIR', '');
    expect(configDirectory('vapid-key.json')).toBe(
      join(process.cwd(), 'data', 'vapid-key.json'),
    );
    vi.stubEnv('SOMS_DATA_DIR', '/tmp/custom-data');
    expect(configDirectory('vapid-key.json')).toBe(
      '/tmp/custom-data/vapid-key.json',
    );
  });

  it('separates credentials from mutable data when explicitly configured', () => {
    vi.stubEnv('SOMS_DATA_DIR', '/tmp/runtime');
    vi.stubEnv('SOMS_CONFIG_DIR', 'local/bravo');
    expect(configDirectory('vapid-key.json')).toBe(
      resolve('local/bravo/vapid-key.json'),
    );
    expect(dataDirectory('uploads')).toBe('/tmp/runtime/uploads');
  });
});
