import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, gte, lt, lte, or, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  account,
  clientStateFeed,
  relationshipIntent,
  relationshipRequest,
} from '../../database/schema.js';
import { ClientStateFeedService } from '../../client-state-feed/client-state-feed.service.js';
import type {
  AuthorizedRequestPageScope,
  ConcludeRequestCommand,
  ConcludeRequestResult,
  MarkIncomingRequestsReadResult,
  OpenRequestCommand,
  OpenRequestResult,
  RequestPageWindow,
  StoredIncomingRequestHead,
  StoredRequestRound,
} from './request-transaction.contract.js';
import { RequestTransactionCapability } from './request-transaction.contract.js';
import type {
  RequestPage,
  RequestRecord,
} from '../../../shared/relationship-request.js';
import type { RequestProjectionStatusValue } from '../../../shared/request-projection-status.js';

export const REQUEST_ONLINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class RequestTransactionCapabilityImpl extends RequestTransactionCapability {
  constructor(private readonly clientStateFeedService: ClientStateFeedService) {
    super();
  }

  requestStatusAt(
    round: Pick<StoredRequestRound, 'status' | 'expiresAt'>,
    asOf: Date,
  ): RequestProjectionStatusValue {
    if (
      round.status === 'REQUESTED' &&
      asOf.getTime() >= round.expiresAt.getTime()
    ) {
      return 'EXPIRED';
    }
    return round.status;
  }

  async openRequestInTx(
    tx: DatabaseTransaction,
    command: OpenRequestCommand,
  ): Promise<OpenRequestResult> {
    const { flow, evidence } = command;

    // Read the current live intent under existing business locks
    const [intent] = await tx
      .select({
        requestId: relationshipIntent.requestId,
      })
      .from(relationshipIntent)
      .where(
        and(
          eq(relationshipIntent.authorAccount, flow.author.account),
          eq(relationshipIntent.authorNamespaceId, flow.author.namespaceId),
          eq(relationshipIntent.receiverAccount, flow.receiver.account),
          eq(relationshipIntent.receiverNamespaceId, flow.receiver.namespaceId),
        ),
      )
      .for('no key update');

    // If an associated request round already exists and is still open, reuse
    // the existing round: a same-round authoring retry must not refresh its
    // evidence or notification heads. A round associated with a re-opened
    // intent after a terminal conclusion stays history: a fresh round is
    // allocated and the intent is re-pointed to it. Liveness is judged against
    // the decision instant: a replayed peer delivery reuses its round, while
    // a retry after expiry allocates a new one.
    const decisionTime = new Date();
    if (intent?.requestId) {
      const [existingRound] = await tx
        .select()
        .from(relationshipRequest)
        .where(eq(relationshipRequest.id, intent.requestId));

      if (
        existingRound?.status === 'REQUESTED' &&
        existingRound.expiresAt.getTime() > decisionTime.getTime()
      ) {
        return {
          status: 'UNCHANGED',
          round: {
            id: existingRound.id,
            kind: existingRound.kind as StoredRequestRound['kind'],
            author: {
              account: existingRound.authorAccount,
              namespaceId: existingRound.authorNamespaceId,
            },
            receiver: {
              account: existingRound.receiverAccount,
              namespaceId: existingRound.receiverNamespaceId,
            },
            status: existingRound.status,
            authorProfileNamespaceId: existingRound.authorProfileNamespaceId,
            authorProfileRev: existingRound.authorProfileRev,
            snapshot: existingRound.snapshot,
            note: existingRound.note,
            requestedAt: existingRound.requestedAt,
            expiresAt: existingRound.expiresAt,
            createdAt: existingRound.createdAt,
            updatedAt: existingRound.updatedAt,
          },
          effects: { clientUpdates: [] },
        };
      }
    }

    // The owning intent command admitted a new round. Preserve expired
    // evidence while closing the previously associated round in this transaction.
    if (intent?.requestId) {
      await tx
        .update(relationshipRequest)
        .set({
          status: 'EXPIRED',
          updatedAt: decisionTime,
        })
        .where(
          and(
            eq(relationshipRequest.id, intent.requestId),
            eq(relationshipRequest.status, 'REQUESTED'),
            lte(relationshipRequest.expiresAt, decisionTime),
          ),
        );
    }

    // Allocate a new round in RelationshipRequest
    const [newRound] = await tx
      .insert(relationshipRequest)
      .values({
        kind: flow.kind,
        authorAccount: flow.author.account,
        authorNamespaceId: flow.author.namespaceId,
        receiverAccount: flow.receiver.account,
        receiverNamespaceId: flow.receiver.namespaceId,
        status: 'REQUESTED',
        authorProfileNamespaceId: evidence.authorProfileNamespaceId,
        authorProfileRev: evidence.authorProfileRev,
        snapshot: evidence.snapshot,
        note: (evidence.note ?? '').slice(0, 255),
        requestedAt: evidence.requestedAt,
        expiresAt: evidence.expiresAt,
      })
      .returning();

    if (!newRound) {
      throw new Error('failed to create relationship request round');
    }

    // Associate the new requestId with the RelationshipIntent
    await tx
      .update(relationshipIntent)
      .set({
        requestId: newRound.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(relationshipIntent.authorAccount, flow.author.account),
          eq(relationshipIntent.authorNamespaceId, flow.author.namespaceId),
          eq(relationshipIntent.receiverAccount, flow.receiver.account),
          eq(relationshipIntent.receiverNamespaceId, flow.receiver.namespaceId),
        ),
      );

    const clientUpdates: { userId: number; feedId: number }[] = [];

    // Advance recipient's requestEndId and publish request head if receiver is a local user
    if (
      flow.receiver.namespaceId === 0 &&
      !flow.receiver.account.startsWith('!')
    ) {
      const [localUser] = await tx
        .select({ id: account.id, requestEndId: account.requestEndId })
        .from(account)
        .where(eq(account.account, flow.receiver.account))
        .for('no key update');

      if (localUser) {
        await tx
          .update(account)
          .set({
            requestEndId: newRound.id,
            updatedAt: new Date(),
          })
          .where(eq(account.id, localUser.id));

        const feedId = await this.clientStateFeedService.publishRequestHeadInTx(
          tx,
          localUser.id,
        );
        if (feedId !== null) {
          clientUpdates.push({ userId: localUser.id, feedId });
        }
      }
    }

    return {
      status: 'CREATED',
      round: {
        id: newRound.id,
        kind: newRound.kind as StoredRequestRound['kind'],
        author: {
          account: newRound.authorAccount,
          namespaceId: newRound.authorNamespaceId,
        },
        receiver: {
          account: newRound.receiverAccount,
          namespaceId: newRound.receiverNamespaceId,
        },
        status: newRound.status,
        authorProfileNamespaceId: newRound.authorProfileNamespaceId,
        authorProfileRev: newRound.authorProfileRev,
        snapshot: newRound.snapshot,
        note: newRound.note,
        requestedAt: newRound.requestedAt,
        expiresAt: newRound.expiresAt,
        createdAt: newRound.createdAt,
        updatedAt: newRound.updatedAt,
      },
      effects: { clientUpdates },
    };
  }

  async concludeRequestInTx(
    tx: DatabaseTransaction,
    command: ConcludeRequestCommand,
  ): Promise<ConcludeRequestResult> {
    const { flow, requestId, cause } = command;

    // Check that the request exists, matches the flow, and is still open.
    // The owning intent command has usually already applied its terminal
    // transition in this transaction; the association plus the open round are
    // the decision guards, so the pre-write intent status is not consulted.
    const [round] = await tx
      .select()
      .from(relationshipRequest)
      .where(
        and(
          eq(relationshipRequest.id, requestId),
          eq(relationshipRequest.authorAccount, flow.author.account),
          eq(relationshipRequest.authorNamespaceId, flow.author.namespaceId),
          eq(relationshipRequest.receiverAccount, flow.receiver.account),
          eq(
            relationshipRequest.receiverNamespaceId,
            flow.receiver.namespaceId,
          ),
        ),
      )
      .for('no key update');

    if (!round || round.status !== 'REQUESTED') {
      return { status: 'STALE_REQUEST' };
    }

    // Check associated intent
    const [intent] = await tx
      .select()
      .from(relationshipIntent)
      .where(
        and(
          eq(relationshipIntent.authorAccount, flow.author.account),
          eq(relationshipIntent.authorNamespaceId, flow.author.namespaceId),
          eq(relationshipIntent.receiverAccount, flow.receiver.account),
          eq(relationshipIntent.receiverNamespaceId, flow.receiver.namespaceId),
        ),
      )
      .for('no key update');

    // Only an intent still associated with this requestId admits conclusion.
    // Its status is not consulted: the owning command applies the intent
    // transition in the same transaction, order-insensitively.
    if (!intent || intent.requestId !== requestId) {
      return { status: 'STALE_REQUEST' };
    }

    let targetStatus: RequestProjectionStatusValue;
    switch (cause) {
      case 'ACCEPT':
        targetStatus = 'ACCEPTED';
        break;
      case 'REJECT':
        targetStatus = 'REJECTED';
        break;
      case 'WITHDRAW':
        targetStatus = 'WITHDRAWN';
        break;
      case 'EXPIRE':
        targetStatus = 'EXPIRED';
        break;
    }

    const [updatedRound] = await tx
      .update(relationshipRequest)
      .set({
        status: targetStatus,
        updatedAt: new Date(),
      })
      .where(eq(relationshipRequest.id, requestId))
      .returning();

    if (!updatedRound) {
      return { status: 'STALE_REQUEST' };
    }

    return {
      status: 'CHANGED',
      round: {
        id: updatedRound.id,
        kind: updatedRound.kind as StoredRequestRound['kind'],
        author: {
          account: updatedRound.authorAccount,
          namespaceId: updatedRound.authorNamespaceId,
        },
        receiver: {
          account: updatedRound.receiverAccount,
          namespaceId: updatedRound.receiverNamespaceId,
        },
        status: updatedRound.status,
        authorProfileNamespaceId: updatedRound.authorProfileNamespaceId,
        authorProfileRev: updatedRound.authorProfileRev,
        snapshot: updatedRound.snapshot,
        note: updatedRound.note,
        requestedAt: updatedRound.requestedAt,
        expiresAt: updatedRound.expiresAt,
        createdAt: updatedRound.createdAt,
        updatedAt: updatedRound.updatedAt,
      },
    };
  }

  async queryRequestPage(
    tx: DatabaseTransaction,
    scope: AuthorizedRequestPageScope,
    window: RequestPageWindow,
  ): Promise<RequestPage> {
    const { asOf, before, take } = window;
    const cutoff = new Date(asOf.getTime() - REQUEST_ONLINE_WINDOW_MS);

    const conditions = [gte(relationshipRequest.createdAt, cutoff)];

    if (before !== null) {
      conditions.push(lt(relationshipRequest.id, before));
    }

    if (scope.type === 'PERSONAL') {
      if (scope.bucket === 'RECEIVED') {
        conditions.push(
          eq(relationshipRequest.receiverAccount, scope.account),
          eq(relationshipRequest.receiverNamespaceId, 0),
        );
      } else {
        conditions.push(
          eq(relationshipRequest.authorAccount, scope.account),
          eq(relationshipRequest.authorNamespaceId, 0),
        );
      }
    } else {
      // GROUP scope: APPLICATION (users applying to group) vs INVITATION (group inviting users)
      if (scope.direction === 'APPLICATION') {
        conditions.push(
          eq(relationshipRequest.kind, 'GROUP_APPLICATION'),
          eq(relationshipRequest.receiverAccount, scope.group.account),
          eq(relationshipRequest.receiverNamespaceId, scope.group.namespaceId),
        );
      } else {
        conditions.push(
          eq(relationshipRequest.kind, 'GROUP_INVITATION'),
          eq(relationshipRequest.authorAccount, scope.group.account),
          eq(relationshipRequest.authorNamespaceId, scope.group.namespaceId),
        );
      }
    }

    const limit = Math.max(1, Math.min(take, 50));
    const rows = await tx
      .select()
      .from(relationshipRequest)
      .where(and(...conditions))
      .orderBy(desc(relationshipRequest.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items: RequestRecord[] = pageRows.map((row) => {
      const effectiveStatus = this.requestStatusAt(
        { status: row.status, expiresAt: row.expiresAt },
        asOf,
      );
      const isIncoming =
        scope.type === 'PERSONAL'
          ? scope.bucket === 'RECEIVED'
          : scope.direction === 'APPLICATION';

      const base = {
        id: row.id.toString(),
        kind: row.kind as StoredRequestRound['kind'],
        author: {
          account: row.authorAccount,
          namespaceId: row.authorNamespaceId,
        },
        receiver: {
          account: row.receiverAccount,
          namespaceId: row.receiverNamespaceId,
        },
        status: effectiveStatus,
        note: row.note,
        requestedAt: row.requestedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };

      if (isIncoming) {
        return {
          ...base,
          direction: 'INCOMING' as const,
          authorProfile: {
            account: row.authorAccount,
            namespaceId: row.authorNamespaceId,
            profileNamespaceId: row.authorProfileNamespaceId,
            profileRev: row.authorProfileRev,
          },
        };
      } else {
        return {
          ...base,
          direction: 'OUTGOING' as const,
          snapshot: row.snapshot!,
        };
      }
    });

    const nextCursor =
      pageRows.length > 0 ? pageRows[pageRows.length - 1].id.toString() : null;

    return {
      items,
      hasMore,
      before: hasMore ? nextCursor : null,
    };
  }

  async markIncomingRequestsReadInTx(
    tx: DatabaseTransaction,
    userId: number,
    requestReadId: bigint,
  ): Promise<MarkIncomingRequestsReadResult> {
    if (requestReadId < 0n) {
      throw new Error('invalid requestReadId: negative value');
    }

    const [user] = await tx
      .select({
        requestEndId: account.requestEndId,
        requestReadId: account.requestReadId,
      })
      .from(account)
      .where(eq(account.id, userId))
      .for('no key update');

    if (!user) {
      throw new Error(`account not found for userId: ${userId}`);
    }

    const currentHead: StoredIncomingRequestHead = {
      requestEndId: user.requestEndId,
      requestReadId: user.requestReadId,
    };

    if (requestReadId > user.requestEndId) {
      return {
        status: 'READ_AHEAD',
        head: currentHead,
      };
    }

    // Monotonic advance only: if target <= current read, unchanged
    if (requestReadId <= user.requestReadId) {
      return {
        status: 'UNCHANGED',
        head: currentHead,
        effects: { clientUpdates: [] },
      };
    }

    await tx
      .update(account)
      .set({
        requestReadId,
        updatedAt: new Date(),
      })
      .where(eq(account.id, userId));

    const feedId = await this.clientStateFeedService.publishRequestHeadInTx(
      tx,
      userId,
    );
    const clientUpdates = feedId !== null ? [{ userId, feedId }] : [];

    return {
      status: 'CHANGED',
      head: {
        requestEndId: user.requestEndId,
        requestReadId,
      },
      effects: { clientUpdates },
    };
  }
}
