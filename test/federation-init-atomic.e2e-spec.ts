import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../src/database/database.service.js';
import {
  federatedPeer,
  federationPullCursor,
  federationServeCursor,
  peerStateFeedPullCursor,
  peerStateFeedTarget,
  s2SIdentityNonce,
} from '../src/database/schema.js';
import { FederationCursorService } from '../src/federation/federation-cursor.service.js';
import { FederationIgniteService } from '../src/federation/federation-ignite.service.js';
import type {
  FederationIdentityClaim,
  FederationIdentityService,
} from '../src/federation/federation-identity.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';

describe('FederationIgniteService atomic commit', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationIgniteService;
  const domain = 'atomic-init.test';
  const claim: FederationIdentityClaim = {
    protocolVersion: 1,
    originDomain: domain,
    recipientDomain: 'local.test',
    pairwiseServerId: 'server-id',
    rootKeyFingerprint: 'sha256:fingerprint',
    nonce: 'n'.repeat(24),
    issuedAt: Date.now(),
    startChangeId: '12',
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    const cursor = new FederationCursorService(database);
    const identity = {
      consumeNonceInTx: async (tx: DatabaseTransaction) => {
        await tx.insert(s2SIdentityNonce).values({
          originDomain: domain,
          nonceHash: 'hash',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        });
      },
      pinOrVerifyInTx: async (tx: DatabaseTransaction) => {
        await tx.insert(federatedPeer).values({
          domain,
          trustLevel: 'trusted',
          pairwiseServerId: claim.pairwiseServerId,
          rootKeyFingerprint: claim.rootKeyFingerprint,
          identityPinnedAt: new Date(),
        });
        return undefined;
      },
      throwIdentityMismatch: (reason: string) => {
        throw new Error(reason);
      },
      throwNonceReplay: () => {
        throw new Error('nonce replay');
      },
    } as unknown as FederationIdentityService;
    service = new FederationIgniteService(
      database,
      identity,
      cursor,
      new PeerStateFeedService(database),
    );
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "FederatedPeer", "S2SIdentityNonce" CASCADE',
    );
  });

  afterAll(async () => {
    await mod.close();
  });

  it('commits trusted identity, nonce and both cursors together', async () => {
    await expect(
      service.accept({ domain, claim, legacyContinuityProven: false }),
    ).resolves.toBe(0n);

    expect(
      await database.db.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, domain),
      }),
    ).toMatchObject({ trustLevel: 'trusted' });
    expect(await database.db.select().from(s2SIdentityNonce)).toHaveLength(1);
    expect(await database.db.select().from(federationServeCursor)).toHaveLength(
      1,
    );
    expect(await database.db.select().from(federationPullCursor)).toHaveLength(
      1,
    );
    expect(await database.db.select().from(peerStateFeedTarget)).toHaveLength(
      1,
    );
    expect(
      await database.db.select().from(peerStateFeedPullCursor),
    ).toHaveLength(1);
  });

  it('rolls every init write back when cursor initialization fails', async () => {
    await expect(
      service.accept({
        domain,
        claim: { ...claim, nonce: 'x'.repeat(24), startChangeId: '-1' },
        legacyContinuityProven: false,
      }),
    ).rejects.toThrow('remote startChangeId must be non-negative');

    expect(await database.db.select().from(federatedPeer)).toEqual([]);
    expect(await database.db.select().from(s2SIdentityNonce)).toEqual([]);
    expect(await database.db.select().from(federationServeCursor)).toEqual([]);
    expect(await database.db.select().from(federationPullCursor)).toEqual([]);
    expect(await database.db.select().from(peerStateFeedTarget)).toEqual([]);
    expect(await database.db.select().from(peerStateFeedPullCursor)).toEqual(
      [],
    );
  });
});
