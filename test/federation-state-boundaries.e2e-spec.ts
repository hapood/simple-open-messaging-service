import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, or } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageThreadType } from '../src/database/enums.js';
import {
  relationshipIntent,
  relationshipPair,
  group,
  messageThread,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { InviteService } from '../src/invite/invite.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';

describe('federation directed-state boundaries', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let invites: InviteService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    invites = new InviteService(
      database,
      {} as never,
      new ClientStateFeedService(database, {
        onStateFeedUpdated: () => undefined,
      } as never),
      {} as never,
    );
  });

  afterAll(async () => mod.close());

  async function createPair(suffix: string) {
    const [local, peer] = await database.db
      .insert(user)
      .values([
        {
          account: `boundary-local-${suffix}`,
          name: 'local',
          domain: 'local',
          isForeigner: false,
          updatedAt: new Date(),
        },
        {
          account: `boundary-peer-${suffix}`,
          name: 'peer',
          domain: 'peer.test',
          isForeigner: true,
          updatedAt: new Date(),
        },
      ])
      .returning({ id: user.id });
    return { local, peer };
  }

  it('ignores a peer FRIEND snapshot outside an effective request flow', async () => {
    const { local, peer } = await createPair(Date.now().toString(36));
    await database.db.insert(relationshipIntent).values([
      {
        authorUserId: local.id,
        subjectUserId: peer.id,
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
        updatedAt: new Date(),
      },
      {
        authorUserId: peer.id,
        subjectUserId: local.id,
        status: 'ACCEPTED',
        note: '',
        requestedAt: new Date(),
        expiresAt: null,
        updatedAt: new Date(),
      },
    ]);

    const effect = await database.db.transaction((tx) =>
      invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: local.id,
        peerUserId: peer.id,
        status: 'ACCEPTED',
        note: '',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'peer.test',
      }),
    );

    expect(effect).toMatchObject({
      changed: false,
      requestCreated: false,
      clientFeedUpdates: [],
    });
    expect(effect.requestCreated).toBe(false);
    const directions = await database.db
      .select({
        requesterUserId: relationshipIntent.authorUserId,
        status: relationshipIntent.status,
        expiresAt: relationshipIntent.expiresAt,
      })
      .from(relationshipIntent)
      .where(
        and(
          eq(relationshipIntent.authorUserId, local.id),
          eq(relationshipIntent.subjectUserId, peer.id),
        ),
      );
    expect(directions[0]).toMatchObject({
      requesterUserId: local.id,
      status: 'REVOKED',
      expiresAt: null,
    });
  });

  it('initializes an outbound request with a local reverse REVOKED fact', async () => {
    const { local, peer } = await createPair(`o-${Date.now().toString(36)}`);

    await database.db.transaction((tx) =>
      invites.writeLocalFriendIntentInTx(tx, local.id, peer.id, true, 'hello'),
    );

    const directions = await database.db.query.relationshipIntent.findMany({
      where: or(
        and(
          eq(relationshipIntent.authorUserId, local.id),
          eq(relationshipIntent.subjectUserId, peer.id),
        ),
        and(
          eq(relationshipIntent.authorUserId, peer.id),
          eq(relationshipIntent.subjectUserId, local.id),
        ),
      ),
    });
    expect(directions).toHaveLength(2);
    expect(
      directions.find((direction) => direction.authorUserId === local.id),
    ).toMatchObject({ status: 'REQUESTED' });
    expect(
      directions.find((direction) => direction.authorUserId === peer.id),
    ).toMatchObject({
      status: 'REVOKED',
      requestedAt: null,
      expiresAt: null,
    });
  });

  it('atomically confirms crossed requests after promoting the local direction', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-crossed`,
    );
    const requestedAt = new Date();
    await database.db.insert(relationshipIntent).values({
      authorUserId: local.id,
      subjectUserId: peer.id,
      status: 'REQUESTED',
      note: 'local request',
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
      updatedAt: requestedAt,
    });

    const effect = await database.db.transaction((tx) =>
      invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: local.id,
        peerUserId: peer.id,
        status: 'REQUESTED',
        note: 'peer request',
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
        origin: 'peer.test',
      }),
    );

    expect(effect).toMatchObject({
      added: true,
      requestCreated: false,
      localStateRevision: 1,
      threadId: expect.any(Number),
    });
    const directions = await database.db.query.relationshipIntent.findMany({
      where: or(
        and(
          eq(relationshipIntent.authorUserId, local.id),
          eq(relationshipIntent.subjectUserId, peer.id),
        ),
        and(
          eq(relationshipIntent.authorUserId, peer.id),
          eq(relationshipIntent.subjectUserId, local.id),
        ),
      ),
    });
    expect(
      directions.find((row) => row.authorUserId === local.id),
    ).toMatchObject({ status: 'ACCEPTED', expiresAt: null });
    expect(
      directions.find((row) => row.authorUserId === peer.id),
    ).toMatchObject({ status: 'REQUESTED' });
    expect(
      await database.db.query.relationshipPair.findFirst({
        where: and(
          eq(relationshipPair.userLowId, Math.min(local.id, peer.id)),
          eq(relationshipPair.userHighId, Math.max(local.id, peer.id)),
        ),
      }),
    ).toMatchObject({ active: true, threadId: effect.threadId });
    expect(
      await database.db.query.threadParticipant.findMany({
        where: eq(threadParticipant.threadId, effect.threadId!),
      }),
    ).toHaveLength(2);
  });

  it('confirms ACCEPTED + REQUESTED without waiting for a second acknowledgement', async () => {
    const { local, peer } = await createPair(
      `ar-${Date.now().toString(36).slice(-6)}`,
    );
    const requestedAt = new Date();
    await database.db.insert(relationshipIntent).values({
      authorUserId: local.id,
      subjectUserId: peer.id,
      status: 'ACCEPTED',
      note: '',
      requestedAt,
      expiresAt: null,
      updatedAt: requestedAt,
    });

    const effect = await database.db.transaction((tx) =>
      invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: local.id,
        peerUserId: peer.id,
        status: 'REQUESTED',
        note: 'peer request',
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
        origin: 'peer.test',
      }),
    );

    expect(effect).toMatchObject({
      added: true,
      requestCreated: false,
      localStateRevision: 1,
      threadId: expect.any(Number),
    });
    expect(
      await database.db.query.relationshipPair.findFirst({
        where: and(
          eq(relationshipPair.userLowId, Math.min(local.id, peer.id)),
          eq(relationshipPair.userHighId, Math.max(local.id, peer.id)),
        ),
      }),
    ).toMatchObject({ active: true });
  });

  it('does not confirm an expired request paired with a fresh request', async () => {
    const { local, peer } = await createPair(
      `ec-${Date.now().toString(36).slice(-6)}`,
    );
    const requestedAt = new Date(Date.now() - 120_000);
    await database.db.insert(relationshipIntent).values({
      authorUserId: local.id,
      subjectUserId: peer.id,
      status: 'REQUESTED',
      note: 'expired',
      requestedAt,
      expiresAt: new Date(Date.now() - 60_000),
      updatedAt: requestedAt,
    });
    const remoteRequestedAt = new Date();

    const effect = await database.db.transaction((tx) =>
      invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: local.id,
        peerUserId: peer.id,
        status: 'REQUESTED',
        note: 'fresh',
        requestedAt: remoteRequestedAt,
        expiresAt: new Date(remoteRequestedAt.getTime() + 24 * 60 * 60 * 1000),
        origin: 'peer.test',
      }),
    );

    expect(effect).toMatchObject({
      requestCreated: true,
    });
    expect(effect.added).toBeUndefined();
    expect(
      await database.db.query.relationshipPair.findFirst({
        where: and(
          eq(relationshipPair.userLowId, Math.min(local.id, peer.id)),
          eq(relationshipPair.userHighId, Math.max(local.id, peer.id)),
        ),
      }),
    ).toMatchObject({ active: false, threadId: null });
  });

  it('rejects an ACCEPTED database fact without a request timestamp', async () => {
    const { local, peer } = await createPair(
      `ia-${Date.now().toString(36).slice(-6)}`,
    );

    await expect(
      database.db.insert(relationshipIntent).values({
        authorUserId: local.id,
        subjectUserId: peer.id,
        status: 'ACCEPTED',
        requestedAt: null,
        expiresAt: null,
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('confirms FRIEND and removes the TTL when the local request is still valid', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-valid`,
    );
    await database.db.insert(relationshipIntent).values({
      authorUserId: local.id,
      subjectUserId: peer.id,
      status: 'REQUESTED',
      note: 'hello',
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });

    const effect = await database.db.transaction((tx) =>
      invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: local.id,
        peerUserId: peer.id,
        status: 'ACCEPTED',
        note: '',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'peer.test',
      }),
    );

    expect(effect.localStateRevision).toBeDefined();
    const localDirection = await database.db.query.relationshipIntent.findFirst(
      {
        where: and(
          eq(relationshipIntent.authorUserId, local.id),
          eq(relationshipIntent.subjectUserId, peer.id),
        ),
      },
    );
    expect(localDirection).toMatchObject({
      status: 'ACCEPTED',
      expiresAt: null,
    });
  });

  it('completes a peer request that the local direction already accepted', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-final`,
    );
    const requestedAt = new Date();
    await database.db.insert(relationshipIntent).values([
      {
        authorUserId: local.id,
        subjectUserId: peer.id,
        status: 'ACCEPTED',
        note: '',
        requestedAt,
        expiresAt: null,
        updatedAt: new Date(),
      },
      {
        authorUserId: peer.id,
        subjectUserId: local.id,
        status: 'REQUESTED',
        note: 'peer request',
        requestedAt,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      },
    ]);

    const effect = await database.db.transaction((tx) =>
      invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: local.id,
        peerUserId: peer.id,
        status: 'ACCEPTED',
        note: '',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'peer.test',
      }),
    );

    expect(effect.changed).toBe(true);
    const peerDirection = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorUserId, peer.id),
        eq(relationshipIntent.subjectUserId, local.id),
      ),
    });
    expect(peerDirection).toMatchObject({
      status: 'ACCEPTED',
      expiresAt: null,
    });
  });

  it('treats expired requests as absent and refreshes them as a new request', async () => {
    const { local, peer } = await createPair(
      `${Date.now().toString(36)}-expired`,
    );
    const expiredAt = new Date(Date.now() - 60_000);
    await database.db.insert(relationshipIntent).values([
      {
        authorUserId: local.id,
        subjectUserId: peer.id,
        status: 'REQUESTED',
        note: 'old local',
        requestedAt: new Date(Date.now() - 120_000),
        expiresAt: expiredAt,
        updatedAt: new Date(),
      },
      {
        authorUserId: peer.id,
        subjectUserId: local.id,
        status: 'REQUESTED',
        note: 'old peer',
        requestedAt: new Date(Date.now() - 120_000),
        expiresAt: expiredAt,
        updatedAt: new Date(),
      },
    ]);

    await database.db.transaction((tx) =>
      invites.writeLocalFriendIntentInTx(
        tx,
        local.id,
        peer.id,
        true,
        'new request',
      ),
    );

    const refreshed = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorUserId, local.id),
        eq(relationshipIntent.subjectUserId, peer.id),
      ),
    });
    expect(refreshed).toMatchObject({
      status: 'REQUESTED',
      note: 'new request',
    });
    expect(refreshed!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('recreates an expired group invitation even when its note is unchanged', async () => {
    const suffix = `${Date.now().toString(36)}-group`;
    const { local: owner, peer: target } = await createPair(suffix);
    const [groupUser] = await database.db
      .insert(user)
      .values({
        account: `!boundary-${suffix}`,
        name: 'boundary group',
        domain: 'local',
        isForeigner: false,
        isGroup: true,
        hashPwd: '',
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupUserId: groupUser.id,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    await database.db.insert(group).values({
      groupUserId: groupUser.id,
      ownerId: owner.id,
      updatedAt: new Date(),
    });

    const firstId = await invites.createGroupInvite(
      owner.id,
      thread.id,
      target.id,
      'same note',
    );
    const requestedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await database.db
      .update(relationshipIntent)
      .set({
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
      .where(eq(relationshipIntent.id, BigInt(firstId)));
    const secondId = await invites.createGroupInvite(
      owner.id,
      thread.id,
      target.id,
      'same note',
    );

    expect(secondId).toBe(firstId);
    const refreshed = await database.db.query.relationshipIntent.findFirst({
      where: eq(relationshipIntent.id, BigInt(firstId)),
    });
    expect(refreshed).toMatchObject({ status: 'REQUESTED' });
    expect(refreshed!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
