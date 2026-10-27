import type { RequestSnapshot } from '../../../../shared/request-snapshot.js';
import { validateRequestDecisionInTx } from '../../../relationship/request/validate-request-decision-in-tx.js';
import type { RequestTransactionCapability } from '../../../relationship/request/request-transaction.contract.js';
import { lockRelationshipPairsInTx } from '../../../common/locks/relationship-pair-business-lock.js';
import { completeBusinessAddress } from '../../../common/locks/business-address.js';
import { lockBusinessAccountsInTx } from '../../../common/locks/account-business-lock.js';
import {
  requireP2PThreadContentLockUnderPairInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import {
  pairAuthorizationSql,
  directedIntentSql,
  userIntentLocatorSql,
  type PairAuthorizationRow,
  type DirectedIntentRow,
} from './user-intent-authorization-sql.js';
import {
  activePeerByThreadSql,
  type ActivePeerByThreadRow,
} from './user-intent-thread-end-sql.js';
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
  type UserIntentEndpoint,
} from '../shared/user-intent-state-sql.js';
import { Logger } from '@nestjs/common';
import { MeasureBusinessOperation } from '../../../diagnostics/execution-measurement.js';
import { and, eq, sql } from 'drizzle-orm';
import {
  account,
  relationshipIntent,
  relationshipRequest,
} from '../../../database/schema.js';
import type {
  RequestDecision,
  RequestDecisionResult,
} from '../../../../shared/relationship-request.js';
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
  requestDecision?: { requestId: bigint; decision: RequestDecision };
  /** Thread-keyed friendship removal must still address the same active
   * relationship after business locks, never a replacement pending round. */
  establishedRelationship?: { threadId: number; epoch: number };
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
  | { status: 'STALE_REQUEST' | 'EXPIRED' }
  | BusinessRejection;

export interface UserIntentTransactionOutcome {
  outcome: UserIntentOutcome;
  peers: Map<number, bigint>;
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

interface InvalidRequestDecision {
  requestDecisionStatus: 'STALE_REQUEST' | 'EXPIRED';
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
  readonly authorization: PairAuthorizationRow;
  readonly validationTime: number;
}

type ValidatedIntent = ValidatedIntentBase &
  (
    | { readonly kind: 'request'; readonly input: UserIntentRequestInput }
    | {
        readonly kind: 'acceptance';
        readonly reverseRequestId: bigint | null;
        readonly input: UserIntentAcceptanceInput;
      }
    | {
        readonly kind: 'revocation';
        readonly input: UserIntentRevocationInput;
        readonly action: 'WITHDRAW' | 'REJECT' | 'END_FRIENDSHIP';
        readonly targetRequestId: bigint | null;
      }
  );

/** The public entry owns the transaction; internal updates consume its
 * validated lock capability. It locks the local actor's Account state, then the
 * Pair, then thread/intent/allocator rows. The target's relationship-derived
 * state belongs to the Pair scope, not to the target's Account State scope. */
export class UserIntentService {
  private readonly logger = new Logger(UserIntentService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly clientFeed: ClientStateFeedService,
    private readonly peerFeed: PeerStateFeedService,
    private readonly federation: FederationStateFeedPusher,
    private readonly namespaces: FederationNamespaceService,
    private readonly requestCapability: RequestTransactionCapability,
  ) {}

  async decidePersonalRequest(
    userId: number,
    requestId: string,
    decision: RequestDecision,
  ): Promise<RequestDecisionResult> {
    const id = BigInt(requestId);
    // This read locates the pair only. Admission is revalidated under its lock.
    const [round] = await this.database.db
      .select()
      .from(relationshipRequest)
      .where(
        and(
          eq(relationshipRequest.id, id),
          eq(relationshipRequest.kind, 'FRIEND'),
        ),
      );
    const [user] = await this.database.db
      .select({ account: account.account })
      .from(account)
      .where(eq(account.id, userId));
    if (!round || !user) return { status: 'STALE_REQUEST' };
    const withdrawing = decision === 'WITHDRAW';
    const ownerAccount = withdrawing
      ? round.authorAccount
      : round.receiverAccount;
    const ownerNamespaceId = withdrawing
      ? round.authorNamespaceId
      : round.receiverNamespaceId;
    if (ownerAccount !== user.account || ownerNamespaceId !== 0)
      return { status: 'STALE_REQUEST' };
    const outcome = await this.execute(
      {
        userId,
        target: withdrawing
          ? {
              account: round.receiverAccount,
              namespaceId: round.receiverNamespaceId,
            }
          : {
              account: round.authorAccount,
              namespaceId: round.authorNamespaceId,
            },
        decision: decision === 'ACCEPT' ? 'ACCEPTED' : 'REVOKED',
      },
      { requestDecision: { requestId: id, decision } },
    );
    if (outcome.status === 'STALE_REQUEST' || outcome.status === 'EXPIRED')
      return { status: outcome.status };
    if (isBusinessRejection(outcome))
      throw new BusinessException(outcome.code, outcome.message);
    return {
      status: 'OK',
      threadId: 'threadId' in outcome ? (outcome.threadId ?? null) : null,
    };
  }

