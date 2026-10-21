import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseService } from '../database/database.service.js';
import {
  account,
  identityNamespace,
  localFederationRoot,
  localFederationSigningKey,
  localFederationSigningState,
  messageThread,
} from '../database/schema.js';
import {
  isValidRootKeyEntry,
  verifySigningCertificate,
} from './federation-certificate.js';
import { KeypairService } from './keypair.service.js';

// Injected collaborators for the (0, 0) announcement path: the change store
// and the SSE wake are mocked at module level; tests that care about them
// assert on the mocks directly.
const changes = {
  recordNamespaceChangeInTx: vi.fn(async () => 7n),
  recordClientChangeInTx: vi.fn(async () => 11n),
  readFeedEndId: vi.fn(async () => 7n),
};
const sse = { notifyProfileNamespaceChange: vi.fn() };

interface FakeRootRow {
  id: number;
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
  keyName: string;
  publicKey: string;
  privateKey: string;
  createdAt: Date;
  notBefore: Date;
  notAfter: Date;
}

interface FakeSigningStateRow {
  id: number;
  currentKeyName: string;
  plannedSwitchAt: Date | null;
  plannedSuccessorKeyName: string | null;
  updatedAt: Date;
}

interface FakeHandle {
  database: DatabaseService;
  getRoots: () => FakeRootRow[];
  getKeys: () => FakeSigningKeyRow[];
  getState: () => FakeSigningStateRow | undefined;
  setKeys: (rows: FakeSigningKeyRow[]) => void;
  setDomain: (domain: string) => void;
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
  let localNamespace: { id: number; domain: string } | undefined;

