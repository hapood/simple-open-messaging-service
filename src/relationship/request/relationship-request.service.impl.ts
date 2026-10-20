import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import {
  account,
  accountThreadState,
  messageThread,
  relationshipIntent,
  relationshipRequest,
} from '../../database/schema.js';
import { RequestTransactionCapability } from './request-transaction.contract.js';
import { RelationshipRequestService } from './relationship-request.service.js';
import { SseService } from '../../gateway/sse.service.js';
import type {
  GroupRequestPage,
  IncomingRequestHead,
  PersonalRequestPage,
  RequestDecision,
} from '../../../shared/relationship-request.js';

@Injectable()
export class RelationshipRequestServiceImpl extends RelationshipRequestService {
  constructor(
    private readonly database: DatabaseService,
    private readonly capability: RequestTransactionCapability,
    private readonly sse: SseService,
  ) {
    super();
  }

  async queryPersonal(
    userId: number,
    query: { bucket: 'RECEIVED' | 'SENT'; before?: string; take?: number },
  ): Promise<PersonalRequestPage> {
    const asOf = new Date();
    return this.database.db.transaction(async (tx) => {
      const [user] = await tx
        .select({
          account: account.account,
          requestEndId: account.requestEndId,
          requestReadId: account.requestReadId,
        })
        .from(account)
        .where(eq(account.id, userId));

      if (!user) {
        throw new Error(`account not found for userId ${userId}`);
      }

      const before = query.before ? BigInt(query.before) : null;
      const take = query.take ?? 20;

      const page = await this.capability.queryRequestPage(
        tx,
        {
          type: 'PERSONAL',
          userId,
          account: user.account,
          bucket: query.bucket,
        },
        { before, take, asOf },
      );

      const incomingHead: IncomingRequestHead = {
        requestEndId: user.requestEndId.toString(),
        requestReadId: user.requestReadId.toString(),
      };

      return {
        ...page,
        incomingHead,
      };
    });
  }

  async markRead(
    userId: number,
    requestReadId: string,
  ): Promise<IncomingRequestHead> {
    const targetId = BigInt(requestReadId);
    let effectsToDeliver: { userId: number; feedId: number }[] = [];

    const resultHead = await this.database.db.transaction(async (tx) => {
      const result = await this.capability.markIncomingRequestsReadInTx(
        tx,
        userId,
        targetId,
      );
      if (result.status === 'READ_AHEAD') {
        throw new Error('requestReadId exceeds incoming requestEndId');
      }
      if (result.status === 'CHANGED') {
        effectsToDeliver = [...result.effects.clientUpdates];
      }
      return result.head;
    });

    for (const update of effectsToDeliver) {
      this.sse.onThreadFeedUpdated(update.userId, {
        threadFeedEndId: update.feedId,
      });
    }

    return {
      requestEndId: resultHead.requestEndId.toString(),
      requestReadId: resultHead.requestReadId.toString(),
    };
  }

  /** Resolve a member-side group round: the calling member must be the
   * invitation's receiver. Locates the owning group thread for the intent
   * state machine; admission is revalidated under that machine's locks. */
  async roundKind(
    requestId: string,
  ): Promise<'FRIEND' | 'GROUP_APPLICATION' | 'GROUP_INVITATION' | null> {
    const [round] = await this.database.db
      .select({ kind: relationshipRequest.kind })
      .from(relationshipRequest)
      .where(eq(relationshipRequest.id, BigInt(requestId)));
    return (
      (round?.kind as 'FRIEND' | 'GROUP_APPLICATION' | 'GROUP_INVITATION') ??
      null
    );
  }

  async resolveMemberGroupRound(
    userId: number,
    requestId: string,
    decision: RequestDecision,
  ): Promise<
    { status: 'RESOLVED'; threadId: number } | { status: 'STALE_REQUEST' }
  > {
    const id = BigInt(requestId);
    const [req] = await this.database.db
      .select({
        authorAccount: relationshipIntent.authorAccount,
        authorNamespaceId: relationshipIntent.authorNamespaceId,
        receiverAccount: relationshipIntent.receiverAccount,
        receiverNamespaceId: relationshipIntent.receiverNamespaceId,
      })
      .from(relationshipIntent)
      .where(eq(relationshipIntent.requestId, id));
    if (!req) return { status: 'STALE_REQUEST' };
    const [user] = await this.database.db
      .select({ account: account.account })
      .from(account)
      .where(eq(account.id, userId));
    if (!user) return { status: 'STALE_REQUEST' };
    const isAuthor =
      req.authorAccount === user.account && req.authorNamespaceId === 0;
    const isReceiver =
      req.receiverAccount === user.account && req.receiverNamespaceId === 0;
    // The member accepts or declines an invitation (receiver side) and
    // withdraws their own application (author side).
    const permitted = decision === 'WITHDRAW' ? isAuthor : isReceiver;
    if (!permitted) return { status: 'STALE_REQUEST' };
    const group =
      decision === 'WITHDRAW'
        ? { account: req.receiverAccount, namespaceId: req.receiverNamespaceId }
        : { account: req.authorAccount, namespaceId: req.authorNamespaceId };
    const [thread] = await this.database.db
      .select({ id: messageThread.id })
      .from(messageThread)
      .where(
        and(
          eq(messageThread.groupAccount, group.account),
          eq(messageThread.authorityNamespaceId, group.namespaceId),
        ),
      );
    if (!thread) return { status: 'STALE_REQUEST' };
    return { status: 'RESOLVED', threadId: thread.id };
  }

