import { lockExperimentalPairsInTx } from '../../shared/locks/pair-business-lock.js';
import { lockBusinessAccountsInTx } from '../../../relationship/business-scope-lock.js';
import {
  requireP2PThreadContentLockUnderPairInTx,
  type ThreadContentLock,
} from '../../../relationship/thread-content-lock.js';
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
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../../../common/business-code.js';
import { BusinessException } from '../../../common/business.exception.js';
import { normalizeAccount } from '../../../common/account.js';
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
import type { FederationNamespaceService } from '../../../federation/federation-namespace.service.js';
import { loadFederationConfig } from '../../../federation/federation.config.js';

const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One command family: a local user's authored intent about one P2P pair.
 * The target is addressed; the pair is minted when absent (REQUESTED only). */
export interface UserIntentCommand {
  userId: number;
  decision: 'ACCEPTED' | 'REVOKED' | 'REQUESTED';
  target: { account: string; domain: string };
  note?: string;
}

export interface UserIntentDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  peerFeed: PeerStateFeedService;
  federation: FederationService;
  namespaces: FederationNamespaceService;
}

type Endpoint = { account: string; domain: string; namespaceId: number };

const validated = Symbol('validated user intent decision');

interface LocatorRow extends Record<string, unknown> {
  actorAccount: string;
  pairId: string | null;
  pairThreadId: number | null;
  localTargetId: number | null;
}

/** The lock-and-locate product every branch validation starts from. */
type ValidatedIntentBase = Omit<
  ValidatedIntent,
  typeof validated | 'request' | 'acceptance' | 'revocation'
>;

/** Lexical capability, created only after locks and authorization. Mutable pair
 * state is not cached. */
interface ValidatedIntent {
  readonly [validated]: true;
  readonly tx: DatabaseTransaction;
  readonly threadLock: ThreadContentLock;
  readonly params: UserIntentCommand;
  readonly pairId: bigint;
  readonly threadId: number;
  readonly actorSide: 'A' | 'B';
  readonly reverseSide: 'A' | 'B';
  readonly actor: Endpoint;
  readonly target: Endpoint;
  readonly localActorId: number;
  readonly localTargetId: number | null;
  readonly authorization: UserIntentAuthorizationRow;
  readonly request?: UserIntentRequestInput;
  readonly acceptance?: UserIntentAcceptanceInput;
  readonly revocation?: UserIntentRevocationInput;
}

/** Opt-in experiment: deliberately absent from Nest modules and durable task
 * handlers. The public entry owns the transaction; internal updates consume its
 * validated lock capability. Lock order mirrors the group family: both endpoint
 * Account scopes, then the Pair scope, then pair/thread/intent/allocator rows. */
export class ExperimentalUserIntentService {
  private readonly logger = new Logger(ExperimentalUserIntentService.name);
  private readonly config = loadFederationConfig();

  constructor(private readonly deps: UserIntentDependencies) {}

