import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseService } from '../database/database.service.js';
import {
  localFederationIdentity,
  localFederationSigningKey,
  localFederationSigningState,
} from '../database/schema.js';
import { verifySigningCertificate } from './federation-certificate.js';
import { KeypairService } from './keypair.service.js';

interface FakeIdentityRow {
  domain: string;
  rootKeyFingerprint: string;
  rootPublicKey: string;
  rootPrivateKey: string;
  createdAt: Date;
}

interface FakeSigningKeyRow {
  domain: string;
  keyId: string;
  publicKey: string;
  privateKey: string;
  createdAt: Date;
  notBefore: Date;
  notAfter: Date;
}

interface FakeSigningStateRow {
  domain: string;
  currentKeyId: string;
  plannedSwitchAt: Date | null;
  plannedSuccessorKeyId: string | null;
  updatedAt: Date;
}

interface FakeHandle {
  database: DatabaseService;
  getIdentity: () => FakeIdentityRow | undefined;
  getKeys: () => FakeSigningKeyRow[];
  getState: () => FakeSigningStateRow | undefined;
  setKeys: (rows: FakeSigningKeyRow[]) => void;
}

/** Rebuilds the SQL text and positional parameters of a Drizzle `sql` fragment.
 *  Template-literal parts arrive as StringChunk objects; interpolated values appear
 *  directly as chunks (only arrays are interpolated by the service today). */
function interpretSql(fragment: unknown): { text: string; params: unknown[] } {
  const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks ?? [];
  const params: unknown[] = [];
  let text = '';
  for (const chunk of chunks) {
    const record = chunk as { value?: unknown };
    if (
      chunk !== null &&
      typeof chunk === 'object' &&
      Array.isArray(record.value) &&
      record.value.every((part) => typeof part === 'string')
    ) {
      text += (record.value as string[]).join('');
    } else {
      text += `$${params.length + 1}`;
      params.push(chunk);
    }
  }
  return { text, params };
}

function fakeDatabase(options: { hasHistory?: boolean } = {}): FakeHandle {
  let identity: FakeIdentityRow | undefined;
  let keys: FakeSigningKeyRow[] = [];
  let state: FakeSigningStateRow | undefined;

  const insert = (table: unknown) => ({
    values: async (values: object) => {
      if (table === localFederationIdentity) {
        identity = values as FakeIdentityRow;
      } else if (table === localFederationSigningKey) {
        keys.push(values as FakeSigningKeyRow);
      } else if (table === localFederationSigningState) {
        state = values as FakeSigningStateRow;
      } else {
        throw new Error('unexpected insert target');
      }
    },
  });

  const db = {
    query: {
      localFederationIdentity: {
        findFirst: async () => (identity ? { ...identity } : undefined),
      },
      localFederationSigningKey: {
        findMany: async () => keys.map((key) => ({ ...key })),
      },
      localFederationSigningState: {
        findFirst: async () => (state ? { ...state } : undefined),
      },
    },
    execute: async (fragment: unknown) => {
      const { text, params } = interpretSql(fragment);
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('hasHistory')) {
        return { rows: [{ hasHistory: options.hasHistory ?? false }] };
      }
      if (text.includes('DELETE FROM "LocalFederationSigningKey"')) {
        const ids = params[0] as string[];
        keys = keys.filter((key) => !ids.includes(key.keyId));
        return { rows: [] };
      }
      throw new Error(`fake database cannot interpret SQL: ${text}`);
    },
    insert,
    update: (table: unknown) => ({
      set: async (values: object) => {
        if (table !== localFederationSigningState || !state) {
          throw new Error('unexpected update target');
        }
        state = { ...state, ...values } as FakeSigningStateRow;
      },
    }),
    delete: async () => {
      throw new Error('unexpected delete target');
    },
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db),
  };

  return {
    // One boundary cast keeps the in-memory store structurally compatible for the
    // service's narrow query surface; every test uses the typed handle below instead.
    database: { db } as never,
    getIdentity: () => identity,
    getKeys: () => keys,
    getState: () => state,
    setKeys: (rows) => {
      keys = rows;
    },
  };
}

