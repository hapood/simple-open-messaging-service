import {
  forwardRef,
  Injectable,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'node:crypto';
import {
  normalizeAccount,
  isValidAccount,
  isValidSomfpDomain,
} from '../common/account.js';
import { encodeFederationResourceComponent } from './federation-resource-request.js';
import { dataDirectory } from '../common/data-directory.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  ContentType,
  MessageDeleteType,
  MessageThreadType,
} from '../database/enums.js';
import type { Message } from '../message/message.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import * as tables from '../database/schema.js';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { UploadService } from '../upload/upload.service.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import {
  ForwardBundleService,
  type ForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { QuotaService } from '../quota/quota.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import {
  InviteService,
  type FederatedPendingProfileSnapshot,
} from '../invite/invite.service.js';
import { SseService } from '../gateway/sse.service.js';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import {
  derivePreview,
  MessageService,
  type PublicMessage,
} from '../message/message.service.js';
import { recordHostedGroupSentBoundaries } from '../message/hosted-group-sent-boundaries.js';
import { upsertSourceUserInTx } from '../user/source-user.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';
import {
  extractDigestEntries,
  extractDigests,
} from '../upload/file-content.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import {
  type PreserveFederationOriginSequence,
  validatePreservedFederationOriginSequence,
} from './federation-message-sequence-policy.js';
import { openFederatedAudienceInTx } from './federation-audience.js';
import { stat } from 'node:fs/promises';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import {
  buildCallContent,
  parseFederatedCallContent,
} from '../calls/call-content.js';
import {
  type CallSignalPayload,
  parseS2SCallWireFrame,
  type S2SCallFrame,
  toS2SCallWireFrame,
} from '../calls/federated-call-protocol.js';
import {
  FederationCallDelivery,
  type OutboundCallFrameParams,
} from './federation-call-delivery.js';
import {
  FederationMessageContextError,
  S2sResponseError,
} from './federation-errors.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import {
  FederationMediaRangeClient,
  type FederationMediaRangeUnit,
} from './federation-media-range-client.js';
import {
  federationFileSyncKind,
  FederationInboundFileSync,
  isFederatedMediaContentType,
} from './federation-inbound-file-sync.js';
import { FederationPendingMediaPromoter } from './federation-pending-media-promoter.js';
import { requireInboundPendingMedia } from '../message/pending-media-row.js';

export {
  deriveLocalGroupSystemEvents,
  type LocalGroupSystemEvent,
} from './local-group-system-events.js';
export {
  FederationMessageContextError,
  S2sResponseError,
} from './federation-errors.js';

export type {
  S2SCallFrame,
  S2SCallOperation,
} from '../calls/federated-call-protocol.js';

import { FederationRecognitionService } from './federation-recognition.service.js';
import {
  FEDERATED_MESSAGE_CONTENT_TYPES,
  type FederationMessageFeedMessage,
  type FederationMessageQueryPage,
  type FederationThreadAddress,
} from './federation-message-feed.service.js';
import {
  federatedContentDigests,
  fromFederatedMessageContent,
} from './federated-message-content.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import { type FederationMessageTombstoneQueryPage } from './federation-message-tombstone-feed.service.js';
import {
  PeerStateFeedService,
  type PeerStateFeedPage,
} from './peer-state-feed.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { type GroupMetaFeedPage } from './group-meta-feed.service.js';
import { RelationshipIntentService } from '../invite/relationship-intent.service.js';
import { FederationGroupRelationshipService } from './federation-group-relationship.service.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import { SystemMessageType } from '../message/system-message.js';
import { ClientMessageFeedWriter } from '../message/client-message-feed.service.js';
import { assertServerGroupCapacityInTx } from '../group/group-capacity.js';
import {
  FEDERATION_STATE_FEED_PUSH,
  FEDERATION_THREAD_ROUND_WAKE,
} from './federation-thread-round.events.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';
import { FederationProfileStatePublisher } from './federation-profile-state-publisher.service.js';
import { FederationRelationshipCommandService } from './federation-relationship-command.service.js';
import {
  FederationNamespaceService,
  type FederationContext,
} from './federation-namespace.service.js';
import {
  FederationStateFeedConsumerService,
  type StatePageEffect,
} from './federation-state-feed-consumer.service.js';

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

/** A federated user address on the wire: two separate fields (account + domain). The `@` separator
 *  is a UI input convention ONLY — the browser splits a typed `alice@bbb.com` into these two fields
 *  before any API call; S2S payloads + endpoints + consumer DTOs never carry an `@`-joined string. */
export interface S2SAddress {
  account: string;
  domain: string;
}

export type PeerResponseToken = FederationContext;

export interface S2SQuoteTarget {
  targetSeq: number;
}

interface FederatedForwardCard {
  bundleId: string;
}

interface MissedPageEffect {
  kind: 'message' | 'pending';
  historical: boolean;
  threadId: number;
  originSeq: number;
  recipients: number[];
  toAccount: string;
  author: S2SAddress;
  batchId?: string;
  message?: Message;
  deletionSeq?: number;
  forwardClosure?: ForwardWireBundle;
  remoteForwardBundleId?: string;
  localForwardBundleId?: string;
}

interface MessageQueryApplyOptions {
  prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
  isolateMissingContext?: boolean;
  sequencePolicy?: PreserveFederationOriginSequence;
  expectedThreadId?: number;
  historical?: boolean;
}

export interface FederationThreadResourceResponse<T> {
  data: T;
  threadId: number;
  peerDomain: string;
  federationVersion: number;
  peerToken: PeerResponseToken;
}

/**
 * Inline profile avatar transmitted over S2S. The receiver validates the digest, media type, Base64,
 * and dimensions before running the bytes through the local avatar pipeline. Null means no avatar.
 */
export interface InlineProfileAvatar {
  digest: string;
  mimeType: string;
  base64: string;
  width: number;
  height: number;
}

/**
 * A user's public profile as transmitted over S2S — the resolve endpoint (GET /s2s/v1/users/:account)
 * response body. `profileRev` is the sender's profile revision; receivers store it on the foreign
 * projection so an equal or older response cannot overwrite newer profile state.
 */
export interface S2SProfile {
  account: string;
  domain: string;
  displayName: string;
  avatar: InlineProfileAvatar | null;
  bio: string;
  profileRev: number;
}

