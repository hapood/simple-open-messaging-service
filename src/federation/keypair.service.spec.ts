import { ed25519 } from '@noble/curves/ed25519.js';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseService } from '../database/database.service.js';
import { KeypairService } from './keypair.service.js';

interface Anchor {
  domain: string;
  rootKeyFingerprint: string;
  createdAt: Date;
}

function fakeDatabase(
  options: {
    anchor?: Anchor;
    hasHistory?: boolean;
  } = {},
) {
  let anchor = options.anchor;
  let pendingValues: Omit<Anchor, 'createdAt'> | undefined;
  const database = {
    db: {
      query: {
        localFederationIdentity: {
          findFirst: async () => anchor,
        },
      },
      execute: async () => ({
        rows: [{ hasHistory: options.hasHistory ?? false }],
      }),
      insert: () => ({
        values: (values: Omit<Anchor, 'createdAt'>) => {
          pendingValues = values;
          return {
            onConflictDoNothing: async () => {
              if (!anchor) {
                anchor = { ...values, createdAt: new Date() };
              }
            },
          };
        },
      }),
    },
  } as unknown as DatabaseService;
  return {
    database,
    getAnchor: () => anchor,
    getInsertedValues: () => pendingValues,
  };
}

describe('KeypairService identity continuity', () => {
  let directory: string;
  let keyPath: string;
  const originalDomain = process.env.SOMS_DOMAIN;
  const originalKeyPath = process.env.SOMS_S2S_KEY_PATH;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'soms-keypair-'));
    keyPath = join(directory, 'soms-s2s-key.json');
    process.env.SOMS_DOMAIN = 'node-a.example';
    process.env.SOMS_S2S_KEY_PATH = keyPath;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    if (originalDomain === undefined) delete process.env.SOMS_DOMAIN;
    else process.env.SOMS_DOMAIN = originalDomain;
    if (originalKeyPath === undefined) delete process.env.SOMS_S2S_KEY_PATH;
    else process.env.SOMS_S2S_KEY_PATH = originalKeyPath;
  });

  it('generates and anchors a v1 identity only for a fresh database', async () => {
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);

    await service.initialize();

    expect(service.getStatus()).toEqual({ available: true });
    expect(existsSync(keyPath)).toBe(true);
    const file = JSON.parse(readFileSync(keyPath, 'utf8')) as {
      version: number;
      domain: string;
    };
    expect(file).toMatchObject({
      version: 1,
      domain: 'node-a.example',
    });
    expect(fake.getAnchor()).toMatchObject({
      domain: 'node-a.example',
      rootKeyFingerprint: service.getRootKeyFingerprint(),
    });
    expect(service.getPairwiseServerId('peer-b.example')).toBe(
      service.getPairwiseServerId('PEER-B.EXAMPLE.'),
    );
    expect(service.getPairwiseServerId('peer-b.example')).not.toBe(
      service.getPairwiseServerId('peer-c.example'),
    );
  });

  it('refuses the obsolete unversioned file instead of silently rewriting it', async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    const legacy = {
      keyId: 'node-a.example/key-1',
      publicKey: Buffer.from(publicKey).toString('base64'),
      privateKey: Buffer.from(privateKey).toString('base64'),
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    writeFileSync(keyPath, JSON.stringify(legacy), { mode: 0o600 });
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);

    await service.initialize();

    expect(service.getStatus()).toMatchObject({
      available: false,
      reason: expect.stringContaining('unsupported key file version'),
    });
    expect(JSON.parse(readFileSync(keyPath, 'utf8'))).toEqual(legacy);
  });

  it('does not generate a replacement when federation history exists', async () => {
    const fake = fakeDatabase({ hasHistory: true });
    const service = new KeypairService(fake.database);

    await service.initialize();

    expect(service.getStatus()).toMatchObject({ available: false });
    expect(existsSync(keyPath)).toBe(false);
    expect(() => service.assertAvailable()).toThrowError(BusinessException);
    try {
      service.assertAvailable();
    } catch (error) {
      expect((error as BusinessException).bizCode).toBe(
        BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
      );
      expect((error as BusinessException).getStatus()).toBe(503);
    }
  });

  it('disables federation when the root key differs from the DB anchor', async () => {
    const firstDb = fakeDatabase();
    const first = new KeypairService(firstDb.database);
    await first.initialize();
    const anchor = firstDb.getAnchor();
    expect(anchor).toBeDefined();

    rmSync(keyPath);
    const replacementDb = fakeDatabase();
    const replacement = new KeypairService(replacementDb.database);
    await replacement.initialize();
    const replacementFile = readFileSync(keyPath);

    const checkingDb = fakeDatabase({ anchor });
    writeFileSync(keyPath, replacementFile, { mode: 0o600 });
    const checking = new KeypairService(checkingDb.database);
    await checking.initialize();

    expect(checking.getStatus()).toMatchObject({
      available: false,
      reason: expect.stringContaining('does not match'),
    });
  });

  it('disables federation when SOMS_DOMAIN changes', async () => {
    const fake = fakeDatabase();
    const first = new KeypairService(fake.database);
    await first.initialize();

    process.env.SOMS_DOMAIN = 'node-b.example';
    const changed = new KeypairService(fake.database);
    await changed.initialize();

    expect(changed.getStatus()).toMatchObject({
      available: false,
      reason: expect.stringContaining('does not match key identity domain'),
    });
  });

  it('does not replace a malformed key file', async () => {
    writeFileSync(keyPath, '{not-json', { mode: 0o600 });
    const service = new KeypairService(fakeDatabase().database);

    await service.initialize();

    expect(service.getStatus()).toMatchObject({ available: false });
    expect(readFileSync(keyPath, 'utf8')).toBe('{not-json');
  });
});
