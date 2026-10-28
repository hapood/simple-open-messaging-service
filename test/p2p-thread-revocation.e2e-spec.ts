import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { RequestTransactionCapabilityImpl } from '../src/relationship/request/request-transaction-capability.impl.js';
import * as tables from '../src/database/schema.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { SseService } from '../src/gateway/sse.service.js';
import { CallStateRegistry } from '../src/gateway/call-state.registry.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { FederationNamespaceService } from '../src/federation/federation-namespace.service.js';
import { ProfileNamespaceFeedService } from '../src/federation/profile-namespace-feed.service.js';
import { ProfileNamespaceService } from '../src/federation/profile-namespace.service.js';
import { ProfileNamespaceChangeStore } from '../src/federation/profile-namespace-change-store.service.js';
import { KeypairService } from '../src/federation/keypair.service.js';
import { UserIntentService } from '../src/user/p2p-intent/authored/user-intent.service.js';

/** Real SQL/transactions without booting unrelated controllers or schedulers.
 * Only outbound federation wake delivery is a spy; local fixtures have no peer. */
describe('P2P thread-keyed relationship revocation', () => {
  let database: DatabaseService;
  let feed: ClientStateFeedService;
  let sse: SseService;
  let namespaces: FederationNamespaceService;
  let service: UserIntentService;
  let sequence = 0;

  beforeAll(() => {
    database = new DatabaseService();
    sse = new SseService(database, new CallStateRegistry());
    feed = new ClientStateFeedService(database, sse);
    const changes = new ProfileNamespaceChangeStore(database);
    const keys = new KeypairService(database, changes, sse);
    namespaces = new FederationNamespaceService(
      database,
      new ProfileNamespaceFeedService(database, changes),
      new ProfileNamespaceService(database, keys),
    );
    const requestCapability = new RequestTransactionCapabilityImpl(feed);
    service = new UserIntentService(
      database,
      feed,
      new PeerStateFeedService(database),
      { pushStateFeedNamespaces: vi.fn() },
      namespaces,
      requestCapability,
      { tick: vi.fn().mockResolvedValue(undefined) } as never,
    );
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    feed?.onModuleDestroy();
    sse?.onModuleDestroy();
    await database?.onApplicationShutdown();
  });

  async function pair() {
    const suffix = ++sequence;
    const [alice, bob, stranger] = await database.db
      .insert(tables.account)
      .values([
        { account: `thread-revoke-a-${suffix}` },
        { account: `thread-revoke-b-${suffix}` },
        { account: `thread-revoke-c-${suffix}` },
      ])
      .returning();
    await service.execute({
      userId: alice.id,
      target: { account: bob.account, namespaceId: 0 },
      decision: 'REQUESTED',
      snapshot: { displayName: bob.account, avatar: null },
    });
    const row = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(tables.relationshipPair.endpointAAccount, alice.account),
        eq(tables.relationshipPair.endpointBAccount, bob.account),
      ),
    });
    if (!row?.threadId) throw new Error('request did not create a pair thread');
    return { alice, bob, stranger, threadId: row.threadId };
  }

  async function activate(f: Awaited<ReturnType<typeof pair>>) {
    expect(
      await service.execute({
        userId: f.bob.id,
        target: { account: f.alice.account, namespaceId: 0 },
        decision: 'ACCEPTED',
      }),
    ).toMatchObject({ status: 'APPLIED' });
  }

  it('rejects a pending pair and a caller outside the pair', async () => {
    const f = await pair();
    expect(
      await service.endEstablishedRelationship({
        userId: f.alice.id,
        threadId: f.threadId,
      }),
    ).toMatchObject({ status: 'REJECTED' });
    await activate(f);
    expect(
      await service.endEstablishedRelationship({
        userId: f.stranger.id,
        threadId: f.threadId,
      }),
    ).toMatchObject({ status: 'REJECTED' });
    expect(
      await database.db.query.relationshipPair.findFirst({
        where: eq(tables.relationshipPair.threadId, f.threadId),
      }),
    ).toMatchObject({ active: true });
  });

  it('revokes an established pair without rewriting its accepted request history', async () => {
    const f = await pair();
    await activate(f);
    // Request lifecycle wiring is separate: explicitly associate a completed
    // round so this regression proves established revocation leaves it alone.
    const [request] = await database.db
      .insert(tables.relationshipRequest)
      .values({
        kind: 'FRIEND',
        authorAccount: f.alice.account,
        authorNamespaceId: 0,
        receiverAccount: f.bob.account,
        receiverNamespaceId: 0,
        status: 'ACCEPTED',
        authorProfileNamespaceId: 0,
        authorProfileRev: 0,
        snapshot: { displayName: f.bob.account, avatar: null },
        note: 'original',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    await database.db
      .update(tables.relationshipIntent)
      .set({ requestId: request.id })
      .where(
        and(
          eq(tables.relationshipIntent.authorAccount, f.alice.account),
          eq(tables.relationshipIntent.receiverAccount, f.bob.account),
        ),
      );
    expect(
      await service.endEstablishedRelationship({
        userId: f.bob.id,
        threadId: f.threadId,
      }),
    ).toEqual({ status: 'APPLIED' });
    expect(
      await database.db.query.relationshipPair.findFirst({
        where: eq(tables.relationshipPair.threadId, f.threadId),
      }),
    ).toMatchObject({ active: false });
    expect(
      await database.db.query.relationshipRequest.findFirst({
        where: eq(tables.relationshipRequest.id, request.id),
      }),
    ).toEqual(request);
    expect(
      await service.endEstablishedRelationship({
        userId: f.alice.id,
        threadId: f.threadId,
      }),
    ).toMatchObject({ status: 'REJECTED' });
  });

  it.each([false, true])(
    'does not redirect a captured revocation to a replacement relationship (active=%s)',
    async (reactivate) => {
      const f = await pair();
      await activate(f);
      let resume!: () => void;
      let captured!: () => void;
      const paused = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const release = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const localDomain = namespaces.localDomainInTx.bind(namespaces);
      vi.spyOn(namespaces, 'localDomainInTx').mockImplementationOnce(
        async (tx) => {
          captured();
          await release;
          return localDomain(tx);
        },
      );
      // The thread locator has read active+epoch before localDomainInTx begins.
      const oldRevocation = service.endEstablishedRelationship({
        userId: f.alice.id,
        threadId: f.threadId,
      });
      try {
        await paused;
        expect(
          await service.endEstablishedRelationship({
            userId: f.bob.id,
            threadId: f.threadId,
          }),
        ).toEqual({ status: 'APPLIED' });
        await service.execute({
          userId: f.alice.id,
          target: { account: f.bob.account, namespaceId: 0 },
          decision: 'REQUESTED',
          snapshot: { displayName: f.bob.account, avatar: null },
        });
        if (reactivate) await activate(f);
      } finally {
        resume();
      }
      expect(await oldRevocation).toMatchObject({ status: 'REJECTED' });
      expect(
        await database.db.query.relationshipIntent.findFirst({
          where: and(
            eq(tables.relationshipIntent.authorAccount, f.alice.account),
            eq(tables.relationshipIntent.receiverAccount, f.bob.account),
          ),
        }),
      ).toMatchObject({ status: reactivate ? 'ACCEPTED' : 'REQUESTED' });
      expect(
        await database.db.query.relationshipPair.findFirst({
          where: eq(tables.relationshipPair.threadId, f.threadId),
        }),
      ).toMatchObject({ active: reactivate });
    },
  );
});