function parseInboundDownloadAuth(
  value: unknown,
): { fromAccount: string; fromDomain: string; toAccount: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const auth = value as Record<string, unknown>;
  if (
    typeof auth.fromAccount !== 'string' ||
    typeof auth.fromDomain !== 'string' ||
    typeof auth.toAccount !== 'string' ||
    !auth.fromAccount ||
    !auth.fromDomain ||
    !auth.toAccount
  ) {
    return;
  }
  return {
    fromAccount: auth.fromAccount,
    fromDomain: auth.fromDomain,
    toAccount: auth.toAccount,
  };
}

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
 * the profile embedded in the friend-request payload (and refreshed via fetchRemoteUser on
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
  /** Serializes inbound frames that may establish the same call binding, closing concurrent incoming races. */
  private readonly callInboundLocks = new KeyedMutex();
  private readonly callDelivery = new FederationCallDelivery();
  private readonly peerLifecycle: FederationPeerLifecycle;
  private readonly inboundFileSync: FederationInboundFileSync;
  private readonly pendingMediaPromoter: FederationPendingMediaPromoter;

  constructor(
    private readonly database: DatabaseService,
    private readonly signature: SignatureService,
    private readonly discovery: DiscoveryService,
    private readonly upload: UploadService,
    private readonly participantService: ThreadParticipantService,
    private readonly message: MessageService,
    @Inject(forwardRef(() => InviteService))
    private readonly invite: InviteService,
    private readonly sse: SseService,
    private readonly quota: QuotaService,
    private readonly linkPreview: LinkPreviewService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly messageVisibility: MessageVisibilityService,
    private readonly deletedMessages: DeletedMessageService,
    // Inbound S2S call frames are bridged to CallsService via emitAsync('call.frame.inbound') rather
    // than a direct injection — FederationService must NOT inject CallsService (that would cycle: the
    // calls layer injects FederationService for outbound). The event bus breaks the edge cleanly.
    private readonly eventEmitter: EventEmitter2,
    private readonly recognition: FederationRecognitionService,
    private readonly downloadScheduler: FederationDownloadScheduler,
    private readonly transportConfig: FederationTransportConfigService,
    private readonly stateFeedPull: PeerStateFeedPullService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupRelationships: FederationGroupRelationshipService,
    private readonly threadContentHeads: FederationThreadContentHeadService,
    private readonly profileStatePublisher: FederationProfileStatePublisher,
    private readonly relationshipCommands: FederationRelationshipCommandService,
    private readonly namespaces: FederationNamespaceService,
    private readonly stateFeedConsumer: FederationStateFeedConsumerService,
  ) {
    this.peerLifecycle = new FederationPeerLifecycle(
      this.database,
      this.recognition,
      this.discovery,
      this.config.domain,
    );
    this.inboundFileSync = new FederationInboundFileSync(
      this.database,
      this.quota,
      this.upload,
      this.downloadScheduler,
    );
    this.pendingMediaPromoter = new FederationPendingMediaPromoter(
      this.database,
    );
  }

  /** The wire address of a LOCAL user: { account, domain } (domain = our real config.domain). */
  localAddress(account: string): S2SAddress {
    return { account: account, domain: this.config.domain };
  }

  /** This server's domain (config.domain) — for address-domain comparison in controllers. */
  get ourDomain(): string {
    return this.config.domain;
  }

  // ─── durable discovery wake-up routing ─────────────────────────────────────

  /** Hook for the local-send path (MessageController.sendMessage) + the pulled path (storePulledMessage):
   *  after a message lands, route the outbound hint. Best-effort — never throws into the caller. */
  async notifyOnSend(
    author: S2SAddress,
    threadId: number,
    originSeq: number,
  ): Promise<void> {
    await this.signalOutbound(threadId, author, originSeq, undefined);
  }

  /** Best-effort wake-up after a local user leaves a federated group mirror. The durable system message
   *  is already part of the global change feed; this method only wakes the origin. */
  async notifyGroupLeave(
    threadId: number,
    leaverUserId: number,
  ): Promise<void> {
    try {
      const [trd] = await this.database.db
        .select({ domain: tables.group.domain })
        .from(tables.messageThread)
        .innerJoin(
          tables.group,
          eq(tables.group.id, tables.messageThread.groupId),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      const originDomain = trd?.domain;
      if (!originDomain || originDomain === 'local') return; // origin / local group — no-op
      void leaverUserId;
      await this.pushDiscoveryHwm(originDomain);
    } catch (e) {
      this.logger.debug(
        `notifyGroupLeave(${threadId}) failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * The direct-authority routing entry. A successfully persisted pulled copy is signalled back to its
   * direct source once as a processing receipt. The remaining authority-defined audience is notified
   * directly; receipt replay matches an existing stable identity and allocates no further message.
   * P2P → each foreign peer except the author; GROUP → (origin: all foreign member-domains; mirror:
   * {originDomain}). Best-effort: logs + swallows.
   */
  async signalOutbound(
    threadId: number,
    authorAddress: S2SAddress,
    latestSeq: number,
    fetchedFromDomain: string | undefined,
  ): Promise<void> {
    try {
      const [trd, participants] = await Promise.all([
        this.database.db
          .select({
            type: tables.messageThread.type,
            groupDomain: tables.group.domain,
          })
          .from(tables.messageThread)
          .leftJoin(
            tables.group,
            eq(tables.group.id, tables.messageThread.groupId),
          )
          .where(eq(tables.messageThread.id, threadId))
          .limit(1)
          .then((rows) => rows[0]),
        this.database.db
          .select({
            userId: tables.threadMember.userId,
            user: {
              account: tables.user.account,
              domain: tables.user.domain,
            },
          })
          .from(tables.threadMember)
          .innerJoin(
            tables.user,
            eq(tables.user.id, tables.threadMember.userId),
          )
          .where(eq(tables.threadMember.threadId, threadId)),
      ]);
      if (!trd) return;
      const participantAuthorization = await Promise.all(
        participants.map((participant) =>
          isThreadMutuallyAuthorized(
            this.database.db,
            participant.userId,
            threadId,
          ),
        ),
      );
      const authorizedParticipants = participants.filter(
        (_, index) => participantAuthorization[index],
      );
      const author = authorizedParticipants.find(
        (p) =>
          p.user.account === authorAddress.account &&
          p.user.domain === authorAddress.domain,
      );
      if (!author) return;
      if (fetchedFromDomain) {
        void this.offerAndPushMessage(
          fetchedFromDomain,
          threadId,
          latestSeq,
        ).catch((e) =>
          this.logger.debug(
            `delivery receipt HWM push ${fetchedFromDomain} failed: ${(e as Error).message}`,
          ),
        );
      }

      const groupDomain = trd.groupDomain;
      if (!groupDomain) {
        // P2P (local-only or federated 1:1): signal each foreign peer participant EXCEPT the author + the
        // fetch source. A pulled P2P message's only foreign participant is the author → nobody to signal.
        for (const p of authorizedParticipants) {
          if (
            (p.user.account === authorAddress.account &&
              p.user.domain === authorAddress.domain) ||
            p.user.domain === 'local'
          )
            continue;
          if (fetchedFromDomain && p.user.domain === fetchedFromDomain)
            continue;
          void this.offerAndPushMessage(
            p.user.domain,
            threadId,
            latestSeq,
          ).catch((e) => {
            this.logger.debug(
              `discovery HWM push ${p.user.domain} failed: ${(e as Error).message}`,
            );
          });
        }
        return;
      }
      // GROUP federated. dest = origin → all mirror domains, mirror → origin. The direct fetch source
      // already received the processing-receipt notification above.
      const destDomains = new Set<string>();
      if (groupDomain === 'local') {
        for (const p of authorizedParticipants)
          if (p.user.domain !== 'local') destDomains.add(p.user.domain);
      } else {
        destDomains.add(groupDomain);
      }
      if (fetchedFromDomain) destDomains.delete(fetchedFromDomain);
      for (const d of destDomains) {
        void this.offerAndPushMessage(d, threadId, latestSeq).catch((e) =>
          this.logger.debug(
            `discovery HWM push ${d} failed: ${(e as Error).message}`,
          ),
        );
      }
    } catch (e) {
      // Never break the caller (send/pull path) — a transient DB error just skips this notify.
      this.logger.debug(
        `signalOutbound(${threadId}) failed: ${(e as Error).message}`,
      );
    }
  }

  private async offerAndPushMessage(
    peerDomain: string,
    threadId: number,
    messageSeq: number,
  ): Promise<void> {
    await this.threadContentHeads.offerCommitted(
      peerDomain,
      threadId,
      messageSeq,
    );
    await this.pushDiscoveryHwm(peerDomain);
  }

  /** Wake direct thread peers after a locally authoritative deletion or group submission. Mirrors
   * must not call this for an authoritative deletion consumed from their group origin. */
  async signalDeletionOutbound(
    threadId: number,
    messageSeq: number,
  ): Promise<void> {
    const peers = await this.database.db
      .selectDistinct({ domain: tables.threadAudience.targetDomain })
      .from(tables.threadAudience)
      .where(
        and(
          eq(tables.threadAudience.threadId, threadId),
          isNull(tables.threadAudience.localUserId),
        ),
      );
    void messageSeq;
    await Promise.all(
      peers.map(async ({ domain }) => {
        await this.threadContentHeads.offerCommitted(domain, threadId);
        await this.pushDiscoveryHwm(domain);
      }),
    );
  }

  /** Find a LOCAL user id by account (domain="local"). Null if not found / not local / soft-deleted.
   *  The isDeleted gate matters here because S2S bypasses the token system: the local /uploads/* path is
   *  protected from admin-disabled users by session-token revocation (invalidateAllSessions revokes every
   *  SessionToken row on disable), but
   *  /media/:digest never touches client tokens — so a disabled user's media would still flow out over federation
   *  unless we reject the soft-deleted row here. */
  async findLocalUserId(account: string): Promise<number | null> {
    const u = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(account)),
        eq(tables.user.domain, 'local'),
        eq(tables.user.namespaceId, 0),
      ),
    });
    return u && u.domain === 'local' && u.availability === 'AVAILABLE'
      ? u.id
      : null;
  }

  /** Look up a local user id from a full address (must be account@<our domain>). */
  async findLocalUserIdByAddress(address: S2SAddress): Promise<number | null> {
    if (address.domain !== this.config.domain) return null;
    return this.findLocalUserId(address.account);
  }

  /** Load a local user (full row) by id; throw if missing or not local. The single source for the
   *  `from` address + outbound profile builders, replacing the old localAccount() helper. */
  private async requireLocalUser(userId: number): Promise<{
    id: number;
    account: string;
    name: string;
    avatar: string;
    bio: string;
    profileRev: number;
  }> {
    const u = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, userId),
    });
    if (!u || u.domain !== 'local')
      throw new Error(`user ${userId} is not a local user`);
    return u;
  }

  /** Build the S2SProfile wire shape from a loaded local user (reads the avatar file → base64). */
  private async toS2SProfile(u: {
    account: string;
    name: string;
    avatar: string;
    bio: string;
    profileRev: number;
  }): Promise<S2SProfile> {
    const wire = u.avatar ? await this.upload.readAvatarAsWire(u.avatar) : null;
    const avatar = wire
      ? {
          digest: createHash('sha256')
            .update(Buffer.from(wire.b64, 'base64'))
            .digest('hex'),
          mimeType: 'image/webp',
          base64: wire.b64,
          width: wire.w,
          height: wire.h,
        }
      : null;
    return {
      account: u.account,
      domain: this.config.domain,
      displayName: u.name,
      avatar,
      bio: u.bio,
      profileRev: u.profileRev,
    };
  }

  /** Transactional PROFILE writer used by profile mutations. The caller sends wake-ups only after commit. */
  async writeProfileStateInTx(
    tx: DatabaseTransaction,
    userId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    return this.profileStatePublisher.writeProfileStateInTx(
      tx,
      userId,
      clientFeedUpdates,
    );
  }

  /** Remove origin-owned group disclosure after the peer's last active member disappears. */
  private async cleanupGroupProjectionInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupId: number,
    groupAccount: string,
    peerDomain: string,
    namespaceId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    return this.profileStatePublisher.cleanupGroupProjectionInTx(
      tx,
      threadId,
      groupId,
      groupAccount,
      peerDomain,
      namespaceId,
      clientFeedUpdates,
    );
  }

  /** Accept an incoming Address-based request. This is the first point where this server consents to
   * the relationship, so the verified PROFILE projection is promoted into User and the existing
   * id-based friendship state machine can take over. */
  async acceptAddressedFriendRequest(
    localUserId: number,
    remote: { account: string; domain: string },
  ): Promise<Map<string, bigint>> {
    const remoteAccount = normalizeAccount(remote.account);
    const remoteDomain = remote.domain.trim().toLowerCase();
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const context = await this.namespaces.captureActiveInTx(tx, remoteDomain);
      const request = await tx.query.federatedFriendRequest.findFirst({
        where: and(
          eq(tables.federatedFriendRequest.localUserId, localUserId),
          eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
          eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
          eq(tables.federatedFriendRequest.namespaceId, context.namespaceId),
          eq(tables.federatedFriendRequest.direction, 'INCOMING'),
        ),
      });
      if (!request)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request not found',
        );
      if (
        request.localUserId !== localUserId ||
        request.direction !== 'INCOMING'
      )
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'request is not yours',
        );
      if (
        request.status !== 'REQUESTED' ||
        request.expiresAt === null ||
        request.expiresAt <= new Date()
      )
        throw new BusinessException(
          BusinessCode.INVITE_EXPIRED,
          'request expired',
        );
      if (remoteAccount.startsWith('!')) {
        const shell =
          await this.stateFeedConsumer.ensureFederatedGroupRequestShellInTx(
            tx,
            request.remoteAccount,
            request.remoteDomain,
            request.namespaceId,
          );
        await this.relationshipIntents.applyRemoteGroupIntentInTx(tx, {
          groupId: shell.groupId,
          memberUserId: localUserId,
          threadId: shell.threadId,
          author: 'GROUP',
          status: 'REQUESTED',
          note: request.note,
          requestedAt: request.requestedAt,
          expiresAt: request.expiresAt,
        });
        const state =
          await this.relationshipCommands.writeMemberRelationshipIntentInTx(
            tx,
            shell.threadId,
            localUserId,
            'ACCEPTED',
            clientFeedUpdates,
          );
        await tx
          .insert(tables.threadAudience)
          .values({
            targetDomain: 'local',
            localUserId,
            threadId: shell.threadId,
          })
          .onConflictDoNothing();
        await tx
          .delete(tables.federatedFriendRequest)
          .where(
            and(
              eq(tables.federatedFriendRequest.localUserId, localUserId),
              eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
              eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
              eq(tables.federatedFriendRequest.namespaceId, request.namespaceId),
              eq(tables.federatedFriendRequest.direction, 'INCOMING'),
            ),
          );
        return { peers: state, friendAddedThreadId: undefined };
      }
      const remoteUserId =
        await this.stateFeedConsumer.materializeFederatedUserInTx(
          tx,
          request.remoteAccount,
          request.remoteDomain,
          request.namespaceId,
        );
      await this.relationshipIntents.applyRemoteP2PIntentInTx(tx, {
        authorUserId: remoteUserId,
        subjectUserId: localUserId,
        threadId: null,
        status: 'REQUESTED',
        note: request.note,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt,
      });
      const pair = await this.relationshipIntents.lockPairInTx(
        tx,
        localUserId,
        remoteUserId,
      );
      const pairBefore = await tx.query.relationshipPair.findFirst({
        where: eq(tables.relationshipPair.id, pair.id),
        columns: { active: true },
      });
      const state = await this.relationshipCommands.writeFriendIntentInTx(
        tx,
        localUserId,
        remoteUserId,
        true,
        '',
        clientFeedUpdates,
        true,
      );
      await tx
        .delete(tables.federatedFriendRequest)
        .where(
          and(
            eq(tables.federatedFriendRequest.localUserId, localUserId),
            eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
            eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
            eq(tables.federatedFriendRequest.namespaceId, request.namespaceId),
            eq(tables.federatedFriendRequest.direction, 'INCOMING'),
          ),
        );
      const pairAfter = await tx.query.relationshipPair.findFirst({
        where: eq(tables.relationshipPair.id, pair.id),
        columns: { active: true, threadId: true },
      });
      return {
        peers: state,
        friendAddedThreadId:
          pairBefore?.active !== true && pairAfter?.active === true
            ? (pairAfter.threadId ?? undefined)
            : undefined,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    if (result.friendAddedThreadId !== undefined)
      await this.publishLocalSystemMessage({
        actorUserId: localUserId,
        threadId: result.friendAddedThreadId,
        type: SystemMessageType.FRIEND_ADDED,
        recipientUserIds: [localUserId],
      });
    return result.peers;
  }

  /** Start a member-authored join request for a group hosted by a federated peer. */
  async requestFederatedGroupJoin(
    memberUserId: number,
    address: S2SAddress,
    note: string,
    snapshot: FederatedPendingProfileSnapshot,
  ): Promise<void> {
    if (!address.account.startsWith('!'))
      throw new BusinessException(
        BusinessCode.FRIEND_INVALID_TARGET,
        'target is not a group',
      );
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const state = await this.database.db.transaction(async (tx) => {
      const context = await this.namespaces.captureActiveInTx(
        tx,
        address.domain,
      );
      const shell =
        await this.stateFeedConsumer.ensureFederatedGroupRequestShellInTx(
          tx,
          address.account,
          address.domain,
          context.namespaceId,
        );
      return this.relationshipCommands.writeMemberRelationshipIntentInTx(
        tx,
        shell.threadId,
        memberUserId,
        'REQUESTED',
        clientFeedUpdates,
        note,
        snapshot,
      );
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    await this.pushStateFeedDomains(state.keys());
  }

  async revokeGroupJoinRequest(
    memberUserId: number,
    address: S2SAddress,
  ): Promise<void> {
    const account = normalizeAccount(address.account);
    const domain = address.domain.trim().toLowerCase();
    const storedDomain = domain === this.config.domain ? 'local' : domain;
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const state = await this.database.db.transaction(async (tx) => {
      const namespaceId =
        storedDomain === 'local'
          ? 0
          : (await this.namespaces.captureActiveInTx(tx, domain)).namespaceId;
      const groupState = await tx.query.group.findFirst({
        where: and(
          eq(tables.group.account, account),
          eq(tables.group.domain, storedDomain),
          eq(tables.group.namespaceId, namespaceId),
        ),
        columns: {
          id: true,
          account: true,
          name: true,
          avatar: true,
          description: true,
          profileRev: true,
          namespaceId: true,
        },
      });
      if (!groupState)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      const thread = await tx.query.messageThread.findFirst({
        where: eq(tables.messageThread.groupId, groupState.id),
        columns: { id: true },
      });
      const member = await tx.query.user.findFirst({
        where: eq(tables.user.id, memberUserId),
        columns: { account: true },
      });
      if (!thread || !member)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      const allocated =
        await this.relationshipCommands.writeMemberRelationshipIntentInTx(
          tx,
          thread.id,
          memberUserId,
          'REVOKED',
          clientFeedUpdates,
        );
      const endpoints = clientGroupIntentEndpoints(
        account,
        member.account,
        'MEMBER',
      );
      const feedId = await this.clientStateFeed.writeInTx(tx, {
        userId: memberUserId,
        namespaceId: groupState.namespaceId,
        account: endpoints.account,
        domain: 'local',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: endpoints.subjectAccount,
        subjectDomain: domain,
        body: {
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
          direction: 'OUTGOING',
          threadId: thread.id,
          group: {
            account,
            domain,
            isLocal: storedDomain === 'local',
            name: groupState.name,
            avatar: groupState.avatar,
            description: groupState.description,
            profileRev: groupState.profileRev,
          },
        },
      });
      if (feedId !== null)
        clientFeedUpdates.push({ userId: memberUserId, feedId });
      return allocated;
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    await this.pushStateFeedDomains(state.keys());
  }

  /** Revoke the caller's outgoing pre-stub request. Incoming requests have no rejection transition;
   * clients may ignore or locally discard their presentation. */
  async revokeAddressedOutgoingRequest(
    localUserId: number,
    remote: { account: string; domain: string },
  ): Promise<Map<string, bigint>> {
    const remoteAccount = normalizeAccount(remote.account);
    const remoteDomain = remote.domain.trim().toLowerCase();
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const context = await this.namespaces.captureActiveInTx(tx, remoteDomain);
      const request = await tx.query.federatedFriendRequest.findFirst({
        where: and(
          eq(tables.federatedFriendRequest.localUserId, localUserId),
          eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
          eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
          eq(tables.federatedFriendRequest.namespaceId, context.namespaceId),
          eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
        ),
      });
      if (!request)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request not found',
        );
      if (
        request.localUserId !== localUserId ||
        request.direction !== 'OUTGOING'
      )
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'request is not yours',
        );
      if (request.status !== 'REQUESTED')
        throw new BusinessException(
          BusinessCode.INVITE_ALREADY_HANDLED,
          'request already handled',
        );
      await tx
        .update(tables.federatedFriendRequest)
        .set({
          status: 'REVOKED',
          requestedAt: null,
          expiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tables.federatedFriendRequest.localUserId, localUserId),
            eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
            eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
            eq(tables.federatedFriendRequest.namespaceId, request.namespaceId),
            eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
          ),
        );
      const local = await tx.query.user.findFirst({
        where: and(
          eq(tables.user.id, localUserId),
          eq(tables.user.domain, 'local'),
          eq(tables.user.namespaceId, 0),
        ),
        columns: {
          id: true,
          account: true,
          name: true,
          avatar: true,
          domain: true,
        },
      });
      if (!local) throw new Error('local friend requester disappeared');
      const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
        userId: localUserId,
        namespaceId: request.namespaceId,
        account: local.account,
        domain: this.config.domain,
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: request.remoteAccount,
        subjectDomain: request.remoteDomain,
        body: {
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
          direction: 'OUTGOING',
          localThreadId: null,
          peer: {
            id: 0,
            account: request.remoteAccount,
            name: request.displayName ?? request.remoteAccount,
            avatar: request.avatar ?? '',
            domain: request.remoteDomain,
          },
        },
      });
      if (clientFeedId !== null)
        clientFeedUpdates.push({ userId: localUserId, feedId: clientFeedId });
      const state = await this.stateFeed.writeManyInTx(tx, [
        {
          peerDomain: request.remoteDomain,
          namespaceId: request.namespaceId,
          account: local.account,
          domain: this.config.domain,
          subjectAccount: request.remoteAccount,
          subjectDomain: request.remoteDomain,
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'REVOKED',
            note: '',
            requestedAt: null,
            expiresAt: null,
          },
        },
      ]);
      return state;
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    return result;
  }

  /** User-facing acceptance of a stored GROUP→USER request. Acceptance makes the local conversation
   * formal immediately; authoritative GROUP_META later fills and reconciles the complete roster. */
  async acceptGroupRequest(
    threadId: number,
    memberUserId: number,
  ): Promise<void> {
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
      const [thread] = await tx
        .select({
          groupId: tables.messageThread.groupId,
          groupDomain: tables.group.domain,
        })
        .from(tables.messageThread)
        .innerJoin(
          tables.group,
          eq(tables.group.id, tables.messageThread.groupId),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      if (!thread?.groupId)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      if (
        !(await this.relationshipIntents.hasValidGroupInviteInTx(tx, {
          groupId: thread.groupId,
          memberUserId,
          threadId,
          author: 'GROUP',
        }))
      )
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      const existing = await tx.query.threadMember.findFirst({
        where: and(
          eq(tables.threadMember.threadId, threadId),
          eq(tables.threadMember.userId, memberUserId),
          eq(tables.threadMember.left, false),
        ),
        columns: { id: true },
      });
      const alreadyVisible =
        existing != null &&
        (await isThreadMutuallyAuthorized(tx, memberUserId, threadId));
      if (thread.groupDomain === 'local')
        await assertServerGroupCapacityInTx(tx, threadId, memberUserId);
      const allocated =
        await this.relationshipCommands.writeMemberRelationshipIntentInTx(
          tx,
          threadId,
          memberUserId,
          'ACCEPTED',
          clientFeedUpdates,
        );
      await tx
        .insert(tables.threadAudience)
        .values({
          targetDomain: 'local',
          localUserId: memberUserId,
          threadId,
        })
        .onConflictDoNothing();
      if (thread.groupDomain !== 'local')
        await openFederatedAudienceInTx(tx, thread.groupDomain, threadId);
      return {
        allocated,
        clientFeedUpdates,
        shouldWriteStatus: !alreadyVisible,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    if (result.shouldWriteStatus)
      await this.publishLocalSystemMessage({
        actorUserId: memberUserId,
        threadId,
        type: SystemMessageType.GROUP_JOINED,
        subjectUserId: memberUserId,
      });
    await this.pushStateFeedDomains(result.allocated.keys());
  }

  async pushStateFeedDomains(domains: Iterable<string>): Promise<void> {
    for (const peerDomain of new Set(domains))
      this.eventEmitter.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
  }

  /** Converge locally authored relationship directions after an authenticated query denial. */
  async handleThreadQueryForbidden(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    expectedAuthorizationEpoch: number,
  ): Promise<
    | 'P2P_REVOKED'
    | 'P2P_ALREADY_CLOSED'
    | 'GROUP_REVOKED'
    | 'GROUP_ALREADY_CLOSED'
    | 'STALE'
  > {
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const endpoints = await tx.execute<{
        localUserId: number;
        remoteUserId: number;
      }>(sql`
        SELECT local_identity.id AS "localUserId",
          remote_identity.id AS "remoteUserId"
        FROM "RelationshipPair" pair
        JOIN "User" local_identity
          ON local_identity.domain = 'local'
         AND local_identity."namespaceId" = 0
         AND ((pair."endpointAType" = 'USER'
               AND pair."endpointAAccount" = local_identity.account
               AND pair."endpointADomain" = local_identity.domain)
           OR (pair."endpointBType" = 'USER'
               AND pair."endpointBAccount" = local_identity.account
               AND pair."endpointBDomain" = local_identity.domain))
        JOIN "User" remote_identity
          ON remote_identity.domain = ${peerDomain}
         AND remote_identity."namespaceId" = ${namespaceId}
         AND ((pair."endpointAType" = 'USER'
               AND pair."endpointAAccount" = remote_identity.account
               AND pair."endpointADomain" = remote_identity.domain)
           OR (pair."endpointBType" = 'USER'
               AND pair."endpointBAccount" = remote_identity.account
               AND pair."endpointBDomain" = remote_identity.domain))
        WHERE pair.kind = 'P2P'
          AND pair."threadId" = ${threadId}
          AND pair."endpointANamespaceId" = ${namespaceId}
          AND pair."endpointBNamespaceId" = ${namespaceId}
        LIMIT 1
      `);
      const endpoint = endpoints.rows[0];
      if (!endpoint) {
        const groupLocations = await tx.execute<{
          groupAccount: string;
          groupDomain: string;
        }>(sql`
          SELECT group_profile.account AS "groupAccount",
            group_profile.domain AS "groupDomain"
          FROM "MessageThread" thread
          JOIN "Group" group_profile ON group_profile.id = thread."groupId"
          WHERE thread.id = ${threadId}
            AND thread.type = 'GROUP'
          LIMIT 1
        `);
        const groupLocation = groupLocations.rows[0];
        if (!groupLocation) {
          const thread = await tx.query.messageThread.findFirst({
            where: eq(tables.messageThread.id, threadId),
            columns: { authorizationEpoch: true },
          });
          return {
            outcome:
              thread?.authorizationEpoch === expectedAuthorizationEpoch
                ? ('P2P_ALREADY_CLOSED' as const)
                : ('STALE' as const),
            allocated: new Map<string, bigint>(),
          };
        }

        await this.relationshipIntents.lockGroupBusinessScopeInTx(tx, {
          account: groupLocation.groupAccount,
          domain: groupLocation.groupDomain,
        });
        const lockedGroups = await tx.execute<{
          authorizationEpoch: number;
        }>(sql`
          SELECT thread."authorizationEpoch"
          FROM "MessageThread" thread
          JOIN "Group" group_profile ON group_profile.id = thread."groupId"
          WHERE thread.id = ${threadId}
            AND thread.type = 'GROUP'
            AND group_profile.account = ${groupLocation.groupAccount}
            AND group_profile.domain = ${groupLocation.groupDomain}
          FOR UPDATE OF group_profile, thread
        `);
        const lockedGroup = lockedGroups.rows[0];
        if (
          !lockedGroup ||
          lockedGroup.authorizationEpoch !== expectedAuthorizationEpoch
        ) {
          return {
            outcome: 'STALE' as const,
            allocated: new Map<string, bigint>(),
          };
        }

        const groupMembers = await tx.execute<{
          groupId: number;
          groupDomain: string;
          memberUserId: number;
        }>(sql`
          SELECT group_profile.id AS "groupId",
            group_profile.domain AS "groupDomain",
            member_identity.id AS "memberUserId"
          FROM "MessageThread" thread
          JOIN "Group" group_profile ON group_profile.id = thread."groupId"
          JOIN "RelationshipPair" pair
            ON pair."threadId" = thread.id
           AND pair.kind = 'GROUP_MEMBER'
           AND pair.active = true
          JOIN "User" member_identity
            ON ((pair."endpointAType" = 'USER'
                 AND pair."endpointAAccount" = member_identity.account
                 AND pair."endpointADomain" = member_identity.domain)
             OR (pair."endpointBType" = 'USER'
                 AND pair."endpointBAccount" = member_identity.account
                 AND pair."endpointBDomain" = member_identity.domain))
          WHERE thread.id = ${threadId}
            AND thread.type = 'GROUP'
            AND ((group_profile.domain = ${peerDomain}
                  AND group_profile."namespaceId" = ${namespaceId}
                  AND member_identity.domain = 'local'
                  AND member_identity."namespaceId" = 0)
              OR (group_profile.domain = 'local'
                  AND group_profile."namespaceId" = 0
                  AND member_identity.domain = ${peerDomain}
                  AND member_identity."namespaceId" = ${namespaceId}))
            AND pair."endpointANamespaceId" = ${namespaceId}
            AND pair."endpointBNamespaceId" = ${namespaceId}
          ORDER BY member_identity.id
        `);
        const members = groupMembers.rows;
        if (members.length === 0) {
          return {
            outcome: 'GROUP_ALREADY_CLOSED' as const,
            allocated: new Map<string, bigint>(),
          };
        }

        await this.relationshipCommands.lockGroupMutationInTx(
          tx,
          threadId,
          members[0]!.memberUserId,
          members.map((member) => member.memberUserId),
        );

        const allocated = new Map<string, bigint>();
        for (const member of members) {
          const written =
            member.groupDomain === 'local'
              ? await this.relationshipCommands.writeGroupRelationshipIntentInTx(
                  tx,
                  threadId,
                  member.memberUserId,
                  '',
                  'REVOKED',
                  clientFeedUpdates,
                )
              : await this.relationshipCommands.writeMemberRelationshipIntentInTx(
                  tx,
                  threadId,
                  member.memberUserId,
                  'REVOKED',
                  clientFeedUpdates,
                );
          for (const [domain, feedId] of written) allocated.set(domain, feedId);
        }
        return { outcome: 'GROUP_REVOKED' as const, allocated };
      }

      const relationship =
        await this.relationshipIntents.readP2PRelationshipInTx(
          tx,
          endpoint.localUserId,
          endpoint.remoteUserId,
        );
      const thread = await tx.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: { authorizationEpoch: true },
      });
      if (
        relationship.pair.threadId !== threadId ||
        thread?.authorizationEpoch !== expectedAuthorizationEpoch
      ) {
        return {
          outcome: 'STALE' as const,
          allocated: new Map<string, bigint>(),
        };
      }
      const positive = (status: string | undefined) =>
        status === 'REQUESTED' || status === 'ACCEPTED';
      if (
        !relationship.pair.active ||
        !positive(relationship.firstIntent?.status) ||
        !positive(relationship.secondIntent?.status)
      ) {
        return {
          outcome: 'P2P_ALREADY_CLOSED' as const,
          allocated: new Map<string, bigint>(),
        };
      }
      const allocated = await this.relationshipCommands.writeFriendIntentInTx(
        tx,
        endpoint.localUserId,
        endpoint.remoteUserId,
        false,
        '',
        clientFeedUpdates,
      );
      return { outcome: 'P2P_REVOKED' as const, allocated };
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    await this.pushStateFeedDomains(result.allocated.keys());
    return result.outcome;
  }

  /** Materialize expired directions authored by this server as durable revocations. The expiry
   * boundary itself remains authoritative; this sweep only makes the already-effective negative
   * state explicit so clients and peers converge without retaining stale REQUESTED snapshots. */
  async revokeExpiredLocalRequests(): Promise<number> {
    const pendingClientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const expired = await tx.execute<{
        pairId: bigint;
        authorSide: 'A' | 'B';
        kind: 'P2P' | 'GROUP_MEMBER';
        authorAccount: string;
        authorDomain: string;
        authorNamespaceId: number;
        subjectAccount: string;
        subjectDomain: string;
        subjectNamespaceId: number;
        threadId: number | null;
      }>(sql`
        SELECT intent."pairId", intent."authorSide", pair.kind, pair."threadId",
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
      const allocated = new Map<string, bigint>();
      let count = 0;
      for (const request of expired.rows) {
        await tx.execute(sql`
          SELECT id FROM "RelationshipPair" WHERE id = ${request.pairId}
          FOR UPDATE
        `);
        const updated = await tx.execute(sql`
          UPDATE "RelationshipIntent"
          SET status = 'REVOKED', note = '', "requestedAt" = NULL,
            "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "pairId" = ${request.pairId}
            AND "authorSide" = ${request.authorSide}
            AND status = 'REQUESTED' AND "expiresAt" <= CURRENT_TIMESTAMP
          RETURNING 1
        `);
        if ((updated.rowCount ?? 0) === 0) continue;
        count += 1;
        if (request.kind === 'GROUP_MEMBER' && request.threadId !== null) {
          const [groupState, member] = await Promise.all([
            tx.query.group.findFirst({
              where: and(
                eq(
                  tables.group.account,
                  request.authorSide === 'A'
                    ? request.authorAccount
                    : request.subjectAccount,
                ),
                eq(
                  tables.group.domain,
                  request.authorSide === 'A'
                    ? request.authorDomain
                    : request.subjectDomain,
                ),
              ),
              columns: { id: true, domain: true },
            }),
            tx.query.user.findFirst({
              where: and(
                eq(
                  tables.user.account,
                  request.authorSide === 'B'
                    ? request.authorAccount
                    : request.subjectAccount,
                ),
                eq(
                  tables.user.domain,
                  request.authorSide === 'B'
                    ? request.authorDomain
                    : request.subjectDomain,
                ),
                eq(
                  tables.user.sourceDomain,
                  request.authorSide === 'B'
                    ? request.authorDomain
                    : request.subjectDomain,
                ),
              ),
              columns: { id: true },
            }),
          ]);
          if (!groupState || !member)
            throw new Error('expired group relationship endpoint missing');
          await this.groupRelationships.syncActiveInTx(tx, {
            threadId: request.threadId,
            groupId: groupState.id,
            memberUserId: member.id,
            active: false,
            hostedLocally: groupState.domain === 'local',
          });
          if (groupState.domain === 'local')
            await this.relationshipCommands.writeGroupRequestEffectsInTx(
              tx,
              request.threadId,
              groupState.id,
              member.id,
              pendingClientFeedUpdates,
              'REVOKED',
              request.authorSide === 'A' ? 'INVITATION' : 'APPLICATION',
              false,
            );
          if (request.authorSide === 'B' || request.subjectDomain === 'local')
            await this.invite.writeGroupRequestClientStateInTx(
              tx,
              request.threadId,
              member.id,
              pendingClientFeedUpdates,
            );
        } else if (request.kind === 'P2P') {
          const [author, subject] = await Promise.all([
            this.ensureForeignUserInTransaction(
              tx,
              request.authorAccount,
              request.authorDomain,
              request.authorNamespaceId,
            ),
            this.ensureForeignUserInTransaction(
              tx,
              request.subjectAccount,
              request.subjectDomain,
              request.subjectNamespaceId,
            ),
          ]);
          await this.relationshipIntents.setPairActiveInTx(
            tx,
            author,
            subject,
            false,
          );
          pendingClientFeedUpdates.push(
            ...(await this.invite.writeFriendRequestClientStateInTx(
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
            domain: this.config.domain,
            subjectAccount: request.subjectAccount,
            subjectDomain: request.subjectDomain,
            eventType: 'RELATIONSHIP_INTENT',
            body: {
              status: 'REVOKED',
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

  /** Transactional authoritative GROUP_META + group PROFILE snapshot writer. */
  async writeGroupStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    return this.profileStatePublisher.writeGroupStateInTx(
      tx,
      threadId,
      clientFeedUpdates,
    );
  }

  /** Public profile of a local user (GET /s2s/v1/users/:account). Null if not local / not found. */
  async getLocalUserProfile(address: S2SAddress): Promise<S2SProfile | null> {
    if (address.domain !== this.config.domain) return null;
    const u = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(address.account)),
        eq(tables.user.domain, 'local'),
        eq(tables.user.namespaceId, 0),
      ),
    });
    if (!u || u.domain !== 'local') return null;
    return this.toS2SProfile(u);
  }

  /** Find or create a foreign User stub for account@<peer-domain>. Stubs never authenticate. */
  async ensureForeignUser(
    account: string,
    domain: string,
    namespaceId: number,
  ): Promise<number> {
    return this.database.db.transaction((tx) =>
      this.ensureForeignUserInTransaction(tx, account, domain, namespaceId),
    );
  }

  private async ensureForeignUserInTransaction(
    tx: DatabaseTransaction,
    account: string,
    domain: string,
    namespaceId: number,
  ): Promise<number> {
    const acct = normalizeAccount(account);
    const existing = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.account, acct),
        eq(tables.user.domain, domain),
        eq(tables.user.sourceDomain, domain),
        eq(tables.user.namespaceId, namespaceId),
      ),
      columns: { id: true },
    });
    if (existing) return existing.id;
    return upsertSourceUserInTx(tx, {
      account: acct,
      domain,
      sourceDomain: domain,
      namespaceId,
      name: acct,
      profileRev: 0,
    });
  }

  /**
   * Resolve-on-demand safety net for send-friend-request: ensure a foreign stub has been localized
   * (profile pulled) at least once. No-op if already localized (remoteUpdatedAt set). If the caller
   * addresses a foreign user by id without a prior resolve (so the stub is a bare account), pull the
   * profile now. Throws on peer failure so the controller surfaces FEDERATION_DELIVERY_FAILED (the
   * subsequent send would fail against the same peer anyway).
   */
  async ensureForeignUserLocalized(
    userId: number,
    address: S2SAddress,
  ): Promise<void> {
    const peerToken = await this.capturePeerResponseToken(address.domain);
    const profile = await this.fetchRemoteUser(address);
    await this.localizeForeignProfile(userId, profile, { peerToken });
  }

  /** Sign + synchronously POST an arbitrary JSON body to a peer S2S path (`${base}${path}`). The single
   *  signed-POST entry for every outbound S2S op — friend-request / friend-approve (Step 1) AND the
   *  discovery HWM push. Same liveness/degradation wiring as getSigned. */
  private async postSigned(
    path: string,
    body: string,
    peerDomain: string,
  ): Promise<void> {
    await this.peerHttp().post(path, body, peerDomain);
  }

  /**
   * Shared signed-POST transport: sign the (method, path, authority, body) tuple, POST, and apply the
   * lifecycle wiring: network failure/503 degrades, a registered fatal 409 halts, and all HTTP 200
   * business outcomes leave lifecycle unchanged.
   */
  private async sendSignedPost(
    url: URL,
    body: string,
    peerDomain: string,
  ): Promise<void> {
    await this.peerHttp().postUrl(url, body, peerDomain);
  }

  /** GET a signed S2S endpoint (users / revision). Returns the parsed JSON. Throws on non-success. */
  private async getSigned<T>(
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<T> {
    return this.peerHttp().get<T>(path, peerDomain, maxResponseBytes);
  }

  private peerHttp(): FederationPeerHttp {
    return new FederationPeerHttp(
      this.signature,
      this.discovery,
      this.recognition,
      this.transportConfig,
      {
        isFatalPeerCode: (code): code is number => this.isFatalPeerCode(code),
        markContactSuccess: (domain) => this.markContactSuccess(domain),
        markPeerHalted: (domain, code, message) =>
          this.markPeerHalted(domain, code, message),
      },
    );
  }

  // ─── bidirectional server recognition ─────────────────────────────────────────

  /**
   * Establish or recover the two directional recognition facts before ordinary data-plane traffic.
   */
  async ensurePeerTrusted(domain: string): Promise<void> {
    await this.peerLifecycle.ensureTrusted(domain);
  }

  /**
   * Recover one reconnect-sweep candidate without confusing availability with identity bootstrap.
   * Retry missing Recognize facts or a degraded transport without replacing the pinned root.
   */
  async recoverPeerTrust(domain: string): Promise<void> {
    await this.peerLifecycle.recoverTrust(domain);
  }

  /** Whether mutual recognition with a peer domain is already available — a pure local lookup with no
   *  network or side effects. Our own domain always reads available because it is a local lookup.
   *
   *  Used by the user-facing pre-flight (POST /user/peer-trust-status) so the client can tell
   *  FIRST-CONTACT — a handshake IS expected during the upcoming resolve, so show a "Connecting to
   *  <domain>…" affordance — from an already-trusted resolve (fast, no banner). This is a known
   *  server-side fact, NOT a latency guess: the rare already-trusted-but-failing case (the peer reset
   *  its server and lost the prior handshake) is rejected by identity verification inside the resolve
   *  and surfaces as an error there, not here. */
  async isPeerTrusted(domain: string): Promise<boolean> {
    return this.peerLifecycle.isTrusted(domain);
  }

  // ─── trust lifecycle (state machine + audit log) ──────────────────────────────
  //
  // FederatedPeer holds the CURRENT state (the cheap read path); FederatedPeerEvent is the append-only
  // log of every transition (the admin timeline). FederationService is the single owner: every
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

  /** Compatibility wrapper for callers that observed a successful signed round trip. */
  async markRecovered(domain: string): Promise<void> {
    await this.peerLifecycle.markRecovered(domain);
  }

  private isFatalPeerCode(code: unknown): code is number {
    return this.peerLifecycle.isFatalCode(code);
  }

  private async markPeerHalted(
    domain: string,
    code: number,
    message: unknown,
  ): Promise<void> {
    await this.peerLifecycle.markHalted(domain, code, message);
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
  ): Promise<{ domain: string; trustLevel: 'degraded' }> {
    return this.peerLifecycle.manuallyRecoverPinnedIdentity(
      peerDomain,
      confirmDomain,
    );
  }

  /** POST /s2s/v1/call — deliver ONE ephemeral WebRTC call frame (ring / lifecycle / SDP-ICE relay)
   *  to the peer server hosting the call's other participant. Awaitable so the caller's `initiate` can
   *  detect a ring failure (→ the `unreachable` terminal bubble). The persisted CALL record rides the
   *  pull-based message sync, NOT this frame. `peerDomain` is the server hosting the foreign participant. */
  async sendCallFrame(
    params: OutboundCallFrameParams,
    peerDomain: string,
  ): Promise<void> {
    await this.callDelivery.send(params, peerDomain, (frame, domain) =>
      this.postCallFrame(frame, domain),
    );
  }

  private async postCallFrame(
    params: OutboundCallFrameParams,
    peerDomain: string,
  ): Promise<void> {
    const base = {
      callSid: params.callSid,
      callType: params.callType,
    };
    let frame: S2SCallFrame;
    if (params.op === 'incoming') {
      const from = await this.requireLocalUser(params.fromLocalUserId);
      frame = {
        ...base,
        op: 'incoming',
        payload: {
          fromAccount: from.account,
          toAccount: params.to.account,
        },
      };
    } else if (params.op === 'signal') {
      const signalPayload = {
        signalId: params.signalId,
        signalType: params.signalType,
        data: params.data,
      };
      frame = {
        ...base,
        op: 'signal',
        payload: signalPayload as CallSignalPayload,
      };
    } else if (params.op === 'connected') {
      frame = {
        ...base,
        op: 'connected',
        payload: { startedAt: params.startedAt },
      };
    } else if (params.op === 'ended') {
      frame = {
        ...base,
        op: 'ended',
        payload: { endReason: params.endReason },
      };
    } else if (params.op === 'video-upgraded') {
      frame = { ...base, op: 'video-upgraded', callType: 'VIDEO' };
    } else {
      frame = { ...base, op: params.op };
    }
    await this.postSigned(
      '/s2s/v1/call',
      JSON.stringify(toS2SCallWireFrame(frame)),
      peerDomain,
    );
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
      (await this.database.db.query.user.findFirst({
        where: and(
          eq(tables.user.account, normalizeAccount(account)),
          eq(tables.user.domain, domain),
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
        groupId: tables.messageThread.groupId,
        group: {
          account: tables.group.account,
          domain: tables.group.domain,
          dissolvedAt: tables.group.dissolvedAt,
        },
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.group,
        eq(tables.group.id, tables.messageThread.groupId),
      )
      .where(eq(tables.group.account, normalizeAccount(groupAccount)))
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
    const frame = parseS2SCallWireFrame(body);
    if (frame.op !== 'incoming') {
      await this.eventEmitter.emitAsync('call.frame.inbound', {
        peerDomain,
        namespaceId,
        signatureExpiresAtSec,
        frame,
      });
      return;
    }
    await this.callInboundLocks.runExclusive(
      JSON.stringify([peerDomain, namespaceId, frame.callSid]),
      async () =>
        this.handleInboundIncoming(
          frame,
          peerDomain,
          namespaceId,
          signatureExpiresAtSec,
        ),
    );
  }

  private async handleInboundIncoming(
    body: Extract<S2SCallFrame, { op: 'incoming' }>,
    peerDomain: string,
    namespaceId: number,
    signatureExpiresAtSec: number,
  ): Promise<void> {
    const preflight = await this.eventEmitter.emitAsync(
      'call.frame.incoming.preflight',
      { peerDomain, namespaceId, frame: body },
    );
    if (preflight?.some((handled) => handled === true)) return;
    const terminal = await this.database.db.query.callTombstone.findFirst({
      where: and(
        eq(tables.callTombstone.peerDomain, peerDomain),
        eq(tables.callTombstone.namespaceId, namespaceId),
        eq(tables.callTombstone.callSid, body.callSid),
        gt(tables.callTombstone.expiresAt, new Date()),
      ),
      columns: { terminalOp: true },
    });
    if (terminal) {
      throw new BusinessException(
        terminal.terminalOp === 'cancelled'
          ? BusinessCode.CALL_CANCELLED
          : BusinessCode.CALL_TERMINATED,
        terminal.terminalOp === 'cancelled'
          ? 'call was already cancelled'
          : 'call was already terminated',
        HttpStatus.OK,
      );
    }
    await this.quota.peek(peerDomain, 'requests');
    const peerStubId = await this.ensureForeignUser(
      body.payload.fromAccount,
      peerDomain,
      namespaceId,
    );
    const localUserId = await this.findLocalUserIdByAddress({
      account: body.payload.toAccount,
      domain: this.config.domain,
    });
    if (localUserId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${body.payload.toAccount} not found`,
      );
    }
    const threadId = await this.participantService.findP2PThreadBetween(
      localUserId,
      peerStubId,
    );
    if (threadId === null) {
      throw new BusinessException(
        BusinessCode.CALL_NOT_ALLOWED,
        'no relationship with caller',
      );
    }
    await this.eventEmitter.emitAsync('call.frame.inbound', {
      localUserId,
      peerStubId,
      peerDomain,
      namespaceId,
      signatureExpiresAtSec,
      threadId,
      frame: body,
    });
  }

  /** Group writes are gated exclusively by locally converged state. */
  async assertGroupWritable(threadId: number): Promise<void> {
    const [state] = await this.database.db
      .select({ dissolvedAt: tables.group.dissolvedAt })
      .from(tables.messageThread)
      .innerJoin(
        tables.group,
        eq(tables.group.id, tables.messageThread.groupId),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (state?.dissolvedAt) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
  }

  /** P2P writes are gated exclusively by locally converged state. No synchronous peer query is allowed
   * on the message-send path. */
  async assertP2PWritable(
    threadId: number,
    localUserId: number,
  ): Promise<void> {
    if (
      !(await isThreadMutuallyAuthorized(
        this.database.db,
        localUserId,
        threadId,
      ))
    ) {
      throw new BusinessException(BusinessCode.FRIEND_NOT_FOUND, 'not friends');
    }
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

  /**
   * Unified pre-flight for every Step 2 outbound op: ensure trust is current BEFORE running, so a
   * degraded/halted peer is caught up front (not only after a failure). The op itself (sendSignedPost
   * / getSigned) already calls markTransportDegraded on failure → self-heal on the next reconnect-sweep tick.
   * Throws FEDERATION_PEER_BLOCKED if the peer is admin-blocked.
   */
  private async withTrustedPeer<T>(
    domain: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.ensurePeerTrusted(domain);
    try {
      return await fn();
    } catch (error) {
      // A peer restart can make both sides mark each other degraded: its startup pull reaches us while we
      // its recognition facts are incomplete, so it receives FEDERATION_RECOGNITION_REQUIRED.
      // Only this explicit trust-state response is recoverable here. The pinned-identity signed
      // heartbeat restores mutual reachability, after which the original operation is tried once.
      // Other 401/403 responses (bad signatures, identity changes, admin policy) remain terminal.
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.FEDERATION_RECOGNITION_REQUIRED
      ) {
        await this.recoverPeerTrust(domain);
        return fn();
      }
      throw error;
    }
  }

  /**
   * Start one thread-bound S2S read. Capturing the active namespace pins the peer identity context
   * for this operation, while the thread authorization version travels with the response and is
   * rechecked before any returned data may be persisted.
   */
  private async getSignedForThread<T>(
    threadId: number,
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<{ data: T; federationVersion: number }> {
    const federationVersion = await this.readThreadFederationVersion(
      threadId,
      peerDomain,
    );
    try {
      const data = await this.withTrustedPeer(peerDomain, () =>
        this.getSigned<T>(path, peerDomain, maxResponseBytes),
      );
      return { data, federationVersion };
    } catch (error) {
      if (error instanceof S2sResponseError) {
        error.federationVersion = federationVersion;
      }
      throw error;
    }
  }

  private async readThreadFederationVersion(
    threadId: number,
    peerDomain: string,
  ): Promise<number> {
    return this.database.db.transaction(async (tx) => {
      await this.namespaces.captureActiveInTx(tx, peerDomain);
      const [state] = await tx
        .select({
          federationVersion: tables.messageThread.federationVersion,
        })
        .from(tables.messageThread)
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      if (!state) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          `federation thread ${threadId} is unavailable for ${peerDomain}`,
        );
      }
      return state.federationVersion;
    });
  }

  private async assertThreadResponseWritable(
    tx: DatabaseTransaction,
    threadId: number,
    peerDomain: string,
    expectedFederationVersion: number,
  ): Promise<void> {
    const [state] = await tx
      .select({
        federationVersion: tables.messageThread.federationVersion,
      })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!state || state.federationVersion !== expectedFederationVersion) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation response for thread ${threadId} from ${peerDomain}`,
      );
    }
  }

  async capturePeerResponseToken(domain: string): Promise<PeerResponseToken> {
    return this.namespaces.captureActive(domain);
  }

  private async assertPeerResponseWritable(
    tx: DatabaseTransaction,
    token: PeerResponseToken,
  ): Promise<void> {
    await this.namespaces.requireCapturedInTx(tx, token);
  }

  /** Lightweight, ephemeral discovery wake-up. The receiver never persists this advertised HWM. */
  async pushDiscoveryHwm(domain: string): Promise<void> {
    const context = await this.capturePeerResponseToken(domain);
    const stateFeedEndId = await this.stateFeed.readFeedEndId(
      context.namespaceId,
    );
    await this.postSigned(
      '/s2s/v1/feed-heads',
      JSON.stringify({
        stateFeedEndId: stateFeedEndId.toString(),
      }),
      domain,
    );
  }

  /** Rebuild compacted thread heads after startup/reconnect before publishing the State Feed HWM. */
  async rebuildAndPushDiscoveryHwm(domain: string): Promise<void> {
    await this.threadContentHeads.fill(domain);
    await this.pushDiscoveryHwm(domain);
  }

  private mapFeedCursorUnavailable(error: unknown): Error {
    if (
      error instanceof S2sResponseError &&
      error.code === BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE
    ) {
      const data = error.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        Object.keys(data).length === 2 &&
        Object.hasOwn(data, 'resumeAfter') &&
        Object.hasOwn(data, 'resumeBefore')
      ) {
        const cursor = data as {
          resumeAfter?: unknown;
          resumeBefore?: unknown;
        };
        if (
          typeof cursor.resumeAfter === 'string' &&
          /^(0|[1-9]\d*)$/.test(cursor.resumeAfter) &&
          typeof cursor.resumeBefore === 'string' &&
          /^(0|[1-9]\d*)$/.test(cursor.resumeBefore)
        ) {
          return new RemoteFeedCursorUnavailableError(
            BigInt(cursor.resumeAfter),
            BigInt(cursor.resumeBefore),
          );
        }
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  async pullStateFeedPage(
    domain: string,
    after?: bigint,
    take?: number,
    through?: bigint,
  ): Promise<PeerStateFeedPage> {
    if (
      (after === undefined && (take !== undefined || through !== undefined)) ||
      (after !== undefined && after < 0n) ||
      (after !== undefined && through !== undefined && through < after) ||
      (take !== undefined &&
        (!Number.isInteger(take) || take < 1 || take > 200))
    )
      throw new Error('invalid state feed cursor/page size');
    const query = new URLSearchParams();
    if (after !== undefined) query.set('after', after.toString());
    if (take !== undefined) query.set('take', take.toString());
    if (through !== undefined) query.set('through', through.toString());
    try {
      return await this.withTrustedPeer(domain, () =>
        this.getSigned<PeerStateFeedPage>(
          `/s2s/v1/state-feed${query.size === 0 ? '' : `?${query.toString()}`}`,
          domain,
          16 * 1024 * 1024,
        ),
      );
    } catch (error) {
      throw this.mapFeedCursorUnavailable(error);
    }
  }

  private async pullGroupMetaFeed(
    domain: string,
    account: string,
    mode: 'full' | 'delta',
    after: bigint,
    fixedThrough?: bigint,
  ): Promise<GroupMetaFeedPage> {
    let cursor = after;
    let through = fixedThrough;
    const items: GroupMetaFeedPage['items'] = [];
    for (;;) {
      const requestedAfter = cursor;
      const query = new URLSearchParams({
        account,
        mode,
        after: cursor.toString(),
        take: '100',
      });
      if (through !== undefined) query.set('through', through.toString());
      let page: GroupMetaFeedPage;
      try {
        page = await this.withTrustedPeer(domain, () =>
          this.getSigned<GroupMetaFeedPage>(
            `/s2s/v1/group-meta?${query.toString()}`,
            domain,
            16 * 1024 * 1024,
          ),
        );
      } catch (error) {
        if (
          mode === 'delta' &&
          error instanceof S2sResponseError &&
          error.code === BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE
        ) {
          const recovery = error.data as {
            resumeAfter?: unknown;
            resumeBefore?: unknown;
          };
          if (
            typeof recovery?.resumeAfter !== 'string' ||
            !/^(0|[1-9]\d*)$/.test(recovery.resumeAfter) ||
            typeof recovery.resumeBefore !== 'string' ||
            !/^[1-9]\d*$/.test(recovery.resumeBefore) ||
            BigInt(recovery.resumeBefore) <= BigInt(recovery.resumeAfter)
          )
            throw new Error('invalid group-meta recovery window');
          this.logger.warn(
            `group-meta cursor for ${account}@${domain} is unavailable; rebuilding from ${recovery.resumeAfter} through ${(BigInt(recovery.resumeBefore) - 1n).toString()}`,
          );
          return this.pullGroupMetaFeed(
            domain,
            account,
            'full',
            BigInt(recovery.resumeAfter),
            BigInt(recovery.resumeBefore) - 1n,
          );
        }
        throw error;
      }
      if (
        page.account !== account ||
        page.mode !== mode ||
        !/^(0|[1-9]\d*)$/.test(page.scannedThrough) ||
        !/^(0|[1-9]\d*)$/.test(page.groupMetaFeedEndId)
      )
        throw new Error('invalid group-meta page');
      const scannedThrough = BigInt(page.scannedThrough);
      const pageEnd = BigInt(page.groupMetaFeedEndId);
      if (through === undefined) through = pageEnd;
      if (scannedThrough < cursor || scannedThrough > through)
        throw new Error('invalid group-meta scan boundary');
      items.push(...page.items);
      cursor = scannedThrough;
      if (!page.hasMore) {
        if (cursor !== through)
          throw new Error('incomplete group-meta bounded drain');
        return {
          account,
          mode,
          items,
          scannedThrough: cursor.toString(),
          groupMetaFeedEndId: page.groupMetaFeedEndId,
          hasMore: false,
        };
      }
      if (cursor === requestedAfter)
        throw new Error('group-meta pagination made no progress');
    }
  }

  private async prefetchGroupMetaFeeds(
    domain: string,
    namespaceId: number,
    page: PeerStateFeedPage,
  ): Promise<Map<string, GroupMetaFeedPage>> {
    const result = new Map<string, GroupMetaFeedPage>();
    for (const item of page.items) {
      if (item.eventType !== 'GROUP_META_FEED_HEAD') continue;
      const groupMetaFeedEndId = (item.body as { groupMetaFeedEndId?: unknown })
        ?.groupMetaFeedEndId;
      if (
        typeof groupMetaFeedEndId !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(groupMetaFeedEndId)
      )
        throw new Error('invalid GROUP_META_FEED_HEAD body');
      const mirror = await this.database.db
        .select({
          remoteGroupMetaFeedId: tables.group.remoteGroupMetaFeedId,
        })
        .from(tables.group)
        .where(
          and(
            eq(tables.group.account, item.account),
            eq(tables.group.domain, domain),
            eq(tables.group.namespaceId, namespaceId),
          ),
        )
        .limit(1);
      const current = mirror[0]?.remoteGroupMetaFeedId;
      if (
        current !== null &&
        current !== undefined &&
        current >= BigInt(groupMetaFeedEndId)
      )
        continue;
      result.set(
        item.account,
        await this.pullGroupMetaFeed(
          domain,
          item.account,
          current === null || current === undefined ? 'full' : 'delta',
          current ?? 0n,
        ),
      );
    }
    return result;
  }

  /** State is always drained before callers start data feeds. When a lightweight hint supplies a
   * required revision, returning successfully is a durable barrier: the state cursor reached it. */
  async pullStateFromPeer(
    domain: string,
    requiredRevision?: bigint,
  ): Promise<bigint> {
    const context = await this.capturePeerResponseToken(domain);
    if (requiredRevision !== undefined) {
      this.stateFeedPull.advertise(
        domain,
        context.namespaceId,
        requiredRevision,
      );
    }
    const changed = new WeakMap<PeerStateFeedPage, StatePageEffect>();
    const groupMetaPages = new WeakMap<
      PeerStateFeedPage,
      Map<string, GroupMetaFeedPage>
    >();
    const groupMetaPagesByFeedId = new Map<
      string,
      Map<string, GroupMetaFeedPage>
    >();
    const drainClientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    await this.stateFeedPull.run(domain, context.namespaceId, {
      // The first page captures a source end; the pull worker freezes that as
      // `through` for the rest of this drain. A newer hint starts another fixed
      // drain after this one, so a replay never races a moving source head.
      fetch: async (after, through) => {
        const page = await this.pullStateFeedPage(
          domain,
          after,
          after === undefined ? undefined : 100,
          through,
        );
        const prefetched = await this.prefetchGroupMetaFeeds(
          domain,
          context.namespaceId,
          page,
        );
        groupMetaPages.set(page, prefetched);
        for (const item of page.items)
          groupMetaPagesByFeedId.set(item.feedId, prefetched);
        return page;
      },
      // A corrected state cursor is a full replay, not an incremental
      // continuation. Forget every per-group cursor atomically with accepting
      // the publisher's resume point so each subsequently advertised group is
      // fetched from its retained history.
      beginRebuild: async (tx) => {
        await tx.execute(sql`
          UPDATE "Group" mirror_group
          SET "remoteGroupMetaFeedId" = NULL, "updatedAt" = NOW()
          WHERE mirror_group.domain = ${domain}
            AND mirror_group."namespaceId" = ${context.namespaceId}
        `);
      },
      apply: async (tx, page) => {
        changed.set(
          page,
          await this.stateFeedConsumer.applyPageInTx(
            tx,
            domain,
            context.namespaceId,
            page,
            groupMetaPages.get(page) ??
              groupMetaPagesByFeedId.get(page.items[0]?.feedId ?? ''),
          ),
        );
      },
      afterCommit: async (page) => {
        const effect = changed.get(page) ?? {
          clientFeedUpdates: [],
          statePushDomains: [],
          localSystemMessages: [],
          threadRoundWakes: [],
        };
        drainClientFeedUpdates.push(...effect.clientFeedUpdates);
        await this.pushStateFeedDomains(effect.statePushDomains);
        for (const status of effect.localSystemMessages)
          await this.publishLocalSystemMessage(status);
        for (const wake of effect.threadRoundWakes)
          this.eventEmitter.emit(FEDERATION_THREAD_ROUND_WAKE, wake);
        const feedId = page.items[0]?.feedId;
        if (feedId !== undefined) groupMetaPagesByFeedId.delete(feedId);
      },
      afterDrain: async () => {
        this.clientStateFeed.notifyFeedUpdates(drainClientFeedUpdates);
      },
    });
    const cursor = await this.readStatePullCursor(domain, context.namespaceId);
    if (requiredRevision !== undefined && cursor < requiredRevision) {
      throw new Error(
        `state feed for ${domain} stopped at ${cursor.toString()} before required revision ${requiredRevision.toString()}`,
      );
    }
    return cursor;
  }

  private async readStatePullCursor(
    domain: string,
    namespaceId: number,
  ): Promise<bigint> {
    const row = await this.database.db.query.peerStateFeedPullCursor.findFirst({
      where: eq(tables.peerStateFeedPullCursor.namespaceId, namespaceId),
      columns: { committedThrough: true },
    });
    if (!row) throw new Error(`peer ${domain} has no state-feed pull cursor`);
    return row.committedThrough;
  }

  /** Materialize a stable address-derived identity shell. PROFILE is ordered after the confirming
   * ACCEPTED, so the initial row intentionally contains placeholders and is filled by a later
   * verified PROFILE item in the same or a subsequent drain. */

  /** Ensure an incoming federated group request has a structurally complete retained conversation.
   * RelationshipIntent remains the sole authorization source, and no client state entry is published
   * until the user accepts the request. */

  /** Publish a server-local timeline notice only after its state transaction commits. */
  private async publishLocalSystemMessage(status: {
    actorUserId: number;
    threadId: number;
    type: SystemMessageType;
    subjectUserId?: number;
    message?: PublicMessage;
    recipientUserIds?: number[];
  }): Promise<void> {
    if (status.message && status.recipientUserIds) {
      for (const recipientUserId of status.recipientUserIds)
        this.sse.onNewMessage(
          recipientUserId,
          status.threadId,
          status.message.seq,
          status.message.createdAt.getTime(),
        );
      return;
    }
    const message = await this.message.tryWriteSystemMessage(
      status.threadId,
      status.type,
      status.subjectUserId,
      {
        actorUserId: status.actorUserId,
        recipientUserIds: status.recipientUserIds,
      },
    );
    if (!message) return;
    try {
      const recipients = status.recipientUserIds
        ? status.recipientUserIds.map((userId) => ({ userId, blocked: false }))
        : await this.participantService.getActiveParticipantUserIds(
            status.threadId,
          );
      for (const recipient of recipients) {
        if (
          !recipient.blocked &&
          (status.recipientUserIds !== undefined ||
            recipient.userId !== status.actorUserId)
        )
          this.sse.onNewMessage(
            recipient.userId,
            status.threadId,
            message.seq,
            message.createdAt.getTime(),
          );
      }
    } catch (error) {
      this.logger.error(
        `failed to publish local system message ${status.type} for thread ${status.threadId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /** Refresh every local-origin group source that exposes this member. */

  /** A member profile change is a group-meta semantic change and therefore advances the same group
   * revision used by roster mutations before publishing the compacted member projection. */

  async fetchThreadResource<T>(
    threadId: number,
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<FederationThreadResourceResponse<T>> {
    const peerToken = await this.capturePeerResponseToken(peerDomain);
    const response = await this.getSignedForThread<T>(
      threadId,
      path,
      peerDomain,
      maxResponseBytes,
    );
    return {
      ...response,
      threadId,
      peerDomain,
      peerToken,
    };
  }

  async assertThreadResourceResponseWritableInTransaction(
    tx: DatabaseTransaction,
    response: FederationThreadResourceResponse<unknown>,
  ): Promise<void> {
    await this.assertPeerResponseWritable(tx, response.peerToken);
    await this.assertThreadResponseWritable(
      tx,
      response.threadId,
      response.peerDomain,
      response.federationVersion,
    );
  }

  async applyReverseMessagePage(params: {
    response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    before: number;
    through?: number;
    prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
  }): Promise<void> {
    const effects = await this.database.db.transaction(async (tx) => {
      return this.applyReverseMessagePageInTransaction(tx, params);
    });
    await effects.publish();
  }

  async applyReverseMessagePageInTransaction(
    tx: DatabaseTransaction,
    params: {
      response: FederationThreadResourceResponse<FederationMessageQueryPage>;
      before: number;
      through?: number;
      prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
    },
  ): Promise<{ publish: () => Promise<void> }> {
    await this.assertThreadResourceResponseWritableInTransaction(
      tx,
      params.response,
    );
    const effects = await this.applyMessageQueryItemsInTransaction(
      tx,
      params.response.peerDomain,
      params.response.data.messages,
      params.response.peerToken,
      {
        prefetchedForwardClosures: params.prefetchedForwardClosures,
        sequencePolicy: {
          kind: 'PRESERVE_ORIGIN',
          beforeSeq: params.before,
          ...(params.through === undefined
            ? {}
            : { throughSeq: params.through }),
        },
        expectedThreadId: params.response.threadId,
        historical: true,
      },
    );
    return {
      publish: () =>
        this.publishMessageQueryEffects(params.response.peerDomain, effects),
    };
  }

  /** Publish one fully fetched reverse interval inside the caller's epoch-CAS transaction. */
  async finalizeReverseMessageWindowInTransaction(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      peerDomain: string;
      namespaceId: number;
      beforeSeq: number;
      throughSeq: number;
    },
  ): Promise<void> {
    const staged = await tx.query.message.findMany({
      where: and(
        eq(tables.message.threadId, params.threadId),
        eq(tables.message.federationSourceDomain, params.peerDomain),
        eq(tables.message.localState, 'STUB'),
        sql`${tables.message.originSeq} >= ${params.throughSeq}`,
        sql`${tables.message.originSeq} < ${params.beforeSeq}`,
      ),
      orderBy: asc(tables.message.seq),
    });
    let tombstoneEndSeq: number | null = null;
    for (const item of staged) {
      if (item.originSeq === null) {
        throw new Error('reverse STUB has no publisher sequence');
      }
      if (item.creatorAccount === null || item.creatorDomain === null) {
        throw new Error('reverse STUB has no federated author');
      }
      if (!item.isDeleted) continue;

      const pendingTombstone =
        await tx.query.federatedMessageTombstone.findFirst({
          where: and(
            eq(tables.federatedMessageTombstone.threadId, params.threadId),
            eq(
              tables.federatedMessageTombstone.sourceDomain,
              params.peerDomain,
            ),
            eq(tables.federatedMessageTombstone.messageSeq, item.originSeq),
          ),
          columns: { type: true, sourceDomain: true },
        });
      let deletionSeq: number | null = null;
      if (pendingTombstone) {
        const deletion = await DeletedMessageService.ensureFactInTx(tx, {
          threadId: params.threadId,
          messageSeq: item.seq,
          type: pendingTombstone.type,
          federationSourceDomain: pendingTombstone.sourceDomain,
          updatedAt: new Date(),
        });
        deletionSeq = deletion.deletionSeq;
        await tx
          .delete(tables.federatedMessageTombstone)
          .where(
            and(
              eq(tables.federatedMessageTombstone.threadId, params.threadId),
              eq(
                tables.federatedMessageTombstone.sourceDomain,
                params.peerDomain,
              ),
              eq(tables.federatedMessageTombstone.messageSeq, item.originSeq),
            ),
          );
      } else {
        const existing = await tx.query.deletedMessage.findFirst({
          where: and(
            eq(tables.deletedMessage.threadId, params.threadId),
            eq(tables.deletedMessage.messageSeq, item.seq),
          ),
          columns: { deletionSeq: true },
        });
        if (!existing) {
          throw new Error('deleted reverse STUB has no tombstone fact');
        }
        deletionSeq = existing.deletionSeq;
      }
      tombstoneEndSeq = Math.max(tombstoneEndSeq ?? deletionSeq, deletionSeq);
    }
    if (tombstoneEndSeq !== null) {
      await ClientMessageFeedWriter.publishTombstone(
        tx,
        params.threadId,
        tombstoneEndSeq,
      );
    }
    await tx.execute(sql`
      UPDATE "Message" staged
      SET "localState" = 'READY', "updatedAt" = CURRENT_TIMESTAMP
      WHERE staged."threadId" = ${params.threadId}
        AND staged."federationSourceDomain" = ${params.peerDomain}
        AND staged."localState" = 'STUB'
        AND staged."originSeq" >= ${params.throughSeq}
        AND staged."originSeq" < ${params.beforeSeq}
        AND NOT EXISTS (
          SELECT 1
          FROM "PendingMedia" pending
          WHERE pending."messageId" = staged.id
        )
    `);
  }

  async applyForwardMessagePage(params: {
    response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    after: number;
    frozenTargetSeq: number;
    prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
  }): Promise<{
    publish: () => Promise<void>;
  }> {
    const publication = await this.database.db.transaction((tx) =>
      this.applyForwardMessagePageInTransaction(tx, params),
    );
    return publication;
  }

  async applyForwardMessagePageInTransaction(
    tx: DatabaseTransaction,
    params: {
      response: FederationThreadResourceResponse<FederationMessageQueryPage>;
      after: number;
      frozenTargetSeq: number;
      prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
    },
  ): Promise<{ publish: () => Promise<void> }> {
    await this.assertThreadResourceResponseWritableInTransaction(
      tx,
      params.response,
    );
    const applied = await this.applyMessageQueryItemsInTransaction(
      tx,
      params.response.peerDomain,
      params.response.data.messages,
      params.response.peerToken,
      {
        prefetchedForwardClosures: params.prefetchedForwardClosures,
        expectedThreadId: params.response.threadId,
      },
    );
    return {
      publish: () =>
        this.publishMessageQueryEffects(params.response.peerDomain, applied),
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
      response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
      frozenTargetSeq: number;
    },
  ): Promise<{ publish: () => Promise<void> }> {
    await this.assertThreadResourceResponseWritableInTransaction(
      tx,
      params.response,
    );
    const satisfiedQuoteDependencies: Array<{
      threadId: number;
      sourceDomain: string;
      originSeq: number;
    }> = [];
    for (const item of params.response.data.tombstones) {
      if (
        !Number.isSafeInteger(item.deletionSeq) ||
        item.deletionSeq < 1 ||
        !Number.isSafeInteger(item.messageSeq) ||
        item.messageSeq < 1 ||
        !Number.isSafeInteger(item.deletedAt) ||
        item.deletedAt < 0 ||
        ![
          MessageDeleteType.USER_RETRACTION,
          MessageDeleteType.MODERATION_REMOVAL,
        ].includes(item.type)
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'peer returned an invalid thread tombstone',
          HttpStatus.BAD_REQUEST,
        );
      }
      const route = await this.resolveTombstoneThreadInTransaction(
        tx,
        item.thread,
        params.response.peerDomain,
        params.response.peerToken.namespaceId,
      );
      if (route.threadId !== params.response.threadId) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'tombstone query returned an item for a different thread',
          HttpStatus.BAD_REQUEST,
        );
      }
      const authorityDomain =
        route.groupOriginDomain ?? params.response.peerDomain;
      if (authorityDomain !== params.response.peerDomain) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'group tombstone is not from the group origin',
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.deletedMessages.applyFederatedInTx(tx, {
        threadId: route.threadId,
        messageSeq: item.messageSeq,
        authorityDomain,
        sourceDomain: params.response.peerDomain,
        sourceNamespaceId: params.response.peerToken.namespaceId,
        remoteDeletionSeq: item.deletionSeq,
        type: item.type,
        authorityDeletedAt: new Date(item.deletedAt),
        allowPending: true,
        federationSourceDomain: params.response.peerDomain,
        expectedFederationVersion: route.federationVersion,
      });
      satisfiedQuoteDependencies.push({
        threadId: route.threadId,
        sourceDomain: params.response.peerDomain,
        originSeq: item.messageSeq,
      });
    }
    return {
      publish: async () => {
        for (const dependency of satisfiedQuoteDependencies) {
          const waiting = await this.database.db
            .select({ batchId: tables.pendingMedia.batchId })
            .from(tables.pendingMedia)
            .innerJoin(
              tables.message,
              eq(tables.message.id, tables.pendingMedia.messageId),
            )
            .where(
              and(
                eq(tables.pendingMedia.direction, 'INBOUND'),
                eq(tables.message.threadId, dependency.threadId),
                eq(tables.pendingMedia.originDomain, dependency.sourceDomain),
                eq(
                  tables.pendingMedia.dependsOnOriginSeq,
                  dependency.originSeq,
                ),
              ),
            );
          for (const row of waiting) {
            await this.promotePendingMessage(row.batchId);
          }
        }
      },
    };
  }

  /** Apply one bounded message-query page inside the caller's cursor transaction. No network-visible
   * effects happen here; the returned effects are published only after that transaction commits. */
  async applyMessageQueryItemsInTransaction(
    tx: DatabaseTransaction,
    domain: string,
    items: readonly FederationMessageFeedMessage[],
    token: PeerResponseToken,
    options: MessageQueryApplyOptions = {},
  ): Promise<MissedPageEffect[]> {
    const {
      prefetchedForwardClosures = new Map(),
      isolateMissingContext = false,
      sequencePolicy,
      expectedThreadId,
      historical = false,
    } = options;
    await this.assertPeerResponseWritable(tx, token);
    if (sequencePolicy) {
      for (const item of items) {
        try {
          validatePreservedFederationOriginSequence(item.seq, sequencePolicy);
        } catch (error) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            error instanceof Error
              ? error.message
              : 'message is outside the frozen reverse window',
            HttpStatus.BAD_REQUEST,
          );
        }
      }
    }
    const effects: MissedPageEffect[] = [];
    for (const [itemIndex, item] of items.entries()) {
      const savepoint = `federation_message_${itemIndex}`;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        this.assertFederatedMessageEnvelope(item);
        if ('author' in item && item.author.domain === 'local') {
          this.logger.warn(
            `normalized a federated group-message author from the local persistence domain to its authenticated peer domain: ${federatedMessageLogContext(
              domain,
              item,
              'LOCAL_AUTHOR_DOMAIN_NORMALIZED',
            )}`,
          );
        }
        const author = this.federatedMessageAuthor(item, domain);
        if (!isValidSomfpDomain(author.domain)) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'federated message author has an invalid wire domain',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (
          !FEDERATED_MESSAGE_CONTENT_TYPES.includes(
            item.contentType as ContentType,
          )
        )
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'unknown federated message content type',
            HttpStatus.BAD_REQUEST,
          );
        const hasOriginSeq = item.originSeq !== null;
        const hasOriginCreatedAt = item.originCreatedAt !== null;
        if (
          !Number.isSafeInteger(item.seq) ||
          item.seq < 1 ||
          hasOriginSeq !== hasOriginCreatedAt ||
          (hasOriginSeq &&
            (!Number.isSafeInteger(item.originSeq) || item.originSeq! < 1)) ||
          (hasOriginCreatedAt &&
            (!Number.isSafeInteger(item.originCreatedAt) ||
              item.originCreatedAt! < 0))
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'missed message has invalid seq coordinate',
            HttpStatus.BAD_REQUEST,
          );
        }
        const route = await this.resolveMissedThreadInTransaction(
          tx,
          item,
          domain,
          token.namespaceId,
        );
        if (
          expectedThreadId !== undefined &&
          route.threadId !== expectedThreadId
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'message query returned an item for a different thread',
            HttpStatus.BAD_REQUEST,
          );
        }
        const sourceTime = new Date(item.createdAt);
        if (
          !Number.isSafeInteger(item.createdAt) ||
          item.createdAt < 0 ||
          Number.isNaN(sourceTime.getTime()) ||
          (item.contentType === ContentType.CALL &&
            (typeof item.clientMessageId !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                item.clientMessageId,
              )))
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'missed message has invalid timestamps or clientMessageId',
            HttpStatus.BAD_REQUEST,
          );
        }
        const incomingText =
          item.contentType === ContentType.PURE_TEXT
            ? parseTextMessageContent(item.content)
            : null;
        if (
          item.contentType === ContentType.PURE_TEXT &&
          (!incomingText || incomingText.quote !== undefined)
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'invalid federated text quote',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (
          item.quoteTarget !== undefined &&
          (item.contentType !== ContentType.PURE_TEXT ||
            !Number.isSafeInteger(item.quoteTarget.targetSeq) ||
            item.quoteTarget.targetSeq < 1)
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'invalid federated reply target',
            HttpStatus.BAD_REQUEST,
          );
        }
        this.assertMissedAssetDescriptors(item);
        let storedContent = fromFederatedMessageContent(
          item.contentType as ContentType,
          item.content,
          this.config.domain,
          new Map(item.assets.map((asset) => [asset.digest, asset.bytes])),
        );

        if (author.domain === this.config.domain) {
          if (item.originSeq === null || item.originCreatedAt === null) {
            this.logger.error(
              `self-authored message diagnostic is missing source coordinates: ${federatedMessageLogContext(
                domain,
                item,
                'SOURCE_COORDINATES_MISSING',
              )}`,
            );
            continue;
          }
          const localSourceMessage = await tx.query.message.findFirst({
            where: and(
              eq(tables.message.threadId, route.threadId),
              eq(tables.message.seq, item.originSeq),
            ),
            columns: {
              id: true,
              createdAt: true,
              originSeq: true,
              federationSourceDomain: true,
            },
          });
          if (localSourceMessage) {
            if (
              localSourceMessage.createdAt.getTime() !== item.originCreatedAt
            ) {
              this.logger.error(
                `ignored a self-authored message diagnostic with conflicting source time: ${JSON.stringify(
                  {
                    messageId: localSourceMessage.id.toString(),
                    peerDomain: domain,
                    receiptOriginSeq: item.originSeq,
                    receiptOriginCreatedAt: item.originCreatedAt,
                    localCreatedAt: localSourceMessage.createdAt.getTime(),
                  },
                )}`,
              );
            }
            if (sequencePolicy) {
              if (
                (localSourceMessage.originSeq !== null &&
                  localSourceMessage.originSeq !== item.seq) ||
                (localSourceMessage.federationSourceDomain !== null &&
                  localSourceMessage.federationSourceDomain !== domain)
              ) {
                throw new BusinessException(
                  BusinessCode.FEDERATION_MALFORMED,
                  'self-authored message has a conflicting publisher coordinate',
                  HttpStatus.BAD_REQUEST,
                );
              }
              await DeletedMessageService.lockFederatedIdentity(
                tx,
                route.threadId,
                domain,
                token.namespaceId,
                item.seq,
              );
              await tx
                .update(tables.message)
                .set({
                  originSeq: item.seq,
                  federationSourceDomain: domain,
                  updatedAt: new Date(),
                })
                .where(eq(tables.message.id, localSourceMessage.id));
            }
            const existingReceipt =
              await tx.query.federationMessageReceipt.findFirst({
                where: and(
                  eq(tables.federationMessageReceipt.peerDomain, domain),
                  eq(
                    tables.federationMessageReceipt.namespaceId,
                    token.namespaceId,
                  ),
                  eq(tables.federationMessageReceipt.threadId, route.threadId),
                  eq(tables.federationMessageReceipt.peerSeq, item.seq),
                ),
                columns: { messageId: true },
              });
            if (
              existingReceipt &&
              existingReceipt.messageId !== localSourceMessage.id
            ) {
              throw new BusinessException(
                BusinessCode.FEDERATION_MALFORMED,
                'conflicting processing receipt coordinate',
                HttpStatus.BAD_REQUEST,
              );
            }
            if (!existingReceipt) {
              await tx.insert(tables.federationMessageReceipt).values({
                peerDomain: domain,
                namespaceId: token.namespaceId,
                threadId: route.threadId,
                peerSeq: item.seq,
                messageId: localSourceMessage.id,
              });
            }
            continue;
          }
          this.logger.error(
            `self-authored missed message has no matching local source message: ${federatedMessageLogContext(
              domain,
              item,
              'LOCAL_SOURCE_MESSAGE_NOT_FOUND',
            )}`,
          );
          continue;
        }
        if (item.contentType === ContentType.CALL) {
          const caller = await tx.query.user.findFirst({
            where: and(
              eq(tables.user.account, route.creatorAccount),
              eq(tables.user.domain, route.creatorDomain),
              eq(tables.user.namespaceId, token.namespaceId),
            ),
            columns: { id: true },
          });
          const call = parseFederatedCallContent(item.content);
          if (
            !call ||
            !caller ||
            !('peerAccount' in item.thread) ||
            route.recipients.length !== 1
          ) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'invalid federated CALL content',
              HttpStatus.BAD_REQUEST,
            );
          }
          storedContent = buildCallContent({
            callType: call.mediaType,
            outcome: call.outcome,
            callerId: caller.id,
            calleeId: route.recipients[0],
            ...(call.startedAt === undefined
              ? {}
              : { startedAt: call.startedAt }),
            endedAt: call.endedAt,
            ...(call.startedAt === undefined
              ? {}
              : { durationMs: call.endedAt - call.startedAt }),
          });
        }

        const existingMessage = await tx.query.message.findFirst({
          where: and(
            eq(tables.message.threadId, route.threadId),
            eq(tables.message.creatorAccount, route.creatorAccount),
            eq(tables.message.creatorDomain, route.creatorDomain),
            eq(tables.message.originSeq, item.seq),
          ),
          columns: {
            id: true,
            originServerTime: true,
          },
        });
        if (existingMessage) {
          const previousOriginTime = existingMessage.originServerTime;
          if (
            previousOriginTime &&
            previousOriginTime.getTime() !== sourceTime.getTime()
          ) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'conflicting immutable federated message originCreatedAt',
              HttpStatus.BAD_REQUEST,
            );
          }
          continue;
        }

        let forwardCard: FederatedForwardCard | undefined;
        let forwardClosure: ForwardWireBundle | undefined;
        if (item.contentType === ContentType.FORWARD) {
          try {
            forwardCard = JSON.parse(item.content) as FederatedForwardCard;
          } catch {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'invalid FORWARD card JSON',
              HttpStatus.BAD_REQUEST,
            );
          }
          if (
            typeof forwardCard.bundleId !== 'string' ||
            Object.keys(forwardCard).some((key) => key !== 'bundleId')
          ) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'invalid FORWARD card shape',
              HttpStatus.BAD_REQUEST,
            );
          }
          forwardClosure = prefetchedForwardClosures.get(itemIndex);
          if (!forwardClosure) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'FORWARD closure was not prefetched',
              HttpStatus.BAD_REQUEST,
            );
          }
        }

        const stored = await this.storePulledMessageInTransaction(tx, {
          threadId: route.threadId,
          creator: {
            account: route.creatorAccount,
            domain: route.creatorDomain,
          },
          fetchedFromDomain: domain,
          namespaceId: token.namespaceId,
          message: {
            originSeq: item.seq,
            clientMessageId: item.clientMessageId ?? null,
            contentType: item.contentType,
            content: storedContent,
            ts: item.createdAt,
            quoteTarget: item.quoteTarget,
          },
          expectedFederationVersion: route.federationVersion,
          incomingText,
          forwardCard,
          forwardClosure,
          originTime: sourceTime,
          hasUnavailableAssets: false,
          assetBytes: new Map(
            item.assets.map((asset) => [asset.digest, asset.bytes]),
          ),
          downloadAuth: {
            fromAccount: author.account,
            fromDomain: author.domain,
            toAccount: route.toAccount,
          },
          sequencePolicy,
        });
        if (stored.kind === 'pending') {
          effects.push({
            kind: 'pending',
            historical,
            threadId: route.threadId,
            originSeq: item.seq,
            recipients: route.recipients,
            toAccount: route.toAccount,
            author,
            batchId: stored.batchId,
          });
          continue;
        }

        if (!historical) {
          const arrival = stored.message.createdAt;
          await tx
            .update(tables.messageThread)
            .set({
              lastMessageSeq: stored.message.seq,
              lastMessagePreview: derivePreview(
                item.contentType as ContentType,
                stored.storedContent,
              ),
              lastMessageAt: arrival,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(tables.messageThread.id, route.threadId),
                or(
                  isNull(tables.messageThread.lastMessageAt),
                  lt(tables.messageThread.lastMessageAt, arrival),
                ),
              ),
            );
        }
        let deletionSeq: number | undefined;
        if (stored.message.isDeleted) {
          const deletion = await tx.query.deletedMessage.findFirst({
            where: and(
              eq(tables.deletedMessage.threadId, route.threadId),
              eq(tables.deletedMessage.messageSeq, stored.message.seq),
            ),
            columns: { deletionSeq: true },
          });
          deletionSeq = deletion?.deletionSeq;
        }
        effects.push({
          kind: 'message',
          historical,
          threadId: route.threadId,
          originSeq: item.seq,
          recipients: route.recipients,
          toAccount: route.toAccount,
          author,
          message: stored.message,
          deletionSeq,
          forwardClosure,
          remoteForwardBundleId: forwardCard?.bundleId,
          localForwardBundleId: stored.localForwardBundleId,
        });
      } catch (error) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
        if (sequencePolicy) throw error;
        if (error instanceof FederationMessageContextError) {
          if (!isolateMissingContext) throw error;
          this.logger.error(
            `ignored message with unresolved context after state recovery: ${federatedMessageLogContext(
              domain,
              item,
              error,
            )}`,
          );
          continue;
        }
        this.logger.error(
          `ignored invalid federated message: ${federatedMessageLogContext(
            domain,
            item,
            error,
          )}`,
        );
      } finally {
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      }
    }
    return effects;
  }

  /** Publish only committed /missed work. Messages already in Message fan immediately; pending media
   * starts its durable download and will fan from promotePendingMessage after its own commit. */
  async publishMessageQueryEffects(
    domain: string,
    effects: MissedPageEffect[],
  ): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'pending') {
        void this.runFileSyncBatch(effect.batchId!, (digest, offset) =>
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
      if (effect.localForwardBundleId && !effect.message!.isDeleted) {
        await this.forwardBundles.rebuildLinkCards(
          effect.localForwardBundleId,
          (url) => this.linkPreview.buildCardContent(url),
        );
      }
      if (!effect.historical) {
        void this.signalOutbound(
          effect.threadId,
          {
            account: effect.message!.creatorAccount!,
            domain: effect.message!.creatorDomain!,
          },
          effect.originSeq,
          domain,
        ).catch(() => undefined);
        if (effect.message!.isDeleted) {
          void this.signalDeletionOutbound(
            effect.threadId,
            effect.message!.seq,
          ).catch(() => undefined);
        }
      }
      if (
        effect.forwardClosure &&
        effect.remoteForwardBundleId &&
        !effect.message!.isDeleted
      ) {
        await this.localizeForwardAssets(
          effect.forwardClosure,
          domain,
          await this.resolveForwardAssetAuth(effect.message!),
        );
      }
    }
  }

  private assertMissedAssetDescriptors(
    item: FederationMessageFeedMessage,
  ): void {
    const expected = new Set(
      federatedContentDigests(item.contentType as ContentType, item.content),
    );
    const described = new Set<string>();
    for (const asset of item.assets) {
      if (
        !/^[a-f0-9]{64}$/.test(asset.digest) ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 0
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'invalid missed asset descriptor',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (described.has(asset.digest)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'invalid or duplicate missed asset descriptor',
          HttpStatus.BAD_REQUEST,
        );
      }
      described.add(asset.digest);
    }
    if (item.contentType === ContentType.CONTACT_CARD) {
      const avatar = item.assets[0];
      if (
        avatar &&
        (avatar.bytes < 1 || avatar.bytes > UploadService.MAX_AVATAR_WIRE_BYTES)
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'contact-card avatar exceeds the profile avatar size limit',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    if (
      expected.size !== described.size ||
      [...expected].some((digest) => !described.has(digest))
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missed asset descriptors do not match message content',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertFederatedMessageEnvelope(
    item: FederationMessageFeedMessage,
  ): void {
    const assertFields = (
      value: unknown,
      required: string[],
      optional: string[] = [],
    ): Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'federated message contains a non-object descriptor',
          HttpStatus.BAD_REQUEST,
        );
      }
      const record = value as Record<string, unknown>;
      const allowed = new Set([...required, ...optional]);
      if (
        required.some((field) => !(field in record)) ||
        Object.keys(record).some((field) => !allowed.has(field))
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'federated message contains invalid fields',
          HttpStatus.BAD_REQUEST,
        );
      }
      return record;
    };
    const rawThread = item.thread as unknown as Record<string, unknown>;
    const isGroup =
      typeof rawThread?.['account'] === 'string' &&
      rawThread['account'].startsWith('!');
    assertFields(
      item,
      [
        'thread',
        isGroup ? 'author' : 'authorRef',
        'seq',
        'originSeq',
        'contentType',
        'content',
        'createdAt',
        'originCreatedAt',
        ...(item.contentType === ContentType.CALL ? ['clientMessageId'] : []),
        'assets',
      ],
      ['quoteTarget'],
    );
    const thread = assertFields(
      rawThread,
      isGroup ? ['account'] : ['account', 'peerAccount'],
    );
    if (
      typeof thread['account'] !== 'string' ||
      ('peerAccount' in thread && typeof thread['peerAccount'] !== 'string')
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has an invalid thread address',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (isGroup) {
      const author = assertFields(
        (item as Extract<FederationMessageFeedMessage, { author: unknown }>)
          .author,
        ['account', 'domain'],
      );
      if (
        typeof author['account'] !== 'string' ||
        typeof author['domain'] !== 'string'
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'federated message has an invalid group author',
          HttpStatus.BAD_REQUEST,
        );
      }
    } else if (
      !['THREAD_ACCOUNT', 'THREAD_PEER_ACCOUNT'].includes(
        (item as { authorRef?: string }).authorRef ?? '',
      )
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has an invalid P2P author reference',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (typeof item.content !== 'string' || !Array.isArray(item.assets)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has invalid primitive fields',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (item.quoteTarget) {
      assertFields(item.quoteTarget, ['targetSeq']);
    }
    for (const asset of item.assets) {
      assertFields(asset, ['digest', 'bytes']);
    }
  }

  private federatedMessageAuthor(
    item: FederationMessageFeedMessage,
    sourceDomain: string,
  ): S2SAddress {
    if ('authorRef' in item) {
      return item.authorRef === 'THREAD_ACCOUNT'
        ? { account: item.thread.account, domain: sourceDomain }
        : {
            account: item.thread.peerAccount,
            domain: this.config.domain,
          };
    }
    return item.author.domain === 'local'
      ? { account: item.author.account, domain: sourceDomain }
      : item.author;
  }

  private async resolveMissedThreadInTransaction(
    tx: DatabaseTransaction,
    item: FederationMessageFeedMessage,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<{
    threadId: number;
    creatorAccount: string;
    creatorDomain: string;
    federationVersion: number;
    recipients: number[];
    toAccount: string;
  }> {
    let threadRows: Array<{
      threadId: number;
      federationVersion: number;
      toAccount: string;
    }> = [];
    if (!('peerAccount' in item.thread)) {
      const result = await tx.execute<{
        threadId: number;
        federationVersion: number;
        toAccount: string;
      }>(sql`
        SELECT thread.id AS "threadId",
               thread."federationVersion",
               group_user.account AS "toAccount"
        FROM "MessageThread" thread
        JOIN "Group" group_user ON group_user.id = thread."groupId"
        WHERE thread.type = 'GROUP'
          AND group_user.account = ${normalizeAccount(item.thread.account)}
          AND group_user.domain = ${sourceDomain}
          AND group_user."namespaceId" = ${namespaceId}
        LIMIT 1
        FOR SHARE OF thread
      `);
      threadRows = result.rows;
    } else {
      const author = this.federatedMessageAuthor(item, sourceDomain);
      const selfAuthored = author.domain === this.config.domain;
      const expectedAuthorAccount = selfAuthored
        ? item.thread.peerAccount
        : item.thread.account;
      if (
        normalizeAccount(author.account) !==
        normalizeAccount(expectedAuthorAccount)
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'invalid P2P missed route',
          HttpStatus.BAD_REQUEST,
        );
      }
      const result = await tx.execute<{
        threadId: number;
        federationVersion: number;
        toAccount: string;
      }>(sql`
        SELECT thread.id AS "threadId",
               thread."federationVersion",
               local_user.account AS "toAccount"
        FROM "MessageThread" thread
        JOIN "ThreadMember" local_member ON local_member."threadId" = thread.id
        JOIN "User" local_user ON local_user.id = local_member."userId"
        JOIN "ThreadParticipant" local_participant
          ON local_participant."threadId" = thread.id
         AND local_participant."accountId" = local_user.id
        JOIN "ThreadMember" remote_member ON remote_member."threadId" = thread.id
        JOIN "User" remote_user ON remote_user.id = remote_member."userId"
        WHERE thread.type = 'P2P'
          AND local_user.domain = 'local'
          AND local_user."namespaceId" = 0
          AND local_user.account = ${normalizeAccount(item.thread.peerAccount)}
          AND local_member."left" = false
          AND remote_user.domain = ${sourceDomain}
          AND remote_user."namespaceId" = ${namespaceId}
          AND remote_user.account = ${normalizeAccount(item.thread.account)}
          AND remote_member."left" = false
        LIMIT 1
        FOR SHARE OF thread, local_member, remote_member
      `);
      threadRows = result.rows;
    }
    const route = threadRows[0];
    if (!route) {
      throw new FederationMessageContextError(
        'missed message has no retained local thread',
      );
    }
    const author = this.federatedMessageAuthor(item, sourceDomain);
    const creatorAccount = normalizeAccount(author.account);
    const creatorDomain =
      author.domain === this.config.domain ? 'local' : author.domain;
    if (
      !('peerAccount' in item.thread) &&
      author.domain !== this.config.domain
    ) {
      const normalizedAuthor = normalizeAccount(author.account);
      const existingAuthor = await tx.query.user.findFirst({
        where: and(
          eq(tables.user.account, normalizedAuthor),
          eq(tables.user.domain, author.domain),
          eq(tables.user.sourceDomain, sourceDomain),
          eq(tables.user.namespaceId, namespaceId),
        ),
        columns: { id: true },
      });
      const authorId =
        existingAuthor?.id ??
        (await upsertSourceUserInTx(tx, {
          account: normalizedAuthor,
          domain: author.domain,
          sourceDomain,
          namespaceId,
          name: normalizedAuthor,
          profileRev: 0,
        }));
      await tx
        .insert(tables.threadMember)
        .values({
          threadId: route.threadId,
          userId: authorId,
          role: null,
          left: true,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }
    const recipientRows =
      'peerAccount' in item.thread
        ? await tx.execute<{ userId: number }>(sql`
            SELECT participant."accountId" AS "userId"
            FROM "ThreadParticipant" participant
            WHERE participant."threadId" = ${route.threadId}
            FOR SHARE OF participant
          `)
        : await tx.execute<{ userId: number }>(sql`
            SELECT audience."localUserId" AS "userId"
            FROM "ThreadAudience" audience
            WHERE audience."threadId" = ${route.threadId}
              AND audience."targetDomain" = 'local'
              AND audience."localUserId" IS NOT NULL
            FOR SHARE OF audience
          `);
    return {
      ...route,
      creatorAccount,
      creatorDomain,
      recipients: recipientRows.rows.map((row) => row.userId),
    };
  }

  private async resolveTombstoneThreadInTransaction(
    tx: DatabaseTransaction,
    thread: FederationThreadAddress,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<{
    threadId: number;
    federationVersion: number;
    recipients: number[];
    groupOriginDomain?: string;
  }> {
    if ('peerAccount' in thread) {
      return this.resolveMissedThreadInTransaction(
        tx,
        { thread, authorRef: 'THREAD_ACCOUNT' } as FederationMessageFeedMessage,
        sourceDomain,
        namespaceId,
      );
    }

    const rows = await tx.execute<{
      threadId: number;
      federationVersion: number;
      groupDomain: string;
    }>(sql`
      SELECT message_thread.id AS "threadId",
             message_thread."federationVersion",
             group_user.domain AS "groupDomain"
      FROM "MessageThread" message_thread
      JOIN "Group" group_user ON group_user.id = message_thread."groupId"
      WHERE message_thread.type = 'GROUP'
        AND group_user.account = ${normalizeAccount(thread.account)}
        AND group_user."namespaceId" = ${namespaceId}
      LIMIT 1
      FOR SHARE OF message_thread
    `);
    const route = rows.rows[0];
    if (!route)
      throw new FederationMessageContextError(
        'tombstone has no retained local group thread',
      );
    const recipientRows = await tx.execute<{ userId: number }>(sql`
      SELECT participant."accountId" AS "userId"
      FROM "ThreadParticipant" participant
      WHERE participant."threadId" = ${route.threadId}
      FOR SHARE OF participant
    `);
    const recipientAuthorization = await Promise.all(
      recipientRows.rows.map((row) =>
        isThreadMutuallyAuthorized(tx, row.userId, route.threadId),
      ),
    );
    return {
      ...route,
      groupOriginDomain:
        route.groupDomain === 'local' ? this.config.domain : route.groupDomain,
      recipients: recipientRows.rows
        .filter((_, index) => recipientAuthorization[index])
        .map((row) => row.userId),
    };
  }

  /** Domains with incomplete recognition or degraded reachability. */
  async listRecoverablePeerDomains(): Promise<string[]> {
    const rows = await this.database.db.query.federatedPeer.findMany({
      where: inArray(tables.federatedPeer.trustLevel, [
        'unrecognized',
        'degraded',
      ]),
      columns: { domain: true },
    });
    return rows.map((r) => r.domain);
  }

  /** Fully recognized peers participating in startup and periodic reconciliation. */
  async listTrustedPeerDomains(): Promise<string[]> {
    const rows = await this.database.db.query.federatedPeer.findMany({
      where: inArray(tables.federatedPeer.trustLevel, [
        'available',
        'degraded',
      ]),
      columns: { domain: true },
    });
    return rows.map((row) => row.domain);
  }

  /** Effective wire domain of a participant's user: locals ("local" in DB) surface as our real
   *  config.domain; foreign stubs surface their stored peer domain. Used for roster-gate + author
   *  matching against wire `fromDomain`. */
  private effectiveDomain(u: { domain: string }): string {
    return u.domain === 'local' ? this.config.domain : u.domain;
  }

  /**
   * Group-thread access gate (the roster gate, §8): resolve the group `!account` → local thread, then
   * prove the REQUESTER (signerDomain) has an active local member here (it is a member-server of this
   * group). When `fromAccount` is given (per-author hub-leg pull), also prove the author is an active
   * member and return its userId. Throws NOT_FOUND (no such group) / FORBIDDEN (requester or author not a
   * member). `toAccount`-is-group on the wire routes here; the group account resolves via findGroupThread.
   */
  private async resolveGroupThreadAccess(
    groupAccount: string,
    fromAccount: string | undefined,
    fromDomain: string | undefined,
    signerDomain: string,
  ): Promise<{ threadId: number; authorId?: number }> {
    const trd = await this.findGroupThread(groupAccount);
    if (!trd || trd.type !== MessageThreadType.GROUP) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `group ${groupAccount} not found`,
      );
    }
    if (trd.group?.dissolvedAt != null) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    const participants = await this.database.db.query.threadMember.findMany({
      where: and(
        eq(tables.threadMember.threadId, trd.id),
        eq(tables.threadMember.left, false),
      ),
      with: {
        user: { columns: { account: true, domain: true } },
      },
    });
    const participantAuthorization = await Promise.all(
      participants.map((participant) =>
        isThreadMutuallyAuthorized(
          this.database.db,
          participant.userId,
          trd.id,
        ),
      ),
    );
    const authorizedParticipants = participants.filter(
      (_, index) => participantAuthorization[index],
    );
    const signerIsMember = authorizedParticipants.some(
      (p) => this.effectiveDomain(p.user) === signerDomain,
    );
    if (!signerIsMember) {
      throw new BusinessException(BusinessCode.FORBIDDEN, 'not a member');
    }
    let authorId: number | undefined;
    if (fromAccount && fromDomain) {
      const author = authorizedParticipants.find(
        (p) =>
          p.user.account === normalizeAccount(fromAccount) &&
          this.effectiveDomain(p.user) === fromDomain,
      );
      if (!author) {
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'author not a member',
        );
      }
      authorId = author.userId;
    }
    return { threadId: trd.id, authorId };
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
    // Resource authorization is deliberately independent from compacted feed-index lifetime. Durable
    // delivery proof allows already-authorized history to finish localizing its referenced resources.
    const candidates = await this.database.db
      .select({
        messageId: tables.message.id,
        threadId: tables.message.threadId,
        authorDomain: sql<string>`${tables.message.creatorDomain}`,
        threadType: tables.messageThread.type,
        groupId: tables.messageThread.groupId,
      })
      .from(tables.message)
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, tables.message.threadId),
      )
      .innerJoin(
        tables.threadAudience,
        and(
          eq(tables.threadAudience.threadId, tables.message.threadId),
          eq(tables.threadAudience.targetDomain, signerDomain),
          eq(
            tables.threadAudience.targetNamespaceId,
            signerNamespaceId,
          ),
          isNull(tables.threadAudience.localUserId),
        ),
      )
      .where(
        and(
          eq(tables.message.creatorAccount, normalizeAccount(fromAccount)),
          isNotNull(tables.message.creatorDomain),
          eq(tables.message.isDeleted, false),
          eq(tables.message.seq, sourceSeq),
        ),
      );
    let sourceMessage: { id: bigint; threadId: number } | undefined;
    for (const candidate of candidates) {
      if (
        this.effectiveDomain({ domain: candidate.authorDomain }) !== fromDomain
      ) {
        continue;
      }
      if (
        !(await this.historicalThreadMatchesRecipient(
          candidate.threadId,
          candidate.threadType,
          candidate.groupId,
          toAccount,
          signerDomain,
          signerNamespaceId,
        ))
      ) {
        continue;
      }
      sourceMessage = { id: candidate.messageId, threadId: candidate.threadId };
      break;
    }
    if (!sourceMessage) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'message was not historically delivered to peer',
      );
    }
    const binding = await this.database.db.query.messageAsset.findFirst({
      where: and(
        eq(tables.messageAsset.messageId, sourceMessage.id),
        eq(tables.messageAsset.digest, digest),
      ),
      columns: { messageId: true },
    });
    if (binding) return this.resolveCasFile(digest);
    const forwardBinding =
      await this.database.db.query.forwardMessage.findFirst({
        where: eq(tables.forwardMessage.messageId, sourceMessage.id),
        columns: { bundleId: true },
      });
    if (!forwardBinding) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'digest is not bound to message',
      );
    }
    const closure = await this.forwardBundles.buildClosure(
      forwardBinding.bundleId,
    );
    if (!closure.assets.some((asset) => asset.digest === digest)) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'digest is not bound to forward message',
      );
    }
    return this.resolveCasFile(digest);
  }

  private async historicalThreadMatchesRecipient(
    threadId: number,
    threadType: MessageThreadType,
    groupId: number | null,
    toAccount: string,
    signerDomain: string,
    signerNamespaceId: number,
  ): Promise<boolean> {
    if (threadType === MessageThreadType.GROUP) {
      if (!toAccount.startsWith('!') || groupId === null) return false;
      const group = await this.database.db.query.group.findFirst({
        where: and(
          eq(tables.group.id, groupId),
          eq(tables.group.account, normalizeAccount(toAccount)),
        ),
        columns: { id: true },
      });
      return group !== undefined;
    }
    if (toAccount.startsWith('!')) return false;
    const recipient = await this.database.db
      .select({ id: tables.user.id })
      .from(tables.threadMember)
      .innerJoin(tables.user, eq(tables.user.id, tables.threadMember.userId))
      .where(
        and(
          eq(tables.threadMember.threadId, threadId),
          eq(tables.user.account, normalizeAccount(toAccount)),
          eq(tables.user.domain, signerDomain),
          eq(tables.user.namespaceId, signerNamespaceId),
          ne(tables.user.domain, 'local'),
        ),
      )
      .limit(1);
    return recipient.length > 0;
  }

  async serveForwardBundleClosure(
    bundleId: string,
    signerDomain: string,
    signerNamespaceId: number,
  ) {
    await this.requireForwardBundlePeerAccess(
      bundleId,
      signerDomain,
      signerNamespaceId,
    );
    return this.forwardBundles.buildClosure(bundleId);
  }

  private async requireForwardBundlePeerAccess(
    bundleId: string,
    signerDomain: string,
    signerNamespaceId: number,
  ): Promise<void> {
    const [visible] = await this.database.db
      .select({ messageId: tables.forwardMessage.messageId })
      .from(tables.forwardMessage)
      .innerJoin(
        tables.message,
        eq(tables.message.id, tables.forwardMessage.messageId),
      )
      .innerJoin(
        tables.threadAudience,
        and(
          eq(tables.threadAudience.threadId, tables.message.threadId),
          eq(tables.threadAudience.targetDomain, signerDomain),
          eq(
            tables.threadAudience.targetNamespaceId,
            signerNamespaceId,
          ),
          isNull(tables.threadAudience.localUserId),
        ),
      )
      .where(
        and(
          eq(tables.forwardMessage.bundleId, bundleId),
          eq(tables.message.isDeleted, false),
        ),
      )
      .limit(1);
    if (!visible) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'forward bundle not visible to peer',
      );
    }
  }

  private async resolveCasFile(
    digest: string,
  ): Promise<{ absPath: string; bytes: number }> {
    let asset: { bytes: bigint } | undefined;
    try {
      asset = await this.database.db.query.mediaAsset.findFirst({
        where: and(
          eq(tables.mediaAsset.digest, digest),
          eq(tables.mediaAsset.isDeleted, false),
        ),
        columns: { bytes: true },
      });
    } catch (error) {
      this.logger.warn(
        `Unable to verify media asset ${digest}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'media storage unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!asset) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'file unavailable');
    }
    const absPath = dataDirectory(
      'cas',
      digest.slice(0, 2),
      digest.slice(2, 4),
      digest,
    );
    try {
      const s = await stat(absPath);
      if (!s.isFile() || BigInt(s.size) !== asset.bytes) {
        this.logger.warn(`Media asset ${digest} failed its CAS size check`);
        throw new BusinessException(
          BusinessCode.INTERNAL,
          'media storage unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      return { absPath, bytes: s.size };
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        this.logger.warn(
          `Unable to inspect media asset ${digest}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw new BusinessException(
          BusinessCode.INTERNAL,
          'media storage unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw new BusinessException(BusinessCode.NOT_FOUND, 'file unavailable');
    }
  }

  /** Shared authz prelude for authorized S2S media reads: proves
   *  `fromAccount` is a live local user (non-deleted), `toAccount` is the requester's foreign stub on
   *  signerDomain, and the from↔to Friendship is APPROVED — returning fromId + threadId. Throws NOT_FOUND
   *  (user missing) /
   *  FORBIDDEN (not friends). Media denial is resource-local and does not trigger the message-query
   *  fast-convergence rule. Consolidates the same current P2P relationship required by message access. */
  private async resolveFriendshipThread(
    fromAccount: string,
    toAccount: string,
    signerDomain: string,
  ): Promise<{ fromId: number; threadId: number }> {
    const fromId = await this.findLocalUserId(fromAccount);
    if (fromId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `sender ${fromAccount} not found`,
      );
    }
    // `toAccount` is the requester's user → on OUR side it's a foreign stub on the signer's domain.
    const toStub = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(toAccount)),
        eq(tables.user.domain, signerDomain),
      ),
      columns: { id: true, domain: true },
    });
    if (!toStub || toStub.domain === 'local') {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `recipient ${toAccount} not found`,
      );
    }
    const threadId = await this.participantService.findP2PThreadBetween(
      fromId,
      toStub.id,
    );
    if (threadId === null) {
      // Gate 2 failed: no active P2P thread (not friends — e.g. after a local-only unfriend).
      throw new BusinessException(BusinessCode.FRIEND_NOT_FOUND, 'not friends');
    }
    return { fromId, threadId };
  }

  /** Converge a federated mirror after the origin authoritatively reports that the group dissolved. */
  private async markGroupDissolved(
    threadId: number,
    peerDomain: string,
    expectedFederationVersion: number,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.assertThreadResponseWritable(
        tx,
        threadId,
        peerDomain,
        expectedFederationVersion,
      );
      const trd = await tx.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: { groupId: true },
      });
      if (trd?.groupId == null) return;
      await tx
        .update(tables.group)
        .set({ dissolvedAt: new Date() })
        .where(eq(tables.group.id, trd.groupId));
      return undefined;
    });
  }

  /** Active local recipients of a thread; foreign stubs have no SSE connection on this server. */
  private async localActiveMemberIds(threadId: number): Promise<number[]> {
    const rows = await this.database.db
      .select({ userId: tables.threadMember.userId })
      .from(tables.threadMember)
      .innerJoin(tables.user, eq(tables.user.id, tables.threadMember.userId))
      .innerJoin(tables.account, eq(tables.account.id, tables.user.id))
      .where(
        and(
          eq(tables.threadMember.threadId, threadId),
          eq(tables.threadMember.left, false),
        ),
      );
    const authorization = await Promise.all(
      rows.map((row) =>
        isThreadMutuallyAuthorized(this.database.db, row.userId, threadId),
      ),
    );
    return rows
      .filter((_, index) => authorization[index])
      .map((row) => row.userId);
  }

  /**
   * Transaction-only core shared by the global /missed page applier and pending-media promotion.
   * It performs no SSE and starts no media download; callers own post-commit work.
   */
  private async storePulledMessageInTransaction(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      creator: S2SAddress;
      fetchedFromDomain: string;
      namespaceId: number;
      message: {
        originSeq: number;
        clientMessageId: string | null;
        contentType: string;
        content: string;
        ts: number;
        quoteTarget?: S2SQuoteTarget;
      };
      expectedFederationVersion: number;
      incomingText: ReturnType<typeof parseTextMessageContent>;
      forwardCard?: FederatedForwardCard;
      forwardClosure?: ForwardWireBundle;
      originTime: Date;
      hasUnavailableAssets?: boolean;
      assetBytes?: ReadonlyMap<string, number>;
      downloadAuth?: {
        fromAccount: string;
        fromDomain: string;
        toAccount: string;
      };
      sequencePolicy?: PreserveFederationOriginSequence;
    },
  ): Promise<
    | {
        kind: 'message';
        message: Message;
        storedContent: string;
        localForwardBundleId?: string;
      }
    | { kind: 'pending'; batchId: string }
  > {
    const {
      threadId,
      creator,
      fetchedFromDomain,
      namespaceId,
      message: incoming,
      expectedFederationVersion,
      incomingText,
      forwardCard,
      forwardClosure,
      originTime,
      hasUnavailableAssets = false,
      assetBytes,
      downloadAuth,
      sequencePolicy,
    } = params;
    if (sequencePolicy) {
      validatePreservedFederationOriginSequence(
        incoming.originSeq,
        sequencePolicy,
      );
    }
    await this.assertThreadResponseWritable(
      tx,
      threadId,
      fetchedFromDomain,
      expectedFederationVersion,
    );
    await DeletedMessageService.lockFederatedIdentity(
      tx,
      threadId,
      fetchedFromDomain,
      namespaceId,
      incoming.originSeq,
    );
    const racedMessage = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.federationSourceDomain, fetchedFromDomain),
        eq(tables.message.sourceNamespaceId, namespaceId),
        eq(tables.message.originSeq, incoming.originSeq),
      ),
    });
    if (racedMessage) {
      if (racedMessage.localState === 'STUB') {
        const pending = await tx.query.pendingMedia.findFirst({
          where: eq(tables.pendingMedia.messageId, racedMessage.id),
          columns: { batchId: true },
        });
        if (pending) return { kind: 'pending', batchId: pending.batchId };
      }
      return {
        kind: 'message',
        message: racedMessage,
        storedContent: racedMessage.content,
      };
    }
    if (sequencePolicy) {
      await this.assertPreservedMessageSeqAvailable(
        tx,
        threadId,
        incoming.originSeq,
      );
    }
    const tombstone = await tx.query.federatedMessageTombstone.findFirst({
      where: and(
        eq(tables.federatedMessageTombstone.threadId, threadId),
        eq(tables.federatedMessageTombstone.sourceDomain, fetchedFromDomain),
        eq(tables.federatedMessageTombstone.sourceNamespaceId, namespaceId),
        eq(tables.federatedMessageTombstone.messageSeq, incoming.originSeq),
      ),
      columns: { type: true, sourceDomain: true },
    });

    let waitsForQuoteTarget = false;
    const quoteTargetSeq = incoming.quoteTarget?.targetSeq;
    if (!tombstone && incomingText && quoteTargetSeq !== undefined) {
      const quotedMessage = await this.findQuoteTargetMessage(
        tx,
        threadId,
        fetchedFromDomain,
        namespaceId,
        quoteTargetSeq,
      );
      if (!quotedMessage) {
        const [quotedPending] = await tx
          .select({ id: tables.pendingMedia.id })
          .from(tables.pendingMedia)
          .innerJoin(
            tables.message,
            eq(tables.message.id, tables.pendingMedia.messageId),
          )
          .where(
            and(
              eq(tables.pendingMedia.direction, 'INBOUND'),
              eq(tables.message.threadId, threadId),
              eq(tables.message.federationSourceDomain, fetchedFromDomain),
              eq(tables.message.sourceNamespaceId, namespaceId),
              eq(tables.message.originSeq, quoteTargetSeq),
            ),
          )
          .limit(1);
        if (!quotedPending) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'quoted message is missing from the ordered pull stream',
            HttpStatus.BAD_REQUEST,
          );
        }
        waitsForQuoteTarget = true;
      }
    }

    // Media and messages quoting staged media commit a Message STUB at their final sequence before
    // localization. Forward pulls allocate a local sequence; reverse pulls preserve the publisher
    // coordinate. PendingMedia owns only the later materialization work.
    if (
      !tombstone &&
      !hasUnavailableAssets &&
      ((this.isMediaContentType(incoming.contentType as ContentType) &&
        (incoming.contentType !== ContentType.LINK ||
          extractDigests(incoming.content).length > 0)) ||
        waitsForQuoteTarget)
    ) {
      const batchId = randomUUID();
      const digests = extractDigestEntries(incoming.content);
      const seq = sequencePolicy
        ? incoming.originSeq
        : await this.allocateMessageSeq(tx, threadId);
      const [thread] = await tx
        .select({ authorizationEpoch: tables.messageThread.authorizationEpoch })
        .from(tables.messageThread)
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      if (!thread) throw new Error(`message thread ${threadId} is missing`);
      const [stub] = await tx
        .insert(tables.message)
        .values({
          contentType: incoming.contentType as ContentType,
          content: incoming.content,
          threadId,
          creatorAccount: creator.account,
          creatorDomain: creator.domain,
          creatorNamespaceId:
            creator.domain === this.config.domain ? 0 : namespaceId,
          seq,
          originSeq: incoming.originSeq,
          clientMessageId: incoming.clientMessageId,
          originServerTime: originTime,
          federationSourceDomain: fetchedFromDomain,
          sourceNamespaceId: namespaceId,
          localState: 'STUB',
          updatedAt: new Date(),
        })
        .returning({ id: tables.message.id });
      if (!sequencePolicy) {
        await recordHostedGroupSentBoundaries(tx, threadId, creator, seq);
        await ClientMessageFeedWriter.publishMessage(tx, threadId, seq);
      }
      await tx.insert(tables.pendingMedia).values({
        messageId: stub.id,
        direction: 'INBOUND',
        batchId,
        fileCnt: digests.length,
        originDomain: fetchedFromDomain,
        namespaceId,
        expectedAuthorizationEpoch: thread.authorizationEpoch,
        dependsOnOriginSeq: waitsForQuoteTarget ? quoteTargetSeq : null,
        updatedAt: new Date(),
      });
      for (const { digest, size } of digests) {
        await tx
          .insert(tables.fileSyncProgress)
          .values({
            batchId,
            digest,
            direction: 'INBOUND',
            kind: this.fileSyncKindFor(incoming.contentType as ContentType),
            status: 'PENDING',
            bytesTotal: BigInt(assetBytes?.get(digest) ?? size ?? 0),
            originDomain: fetchedFromDomain,
            namespaceId,
            payload: downloadAuth ?? null,
          })
          .onConflictDoNothing();
      }
      return { kind: 'pending', batchId };
    }

    // Direct path: text/non-media, FORWARD, or born-deleted (tombstone present).
    let storedContent = incoming.content;
    let localForwardBundleId: string | undefined;
    if (forwardClosure && forwardCard) {
      const imported = await this.forwardBundles.importClosure(
        fetchedFromDomain,
        forwardClosure,
        tx,
      );
      localForwardBundleId = imported.localRootBundleId;
      storedContent = this.forwardBundles.localCardContent(
        forwardClosure,
        localForwardBundleId,
      );
    }
    const seq = sequencePolicy
      ? incoming.originSeq
      : await this.allocateMessageSeq(tx, threadId);
    storedContent = contextualizeCasUrls(storedContent, threadId, seq);
    if (incomingText && incoming.quoteTarget) {
      const localQuoteSeq = await this.resolveLocalQuoteSeq(
        tx,
        threadId,
        fetchedFromDomain,
        namespaceId,
        incoming.quoteTarget,
      );
      storedContent = stringifyTextMessageContent({
        text: incomingText.text,
        quote: { seq: localQuoteSeq },
      });
    }
    const [message] = await tx
      .insert(tables.message)
      .values({
        contentType: incoming.contentType as ContentType,
        content: storedContent,
        threadId,
        creatorAccount: creator.account,
        creatorDomain: creator.domain,
        creatorNamespaceId:
          creator.domain === this.config.domain ? 0 : namespaceId,
        seq,
        originSeq: incoming.originSeq,
        clientMessageId: incoming.clientMessageId,
        originServerTime: originTime,
        federationSourceDomain: fetchedFromDomain,
        sourceNamespaceId: namespaceId,
        isDeleted: tombstone !== undefined,
        localState: sequencePolicy ? 'STUB' : 'READY',
        updatedAt: new Date(),
      })
      .returning();
    if (!sequencePolicy) {
      await recordHostedGroupSentBoundaries(tx, threadId, creator, seq);
    }
    let localDeletionSeq: number | null = null;
    if (tombstone && !sequencePolicy) {
      const deletion = await DeletedMessageService.ensureFactInTx(tx, {
        threadId,
        messageSeq: seq,
        type: tombstone.type,
        federationSourceDomain: tombstone.sourceDomain,
        updatedAt: new Date(),
      });
      localDeletionSeq = deletion.created ? deletion.deletionSeq : null;
      await tx
        .delete(tables.federatedMessageTombstone)
        .where(
          and(
            eq(tables.federatedMessageTombstone.threadId, threadId),
            eq(
              tables.federatedMessageTombstone.sourceDomain,
              fetchedFromDomain,
            ),
            eq(tables.federatedMessageTombstone.sourceNamespaceId, namespaceId),
            eq(tables.federatedMessageTombstone.messageSeq, incoming.originSeq),
          ),
        );
    }
    if (!sequencePolicy) {
      await ClientMessageFeedWriter.publishMessage(tx, threadId, seq);
    }
    if (localDeletionSeq !== null)
      await ClientMessageFeedWriter.publishTombstone(
        tx,
        threadId,
        localDeletionSeq,
      );
    if (localForwardBundleId) {
      await tx.insert(tables.forwardMessage).values({
        messageId: message.id,
        bundleId: localForwardBundleId,
      });
    }
    // Quota (land-then-mark): the outer forward counts as ONE message; each bundle in the closure counts as
    // ONE file (regardless of inner asset/message count). Inner messages no longer count individually, and
    // bundle asset bytes are intentionally excluded (bundles contribute 0 to file total size).
    await this.quota.tickLax(fetchedFromDomain, 'messages', tx, 1);
    if (forwardClosure) {
      await this.quota.tickLax(
        fetchedFromDomain,
        'files',
        tx,
        forwardClosure.children.length + 1,
      );
    }
    return { kind: 'message', message, storedContent, localForwardBundleId };
  }

  private async allocateMessageSeq(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<number> {
    const [thread] = await tx
      .update(tables.messageThread)
      .set({ curSeq: sql`${tables.messageThread.curSeq} + 1` })
      .where(eq(tables.messageThread.id, threadId))
      .returning({ curSeq: tables.messageThread.curSeq });
    if (!thread) throw new Error(`message thread ${threadId} is missing`);
    return thread.curSeq;
  }

  private async assertPreservedMessageSeqAvailable(
    tx: DatabaseTransaction,
    threadId: number,
    seq: number,
  ): Promise<void> {
    const thread = await tx.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
      columns: { curSeq: true },
    });
    if (!thread) throw new Error(`message thread ${threadId} is missing`);
    if (seq > thread.curSeq) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'reverse message seq is beyond the receiver-local thread tail',
        HttpStatus.BAD_REQUEST,
      );
    }
    const occupied = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.seq, seq),
      ),
      columns: { id: true },
    });
    if (occupied) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'reverse message seq conflicts with an existing local message',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async resolveLocalQuoteSeq(
    tx: DatabaseTransaction,
    threadId: number,
    sourceDomain: string,
    namespaceId: number,
    target: S2SQuoteTarget,
  ): Promise<number> {
    const message = await this.findQuoteTargetMessage(
      tx,
      threadId,
      sourceDomain,
      namespaceId,
      target.targetSeq,
    );
    if (!message) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'quoted message is missing from the ordered pull stream',
        HttpStatus.BAD_REQUEST,
      );
    }
    return message.seq;
  }

  private async findQuoteTargetMessage(
    tx: DatabaseTransaction,
    threadId: number,
    sourceDomain: string,
    namespaceId: number,
    sourceSeq: number,
  ): Promise<{ id: bigint; seq: number } | undefined> {
    const direct = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.federationSourceDomain, sourceDomain),
        eq(tables.message.sourceNamespaceId, namespaceId),
        eq(tables.message.originSeq, sourceSeq),
      ),
      columns: { id: true, seq: true },
    });
    if (direct) return direct;
    const receipt = await tx.query.federationMessageReceipt.findFirst({
      where: and(
        eq(tables.federationMessageReceipt.peerDomain, sourceDomain),
        eq(tables.federationMessageReceipt.namespaceId, namespaceId),
        eq(tables.federationMessageReceipt.threadId, threadId),
        eq(tables.federationMessageReceipt.peerSeq, sourceSeq),
      ),
      columns: { messageId: true },
    });
    if (!receipt) return undefined;
    return tx.query.message.findFirst({
      where: and(
        eq(tables.message.id, receipt.messageId),
        eq(tables.message.threadId, threadId),
      ),
      columns: { id: true, seq: true },
    });
  }

  private async localizeForwardAssets(
    closure: ForwardWireBundle,
    peerDomain: string,
    authorization: {
      fromAccount: string;
      fromDomain: string;
      toAccount: string;
      sourceSeq: number;
    },
  ): Promise<void> {
    // Derive from the validated per-bundle manifests; the top-level `assets` array is only a wire
    // convenience summary and is never an independent authorization/download authority.
    for (const asset of this.forwardBundles.assetsFromClosure(closure)) {
      try {
        const have = await this.database.db.query.mediaAsset.findFirst({
          where: and(
            eq(tables.mediaAsset.digest, asset.digest),
            eq(tables.mediaAsset.isDeleted, false),
          ),
          columns: { digest: true },
        });
        if (have) continue;
        await this.upload.saveCasFromStream(
          'bin',
          (offset) =>
            this.fetchMediaChunks(
              peerDomain,
              asset.digest,
              authorization.fromAccount,
              authorization.fromDomain,
              authorization.toAccount,
              authorization.sourceSeq,
              offset,
            ),
          asset.digest,
        );
      } catch {
        // Bundle JSON remains usable and the client can retry asset localization later.
      }
    }
  }

  /** Whether a content type carries CAS media the receiver must localize from the peer. */
  private isMediaContentType(t: ContentType): boolean {
    return isFederatedMediaContentType(t);
  }

  /** Map an inbound message contentType to the FileSyncProgress kind. LINK_CARD identifies optional
   * federated link-card artwork. GALLERY's
   * per-item rows are tagged BUNDLE because the per-item family lives in the message content. */
  private fileSyncKindFor(
    t: ContentType,
  ): 'IMAGE' | 'VIDEO' | 'FILE' | 'AUDIO' | 'LINK_CARD' | 'BUNDLE' {
    return federationFileSyncKind(t);
  }

  /**
   * Drive every pending file in a batch, then promote the staged message once all files succeed.
   * The extracted coordinator serializes concurrent retry and recovery attempts for the same batch.
   */
  async runFileSyncBatch(
    batchId: string,
    fetchChunksFor: (digest: string, offset: number) => AsyncIterable<Buffer>,
  ): Promise<void> {
    await this.inboundFileSync.runBatch(
      batchId,
      fetchChunksFor,
      (id) => this.promotePendingMessage(id),
      (id) => this.failPendingMessage(id),
    );
  }

  /** Persist a terminal inbound materialization failure on the Message and discard the spent job. */
  private async failPendingMessage(batchId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const row = await tx.query.pendingMedia.findFirst({
        where: and(
          eq(tables.pendingMedia.batchId, batchId),
          eq(tables.pendingMedia.direction, 'INBOUND'),
        ),
      });
      if (!row) return;
      const batch = requireInboundPendingMedia(row);
      await tx
        .update(tables.message)
        .set({ localState: 'FAILED', updatedAt: new Date() })
        .where(
          and(
            eq(tables.message.id, batch.messageId),
            eq(tables.message.localState, 'STUB'),
          ),
        );
      await tx
        .delete(tables.fileSyncProgress)
        .where(eq(tables.fileSyncProgress.batchId, batchId));
      await tx
        .delete(tables.pendingMedia)
        .where(eq(tables.pendingMedia.id, batch.id));
    });
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
    return this.resumeInboundBatch(batchId, ['DOWNLOADING', 'FAILED']);
  }

  /**
   * Startup recovery is deliberately narrower than the admin retry: a process crash may strand an
   * active transfer in DOWNLOADING, so it is reset and resumed. A clean FAILED row remains terminal
   * until an administrator explicitly retries it.
   */
  async recoverInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.resumeInboundBatch(batchId, ['DOWNLOADING']);
  }

  private async resumeInboundBatch(
    batchId: string,
    resetStatuses: Array<'DOWNLOADING' | 'FAILED'>,
  ): Promise<{ batchId: string; resetFiles: number }> {
    const batchRow = await this.database.db.query.pendingMedia.findFirst({
      where: eq(tables.pendingMedia.batchId, batchId),
    });
    if (!batchRow || batchRow.direction !== 'INBOUND') {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `inbound media batch ${batchId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    const batch = requireInboundPendingMedia(batchRow);
    const stagedMessage = await this.database.db.query.message.findFirst({
      where: eq(tables.message.id, batch.messageId),
      columns: { originSeq: true },
    });
    if (batch.dependsOnOriginSeq !== null) {
      await this.promotePendingMessage(batchId);
      return { batchId, resetFiles: 0 };
    }
    // Admin retry resets FAILED too; startup recovery resets only crash-stranded DOWNLOADING rows.
    // SUCCEEDED and protocol-terminal TOMBSTONED files are always left as-is.
    const reset = await this.database.db
      .update(tables.fileSyncProgress)
      .set({ status: 'PENDING', errorKind: null, updatedAt: new Date() })
      .where(
        and(
          eq(tables.fileSyncProgress.batchId, batchId),
          inArray(tables.fileSyncProgress.status, resetStatuses),
        ),
      )
      .returning({ id: tables.fileSyncProgress.id });

    // Global /missed persists the already-authorized wire route with each file. This matters when a
    // relationship changes while a quota-paused transfer is waiting: recovery must replay the exact
    // authorization context admitted with the change, not derive a potentially different current route.
    const progress = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.batchId, batchId),
      columns: { payload: true },
    });
    const persistedAuth = parseInboundDownloadAuth(progress?.payload);

    const fromAccount = persistedAuth?.fromAccount;
    const fromDomain = persistedAuth?.fromDomain;
    const toAccount = persistedAuth?.toAccount;
    if (
      !fromAccount ||
      !fromDomain ||
      !toAccount ||
      stagedMessage?.originSeq == null
    ) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        `inbound media batch ${batchId} has no persisted download route`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const originDomain = batch.originDomain;
    const originSeq = stagedMessage.originSeq;

    // Fire-and-forget: the per-batch mutex serializes this against any in-flight original driver.
    void this.runFileSyncBatch(batchId, (digest, offset) =>
      this.fetchMediaChunks(
        originDomain,
        digest,
        fromAccount,
        fromDomain,
        toAccount,
        originSeq,
        offset,
      ),
    ).catch(() => undefined);

    return { batchId, resetFiles: reset.length };
  }

  /** Materialize an inbound STUB independently of its already-committed synchronization round. */
  private async promotePendingMessage(batchId: string): Promise<void> {
    const promoted = await this.pendingMediaPromoter.promote(batchId);
    if (!promoted) return;
    const { dependentBatchIds } = promoted;

    // Wake every durable quote that was waiting for this wire coordinate. Each successful child
    // promotion performs the same lookup again, naturally draining quote chains without polling.
    for (const dependentBatchId of dependentBatchIds) {
      await this.promotePendingMessage(dependentBatchId);
    }
  }

  /** Apply an existing participant's thread-scoped delivery block without rechecking relationship
   * authorization. Remote group mirrors deliberately deliver from their local audience projection. */
  private async unblockedRecipients(
    threadId: number,
    candidateIds: number[],
  ): Promise<number[]> {
    const settings =
      await this.participantService.getParticipantDeliverySettings(
        threadId,
        candidateIds,
      );
    const blocked = new Set(
      settings
        .filter((participant) => participant.blocked)
        .map((participant) => participant.userId),
    );
    return [...new Set(candidateIds)].filter((userId) => !blocked.has(userId));
  }

  /**
   * Receiver-side media localize (§3.3 / §4.5): for each CAS digest referenced by a pulled message,
   * fetch the bytes from the peer's /media/:digest and store them through the SAME CAS pipeline as a local
   * upload (sha256 → shard path → MediaAsset ref++), then write the MediaMessage authz row so the local
   * /uploads/cas/* gate admits the recipient. The content URL is already server-relative, so once the
   * file is local it serves same-origin with no rewrite. Integrity-checked (the re-hash must match the
   * advertised digest). Best-effort per file; a failure leaves the message with the peer's cross-origin
   * URL (inert) for a later retry.
   */
  private async localizeMedia(
    msg: {
      id: bigint;
      threadId: number;
      seq: number;
      content: string;
      contentType: ContentType;
    },
    peerDomain: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
    sourceSeq: number,
    expectedFederationVersion: number,
  ): Promise<void> {
    // Quota is charged inside driveFileSync (quotaCounted-guarded, type-agnostic) once the byte size is
    // known; the dedup path below (file already local) skips fetchMediaChunks entirely — counted once.
    for (const { digest, ext } of extractDigestEntries(msg.content)) {
      try {
        // Dedup: if the file is already local (prior fetch or a coincidental local upload), just ensure
        // the authz row exists and skip the network fetch.
        const have = await this.database.db.query.mediaAsset.findFirst({
          where: and(
            eq(tables.mediaAsset.digest, digest),
            eq(tables.mediaAsset.isDeleted, false),
          ),
          columns: { digest: true },
        });
        if (!have) {
          // Stream the asset from the peer in resumable Range chunks → local CAS (no whole-file
          // buffer, no whole-transfer timeout). saveCasFromStream verifies the digest === advertised
          // and throws on mismatch (corrupt/tampered/truncated) — caught below, leaving the message
          // inert for a later retry.
          await this.upload.saveCasFromStream(
            ext,
            (offset) =>
              this.fetchMediaChunks(
                peerDomain,
                digest,
                fromAccount,
                fromDomain,
                toAccount,
                sourceSeq,
                offset,
              ),
            digest,
          );
        }
        await this.database.db.transaction(async (tx) => {
          await this.assertThreadResponseWritable(
            tx,
            msg.threadId,
            peerDomain,
            expectedFederationVersion,
          );
          await tx
            .insert(tables.messageAsset)
            .values({ messageId: msg.id, threadId: msg.threadId, digest })
            .onConflictDoNothing();
        });
      } catch {
        // Best-effort per file — never block the text pull. The cross-origin URL stays inert until a
        // later retry (the manual relocalize endpoint, or pull-on-open / next push) re-runs localize.
      }
    }
  }

  /** Whether every CAS digest referenced by `content` is fully local: each digest has a MediaMessage
   *  authz row for THIS message (same-origin fetch admitted) AND a READY MediaAsset (bytes on
   *  disk). A non-media message (no digest) is trivially ready. Drives the localize
   *  outcome report + the MEDIA_STATUS signal, and is reused by the manual relocalize endpoint. */
  private async isMessageMediaReady(
    msgId: bigint,
    content: string,
  ): Promise<boolean> {
    const digests = extractDigests(content);
    if (digests.length === 0) return true;
    const rows = await this.database.db.query.messageAsset.findMany({
      where: and(
        eq(tables.messageAsset.messageId, msgId),
        inArray(tables.messageAsset.digest, digests),
      ),
      columns: { digest: true },
    });
    if (rows.length !== digests.length) return false; // a digest has no authz row yet
    const assets = await this.database.db.query.mediaAsset.findMany({
      where: and(
        inArray(tables.mediaAsset.digest, digests),
        eq(tables.mediaAsset.isDeleted, false),
      ),
      columns: { digest: true },
    });
    return assets.length === digests.length;
  }

  /**
   * Manually re-run localize for one federated media message (the user tapped retry in the detail
   * view). Resolves the localizeMedia context (creator account/domain + the thread's receiver/peer
   * domain) from the stored message alone, then re-runs the SAME localize path the pull flow uses —
   * localizeMedia is idempotent (already-local digests skip the fetch and cost no quota) and pushes
   * the terminal MEDIA_STATUS itself, so this method needs no push of its own. Returns the post-
   * localize status so the endpoint can answer the client. Non-media → 'ready' (nothing to do);
   * missing message/creator → NOT_FOUND.
   */
  async localizeMediaForMessage(
    userId: number,
    threadId: number,
    seq: number,
  ): Promise<'ready' | 'downloading' | 'failed'> {
    const msg = await this.messageVisibility.findVisibleByThreadSeq(
      userId,
      threadId,
      seq,
    );
    if (!msg) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `no such message in thread [${threadId}]`,
      );
    }
    if (msg.contentType === ContentType.FORWARD) {
      return this.relocalizeForwardMessage(msg);
    }
    if (!this.isMediaContentType(msg.contentType)) return 'ready';
    if (msg.creatorAccount === null || msg.creatorDomain === null)
      throw new Error('user-authored media message has no creator');
    if (msg.localState === 'STUB') return 'downloading';
    const { toAccount, peerDomain } = await this.resolveMediaContext(
      msg.threadId,
      msg.creatorAccount,
      msg.creatorDomain,
      msg.creatorNamespaceId,
    );
    if (msg.localState === 'FAILED') {
      if (
        msg.originSeq === null ||
        msg.federationSourceDomain === null ||
        peerDomain !== msg.federationSourceDomain
      ) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'failed placeholder has no retryable federation source',
        );
      }
      const batchId = await this.restageFailedInboundMessage(msg, {
        peerDomain,
        fromAccount: msg.creatorAccount,
        fromDomain:
          msg.creatorDomain === 'local'
            ? this.config.domain
            : msg.creatorDomain,
        toAccount,
      });
      if (batchId) {
        void this.runFileSyncBatch(batchId, (digest, offset) =>
          this.fetchMediaChunks(
            peerDomain,
            digest,
            msg.creatorAccount!,
            msg.creatorDomain === 'local'
              ? this.config.domain
              : msg.creatorDomain!,
            toAccount,
            msg.originSeq!,
            offset,
          ),
        ).catch(() => undefined);
      }
      return 'downloading';
    }
    const federationVersion = await this.readThreadFederationVersion(
      msg.threadId,
      peerDomain,
    );
    await this.localizeMedia(
      msg,
      peerDomain,
      msg.creatorAccount,
      msg.creatorDomain === 'local' ? this.config.domain : msg.creatorDomain,
      toAccount,
      msg.originSeq ?? msg.seq,
      federationVersion,
    );
    return (await this.isMessageMediaReady(msg.id, msg.content))
      ? 'ready'
      : 'failed';
  }

  private async restageFailedInboundMessage(
    msg: Message,
    authorization: {
      peerDomain: string;
      fromAccount: string;
      fromDomain: string;
      toAccount: string;
    },
  ): Promise<string | null> {
    const batchId = randomUUID();
    const digests = extractDigestEntries(msg.content);
    if (digests.length === 0) return null;
    if (msg.sourceNamespaceId === null)
      throw new Error('failed inbound message has no source namespace');
    const namespaceId = msg.sourceNamespaceId;
    return this.database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          localState: tables.message.localState,
          authorizationEpoch: tables.messageThread.authorizationEpoch,
        })
        .from(tables.message)
        .innerJoin(
          tables.messageThread,
          eq(tables.messageThread.id, tables.message.threadId),
        )
        .where(eq(tables.message.id, msg.id))
        .for('update', { of: tables.message })
        .limit(1);
      if (!locked || locked.localState !== 'FAILED') return null;
      await tx.insert(tables.pendingMedia).values({
        messageId: msg.id,
        direction: 'INBOUND',
        batchId,
        fileCnt: digests.length,
        originDomain: authorization.peerDomain,
        namespaceId,
        expectedAuthorizationEpoch: locked.authorizationEpoch,
        updatedAt: new Date(),
      });
      for (const { digest, size } of digests) {
        await tx.insert(tables.fileSyncProgress).values({
          batchId,
          digest,
          direction: 'INBOUND',
          kind: this.fileSyncKindFor(msg.contentType),
          status: 'PENDING',
          bytesTotal: BigInt(size ?? 0),
          originDomain: authorization.peerDomain,
          namespaceId,
          payload: authorization,
        });
      }
      await tx
        .update(tables.message)
        .set({ localState: 'STUB', updatedAt: new Date() })
        .where(eq(tables.message.id, msg.id));
      return batchId;
    });
  }

  private async relocalizeForwardMessage(
    msg: Message,
  ): Promise<'ready' | 'failed'> {
    const binding = await this.database.db.query.forwardMessage.findFirst({
      where: eq(tables.forwardMessage.messageId, msg.id),
      columns: { bundleId: true },
    });
    if (!binding) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'forward bundle binding not found',
      );
    }
    const root = await this.database.db.query.forwardBundle.findFirst({
      where: eq(tables.forwardBundle.id, binding.bundleId),
      columns: { sourceDomain: true, sourceBundleId: true },
    });
    if (!root) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'bundle not found');
    }
    const closure = await this.forwardBundles.buildClosure(binding.bundleId);
    if (root.sourceDomain && root.sourceBundleId) {
      // JSONB import is already committed. A retry creates a fresh best-effort download run from the
      // immutable bundle metadata; it is deliberately not coupled to the import transaction.
      await this.localizeForwardAssets(
        closure,
        root.sourceDomain,
        await this.resolveForwardAssetAuth(msg),
      );
    }
    const digests = [
      ...new Set(
        this.forwardBundles
          .assetsFromClosure(closure)
          .map((asset) => asset.digest),
      ),
    ];
    const ready =
      digests.length === 0 ||
      (
        await this.database.db.query.mediaAsset.findMany({
          where: and(
            inArray(tables.mediaAsset.digest, digests),
            eq(tables.mediaAsset.isDeleted, false),
          ),
          columns: { digest: true },
        })
      ).length === digests.length;
    return ready ? 'ready' : 'failed';
  }

  /**
   * Resolve the localizeMedia transport context for a pulled message: `toAccount` + `peerDomain`
   * naming the peer /media/:digest source. GROUP → the thread's group-User account + its origin domain
   * (roster-gated source). P2P → the thread's OTHER active (non-creator) participant account (the
   * local receiver), with peerDomain = the creator's domain (the sender server). Mirrors the context
   * the pull paths compute at pull time (pullP2P / pullGroupWhole), recovered here from the stored
   * message for the manual retry path. */
  private async resolveMediaContext(
    threadId: number,
    creatorAccount: string,
    creatorDomain: string,
    creatorNamespaceId: number,
  ): Promise<{ toAccount: string; peerDomain: string }> {
    const [thread] = await this.database.db
      .select({
        type: tables.messageThread.type,
        group: {
          account: tables.group.account,
          domain: tables.group.domain,
        },
      })
      .from(tables.messageThread)
      .leftJoin(tables.group, eq(tables.group.id, tables.messageThread.groupId))
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (thread?.type === MessageThreadType.GROUP && thread.group) {
      return {
        toAccount: thread.group.account,
        peerDomain: thread.group.domain,
      };
    }
    // P2P: the receiver is the thread's other active (non-creator) participant.
    const [peer] = await this.database.db
      .select({ account: tables.user.account })
      .from(tables.threadMember)
      .innerJoin(tables.user, eq(tables.user.id, tables.threadMember.userId))
      .where(
        and(
          eq(tables.threadMember.threadId, threadId),
          eq(tables.threadMember.left, false),
          or(
            ne(tables.user.account, creatorAccount),
            ne(tables.user.domain, creatorDomain),
            ne(tables.user.namespaceId, creatorNamespaceId),
          ),
        ),
      )
      .limit(1);
    return {
      toAccount: peer?.account ?? creatorAccount,
      peerDomain: creatorDomain,
    };
  }

  /** Derive the stable message/thread authorization coordinate for a stored FORWARD message. */
  private async resolveForwardAssetAuth(msg: Message): Promise<{
    fromAccount: string;
    fromDomain: string;
    toAccount: string;
    sourceSeq: number;
  }> {
    if (msg.creatorAccount === null || msg.creatorDomain === null)
      throw new Error('user-authored forward message has no creator');
    const { toAccount } = await this.resolveMediaContext(
      msg.threadId,
      msg.creatorAccount,
      msg.creatorDomain,
      msg.creatorNamespaceId,
    );
    return {
      fromAccount: msg.creatorAccount,
      fromDomain:
        msg.creatorDomain === 'local' ? this.config.domain : msg.creatorDomain,
      toAccount,
      sourceSeq: msg.originSeq ?? msg.seq,
    };
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
    yield* this.mediaRangeClient().fetch(
      peerDomain,
      digest,
      fromAccount,
      fromDomain,
      toAccount,
      sourceSeq,
      startOffset,
    );
  }

  /** One signed Range GET to /media/:digest, with status-based classification (see fetchMediaChunks). Returns
   *  the Response + parsed Content-Range bounds and optional per-unit Content-Digest. Throws — with
   *  markTransportDegraded for auth/transport failures — on
   *  anything that isn't 200/206. The raw query is covered by the request signature. */
  private async requestRangeUnit(
    url: URL,
    peerDomain: string,
    start: number,
    end: number,
  ): Promise<FederationMediaRangeUnit> {
    return this.mediaRangeClient().requestUnit(url, peerDomain, start, end);
  }

  private mediaRangeClient(): FederationMediaRangeClient {
    return new FederationMediaRangeClient(
      this.signature,
      this.discovery,
      this.recognition,
      this.transportConfig,
      {
        isFatalPeerCode: (code): code is number => this.isFatalPeerCode(code),
        markContactSuccess: (domain) => this.markContactSuccess(domain),
        markPeerHalted: (domain, code, message) =>
          this.markPeerHalted(domain, code, message),
      },
    );
  }

  /**
   * Fetch a peer user's public profile (signed GET /s2s/v1/users/:account). Used by federated
   * resolve (the add-friend card), ensureForeignUserLocalized (send-friend-request safety net), and
   * initial invite/profile localization. Throws on any non-success (the caller
   * surfaces FEDERATION_DELIVERY_FAILED → user retries / inits).
   */
  async fetchRemoteUser(address: S2SAddress): Promise<S2SProfile> {
    const profile = await this.getSigned<S2SProfile>(
      `/s2s/v1/users/${encodeFederationResourceComponent(address.account)}`,
      address.domain,
    );
    if (!Number.isSafeInteger(profile.profileRev) || profile.profileRev < 0) {
      throw new S2sResponseError(
        `S2S profile from ${address.domain} has an invalid profileRev`,
        HttpStatus.OK,
        BusinessCode.FEDERATION_MALFORMED,
      );
    }
    return profile;
  }

  // ─── inbound / re-pull localization ──────────────────────────────────────────

  /**
   * Localize a foreign stub from a received S2SProfile: decode + persist the avatar via the
   * shared saveAvatars pipeline, write name/avatar/bio, and stamp remoteUpdatedAt. Idempotent + gated
   * on the profile revision — skips entirely when profile.updatedAt is not newer than the stored
   * remoteUpdatedAt (so a re-delivered payload or a no-change re-pull does no work). Avatar decode
   * failures (corrupt/oversized bytes from a compromised peer) are isolated: name/bio/remoteUpdatedAt
   * still advance and the existing avatar is kept, so a broken avatar can't break friend-flow (and
   * advancing remoteUpdatedAt prevents a probe retry-loop on the same broken bytes).
   */
  async localizeForeignProfile(
    userId: number,
    profile: S2SProfile,
    gate?:
      | {
          threadId: number;
          peerDomain: string;
          expectedFederationVersion: number;
        }
      | { peerToken: PeerResponseToken },
  ): Promise<void> {
    const stub = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, userId),
      columns: { avatar: true, profileRev: true },
    });
    if (!stub) return; // stub gone — nothing to localize
    if (profile.profileRev <= stub.profileRev) {
      return; // already at least as fresh as this profile
    }

    const data = await this.prepareForeignProfileData(profile);
    if (gate) {
      await this.database.db.transaction(async (tx) => {
        if ('peerToken' in gate) {
          await this.assertPeerResponseWritable(tx, gate.peerToken);
        } else {
          await this.assertThreadResponseWritable(
            tx,
            gate.threadId,
            gate.peerDomain,
            gate.expectedFederationVersion,
          );
        }
        await tx
          .update(tables.user)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(tables.user.id, userId));
      });
    } else {
      await this.database.db
        .update(tables.user)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(tables.user.id, userId));
    }

    // The previous localized avatar files are intentionally LEFT on disk — gcOrphanedAvatars reaps
    // them once they are no longer any User/Group's current avatar (no delete racing a render, and
    // re-localization on a transient profile-fetch hiccup no longer thrashes the disk).
  }

  async upsertForeignUserFromPeerResponse(
    account: string,
    domain: string,
    profile: S2SProfile,
    peerToken: PeerResponseToken,
  ): Promise<number> {
    if (peerToken.domain !== domain) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'peer response token domain does not match foreign user domain',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.database.db.transaction(async (tx) => {
      await this.assertPeerResponseWritable(tx, peerToken);
      const userId = await this.ensureForeignUserInTransaction(
        tx,
        account,
        domain,
        peerToken.namespaceId,
      );
      const [stub] = await tx
        .select({ profileRev: tables.user.profileRev })
        .from(tables.user)
        .where(eq(tables.user.id, userId))
        .for('update')
        .limit(1);
      if (
        stub?.profileRev !== undefined &&
        profile.profileRev <= stub.profileRev
      )
        return userId;
      const data = await this.prepareForeignProfileData(profile);
      await tx
        .update(tables.user)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(tables.user.id, userId));
      return userId;
    });
  }

  private async prepareForeignProfileData(profile: S2SProfile): Promise<{
    name: string;
    bio: string;
    profileRev: number;
    avatar?: string;
  }> {
    let newAvatarUrl: string | null = null;
    if (profile.avatar) {
      try {
        if (
          !/^[a-f0-9]{64}$/.test(profile.avatar.digest) ||
          typeof profile.avatar.mimeType !== 'string' ||
          profile.avatar.mimeType.length === 0
        ) {
          throw new Error('invalid public profile avatar metadata');
        }
        const bytes = Buffer.from(profile.avatar.base64, 'base64');
        if (
          createHash('sha256').update(bytes).digest('hex') !==
          profile.avatar.digest
        ) {
          throw new Error('public profile avatar digest mismatch');
        }
        newAvatarUrl = await this.upload.saveAvatarFromWire({
          b64: profile.avatar.base64,
          w: profile.avatar.width,
          h: profile.avatar.height,
        });
      } catch {
        newAvatarUrl = null;
      }
    } else {
      newAvatarUrl = '';
    }
    const data: {
      name: string;
      bio: string;
      profileRev: number;
      avatar?: string;
    } = {
      name: profile.displayName,
      bio: profile.bio,
      profileRev: profile.profileRev,
    };
    if (newAvatarUrl !== null) data.avatar = newAvatarUrl;
    return data;
  }
}