  const db = {
    query: {
      identityNamespace: {
        findFirst: async () =>
          localNamespace ? { ...localNamespace } : undefined,
      },
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
        if (table === identityNamespace) {
          localNamespace = values as { id: number; domain: string };
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
            const ids = fakeRootsById(condition);
            const updates = values as Partial<FakeRootRow>;
            roots = roots.map((root) =>
              ids.length === 0 || ids.includes(root.id)
                ? { ...root, ...updates }
                : root,
            );
            return;
          }
          if (table === identityNamespace) {
            if (!localNamespace) throw new Error('local namespace is missing');
            localNamespace = { ...localNamespace, ...values };
            return;
          }
          if (table === account || table === messageThread) return;
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
    setDomain: (domain) => {
      if (!localNamespace) throw new Error('local namespace is missing');
      localNamespace = { ...localNamespace, domain };
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
    vi.clearAllMocks();
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
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await service.initialize();

    expect(service.getStatus()).toEqual({ available: true });
    const root = fake.getRoots()[0];
    const key = fake.getKeys()[0];
    const state = fake.getState();
    expect(root).not.toHaveProperty('domain');
    expect(service.getIdentityDomain()).toBe('node-a.example');
    expect(root?.rootPublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(root?.rootPrivateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(root?.claimable).toBe(true);
    expect(key?.rootId).toBe(root?.id);
    expect(key?.keyName).toMatch(/^k-[A-Za-z0-9_-]{20}$/);
    expect(state).toMatchObject({
      id: 0,
      currentKeyName: key?.keyName,
      plannedSwitchAt: null,
      plannedSuccessorKeyName: null,
    });
    expect(state).not.toHaveProperty('domain');
    expect(service.getKeyId()).toBe(`node-a.example/${key?.keyName}`);
    expect(service.getRootPublicKeyB64()).toBe(root?.rootPublicKey);

    // The published group has exactly this root; the certificate names it and
    // verifies under it.
    const group = service.getRootGroup();
    expect(group).toHaveLength(1);
    expect(group[0]?.ed25519).toBe(root?.rootPublicKey);
    const certificates = service.getSigningKeyCertificates();
    expect(certificates).toHaveLength(1);
    expect(certificates[0]?.keyId).toBe(`node-a.example/${key?.keyName}`);
    expect(certificates[0]?.root).toBe(root?.rootPublicKey);
    expect(
      verifySigningCertificate(certificates[0]!, service.getRootPublicKeyB64()),
    ).toBe(true);
  });

  it('shares one initialization promise across concurrent callers', async () => {
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    const calls = [
      service.initialize(),
      service.initialize(),
      service.waitUntilInitialized(),
    ];
    await Promise.all(calls);
    expect(fake.getRoots()).toHaveLength(1);
    expect(fake.getKeys()).toHaveLength(1);
    expect(service.getStatus()).toEqual({ available: true });
  });

  it('keeps the same identity and current key across restarts', async () => {
    const fake = fakeDatabase();
    const first = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await first.initialize();
    const keyId = first.getKeyId();
    const rootPublicKey = first.getRootPublicKeyB64();

    const second = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await second.initialize();
    expect(second.getKeyId()).toBe(keyId);
    expect(second.getRootPublicKeyB64()).toBe(rootPublicKey);
    expect(fake.getRoots()).toHaveLength(1);
    expect(fake.getKeys()).toHaveLength(1);
  });

  it('never regenerates an identity when federation history exists', async () => {
    const fake = fakeDatabase({ hasHistory: true });
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
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

  it('re-binds a changed SOMS_DOMAIN without changing keys or validity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await service.initialize();
    const rootPublicKey = service.getRootPublicKeyB64();
    const previousKeyId = service.getKeyId();
    const rootsBefore = structuredClone(fake.getRoots());
    const keysBefore = structuredClone(fake.getKeys());
    const stateBefore = structuredClone(fake.getState());
    const certificateBefore = service.getSigningKeyCertificates()[0]!;
    service.onModuleDestroy();
    vi.clearAllMocks();
    process.env.SOMS_DOMAIN = 'node-b.example';

    const changed = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await changed.initialize();

    expect(changed.getStatus()).toEqual({ available: true });
    expect(changed.getIdentityDomain()).toBe('node-b.example');
    expect(changed.getRootPublicKeyB64()).toBe(rootPublicKey);
    expect(changed.getKeyId()).toMatch(/^node-b\.example\/k-/);
    expect(changed.getKeyId()).not.toBe(previousKeyId);
    expect(changed.getSigningKeyCertificates()).toHaveLength(1);
    expect(fake.getRoots()).toEqual(rootsBefore);
    expect(fake.getKeys()).toEqual(keysBefore);
    expect(fake.getState()).toEqual(stateBefore);
    const certificateAfter = changed.getSigningKeyCertificates()[0]!;
    expect(certificateAfter).toEqual({
      ...certificateBefore,
      keyId: `node-b.example/${keysBefore[0]!.keyName}`,
      authorizationSignature: expect.any(String),
    });
    expect(certificateAfter.authorizationSignature).not.toBe(
      certificateBefore.authorizationSignature,
    );
    expect(verifySigningCertificate(certificateAfter, rootPublicKey)).toBe(
      true,
    );
    expect(
      verifySigningCertificate(
        {
          ...certificateAfter,
          authorizationSignature: certificateBefore.authorizationSignature,
        },
        rootPublicKey,
      ),
    ).toBe(false);
    expect(changes.recordNamespaceChangeInTx).toHaveBeenCalledWith(
      expect.anything(),
      0,
    );
    expect(changes.recordClientChangeInTx).toHaveBeenCalledWith(
      expect.anything(),
      { publisherNamespaceId: 0, profileNamespaceId: 0 },
    );
    expect(sse.notifyProfileNamespaceChange).not.toHaveBeenCalled();
  });

  it('preserves a prepublished successor and switches on the original schedule after renaming', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const first = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await first.initialize();
    vi.setSystemTime(1_700_000_000_420);
    await first.maintain();
    const stateBefore = structuredClone(fake.getState());
    const keysBefore = structuredClone(fake.getKeys());
    const certificatesBefore = first.getSigningKeyCertificates();
    expect(stateBefore?.plannedSuccessorKeyName).not.toBeNull();
    first.onModuleDestroy();

    process.env.SOMS_DOMAIN = 'node-b.example';
    const renamed = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await renamed.initialize();
    expect(fake.getState()).toEqual(stateBefore);
    expect(fake.getKeys()).toEqual(keysBefore);
    const certificatesAfter = renamed.getSigningKeyCertificates();
    expect(certificatesAfter).toHaveLength(2);
    for (const [index, certificate] of certificatesAfter.entries()) {
      expect(certificate).toMatchObject({
        ...certificatesBefore[index],
        keyId: certificatesBefore[index]!.keyId.replace(
          'node-a.example/',
          'node-b.example/',
        ),
        authorizationSignature: expect.any(String),
      });
      expect(verifySigningCertificate(certificate, certificate.root)).toBe(
        true,
      );
    }

    vi.setSystemTime(1_700_000_000_505);
    await renamed.maintain();
    expect(renamed.getKeyId()).toBe(
      `node-b.example/${stateBefore!.plannedSuccessorKeyName}`,
    );
    expect(fake.getKeys()).toEqual(keysBefore);
    expect(fake.getState()?.plannedSuccessorKeyName).toBeNull();
    renamed.onModuleDestroy();
  });

  it('does not reannounce the same domain and restores the same certificate when renamed back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const fake = fakeDatabase();
    const boot = async () => {
      const service = new KeypairService(
        fake.database,
        changes as never,
        sse as never,
      );
      await service.initialize();
      service.onModuleDestroy();
      return service;
    };
    const original = await boot();
    const certificateBefore = original.getSigningKeyCertificates();
    const keysBefore = structuredClone(fake.getKeys());
    vi.clearAllMocks();
    await boot();
    expect(changes.recordNamespaceChangeInTx).not.toHaveBeenCalled();
    expect(changes.recordClientChangeInTx).not.toHaveBeenCalled();

    process.env.SOMS_DOMAIN = 'node-b.example';
    await boot();
    process.env.SOMS_DOMAIN = 'node-a.example';
    const restored = await boot();
    expect(restored.getSigningKeyCertificates()).toEqual(certificateBefore);
    expect(fake.getKeys()).toEqual(keysBefore);
    expect(changes.recordNamespaceChangeInTx).toHaveBeenCalledTimes(2);
    expect(changes.recordClientChangeInTx).toHaveBeenCalledTimes(2);
  });

  it('reloads the namespace-0 domain rather than using configuration during maintenance', async () => {
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await service.initialize();
    const originalKey = structuredClone(fake.getKeys());
    fake.setDomain('persisted.example');
    process.env.SOMS_DOMAIN = 'unrelated.example';
    await service.maintain();
    expect(service.getIdentityDomain()).toBe('persisted.example');
    expect(service.getKeyId()).toBe(
      `persisted.example/${originalKey[0]!.keyName}`,
    );
    expect(fake.getKeys()).toEqual(originalKey);
    service.onModuleDestroy();
  });

  it('never exposes retained private root keys in administration responses', async () => {
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await service.initialize();
    const roots = service.getRootEpochs();
    expect(roots).toHaveLength(1);
    expect(roots[0]).not.toHaveProperty('rootPrivateKey');
    expect(roots[0]).toMatchObject({
      domain: 'node-a.example',
      rootPublicKey: fake.getRoots()[0]!.rootPublicKey,
    });
    expect(JSON.stringify(roots)).not.toContain(
      fake.getRoots()[0]!.rootPrivateKey,
    );
    service.onModuleDestroy();
  });

  it('rotates signing keys through plan and switch while retaining the predecessor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await service.initialize();

    const firstKey = fake.getKeys()[0]!;
    expect(service.getKeyId()).toBe(`node-a.example/${firstKey.keyName}`);
    expect(service.getSigningKeyCertificates()).toHaveLength(1);

    // Entering the rotation window plans a successor without switching.
    vi.setSystemTime(1_700_000_000_420);
    await service.maintain();
    const secondKey = fake
      .getKeys()
      .find((key) => key.keyName !== firstKey.keyName)!;
    expect(secondKey.notBefore.getTime()).toBe(1_700_000_000_420);
    expect(secondKey.notAfter.getTime() - secondKey.notBefore.getTime()).toBe(
      600,
    );
    const plannedState = fake.getState();
    // plannedSwitchAt = max(current.notAfter - retention, now + skew) = t0+500
    expect(plannedState?.plannedSwitchAt?.getTime()).toBe(1_700_000_000_500);
    expect(plannedState?.plannedSuccessorKeyName).toBe(secondKey.keyName);
    expect(service.getKeyId()).toBe(`node-a.example/${firstKey.keyName}`);
    expect(service.getSigningKeyCertificates()).toHaveLength(2);

    // After the planned switch the successor is the only new-request signer; the
    // predecessor remains published for verification.
    vi.setSystemTime(1_700_000_000_505);
    await service.maintain();
    expect(service.getKeyId()).toBe(`node-a.example/${secondKey.keyName}`);
    expect(fake.getState()?.currentKeyName).toBe(secondKey.keyName);
    expect(fake.getState()?.plannedSuccessorKeyName).toBeNull();
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
    await service.maintain();
    expect(fake.getKeys().map((key) => key.keyName)).toEqual(
      expect.arrayContaining([firstKey.keyName, secondKey.keyName]),
    );
    expect(service.getSigningKeyCertificates()).toHaveLength(1);
  }, 20_000);

  it('recovers under the unchanged root when the current key expired without a successor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
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
    await service.maintain();

    expect(service.getStatus()).toEqual({ available: true });
    expect(service.getRootPublicKeyB64()).toBe(rootPublicKey);
    expect(service.getKeyId()).not.toBe(originalKeyId);
    expect(
      fake.getKeys().map((key) => `node-a.example/${key.keyName}`),
    ).toContain(originalKeyId);
    const certificates = service.getSigningKeyCertificates();
    expect(certificates).toHaveLength(1);
    expect(verifySigningCertificate(certificates[0]!, rootPublicKey)).toBe(
      true,
    );
    expect(`node-a.example/${fake.getState()?.currentKeyName}`).toBe(
      certificates[0]?.keyId,
    );
  }, 20_000);

