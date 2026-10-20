import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, or } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  identityNamespace,
  message,
  peerStateFeed,
  profileTable,
  relationshipRequest,
  relationshipIntent,
} from '../src/database/schema.js';
import { UserIntentService } from '../src/user/p2p-intent/authored/user-intent.service.js';
import {
  ReceivedUserIntentService,
  type ReceivedUserIntentCommand,
} from '../src/user/p2p-intent/received/received-user-intent.service.js';
import { findP2PRelationship, seedFederatedPeerNamespace } from './seed.js';

describe('received P2P intent convergence', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let authored: UserIntentService;
  let received: ReceivedUserIntentService;

  beforeAll(async () => {
    // Do not start network workers: these tests exercise committed facts and
    // publications, independently of best-effort post-commit transport hints.
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = mod.get(DatabaseService);
    authored = mod.get(UserIntentService);
    received = mod.get(ReceivedUserIntentService);
  });

  afterAll(async () => mod?.close());

  async function pending(suffix: string) {
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      `${suffix}.test`,
    );
    const [local] = await database.db
      .insert(account)
      .values({
        account: `converge-${suffix}`,
        defaultProfileRev: 1,
        updatedAt: new Date(),
      })
      .returning();
    await database.db.insert(profileTable).values({
      account: local.account,
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 1,
      displayName: 'Local author',
    });
    const peer = { account: 'remote', domain: `${suffix}.test`, namespaceId };
    await database.db.transaction((tx) =>
      authored.executeInTx(
        tx,
        {
          userId: local.id,
          target: peer,
          decision: 'REQUESTED',
          note: 'original request',
          snapshot: { displayName: 'Remote recipient', avatar: null },
        },
        [],
      ),
    );
    const readFeed = () =>
      database.db.query.peerStateFeed.findFirst({
        where: and(
          eq(peerStateFeed.namespaceId, namespaceId),
          eq(peerStateFeed.account, local.account),
          eq(peerStateFeed.eventType, 'RELATIONSHIP_INTENT'),
          eq(peerStateFeed.subjectAccount, peer.account),
          eq(peerStateFeed.subjectNamespaceId, namespaceId),
        ),
      });
    const readIntents = () =>
      database.db.query.relationshipIntent.findMany({
        where: or(
          and(
            eq(relationshipIntent.authorAccount, local.account),
            eq(relationshipIntent.authorNamespaceId, 0),
            eq(relationshipIntent.receiverAccount, peer.account),
            eq(relationshipIntent.receiverNamespaceId, namespaceId),
          ),
          and(
            eq(relationshipIntent.authorAccount, peer.account),
            eq(relationshipIntent.authorNamespaceId, namespaceId),
            eq(relationshipIntent.receiverAccount, local.account),
            eq(relationshipIntent.receiverNamespaceId, 0),
          ),
        ),
        orderBy: relationshipIntent.authorAccount,
      });
    const readHead = () =>
      database.db.query.identityNamespace.findFirst({
        where: eq(identityNamespace.id, namespaceId),
        columns: { stateFeedEndId: true },
      });
    const command: ReceivedUserIntentCommand = {
      localUserId: local.id,
      peer,
      body: {
        status: 'REVOKED',
        profileNamespaceId: 0,
        profileRev: 0,
        note: '',
        requestedAt: null,
        expiresAt: null,
      },
    };
    return { local, peer, readFeed, readHead, readIntents, command };
  }

  it('atomically publishes its own new revoke on rejection, without departure effects or terminal echoes', async () => {
    const { local, peer, readFeed, readHead, readIntents, command } =
      await pending('rejection');
    const initialIntents = await readIntents();
    const initialHead = await readHead();
    const before = await readFeed();
    expect(before?.body).toMatchObject({ status: 'REQUESTED', profileRev: 1 });
    const initial = await findP2PRelationship(database.db, local.id, peer);
    expect(initial.pair?.active).toBe(false);
    const round = await database.db.query.relationshipRequest.findFirst({
      where: eq(relationshipRequest.authorAccount, local.account),
    });
    expect(round?.status).toBe('REQUESTED');

    const rollback = new Error('force rollback after applying the rejection');
    await expect(
      database.db.transaction(async (tx) => {
        const peers = new Set<number>();
        await received.applyInTx(tx, command, [], peers);
        expect(peers).toEqual(new Set([peer.namespaceId]));
        const row = await tx.query.peerStateFeed.findFirst({
          where: eq(peerStateFeed.account, local.account),
        });
        expect(row?.body).toMatchObject({ status: 'REVOKED', profileRev: 1 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await readFeed()).toEqual(before);
    expect(await readHead()).toEqual(initialHead);
    expect(await readIntents()).toEqual(initialIntents);
    expect(await findP2PRelationship(database.db, local.id, peer)).toEqual(
      initial,
    );
    expect(
      await database.db.query.relationshipRequest.findFirst({
        where: eq(relationshipRequest.id, round!.id),
      }),
    ).toEqual(round);

    await database.db.transaction((tx) =>
      received.applyInTx(tx, command, [], new Set()),
    );
    const terminal = await readFeed();
    expect(terminal?.body).toMatchObject({
      status: 'REVOKED',
      profileRev: 1,
      namespaceId: 0,
      expiresAt: null,
    });
    expect(terminal!.feedId).toBeGreaterThan(before!.feedId);
    const settled = await findP2PRelationship(database.db, local.id, peer);
    expect(settled.pair?.active).toBe(false);
    const terminalIntents = await readIntents();
    expect(terminalIntents).toHaveLength(2);
    expect(terminalIntents.every((intent) => intent.status === 'REVOKED')).toBe(
      true,
    );
    expect(
      await database.db.query.relationshipRequest.findFirst({
        where: eq(relationshipRequest.id, round!.id),
      }),
    ).toMatchObject({ status: 'REJECTED' });
    expect(
      await database.db.query.message.findMany({
        where: eq(message.threadId, initial.pair!.threadId!),
      }),
    ).toEqual([]);

    const head = await readHead();
    const peers = new Set<number>();
    await database.db.transaction((tx) =>
      received.applyInTx(tx, command, [], peers),
    );
    expect(peers.size).toBe(0);
    expect(await readFeed()).toEqual(terminal);
    expect(await readHead()).toEqual(head);
  });

  it('does not reindex an existing revoke when a late ACK arrives after withdrawal', async () => {
    const { local, peer, readFeed, readHead, readIntents, command } =
      await pending('late-ack');
    await database.db.transaction((tx) =>
      authored.executeInTx(
        tx,
        {
          userId: local.id,
          target: peer,
          decision: 'REVOKED',
        },
        [],
      ),
    );
    const terminal = await readFeed();
    expect(terminal?.body).toMatchObject({ status: 'REVOKED' });
    const head = await readHead();
    const state = await findP2PRelationship(database.db, local.id, peer);
    const intents = await readIntents();
    const peers = new Set<number>();
    const result = await database.db.transaction((tx) =>
      received.applyInTx(
        tx,
        {
          ...command,
          body: {
            ...command.body,
            status: 'ACCEPTED',
            requestedAt: Date.now() - 1000,
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
          },
        },
        [],
        peers,
      ),
    );
    expect(result.routed).toBe('noop:dropped-ack');
    expect(peers.size).toBe(0);
    expect(await readFeed()).toEqual(terminal);
    expect(await readHead()).toEqual(head);
    expect(await findP2PRelationship(database.db, local.id, peer)).toEqual(
      state,
    );
    expect(await readIntents()).toEqual(intents);
  });
});
