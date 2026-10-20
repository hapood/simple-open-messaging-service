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
import type { FederationStateFeedPusher } from '../../../federation/federation-state-feed.events.js';
import type { RequestTransactionCapability } from '../../../relationship/request/request-transaction.contract.js';
import type { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import { openFederatedAudienceInTx } from '../../../federation/federation-audience.js';
import { initializeRelationshipThreadStateInTx } from '../../../federation/federation-relationship-thread-state.js';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import { normalizeAccount } from '../../../common/account.js';
import { localIdentityDomain } from '../../../common/local-identity.js';
import { lockBusinessAccountsInTx } from '../../../common/locks/account-business-lock.js';
import { completeBusinessAddress } from '../../../common/locks/business-address.js';
import { lockRelationshipPairsInTx } from '../../../common/locks/relationship-pair-business-lock.js';
import {
  requireP2PThreadContentLockUnderPairInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import {
  pairAuthorizationSql,
  directedIntentSql,
  userIntentLocatorSql,
  type PairAuthorizationRow,
  type DirectedIntentRow,
} from '../authored/user-intent-authorization-sql.js';
import { userIntentAcceptanceSql } from '../authored/user-intent-acceptance-sql.js';
import { receivedUserIntentRequestSql } from './received-user-intent-request-sql.js';
import { userIntentRevocationSql } from '../authored/user-intent-revocation-sql.js';
import { receivedUserIntentWriteSql } from './received-user-intent-write-sql.js';
import type { UserIntentService } from '../authored/user-intent.service.js';
import { isBusinessRejection } from '../../../common/business-command-result.js';
import {
  InvalidReceivedIntentError,
  validateReceivedIntentBody,
} from '../../../group/membership-intent/received/received-membership-body.js';
import {
  ensureThreadShellInTx,
  lockOrMintUserPairInTx,
  lockUserIntentAccountsInTx,
  lockUserIntentThreadStateInTx,
  requireExistingThreadId,
  resetUserIntentThreadStateInTx,
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

  constructor(
    private readonly database: DatabaseService,
    private readonly clientFeed: ClientStateFeedService,
    private readonly peerFeed: PeerStateFeedService,
    private readonly federation: FederationStateFeedPusher,
    private readonly userIntents: UserIntentService,
    private readonly requestCapability: RequestTransactionCapability,
  ) {}

  async execute(
    command: ReceivedUserIntentCommand,
  ): Promise<{ routed: ReceivedUserIntentRouting }> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = new Set<number>();
    const result = await this.database.db.transaction(async (tx) =>
      this.applyInTx(tx, command, clientUpdates, peers),
    );
    try {
      if (clientUpdates.length > 0)
        this.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn('received user intent client wake failed', error);
    }
    if (peers.size > 0) void this.federation.pushStateFeedNamespaces(peers);
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
        actorDomain: string;
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
      domain: await localIdentityDomain(tx),
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
          completeBusinessAddress(localUser.account, 0),
          completeBusinessAddress(peer.account, peer.namespaceId),
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
    const pairRow = (
      await tx.execute<PairAuthorizationRow>(
        pairAuthorizationSql({
          pairId,
          actorUserId: command.localUserId,
          targetAccount: peer.account,
          targetDomain: peer.domain,
          targetNamespaceId: peer.namespaceId,
        }),
      )
    ).rows[0];
    if (!pairRow) throw new Error('user intent authorization disappeared');
    // The peer outbound allocator precedes every client-feed allocation,
    // including the AccountThreadState participant trigger below.
    if (namespaceId !== 0)
      await this.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
        { namespaceId },
      ]);

    const [ownIntent] = (
      await tx.execute<DirectedIntentRow>(
        directedIntentSql({
          authorAccount: localUser.account,
          authorNamespaceId: localUser.namespaceId,
          receiverAccount: peer.account,
          receiverNamespaceId: peer.namespaceId,
        }),
      )
    ).rows;

    const [peerIntent] = (
      await tx.execute<DirectedIntentRow>(
        directedIntentSql({
          authorAccount: peer.account,
          authorNamespaceId: peer.namespaceId,
          receiverAccount: localUser.account,
          receiverNamespaceId: localUser.namespaceId,
        }),
      )
    ).rows;

    const localLive =
      ownIntent?.status === 'ACCEPTED' ||
      (ownIntent?.status === 'REQUESTED' &&
        ownIntent.expiresAt !== null &&
        new Date(ownIntent.expiresAt).getTime() > Date.now());
    await lockUserIntentThreadStateInTx(tx, threadId, localUser, peer);
    await lockUserIntentAccountsInTx(tx, [command.localUserId]);

    const contextBase = {
      pair: pairRow,
      localIntent: ownIntent ?? null,
      peerIntent: peerIntent ?? null,
    };

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
        ...contextBase,
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
        ...contextBase,
        clientUpdates,
        localUserId: command.localUserId,
      });
    if (intent.status === 'ACCEPTED') {
      await resetUserIntentThreadStateInTx(tx, threadId, localUser, peer, {
        activate: false,
        boundarySeq: pairRow.threadCurSeq,
      });
      return { routed: 'noop:dropped-ack' };
    }
    return this.applyRevocationInTx(tx, {
      wireIntent,
      pairId,
      threadId,
      localUser,
      peer,
      ...contextBase,
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
      pair: PairAuthorizationRow;
      localIntent: DirectedIntentRow | null;
      peerIntent: DirectedIntentRow | null;
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<number>;
    },
  ): Promise<ReceivedUserIntentResult> {
    const { command, intent, wireIntent, pairId, threadId } = context;
    const namespaceId = context.peer.namespaceId;
    const result = await tx.execute<{
      reverseUpgraded: boolean;
      pairChanged: boolean;
    }>(
      userIntentAcceptanceSql({
        pairId,
        threadId,
        namespaceId,
        actorAccount: context.peer.account,
        actorNamespaceId: namespaceId,
        targetAccount: context.localUser.account,
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
    await resetUserIntentThreadStateInTx(
      tx,
      threadId,
      context.localUser,
      context.peer,
      {
        activate: result.rows[0]?.pairChanged === true,
        boundarySeq: context.pair.threadCurSeq,
      },
    );
    // The locally authored direction this acceptance promotes may still be
    // associated with an open round: conclude it in the same transaction so
    // the author's outgoing history settles at ACCEPTED. A replay finds the
    // round already concluded and the call reports stale without writes.
    if (
      context.localIntent?.status === 'REQUESTED' &&
      context.localIntent.requestId !== null
    )
      await this.requestCapability.concludeRequestInTx(tx, {
        flow: {
          kind: 'FRIEND',
          author: {
            account: context.localUser.account,
            namespaceId: 0,
          },
          receiver: {
            account: context.peer.account,
            namespaceId: context.peer.namespaceId,
          },
        },
        requestId: BigInt(context.localIntent.requestId),
        cause: 'ACCEPT',
      });
    // Announce our direction when this item promoted it, or
    // when a received REQUESTED completed a dangling local acceptance. A
    // received ACK over an already-retained acceptance needs no announcement.
    const publishConfirmation =
      result.rows[0]?.reverseUpgraded === true ||
      (intent.status === 'REQUESTED' &&
        context.localIntent?.status === 'ACCEPTED');
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
            CASE WHEN "requestedAt" IS NULL THEN NULL
              ELSE floor(extract(epoch FROM "requestedAt") * 1000)::bigint END AS "requestedAt"
          FROM "RelationshipIntent"
          WHERE "authorAccount" = ${context.localUser.account}
            AND "authorNamespaceId" = ${context.localUser.namespaceId}
            AND "receiverAccount" = ${context.peer.account}
            AND "receiverNamespaceId" = ${context.peer.namespaceId}
        `)
      ).rows;
      if (!ours) throw new Error('local relationship direction disappeared');
      const confirmations =
        await this.peerFeed.writeAcceptanceConfirmationsInTx(tx, [
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
      routed: context.pair.pairActive
        ? 'noop:already-friends'
        : context.localIntent?.status === 'REQUESTED'
          ? 'activated'
          : 'completion',
      threadId: context.pair.pairActive ? undefined : threadId,
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
      pair: PairAuthorizationRow;
      localIntent: DirectedIntentRow | null;
      peerIntent: DirectedIntentRow | null;
      clientUpdates: PendingClientStateFeedUpdate[];
      localUserId: number;
    },
  ): Promise<ReceivedUserIntentResult> {
    const { intent, wireIntent, pairId, threadId } = context;
    const namespaceId = context.peer.namespaceId;
    const result = await tx.execute<{
      intentChanged: boolean;
    }>(
      receivedUserIntentRequestSql({
        pairId,
        threadId,
        namespaceId,
        actorAccount: context.peer.account,
        actorNamespaceId: namespaceId,
        targetAccount: context.localUser.account,
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
    // A remote-authored round is projected locally with the wire's own
    // validity window, mirroring the group remote-application path: the
    // receiver decides by this local round id. No author-side snapshot is
    // stored — the incoming view resolves the wire author-profile
    // coordinates. A refresh on an already-active pair projects nothing.
    if (!context.pair.pairActive) {
      const projected = await this.requestCapability.openRequestInTx(tx, {
        flow: {
          kind: 'FRIEND',
          author: {
            account: context.peer.account,
            namespaceId: context.peer.namespaceId,
          },
          receiver: {
            account: context.localUser.account,
            namespaceId: 0,
          },
        },
        evidence: {
          authorProfileNamespaceId: wireIntent.profileNamespaceId,
          authorProfileRev: wireIntent.profileRev,
          snapshot: null,
          note: wireIntent.note,
          requestedAt: intent.requestedAt,
          expiresAt: intent.expiresAt,
        },
      });
      if (projected.status !== 'STALE_REQUEST')
        context.clientUpdates.push(...projected.effects.clientUpdates);
    }
    await resetUserIntentThreadStateInTx(
      tx,
      threadId,
      context.localUser,
      context.peer,
      {
        activate: false,
        boundarySeq: context.pair.threadCurSeq,
      },
    );
    context.clientUpdates.push(
      ...(await captureThreadStateUpdatesInTx(tx, [context.localUserId])),
    );
    // A stranger's application is recorded; an expired or withdrawn prior
    // direction is refreshed. The effects are identical — routing is only a
    // diagnostic. On an already-active pair the refresh carries no transition.
    const routed: ReceivedUserIntentRouting = context.pair.pairActive
      ? 'noop:already-friends'
      : context.peerIntent === null
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
      pair: PairAuthorizationRow;
      localIntent: DirectedIntentRow | null;
      peerIntent: DirectedIntentRow | null;
      clientUpdates: PendingClientStateFeedUpdate[];
      peers: Set<number>;
      localUserId: number;
    },
  ): Promise<ReceivedUserIntentResult> {
    const { wireIntent, pairId, threadId } = context;
    const namespaceId = context.peer.namespaceId;
    const result = await tx.execute<{
      pairChanged: boolean;
    }>(
      userIntentRevocationSql({
        pairId,
        threadId,
        namespaceId,
        actorAccount: context.peer.account,
        actorNamespaceId: namespaceId,
        targetAccount: context.localUser.account,
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
    // Open rounds settle with the peer's revocation: our pending request
    // was rejected, the peer's own projected request was withdrawn. Both
    // conclusions are idempotent — a redelivery finds closed rounds and the
    // capability reports stale without writing.
    if (
      context.localIntent?.status === 'REQUESTED' &&
      context.localIntent.requestId !== null
    )
      await this.requestCapability.concludeRequestInTx(tx, {
        flow: {
          kind: 'FRIEND',
          author: {
            account: context.localUser.account,
            namespaceId: 0,
          },
          receiver: {
            account: context.peer.account,
            namespaceId: context.peer.namespaceId,
          },
        },
        requestId: BigInt(context.localIntent.requestId),
        cause: 'REJECT',
      });
    if (
      context.peerIntent?.status === 'REQUESTED' &&
      context.peerIntent.requestId !== null
    )
      await this.requestCapability.concludeRequestInTx(tx, {
        flow: {
          kind: 'FRIEND',
          author: {
            account: context.peer.account,
            namespaceId: context.peer.namespaceId,
          },
          receiver: {
            account: context.localUser.account,
            namespaceId: 0,
          },
        },
        requestId: BigInt(context.peerIntent.requestId),
        cause: 'WITHDRAW',
      });
    if (result.rows[0]?.pairChanged === true) {
      await this.authorOwnConclusionInTx(tx, context);
      return { routed: 'kick' };
    }
    if (context.localIntent?.status === 'ACCEPTED') {
      await this.authorOwnConclusionInTx(tx, context);
      return { routed: 'conclusion' };
    }
    if (context.localIntent?.status === 'REQUESTED') {
      // BUG-1 convergence: the peer's REVOKED ends our pending direction in
      // this same transaction — a left-live REQUESTED would swallow a later
      // re-request as a same-round refresh and never reach the peer. The
      // round itself already concluded REJECTED above; no echo is authored
      // because the peer already holds the rejection fact.
      await tx.execute(
        authoredIntentWriteSql({
          author: {
            account: context.localUser.account,
            namespaceId: 0,
          },
          receiver: {
            account: context.peer.account,
            namespaceId: context.peer.namespaceId,
          },
          threadId,
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
        }),
      );
      return { routed: 'rejection' };
    }
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
    const result = await this.userIntents.executeInTx(
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
}
