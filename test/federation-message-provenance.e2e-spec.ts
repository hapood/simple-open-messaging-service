import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  message,
  messageThread,
  relationshipPair,
} from '../src/database/schema.js';
import { FederationMessageProvenanceService } from '../src/federation/federation-message-provenance.service.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { withMessageDigest } from './support/message-fixture.js';

describe('historical P2P message provenance', () => {
  let database: DatabaseService;
  let service: FederationMessageProvenanceService;
  let threadId: number;
  let accountId: number;
  let digest: string;
  const suffix = Date.now().toString(36);
  const localAccount = `provenance-local-${suffix}`;
  const peerAccount = `provenance-peer-${suffix}`;

  beforeAll(async () => {
    database = new DatabaseService();
    service = new FederationMessageProvenanceService(database);
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      `provenance-${suffix}.test`,
    );
    const [owner] = await database.db
      .insert(account)
      .values({ account: localAccount })
      .returning({ id: account.id });
    accountId = owner.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 1, updatedAt: new Date() })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db.insert(relationshipPair).values({
      threadId,
      kind: 'P2P',
      active: false,
      endpointAType: 'USER',
      endpointAAccount: localAccount,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: peerAccount,
      endpointBNamespaceId: namespaceId,
    });
    const [retained] = await database.db
      .insert(message)
      .values(
        withMessageDigest({
          threadId,
          seq: 1,
          creatorAccount: localAccount,
          updatedAt: new Date(),
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'retained historical payload' }),
        }),
      )
      .returning({ digest: message.payloadDigest });
    digest = retained.digest!;
  });

  afterAll(async () => {
    await database.db.delete(message).where(eq(message.threadId, threadId));
    await database.db
      .delete(relationshipPair)
      .where(eq(relationshipPair.threadId, threadId));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(account).where(eq(account.id, accountId));
    await database.pool.end();
  });

  it('confirms the exact retained payload after the P2P relationship closes', async () => {
    expect(
      await service.query([
        {
          thread: { account: localAccount, peerAccount },
          seq: 1,
          payloadDigest: digest,
        },
      ]),
    ).toEqual([
      { thread: { account: localAccount, peerAccount }, seq: 1, known: 'yes' },
    ]);
    const pair = await database.db.query.relationshipPair.findFirst({
      where: eq(relationshipPair.threadId, threadId),
    });
    expect(pair?.active).toBe(false);
  });

  it('still rejects a wrong digest, sequence, or account pair', async () => {
    const queries = [
      {
        thread: { account: localAccount, peerAccount },
        seq: 1,
        payloadDigest: '0'.repeat(64),
      },
      {
        thread: { account: localAccount, peerAccount },
        seq: 2,
        payloadDigest: digest,
      },
      {
        thread: { account: localAccount, peerAccount: `other-${suffix}` },
        seq: 1,
        payloadDigest: digest,
      },
    ];
    expect(await service.query(queries)).toEqual(
      queries.map(({ thread, seq }) => ({ thread, seq, known: 'no' })),
    );
  });
});