  async queryGroup(
    userId: number,
    groupId: number,
    direction: 'APPLICATION' | 'INVITATION',
    query: { before?: string; take?: number },
  ): Promise<GroupRequestPage> {
    const asOf = new Date();
    return this.database.db.transaction(async (tx) => {
      const [thread] = await tx
        .select({
          groupAccount: messageThread.groupAccount,
          authorityNamespaceId: messageThread.authorityNamespaceId,
        })
        .from(messageThread)
        .where(eq(messageThread.id, groupId));

      if (!thread?.groupAccount) {
        throw new Error(`group thread ${groupId} not found`);
      }

      const [threadState] = await tx
        .select({
          joinRequestEndFeedId: accountThreadState.joinRequestEndFeedId,
          joinRequestReadFeedId: accountThreadState.joinRequestReadFeedId,
        })
        .from(accountThreadState)
        .where(
          and(
            eq(accountThreadState.accountId, userId),
            eq(accountThreadState.threadId, groupId),
          ),
        );

      const before = query.before ? BigInt(query.before) : null;
      const take = query.take ?? 20;

      const page = await this.capability.queryRequestPage(
        tx,
        {
          type: 'GROUP',
          actorUserId: userId,
          groupId,
          group: {
            account: thread.groupAccount,
            namespaceId: thread.authorityNamespaceId,
          },
          direction,
        },
        { before, take, asOf },
      );

      return {
        ...page,
        joinRequestEndFeedId: threadState?.joinRequestEndFeedId ?? 0,
        joinRequestReadFeedId: threadState?.joinRequestReadFeedId ?? 0,
      };
    });
  }

  /** Resolve a manager-side group round: the round's group endpoint must
   * match the addressed thread's group identity for the requested direction.
   * Locating only — role authorization belongs to the route guards and the
   * decision admission is revalidated under the membership state machine's
   * locks via the requestDecision gate. */
  async resolveManagerGroupRound(
    userId: number,
    groupId: number,
    requestId: string,
    direction: 'APPLICATION' | 'INVITATION',
  ): Promise<
    | {
        status: 'RESOLVED';
        member: { account: string; namespaceId: number };
      }
    | { status: 'STALE_REQUEST' }
  > {
    void userId; // role authorization stays with the route guards
    const id = BigInt(requestId);
    const [thread] = await this.database.db
      .select({
        groupAccount: messageThread.groupAccount,
        authorityNamespaceId: messageThread.authorityNamespaceId,
      })
      .from(messageThread)
      .where(eq(messageThread.id, groupId));
    if (!thread?.groupAccount) return { status: 'STALE_REQUEST' };
    const [round] = await this.database.db
      .select()
      .from(relationshipRequest)
      .where(eq(relationshipRequest.id, id));
    if (!round) return { status: 'STALE_REQUEST' };
    const isApplication = direction === 'APPLICATION';
    const groupEndpointMatches = isApplication
      ? round.receiverAccount === thread.groupAccount &&
        round.receiverNamespaceId === thread.authorityNamespaceId
      : round.authorAccount === thread.groupAccount &&
        round.authorNamespaceId === thread.authorityNamespaceId;
    if (
      !groupEndpointMatches ||
      round.kind !== (isApplication ? 'GROUP_APPLICATION' : 'GROUP_INVITATION')
    )
      return { status: 'STALE_REQUEST' };
    const member = isApplication
      ? { account: round.authorAccount, namespaceId: round.authorNamespaceId }
      : {
          account: round.receiverAccount,
          namespaceId: round.receiverNamespaceId,
        };
    return { status: 'RESOLVED', member };
  }
}
