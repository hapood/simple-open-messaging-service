import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseService } from '../database/database.service.js';
import {
  localFederationRoot,
  localFederationSigningKey,
  localFederationSigningState,
} from '../database/schema.js';
import { verifySigningCertificate } from './federation-certificate.js';
import { KeypairService } from './keypair.service.js';

interface FakeRootRow {
  id: number;
  domain: string;
  rootPublicKey: string;
  rootPrivateKey: string;
  notBefore: Date;
  notAfter: Date;
  claimable: boolean;
  unpublishedAt: Date | null;
  createdAt: Date;
}

interface FakeSigningKeyRow {
  rootId: number;
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
  getRoots: () => FakeRootRow[];
  getKeys: () => FakeSigningKeyRow[];
  getState: () => FakeSigningStateRow | undefined;
  setKeys: (rows: FakeSigningKeyRow[]) => void;
}

/** Rebuilds the SQL text of a Drizzle `sql` fragment; interpolated values appear
 *  as parameters. Only the advisory-lock and history probes reach execute(). */
function interpretSql(fragment: unknown): string {
  const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks ?? [];
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
      text += '?';
    }
  }
  return text;
}

let nextRootId = 1;

/** Extract root-row ids referenced by an eq(localFederationRoot.id, n) condition. */
function fakeRootsById(condition: unknown): number[] {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  const ids: number[] = [];
  for (const chunk of chunks) {
    const record = chunk as { value?: unknown };
    if (
      typeof chunk === 'object' &&
      chunk !== null &&
      !Array.isArray(chunk) &&
      record.value !== undefined &&
      typeof record.value === 'number'
    ) {
      ids.push(record.value as number);
    }
  }
  return ids;
}