  it('rejects signing outside the current key validity interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
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
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
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
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
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

  it('announces a replacement on both feeds in one transaction and wakes devices after commit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await service.initialize();
    vi.clearAllMocks();

    const rotation = await service.rotateRoot();

    // The namespace-0 s2s feed item (peers re-pull /profile-namespaces/0 for
    // the new root public key) and the (0, 0) client change (devices re-
    // resolve the pair) both ran inside the replacement transaction.
    expect(changes.recordNamespaceChangeInTx).toHaveBeenCalledTimes(1);
    expect(changes.recordNamespaceChangeInTx).toHaveBeenCalledWith(
      expect.anything(),
      0,
    );
    expect(changes.recordClientChangeInTx).toHaveBeenCalledTimes(1);
    expect(changes.recordClientChangeInTx).toHaveBeenCalledWith(
      expect.anything(),
      { publisherNamespaceId: 0, profileNamespaceId: 0 },
    );
    // The wake broadcasts the allocated client change id after commit, and
    // the admin answer carries it as a decimal string.
    expect(sse.notifyProfileNamespaceChange).toHaveBeenCalledTimes(1);
    expect(sse.notifyProfileNamespaceChange).toHaveBeenCalledWith(11n);
    expect(rotation.clientChangeId).toBe('11');
  }, 20_000);