describe('KeypairService database-backed identity', () => {
  const originalDomain = process.env.SOMS_DOMAIN;
  const rotationEnv = [
    'SOMS_FEDERATION_SIGNING_KEY_LIFETIME_MS',
    'SOMS_FEDERATION_CLOCK_SKEW_BUDGET_MS',
    'SOMS_FEDERATION_SUCCESSOR_PREPUBLICATION_MS',
    'SOMS_FEDERATION_PREDECESSOR_RETENTION_MS',
  ];
  let originalValues: Record<string, string | undefined>;

  beforeEach(() => {
    process.env.SOMS_DOMAIN = 'node-a.example';
    originalValues = Object.fromEntries(
      rotationEnv.map((name) => [name, process.env[name]]),
    );
  });

  afterEach(() => {
    for (const name of rotationEnv) {
      if (originalValues[name] === undefined) delete process.env[name];
      else process.env[name] = originalValues[name];
    }
    if (originalDomain === undefined) delete process.env.SOMS_DOMAIN;
    else process.env.SOMS_DOMAIN = originalDomain;
    vi.useRealTimers();
  });

  function setRotationTimings(): void {
    process.env.SOMS_FEDERATION_SIGNING_KEY_LIFETIME_MS = '600';
    process.env.SOMS_FEDERATION_CLOCK_SKEW_BUDGET_MS = '10';
    process.env.SOMS_FEDERATION_SUCCESSOR_PREPUBLICATION_MS = '100';
    process.env.SOMS_FEDERATION_PREDECESSOR_RETENTION_MS = '100';
  }

  it('bootstraps identity, initial signing key, and selection state for a fresh database', async () => {
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();

    expect(service.getStatus()).toEqual({ available: true });
    const identity = fake.getIdentity();
    const key = fake.getKeys()[0];
    const state = fake.getState();
    expect(identity?.domain).toBe('node-a.example');
    expect(identity?.rootPublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(identity?.rootPrivateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(identity?.rootKeyFingerprint).toBe(service.getRootKeyFingerprint());
    expect(key?.keyId).toMatch(/^node-a\.example\/k-[A-Za-z0-9_-]{20}$/);
    expect(key?.notBefore.getTime()).toBe(key?.createdAt.getTime());
    expect(key?.notAfter.getTime() - key?.notBefore.getTime()).toBe(
      30 * 24 * 3_600_000,
    );
    expect(state).toMatchObject({
      domain: 'node-a.example',
      currentKeyId: key?.keyId,
      plannedSwitchAt: null,
      plannedSuccessorKeyId: null,
    });
    expect(service.getKeyId()).toBe(key?.keyId);

    const certificates = service.getSigningKeyCertificates();
    expect(certificates).toHaveLength(1);
    expect(certificates[0]?.keyId).toBe(key?.keyId);
    expect(
      verifySigningCertificate(certificates[0]!, service.getRootPublicKeyB64()),
    ).toBe(true);
  });

  it('keeps the same identity and current key across restarts', async () => {
    const fake = fakeDatabase();
    const first = new KeypairService(fake.database);
    await first.initialize();
    const keyId = first.getKeyId();
    const fingerprint = first.getRootKeyFingerprint();

    const second = new KeypairService(fake.database);
    await second.initialize();
    expect(second.getKeyId()).toBe(keyId);
    expect(second.getRootKeyFingerprint()).toBe(fingerprint);
    expect(fake.getIdentity()?.rootKeyFingerprint).toBe(fingerprint);
    expect(fake.getKeys()).toHaveLength(1);
  });

  it('never regenerates an identity when federation history exists', async () => {
    const fake = fakeDatabase({ hasHistory: true });
    const service = new KeypairService(fake.database);
    await service.initialize();

    expect(service.getStatus()).toEqual({
      available: false,
      reason:
        'federation history exists but the local identity row is missing; restore the database from backup',
    });
    expect(fake.getIdentity()).toBeUndefined();
    expect(fake.getKeys()).toHaveLength(0);
    expect(() => service.getKeyId()).toThrow(BusinessException);
  });

  it('fails closed when SOMS_DOMAIN no longer matches the stored identity', async () => {
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();
    process.env.SOMS_DOMAIN = 'node-b.example';

    const changed = new KeypairService(fake.database);
    await changed.initialize();
    expect(changed.getStatus()).toEqual({
      available: false,
      reason:
        'SOMS_DOMAIN=node-b.example does not match the database identity domain=node-a.example',
    });
  });

  it('rotates through plan, switch, and predecessor removal with one signer at a time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();

    const firstKey = fake.getKeys()[0]!;
    expect(service.getKeyId()).toBe(firstKey.keyId);
    expect(service.getSigningKeyCertificates()).toHaveLength(1);

    // Entering the rotation window plans a successor without switching.
    vi.setSystemTime(1_700_000_000_420);
    await service.initialize();
    const secondKey = fake
      .getKeys()
      .find((key) => key.keyId !== firstKey.keyId)!;
    expect(secondKey.notBefore.getTime()).toBe(1_700_000_000_420);
    expect(secondKey.notAfter.getTime() - secondKey.notBefore.getTime()).toBe(
      600,
    );
    const plannedState = fake.getState();
    // plannedSwitchAt = max(current.notAfter - retention, now + skew) = t0+500
    expect(plannedState?.plannedSwitchAt?.getTime()).toBe(1_700_000_000_500);
    expect(plannedState?.plannedSuccessorKeyId).toBe(secondKey.keyId);
    expect(service.getKeyId()).toBe(firstKey.keyId);
    expect(service.getSigningKeyCertificates()).toHaveLength(2);

    // After the planned switch the successor is the only new-request signer; the
    // predecessor remains published for verification.
    vi.setSystemTime(1_700_000_000_505);
    await service.initialize();
    expect(service.getKeyId()).toBe(secondKey.keyId);
    expect(fake.getState()?.currentKeyId).toBe(secondKey.keyId);
    expect(fake.getState()?.plannedSuccessorKeyId).toBeNull();
    expect(service.getSigningKeyCertificates()).toHaveLength(2);
    expect(
      service
        .getSigningKeyCertificates()
        .every((certificate) =>
          verifySigningCertificate(certificate, service.getRootPublicKeyB64()),
        ),
    ).toBe(true);

    // Past the predecessor's notAfter its row (and private material) is removed.
    vi.setSystemTime(1_700_000_000_610);
    await service.initialize();
    expect(fake.getKeys().map((key) => key.keyId)).toEqual([secondKey.keyId]);
    expect(service.getSigningKeyCertificates()).toHaveLength(1);
  }, 20_000);

  it('recovers under the unchanged root when the current key expired without a successor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();
    const fingerprint = service.getRootKeyFingerprint();
    const rootPublicKey = service.getRootPublicKeyB64();
    const originalKeyId = service.getKeyId();

    // A simulated outage ran the wall clock past the key's notAfter with no
    // maintenance in between; the persisted row now advertises an expired key.
    vi.setSystemTime(1_700_000_002_000);
    fake.setKeys(
      fake.getKeys().map((key) => ({
        ...key,
        notAfter: new Date(1_700_000_000_600),
      })),
    );
    await service.initialize();

    expect(service.getStatus()).toEqual({ available: true });
    expect(service.getRootKeyFingerprint()).toBe(fingerprint);
    expect(service.getKeyId()).not.toBe(originalKeyId);
    expect(fake.getKeys().map((key) => key.keyId)).not.toContain(originalKeyId);
    const certificates = service.getSigningKeyCertificates();
    expect(certificates).toHaveLength(1);
    expect(verifySigningCertificate(certificates[0]!, rootPublicKey)).toBe(
      true,
    );
    expect(fake.getState()?.currentKeyId).toBe(certificates[0]?.keyId);
  }, 20_000);

  it('rejects signing outside the current key validity interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();

    // Move the wall clock past the current key's notAfter without running
    // maintenance, so the cached snapshot still selects an expired key.
    vi.setSystemTime(1_700_000_002_000);
    expect(() => service.getPrivateKey()).toThrow(BusinessException);
    try {
      service.getKeyId();
      expect.unreachable('getKeyId must refuse to sign with an expired key');
    } catch (error) {
      expect((error as BusinessException).bizCode).toBe(
        BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
      );
    }
  });
});