function fakeDatabase(options: { hasHistory?: boolean } = {}): FakeHandle {
  let roots: FakeRootRow[] = [];
  let keys: FakeSigningKeyRow[] = [];
  let state: FakeSigningStateRow | undefined;

  const db = {
    query: {
      localFederationRoot: {
        findMany: async () => roots.map((root) => ({ ...root })),
        findFirst: async () => (roots[0] ? { ...roots[0]! } : undefined),
      },
      localFederationSigningKey: {
        findMany: async () => keys.map((key) => ({ ...key })),
      },
      localFederationSigningState: {
        findFirst: async () => (state ? { ...state } : undefined),
      },
    },
    execute: async (fragment: unknown) => {
      const text = interpretSql(fragment);
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('hasHistory')) {
        return { rows: [{ hasHistory: options.hasHistory ?? false }] };
      }
      throw new Error(`fake database cannot interpret SQL: ${text}`);
    },
    insert: (table: unknown) => ({
      values: (values: object) => {
        if (table === localFederationRoot) {
          const row = {
            ...(values as Omit<FakeRootRow, 'id' | 'createdAt'>),
            id: nextRootId++,
            createdAt: new Date(),
          } as FakeRootRow;
          roots.push(row);
          return { returning: async () => [{ id: row.id }] };
        }
        if (table === localFederationSigningKey) {
          keys.push(values as FakeSigningKeyRow);
          return Promise.resolve();
        }
        if (table === localFederationSigningState) {
          state = values as FakeSigningStateRow;
          return Promise.resolve();
        }
        throw new Error('unexpected insert target');
      },
    }),
    update: (table: unknown) => ({
      set: (values: object) => ({
        where: async (condition: unknown) => {
          if (table === localFederationSigningState) {
            if (!state) throw new Error('no signing state to update');
            state = { ...state, ...(values as FakeSigningStateRow) };
            return;
          }
          if (table === localFederationRoot) {
            // The only root update filters by id equality; apply the change to
            // matching rows.
            const ids = fakeRootsById(condition);
            if (ids.length === 0)
              throw new Error(
                'fake database cannot interpret root update without ids',
              );
            roots = roots.map((root) =>
              ids.includes(root.id)
                ? { ...root, ...(values as Partial<FakeRootRow>) }
                : root,
            );
            return;
          }
          throw new Error('unexpected update target');
        },
      }),
    }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db),
  };

  return {
    database: { db } as never,
    getRoots: () => roots,
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
    nextRootId = 1;
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

  it('bootstraps a claimable root epoch, initial signing key, and selection state', async () => {
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();

    expect(service.getStatus()).toEqual({ available: true });
    const root = fake.getRoots()[0];
    const key = fake.getKeys()[0];
    const state = fake.getState();
    expect(root?.domain).toBe('node-a.example');
    expect(root?.rootPublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(root?.rootPrivateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(root?.claimable).toBe(true);
    expect(key?.rootId).toBe(root?.id);
    expect(key?.keyId).toMatch(/^node-a\.example\/k-[A-Za-z0-9_-]{20}$/);
    expect(state).toMatchObject({
      domain: 'node-a.example',
      currentKeyId: key?.keyId,
      plannedSwitchAt: null,
      plannedSuccessorKeyId: null,
    });
    expect(service.getKeyId()).toBe(key?.keyId);
    expect(service.getRootPublicKeyB64()).toBe(root?.rootPublicKey);

    // The published group has exactly this root; the certificate names it and
    // verifies under it.
    const group = service.getRootGroup();
    expect(group).toHaveLength(1);
    expect(group[0]?.ed25519).toBe(root?.rootPublicKey);
    const certificates = service.getSigningKeyCertificates();
    expect(certificates).toHaveLength(1);
    expect(certificates[0]?.keyId).toBe(key?.keyId);
    expect(certificates[0]?.root).toBe(root?.rootPublicKey);
    expect(
      verifySigningCertificate(certificates[0]!, service.getRootPublicKeyB64()),
    ).toBe(true);
  });

  it('keeps the same identity and current key across restarts', async () => {
    const fake = fakeDatabase();
    const first = new KeypairService(fake.database);
    await first.initialize();
    const keyId = first.getKeyId();
    const rootPublicKey = first.getRootPublicKeyB64();

    const second = new KeypairService(fake.database);
    await second.initialize();
    expect(second.getKeyId()).toBe(keyId);
    expect(second.getRootPublicKeyB64()).toBe(rootPublicKey);
    expect(fake.getRoots()).toHaveLength(1);
    expect(fake.getKeys()).toHaveLength(1);
  });

  it('never regenerates an identity when federation history exists', async () => {
    const fake = fakeDatabase({ hasHistory: true });
    const service = new KeypairService(fake.database);
    await service.initialize();

    expect(service.getStatus()).toEqual({
      available: false,
      reason:
        'federation history exists but the local root-identity rows are missing; restore the database from backup',
    });
    expect(fake.getRoots()).toHaveLength(0);
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

  it('rotates signing keys through plan and switch while retaining the predecessor', async () => {
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

    // Past the predecessor's notAfter its row is retained forever — private
    // material included — while publication drops it.
    vi.setSystemTime(1_700_000_000_610);
    await service.initialize();
    expect(fake.getKeys().map((key) => key.keyId)).toEqual(
      expect.arrayContaining([firstKey.keyId, secondKey.keyId]),
    );
    expect(service.getSigningKeyCertificates()).toHaveLength(1);
  }, 20_000);

  it('recovers under the unchanged root when the current key expired without a successor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();
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
    expect(service.getRootPublicKeyB64()).toBe(rootPublicKey);
    expect(service.getKeyId()).not.toBe(originalKeyId);
    expect(fake.getKeys().map((key) => key.keyId)).toContain(originalKeyId);
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

  it('rotates the root epoch with immediate certificate revocation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();
    const previousRoot = fake.getRoots()[0]!;
    const previousRootKey = previousRoot.rootPublicKey;
    const previousRootPrivate = previousRoot.rootPrivateKey;

    // Advance so a second signing key exists under the old root.
    vi.setSystemTime(1_700_000_000_420);
    await service.initialize();
    const oldRootKeyCount = fake.getKeys().length;

    vi.setSystemTime(1_700_000_000_430);
    const result = await service.rotateRoot();
    expect(result.previousRootId).toBe(previousRoot.id);
    expect(fake.getRoots()).toHaveLength(2);
    expect(fake.getRoots().filter((root) => root.claimable)).toHaveLength(1);
    expect(service.getRootPublicKeyB64()).toBe(result.newRootPublicKey);
    expect(result.newRootPublicKey).not.toBe(previousRootKey);

    // All keys ever generated are retained, including under the old root.
    expect(fake.getKeys().length).toBe(oldRootKeyCount + 1);
    expect(fake.getKeys().every((key) => key.privateKey.length === 44)).toBe(
      true,
    );

    // The published group still contains the predecessor; the published
    // certificates are only successor-authorized — removal is the revocation.
    const group = service.getRootGroup();
    expect(group.map((entry) => entry.ed25519)).toEqual(
      expect.arrayContaining([previousRootKey, result.newRootPublicKey]),
    );
    const certificates = service.getSigningKeyCertificates();
    expect(certificates.length).toBeGreaterThanOrEqual(1);
    expect(
      certificates.every(
        (certificate) => certificate.root === result.newRootPublicKey,
      ),
    ).toBe(true);
    expect(
      certificates.every((certificate) =>
        verifySigningCertificate(certificate, certificate.root),
      ),
    ).toBe(true);

    // Sealed challenges under the retired root stay openable: the retained
    // private key is resolvable by public key for both roots.
    expect(service.isRetainedPublicKey(previousRootKey)).toBe(true);
    expect(service.isRetainedPublicKey(result.newRootPublicKey)).toBe(true);
    expect(service.getRetainedPrivateKey(previousRootKey)).toEqual(
      Uint8Array.from(Buffer.from(previousRootPrivate, 'base64')),
    );
    const retiredSigningKey = fake
      .getKeys()
      .find((key) => key.rootId === previousRoot.id)!;
    expect(service.getRetainedPrivateKey(retiredSigningKey.publicKey)).toEqual(
      Uint8Array.from(Buffer.from(retiredSigningKey.privateKey, 'base64')),
    );
    expect(service.isRetainedPublicKey('A'.repeat(43) + '=')).toBe(false);
  }, 20_000);

  it('refuses to unpublish the claimable root or a still-valid predecessor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(fake.database);
    await service.initialize();
    const claimableId = fake.getRoots()[0]!.id;
    await expect(service.unpublishRoot(claimableId)).rejects.toThrow(
      /claimable/,
    );

    vi.setSystemTime(1_700_000_000_430);
    const rotation = await service.rotateRoot();
    await expect(service.unpublishRoot(rotation.newRootId)).rejects.toThrow(
      /claimable/,
    );
    // The predecessor root's validity (default 3650 days) still runs; an
    // operator may only unpublish after it expired or adoption completed —
    // here it is still valid, so the guard fires.
    await expect(
      service.unpublishRoot(rotation.previousRootId),
    ).rejects.toThrow(/still-valid/);
    expect(service.getRootGroup()).toHaveLength(2);
  }, 20_000);
});
