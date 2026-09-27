import type { FederationLocalSystemMessage } from './federation-local-system-message-publisher.service.js';
import {
  groupState as groupStateTable,
  readGroupState,
  groupStateFields,
} from '../group/shared/group-state.js';
import { toClientIdentity } from '../common/client-identity.js';
import { localAccountsForTargetsInTx } from '../user/account-address.js';
import {
  forwardRef,
  Injectable,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { normalizeAccount, isValidAccount } from '../common/account.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { MessageThreadType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { UploadService } from '../upload/upload.service.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import {
  ForwardBundleService,
  type ForwardWireBundle,
  type InboundForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { loadFederationConfig } from './federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import type { MediaStatus } from '../common/media-status.js';
import { QuotaService } from '../quota/quota.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { RelationshipService } from '../relationship/relationship.service.js';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import { type OutboundCallFrameParams } from './federation-call-delivery.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';

export {
  FederationMessageContextError,
  S2sResponseError,
} from './federation-errors.js';

export type {
  S2SCallFrame,
  S2SCallOperation,
} from '../calls/federated-call-protocol.js';
export type { S2SAddress } from './federation-address.js';
export type { S2SProfile } from './federation-profile.js';
import {
  type FederationMessageFeedMessage,
  type FederationMessageQueryPage,
  type FederationThreadAddress,
} from './federation-message-feed.service.js';
import { type FederationMessageTombstoneQueryPage } from './federation-message-tombstone-feed.service.js';
import {
  PeerStateFeedService,
  type PeerStateFeedPage,
} from './peer-state-feed.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { RelationshipIntentService } from '../relationship/relationship-intent.service.js';
import { GroupRelationshipFoldService } from '../group/membership-intent/shared/group-relationship-fold.service.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';
import { GroupRelationshipMutationService } from '../group/membership-intent/shared/group-relationship-mutation.service.js';
import { type FederationContext } from './federation-namespace.service.js';
import type { S2SAddress } from './federation-address.js';
import { FederationUserDirectoryService } from './federation-user-directory.service.js';
import { FederationCallBridgeService } from './federation-call-bridge.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { type FederationThreadResourceResponse } from './federation-thread-resource-client.service.js';
import { FederationProfileService } from './federation-profile.service.js';
import type { S2SProfile } from './federation-profile.js';
import { FederationMediaLocalizationService } from './federation-media-localization.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';
import {
  FederationInboundMessagePageService,
  type FederationMessagePageApplyOptions as MessageQueryApplyOptions,
  type FederationMessagePageEffect as MissedPageEffect,
} from './federation-inbound-message-page.service.js';
import { FederationLocalSystemMessagePublisher } from './federation-local-system-message-publisher.service.js';
import { FederationStatePullService } from './federation-state-pull.service.js';
import { FederationPeerResourceService } from './federation-peer-resource.service.js';
import { FederationInboundMessageCommitService } from './federation-inbound-message-commit.service.js';
import { ProfileEvidenceProjectionService } from '../profile-resolution/profile-evidence-projection.service.js';
import { ProfileResolutionCoordinatorService } from '../profile-resolution/profile-resolution-coordinator.service.js';
import { FederationThreadQueryDenialService } from './federation-thread-query-denial.service.js';
import {
  lockBusinessAccountsInTx,
  type BusinessScopeAddress,
} from '../common/locks/account-business-lock.js';

/** Preserve the relationship author's side in the client-feed compaction key. */
export function clientGroupIntentEndpoints(
  groupAccount: string,
  memberAccount: string,
  author: 'GROUP' | 'MEMBER',
): { account: string; subjectAccount: string } {
  return author === 'GROUP'
    ? { account: groupAccount, subjectAccount: memberAccount }
    : { account: memberAccount, subjectAccount: groupAccount };
}

export type PeerResponseToken = FederationContext;

/**
 * Outbound S2S: SYNCHRONOUS inline delivery. Each send* method builds a payload, signs it
 * (SignatureService), and POSTs it to the peer's friend-op endpoint (DiscoveryService resolves the
 * base URL), all inline within the caller's request. No outbox/worker — Step 1 friend-flow is low-volume
 * and the friendship ops are idempotent, so a peer that's momentarily down just fails the action and the
 * user retries (the compacted state key plus feed ordering makes retries safe). Step 2 messages do NOT
 * add an outbox either — they use coalesced-notify + active pull.
 *
 * Transaction note: the DB state change (e.g. Friendship PENDING) commits in its own tx BEFORE the
 * send — an HTTP POST can't live inside a DB tx. If the POST fails, local state is committed but the
 * peer isn't notified; the user retries and the idempotent re-send succeeds once the peer is back.
 * That temporary, self-healing inconsistency is the cost of sync; acceptable for Step 1's idempotent
 * friend ops.
 *
 * Identity model: local users have domain="local"; federated peers are foreign User stubs
 * (domain=<peer>, unusable random hashPwd). Federation addresses always
 * use the REAL config.domain for local users' wire addresses ({ account: <account>, domain: <config.domain> }), never "local".
 *
 * Avatar localization: foreign stubs carry the peer's avatar/name/bio/remoteUpdatedAt, localized from
 * the profile embedded in the friend-request payload (and refreshed via fetchRemoteAccount on
 * approve + the chat-open staleness probe). Deletion is LOCAL-ONLY — unfriending never fans out an S2S
 * notification; the peer discovers the severed edge lazily, via a rejection-on-send in Step 2.
 */
@Injectable()
export class FederationService {
  private readonly config = loadFederationConfig();
  private readonly logger = new Logger(FederationService.name);
  /** Receiver-side debounce window: a group thread pulled within this skips a redundant whole-thread GET. */
  private static readonly GROUP_PULL_DEBOUNCE_MS = 500;
  /** Per-group-thread last pull timestamp (the receiver debounce on pullGroupWhole). */
  private readonly recentGroupPulls = new Map<number, number>();
  constructor(
    private readonly database: DatabaseService,
    private readonly peerLifecycle: FederationPeerLifecycle,
    private readonly mediaRangeClient: FederationMediaRangeClient,
    private readonly inboundMediaBatches: FederationInboundMediaBatchService,
    private readonly users: FederationUserDirectoryService,
    private readonly callBridge: FederationCallBridgeService,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly profiles: FederationProfileService,
    private readonly mediaLocalization: FederationMediaLocalizationService,
    private readonly inboundMessageRoutes: FederationInboundMessageRouteService,
    private readonly inboundMessageValidator: FederationInboundMessageValidatorService,
    private readonly inboundMessagePages: FederationInboundMessagePageService,
    private readonly statePull: FederationStatePullService,
    private readonly localSystemMessages: FederationLocalSystemMessagePublisher,
    private readonly peerResources: FederationPeerResourceService,
    private readonly inboundMessageCommits: FederationInboundMessageCommitService,
    private readonly threadQueryDenials: FederationThreadQueryDenialService,
    private readonly upload: UploadService,
    private readonly participantService: AccountThreadStateService,
    @Inject(forwardRef(() => RelationshipService))
    private readonly relationships: RelationshipService,
    private readonly quota: QuotaService,
    private readonly linkPreview: LinkPreviewService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupRelationships: GroupRelationshipFoldService,
    private readonly relationshipMutations: GroupRelationshipMutationService,
    @Optional()
    private readonly profileResolutions?: ProfileResolutionCoordinatorService,
    @Optional()
    private readonly profileEvidenceProjections?: ProfileEvidenceProjectionService,
  ) {}

  /** The wire address of a LOCAL user: { account, domain } (domain = our real config.domain). */
  localAddress(account: string): S2SAddress {
    return { account: account, domain: this.config.domain };
  }

  /** This server's domain (config.domain) — for address-domain comparison in controllers. */
  get ourDomain(): string {
    return this.config.domain;
  }

  /** Find a LOCAL user id by account (domain="local"). Null if not found / not local / soft-deleted.
   *  The isDeleted gate matters here because S2S bypasses the token system: the local /uploads/* path is
   *  protected from admin-disabled users by session-token revocation (invalidateAllSessions revokes every
   *  SessionToken row on disable), but
   *  /media/:digest never touches client tokens — so a disabled user's media would still flow out over federation
   *  unless we reject the soft-deleted row here. */
  async findLocalUserId(account: string): Promise<number | null> {
    return this.users.findLocalUserId(account);
  }

  /** Look up a local user id from a full address (must be account@<our domain>). */
  async findLocalUserIdByAddress(address: S2SAddress): Promise<number | null> {
    return this.users.findLocalUserIdByAddress(address);
  }

  async pushStateFeedDomains(domains: Iterable<string>): Promise<void> {
    for (const peerDomain of new Set(domains))
      this.eventEmitter.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
  }

  async handleThreadQueryForbidden(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    expectedAuthorizationEpoch: number,
  ) {
    return this.threadQueryDenials.handleThreadQueryForbidden(
      threadId,
      peerDomain,
      namespaceId,
      expectedAuthorizationEpoch,
    );
  }

  /** Materialize expired directions authored by this server as durable revocations. The expiry
   * boundary itself remains authoritative; this sweep only makes the already-effective negative
   * state explicit so clients and peers converge without retaining stale REQUESTED snapshots. */
  async revokeExpiredLocalRequests(): Promise<number> {
    const pendingClientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const expired = await tx.execute<{
        pairId: string;
        authorSide: 'A' | 'B';
        kind: 'P2P' | 'GROUP_MEMBER';
        authorAccount: string;
        authorDomain: string;
        authorNamespaceId: number;
        subjectAccount: string;
        subjectDomain: string;
        subjectNamespaceId: number;
        threadId: number | null;
        profileRev: number;
      }>(sql`
        SELECT intent."pairId", intent."authorSide", intent."profileRev", pair.kind, pair."threadId",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointAAccount"
            ELSE pair."endpointBAccount" END AS "authorAccount",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointADomain"
            ELSE pair."endpointBDomain" END AS "authorDomain",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointANamespaceId"
            ELSE pair."endpointBNamespaceId" END AS "authorNamespaceId",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointBAccount"
            ELSE pair."endpointAAccount" END AS "subjectAccount",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointBDomain"
            ELSE pair."endpointADomain" END AS "subjectDomain",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointBNamespaceId"
            ELSE pair."endpointANamespaceId" END AS "subjectNamespaceId"
        FROM "RelationshipIntent" intent
        JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
        WHERE (CASE WHEN intent."authorSide" = 'A'
            THEN pair."endpointADomain" ELSE pair."endpointBDomain" END) = 'local'
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" <= CURRENT_TIMESTAMP
        ORDER BY intent."expiresAt", intent."pairId", intent."authorSide"
      `);
      const businessAddresses: BusinessScopeAddress[] = [];
      for (const request of expired.rows) {
        if (request.kind === 'P2P') {
          businessAddresses.push(
            {
              account: request.authorAccount,
              domain: request.authorDomain,
            },
            {
              account: request.subjectAccount,
              domain: request.subjectDomain,
            },
          );
        } else {
          businessAddresses.push(
            request.authorSide === 'A'
              ? {
                  account: request.authorAccount,
                  domain: request.authorDomain,
                }
              : {
                  account: request.subjectAccount,
                  domain: request.subjectDomain,
                },
          );
        }
      }
      await lockBusinessAccountsInTx(tx, businessAddresses);
      await this.stateFeed.lockOutboundStateFeedNamespacesInTx(
        tx,
        expired.rows
          .filter((request) => request.subjectDomain !== 'local')
          .map((request) => ({
            peerDomain: request.subjectDomain,
            namespaceId: request.subjectNamespaceId,
          })),
      );
      const allocated = new Map<string, bigint>();
      let count = 0;
      for (const request of expired.rows) {
        const pairId = BigInt(request.pairId);
        await tx.execute(sql`
          SELECT id FROM "RelationshipPair" WHERE id = ${pairId}
          FOR NO KEY UPDATE
        `);
        const updated = await tx.execute(sql`
          UPDATE "RelationshipIntent"
          SET status = 'REVOKED', note = '', "requestedAt" = NULL,
            "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "pairId" = ${pairId}
            AND "authorSide" = ${request.authorSide}
            AND status = 'REQUESTED' AND "expiresAt" <= CURRENT_TIMESTAMP
          RETURNING 1
        `);
        if ((updated.rowCount ?? 0) === 0) continue;
        count += 1;
        if (request.kind === 'GROUP_MEMBER' && request.threadId !== null) {
          const groupState = await readGroupState(
            tx,
            and(
              eq(
                groupStateFields.account,
                request.authorSide === 'A'
                  ? request.authorAccount
                  : request.subjectAccount,
              ),
              eq(
                groupStateFields.domain,
                request.authorSide === 'A'
                  ? request.authorDomain
                  : request.subjectDomain,
              ),
            ),
          );
          const member = toClientIdentity(
            {
              account:
                request.authorSide === 'B'
                  ? request.authorAccount
                  : request.subjectAccount,
              domain:
                request.authorSide === 'B'
                  ? request.authorDomain
                  : request.subjectDomain,
              namespaceId:
                request.authorSide === 'B'
                  ? request.authorNamespaceId
                  : request.subjectNamespaceId,
            },
            this.config.domain,
          );
          if (!groupState)
            throw new Error('expired group relationship endpoint missing');
          await this.groupRelationships.syncActiveInTx(tx, {
            threadId: request.threadId,
            groupId: groupState.id,
            memberUserId: member,
            active: false,
            hostedLocally: groupState.domain === 'local',
          });
          if (groupState.domain === 'local')
            await this.relationshipMutations.writeGroupRequestEffectsInTx(
              tx,
              request.threadId,
              member,
              'EXPIRED',
              request.authorSide === 'A' ? 'INVITATION' : 'APPLICATION',
              false,
            );
          const [localMember] = await localAccountsForTargetsInTx(tx, [member]);
          if (localMember)
            await this.relationships.writeGroupRequestClientStateInTx(
              tx,
              request.threadId,
              localMember.id,
              pendingClientFeedUpdates,
            );
        } else if (request.kind === 'P2P') {
          const author = toClientIdentity(
            {
              account: request.authorAccount,
              domain: request.authorDomain,
              namespaceId: request.authorNamespaceId,
            },
            this.config.domain,
          );
          const subject = toClientIdentity(
            {
              account: request.subjectAccount,
              domain: request.subjectDomain,
              namespaceId: request.subjectNamespaceId,
            },
            this.config.domain,
          );
          await this.relationshipIntents.setPairActiveInTx(
            tx,
            author,
            subject,
            false,
          );
          pendingClientFeedUpdates.push(
            ...(await this.relationships.writeRelationshipRequestClientStateInTx(
              tx,
              author,
              subject,
            )),
          );
        }
        if (request.subjectDomain === 'local') continue;
        const revisions = await this.stateFeed.writeManyInTx(tx, [
          {
            peerDomain: request.subjectDomain,
            namespaceId: request.subjectNamespaceId!,
            account: request.authorAccount,
            domain: 'local',
            subjectAccount: request.subjectAccount,
            subjectDomain: request.subjectDomain,
            eventType: 'RELATIONSHIP_INTENT',
            body: {
              status: 'REVOKED',
              profileRev: request.profileRev,
              note: '',
              requestedAt: null,
              expiresAt: null,
            },
          },
        ]);
        for (const [domain, revision] of revisions)
          allocated.set(domain, revision);
      }
      return { count, allocated };
    });
    this.clientStateFeed.notifyFeedUpdates(pendingClientFeedUpdates);
    await this.pushStateFeedDomains(result.allocated.keys());
    return result.count;
  }

  /** Public profile of a local user or group. Null if not local, unavailable, or not found. */
  async getLocalAccountProfile(
    address: S2SAddress,
  ): Promise<S2SProfile | null> {
    return this.profiles.getLocalAccountProfile(address);
  }

  async getAuthorizedLocalProfile(
    account: string,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    return this.profiles.getAuthorizedLocalProfile(
      account,
      rev,
      peerDomain,
      namespaceId,
    );
  }

  async getAuthorizedIntentProfile(
    account: string,
    peerAccount: string,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    return this.profiles.getAuthorizedIntentProfile(
      account,
      peerAccount,
      rev,
      peerDomain,
      namespaceId,
    );
  }

  async getAuthorizedAccountProfile(
    account: string,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    return this.profiles.getAuthorizedAccountProfile(
      account,
      rev,
      peerDomain,
      namespaceId,
    );
  }

  async getAuthorizedGroupMemberProfile(
    groupAccount: string,
    memberDomain: string,
    memberAccount: string,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    return this.profiles.getAuthorizedGroupMemberProfile(
      groupAccount,
      memberDomain,
      memberAccount,
      rev,
      peerDomain,
      namespaceId,
    );
  }

  async getStoredProfile(
    account: string,
    domain: string,
    namespaceId: number,
    rev: number,
  ): Promise<S2SProfile | null> {
    return this.profiles.getStoredProfile(account, domain, namespaceId, rev);
  }

  // ─── bidirectional server recognition ─────────────────────────────────────────

  /** Pure local directional gate. It never starts recognition or performs network IO. */
  async checkPeerOutboundReady(domain: string): Promise<void> {
    await this.peerLifecycle.checkOutboundReady(domain);
  }

  async checkPeerHealth(domain: string) {
    return this.peerLifecycle.checkHealth(domain);
  }

  /** Pure local check; it neither sends Health nor starts recognition. */
  async hasCompletePeerRecognition(domain: string): Promise<boolean> {
    return this.peerLifecycle.hasCompleteRecognition(domain);
  }

  /**
   * Recover one reconnect-sweep candidate without confusing availability with identity bootstrap.
   * Retry missing Recognize facts or a degraded transport without replacing the pinned root.
   */
  async recoverPeerRecognition(domain: string): Promise<void> {
    await this.peerLifecycle.recoverPeerRecognition(domain);
  }

  // ─── trust lifecycle (state machine + audit log) ──────────────────────────────
  //
  // FederatedPeer holds the CURRENT state (the cheap read path); FederatedPeerEvent is the append-only
  // log of every transition (the admin timeline). FederationPeerLifecycle is the single owner: every
  // transition — recognition convergence, transport health and admin actions — flows through these
  // methods, so the row + the event stay consistent. Recognition facts remain authoritative when a
  // transport failure temporarily moves a healthy peer to degraded.

  /** Best-practice liveness watermark window. "Last successful contact" is an admin observability
   *  signal whose consumer needs MINUTE granularity (is this peer up?), not sub-second — so write
   *  frequency is matched to that real precision need (see markContactSuccess). The window is the
   *  precision knob: lower it if a consumer genuinely needs finer. */
  /** Advance the per-op liveness watermark (lastSuccessAt) on a successful signed S2S op. Throttled to
   *  ≤1 round trip + ≤1 write per domain per LAST_SUCCESS_WINDOW_MS — two layers keep it cheap AND
   *  correct: (1) an in-memory per-domain guard skips the round trip entirely within the window; (2) a
   *  conditional UPDATE (`WHERE lastSuccessAt IS NULL OR older-than-window`) is correct across restart
   *  and multiple instances (a no-op zero-row probe within the window). Precision is deliberately
   *  ±window — a liveness watermark needs minute, not sub-second, granularity. No event (events are
   *  for state transitions only, keeping the log low-volume). Best-effort: a write failure is swallowed
   *  so a DB hiccup can never break the caller's real S2S op.
   *
   *  Observability-only: NO state machine consumes lastSuccessAt. Degradation is failure-driven (the
   *  matched markTransportDegraded on a failed op), NOT staleness-driven; the reconnect sweep + slowPoll select
   *  targets by trustLevel, never by this watermark. So this write is benign bookkeeping — the explicit
   *  identity continuity and normal signed data requests provide liveness; advancing here is the
   *  higher-fidelity supplement that records every real successful contact. */
  async markContactSuccess(domain: string): Promise<void> {
    await this.peerLifecycle.markContactSuccess(domain);
  }

  /** Admin block: forbid federation with a peer; recognition and ordinary inbound traffic both reject
   *  this durable policy state. Idempotent. Logs a `blocked` event. */
  async markBlocked(domain: string, note?: string): Promise<void> {
    await this.peerLifecycle.markBlocked(domain, note);
  }

  /** Admin unblock reopens recognition without fabricating either directional confirmation. */
  async markUnblocked(domain: string): Promise<void> {
    await this.peerLifecycle.markUnblocked(domain);
  }

  /** Admin list: peers with their lifecycle columns, filtered by free-text domain + trust state. */
  async listPeers(opts: {
    skip: number;
    take: number;
    search?: string;
    status?: string;
  }) {
    return this.peerLifecycle.list(opts);
  }

  /** Admin timeline: a peer's lifecycle events, newest-first. */
  async peerEvents(domain: string, take = 100) {
    return this.peerLifecycle.events(domain, take);
  }

  /**
   * Administrator-only, non-destructive recovery after a transient DNS/SRV hijack caused identity loss.
   * The operation never adopts what DNS currently serves: hostname-verified discovery must present the
   * exact pinned root, while current signing certificates may legitimately differ through rotation.
   */
  async manuallyRecoverPinnedIdentity(
    peerDomain: string,
    confirmDomain: string,
  ): Promise<{
    domain: string;
    trustLevel: 'unrecognized' | 'establishing' | 'degraded';
  }> {
    return this.peerLifecycle.manuallyRecoverPinnedIdentity(
      peerDomain,
      confirmDomain,
    );
  }

  /** POST /s2s/v1/call — deliver ONE ephemeral WebRTC call frame (ring / lifecycle / SDP-ICE relay)
   *  to the peer server hosting the call's other participant. Awaitable so the caller's `initiate` can
   *  detect a ring failure. Terminal history is generated independently on each local server. `peerDomain` is the server hosting the foreign participant. */
  async sendCallFrame(
    params: OutboundCallFrameParams,
    peerDomain: string,
  ): Promise<void> {
    await this.callBridge.sendFrame(params, peerDomain);
  }

  /** Whether this server is the roster and history authority for a group thread. */
  private isOriginThread(trd: { group: { domain: string } | null }): boolean {
    return trd.group?.domain === 'local';
  }

  /** Resolve a wire address (account + domain) to a User row, normalizing the local domain: wire addresses
   *  use the real config.domain for locals, but the DB stores local users with domain="local". Foreign
   *  stubs are looked up by their peer domain verbatim. Returns the stub/local user or null. */
  private async resolveUserByWireAddress(
    account: string,
    fromDomain: string,
  ): Promise<{ id: number } | null> {
    const domain = fromDomain === this.config.domain ? 'local' : fromDomain;
    return (
      (await this.database.db.query.account.findFirst({
        where: and(
          eq(tables.account.account, normalizeAccount(account)),
          eq(tables.account.domain, domain),
        ),
        columns: { id: true },
      })) ?? null
    );
  }

  /** Resolve an independent group address to its local origin or mirror thread. */
  private async findGroupThread(groupAccount: string): Promise<{
    id: number;
    type: MessageThreadType;
    groupId: number | null;
    group: {
      account: string;
      domain: string;
      dissolvedAt: Date | null;
    } | null;
  } | null> {
    const [row] = await this.database.db
      .select({
        id: tables.messageThread.id,
        type: tables.messageThread.type,
        groupId: tables.messageThread.id,
        group: {
          account: groupStateFields.account,
          domain: groupStateFields.domain,
          dissolvedAt: groupStateFields.dissolvedAt,
        },
      })
      .from(tables.messageThread)
      .innerJoin(
        groupStateTable,
        eq(groupStateTable.id, tables.messageThread.id),
      )
      .where(eq(groupStateFields.account, normalizeAccount(groupAccount)))
      .limit(1);
    return row ?? null;
  }

  /** Inbound POST /s2s/v1/call — receive ONE federated call frame. Resolves the wire identities to
   *  LOCAL ids (the sender → a foreigner stub; the recipient → a local userId) + the LOCAL P2P thread,
   *  then hands the frame to CallsService via `emitAsync('call.frame.inbound')` — NOT a direct injection
   *  (the calls layer injects FederationService for outbound; a back-edge would cycle). `emitAsync` (not
   *  `emit`) so the 200 response serializes after callee-side state setup: the caller's first `offer`
   *  signal must not race ahead of the call it addresses.
   *
   *  The verified signer domain supplies the sender's server identity; the body carries only account
   *  names because the receiver domain is this server. Quota: `peek 'requests'` for the initiating
   *  `incoming` op ONLY (a call is one unit; an ICE burst
   *  must not exhaust the budget). The `tick` happens in CallsService AFTER the in-memory call-state
   *  guard, so a retried `incoming` (fresh UUID) burns no quota. No persistent callSid table — the
   *  receiver's call state machine + the callSid-keyed bubble write make replays idempotent. The
   *  not-found / not-friends rejects use HTTP 404 (NOT in postSigned's success- or degradation-sets → the
   *  sender throws without degrading a healthy peer). */
  async handleCallFrame(
    body: unknown,
    peerDomain: string,
    namespaceId: number,
    signatureExpiresAtSec: number,
  ): Promise<void> {
    await this.callBridge.handleFrame(
      body,
      peerDomain,
      namespaceId,
      signatureExpiresAtSec,
    );
  }

  /** Group writes are gated exclusively by locally converged state. */
  async assertGroupWritable(threadId: number): Promise<void> {
    await this.threadAccess.assertGroupWritable(threadId);
  }

  /** P2P writes are gated exclusively by locally converged state. No synchronous peer query is allowed
   * on the message-send path. */
  async assertP2PWritable(
    threadId: number,
    localUserId: number,
  ): Promise<void> {
    await this.threadAccess.assertP2PWritable(threadId, localUserId);
  }

  /** Validate a wire address has non-empty account + domain AND a well-formed account charset (defense
   *  against malformed peer input; the S2sSignatureGuard already bound signer==origin + integrity). */
  private requireS2SAddress(a: S2SAddress): S2SAddress {
    if (!a || !a.account || !a.domain) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed address ${JSON.stringify(a)}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!isValidAccount(a.account)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `account [${a.account}] fails charset`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return a;
  }

  // ─── Step 2: message delivery (coalesced hint map + active pull) ──────────────

  async capturePeerResponseToken(domain: string): Promise<PeerResponseToken> {
    return this.threadAccess.capturePeerResponseToken(domain);
  }

  async pullStateFeedPage(
    domain: string,
    after?: bigint,
    take?: number,
    through?: bigint,
  ): Promise<PeerStateFeedPage> {
    return this.statePull.pullStateFeedPage(domain, after, take, through);
  }

  /** State is always drained before callers start data feeds. When a lightweight hint supplies a
   * required revision, returning successfully is a durable barrier: the state cursor reached it. */
  async pullStateFromPeer(
    domain: string,
    requiredRevision?: bigint,
  ): Promise<bigint> {
    return this.statePull.pullStateFromPeer(domain, requiredRevision);
  }

  /** Ensure an incoming federated group request has a structurally complete retained conversation.
   * RelationshipIntent remains the sole authorization source, and no client state entry is published
   * until the user accepts the request. */

  /** Publish a server-local timeline notice only after its state transaction commits. */
  private async publishLocalSystemMessage(
    status: FederationLocalSystemMessage,
  ): Promise<void> {
    await this.localSystemMessages.publish(status);
  }

  /** Refresh every local-origin group source that exposes this member. */

  /** A member profile change is a group-meta semantic change and therefore advances the same group
   * revision used by roster mutations before publishing the compacted member projection. */

  async assertThreadResourceResponseWritableInTransaction(
    tx: DatabaseTransaction,
    response: FederationThreadResourceResponse<unknown>,
  ): Promise<void> {
    await this.threadAccess.assertResourceResponseWritable(tx, response);
  }

  async applyReverseMessagePage(params: {
    response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    before: number;
    through?: number;
    messageSeqOffset: number;
    prefetchedForwardClosures?: ReadonlyMap<number, InboundForwardWireBundle>;
  }): Promise<void> {
    const publication = await this.database.db.transaction((tx) =>
      this.applyReverseMessagePageInTransaction(tx, params),
    );
    await publication.publish();
  }

  async applyReverseMessagePageInTransaction(
    tx: DatabaseTransaction,
    params: {
      threadLock?: ThreadContentLock;
      response: FederationThreadResourceResponse<FederationMessageQueryPage>;
      before: number;
      through?: number;
      messageSeqOffset: number;
      prefetchedForwardClosures?: ReadonlyMap<number, InboundForwardWireBundle>;
    },
  ): Promise<{ publish: () => Promise<void> }> {
    const effects = await this.inboundMessageCommits.applyReverseInTransaction(
      tx,
      params,
    );
    return {
      publish: () =>
        this.publishMessageQueryEffects(params.response.peerDomain, effects),
    };
  }

  async finalizeReverseMessageWindowInTransaction(
    tx: DatabaseTransaction,
    params: {
      threadLock?: ThreadContentLock;
      threadId: number;
      namespaceId: number;
      beforeSeq: number;
      throughSeq: number;
    },
  ): Promise<void> {
    await this.inboundMessageCommits.finalizeReverseWindowInTransaction(
      tx,
      params,
    );
  }

  async applyForwardMessagePage(params: {
    response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    after: number;
    frozenTargetSeq: number;
    prefetchedForwardClosures?: ReadonlyMap<number, InboundForwardWireBundle>;
  }): Promise<{ publish: () => Promise<void> }> {
    return this.database.db.transaction((tx) =>
      this.applyForwardMessagePageInTransaction(tx, params),
    );
  }

  async applyForwardMessagePageInTransaction(
    tx: DatabaseTransaction,
    params: {
      threadLock?: ThreadContentLock;
      response: FederationThreadResourceResponse<FederationMessageQueryPage>;
      after: number;
      frozenTargetSeq: number;
      prefetchedForwardClosures?: ReadonlyMap<number, InboundForwardWireBundle>;
    },
  ): Promise<{ publish: () => Promise<void> }> {
    const effects = await this.inboundMessageCommits.applyForwardInTransaction(
      tx,
      params,
    );
    return {
      publish: () =>
        this.publishMessageQueryEffects(params.response.peerDomain, effects),
    };
  }

  async applyForwardTombstonePage(params: {
    response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
    frozenTargetSeq: number;
  }): Promise<{ publish: () => Promise<void> }> {
    return this.database.db.transaction((tx) =>
      this.applyForwardTombstonePageInTransaction(tx, params),
    );
  }

  async applyForwardTombstonePageInTransaction(
    tx: DatabaseTransaction,
    params: {
      threadLock?: ThreadContentLock;
      response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
      frozenTargetSeq: number;
    },
  ): Promise<{
    publish: () => Promise<void>;
  }> {
    const effect =
      await this.inboundMessageCommits.applyTombstonesInTransaction(tx, params);
    return {
      publish: async () => {
        await this.inboundMessageCommits.publishSatisfiedQuoteDependencies(
          effect.quoteDependencies,
        );
      },
    };
  }

  /** Apply one bounded message-query page inside the caller's cursor transaction. */
  async applyMessageQueryItemsInTransaction(
    tx: DatabaseTransaction,
    domain: string,
    items: readonly FederationMessageFeedMessage[],
    token: PeerResponseToken,
    options: MessageQueryApplyOptions = {},
  ): Promise<MissedPageEffect[]> {
    return this.inboundMessagePages.apply(tx, domain, items, token, options);
  }
  /** Publish ancillary work only; message and tombstone fanout is admitted in the source transaction. */
  async publishMessageQueryEffects(
    domain: string,
    effects: MissedPageEffect[],
  ): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'pending') {
        void this.runFileSyncBatch(effect.batchId, (digest, offset) =>
          this.fetchMediaChunks(
            domain,
            digest,
            effect.author.account,
            effect.author.domain,
            effect.toAccount,
            effect.originSeq,
            offset,
          ),
        ).catch(() => undefined);
        continue;
      }
      if (
        this.config.forwardedResourcePolicy === 'rebuild' &&
        effect.localForwardBundleId &&
        !effect.message.isDeleted
      ) {
        await this.forwardBundles.rebuildUntrustedCards(
          effect.localForwardBundleId,
          (url) => this.linkPreview.buildCardContent(url),
        );
      }
      if (this.profileResolutions && effect.profileDemand) {
        void this.profileResolutions
          .resolveDemand(effect.profileDemand)
          .catch((error: unknown) =>
            this.logger.warn(
              `message profile resolution failed for ${effect.threadId}:${effect.message.seq}: ${(error as Error).message}`,
            ),
          );
      }
      if (this.profileEvidenceProjections && effect.profileEvidenceProjection) {
        void this.profileEvidenceProjections
          .resolve(effect.profileEvidenceProjection)
          .catch((error: unknown) =>
            this.logger.warn(
              `message profile evidence projection failed for ${effect.threadId}:${effect.message.seq}: ${(error as Error).message}`,
            ),
          );
      }
      if (
        effect.forwardClosure &&
        effect.remoteForwardBundleId &&
        !effect.message.isDeleted
      ) {
        await this.mediaLocalization.localizeForwardAssets(
          // importClosure validated this closure before the message was stored; the
          // effect only carries it on that success path.
          effect.forwardClosure as ForwardWireBundle,
          domain,
          await this.mediaLocalization.resolveForwardAssetAuth(effect.message),
        );
      }
    }
  }

  private assertMissedAssetDescriptors(
    item: FederationMessageFeedMessage,
  ): void {
    this.inboundMessageValidator.assertAssetDescriptors(item);
  }

  private assertFederatedMessageEnvelope(
    item: FederationMessageFeedMessage,
  ): void {
    this.inboundMessageValidator.assertEnvelope(item);
  }
  private federatedMessageAuthor(
    item: FederationMessageFeedMessage,
    sourceDomain: string,
  ): S2SAddress {
    return this.inboundMessageRoutes.messageAuthor(item, sourceDomain);
  }

  private async resolveMissedThreadInTransaction(
    tx: DatabaseTransaction,
    item: FederationMessageFeedMessage,
    sourceDomain: string,
    namespaceId: number,
  ) {
    return this.inboundMessageRoutes.resolveMessage(
      tx,
      item,
      sourceDomain,
      namespaceId,
    );
  }

  private async resolveTombstoneThreadInTransaction(
    tx: DatabaseTransaction,
    thread: FederationThreadAddress,
    sourceDomain: string,
    namespaceId: number,
  ) {
    return this.inboundMessageRoutes.resolveTombstone(
      tx,
      thread,
      sourceDomain,
      namespaceId,
    );
  }
  /** Locally prepared peers still waiting for the peer's acceptance assertion. */
  async listRecoverablePeerDomains(): Promise<string[]> {
    const rows = await this.database.db.query.federatedPeer.findMany({
      where: and(
        eq(tables.federatedPeer.trustLevel, 'establishing'),
        eq(tables.federatedPeer.recognizesPeer, true),
        eq(tables.federatedPeer.localServiceAvailable, true),
        eq(tables.federatedPeer.peerAcceptanceConfirmed, false),
      ),
      columns: { domain: true },
    });
    return rows.map((r) => r.domain);
  }

  /** Fully recognized peers participating in startup reconciliation. */
  async listTrustedPeerDomains(): Promise<string[]> {
    const rows = await this.database.db.query.federatedPeer.findMany({
      where: and(
        inArray(tables.federatedPeer.trustLevel, ['available', 'degraded']),
        eq(tables.federatedPeer.recognizesPeer, true),
        eq(tables.federatedPeer.localServiceAvailable, true),
        eq(tables.federatedPeer.peerAcceptanceConfirmed, true),
      ),
      columns: { domain: true },
    });
    return rows.map((row) => row.domain);
  }

  async resolveMediaFile(
    fromAccount: string,
    toAccount: string,
    fromDomain: string,
    signerDomain: string,
    signerNamespaceId: number,
    digest: string,
    sourceSeq: number,
  ): Promise<{ absPath: string; bytes: number }> {
    return this.peerResources.resolveMediaFile(
      fromAccount,
      toAccount,
      fromDomain,
      signerDomain,
      signerNamespaceId,
      digest,
      sourceSeq,
    );
  }

  async serveForwardBundleClosure(
    bundleId: string,
    signerDomain: string,
    signerNamespaceId: number,
  ) {
    return this.peerResources.serveForwardBundleClosure(
      bundleId,
      signerDomain,
      signerNamespaceId,
    );
  }

  /**
   * Drive every pending file in a batch, then promote the staged message once all files succeed.
   * The extracted coordinator serializes concurrent retry and recovery attempts for the same batch.
   */
  async runFileSyncBatch(
    batchId: string,
    fetchChunksFor: (digest: string, offset: number) => AsyncIterable<Buffer>,
  ): Promise<void> {
    await this.inboundMediaBatches.runFileSyncBatch(batchId, fetchChunksFor);
  }

  /**
   * Admin-driven retry of a stalled inbound media batch (design doc §12.7). Resets files frozen in
   * DOWNLOADING (a crashed driver) or FAILED back to PENDING, restores the admitted download route
   * persisted by global /missed, then fire-and-forgets runFileSyncBatch. Returns the
   * number of stuck files reset (FAILED/DOWNLOADING → PENDING); the admin observes progress via the
   * inbox list endpoint.
   */
  async retryInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.inboundMediaBatches.retryInboundBatch(batchId);
  }

  /**
   * Startup recovery is deliberately narrower than the admin retry: a process crash may strand an
   * active transfer in DOWNLOADING, so it is reset and resumed. A clean FAILED row remains terminal
   * until an administrator explicitly retries it.
   */
  async recoverInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.inboundMediaBatches.recoverInboundBatch(batchId);
  }

  /**
   * Manually re-run localize for one federated media message (the user tapped retry in the detail
   * view). Resolves the localizeMedia context (creator account/domain + the thread's receiver/peer
   * domain) from the stored message alone, then re-runs the SAME localize path the pull flow uses.
   * localizeMedia is idempotent (already-local digests skip the fetch and cost no quota). Returns the
   * post-localize status so the endpoint can answer the client. Non-media → 'ready' (nothing to do);
   * missing message/creator → NOT_FOUND.
   */
  async localizeMediaForMessage(
    userId: number,
    threadId: number,
    seq: number,
  ): Promise<MediaStatus> {
    return this.mediaLocalization.localizeMediaForMessage(
      userId,
      threadId,
      seq,
    );
  }

  /**
   * Receiver-side resumable media fetch (Step 2 §4.5): yield a peer-hosted chat-media asset as ordered
   * Buffer chunks via signed Range GETs to /media/:digest, for saveCasFromStream to stream to disk. Each
   * yielded Buffer is ONE fully-accumulated Range unit (≤ mediaChunkBytes), so a body-read abort
   * discards only that unit upstream and is re-requested from the SAME offset — the writer never sees a
   * partial/duplicated slice, and resume is byte-exact. Offset advances by the peer's returned
   * Content-Range (the server may clamp the tail, RFC 7233 §4.2), NOT by the requested window.
   *
   * Degradation policy is STATUS-based (the fetch-throws-vs-body-abort proxy is unreliable at the header
   * boundary): a fetch rejection or 5xx → peer unreachable → markTransportDegraded + throw. Registered 200
   * business errors and 400/401/416 reject only this transfer without degrading. A body-read error AFTER
   * a 206 → retry the same unit, NO degradation (peer alive; lost a
   * stream). After mediaMaxChunkRetries consecutive failures → give up (throw; localizeMedia leaves it
   * inert). markContactSuccess fires ONCE per digest (after the first 2xx headers). If the peer returns
   * A peer that ignores Range and returns 200 is rejected: federation media requires exact resumable
   * ranges. Per-unit Content-Digest is optional, but when present it is verified before yielding; the
   * final CAS digest remains mandatory in both cases.
   */
  private async *fetchMediaChunks(
    peerDomain: string,
    digest: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
    sourceSeq: number,
    startOffset = 0,
  ): AsyncGenerator<Buffer> {
    yield* this.mediaRangeClient.fetch(
      peerDomain,
      digest,
      fromAccount,
      fromDomain,
      toAccount,
      sourceSeq,
      startOffset,
    );
  }

  /**
   * Fetch a peer user or group's public profile (signed GET /s2s/v1/accounts/:account). Used by
   * federated resolve, ensureForeignUserLocalized (send-friend-request safety net), and initial
   * invite/profile localization. Throws on any non-success (the caller
   * surfaces FEDERATION_DELIVERY_FAILED → user retries / inits).
   */
  async fetchRemoteAccount(address: S2SAddress): Promise<S2SProfile> {
    return this.profiles.fetchRemoteAccount(address);
  }
}
import type { ThreadContentLock } from '../common/locks/thread-content-lock.js';