  async handleUserIntent(params: UserIntentCommand): Promise<void> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.deps.database.db.transaction(async (tx) => {
      const context = await this.lockAndValidateInTx(tx, params);
      if (!context) return undefined;
      return this.applyInTx(context, clientUpdates);
    });
    if (!peers) return;
    try {
      if (clientUpdates.length > 0)
        this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn('experimental user intent client wake failed', error);
    }
    if (peers.size === 0) return;
    void this.deps.federation
      .pushStateFeedDomains(peers.keys())
      .catch((error: unknown) =>
        this.logger.warn('experimental user intent peer wake failed', error),
      );
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: UserIntentCommand,
  ): Promise<ValidatedIntent | undefined> {
    const targetAccount = normalizeAccount(params.target.account);
    const targetDomain = params.target.domain.trim().toLowerCase();
    // A remote target's active namespace is captured (and fails when the peer
    // is unreachable), matching the legacy command scope resolution.
    const targetNamespaceId =
      targetDomain === 'local'
        ? 0
        : (await this.deps.namespaces.captureActiveInTx(tx, targetDomain))
            .namespaceId;
    const located = await this.locateInTx(tx, {
      actorUserId: params.userId,
      targetAccount,
      targetDomain,
      targetNamespaceId,
    });
    if (!located)
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'authenticated user does not exist',
      );
    if (targetDomain === 'local' && targetAccount === located.actorAccount)
      throw new Error('relationship endpoints must be distinct');
    let pairId: bigint | null =
      located.pairId === null ? null : BigInt(located.pairId);
    // An absent pair cannot change under the caller, so rejecting before the
    // locks is authoritative — matching the group family's locator contract.
    if (!pairId && params.decision !== 'REQUESTED')
      throw new BusinessException(BusinessCode.NOT_FOUND, 'request not found');

    const actor: Endpoint = {
      account: located.actorAccount,
      domain: 'local',
      namespaceId: 0,
    };
    const target: Endpoint = {
      account: targetAccount,
      domain: targetDomain,
      namespaceId: targetNamespaceId,
    };
    // Both endpoint scopes, then the Pair scope — the established order, once each.
    await lockBusinessAccountsInTx(tx, [
      { account: actor.account, domain: 'local' },
      { account: target.account, domain: target.domain },
    ]);
    await lockExperimentalPairsInTx(tx, [
      {
        kind: 'P2P',
        addresses: [
          completeAddress(actor.account, 'local'),
          completeAddress(target.account, target.domain),
        ],
      },
    ]);

    if (!pairId) {
      // Mint the canonical pair when the target has none yet. Both endpoints
      // share the relationship namespace, exactly like the legacy canonical
      // key. The conflicting DO UPDATE always takes the row lock, so no
      // separate select follows.
      const [endpointA, endpointB] =
        compareEndpoints(actor, target) < 0
          ? [actor, target]
          : [target, actor];
      const minted = await tx.execute<{ id: string }>(sql`
        INSERT INTO "RelationshipPair"
          (kind, "endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
           "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId")
        VALUES ('P2P', 'USER', ${endpointA.account}, ${endpointA.domain}, ${targetNamespaceId},
          'USER', ${endpointB.account}, ${endpointB.domain}, ${targetNamespaceId})
        ON CONFLICT ("endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
          "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId")
        DO UPDATE SET "updatedAt" = CURRENT_TIMESTAMP
        RETURNING id
      `);
      pairId = BigInt(minted.rows[0]!.id);
    } else {
      const locked = await tx.execute<{ id: string; threadId: number | null }>(
        sql`SELECT id::text, "threadId" FROM "RelationshipPair" WHERE id = ${pairId} FOR NO KEY UPDATE`,
      );
      if (!locked.rows[0])
        throw new Error('relationship pair lock disappeared');
      located.pairThreadId = locked.rows[0].threadId;
    }
    const actorSide: 'A' | 'B' =
      compareEndpoints(actor, target) < 0 ? 'A' : 'B';
    const reverseSide: 'A' | 'B' = actorSide === 'A' ? 'B' : 'A';

    // The retained P2P shell: mint the thread when the pair has none, then
    // bind it. Legacy ensures the shell on every positive direction; the
    // revocation enters without it.
    const shell =
      params.decision === 'REVOKED'
        ? await this.requireExistingThreadInTx(located.pairThreadId)
        : await this.ensureThreadShellInTx(
            tx,
            pairId,
            located.pairThreadId,
            targetDomain === 'local' ? 0 : targetNamespaceId,
          );
    const threadLock = await requireP2PThreadContentLockUnderPairInTx(
      tx,
      pairId,
      shell,
    );
    await tx.execute(
      sql`SELECT id FROM "RelationshipIntent" WHERE "pairId" = ${pairId} ORDER BY "authorSide" FOR NO KEY UPDATE`,
    );
    // One post-lock authorization read; the participant reset below gates on it
    // so an already-active pair's no-op path leaves participant state alone.
    const row = (
      await tx.execute<UserIntentAuthorizationRow>(
        userIntentAuthorizationSql({
          pairId,
          actorUserId: params.userId,
          targetAccount,
          targetDomain,
          actorSide,
          reverseSide,
        }),
      )
    ).rows[0];
    if (!row) throw new Error('user intent authorization disappeared');
    if (params.decision === 'REVOKED')
      await this.lockThreadStateInTx(tx, shell, actor, target);
    else
      await this.resetThreadStateInTx(tx, shell, actor, target, {
        // Activation starts read at the boundary (the legacy read-window
        // initialization) and must not touch an already-active pair.
        activate: params.decision === 'ACCEPTED' && !row.pairActive,
      });
    // Account rows the composed statements allocate client feed ids from.
    const accountIds = [located.localTargetId, params.userId].filter(
      (id): id is number => typeof id === 'number',
    );
    await tx.execute(
      sql`SELECT id FROM "Account" WHERE id = ANY(${sql.param(accountIds)}::integer[]) ORDER BY id FOR NO KEY UPDATE`,
    );
    if (targetDomain !== 'local')
      await this.deps.peerFeed.lockTargetsInTx(tx, [
        { peerDomain: targetDomain, namespaceId: targetNamespaceId },
      ]);


    const base = {
      [validated]: true as const,
      tx,
      threadLock,
      params,
      pairId,
      threadId: shell,
      actorSide,
      reverseSide,
      actor,
      target,
      localActorId: params.userId,
      localTargetId: row.localTargetId,
      authorization: row,
    };
    if (params.decision === 'REQUESTED')
      return this.validateRequestInTx(base, row);
    if (params.decision === 'ACCEPTED')
      return this.validateAcceptanceInTx(base, row);
    return this.validateRevocationInTx(base, row);
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
    return (
      await tx.execute<LocatorRow>(userIntentLocatorSql(key))
    ).rows[0];
  }

  /** A revocation enters an existing relationship; its thread must exist. */
  private requireExistingThreadInTx(threadId: number | null): number {
    if (!threadId)
      throw new Error('P2P relationship has no retained thread');
    return threadId;
  }

  /** Mint the structurally complete, non-visible P2P shell when absent and
   * return its thread id. Mirrors ensureP2PThreadShellInTx's mint step; the
   * participant reset happens in resetThreadStateInTx. */
  private async ensureThreadShellInTx(
    tx: DatabaseTransaction,
    pairId: bigint,
    boundThreadId: number | null,
    authorityNamespaceId: number,
  ): Promise<number> {
    if (boundThreadId) return boundThreadId;
    const result = await tx.execute<{ threadId: number }>(sql`
      WITH fresh AS (
        INSERT INTO "MessageThread" (type, "authorityNamespaceId", "updatedAt")
        VALUES ('P2P'::"MessageThreadType", ${authorityNamespaceId}::integer, CURRENT_TIMESTAMP)
        RETURNING id
      ), bound AS (
        UPDATE "RelationshipPair" p SET "threadId" = f.id, "updatedAt" = CURRENT_TIMESTAMP
        FROM fresh f WHERE p.id = ${pairId}
        RETURNING p."threadId"
      )
      SELECT "threadId" FROM bound
    `);
    const threadId = result.rows[0]?.threadId;
    if (!threadId) throw new Error('P2P thread shell is missing');
    return threadId;
  }

  /** Positive directions reset the participant state (legacy shell upsert);
   * an activation additionally starts read at the boundary, like the legacy
   * read-window initialization. This lives in its own statement because the
   * participant trigger writes the same Account rows the composed statement's
   * feed allocation writes, and one statement may not touch that row twice.
   * The reused rows double as this command's participant locks. */
  private async resetThreadStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    actor: Endpoint,
    target: Endpoint,
    options: { activate: boolean },
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO "AccountThreadState" ("accountId", "threadId")
      SELECT a.id, ${threadId} FROM "Account" a
      WHERE a.domain = 'local' AND a."namespaceId" = 0
        AND ((a.account = ${actor.account})
          OR (a.account = ${target.account} AND ${target.domain} = 'local'))
      ON CONFLICT ("accountId", "threadId") DO UPDATE SET
        "messageVisibleThroughSeq" = NULL,
        "lastReadSeq" = CASE WHEN ${options.activate}
          THEN GREATEST("AccountThreadState"."lastReadSeq",
            LEAST((SELECT t."curSeq" FROM "MessageThread" t WHERE t.id = ${threadId}),
              COALESCE("AccountThreadState"."messageVisibleThroughSeq",
                (SELECT t."curSeq" FROM "MessageThread" t WHERE t.id = ${threadId}))))
          ELSE "AccountThreadState"."lastReadSeq" END,
        "unreadCount" = CASE WHEN ${options.activate} THEN 0
          ELSE "AccountThreadState"."unreadCount" END,
        "previewSeqs" = CASE WHEN ${options.activate} THEN '{}'::integer[]
          ELSE "AccountThreadState"."previewSeqs" END,
        "lastMentionSeq" = CASE WHEN ${options.activate} THEN NULL
          ELSE "AccountThreadState"."lastMentionSeq" END,
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "accountId"
    `);
  }

  private async lockThreadStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    actor: Endpoint,
    target: Endpoint,
  ): Promise<void> {
    await tx.execute(sql`
      SELECT s."accountId" FROM "AccountThreadState" s
      JOIN "Account" a ON a.id = s."accountId"
      WHERE s."threadId" = ${threadId} AND a.domain = 'local' AND a."namespaceId" = 0
        AND ((a.account = ${actor.account})
          OR (a.account = ${target.account} AND ${target.domain} = 'local'))
      ORDER BY s."accountId" FOR NO KEY UPDATE OF s
    `);
  }

  /** REQUESTED entry. `req + req/ack = ack`: a live reverse direction (their
   * pending request, or their ACCEPTED that our earlier revoke had withdrawn
   * from) collapses into the acceptance path with the authorization row
   * already in hand. Every other state receives a fresh or refreshed request. */
  private validateRequestInTx(
    base: ValidatedIntentBase,
    row: UserIntentAuthorizationRow,
  ): ValidatedIntent | undefined {
    if (reverseEffective(row)) return this.validateAcceptanceInTx(base, row);
    if (row.localTargetId === null && base.target.domain === 'local')
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'request target is missing',
      );
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + REQUEST_TTL_MS);
    return this.finalize(base, {
      request: {
        ...feedInput(base),
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
  ): ValidatedIntent | undefined {
    if (row.pairActive) return undefined;
    const live =
      (row.reverseStatus === 'REQUESTED' && reverseRequestUnexpired(row)) ||
      row.reverseStatus === 'ACCEPTED';
    if (!live)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'request not found');
    if (row.localTargetId === null && base.target.domain === 'local')
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'request target is missing',
      );
    return this.finalize(base, {
      acceptance: {
        ...feedInput(base),
        // An ACK entry carries no note; the crossed-request collapse keeps the
        // requester's note, exactly like the legacy confirm path.
        note: (
          base.params.decision === 'REQUESTED' ? (base.params.note ?? '') : ''
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
  ): ValidatedIntent | undefined {
    const ownLive =
      row.ownStatus === 'ACCEPTED' ||
      (row.ownStatus === 'REQUESTED' && ownRequestUnexpired(row));
    if (!(ownLive || reverseEffective(row) || row.pairActive))
      throw new BusinessException(BusinessCode.NOT_FOUND, 'request not found');
    return this.finalize(base, {
      revocation: {
        ...feedInput(base),
        pairTaskScopeKey: userPairTaskScopeKey(base.actor, base.target),
      },
    });
  }

  /** Shared branch epilogue: build the validated capability. The composed
   * statements read every remaining coordinate from locked rows. */
  private finalize(
    base: ValidatedIntentBase,
    branch: {
      request?: UserIntentRequestInput;
      acceptance?: UserIntentAcceptanceInput;
      revocation?: UserIntentRevocationInput;
    },
  ): ValidatedIntent {
    return {
      ...base,
      [validated]: true,
      ...(branch.request ? { request: branch.request } : {}),
      ...(branch.acceptance ? { acceptance: branch.acceptance } : {}),
      ...(branch.revocation ? { revocation: branch.revocation } : {}),
    } as ValidatedIntent;
  }

  private async applyInTx(
    context: ValidatedIntent,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    if (context[validated] !== true || context.threadLock.tx !== context.tx)
      throw new Error('invalid user intent lock context');
    if (context.acceptance)
      return this.applyAcceptanceInTx(context, clientUpdates);
    if (context.revocation)
      return this.applyRevocationInTx(context, clientUpdates);
    if (context.request)
      return this.applyRequestInTx(context, clientUpdates);
    throw new Error('invalid user intent branch');
  }

  private async applyRequestInTx(
    context: ValidatedIntent,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const result = await context.tx.execute<{
      requestId: string;
      intentChanged: boolean;
      clientUpdates: Array<{ userId: number; feedId: number }>;
      peerFeedId: string | null;
    }>(userIntentRequestSql(context.request!));
    return this.collectWakes(context, result, clientUpdates);
  }

  private async applyAcceptanceInTx(
    context: ValidatedIntent,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const result = await context.tx.execute<{
      requestId: string;
      intentChanged: boolean;
      reverseUpgraded: boolean;
      pairChanged: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      clientUpdates: Array<{ userId: number; feedId: number }>;
      peerFeedId: string | null;
    }>(userIntentAcceptanceSql(context.acceptance!));
    // The remote source activates from its retained authored snapshot, inside
    // this transaction and under the lock already held (gap recovery included).
    if (context.target.domain !== 'local')
      await initializeRelationshipThreadStateInTx(
        context.tx,
        context.threadId,
        context.pairId,
        context.threadLock,
      );
    return this.collectWakes(context, result, clientUpdates);
  }

  private async applyRevocationInTx(
    context: ValidatedIntent,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const result = await context.tx.execute<{
      requestId: string;
      intentChanged: boolean;
      pairChanged: boolean;
      audienceChanged: boolean;
      systemMessageSeq: number | null;
      clientUpdates: Array<{ userId: number; feedId: number }>;
      peerFeedId: string | null;
    }>(userIntentRevocationSql(context.revocation!));
    return this.collectWakes(context, result, clientUpdates);
  }

  /** Merge feed wakes, the thread-state hint capture (the retained thread
   * always exists here), and the peer target into the post-commit wake set. */
  private async collectWakes(
    context: ValidatedIntent,
    result: {
      rows: Array<{
        clientUpdates: Array<{ userId: number; feedId: number }>;
        peerFeedId: string | null;
      }>;
    },
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
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
    const peers = new Map<string, bigint>();
    if (context.target.domain !== 'local' && row.peerFeedId !== null)
      peers.set(context.target.domain, BigInt(row.peerFeedId));
    return peers;
  }
}

function feedInput(base: {
  pairId: bigint;
  threadId: number;
  actor: Endpoint;
  target: Endpoint;
  actorSide: 'A' | 'B';
  localActorId: number;
  localTargetId: number | null;
}) {
  const namespaceId = Math.max(base.actor.namespaceId, base.target.namespaceId);
  return {
    pairId: base.pairId,
    threadId: base.threadId,
    namespaceId,
    localDomain: base.actor.domain,
    keyA: compactionKey(namespaceId, base.actor, base.target),
    keyB: compactionKey(namespaceId, base.target, base.actor),
    actorSide: base.actorSide,
    reverseSide: (base.actorSide === 'A' ? 'B' : 'A') as 'A' | 'B',
    actorAccount: base.actor.account,
    targetAccount: base.target.account,
    targetDomain: base.target.domain,
    targetNamespaceId: base.target.namespaceId,
    localActorId: base.localActorId,
    localTargetId: base.localTargetId,
  };
}

/** ClientStateFeedService.compactionKey's exact shape. */
function compactionKey(
  namespaceId: number,
  account: Endpoint,
  subject: Endpoint,
): string {
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    namespaceId,
    account.account,
    account.domain,
    subject.account,
    subject.domain,
  ]);
}

/** DurableTask USER_PAIR scope key: both complete addresses, domain-sorted. */
function userPairTaskScopeKey(actor: Endpoint, target: Endpoint): string {
  const ordered = [
    { domain: actor.domain, account: actor.account },
    { domain: target.domain, account: target.account },
  ].sort(
    (left, right) =>
      left.domain.localeCompare(right.domain) ||
      left.account.localeCompare(right.account),
  );
  return JSON.stringify([
    'task-scope',
    'USER_PAIR',
    ...ordered.map((endpoint) => [endpoint.domain, endpoint.account]),
  ]);
}

function reverseRequestUnexpired(row: UserIntentAuthorizationRow): boolean {
  return (
    row.reverseExpiresAt !== null &&
    new Date(row.reverseExpiresAt).getTime() > Date.now()
  );
}

function ownRequestUnexpired(row: UserIntentAuthorizationRow): boolean {
  return (
    row.ownExpiresAt !== null &&
    new Date(row.ownExpiresAt).getTime() > Date.now()
  );
}

function reverseEffective(row: UserIntentAuthorizationRow): boolean {
  return (
    row.reverseStatus === 'ACCEPTED' ||
    (row.reverseStatus === 'REQUESTED' && reverseRequestUnexpired(row))
  );
}

function compareEndpoints(left: Endpoint, right: Endpoint): number {
  return (
    left.domain.localeCompare(right.domain) ||
    left.account.localeCompare(right.account) ||
    left.namespaceId - right.namespaceId
  );
}

function completeAddress(account: string, domain: string): string {
  return `${account}@${domain}`.toLowerCase();
}
