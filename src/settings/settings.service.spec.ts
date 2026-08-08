import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsService } from './settings.service.js';
import type { DatabaseService } from '../database/database.service.js';

/**
 * SettingsService Firebase client config (file-based, 2026-07-23): the 4 fields are read once at boot from
 * FIREBASE_CLIENT_CONFIG (default data/google-services.json) and cached for the process lifetime. These
 * specs pin that boot-read contract — valid file → 4 fields; missing/malformed → null (unconfigured); and
 * the boot value is cached (a later file change is NOT picked up without a restart). Every test points
 * FIREBASE_CLIENT_CONFIG at a temp file so the real data/google-services.json is never touched.
 */

// The Firebase path only refreshes the absent VAPID row during boot.
const databaseStub = {
  db: {
    query: { systemSetting: { findFirst: async () => undefined } },
  },
} as unknown as DatabaseService;

const validJson = JSON.stringify({
  project_info: { project_number: '987654321098', project_id: 'soms-example' },
  client: [
    {
      client_info: {
        mobilesdk_app_id: '1:987654321098:android:0123456789abcdef',
        android_client_info: { package_name: 'com.soms.client' },
      },
      api_key: [{ current_key: 'AIzaSyabcdefghijklmnopqrstuvwxyz1234567890' }],
    },
  ],
});

describe('SettingsService — Firebase client config (file-based, boot-loaded)', () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'soms-fb-'));
    savedEnv = process.env.FIREBASE_CLIENT_CONFIG;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.FIREBASE_CLIENT_CONFIG;
    else process.env.FIREBASE_CLIENT_CONFIG = savedEnv;
  });

  /** Boot a fresh service (runs onModuleInit → the eager disk read) and return it. No teardown needed:
   *  @Interval only schedules inside a Nest context, and this direct instantiation starts no timer. */
  async function boot(): Promise<SettingsService> {
    const s = new SettingsService(databaseStub);
    await s.onModuleInit();
    return s;
  }

  it('loads the 4 fields at boot from FIREBASE_CLIENT_CONFIG', async () => {
    const p = join(dir, 'google-services.json');
    writeFileSync(p, validJson);
    process.env.FIREBASE_CLIENT_CONFIG = p;
    const s = await boot();
    expect(s.getFirebaseConfig()).toEqual({
      apiKey: 'AIzaSyabcdefghijklmnopqrstuvwxyz1234567890',
      projectId: 'soms-example',
      appId: '1:987654321098:android:0123456789abcdef',
      gcmSenderId: '987654321098',
    });
  });

  it('is unconfigured (null) when the file is missing', async () => {
    process.env.FIREBASE_CLIENT_CONFIG = join(dir, 'nope.json'); // does not exist
    const s = await boot();
    expect(s.getFirebaseConfig()).toBeNull();
    expect(s.firebaseClientConfigured).toBe(false);
  });

  it('defaults federation chunk digests off when the setting is absent', async () => {
    const s = await boot();
    await expect(s.getFederationDownloadLimits()).resolves.toEqual({
      global: 10,
      perPeer: 2,
      chunkDigestEnabled: false,
    });
    await expect(s.isFederationChunkDigestEnabled()).resolves.toBe(false);
  });

  it('is unconfigured (null) when the file is malformed', async () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{not json');
    process.env.FIREBASE_CLIENT_CONFIG = p;
    const s = await boot();
    expect(s.getFirebaseConfig()).toBeNull();
  });

  it('caches the boot read — a later file change is not picked up without a restart', async () => {
    const p = join(dir, 'google-services.json');
    writeFileSync(p, validJson);
    process.env.FIREBASE_CLIENT_CONFIG = p;
    const s = await boot();
    expect(s.getFirebaseConfig()).not.toBeNull();
    // Corrupt the file AFTER boot — the cached boot value still wins (proves it's read once at startup, not
    // re-read on each getFirebaseConfig call).
    writeFileSync(p, '{garbage');
    expect(s.getFirebaseConfig()).not.toBeNull();
  });
});
