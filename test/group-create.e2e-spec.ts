import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq, or } from 'drizzle-orm';
import type { PersonalRequestPage } from '../shared/relationship-request.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  accountThreadState,
  clientStateFeed,
  groupMeta,
  messageThread,
  relationshipIntent,
  relationshipPair,
  relationshipRequest,
} from '../src/database/schema.js';
import { readCurrentGroupMemberInTx } from '../src/group/meta/current-group-roster.js';
import { seedUserWithSession } from './seed.js';
import { createTestApp } from './support/app';

describe('group creation authorization', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });

  afterAll(async () => app.close());

  it('lets the owner send immediately after creating a group', async () => {
    const owner = await seedUserWithSession(app, 'group-owner');
    const authorization = `Bearer ${owner.token}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', authorization)
      .send({ name: 'New group' });
    expect(created.body.code, JSON.stringify(created.body)).toBe(
      BusinessCode.OK,
    );

    const sent = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', authorization)
      .send({
        threadId: created.body.data.threadId,
        contentType: 'PURE_TEXT',
        content: '{"text":"owner message"}',
      });
    expect(sent.body.code, JSON.stringify(sent.body)).toBe(BusinessCode.OK);
  });

  it.each([false, true])(
    'initializes the owner without request history or attention (existing unread=%s)',
    async (existingUnread) => {
      const owner = await seedUserWithSession(app, `founder-${existingUnread}`);
      const peer = await seedUserWithSession(
        app,
        `founder-peer-${existingUnread}`,
      );
      const post = (actor: typeof owner, route: string, body: object) =>
        request(app.getHttpServer())
          .post(`/api/v1/${route}`)
          .set('Authorization', `Bearer ${actor.token}`)
          .send(body);
      const personalPage = async (
        bucket: 'RECEIVED' | 'SENT',
      ): Promise<PersonalRequestPage> => {
        const response = await post(owner, 'relationship/requests', {
          bucket,
          take: 50,
        });
        expect(response.body.code, JSON.stringify(response.body)).toBe(
          BusinessCode.OK,
        );
        return response.body.data;
      };
      const heads = async () =>
        database.db.query.account.findFirst({
          where: eq(account.id, owner.id),
          columns: {
            requestEndId: true,
            requestReadId: true,
            clientStateFeedEndId: true,
          },
        });
      if (existingUnread) {
        const response = await post(peer, 'relationship/request', {
          account: owner.account,
          namespaceId: 0,
          snapshot: { displayName: 'Founder', avatar: null },
        });
        expect(response.body.code, JSON.stringify(response.body)).toBe(
          BusinessCode.OK,
        );
        await vi.waitFor(
          async () => {
            expect((await personalPage('RECEIVED')).items).toHaveLength(1);
          },
          { timeout: 10_000 },
        );
      }
      const beforeHeads = await heads();
      if (existingUnread) {
        expect(beforeHeads!.requestEndId).toBeGreaterThan(
          beforeHeads!.requestReadId,
        );
      }
      const beforeReceived = await personalPage('RECEIVED');
      const beforeSent = await personalPage('SENT');
      const beforeFeed = await database.db.query.clientStateFeed.findMany({
        where: eq(clientStateFeed.userId, owner.id),
        orderBy: clientStateFeed.feedId,
      });
      const created = await post(owner, 'group/create', {
        name: 'Founding without invitation',
      });
      expect(created.body.code, JSON.stringify(created.body)).toBe(
        BusinessCode.OK,
      );
      const threadId = created.body.data.threadId as number;
      const thread = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
      });
      expect(thread?.groupAccount).toBeTruthy();
      const groupAccount = thread!.groupAccount!;

      expect(await heads()).toEqual(beforeHeads);
      expect(await personalPage('RECEIVED')).toEqual(beforeReceived);
      expect(await personalPage('SENT')).toEqual(beforeSent);
      expect(
        await database.db.query.clientStateFeed.findMany({
          where: eq(clientStateFeed.userId, owner.id),
          orderBy: clientStateFeed.feedId,
        }),
      ).toEqual(beforeFeed);
      expect(
        await database.db.query.relationshipRequest.findMany({
          where: or(
            eq(relationshipRequest.authorAccount, groupAccount),
            eq(relationshipRequest.receiverAccount, groupAccount),
          ),
        }),
      ).toEqual([]);
      for (const route of ['group/invitations', 'group/join-requests']) {
        const response = await post(owner, route, {
          groupId: threadId,
          take: 50,
        });
        expect(response.body.code, JSON.stringify(response.body)).toBe(
          BusinessCode.OK,
        );
        expect(response.body.data.items).toEqual([]);
      }
      expect(
        await database.db.query.groupMeta.findFirst({
          where: eq(groupMeta.threadId, threadId),
        }),
      ).toMatchObject({ applicationEndId: 0, invitationEndId: 0 });
      const intents = await database.db.query.relationshipIntent.findMany({
        where: or(
          eq(relationshipIntent.authorAccount, groupAccount),
          eq(relationshipIntent.receiverAccount, groupAccount),
        ),
      });
      expect(intents).toHaveLength(2);
      expect(intents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authorAccount: groupAccount,
            status: 'ACCEPTED',
            requestId: null,
          }),
          expect.objectContaining({
            authorAccount: owner.account,
            status: 'ACCEPTED',
            requestId: null,
          }),
        ]),
      );
      expect(
        await database.db.transaction((tx) =>
          readCurrentGroupMemberInTx(tx, threadId, owner.id),
        ),
      ).toMatchObject({ account: owner.account, role: 'OWNER' });
      const state = await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, threadId),
        ),
      });
      expect(state).toMatchObject({
        role: 'OWNER',
        lastReadSeq: 1,
        groupInviteEndFeedId: 0,
        joinRequestEndFeedId: 0,
      });
      expect(state!.threadFeedId).toBeGreaterThan(0);
      expect(state!.threadProfileRev).toBeGreaterThan(0);

      // Establish friendship through the normal API before inviting another user.
      if (!existingUnread) {
        const response = await post(peer, 'relationship/request', {
          account: owner.account,
          namespaceId: 0,
          snapshot: { displayName: 'Founder', avatar: null },
        });
        expect(response.body.code, JSON.stringify(response.body)).toBe(
          BusinessCode.OK,
        );
      }
      const friendRequest = await vi.waitFor(
        async () => {
          const items = (await personalPage('RECEIVED')).items;
          expect(items).toHaveLength(1);
          return items[0];
        },
        { timeout: 10_000 },
      );
      const accepted = await post(owner, 'relationship/accept', {
        requestId: friendRequest.id,
      });
      expect(accepted.body.code, JSON.stringify(accepted.body)).toBe(
        BusinessCode.OK,
      );
      const peerBefore = await database.db.query.account.findFirst({
        where: eq(account.id, peer.id),
      });
      const invitation = await post(owner, 'group/invite', {
        groupId: threadId,
        users: [
          {
            account: peer.account,
            namespaceId: 0,
            snapshot: { displayName: 'Peer', avatar: null },
          },
        ],
      });
      expect(invitation.body.code, JSON.stringify(invitation.body)).toBe(
        BusinessCode.OK,
      );
      await vi.waitFor(
        async () => {
          const rows = await database.db.query.relationshipRequest.findMany({
            where: eq(relationshipRequest.authorAccount, groupAccount),
          });
          expect(rows).toEqual([
            expect.objectContaining({
              kind: 'GROUP_INVITATION',
              receiverAccount: peer.account,
              status: 'REQUESTED',
            }),
          ]);
          const peerAfter = await database.db.query.account.findFirst({
            where: eq(account.id, peer.id),
          });
          expect(peerAfter!.requestEndId).toBe(rows[0].id);
          expect(peerAfter!.requestEndId).toBeGreaterThan(
            peerBefore!.requestEndId,
          );
          expect(peerAfter!.requestReadId).toBe(peerBefore!.requestReadId);
          expect(
            await database.db.query.groupMeta.findFirst({
              where: eq(groupMeta.threadId, threadId),
            }),
          ).toMatchObject({ invitationEndId: 1 });
        },
        { timeout: 10_000 },
      );
    },
  );

  it('uses the active group relationship as send authority', async () => {
    const owner = await seedUserWithSession(app, 'group-pair-authority');
    const authorization = `Bearer ${owner.token}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', authorization)
      .send({ name: 'Projection lag group' });
    expect(created.body.code, JSON.stringify(created.body)).toBe(
      BusinessCode.OK,
    );
    const threadId = created.body.data.threadId as number;

    const whileActive = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', authorization)
      .send({
        threadId,
        contentType: 'PURE_TEXT',
        content: '{"text":"pair remains authoritative"}',
      });
    expect(whileActive.body.code, JSON.stringify(whileActive.body)).toBe(
      BusinessCode.OK,
    );

    await database.db
      .update(relationshipPair)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(relationshipPair.threadId, threadId));
    const whileInactive = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', authorization)
      .send({
        threadId,
        contentType: 'PURE_TEXT',
        content: '{"text":"must be rejected"}',
      });
    expect(whileInactive.body.code).toBe(BusinessCode.GROUP_FORBIDDEN);
  });
});