  it('serves a federation-valid roots group after a rotation: intervals, uniqueness, and certificate enclosure', async () => {
    // The well-known document is consumed by the discovery-side validators
    // (federation-certificate.ts / discovery.service.ts); this test replays
    // exactly those acceptance rules against our own published surface after
    // an administrator-triggered replacement, using the real validators.
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    setRotationTimings();
    const fake = fakeDatabase();
    const service = new KeypairService(
      fake.database,
      changes as never,
      sse as never,
    );
    await service.initialize();
    vi.setSystemTime(1_700_000_000_430);
    const rotation = await service.rotateRoot();
    const now = Date.now();

    const group = service.getRootGroup();
    // Rotation never cleans up: the predecessor stays published alongside the
    // successor, deterministically ordered by notBefore.
    expect(group).toHaveLength(2);
    expect(group.map((entry) => entry.ed25519)).toEqual([
      expect.any(String),
      rotation.newRootPublicKey,
    ]);
    for (let i = 1; i < group.length; i += 1)
      expect(group[i]!.notBefore).toBeGreaterThanOrEqual(
        group[i - 1]!.notBefore,
      );

    // Per-entry structural rules: canonical base64 key, safe-integer
    // half-open validity interval, notBefore < notAfter.
    for (const entry of group) expect(isValidRootKeyEntry(entry)).toBe(true);

    // Document-level rules: unique keys, and at least one currently valid
    // root. The predecessor is usually also still valid — that is exactly
    // why it stays published for peers in the adoption window — but the
    // claimable successor must always be among the currently valid roots.
    expect(new Set(group.map((entry) => entry.ed25519)).size).toBe(
      group.length,
    );
    const currentlyValid = group.filter(
      (entry) => entry.notBefore <= now && now < entry.notAfter,
    );
    expect(currentlyValid.length).toBeGreaterThanOrEqual(1);
    expect(currentlyValid.map((entry) => entry.ed25519)).toContain(
      service.getRootPublicKeyB64(),
    );

    // Certificate rules: every published certificate must name a root from
    // the group, verify under it, and keep its interval enclosed by that
    // root's interval.
    const byKey = new Map(group.map((entry) => [entry.ed25519, entry]));
    for (const certificate of service.getSigningKeyCertificates()) {
      const authorizing = byKey.get(certificate.root);
      expect(authorizing).toBeDefined();
      expect(certificate.notBefore).toBeGreaterThanOrEqual(
        authorizing!.notBefore,
      );
      expect(certificate.notAfter).toBeLessThanOrEqual(authorizing!.notAfter);
      expect(verifySigningCertificate(certificate, certificate.root)).toBe(
        true,
      );
    }
  }, 20_000);
});
