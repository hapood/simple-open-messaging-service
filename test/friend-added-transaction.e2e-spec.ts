import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  message,
  messageThread,
  clientStateFeed,
} from '../src/database/schema.js';
import { RelationshipService } from '../src/relationship/relationship.service.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { MessageService } from '../src/message/message.service.js';
import { ThreadPreviewService } from '../src/message/thread-preview.service.js';
import { findP2PRelationship, seedFederatedPeerNamespace } from './seed.js';

describe('FRIEND_ADDED activation transaction', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let relationships: RelationshipService;
  const messages = Object.create(MessageService.prototype) as MessageService;
  let counter = 0;
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    relationships = new RelationshipService(
      database,
      {} as never,
      new ClientStateFeedService(database, {
        onStateFeedUpdated: () => undefined,
      } as never),
      new RelationshipIntentService(),
      {} as never,
      messages,
    );
    Object.assign(relationships, {
      previews: new ThreadPreviewService(database),
    });
  });
  afterAll(async () => mod.close());

  async function pair(federated = false) {
    const suffix = ++counter;
    const namespaceId = federated
      ? await seedFederatedPeerNamespace(database.db, 'notice-peer.test')
      : 0;
    const [local] = await database.db
      .insert(account)
      .values({ account: `notice-local-${suffix}` })
      .returning();
    const peer = federated
      ? {
          account: `notice-peer-${suffix}`,
          domain: 'notice-peer.test',
          namespaceId,
        }
      : (
          await database.db
            .insert(account)
            .values({ account: `notice-peer-${suffix}` })
            .returning()
        )[0];
    return { local, peer };
  }
  async function notices(threadId: number) {
    return database.db
      .select()
      .from(message)
      .where(eq(message.threadId, threadId));
  }

  it('rolls back relationship, message, sequence and feed together; retry and duplicate acceptance write once', async () => {
    const { local, peer } = await pair();
    if (!('id' in peer)) throw new Error('local peer required');
    await database.db.transaction((tx) =>
      relationships.writeLocalP2PIntentInTx(
        tx,
        local.id,
        'id' in peer ? peer.id : peer,
        true,
      ),
    );
    const initial = await findP2PRelationship(
      database.db,
      local.id,
      'id' in peer ? peer.id : peer,
    );
    const threadId = initial.pair!.threadId!;
    const feedsBefore = await database.db.select().from(clientStateFeed);
    await expect(
      database.db.transaction(async (tx) => {
        await relationships.writeLocalP2PIntentInTx(
          tx,
          'id' in peer ? peer.id : peer,
          local.id,
          true,
        );
        expect(
          await tx.select().from(message).where(eq(message.threadId, threadId)),
        ).toHaveLength(1);
        expect(
          (
            await findP2PRelationship(
              tx,
              local.id,
              'id' in peer ? peer.id : peer,
            )
          ).pair?.active,
        ).toBe(true);
        throw new Error('rollback activation');
      }),
    ).rejects.toThrow('rollback activation');
    expect(
      (
        await findP2PRelationship(
          database.db,
          local.id,
          'id' in peer ? peer.id : peer,
        )
      ).pair?.active,
    ).toBe(false);
    expect(await notices(threadId)).toHaveLength(0);
    expect(await database.db.select().from(clientStateFeed)).toEqual(
      feedsBefore,
    );
    expect(
      (
        await database.db
          .select()
          .from(messageThread)
          .where(eq(messageThread.id, threadId))
      )[0].curSeq,
    ).toBe(0);
    await Promise.all(
      [1, 2].map(() =>
        database.db.transaction((tx) =>
          relationships.writeLocalP2PIntentInTx(
            tx,
            ('id' in peer ? peer.id : peer) as number,
            local.id,
            true,
          ),
        ),
      ),
    );
    expect(await notices(threadId)).toHaveLength(1);
    expect(JSON.parse((await notices(threadId))[0].content).type).toBe(
      'FRIEND_ADDED',
    );
  });

  it('rolls back activation when the system message write fails', async () => {
    const { local, peer } = await pair();
    await database.db.transaction((tx) =>
      relationships.writeLocalP2PIntentInTx(
        tx,
        local.id,
        'id' in peer ? peer.id : peer,
        true,
      ),
    );
    const spy = vi
      .spyOn(messages, 'writeSystemMessageInTx')
      .mockRejectedValueOnce(new Error('storage failed'));
    try {
      await expect(
        database.db.transaction((tx) =>
          relationships.writeLocalP2PIntentInTx(
            tx,
            ('id' in peer ? peer.id : peer) as number,
            local.id,
            true,
          ),
        ),
      ).rejects.toThrow('storage failed');
    } finally {
      spy.mockRestore();
    }
    const state = await findP2PRelationship(
      database.db,
      local.id,
      'id' in peer ? peer.id : peer,
    );
    expect(state.pair?.active).toBe(false);
    expect(await notices(state.pair!.threadId!)).toHaveLength(0);
  });

  it.each([false, true])(
    'writes for the first federated activation and not the later confirmation (reverse=%s)',
    async (reverse) => {
      const { local, peer } = await pair(true);
      const remote = (status: 'REQUESTED' | 'ACCEPTED') =>
        database.db.transaction((tx) =>
          relationships.applyRemoteP2PIntentInTx(tx, {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            localUserId: local.id,
            peerUserId: 'id' in peer ? peer.id : peer,
            status,
            profileRev: 0,
            note: '',
            requestedAt: new Date(),
            expiresAt:
              status === 'REQUESTED' ? new Date(Date.now() + 60_000) : null,
            origin: 'notice-peer.test',
          }),
        );
      const request = () =>
        database.db.transaction((tx) =>
          relationships.writeLocalP2PIntentInTx(
            tx,
            local.id,
            'id' in peer ? peer.id : peer,
            true,
          ),
        );
      if (reverse) {
        await remote('REQUESTED');
        await request();
      } else {
        await request();
        await remote('REQUESTED');
      }
      const state = await findP2PRelationship(
        database.db,
        local.id,
        'id' in peer ? peer.id : peer,
      );
      expect(state.pair?.active).toBe(true);
      expect(await notices(state.pair!.threadId!)).toHaveLength(1);
      await remote('ACCEPTED');
      await remote('ACCEPTED');
      await request();
      expect(await notices(state.pair!.threadId!)).toHaveLength(1);
    },
  );
});