/** Build a bounded, control-character-free diagnostic for untrusted message items. Message content,
 * asset descriptors and arbitrary nested wire values must never be copied into application logs. */
function federatedMessageLogContext(
  peerDomain: string,
  item: unknown,
  error: unknown,
): string {
  const record = logRecord(item);
  const content =
    typeof record?.['content'] === 'string' ? record['content'] : undefined;
  const author = logAddress(record?.['author']);
  const thread = logThread(record?.['thread']);
  const reason =
    error instanceof Error
      ? `${safeLogText(error.name, 80)}: ${safeLogText(error.message, 320)}`
      : safeLogText(error, 320);
  return JSON.stringify({
    peerDomain: safeLogText(peerDomain, 253),
    contentType: safeLogText(record?.['contentType'], 80),
    ...(content === undefined
      ? {}
      : {
          contentBytes: Buffer.byteLength(content),
          contentSha256: createHash('sha256').update(content).digest('hex'),
        }),
    ...(author === undefined ? {} : { author }),
    ...(thread === undefined ? {} : { thread }),
    reason,
  });
}

function logRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function logAddress(value: unknown): Record<string, string> | undefined {
  const record = logRecord(value);
  if (!record) return undefined;
  return {
    account: safeLogText(record['account'], 128),
    domain: safeLogText(record['domain'], 253),
  };
}

function logThread(value: unknown): Record<string, unknown> | undefined {
  const record = logRecord(value);
  if (!record) return undefined;
  const type = safeLogText(record['type'], 32);
  if (type === 'GROUP') {
    return {
      type,
      account: safeLogText(record['account'], 128),
      domain: safeLogText(record['domain'], 253),
    };
  }
  if (type === 'P2P') {
    const participants = Array.isArray(record['participants'])
      ? record['participants']
          .slice(0, 2)
          .map(logAddress)
          .filter((address) => address !== undefined)
      : [];
    return { type, participants };
  }
  return { type };
}

function safeLogText(value: unknown, maxLength: number): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'bigint'
        ? String(value)
        : '';
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '�').slice(0, maxLength);
}
