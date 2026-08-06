import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  discoveryChange,
  discoveryTarget,
  message,
  messageThread,
  threadAudience,
  user,
} from '../src/database/schema.js';
import { DiscoveryChangeService } from '../src/message/discovery-change.service.js';

describe('DiscoveryChangeService', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  const service = new DiscoveryChangeService();

  beforeAll(async () => {
    mod = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await mod.close();
  });

  async function fixture() {
    const [alice] = await database.db
      .insert(user)
      .values({
        account: 'alice',
        name: 'Alice',
        isForeigner: false,
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning({ id: messageThread.id });
    await database.db.insert(threadAudience).values([
      {
        targetDomain: 'local',
        localUserId: alice.id,
        threadId: thread.id,
      },
      {
        targetDomain: 'peer.test',
        localUserId: null,
        threadId: thread.id,
      },
    ]);
    const messages = await database.db
      .insert(message)
      .values(
        [0, 1, 2, 3].map((seq) => ({
          seq,
          contentType: 'PURE_TEXT' as const,
          content: JSON.stringify({ text: `message-${seq}` }),
          threadId: thread.id,
          creator: alice.id,
          updatedAt: new Date(),
        })),
      )
      .returning({ id: message.id, seq: message.seq });
    return { alice, thread, messages };
  }

  it('allocates gapless per-target change ids under concurrent transactions', async () => {
    const { messages } = await fixture();
    await Promise.all(
      messages.slice(0, 2).map(({ id }) =>
        database.db.transaction((tx) => service.recordMessageInTx(tx, id)),
      ),
    );

    const targets = await database.db
      .select()
      .from(discoveryTarget)
      .orderBy(asc(discoveryTarget.targetDomain));
    expect(targets).toHaveLength(2);
    expect(targets.every((target) => target.allocatedThrough === 2n)).toBe(
      true,
    );

    for (const target of targets) {
      const changes = await database.db
        .select({ changeId: discoveryChange.changeId })
        .from(discoveryChange)
        .where(eq(discoveryChange.targetId, target.id))
        .orderBy(asc(discoveryChange.changeId));
      expect(changes.map((change) => change.changeId)).toEqual([1n, 2n]);
    }
  });

  it('rolls back both the target HWM and change row without leaving a gap', async () => {
    const { messages } = await fixture();
    await database.db.transaction((tx) =>
      service.recordMessageInTx(tx, messages[0].id),
    );

    await expect(
      database.db.transaction(async (tx) => {
        await service.recordMessageInTx(tx, messages[1].id);
        throw new Error('abort page');
      }),
    ).rejects.toThrow('abort page');

    await database.db.transaction((tx) =>
      service.recordMessageInTx(tx, messages[2].id),
    );
    const targets = await database.db.select().from(discoveryTarget);
    expect(targets.every((target) => target.allocatedThrough === 2n)).toBe(
      true,
    );

    const changes = await database.db
      .select({ messageId: discoveryChange.messageId })
      .from(discoveryChange);
    expect(changes.some((change) => change.messageId === messages[1].id)).toBe(
      false,
    );
  });

  it('stops changes after revocation and resumes from a reinserted current audience', async () => {
    const { alice, thread, messages } = await fixture();
    await database.db.transaction((tx) =>
      service.recordMessageInTx(tx, messages[0].id),
    );
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.localUserId, alice.id));

    const localTarget = await database.db.query.discoveryTarget.findFirst({
      where: eq(discoveryTarget.localUserId, alice.id),
    });
    expect(localTarget).toBeDefined();
    const revokedChanges = await database.db
      .select()
      .from(discoveryChange)
      .where(eq(discoveryChange.targetId, localTarget!.id));
    expect(revokedChanges).toEqual([]);

    const revokedResult = await database.db.transaction((tx) =>
      service.recordMessageInTx(tx, messages[1].id),
    );
    expect(revokedResult).toEqual([
      {
        targetDomain: 'peer.test',
        localUserId: null,
        allocatedThrough: 2n,
      },
    ]);

    await database.db.insert(threadAudience).values({
      targetDomain: 'local',
      localUserId: alice.id,
      threadId: thread.id,
    });
    const restoredResult = await database.db.transaction((tx) =>
      service.recordMessageInTx(tx, messages[2].id),
    );
    expect(restoredResult).toEqual(
      expect.arrayContaining([
        {
          targetDomain: 'local',
          localUserId: alice.id,
          allocatedThrough: 2n,
        },
        {
          targetDomain: 'peer.test',
          localUserId: null,
          allocatedThrough: 3n,
        },
      ]),
    );
  });

  it('keeps a creator leave boundary consumable but produces no later changes', async () => {
    const { alice, thread, messages } = await fixture();
    const [creatorAudience] = await database.db
      .insert(threadAudience)
      .values({
        targetDomain: 'group-origin.test',
        localUserId: null,
        threadId: thread.id,
        scope: 'CREATOR',
        creatorUserId: alice.id,
      })
      .returning({ id: threadAudience.id });
    await database.db.insert(threadAudience).values({
      targetDomain: 'group-origin.test',
      localUserId: null,
      threadId: thread.id,
      scope: 'THREAD',
    });

    const first = await database.db.transaction((tx) =>
      service.recordMessageInTx(tx, messages[0].id),
    );
    const boundary = first.find(
      (item) => item.targetDomain === 'group-origin.test',
    );
    expect(boundary?.allocatedThrough).toBe(1n);
    await database.db
      .update(threadAudience)
      .set({ deliverThroughChangeId: boundary!.allocatedThrough })
      .where(eq(threadAudience.id, creatorAudience.id));
    await database.db
      .delete(threadAudience)
      .where(
        and(
          eq(threadAudience.targetDomain, 'group-origin.test'),
          eq(threadAudience.scope, 'THREAD'),
        ),
      );

    const second = await database.db.transaction((tx) =>
      service.recordMessageInTx(tx, messages[1].id),
    );
    expect(
      second.some((item) => item.targetDomain === 'group-origin.test'),
    ).toBe(false);

    const creatorTarget = await database.db.query.discoveryTarget.findFirst({
      where: eq(discoveryTarget.targetDomain, 'group-origin.test'),
    });
    expect(creatorTarget?.allocatedThrough).toBe(1n);
    const retained = await database.db
      .select({
        changeId: discoveryChange.changeId,
        audienceId: discoveryChange.audienceId,
      })
      .from(discoveryChange)
      .where(eq(discoveryChange.targetId, creatorTarget!.id));
    expect(retained).toEqual([
      { changeId: 1n, audienceId: creatorAudience.id },
    ]);
  });
});