  @MeasureBusinessOperation('relationship.user-intent')
  async execute(
    params: UserIntentCommand,
    options?: UserIntentOptions,
  ): Promise<UserIntentOutcome> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const applied = await this.database.db.transaction((tx) =>
      this.executeInTx(tx, params, clientUpdates, options),
    );
    this.publishIntentEffects(applied, clientUpdates);
    return applied.outcome;
  }

  /** Thread-keyed entry that ends an established P2P relationship, symmetric
   * to group leave. The pair row resolves the peer endpoint; only an active
   * pair is terminable here, so a pending request round can never be decided
   * through a thread or an address on this path. Ending the friendship never
   * rewrites request history. */
  @MeasureBusinessOperation('relationship.user-intent')
  async endEstablishedRelationship(params: {
    userId: number;
    threadId: number;
  }): Promise<UserIntentOutcome> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const applied = await this.database.db.transaction(async (tx) => {
      const row = (
        await tx.execute<ActivePeerByThreadRow>(
          activePeerByThreadSql(params.userId, params.threadId),
        )
      ).rows[0];
      const selfIsEndpoint =
        row !== undefined &&
        ((row.endpointANamespaceId === 0 &&
          row.endpointAAccount === row.actorAccount) ||
          (row.endpointBNamespaceId === 0 &&
            row.endpointBAccount === row.actorAccount));
      if (!selfIsEndpoint || !row.pairActive)
        return {
          outcome: this.reject(
            'INTENT_NOT_FOUND',
            BusinessCode.NOT_FOUND,
            `active relationship for thread [${params.threadId}] does not exist`,
          ).rejected,
          peers: new Map<number, bigint>(),
        } satisfies UserIntentTransactionOutcome;
      const target =
        row.endpointANamespaceId === 0 &&
        row.endpointAAccount === row.actorAccount
          ? {
              account: row.endpointBAccount,
              namespaceId: row.endpointBNamespaceId,
            }
          : {
              account: row.endpointAAccount,
              namespaceId: row.endpointANamespaceId,
            };
      return this.executeInTx(
        tx,
        { userId: params.userId, decision: 'REVOKED', target },
        clientUpdates,
        {
          establishedRelationship: {
            threadId: params.threadId,
            epoch: row.authorizationEpoch,
          },
        },
      );
    });
    this.publishIntentEffects(applied, clientUpdates);
    return applied.outcome;
  }

  /** Post-commit wake epilogue shared by every public entry. */
  private publishIntentEffects(
    applied: UserIntentTransactionOutcome,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): void {
    if (applied.peers.size > 0 || clientUpdates.length > 0) {
      try {
        if (clientUpdates.length > 0)
          this.clientFeed.notifyFeedUpdates(clientUpdates);
      } catch (error) {
        this.logger.warn('user intent client wake failed', error);
      }
      if (applied.peers.size > 0)
        void this.federation.pushStateFeedNamespaces(applied.peers.keys());
    }
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
    if ('requestDecisionStatus' in context)
      return {
        outcome: { status: context.requestDecisionStatus },
        peers: new Map(),
      };
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
    | ValidatedIntent
    | NoOpIntent
    | RejectedIntent
    | StaleAuthorization
    | InvalidRequestDecision
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
      effectiveDomain = await this.namespaces.localDomainInTx(tx);
    } else {
      try {
        const row = await this.namespaces.captureActiveByIdInTx(
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

    const row = (
      await tx.execute<PairAuthorizationRow>(
        pairAuthorizationSql({
          pairId,
          actorUserId: params.userId,
          targetAccount,
          targetDomain: effectiveDomain,
          targetNamespaceId: target.namespaceId,
        }),
      )
    ).rows[0];
    if (!row) throw new Error('user intent authorization disappeared');
    const established = options?.establishedRelationship;
    if (
      established &&
      (params.decision !== 'REVOKED' ||
        !row.pairActive ||
        row.threadId !== established.threadId ||
        row.authorizationEpoch !== established.epoch)
    )
      return this.reject(
        'INTENT_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'established relationship changed before revocation',
      );
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

    const exact = options?.requestDecision;
    if (exact) {
      const withdrawing = exact.decision === 'WITHDRAW';
      const author = withdrawing ? actor : target;
      const receiver = withdrawing ? target : actor;
      const gate = await validateRequestDecisionInTx(tx, {
        flow: { kind: 'FRIEND', author, receiver },
        requestId: exact.requestId,
        pairActive: row.pairActive,
        asOf: new Date(base.validationTime),
      });
      if (gate) return { requestDecisionStatus: gate.status };
    }

    const context =
      params.decision === 'REQUESTED'
        ? await this.validateRequestInTx(base)
        : params.decision === 'ACCEPTED'
          ? await this.validateAcceptanceInTx(base)
          : exact
            ? this.finalize(base, {
                kind: 'revocation',
                action: exact.decision === 'WITHDRAW' ? 'WITHDRAW' : 'REJECT',
                targetRequestId: exact.requestId,
                input: { ...feedInput(base) },
              })
            : await this.validateRevocationInTx(base);
    if ('noOp' in context || 'rejected' in context) return context;
    // Peer feed allocators precede every operation that may allocate from a
    // local Account state-feed counter, including AccountThreadState triggers.
    if (target.namespaceId !== 0)
      await this.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
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
  private async validateRequestInTx(
    base: ValidatedIntentBase,
  ): Promise<ValidatedIntent | NoOpIntent | RejectedIntent> {
    if (base.params.decision !== 'REQUESTED')
      throw new Error('request command required');
    if (
      base.authorization.localTargetId === null &&
      base.target.namespaceId === 0
    )
      return this.reject(
        'TARGET_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'request target is missing',
      );
    // An active pair satisfies the command: no new round, no refresh.
    if (base.authorization.pairActive)
      return { noOp: true, threadId: base.threadId };

    const [reverse] = (
      await base.tx.execute<DirectedIntentRow>(
        directedIntentSql({
          authorAccount: base.target.account,
          authorNamespaceId: base.target.namespaceId,
          receiverAccount: base.actor.account,
          receiverNamespaceId: base.actor.namespaceId,
        }),
      )
    ).rows;

    // `req + req/ack = ack`: a live reverse pending request, or their ACCEPTED
    // that our earlier revoke withdrew from (the peer has not yet ingested the
    // departure), both collapse into the acceptance path so the pair
    // re-establishes synchronously on the re-adding side.
    const reverseEffective =
      reverse?.status === 'ACCEPTED' ||
      (reverse?.status === 'REQUESTED' &&
        reverse.expiresAt !== null &&
        new Date(reverse.expiresAt).getTime() > base.validationTime);

    if (reverseEffective) {
      return this.finalize(base, {
        kind: 'acceptance',
        reverseRequestId: reverse.requestId ? BigInt(reverse.requestId) : null,
        input: {
          ...feedInput(base),
          note: (base.params.decision === 'REQUESTED'
            ? (base.params.note ?? '')
            : ''
          ).slice(0, 255),
          acceptedAt: new Date(),
        },
      });
    }

    const statusChangedAt = new Date();
    const expiresAt = new Date(
      statusChangedAt.getTime() + RELATIONSHIP_INTENT_REQUEST_TTL_MS,
    );
    return this.finalize(base, {
      kind: 'request',
      input: {
        ...feedInput(base),
        snapshot: base.params.snapshot,
        note: (base.params.note ?? '').slice(0, 255),
        statusChangedAt,
        expiresAt,
      },
    });
  }

  private async validateAcceptanceInTx(
    base: ValidatedIntentBase,
  ): Promise<ValidatedIntent | NoOpIntent | RejectedIntent> {
    if (base.authorization.pairActive)
      return { noOp: true, threadId: base.threadId };
    if (
      base.authorization.localTargetId === null &&
      base.target.namespaceId === 0
    )
      return this.reject(
        'TARGET_NOT_FOUND',
        BusinessCode.NOT_FOUND,
        'request target is missing',
      );

    const [reverse] = (
      await base.tx.execute<DirectedIntentRow>(
        directedIntentSql({
          authorAccount: base.target.account,
          authorNamespaceId: base.target.namespaceId,
          receiverAccount: base.actor.account,
          receiverNamespaceId: base.actor.namespaceId,
        }),
      )
    ).rows;

    const live =
      reverse?.status === 'REQUESTED' &&
      reverse.expiresAt !== null &&
      new Date(reverse.expiresAt).getTime() > base.validationTime;

    if (!live)
      return this.reject(
        reverse?.status === 'REQUESTED' ? 'INTENT_EXPIRED' : 'INTENT_NOT_FOUND',
        reverse?.status === 'REQUESTED'
          ? BusinessCode.INVITE_EXPIRED
          : BusinessCode.NOT_FOUND,
        reverse?.status === 'REQUESTED'
          ? 'request has expired'
          : 'request not found',
      );

    return this.finalize(base, {
      kind: 'acceptance',
      reverseRequestId: reverse.requestId ? BigInt(reverse.requestId) : null,
      input: {
        ...feedInput(base),
        note: '',
        acceptedAt: new Date(),
      },
    });
  }

  private async validateRevocationInTx(
    base: ValidatedIntentBase,
  ): Promise<ValidatedIntent | RejectedIntent> {
    const ownDirection = (
      await base.tx.execute<DirectedIntentRow>(
        directedIntentSql({
          authorAccount: base.actor.account,
          authorNamespaceId: base.actor.namespaceId,
          receiverAccount: base.target.account,
          receiverNamespaceId: base.target.namespaceId,
        }),
      )
    ).rows[0];

    // BUG-1 convergence: an own ACCEPTED direction is concluded even when the
    // pair is already down — typically inside the received-consumer
    // transaction, where the peer's revocation deactivated the pair before
    // our own conclusion is authored. The composed statement gates every
    // departure effect on the pair transition, so this path only flips the
    // direction and echoes the conclusion; a dangling live acceptance must
    // never survive the peer's departure.
    if (base.authorization.pairActive || ownDirection?.status === 'ACCEPTED') {
      return this.finalize(base, {
        kind: 'revocation',
        action: 'END_FRIENDSHIP',
        targetRequestId: null,
        input: {
          ...feedInput(base),
        },
      });
    }

    const own = ownDirection;

    const ownLive =
      own?.status === 'REQUESTED' &&
      own.expiresAt !== null &&
      new Date(own.expiresAt).getTime() > base.validationTime;

    if (ownLive) {
      return this.finalize(base, {
        kind: 'revocation',
        action: 'WITHDRAW',
        targetRequestId: own.requestId ? BigInt(own.requestId) : null,
        input: {
          ...feedInput(base),
        },
      });
    }

    const [reverse] = (
      await base.tx.execute<DirectedIntentRow>(
        directedIntentSql({
          authorAccount: base.target.account,
          authorNamespaceId: base.target.namespaceId,
          receiverAccount: base.actor.account,
          receiverNamespaceId: base.actor.namespaceId,
        }),
      )
    ).rows;

    const reverseLive =
      reverse?.status === 'REQUESTED' &&
      reverse.expiresAt !== null &&
      new Date(reverse.expiresAt).getTime() > base.validationTime;

    if (reverseLive) {
      return this.finalize(base, {
        kind: 'revocation',
        action: 'REJECT',
        targetRequestId: reverse.requestId ? BigInt(reverse.requestId) : null,
        input: {
          ...feedInput(base),
        },
      });
    }

    return this.reject(
      own?.status === 'REQUESTED' || reverse?.status === 'REQUESTED'
        ? 'INTENT_EXPIRED'
        : 'INTENT_NOT_FOUND',
      own?.status === 'REQUESTED' || reverse?.status === 'REQUESTED'
        ? BusinessCode.INVITE_EXPIRED
        : BusinessCode.NOT_FOUND,
      own?.status === 'REQUESTED' || reverse?.status === 'REQUESTED'
        ? 'request has expired'
        : 'request not found',
    );
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
      | {
          kind: 'acceptance';
          reverseRequestId: bigint | null;
          input: UserIntentAcceptanceInput;
        }
      | {
          kind: 'revocation';
          input: UserIntentRevocationInput;
          action: 'WITHDRAW' | 'REJECT' | 'END_FRIENDSHIP';
          targetRequestId: bigint | null;
        },
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
    const openResult = await this.requestCapability.openRequestInTx(
      context.tx,
      {
        flow: {
          kind: 'FRIEND',
          author: {
            account: context.actor.account,
            namespaceId: context.actor.namespaceId,
          },
          receiver: {
            account: context.target.account,
            namespaceId: context.target.namespaceId,
          },
        },
        evidence: {
          authorProfileNamespaceId: 0,
          authorProfileRev: context.authorization.actorProfileRev,
          note: context.input.note,
          requestedAt: context.input.statusChangedAt,
          expiresAt: context.input.expiresAt,
          snapshot: context.input.snapshot,
        },
      },
    );
    if (openResult.status !== 'STALE_REQUEST') {
      clientUpdates.push(...openResult.effects.clientUpdates);
    }

    const result = await context.tx.execute<{
      intentChanged: boolean;
      peerFeedId: string | null;
    }>(
      userIntentRequestSql({
        ...context.input,
        requestId:
          openResult.status !== 'STALE_REQUEST' ? openResult.round.id : null,
      }),
    );
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
    if (context.reverseRequestId !== null) {
      await this.requestCapability.concludeRequestInTx(context.tx, {
        flow: {
          kind: 'FRIEND',
          author: {
            account: context.target.account,
            namespaceId: context.target.namespaceId,
          },
          receiver: {
            account: context.actor.account,
            namespaceId: context.actor.namespaceId,
          },
        },
        requestId: context.reverseRequestId,
        cause: 'ACCEPT',
      });
    }

    const result = await context.tx.execute<{
      intentChanged: boolean;
      reverseUpgraded: boolean;
      pairChanged: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
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
    if (context.action === 'WITHDRAW' && context.targetRequestId !== null) {
      await this.requestCapability.concludeRequestInTx(context.tx, {
        flow: {
          kind: 'FRIEND',
          author: {
            account: context.actor.account,
            namespaceId: context.actor.namespaceId,
          },
          receiver: {
            account: context.target.account,
            namespaceId: context.target.namespaceId,
          },
        },
        requestId: context.targetRequestId,
        cause: 'WITHDRAW',
      });
    } else if (
      context.action === 'REJECT' &&
      context.targetRequestId !== null
    ) {
      await this.requestCapability.concludeRequestInTx(context.tx, {
        flow: {
          kind: 'FRIEND',
          author: {
            account: context.target.account,
            namespaceId: context.target.namespaceId,
          },
          receiver: {
            account: context.actor.account,
            namespaceId: context.actor.namespaceId,
          },
        },
        requestId: context.targetRequestId,
        cause: 'REJECT',
      });
      if (context.localTargetId !== null) {
        await context.tx.execute(
          authoredIntentWriteSql({
            author: {
              account: context.target.account,
              namespaceId: context.target.namespaceId,
            },
            receiver: {
              account: context.actor.account,
              namespaceId: context.actor.namespaceId,
            },
            threadId: context.threadId,
            status: 'REVOKED',
            note: '',
            statusChangedAt: new Date(),
            expiresAt: null,
          }),
        );
      }
    }

    const result = await context.tx.execute<{
      intentChanged: boolean;
      pairChanged: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
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
      await context.tx.execute(
        authoredIntentWriteSql({
          author: {
            account: context.target.account,
            namespaceId: context.target.namespaceId,
          },
          receiver: {
            account: context.actor.account,
            namespaceId: context.actor.namespaceId,
          },
          threadId: context.threadId,
          status: 'REVOKED',
          note: '',
          statusChangedAt: new Date(),
          expiresAt: null,
        }),
      );
    }
    return peers;
  }

  /** Merge feed wakes, the thread-state hint capture (the retained thread
   * always exists here), and the peer target into the post-commit wake set. */
  private async collectStateFeedWakeHints(
    context: ValidatedIntent,
    result: {
      rows: Array<{
        peerFeedId: string | null;
      }>;
    },
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<number, bigint>> {
    const row = result.rows[0];
    if (!row) throw new Error('user intent update disappeared');
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
    actorAccount: base.actor.account,
    actorNamespaceId: base.actor.namespaceId,
    targetAccount: base.target.account,
    targetNamespaceId: base.target.namespaceId,
    localActorId: base.localActorId,
    localTargetId: base.localTargetId,
  };
}
