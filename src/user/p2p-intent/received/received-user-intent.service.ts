import { sql } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../database/database.service.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import type { FederationService } from '../../../federation/federation.service.js';
import type { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import { openFederatedAudienceInTx } from '../../../federation/federation-audience.js';
import { initializeRelationshipThreadStateInTx } from '../../../federation/federation-relationship-thread-state.js';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import { normalizeAccount } from '../../../common/account.js';
import { lockBusinessAccountsInTx } from '../../../common/locks/account-business-lock.js';
import { completeBusinessAddress } from '../../../common/locks/business-address.js';
import { lockRelationshipPairsInTx } from '../../../common/locks/relationship-pair-business-lock.js';
import {
  requireP2PThreadContentLockUnderPairInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import {
  userIntentAuthorizationSql,
  userIntentLocatorSql,
  type UserIntentAuthorizationRow,
} from '../authored/user-intent-authorization-sql.js';
import { userIntentAcceptanceSql } from '../authored/user-intent-acceptance-sql.js';
import { userIntentRequestSql } from '../authored/user-intent-request-sql.js';
import { userIntentRevocationSql } from '../authored/user-intent-revocation-sql.js';
import { receivedUserIntentWriteSql } from './received-user-intent-write-sql.js';
import type { UserIntentService } from '../authored/user-intent.service.js';
import { isBusinessRejection } from '../../../common/business-command-result.js';
import {
  InvalidReceivedIntentError,
  validateReceivedIntentBody,
} from '../../../group/membership-intent/received/received-membership-body.js';
import { epochMillisSql } from '../../../group/membership-intent/received/mirror-membership-shared-sql.js';
import {
  ensureThreadShellInTx,
  lockOrMintUserPairInTx,
  lockUserIntentAccountsInTx,
  lockUserIntentThreadStateInTx,
  ownRequestUnexpired,
  requireExistingThreadId,
  resetUserIntentThreadStateInTx,
  userIntentCompactionKey,
  type UserIntentEndpoint,
} from '../shared/user-intent-state-sql.js';

/** A peer-authored P2P intent body as it arrives on the state feed (times are
 * epoch milliseconds). REVOKED carries no thread heads. */
interface ReceivedUserIntentBody {
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
  profileNamespaceId: number;
  profileRev: number;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  messageEndSeq?: number;
  tombstoneEndSeq?: number;
}

/** One command: apply a received peer-authored P2P intent to the local user's
 * pair inside the State Feed consumer transaction. */
export interface ReceivedUserIntentCommand {
  localUserId: number;
  peer: { account: string; domain: string; namespaceId: number };
  body: ReceivedUserIntentBody;
}

export interface ReceivedUserIntentDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  peerFeed: PeerStateFeedService;
  federation: Pick<FederationService, 'pushStateFeedNamespaces'>;
  userIntents: UserIntentService;
}

/** Routing outcomes, for tests and diagnostics. `noop:*` rows never wrote. */
export type ReceivedUserIntentRouting =
  | 'recorded-request'
  | 'refreshed-request'
  | 'activated'
  | 'completion'
  | 'kick'
  | 'conclusion'
  | 'rejection'
  | `noop:${string}`;

export interface ReceivedUserIntentResult {
  routed: ReceivedUserIntentRouting;
  /** Present only when the command activated the pair — the consumer's
   * thread-round wake hint. Departures wake through the reverse task. */
  threadId?: number;
}

/** The body after wireIntent validation: an expired REQUESTED resolves to `undefined`
 * (an ineffective input, not a transition — the pull cursor still advances). */
interface ValidatedReceivedIntentBase {
  requestedAt: Date | null;
  expiresAt: Date | null;
}

type ValidatedReceivedIntent =
  | ({ status: 'REQUESTED' } & ValidatedReceivedIntentBase & {
        requestedAt: Date;
        expiresAt: Date;
      })
  | ({ status: 'ACCEPTED' } & ValidatedReceivedIntentBase)
  | ({ status: 'REVOKED' } & ValidatedReceivedIntentBase);

type Endpoint = UserIntentEndpoint;

/** The receiving-side counterpart of the user intent family: the peer's
 * authored direction arrives as a RELATIONSHIP_INTENT state-feed item and is
 * applied with the same composed statements — the wireIntent snapshot substituted
 * for the authored write (the `authoredSql` seam), and no local-actor
 * authorization, because a live local direction or the cross of two live
 * directions is the authorization. */
export class ReceivedUserIntentService {
  private readonly logger = new Logger(ReceivedUserIntentService.name);

  constructor(private readonly deps: ReceivedUserIntentDependencies) {}

  async execute(
    command: ReceivedUserIntentCommand,
  ): Promise<{ routed: ReceivedUserIntentRouting }> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = new Set<number>();
    const result = await this.deps.database.db.transaction(async (tx) =>
      this.applyInTx(tx, command, clientUpdates, peers),
    );
    try {
      if (clientUpdates.length > 0)
        this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn('received user intent client wake failed', error);
    }
    if (peers.size > 0)
      void this.deps.federation.pushStateFeedNamespaces(peers);
    return { routed: result.routed };
  }

  /** Transactional entry: the caller owns commit and therefore also owns the
   * post-commit client/peer wakes handed back through the sinks. */
  async applyInTx(
    tx: DatabaseTransaction,
    command: ReceivedUserIntentCommand,
    clientUpdates: PendingClientStateFeedUpdate[],
    peers: Set<number>,
  ): Promise<ReceivedUserIntentResult> {
    // The REQUESTED member's dates are non-null by validation, but the shared
    // validator returns the common shape; the command's status discriminates.
    const validated = validateReceivedIntentBody(command.body);
    if (!validated) return { routed: 'noop:expired-request' };
    const intent = {
      status: command.body.status,
      ...validated,
    } as ValidatedReceivedIntent;
    const peerAccount = normalizeAccount(command.peer.account);
    const peerDomain = command.peer.domain.trim().toLowerCase();
    const namespaceId = command.peer.namespaceId;
    // The local subject is the command's anchor; a missing one is permanent.
    const located = (
      await tx.execute<{
        actorAccount: string;
        pairId: string | null;
        pairThreadId: number | null;
      }>(
        userIntentLocatorSql({
          actorUserId: command.localUserId,
          targetAccount: peerAccount,
          targetDomain: peerDomain,
          targetNamespaceId: namespaceId,
        }),
      )
    ).rows[0];
    if (!located)
      throw new InvalidReceivedIntentError(
        'user relationship local subject does not exist',
      );
    // A received ACK or REVOKE for a pair this server never saw is inert:
    // there is no consent artifact to conclude and no row to write, while the
    // pull cursor advances (body-level compaction suppresses the repeats).
    if (located.pairId === null && intent.status !== 'REQUESTED')
      return {
        routed:
          intent.status === 'ACCEPTED' ? 'noop:dropped-ack' : 'noop:no-pair',
      };

    const localUser: Endpoint = {
      account: located.actorAccount,
      domain: 'local',
      namespaceId: 0,
    };
    const peer: Endpoint = {
      account: peerAccount,
      domain: peerDomain,
      namespaceId,
    };
    const wireIntent = {
      profileNamespaceId: command.body.profileNamespaceId,
      profileRev: command.body.profileRev,
      note: command.body.note ?? '',
      messageEndSeq: command.body.messageEndSeq ?? 0,
      tombstoneEndSeq: command.body.tombstoneEndSeq ?? 0,
    };
    // Lock order: the local Account State scope (the only account whose owned
    // state this command mutates), then the Pair scope, then Thread Content,
    // then the implicit allocator locks.
    await lockBusinessAccountsInTx(tx, [
      { account: localUser.account, profileNamespaceId: 0 },
    ]);
    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'P2P',
        addresses: [
          completeBusinessAddress(localUser.account, 'local'),
          completeBusinessAddress(peer.account, peer.domain),
        ],
      },
    ]);
    const locked = await lockOrMintUserPairInTx(
      tx,
      located.pairId === null ? null : BigInt(located.pairId),
      localUser,
      peer,
    );
    const pairId = locked.pairId;
    // The retained P2P shell: minted on every positive direction (an incoming
    // REQUESTED or ACK can activate), entered without one on REVOKED.
    const threadId =
      intent.status === 'REVOKED'
        ? requireExistingThreadId(locked.threadId)
        : await ensureThreadShellInTx(tx, pairId, locked.threadId, namespaceId);
    const threadLock = await requireP2PThreadContentLockUnderPairInTx(
      tx,
      pairId,
      threadId,
    );
    await tx.execute(
      sql`SELECT 1 FROM "RelationshipIntent"
      WHERE ("authorAccount" = ${localUser.account} AND "authorNamespaceId" = ${localUser.namespaceId}
          AND "receiverAccount" = ${peer.account} AND "receiverNamespaceId" = ${peer.namespaceId})
        OR ("authorAccount" = ${peer.account} AND "authorNamespaceId" = ${peer.namespaceId}
          AND "receiverAccount" = ${localUser.account} AND "receiverNamespaceId" = ${localUser.namespaceId})
      ORDER BY "authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId"
      FOR NO KEY UPDATE`,
    );
    // Post-lock state read; our side is "own", the peer's retained direction is
    // "reverse". The routing decision reads only this row, never the locator.
    const row = (
      await tx.execute<UserIntentAuthorizationRow>(
        userIntentAuthorizationSql({
          pairId,
          actorUserId: command.localUserId,
          actorAccount: localUser.account,
          actorNamespaceId: localUser.namespaceId,
          targetAccount: peer.account,
          targetDomain: peer.domain,
          targetNamespaceId: peer.namespaceId,
        }),
      )
    ).rows[0];
    if (!row) throw new Error('user intent authorization disappeared');
    // The peer outbound allocator precedes every client-feed allocation,
    // including the AccountThreadState participant trigger below.
    if (peerDomain !== 'local')
      await this.deps.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
        { namespaceId },
      ]);
    // The incoming item is the peer's direction; the activation gate is our
    // own live consent artifact (an unexpired request or a retained
    // acceptance).
    const localLive =
      row.ownStatus === 'ACCEPTED' ||
      (row.ownStatus === 'REQUESTED' && ownRequestUnexpired(row));
    if (intent.status === 'REVOKED')
      await lockUserIntentThreadStateInTx(tx, threadId, localUser, peer);
    else
      await resetUserIntentThreadStateInTx(tx, threadId, localUser, peer, {
        activate: localLive && !row.pairActive,
      });
    await lockUserIntentAccountsInTx(tx, [command.localUserId]);

    // The peer's newest direction is always persisted first (the composed
    // statements' IS DISTINCT guards make a repeat a no-op); only the
    // relationship effects are gated by the local state.
    if (intent.status !== 'REVOKED' && localLive)
      return this.activateInTx(tx, {
        command,
        intent,
        wireIntent,
        pairId,
        threadId,
        threadLock,
        localUser,
        peer,
        row,
        clientUpdates,
        peers,
      });
    if (intent.status === 'REQUESTED')
      return this.recordRequestInTx(tx, {
        intent,
        wireIntent,
        pairId,
        threadId,
        localUser,
        peer,
        row,
        clientUpdates,
      });
    if (intent.status === 'ACCEPTED') return { routed: 'noop:dropped-ack' };
    return this.applyRevocationInTx(tx, {
      wireIntent,
      pairId,
      threadId,
      localUser,
      peer,
      row,
      clientUpdates,
      peers,
      localUserId: command.localUserId,
    });
  }

  /** The activation family: persist the peer's snapshot, promote a live local
   * request (the composed statement's reverse upgrade), and activate the pair
   * with its local friendship effects. The ack-back and the synchronization
   * state are the two own-side consequences of a confirmed relationship. */
  private async activateInTx(
    tx: DatabaseTransaction,
    context: {
      command: ReceivedUserIntentCommand;
      intent: ValidatedReceivedIntent & { status: 'REQUESTED' | 'ACCEPTED' };
      wireIntent: {
        profileNamespaceId: number;
        profileRev: number;
        note: string;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
      pairId: bigint;
      threadId: number;
      threadLock: ThreadContentLock;
      localUser: Endpoint;
      peer: Endpoint;
      row: UserIntentAuthorizationRow;
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<number>;
    },
  ): Promise<ReceivedUserIntentResult> {
    const { command, intent, wireIntent, pairId, threadId } = context;
    const namespaceId = context.peer.namespaceId;
    const { actorKey, targetKey } = this.intentFeedKeys(
      namespaceId,
      context.peer,
      context.localUser,
    );
    const result = await tx.execute<{
      reverseUpgraded: boolean;
      clientUpdates: Array<{ userId: number; feedId: number }>;
    }>(
      userIntentAcceptanceSql({
        pairId,
        threadId,
        namespaceId,
        actorKey,
        targetKey,
        actorAccount: context.peer.account,
        actorDomain: context.peer.domain,
        actorNamespaceId: namespaceId,
        targetAccount: context.localUser.account,
        targetDomain: 'local',
        targetNamespaceId: 0,
        note: wireIntent.note,
        acceptedAt: new Date(),
        authoredSql: receivedUserIntentWriteSql({
          author: {
            account: context.peer.account,
            namespaceId: namespaceId,
          },
          receiver: {
            account: context.localUser.account,
            namespaceId: 0,
          },
          status: 'ACCEPTED',
          profileNamespaceId: wireIntent.profileNamespaceId,
          profileRev: wireIntent.profileRev,
          note: wireIntent.note,
          requestedAt: intent.requestedAt,
          expiresAt: null,
          messageEndSeq: wireIntent.messageEndSeq,
          tombstoneEndSeq: wireIntent.tombstoneEndSeq,
        }),
      }),
    );
    this.pushUpdates(result.rows[0], context.clientUpdates);
    // Announce our direction when this item promoted it, or
    // when a received REQUESTED completed a dangling local acceptance. A
    // received ACK over an already-retained acceptance needs no announcement.
    const publishConfirmation =
      result.rows[0]?.reverseUpgraded === true ||
      (intent.status === 'REQUESTED' && context.row.ownStatus === 'ACCEPTED');
    if (publishConfirmation) {
      // The wireIntent body carries epoch-millisecond numbers (state feed §4.1),
      // so the timestamp converts in SQL — a raw timestamptz string would
      // fail the peer's envelope validation and freeze its pull cursor.
      const [ours] = (
        await tx.execute<{
          status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
          profileNamespaceId: number;
          profileRev: number;
          note: string | null;
          requestedAt: string | null;
        }>(sql`
          SELECT status, "profileNamespaceId", "profileRev", note,
            ${epochMillisSql(sql`"requestedAt"`)} AS "requestedAt"
          FROM "RelationshipIntent"
          WHERE "authorAccount" = ${context.localUser.account}
            AND "authorNamespaceId" = ${context.localUser.namespaceId}
            AND "receiverAccount" = ${context.peer.account}
            AND "receiverNamespaceId" = ${context.peer.namespaceId}
        `)
      ).rows;
      if (!ours) throw new Error('local relationship direction disappeared');
      const confirmations =
        await this.deps.peerFeed.writeAcceptanceConfirmationsInTx(tx, [
          {
            namespaceId,
            account: context.localUser.account,
            subjectAccount: context.peer.account,
            subjectNamespaceId: context.peer.namespaceId,
            eventType: 'RELATIONSHIP_INTENT',
            body: {
              status: ours.status,
              namespaceId: ours.profileNamespaceId,
              profileRev: ours.profileRev,
              note: ours.note ?? '',
              requestedAt:
                ours.requestedAt === null ? null : Number(ours.requestedAt),
              expiresAt: null,
            },
          },
        ]);
      for (const namespaceId of confirmations.keys())
        context.peers.add(namespaceId);
    }
    await openFederatedAudienceInTx(tx, context.peer.namespaceId, threadId);
    await initializeRelationshipThreadStateInTx(
      tx,
      threadId,
      pairId,
      context.threadLock,
    );
    context.clientUpdates.push(
      ...(await captureThreadStateUpdatesInTx(tx, [command.localUserId])),
    );
    return {
      routed: context.row.pairActive
        ? 'noop:already-friends'
        : context.row.ownStatus === 'REQUESTED'
          ? 'activated'
          : 'completion',
      threadId: context.row.pairActive ? undefined : threadId,
    };
  }

  /** A fresh or refreshed application: persist the peer's REQUESTED, publish
   * both current directions to the local endpoints, and wait for the local
   * decision. No activation, no wake to the peer. */
  private async recordRequestInTx(
    tx: DatabaseTransaction,
    context: {
      intent: ValidatedReceivedIntent & { status: 'REQUESTED' };
      wireIntent: {
        profileNamespaceId: number;
        profileRev: number;
        note: string;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
      pairId: bigint;
      threadId: number;
      localUser: Endpoint;
      peer: Endpoint;
      row: UserIntentAuthorizationRow;
      clientUpdates: PendingClientStateFeedUpdate[];
    },
  ): Promise<ReceivedUserIntentResult> {
    const { intent, wireIntent, pairId, threadId } = context;
    const namespaceId = context.peer.namespaceId;
    const { actorKey, targetKey } = this.intentFeedKeys(
      namespaceId,
      context.peer,
      context.localUser,
    );
    const result = await tx.execute<{
      intentChanged: boolean;
      clientUpdates: Array<{ userId: number; feedId: number }>;
    }>(
      userIntentRequestSql({
        pairId,
        threadId,
        namespaceId,
        actorKey,
        targetKey,
        actorAccount: context.peer.account,
        actorDomain: context.peer.domain,
        actorNamespaceId: namespaceId,
        targetAccount: context.localUser.account,
        targetDomain: 'local',
        targetNamespaceId: 0,
        note: wireIntent.note,
        requestedAt: intent.requestedAt,
        expiresAt: intent.expiresAt,
        authoredSql: receivedUserIntentWriteSql({
          author: {
            account: context.peer.account,
            namespaceId: namespaceId,
          },
          receiver: {
            account: context.localUser.account,
            namespaceId: 0,
          },
          status: 'REQUESTED',
          profileNamespaceId: wireIntent.profileNamespaceId,
          profileRev: wireIntent.profileRev,
          note: wireIntent.note,
          requestedAt: intent.requestedAt,
          expiresAt: intent.expiresAt,
          messageEndSeq: wireIntent.messageEndSeq,
          tombstoneEndSeq: wireIntent.tombstoneEndSeq,
        }),
      }),
    );
    this.pushUpdates(result.rows[0], context.clientUpdates);
    // A stranger's application is recorded; an expired or withdrawn prior
    // direction is refreshed. The effects are identical — routing is only a
    // diagnostic. On an already-active pair the refresh carries no transition.
    const routed: ReceivedUserIntentRouting = context.row.pairActive
      ? 'noop:already-friends'
      : context.row.reverseStatus === null
        ? 'recorded-request'
        : 'refreshed-request';
    return { routed };
  }

  /** The received REVOKE: persist the peer's direction, and when the pair was
   * active run the departure boundary in this transaction (the composed
   * statement gates every effect on the pair transition). Our own direction is
   * authored in the same transaction after the peer direction. Off the pair,
   * a pending request stays requestable (rejection) while a dangling
   * acceptance is concluded so it cannot survive as a live consent artifact. */
  private async applyRevocationInTx(
    tx: DatabaseTransaction,
    context: {
      wireIntent: {
        profileNamespaceId: number;
        profileRev: number;
        note: string;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      };
      pairId: bigint;
      threadId: number;
      localUser: Endpoint;
      peer: Endpoint;
      row: UserIntentAuthorizationRow;
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<number>;
      localUserId: number;
    },
  ): Promise<ReceivedUserIntentResult> {
    const { wireIntent, pairId, threadId } = context;
    const namespaceId = context.peer.namespaceId;
    const { actorKey, targetKey } = this.intentFeedKeys(
      namespaceId,
      context.peer,
      context.localUser,
    );
    const result = await tx.execute<{
      pairChanged: boolean;
      clientUpdates: Array<{ userId: number; feedId: number }>;
    }>(
      userIntentRevocationSql({
        pairId,
        threadId,
        namespaceId,
        actorKey,
        targetKey,
        actorAccount: context.peer.account,
        actorDomain: context.peer.domain,
        actorNamespaceId: namespaceId,
        targetAccount: context.localUser.account,
        targetDomain: 'local',
        targetNamespaceId: 0,
        localActorId: context.localUserId,
        localTargetId: null,
        authoredSql: receivedUserIntentWriteSql({
          author: {
            account: context.peer.account,
            namespaceId: namespaceId,
          },
          receiver: {
            account: context.localUser.account,
            namespaceId: 0,
          },
          status: 'REVOKED',
          profileNamespaceId: wireIntent.profileNamespaceId,
          profileRev: wireIntent.profileRev,
          note: wireIntent.note,
          requestedAt: null,
          expiresAt: null,
        }),
      }),
    );
    this.pushUpdates(result.rows[0], context.clientUpdates);
    if (result.rows[0]?.pairChanged === true) {
      await this.authorOwnConclusionInTx(tx, context);
      return { routed: 'kick' };
    }
    if (context.row.ownStatus === 'ACCEPTED') {
      await this.authorOwnConclusionInTx(tx, context);
      return { routed: 'conclusion' };
    }
    if (context.row.ownStatus === 'REQUESTED') return { routed: 'rejection' };
    return { routed: 'noop:already-revoked' };
  }

  /** Author our REVOKED conclusion while the received command still owns the
   * Account, Pair, thread, intent and feed locks. A refusal here contradicts
   * the post-lock state used above and is therefore an invariant failure. */
  private async authorOwnConclusionInTx(
    tx: DatabaseTransaction,
    context: {
      localUser: Endpoint;
      peer: Endpoint;
      localUserId: number;
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<number>;
    },
  ): Promise<void> {
    const result = await this.deps.userIntents.executeInTx(
      tx,
      {
        userId: context.localUserId,
        decision: 'REVOKED',
        target: context.peer,
      },
      context.clientUpdates,
    );
    if (isBusinessRejection(result.outcome))
      throw new Error(
        `received revoke conclusion rejected: ${result.outcome.reason}`,
      );
    for (const namespaceId of result.peers.keys())
      context.peers.add(namespaceId);
  }

  /** Feed compaction keys follow the direction each key names: the wire
   * author (the peer) and the local target. */
  private intentFeedKeys(
    namespaceId: number,
    actor: Endpoint,
    target: Endpoint,
  ): { actorKey: string; targetKey: string } {
    return {
      actorKey: userIntentCompactionKey(namespaceId, actor, target),
      targetKey: userIntentCompactionKey(namespaceId, target, actor),
    };
  }

  private pushUpdates(
    row:
      | { clientUpdates?: Array<{ userId: number; feedId: number }> }
      | undefined,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): void {
    for (const update of row?.clientUpdates ?? [])
      clientUpdates.push({
        userId: update.userId,
        feedId: Number(update.feedId),
      });
  }
}
