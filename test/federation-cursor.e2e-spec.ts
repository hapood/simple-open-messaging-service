import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { BusinessCode } from '../src/common/business-code.js';
import {
  federatedPeer,
  federationPullCursor,
  federationServeCursor,
} from '../src/database/schema.js';
import {
  FederationCursorError,
  FederationCursorService,
} from '../src/federation/federation-cursor.service.js';

describe('FederationCursorService', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationCursorService;
  const peerDomain = 'cursor-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [FederationCursorService],
    }).compile();
    database = mod.get(DatabaseService);
    service = mod.get(FederationCursorService);
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "FederatedPeer" CASCADE');
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'available',
    });
  });

  afterAll(async () => {
    await mod.close();
  });

  async function setAllocatedThrough(value: bigint): Promise<void> {
    await database.db
      .update(federationServeCursor)
      .set({ allocatedThrough: value })
      .where(eq(federationServeCursor.peerDomain, peerDomain));
  }

  it('pins both initial history floors and keeps them immutable on reconnect', async () => {
    await expect(service.prepareLocalStart(peerDomain)).resolves.toBe(0n);
    await setAllocatedThrough(8n);
    await expect(service.prepareLocalStart(peerDomain)).resolves.toBe(0n);
    await expect(service.initializePeer(peerDomain, 11n)).resolves.toEqual({
      localRetainedAfter: 0n,
      remoteRetainedAfter: 11n,
    });

    await setAllocatedThrough(9n);
    await expect(service.initializePeer(peerDomain, 11n)).resolves.toEqual({
      localRetainedAfter: 0n,
      remoteRetainedAfter: 11n,
    });
    await expect(service.initializePeer(peerDomain, 12n)).resolves.toEqual({
      localRetainedAfter: 0n,
      remoteRetainedAfter: 11n,
    });

    const [pull] = await database.db.select().from(federationPullCursor);
    expect(pull).toMatchObject({
      retainedAfter: 11n,
      committedThrough: 11n,
    });
  });

  it('returns the current resume cursor when after is omitted', async () => {
    await service.initializePeer(peerDomain, 0n);
    await setAllocatedThrough(10n);
    await service.servePage(peerDomain, 0n, async () => ({
      value: null,
      scannedThrough: 8n,
    }));

    await expect(service.rejectMissingAfter(peerDomain)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
      data: { resumeAfter: '0' },
    });
  });

  it('allows retry and advances acknowledgement with a later cursor', async () => {
    await service.initializePeer(peerDomain, 0n);
    await setAllocatedThrough(10n);
    const first = await service.servePage(peerDomain, 0n, async (context) => {
      expect(context.retry).toBe(false);
      return { value: ['first'], scannedThrough: 5n };
    });
    expect(first.value).toEqual(['first']);

    await service.servePage(peerDomain, 0n, async (context) => {
      expect(context.retry).toBe(true);
      expect(context.previouslyServedThrough).toBe(5n);
      return { value: ['retry'], scannedThrough: 5n };
    });
    await service.servePage(peerDomain, 5n, async (context) => {
      expect(context.retry).toBe(false);
      expect(context.acknowledgedThrough).toBe(5n);
      return { value: ['next'], scannedThrough: 8n };
    });

    const [cursor] = await database.db.select().from(federationServeCursor);
    expect(cursor).toMatchObject({
      retainedAfter: 0n,
      acknowledgedThrough: 5n,
      lastServedThrough: 8n,
    });
  });

  it('rejects fast-forward and only accepts the acknowledged or last-served cursor', async () => {
    await service.initializePeer(peerDomain, 0n);
    await setAllocatedThrough(10n);
    await service.servePage(peerDomain, 0n, async () => ({
      value: null,
      scannedThrough: 5n,
    }));
    for (const after of [6n, 7n, 11n]) {
      await expect(
        service.servePage(peerDomain, after, async () => ({
          value: null,
          scannedThrough: after,
        })),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.FEDERATION_FEED_CURSOR_MISMATCH,
        status: 200,
        data: {
          acknowledgedThrough: '0',
          lastServedThrough: '5',
        },
      });
    }

    await expect(service.servePage(peerDomain, 5n, async () => ({
      value: null,
      scannedThrough: 8n,
    }))).resolves.toMatchObject({ scannedThrough: 8n });

    await expect(
      service.servePage(peerDomain, 0n, async () => ({
        value: null,
        scannedThrough: 0n,
      })),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      data: { resumeAfter: '5' },
    });
  });

  it('rolls back the implicit acknowledgement when page scanning fails', async () => {
    await service.initializePeer(peerDomain, 0n);
    await setAllocatedThrough(4n);
    await service.servePage(peerDomain, 0n, async () => ({
      value: null,
      scannedThrough: 4n,
    }));
    await expect(
      service.servePage(peerDomain, 4n, async () => {
        throw new Error('scan failed');
      }),
    ).rejects.toThrow('scan failed');

    const [cursor] = await database.db
      .select()
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain));
    expect(cursor).toMatchObject({
      acknowledgedThrough: 0n,
      lastServedThrough: 4n,
    });
  });

  it('immediately rejects a concurrent request for the same peer', async () => {
    await service.initializePeer(peerDomain, 0n);
    await setAllocatedThrough(3n);
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = service.servePage(peerDomain, 0n, async () => {
      firstEntered();
      await firstCanFinish;
      return { value: 'first', scannedThrough: 3n };
    });
    await firstDidEnter;
    await expect(
      service.servePage(peerDomain, 0n, async () => ({
        value: 'second',
        scannedThrough: 3n,
      })),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_REQUEST_IN_PROGRESS,
      status: 200,
    });
    releaseFirst();
    await expect(first).resolves.toEqual({
      value: 'first',
      scannedThrough: 3n,
    });
  });

  it('rejects a scannedThrough value behind after', async () => {
    await service.initializePeer(peerDomain, 0n);
    await expect(
      service.servePage(peerDomain, 0n, async () => ({
        value: null,
        scannedThrough: -1n,
      })),
    ).rejects.toBeInstanceOf(FederationCursorError);
  });
});
