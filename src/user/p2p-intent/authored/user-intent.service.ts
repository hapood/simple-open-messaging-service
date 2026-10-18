import type { RequestSnapshot } from '../../../../shared/request-snapshot.js';
import { lockRelationshipPairsInTx } from '../../../common/locks/relationship-pair-business-lock.js';
import { completeBusinessAddress } from '../../../common/locks/business-address.js';
import { lockBusinessAccountsInTx } from '../../../common/locks/account-business-lock.js';
import {
  requireP2PThreadContentLockUnderPairInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import {
  userIntentAuthorizationSql,
  userIntentLocatorSql,
  type UserIntentAuthorizationRow,
} from './user-intent-authorization-sql.js';
import {
  userIntentRequestSql,
  type UserIntentRequestInput,
} from './user-intent-request-sql.js';
import {
  userIntentAcceptanceSql,
  type UserIntentAcceptanceInput,
} from './user-intent-acceptance-sql.js';
import {
  userIntentRevocationSql,
  type UserIntentRevocationInput,
} from './user-intent-revocation-sql.js';
import { initializeRelationshipThreadStateInTx } from '../../../federation/federation-relationship-thread-state.js';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import {
  ensureThreadShellInTx,
  lockOrMintUserPairInTx,
  lockUserIntentAccountsInTx,
  lockUserIntentThreadStateInTx,
  requireExistingThreadId,
  resetUserIntentThreadStateInTx,
  reverseEffective,
  reverseRequestUnexpired,
  ownRequestUnexpired,
  userIntentCompactionKey,
  type UserIntentEndpoint,
} from '../shared/user-intent-state-sql.js';
import { Logger } from '@nestjs/common';
import { MeasureBusinessOperation } from '../../../diagnostics/execution-measurement.js';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../../../common/business-code.js';
import { BusinessException } from '../../../common/business.exception.js';
import {
  type BusinessRejection,
  isBusinessRejection,
  rejectBusinessCommand,
} from '../../../common/business-command-result.js';
import { normalizeAccount } from '../../../common/account.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../database/database.service.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import type { FederationStateFeedPusher } from '../../../federation/federation-state-feed.events.js';
import type { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import type { FederationNamespaceService } from '../../../federation/federation-namespace.service.js';
import { RELATIONSHIP_INTENT_REQUEST_TTL_MS } from '../../../common/relationship-intent-state.js';

/** One command family: a local user's authored intent about one P2P pair.
 * The target is addressed by account and identity namespace; the pair is
 * minted when absent (REQUESTED only). The domain is resolved from the
 * namespace row's current binding — a handshake-only concern. */
export type UserIntentCommand = {
  userId: number;
  target: { account: string; namespaceId: number };
  note?: string;
} & (
  | { decision: 'REQUESTED'; snapshot: RequestSnapshot }
  | { decision: 'ACCEPTED' | 'REVOKED'; snapshot?: never }
);

export interface UserIntentOptions {
  /** Runs inside the intent transaction after branch validation and
   * before the composed statement, so a
   * rollback also rolls the tick back. */
  admissionInTx?: (tx: DatabaseTransaction) => Promise<void>;
  /** Commit-time fence for a command derived from a federation thread round.
   * The thread is checked after Pair -> Thread locks are held, so a newer
   * authorization decision wins without the stale command writing anything. */
  expectedAuthorization?: { threadId: number; epoch: number };
}

/** Outcome for the HTTP surface: `threadId` is present only when the pair is
 * active after the command (clients read it as the FRIEND fact). */
export type UserIntentOutcome =
  | { status: 'APPLIED'; threadId?: number }
  | { status: 'NO_OP'; reason: 'ALREADY_ACTIVE'; threadId: number }
  | { status: 'NO_OP'; reason: 'STALE_AUTHORIZATION' }
  | BusinessRejection;

export interface UserIntentTransactionOutcome {
  outcome: UserIntentOutcome;
  peers: Map<number, bigint>;
}

export interface UserIntentDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  peerFeed: PeerStateFeedService;
  federation: FederationStateFeedPusher;
  namespaces: FederationNamespaceService;
}

type Endpoint = UserIntentEndpoint;

const validated = Symbol('validated user intent decision');

interface LocatorRow extends Record<string, unknown> {
  actorAccount: string;
  actorDomain: string;
  actorAvailability: string;
  actorDisabledAt: string | null;
  pairId: string | null;
  pairThreadId: number | null;
  localTargetId: number | null;
  localTargetAvailability: string | null;
  localTargetDisabledAt: string | null;
}

/** The satisfied-acceptance result: the pair is already active, nothing to write. */
interface NoOpIntent {
  noOp: true;
  threadId: number;
}

interface StaleAuthorization {
  staleAuthorization: true;
}

interface RejectedIntent {
  rejected: BusinessRejection;
}

/** Lexical capability, created only after locks and authorization. Mutable pair
 * state is not cached. */
interface ValidatedIntentBase {
  readonly [validated]: true;
  readonly tx: DatabaseTransaction;
  readonly threadLock: ThreadContentLock;
  readonly params: UserIntentCommand;
  readonly pairId: bigint;
  readonly threadId: number;
  readonly actor: Endpoint;
  readonly target: Endpoint;
  readonly localActorId: number;
  readonly localTargetId: number | null;
  readonly authorization: UserIntentAuthorizationRow;
  readonly validationTime: number;
}

type ValidatedIntent = ValidatedIntentBase &
  (
    | { readonly kind: 'request'; readonly input: UserIntentRequestInput }
    | {
        readonly kind: 'acceptance';
        readonly input: UserIntentAcceptanceInput;
      }
    | {
        readonly kind: 'revocation';
        readonly input: UserIntentRevocationInput;
      }
  );

/** The public entry owns the transaction; internal updates consume its
 * validated lock capability. It locks the local actor's Account state, then the
 * Pair, then thread/intent/allocator rows. The target's relationship-derived
 * state belongs to the Pair scope, not to the target's Account State scope. */
export class UserIntentService {
  private readonly logger = new Logger(UserIntentService.name);

  constructor(private readonly deps: UserIntentDependencies) {}

  @MeasureBusinessOperation('relationship.user-intent')
  async execute(
    params: UserIntentCommand,
    options?: UserIntentOptions,
  ): Promise<UserIntentOutcome> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const applied = await this.deps.database.db.transaction((tx) =>
      this.executeInTx(tx, params, clientUpdates, options),
    );
    if (applied.peers.size > 0 || clientUpdates.length > 0) {
      try {
        if (clientUpdates.length > 0)
          this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
      } catch (error) {
        this.logger.warn('user intent client wake failed', error);
      }
      if (applied.peers.size > 0)
        void this.deps.federation.pushStateFeedNamespaces(applied.peers.keys());
    }
    return applied.outcome;
  }

  /** Transactional entry for durable system work. The caller owns commit and
   * therefore also owns post-commit client/peer wakes. */
  async executeInTx(
    tx: DatabaseTransaction,
    params: UserIntentCommand,
    clientUpdates: PendingClientStateFeedUpdate[],
    options?: UserIntentOptions,
  ): Promise<UserIntentTransactionOutcome> {
    const context = await this.lockAndValidateInTx(tx, params, options);
    // An already-active pair is a satisfied acceptance: nothing to write or
    // wake, while the outcome still carries the active thread.
    if ('rejected' in context)
      return { outcome: context.rejected, peers: new Map() };
    if ('staleAuthorization' in context)
      return {
        outcome: { status: 'NO_OP', reason: 'STALE_AUTHORIZATION' },
        peers: new Map(),
      };
    if ('noOp' in context)
      return {
        outcome: {
          status: 'NO_OP',
          reason: 'ALREADY_ACTIVE',
          threadId: context.threadId,
        },
        peers: new Map(),
      };
    await options?.admissionInTx?.(tx);
    const peers = await this.applyInTx(context, clientUpdates);
    return {
      // Only an acceptance (or its crossed-request collapse) leaves the pair
      // active; clients read the returned thread as the FRIEND fact.
      outcome: {
        status: 'APPLIED',
        ...(context.kind === 'acceptance'
          ? { threadId: context.threadId }
          : {}),
      },
      peers,
    };
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: UserIntentCommand,
    options?: UserIntentOptions,
  ): Promise<
    ValidatedIntent | NoOpIntent | RejectedIntent | StaleAuthorization
  > {
    const targetAccount = normalizeAccount(params.target.account);
    // Identity addressing: the namespace id is the durable key. The target's
    // delivery domain is resolved from the namespace row's current binding;
    // namespace zero (the local authority) keeps the node's own identity
    // domain because its namespace row is intentionally inactive.
    let targetNamespaceId: number;
    let effectiveDomain: string;
    if (params.target.namespaceId === 0) {
      targetNamespaceId = 0;
      effectiveDomain = await this.deps.namespaces.localDomainInTx(tx);
    } else {
      try {
        const row = await this.deps.namespaces.captureActiveByIdInTx(
          tx,
          params.target.namespaceId,
        );
        targetNamespaceId = row.namespaceId;
        effectiveDomain = row.domain;
      } catch (error) {
        if (!(error instanceof BusinessException)) throw error;
        return this.reject(
          'IDENTITY_MISMATCH',
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          `target namespace ${params.target.namespaceId} is retired or unknown`,
        );
      }
    }
    const located = await this.locateInTx(tx, {
      actorUserId: params.userId,
      targetAccount,
      targetDomain: effectiveDomain,
      targetNamespaceId,
    });
    if (!located)
      return this.reject(
        'ACTOR_NOT_FOUND',
        BusinessCode.UNAUTHENTICATED,
        'authenticated user does not exist',
      );
    if (
      located.actorAvailability !== 'AVAILABLE' ||
      located.actorDisabledAt !== null
    )
      return this.reject(
        'ACTOR_NOT_FOUND',
        BusinessCode.UNAUTHENTICATED,
        'authenticated user does not exist',
      );
    if (targetNamespaceId === 0 && targetAccount === located.actorAccount)
      return this.reject(
        'SELF_TARGET',
        BusinessCode.FRIEND_SELF,
        'can not request a relationship with yourself',
      );
    if (
      targetNamespaceId === 0 &&
      (located.localTargetId === null ||
        located.localTargetAvailability !== 'AVAILABLE' ||
        located.localTargetDisabledAt !== null)
    )
      return this.reject(
        'TARGET_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'request target is missing',
      );
    let pairId: bigint | null =
      located.pairId === null ? null : BigInt(located.pairId);
    // An absent pair cannot change under the caller, so rejecting before the
    // locks is authoritative — matching the group family's locator contract.
    if (!pairId && params.decision !== 'REQUESTED')
      return this.reject(
        'INTENT_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'request not found',
      );

    const actor: Endpoint = {
      account: located.actorAccount,
      domain: located.actorDomain,
      namespaceId: 0,
    };
    const target: Endpoint = {
      account: targetAccount,
      // Delivery follows the namespace row's current binding, so a
      // re-bound identity is addressed at its live domain.
      domain: effectiveDomain,
      namespaceId: targetNamespaceId,
    };
    // The command owns only the local actor's account state. Both endpoints'
    // intent and relationship-derived projections are protected by the Pair.
    await lockBusinessAccountsInTx(tx, [
      { account: actor.account, profileNamespaceId: 0 },
      ...(target.namespaceId === 0
        ? [{ account: target.account, profileNamespaceId: 0 }]
        : []),
    ]);
    await lockRelationshipPairsInTx(tx, [
      {
        kind: 'P2P',
        addresses: [
          completeBusinessAddress(actor.account, 0),
          completeBusinessAddress(target.account, target.namespaceId),
        ],
      },
    ]);

    const lockedPair = await lockOrMintUserPairInTx(tx, pairId, actor, target);
    pairId = lockedPair.pairId;
    located.pairThreadId = lockedPair.threadId;
    if (params.decision === 'REVOKED' && located.pairThreadId === null)
      return this.reject(
        'INTENT_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'request not found',
      );

    // The retained P2P shell: positive directions mint and bind the thread
    // when the pair has none; revocation requires an existing thread.
    const shell =
      params.decision === 'REVOKED'
        ? requireExistingThreadId(located.pairThreadId)
        : await ensureThreadShellInTx(
            tx,
            pairId,
            located.pairThreadId,
            targetNamespaceId,
          );
    const threadLock = await requireP2PThreadContentLockUnderPairInTx(
      tx,
      pairId,
      shell,
    );
    await tx.execute(
      sql`SELECT 1 FROM "RelationshipIntent"
      WHERE ("authorAccount" = ${actor.account} AND "authorNamespaceId" = ${actor.namespaceId}
          AND "receiverAccount" = ${target.account} AND "receiverNamespaceId" = ${target.namespaceId})
        OR ("authorAccount" = ${target.account} AND "authorNamespaceId" = ${target.namespaceId}
          AND "receiverAccount" = ${actor.account} AND "receiverNamespaceId" = ${actor.namespaceId})
      ORDER BY "authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId"
      FOR NO KEY UPDATE`,
    );
    // One post-lock authorization read; the participant reset below gates on it
    // so an already-active pair's no-op path leaves participant state alone.
    const row = (
      await tx.execute<UserIntentAuthorizationRow>(
        userIntentAuthorizationSql({
          pairId,
          actorUserId: params.userId,
          actorAccount: actor.account,
          actorNamespaceId: actor.namespaceId,
          targetAccount,
          targetDomain: effectiveDomain,
          targetNamespaceId: target.namespaceId,
        }),
      )
    ).rows[0];
    if (!row) throw new Error('user intent authorization disappeared');
    if (
      options?.expectedAuthorization &&
      (row.threadId !== options.expectedAuthorization.threadId ||
        row.authorizationEpoch !== options.expectedAuthorization.epoch)
    )
      return { staleAuthorization: true };
    const base: ValidatedIntentBase = {
      [validated]: true,
      tx,
      threadLock,
      params,
      pairId,
      threadId: shell,
      actor,
      target,
      localActorId: params.userId,
      localTargetId: row.localTargetId,
      authorization: row,
      validationTime: Date.now(),
    };
    // Resolve the branch once before participant mutation. Expiry must not
    // route the same command differently after an awaited allocator lock.
    const context =
      params.decision === 'REQUESTED'
        ? this.validateRequestInTx(base, row)
        : params.decision === 'ACCEPTED'
          ? this.validateAcceptanceInTx(base, row)
          : this.validateRevocationInTx(base, row);
    if ('noOp' in context || 'rejected' in context) return context;
    // Peer feed allocators precede every operation that may allocate from a
    // local Account state-feed counter, including AccountThreadState triggers.
    if (target.namespaceId !== 0)
      await this.deps.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
        { namespaceId: targetNamespaceId },
      ]);
    await lockUserIntentThreadStateInTx(tx, shell, actor, target);
    // Account rows the composed statements allocate client feed ids from.
    await lockUserIntentAccountsInTx(
      tx,
      [located.localTargetId, params.userId].filter(
        (id): id is number => typeof id === 'number',
      ),
    );
    return context;
  }

  private async locateInTx(
    tx: DatabaseTransaction,
    key: {
      actorUserId: number;
      targetAccount: string;
      targetDomain: string;
      targetNamespaceId: number;
    },
  ): Promise<LocatorRow | undefined> {
    return (await tx.execute<LocatorRow>(userIntentLocatorSql(key))).rows[0];
  }

  /** REQUESTED entry. `req + req/ack = ack`: a live reverse direction (their
   * pending request, or their ACCEPTED that our earlier revoke had withdrawn
   * from) collapses into the acceptance path with the authorization row
   * already in hand. Every other state receives a fresh or refreshed request. */
  private validateRequestInTx(
    base: ValidatedIntentBase,
    row: UserIntentAuthorizationRow,
  ): ValidatedIntent | NoOpIntent | RejectedIntent {
    if (base.params.decision !== 'REQUESTED') throw new Error('request command required');
    if (reverseEffective(row, base.validationTime))
      return this.validateAcceptanceInTx(base, row);
    if (row.localTargetId === null && base.target.namespaceId === 0)
      return this.reject(
        'TARGET_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'request target is missing',
      );
    const requestedAt = new Date();
    const expiresAt = new Date(
      requestedAt.getTime() + RELATIONSHIP_INTENT_REQUEST_TTL_MS,
    );
    return this.finalize(base, {
      kind: 'request',
      input: {
        ...feedInput(base),
        snapshot: base.params.snapshot,
        note: (base.params.note ?? '').slice(0, 255),
        requestedAt,
        expiresAt,
      },
    });
  }

  /** ACCEPTED entry states: an already-active pair is a satisfied no-op; a live
   * reverse request is accepted; a reverse ACCEPTED (our withdrawal left their
   * confirmation behind) completes the activation. Everything else — none,
   * REVOKED, expired — is a stale command. */
  private validateAcceptanceInTx(
    base: ValidatedIntentBase,
    row: UserIntentAuthorizationRow,
  ): ValidatedIntent | NoOpIntent | RejectedIntent {
    if (row.pairActive) return { noOp: true, threadId: base.threadId };
    const live =
      (row.reverseStatus === 'REQUESTED' &&
        reverseRequestUnexpired(row, base.validationTime)) ||
      row.reverseStatus === 'ACCEPTED';
    if (!live)
      return this.reject(
        row.reverseStatus === 'REQUESTED'
          ? 'INTENT_EXPIRED'
          : 'INTENT_NOT_FOUND',
        row.reverseStatus === 'REQUESTED'
          ? BusinessCode.INVITE_EXPIRED
          : BusinessCode.NOT_FOUND,
        row.reverseStatus === 'REQUESTED'
          ? 'request has expired'
          : 'request not found',
      );
    if (row.localTargetId === null && base.target.namespaceId === 0)
      return this.reject(
        'TARGET_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'request target is missing',
      );
    return this.finalize(base, {
      kind: 'acceptance',
      input: {
        ...feedInput(base),
        // An ACK entry carries no note; the crossed-request collapse keeps the
        // requester's note.
        note: (base.params.decision === 'REQUESTED'
          ? (base.params.note ?? '')
          : ''
        ).slice(0, 255),
        acceptedAt: new Date(),
      },
    });
  }

  /** REVOKE covers withdraw, reject, and end-friendship. Something must be
   * live on either side — an intent or the pair itself — or the command is
   * stale. Departure effects gate on the pair transition inside the statement. */
  private validateRevocationInTx(
    base: ValidatedIntentBase,
    row: UserIntentAuthorizationRow,
  ): ValidatedIntent | RejectedIntent {
    const ownLive =
      row.ownStatus === 'ACCEPTED' ||
      (row.ownStatus === 'REQUESTED' &&
        ownRequestUnexpired(row, base.validationTime));
    if (
      !(ownLive || reverseEffective(row, base.validationTime) || row.pairActive)
    )
      return this.reject(
        row.ownStatus === 'REQUESTED' || row.reverseStatus === 'REQUESTED'
          ? 'INTENT_EXPIRED'
          : 'INTENT_NOT_FOUND',
        row.ownStatus === 'REQUESTED' || row.reverseStatus === 'REQUESTED'
          ? BusinessCode.INVITE_EXPIRED
          : BusinessCode.NOT_FOUND,
        row.ownStatus === 'REQUESTED' || row.reverseStatus === 'REQUESTED'
          ? 'request has expired'
          : 'request not found',
      );
    return this.finalize(base, {
      kind: 'revocation',
      input: {
        ...feedInput(base),
      },
    });
  }

  private reject(
    reason: BusinessRejection['reason'],
    code: BusinessCode,
    message: string,
  ): RejectedIntent {
    return { rejected: rejectBusinessCommand(reason, code, message) };
  }

  /** Shared branch epilogue: build the validated capability. The composed
   * statements read every remaining coordinate from locked rows. */
  private finalize(
    base: ValidatedIntentBase,
    branch:
      | { kind: 'request'; input: UserIntentRequestInput }
      | { kind: 'acceptance'; input: UserIntentAcceptanceInput }
      | { kind: 'revocation'; input: UserIntentRevocationInput },
  ): ValidatedIntent {
    return {
      ...base,
      [validated]: true,
      ...branch,
    };
  }

  private async applyInTx(
    context: ValidatedIntent,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    if (context[validated] !== true || context.threadLock.tx !== context.tx)
      throw new Error('invalid user intent lock context');
    switch (context.kind) {
      case 'request':
        return this.applyRequestInTx(context, clientUpdates);
      case 'acceptance':
        return this.applyAcceptanceInTx(context, clientUpdates);
      case 'revocation':
        return this.applyRevocationInTx(context, clientUpdates);
    }
  }

  private async applyRequestInTx(
    context: Extract<ValidatedIntent, { kind: 'request' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const result = await context.tx.execute<{
      intentChanged: boolean;
      clientUpdates: Array<{ userId: number; feedId: number }>;
      peerFeedId: string | null;
    }>(userIntentRequestSql(context.input));
    await resetUserIntentThreadStateInTx(
      context.tx,
      context.threadId,
      context.actor,
      context.target,
      {
        activate: false,
        boundarySeq: context.authorization.threadCurSeq,
      },
    );
    return this.collectStateFeedWakeHints(context, result, clientUpdates);
  }

  private async applyAcceptanceInTx(
    context: Extract<ValidatedIntent, { kind: 'acceptance' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const result = await context.tx.execute<{
      intentChanged: boolean;
      reverseUpgraded: boolean;
      pairChanged: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      clientUpdates: Array<{ userId: number; feedId: number }>;
      peerFeedId: string | null;
    }>(userIntentAcceptanceSql(context.input));
    await resetUserIntentThreadStateInTx(
      context.tx,
      context.threadId,
      context.actor,
      context.target,
      {
        activate: result.rows[0]?.pairChanged === true,
        boundarySeq: context.authorization.threadCurSeq,
      },
    );
    // The remote source activates from its retained authored snapshot, inside
    // this transaction and under the lock already held (gap recovery included).
    if (context.target.namespaceId !== 0)
      await initializeRelationshipThreadStateInTx(
        context.tx,
        context.threadId,
        context.pairId,
        context.threadLock,
      );
    return this.collectStateFeedWakeHints(context, result, clientUpdates);
  }

  private async applyRevocationInTx(
    context: Extract<ValidatedIntent, { kind: 'revocation' }>,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const result = await context.tx.execute<{
      intentChanged: boolean;
      pairChanged: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      clientUpdates: Array<{ userId: number; feedId: number }>;
      peerFeedId: string | null;
    }>(userIntentRevocationSql(context.input));
    const peers = await this.collectStateFeedWakeHints(
      context,
      result,
      clientUpdates,
    );
    if (
      result.rows[0]?.pairChanged === true &&
      context.localTargetId !== null
    ) {
      const conclusion = await this.executeInTx(
        context.tx,
        {
          userId: context.localTargetId,
          decision: 'REVOKED',
          target: {
            account: context.actor.account,
            namespaceId: context.actor.namespaceId,
          },
        },
        clientUpdates,
      );
      if (isBusinessRejection(conclusion.outcome))
        throw new Error(
          `local revoke conclusion rejected: ${conclusion.outcome.reason}`,
        );
      for (const [domain, feedId] of conclusion.peers)
        peers.set(domain, feedId);
    }
    return peers;
  }

  /** Merge feed wakes, the thread-state hint capture (the retained thread
   * always exists here), and the peer target into the post-commit wake set. */
  private async collectStateFeedWakeHints(
    context: ValidatedIntent,
    result: {
      rows: Array<{
        clientUpdates: Array<{ userId: number; feedId: number }>;
        peerFeedId: string | null;
      }>;
    },
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const row = result.rows[0];
    if (!row) throw new Error('user intent update disappeared');
    for (const update of row.clientUpdates ?? [])
      clientUpdates.push({
        userId: update.userId,
        feedId: Number(update.feedId),
      });
    const ids = [context.localActorId, context.localTargetId].filter(
      (id): id is number => typeof id === 'number',
    );
    clientUpdates.push(
      ...(await captureThreadStateUpdatesInTx(context.tx, ids)),
    );
    const peers = new Map<number, bigint>();
    if (context.target.namespaceId !== 0 && row.peerFeedId !== null)
      peers.set(context.target.namespaceId, BigInt(row.peerFeedId));
    return peers;
  }
}

function feedInput(base: {
  pairId: bigint;
  threadId: number;
  actor: Endpoint;
  target: Endpoint;
  localActorId: number;
  localTargetId: number | null;
}) {
  const namespaceId = Math.max(base.actor.namespaceId, base.target.namespaceId);
  return {
    pairId: base.pairId,
    threadId: base.threadId,
    namespaceId,
    // The compaction keys follow the direction each key names, independent of
    // which canonical pair side the actor occupies.
    actorKey: userIntentCompactionKey(namespaceId, base.actor, base.target),
    targetKey: userIntentCompactionKey(namespaceId, base.target, base.actor),
    actorAccount: base.actor.account,
    actorNamespaceId: base.actor.namespaceId,
    targetAccount: base.target.account,
    targetNamespaceId: base.target.namespaceId,
    localActorId: base.localActorId,
    localTargetId: base.localTargetId,
  };
}
