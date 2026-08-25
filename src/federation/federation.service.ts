import {
  forwardRef,
  Injectable,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeAccount, isValidAccount } from '../common/account.js';
import { encodeFederationResourceComponent } from './federation-resource-request.js';
import { dataDirectory } from '../common/data-directory.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  ContentType,
  GroupRole,
  MessageDeleteType,
  MessageThreadType,
} from '../database/enums.js';
import type { Message } from '../message/message.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import * as tables from '../database/schema.js';
import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { CasOversizeError, UploadService } from '../upload/upload.service.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import {
  FORWARD_MAX_WIRE_JSON_BYTES,
  ForwardBundleService,
  type ForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { contentDigest, SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { QuotaService } from '../quota/quota.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import {
  applyFederatedPendingProfileSnapshot,
  InviteService,
  type FederatedPendingProfileSnapshot,
} from '../invite/invite.service.js';
import { SseService } from '../gateway/sse.service.js';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import { derivePreview, MessageService } from '../message/message.service.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';
import {
  extractDigestEntries,
  extractDigests,
} from '../upload/file-content.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import { MEDIA_STATUS } from '../common/media-status.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { FederationMessageFeedIndexerService } from './federation-message-feed-indexer.service.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from './federation-audience.js';
import { FEDERATION_MESSAGE_FEED_ADVANCED } from './federation-message-feed.events.js';
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
  assertS2SCallFrame,
  type CallSignalPayload,
  type CallSignalKind,
  type S2SCallFrame,
  type S2SCallOp,
} from '../calls/federated-call-protocol.js';

export type {
  S2SCallFrame,
  S2SCallOp,
} from '../calls/federated-call-protocol.js';

import { FederationCursorService } from './federation-cursor.service.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import {
  FEDERATED_MESSAGE_CONTENT_TYPES,
  type FederationMessageFeedPage,
  type FederationMessageFeedMessage,
  type FederationMessageQueryPage,
  type FederationThreadAddress,
} from './federation-message-feed.service.js';
import {
  federatedContentDigests,
  fromFederatedMessageContent,
} from './federated-message-content.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import {
  FederationMessageFeedPullService,
  type FederationMessageFeedPullCallbacks,
} from './federation-message-feed-pull.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import {
  FederationMessageTombstoneFeedService,
  type FederationMessageTombstonePage,
  type FederationMessageTombstoneItem,
  type FederationMessageTombstoneQueryPage,
} from './federation-message-tombstone-feed.service.js';
import {
  FederationMessageTombstonePullService,
  type FederationMessageTombstonePullCallbacks,
} from './federation-message-tombstone-pull.service.js';
import {
  PeerStateFeedService,
  type PeerStateFeedPage,
} from './peer-state-feed.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import {
  GroupMetaFeedService,
  type GroupMetaFeedPage,
} from './group-meta-feed.service.js';
import { RelationshipIntentService } from '../invite/relationship-intent.service.js';
import {
  isThreadMutuallyAuthorized,
  mutuallyAuthorizedSql,
} from '../invite/relationship-authorization.js';
import { SystemMessageType } from '../message/system-message.js';
import { ClientMessageFeedWriter } from '../message/client-message-feed.service.js';
import {
  assertServerGroupCapacityInTx,
  SERVER_GROUP_FULL_REASON,
} from '../group/group-capacity.js';
import {
  FEDERATION_PROTOCOL_VERSION,
  selectFederationProtocolVersion,
} from './federation-protocol.js';

type GroupIntentWireStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

function groupIntentWireStatus(
  status: GroupIntentWireStatus,
): GroupIntentWireStatus {
  return status;
}

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

function groupIntentStorageStatus(
  status: GroupIntentWireStatus,
): GroupIntentWireStatus {
  return status;
}

/** A failed S2S HTTP response or an HTTP 200 business result. HTTP status carries only transport,
 * authentication, temporary availability, or peer-relationship semantics; `code` carries the
 * operation result and stable diagnostic detail. */
export class S2sResponseError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly data?: unknown;
  federationVersion?: number;
  constructor(message: string, status: number, code?: number, data?: unknown) {
    super(message);
    this.name = 'S2sResponseError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** A well-formed feed item whose local relationship/thread context no longer exists. */
export class FederationMessageContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FederationMessageContextError';
  }
}

/** A structurally self-contained wire item that can never succeed on retry.
 * Page envelopes, cursor boundaries and local/database failures deliberately do not use this type:
 * those failures must retain the cursor because the receiver cannot safely identify a skip point. */
class PermanentFederationItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFederationItemError';
  }
}

/** Raw SQL timestamp columns are driver-dependent Date|string values. Restore the domain Date at
 * that boundary; PeerStateFeedService owns the shared Date -> epoch-ms wire serialization. */
function fromRawTimestamp(value: Date | string | null): Date | null {
  return value === null || value instanceof Date ? value : new Date(value);
}

export interface LocalGroupSystemEvent {
  actorUserId: number;
  subjectUserId: number;
  type: SystemMessageType;
}

/** Pure roster diff used only to decorate the local timeline after GROUP_META commits. */
export function deriveLocalGroupSystemEvents(
  before: ReadonlyArray<{ userId: number; role: GroupRole | null }>,
  after: ReadonlyArray<{ userId: number; role: GroupRole }>,
  previousOwnerId: number,
  nextOwnerId: number,
): LocalGroupSystemEvent[] {
  const previousRoles = new Map(before.map((row) => [row.userId, row.role]));
  const nextIds = new Set(after.map((row) => row.userId));
  const events: LocalGroupSystemEvent[] = [];
  for (const { userId, role } of after) {
    const previousRole = previousRoles.get(userId);
    if (previousRole === undefined) {
      events.push({
        actorUserId: userId,
        subjectUserId: userId,
        type: SystemMessageType.GROUP_JOINED,
      });
    } else if (role === GroupRole.ADMIN && previousRole === GroupRole.MEMBER) {
      events.push({
        actorUserId: nextOwnerId,
        subjectUserId: userId,
        type: SystemMessageType.GROUP_ADMIN_GRANTED,
      });
    } else if (role === GroupRole.MEMBER && previousRole === GroupRole.ADMIN) {
      events.push({
        actorUserId: nextOwnerId,
        subjectUserId: userId,
        type: SystemMessageType.GROUP_ADMIN_REVOKED,
      });
    }
  }
  for (const { userId } of before) {
    if (!nextIds.has(userId))
      events.push({
        actorUserId: userId,
        subjectUserId: userId,
        type: SystemMessageType.GROUP_LEFT,
      });
  }
  if (previousOwnerId !== nextOwnerId)
    events.push({
      actorUserId: nextOwnerId,
      subjectUserId: nextOwnerId,
      type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
    });
  return events;
}

/** A federated user address on the wire: two separate fields (account + domain). The `@` separator
 *  is a UI input convention ONLY — the browser splits a typed `alice@bbb.com` into these two fields
 *  before any API call; S2S payloads + endpoints + consumer DTOs never carry an `@`-joined string. */
export interface S2SAddress {
  account: string;
  domain: string;
}

type OutboundCallFrameParams = {
  fromLocalUserId: number;
  to: S2SAddress;
  callSid: string;
  op: S2SCallOp;
  callType: 'AUDIO' | 'VIDEO';
  endReason?: 'completed' | 'timeout' | 'failed';
  kind?: CallSignalKind;
  payload?: string;
  signalId?: string;
  startedAt?: number;
};

export interface PeerResponseToken {
  domain: string;
  resetGeneration: number;
  rootKeyFingerprint: string;
}

export interface S2SQuoteTarget {
  targetSeq: number;
}

interface FederatedForwardCard {
  bundleId: string;
}

interface MissedPageEffect {
  kind: 'message' | 'pending';
  threadId: number;
  creatorId: number;
  originSeq: number;
  recipients: number[];
  toAccount: string;
  author: S2SAddress;
  batchId?: string;
  message?: Message;
  deletionId?: string;
  forwardClosure?: ForwardWireBundle;
  remoteForwardBundleId?: string;
  localForwardBundleId?: string;
}

interface StatePageEffect {
  clientFeedUpdates: PendingClientStateFeedUpdate[];
  statePushDomains: string[];
  localSystemMessages: Array<{
    actorUserId: number;
    threadId: number;
    type: SystemMessageType;
    subjectUserId?: number;
    message?: Omit<Message, 'id'>;
    recipientUserIds?: number[];
  }>;
}

/**
 * Avatar as transmitted over S2S: base64 (no `data:` prefix) of the source image bytes + the source
 * pixel dimensions. The receiver does NOT assume square — it runs the bytes back through saveAvatars,
 * which center-crops the largest square and emits the 32/64/128/256/512 multi-size set. Recommended
 * source size is 512×512 webp (~40 KB → ~55 KB base64); non-square sources are center-cropped. Null
 * (on S2SProfile.avatar) means the user has no avatar.
 */
export interface S2SAvatar {
  b64: string;
  w: number;
  h: number;
}

/**
 * A user's public profile as transmitted over S2S — the resolve endpoint (GET /s2s/v1/users/:account)
 * response body and the `profile` slot on the friend-request payload. `profileRev` is the sender's
 * User.profileRev (Int, the profile revision); receivers store it as the stub's remoteProfileRev so the
 * lightweight /revision probe can detect staleness without re-transferring the avatar.
 */
export interface S2SProfile {
  account: string;
  domain: string;
  displayName: string;
  avatar: S2SAvatar | null;
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

class FederationDownloadTerminatedError extends Error {
  constructor() {
    super('federation download task was terminated');
  }
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
 * Identity model: local users have domain="local" (isForeigner=false); federated peers are foreign
 * User stubs (domain=<peer>, isForeigner=true, unusable random hashPwd). Federation addresses always
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
  /** Serializes runFileSyncBatch per batchId so the fire-and-forget pull driver and an admin retry
   *  never double-drive the same batch (and never reach promote concurrently for one). */
  private readonly batchSyncLocks = new KeyedMutex();
  /** Serializes inbound frames that may establish the same call binding, closing concurrent incoming races. */
  private readonly callInboundLocks = new KeyedMutex();
  /** Per-call state-changing lifecycle tail. Advisory `ringing` bypasses it; signal frames wait for the
   *  current state-changing tail but do not serialize the ICE burst with each other. */
  private readonly callLifecycleTails = new Map<string, Promise<void>>();
  /** In-flight SDP answers. `connected` must not overtake the answer it confirms; ICE remains parallel. */
  private readonly callAnswerDeliveries = new Map<string, Set<Promise<void>>>();
  /** Last failed state-changing lifecycle op per call. Advisory `ringing` is never recorded here. */
  private readonly callLifecycleFailures = new Map<
    string,
    { op: S2SCallOp; error: unknown }
  >();

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
    private readonly federationCursor: FederationCursorService,
    private readonly downloadScheduler: FederationDownloadScheduler,
    private readonly transportConfig: FederationTransportConfigService,
    private readonly stateFeedPull: PeerStateFeedPullService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
    @Optional()
    private readonly tombstoneFeed?: FederationMessageTombstoneFeedService,
    @Optional()
    private readonly tombstonePull?: FederationMessageTombstonePullService,
    @Optional()
    private readonly messageFeedIndexer?: FederationMessageFeedIndexerService,
    @Optional()
    private readonly groupMetaFeed?: GroupMetaFeedService,
  ) {}

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
    senderUserId: number,
    threadId: number,
    originSeq: number,
  ): Promise<void> {
    await this.signalOutbound(threadId, senderUserId, originSeq, undefined);
  }

  /** Best-effort wake-up after a local user leaves a federated group mirror. The durable system message
   *  is already part of the global change feed; this method only wakes the origin. */
  async notifyGroupLeave(
    threadId: number,
    leaverUserId: number,
  ): Promise<void> {
    try {
      const trd = await this.database.db.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: {},
        with: { user: { columns: { account: true, domain: true } } },
      });
      const originDomain = trd?.user?.domain;
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
    authorUserId: number,
    latestSeq: number,
    fetchedFromDomain: string | undefined,
  ): Promise<void> {
    try {
      const [trd, participants] = await Promise.all([
        this.database.db.query.messageThread.findFirst({
          where: eq(tables.messageThread.id, threadId),
          columns: {},
          with: { user: { columns: { account: true, domain: true } } },
        }),
        this.database.db.query.threadParticipant.findMany({
          where: eq(tables.threadParticipant.threadId, threadId),
          with: {
            user: {
              columns: { account: true, domain: true, isForeigner: true },
            },
          },
        }),
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
        (p) => p.userId === authorUserId,
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

      const groupDomain = trd.user?.domain; // 'local' = origin; <peer> = mirror; undefined = P2P
      if (!groupDomain) {
        // P2P (local-only or federated 1:1): signal each foreign peer participant EXCEPT the author + the
        // fetch source. A pulled P2P message's only foreign participant is the author → nobody to signal.
        for (const p of authorizedParticipants) {
          if (p.userId === authorUserId || !p.user.isForeigner) continue;
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
          if (p.user.isForeigner) destDomains.add(p.user.domain);
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
    await this.messageFeedIndexer?.offerCommitted(
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
        await this.tombstoneFeed?.fill(domain);
        await this.pushDiscoveryHwm(domain);
      }),
    );
  }

  @OnEvent(FEDERATION_MESSAGE_FEED_ADVANCED)
  onMessageFeedAdvanced(event: { peerDomain: string }): void {
    void this.pushDiscoveryHwm(event.peerDomain).catch((error: unknown) =>
      this.logger.debug(
        `message-feed HWM push ${event.peerDomain} failed: ${(error as Error).message}`,
      ),
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
      ),
    });
    return u && !u.isForeigner && !u.isDeleted ? u.id : null;
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
    if (!u || u.isForeigner)
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
    const avatar = u.avatar
      ? await this.upload.readAvatarAsWire(u.avatar)
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
    const [u] = await tx
      .select({
        account: tables.user.account,
        name: tables.user.name,
        avatar: tables.user.avatar,
        bio: tables.user.bio,
        profileRev: tables.user.profileRev,
      })
      .from(tables.user)
      .where(
        and(eq(tables.user.id, userId), eq(tables.user.isForeigner, false)),
      )
      .limit(1);
    if (!u) return new Map();
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
    const peers = await tx.execute<{ domain: string }>(sql`
      SELECT DISTINCT peer_user.domain
      FROM "ThreadParticipant" mine
      JOIN "MessageThread" thread ON thread.id = mine."threadId" AND thread.type = 'P2P'
      JOIN "ThreadParticipant" peer_part ON peer_part."threadId" = mine."threadId"
      JOIN "User" peer_user ON peer_user.id = peer_part."userId"
      WHERE mine."userId" = ${userId}
        AND ${mutuallyAuthorizedSql(userId, sql`peer_part."userId"`)}
        AND peer_user."isForeigner" = true AND peer_user.domain <> 'local'
    `);
    const directProfiles = await this.stateFeed.writeManyInTx(
      tx,
      peers.rows.map(({ domain }) => ({
        peerDomain: domain,
        account: u.account,
        domain: this.config.domain,
        eventType: 'PROFILE' as const,
        subjectAccount: '',
        subjectDomain: 'local',
        body: {
          profileRev: u.profileRev,
          displayName: u.name,
          bio: u.bio,
          avatar,
        },
      })),
    );
    const originGroups = await tx
      .select({ threadId: tables.threadParticipant.threadId })
      .from(tables.threadParticipant)
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, tables.threadParticipant.threadId),
      )
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.messageThread.groupUserId),
      )
      .where(
        and(
          eq(tables.threadParticipant.userId, userId),
          eq(tables.messageThread.type, MessageThreadType.GROUP),
          eq(tables.user.domain, 'local'),
        ),
      );
    const result = new Map(directProfiles);
    for (const group of originGroups) {
      if (!(await isThreadMutuallyAuthorized(tx, userId, group.threadId)))
        continue;
      const state = await this.refreshGroupMemberProjectionInTx(
        tx,
        group.threadId,
        clientFeedUpdates,
      );
      for (const entry of state) result.set(...entry);
    }
    return result;
  }

  /** Publish one local user's current profile to an explicitly addressed peer. This is used for the
   * first friendship intent, before a P2P ThreadAudience exists. */
  private async writeProfileStateToPeerInTx(
    tx: DatabaseTransaction,
    userId: number,
    peerDomain: string,
    forceReindex = false,
  ): Promise<Map<string, bigint>> {
    const [u] = await tx
      .select({
        account: tables.user.account,
        name: tables.user.name,
        avatar: tables.user.avatar,
        bio: tables.user.bio,
        profileRev: tables.user.profileRev,
      })
      .from(tables.user)
      .where(
        and(eq(tables.user.id, userId), eq(tables.user.isForeigner, false)),
      )
      .limit(1);
    if (!u) throw new Error(`local user ${userId} not found`);
    const wire = u.avatar ? await this.upload.readAvatarAsWire(u.avatar) : null;
    return this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain,
        account: u.account,
        domain: this.config.domain,
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: 'local',
        forceReindex,
        body: {
          profileRev: u.profileRev,
          displayName: u.name,
          bio: u.bio,
          avatar: wire
            ? {
                digest: createHash('sha256')
                  .update(Buffer.from(wire.b64, 'base64'))
                  .digest('hex'),
                mimeType: 'image/webp',
                base64: wire.b64,
                width: wire.w,
                height: wire.h,
              }
            : null,
        },
      },
    ]);
  }

  /** Remove a home-authored profile once no active relationship still discloses it to this peer. */
  private async cleanupProfileProjectionInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    localAccount: string,
    peerDomain: string,
  ): Promise<void> {
    const visible = await tx.execute<{ visible: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM "RelationshipPair" pair
        JOIN "User" other_user ON other_user.id = CASE
          WHEN pair."userLowId" = ${localUserId} THEN pair."userHighId"
          ELSE pair."userLowId"
        END
        WHERE pair.active = true
          AND (${localUserId} = pair."userLowId" OR ${localUserId} = pair."userHighId")
          AND other_user."isForeigner" = true
          AND other_user.domain = ${peerDomain}
      ) AS visible
    `);
    if (visible.rows[0]?.visible) return;
    await this.stateFeed.deleteProjectionInTx(tx, {
      peerDomain,
      account: localAccount,
      domain: this.config.domain,
      eventType: 'PROFILE',
      subjectAccount: '',
      subjectDomain: 'local',
    });
  }

  /** Remove origin-owned group disclosure after the peer's last active member disappears. */
  private async cleanupGroupProjectionInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupUserId: number,
    groupAccount: string,
    peerDomain: string,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const visible = await tx.execute<{ visible: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM "RelationshipPair" pair
        JOIN "User" member ON member.id = CASE
          WHEN pair."userLowId" = ${groupUserId} THEN pair."userHighId"
          ELSE pair."userLowId"
        END
        WHERE pair.active = true
          AND (${groupUserId} = pair."userLowId" OR ${groupUserId} = pair."userHighId")
          AND member."isForeigner" = true
          AND member.domain = ${peerDomain}
      ) AS visible
    `);
    if (visible.rows[0]?.visible)
      return this.writeGroupStateInTx(tx, threadId, clientFeedUpdates);
    clientFeedUpdates.push(
      ...(await this.clientStateFeed.recordGroupStateInTx(tx, threadId)),
    );
    if (!this.groupMetaFeed) throw new Error('group meta feed is unavailable');
    await this.groupMetaFeed.deactivateTargetInTx(tx, peerDomain, groupUserId);
    await this.stateFeed.deleteProjectionInTx(tx, {
      peerDomain,
      account: groupAccount,
      domain: this.config.domain,
      eventType: 'PROFILE',
      subjectAccount: '',
      subjectDomain: 'local',
    });
    await this.stateFeed.deleteProjectionInTx(tx, {
      peerDomain,
      account: groupAccount,
      domain: this.config.domain,
      eventType: 'GROUP_META_FEED_HEAD',
      subjectAccount: '',
      subjectDomain: 'local',
    });
    return new Map();
  }

  /** A federated friend request, approval, rejection and deletion are all the same local intent
   * transition. The peer observes it through the compacted RELATIONSHIP_INTENT key. */
  async writeFriendIntentInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    peerUserId: number,
    wantsFriend: boolean,
    note: string,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
    forceConfirmationReindex = false,
  ): Promise<Map<string, bigint>> {
    const remote = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.id, peerUserId),
        eq(tables.user.isForeigner, true),
      ),
      columns: { account: true, domain: true },
    });
    const local = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.id, localUserId),
        eq(tables.user.isForeigner, false),
      ),
      columns: { account: true },
    });
    if (!remote || !local) throw new Error('invalid federated friend intent');
    const projected = await this.invite.writeLocalFriendIntentInTx(
      tx,
      localUserId,
      peerUserId,
      wantsFriend,
      note,
    );
    clientFeedUpdates.push(...projected);
    const request = await tx.execute<{
      status: GroupIntentWireStatus;
      note: string;
      requestedAt: Date | string | null;
      expiresAt: Date | string | null;
    }>(sql`
      SELECT status, note, "requestedAt", "expiresAt" FROM "RelationshipIntent"
      WHERE "authorUserId" = ${localUserId} AND "subjectUserId" = ${peerUserId}
    `);
    const current = request.rows[0];
    if (!current) throw new Error('friend request write disappeared');
    const wireStatus = current.status;
    const relationship = await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain: remote.domain,
        account: local.account,
        domain: this.config.domain,
        subjectAccount: remote.account,
        subjectDomain: remote.domain,
        eventType: 'RELATIONSHIP_INTENT',
        forceReindex: forceConfirmationReindex && wireStatus === 'ACCEPTED',
        body: {
          status: wireStatus,
          note: current.note,
          requestedAt: fromRawTimestamp(current.requestedAt),
          expiresAt: fromRawTimestamp(current.expiresAt),
        },
      },
    ]);
    if (wireStatus === 'REVOKED') {
      await this.cleanupProfileProjectionInTx(
        tx,
        localUserId,
        local.account,
        remote.domain,
      );
      return relationship;
    }
    const profile = await this.writeProfileStateToPeerInTx(
      tx,
      localUserId,
      remote.domain,
      true,
    );
    return new Map([...relationship, ...profile]);
  }

  /** Publish a federated friend request by immutable Address. The request creates an address-derived
   * foreign user and a retained P2P shell locally. REQUESTED is published before a force-reindexed
   * PROFILE so the receiver can authorize and then hydrate the address-keyed pending request without
   * materializing a User stub; acceptance later promotes that verified snapshot into User. */
  async writeAddressedFriendRequestInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    remote: S2SAddress,
    state: {
      requestedAt: Date;
      expiresAt: Date;
      note: string;
      snapshot: FederatedPendingProfileSnapshot;
    },
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const local = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.id, localUserId),
        eq(tables.user.isForeigner, false),
      ),
      columns: { account: true },
    });
    if (!local) throw new Error('invalid local friend requester');
    if (remote.domain === this.config.domain)
      throw new Error('addressed federated request targets the local domain');
    const remoteUserId = await this.materializeFederatedUserInTx(
      tx,
      remote.account,
      remote.domain,
    );
    clientFeedUpdates.push(
      ...(await this.invite.writeLocalFriendIntentInTx(
        tx,
        localUserId,
        remoteUserId,
        true,
        state.note,
        state.snapshot,
      )),
    );
    const relationship = await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain: remote.domain,
        account: local.account,
        domain: this.config.domain,
        subjectAccount: normalizeAccount(remote.account),
        subjectDomain: remote.domain,
        eventType: 'RELATIONSHIP_INTENT',
        body: {
          status: 'REQUESTED',
          note: state.note,
          requestedAt: state.requestedAt,
          expiresAt: state.expiresAt,
        },
      },
    ]);
    const profile = await this.writeProfileStateToPeerInTx(
      tx,
      localUserId,
      remote.domain,
      true,
    );
    return new Map([...relationship, ...profile]);
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
      const request = await tx.query.federatedFriendRequest.findFirst({
        where: and(
          eq(tables.federatedFriendRequest.localUserId, localUserId),
          eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
          eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
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
        const shell = await this.ensureFederatedGroupRequestShellInTx(
          tx,
          request.remoteAccount,
          request.remoteDomain,
          localUserId,
        );
        await this.relationshipIntents.applyRemoteIntentInTx(tx, {
          groupUserId: shell.groupUserId,
          memberUserId: localUserId,
          authorUserId: shell.groupUserId,
          status: 'REQUESTED',
          note: request.note,
          requestedAt: request.requestedAt,
          expiresAt: request.expiresAt,
        });
        const state = await this.writeMemberRelationshipIntentInTx(
          tx,
          shell.threadId,
          localUserId,
          'ACCEPTED',
          clientFeedUpdates,
        );
        await tx
          .update(tables.threadParticipant)
          .set({
            relationshipRev: sql`${tables.threadParticipant.relationshipRev} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tables.threadParticipant.threadId, shell.threadId),
              eq(tables.threadParticipant.userId, localUserId),
            ),
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
              eq(tables.federatedFriendRequest.direction, 'INCOMING'),
            ),
          );
        return state;
      }
      const remoteUserId = await this.materializeFederatedUserInTx(
        tx,
        request.remoteAccount,
        request.remoteDomain,
      );
      await tx
        .insert(tables.relationshipIntent)
        .values({
          authorUserId: remoteUserId,
          subjectUserId: localUserId,
          status: 'REQUESTED',
          note: request.note,
          requestedAt: request.requestedAt,
          expiresAt: request.expiresAt,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            tables.relationshipIntent.authorUserId,
            tables.relationshipIntent.subjectUserId,
          ],
          set: {
            status: 'REQUESTED',
            note: request.note,
            requestedAt: request.requestedAt,
            expiresAt: request.expiresAt,
            updatedAt: new Date(),
          },
        });
      const state = await this.writeFriendIntentInTx(
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
            eq(tables.federatedFriendRequest.direction, 'INCOMING'),
          ),
        );
      return state;
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    return result;
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
      const shell = await this.ensureFederatedGroupRequestShellInTx(
        tx,
        address.account,
        address.domain,
        memberUserId,
      );
      return this.writeMemberRelationshipIntentInTx(
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
      const groupUser = await tx.query.user.findFirst({
        where: and(
          eq(tables.user.account, account),
          eq(tables.user.domain, storedDomain),
          eq(tables.user.isGroup, true),
        ),
        columns: {
          id: true,
          account: true,
          name: true,
          avatar: true,
          bio: true,
          profileRev: true,
        },
      });
      if (!groupUser)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      const thread = await tx.query.messageThread.findFirst({
        where: eq(tables.messageThread.groupUserId, groupUser.id),
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
      const allocated = await this.writeMemberRelationshipIntentInTx(
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
            name: groupUser.name,
            avatar: groupUser.avatar,
            description: groupUser.bio,
            profileRev: groupUser.profileRev,
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
      const request = await tx.query.federatedFriendRequest.findFirst({
        where: and(
          eq(tables.federatedFriendRequest.localUserId, localUserId),
          eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
          eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
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
            eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
          ),
        );
      const local = await tx.query.user.findFirst({
        where: and(
          eq(tables.user.id, localUserId),
          eq(tables.user.isForeigner, false),
        ),
        columns: {
          id: true,
          account: true,
          name: true,
          avatar: true,
          domain: true,
          isForeigner: true,
        },
      });
      if (!local) throw new Error('local friend requester disappeared');
      const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
        userId: localUserId,
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
            isForeigner: true,
          },
        },
      });
      if (clientFeedId !== null)
        clientFeedUpdates.push({ userId: localUserId, feedId: clientFeedId });
      const state = await this.stateFeed.writeManyInTx(tx, [
        {
          peerDomain: request.remoteDomain,
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

  async writeGroupRelationshipIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    note: string,
    status: GroupIntentWireStatus,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
    requestProjectionDirection?: 'APPLICATION' | 'INVITATION',
  ): Promise<Map<string, bigint>> {
    const [state] = await tx
      .select({
        groupUserId: tables.messageThread.groupUserId,
        groupAccount: tables.user.account,
        groupName: tables.user.name,
        groupAvatar: tables.user.avatar,
        groupDescription: tables.user.bio,
        groupProfileRev: tables.user.profileRev,
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.messageThread.groupUserId),
      )
      .innerJoin(tables.group, eq(tables.group.groupUserId, tables.user.id))
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!state?.groupUserId) throw new Error('group invite target is invalid');
    const member = await tx.query.user.findFirst({
      where: eq(tables.user.id, memberUserId),
      columns: { account: true, domain: true, isForeigner: true },
    });
    if (!member) throw new Error('group invite identity is invalid');
    if (status !== 'REVOKED')
      await tx
        .insert(tables.threadParticipant)
        .values({
          threadId,
          userId: memberUserId,
          role: GroupRole.MEMBER,
          relationshipRev: 1,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [
            tables.threadParticipant.userId,
            tables.threadParticipant.threadId,
          ],
        });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const membership = await this.relationshipIntents.writeAuthoredIntentInTx(
      tx,
      {
        groupUserId: state.groupUserId,
        memberUserId,
        authorUserId: state.groupUserId,
        status,
        note,
        expiresAt: status === 'REQUESTED' ? expiresAt : null,
      },
    );
    if (status === 'REVOKED') {
      await this.relationshipIntents.setPairActiveInTx(
        tx,
        state.groupUserId,
        memberUserId,
        false,
      );
    } else if (membership.shouldBeActive) {
      const activated = await this.relationshipIntents.setPairActiveInTx(
        tx,
        state.groupUserId,
        memberUserId,
        true,
      );
      if (activated)
        await tx
          .update(tables.group)
          .set({
            rosterRev: sql`${tables.group.rosterRev} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(tables.group.groupUserId, state.groupUserId));
      if (!member.isForeigner)
        await tx
          .insert(tables.threadAudience)
          .values({
            targetDomain: 'local',
            localUserId: memberUserId,
            threadId,
          })
          .onConflictDoNothing();
    }
    await this.writeGroupRequestEffectsInTx(
      tx,
      threadId,
      state.groupUserId,
      memberUserId,
      clientFeedUpdates,
      membership.request.status,
      requestProjectionDirection ??
        (membership.request.status === 'ACCEPTED'
          ? 'APPLICATION'
          : 'INVITATION'),
      membership.request.status === 'REQUESTED',
    );
    if (!member.isForeigner) {
      const endpoints = clientGroupIntentEndpoints(
        state.groupAccount,
        member.account,
        'GROUP',
      );
      const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
        userId: memberUserId,
        account: endpoints.account,
        domain: 'local',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: endpoints.subjectAccount,
        subjectDomain: 'local',
        body: {
          status: groupIntentWireStatus(membership.request.status),
          note: membership.request.note,
          requestedAt: membership.request.requestedAt?.getTime() ?? null,
          expiresAt: membership.request.expiresAt?.getTime() ?? null,
          threadId,
          group: {
            account: state.groupAccount,
            domain: 'local',
            isLocal: true,
            name: state.groupName,
            avatar: state.groupAvatar,
            description: state.groupDescription,
            profileRev: state.groupProfileRev,
          },
        },
      });
      if (clientFeedId !== null)
        clientFeedUpdates.push({
          userId: memberUserId,
          feedId: clientFeedId,
        });
      return membership.shouldBeActive
        ? this.writeGroupStateInTx(tx, threadId, clientFeedUpdates)
        : new Map();
    }
    const intent = await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain: member.domain,
        account: state.groupAccount,
        domain: this.config.domain,
        subjectAccount: member.account,
        subjectDomain: member.domain,
        eventType: 'RELATIONSHIP_INTENT',
        forceReindex: status === 'ACCEPTED',
        body: {
          status: groupIntentWireStatus(membership.request.status),
          note: membership.request.note,
          requestedAt: membership.request.requestedAt,
          expiresAt: membership.request.expiresAt,
        },
      },
    ]);
    if (membership.request.status !== 'ACCEPTED') {
      const cleanup = await this.cleanupGroupProjectionInTx(
        tx,
        threadId,
        state.groupUserId,
        state.groupAccount,
        member.domain,
        clientFeedUpdates,
      );
      return new Map([...intent, ...cleanup]);
    }
    const profile = await this.writeProfileStateToPeerInTx(
      tx,
      state.groupUserId,
      member.domain,
    );
    const groupState = await this.writeGroupStateInTx(
      tx,
      threadId,
      clientFeedUpdates,
    );
    return new Map([...intent, ...profile, ...groupState]);
  }

  async writeMemberRelationshipIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    status: GroupIntentWireStatus = 'REQUESTED',
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
    note = '',
    groupSnapshot?: FederatedPendingProfileSnapshot,
  ): Promise<Map<string, bigint>> {
    const [thread] = await tx
      .select({ groupUserId: tables.messageThread.groupUserId })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupUserId) throw new Error('group join target is invalid');
    const [groupUser, member] = await Promise.all([
      tx.query.user.findFirst({
        where: eq(tables.user.id, thread.groupUserId),
        columns: {
          account: true,
          domain: true,
          name: true,
          avatar: true,
          bio: true,
          profileRev: true,
        },
      }),
      tx.query.user.findFirst({
        where: eq(tables.user.id, memberUserId),
        columns: { account: true, domain: true, isForeigner: true },
      }),
    ]);
    if (!groupUser || !member || member.isForeigner)
      throw new Error('group join identities are invalid');
    const projectedGroup = applyFederatedPendingProfileSnapshot(
      { name: groupUser.name, avatar: groupUser.avatar },
      groupSnapshot,
    );
    const membership = await this.relationshipIntents.writeAuthoredIntentInTx(
      tx,
      {
        groupUserId: thread.groupUserId,
        memberUserId,
        authorUserId: memberUserId,
        status,
        note,
        expiresAt:
          status === 'REQUESTED'
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            : null,
      },
    );
    let pairActivated = false;
    if (status === 'REVOKED') {
      await this.relationshipIntents.setPairActiveInTx(
        tx,
        thread.groupUserId,
        memberUserId,
        false,
      );
    } else if (membership.shouldBeActive) {
      pairActivated = await this.relationshipIntents.setPairActiveInTx(
        tx,
        thread.groupUserId,
        memberUserId,
        true,
      );
    }
    if (groupUser.domain === 'local' && membership.changed) {
      await this.writeGroupRequestEffectsInTx(
        tx,
        threadId,
        thread.groupUserId,
        memberUserId,
        clientFeedUpdates,
        membership.shouldBeActive ? 'ACCEPTED' : membership.request.status,
        membership.request.status === 'ACCEPTED' ? 'INVITATION' : 'APPLICATION',
        membership.request.status === 'REQUESTED',
      );
    }
    if (groupUser.domain === 'local') {
      if (status === 'REVOKED') {
        return new Map();
      }
      if (clientFeedUpdates && membership.changed) {
        const endpoints = clientGroupIntentEndpoints(
          groupUser.account,
          member.account,
          'MEMBER',
        );
        const feedId = await this.clientStateFeed.writeInTx(tx, {
          userId: memberUserId,
          // Preserve the authored direction in the compacted key. Reusing group->member here would
          // overwrite the group's intent and make bilateral authorization impossible to reconstruct.
          account: endpoints.account,
          domain: 'local',
          eventType: 'RELATIONSHIP_INTENT',
          subjectAccount: endpoints.subjectAccount,
          subjectDomain: 'local',
          body: {
            status: groupIntentWireStatus(membership.request.status),
            note: membership.request.note,
            requestedAt: membership.request.requestedAt,
            expiresAt: membership.request.expiresAt,
            direction: 'OUTGOING',
            threadId,
            group: {
              account: groupUser.account,
              domain: 'local',
              isLocal: true,
              name: projectedGroup.name,
              avatar: projectedGroup.avatar,
              description: groupUser.bio,
              profileRev: groupUser.profileRev,
            },
          },
        });
        if (feedId !== null)
          clientFeedUpdates.push({ userId: memberUserId, feedId });
      }
      if (!membership.shouldBeActive) {
        return new Map();
      }
      if (!pairActivated) return new Map();
      await tx
        .update(tables.group)
        .set({ rosterRev: sql`${tables.group.rosterRev} + 1` })
        .where(eq(tables.group.groupUserId, thread.groupUserId));
      const state = await this.writeGroupStateInTx(
        tx,
        threadId,
        clientFeedUpdates,
      );
      return state;
    }
    const intent = await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain: groupUser.domain,
        account: member.account,
        domain: this.config.domain,
        subjectAccount: groupUser.account,
        subjectDomain: groupUser.domain,
        eventType: 'RELATIONSHIP_INTENT',
        forceReindex: status === 'ACCEPTED',
        body: {
          status: groupIntentWireStatus(membership.request.status),
          note: membership.request.note,
          requestedAt: membership.request.requestedAt,
          expiresAt: membership.request.expiresAt,
        },
      },
    ]);
    if (
      clientFeedUpdates &&
      membership.changed &&
      membership.request.status === 'REQUESTED'
    ) {
      const endpoints = clientGroupIntentEndpoints(
        groupUser.account,
        member.account,
        'MEMBER',
      );
      const feedId = await this.clientStateFeed.writeInTx(tx, {
        userId: memberUserId,
        account: endpoints.account,
        domain: 'local',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: endpoints.subjectAccount,
        subjectDomain: groupUser.domain,
        body: {
          status: 'REQUESTED',
          note: membership.request.note,
          requestedAt: membership.request.requestedAt,
          expiresAt: membership.request.expiresAt,
          direction: 'OUTGOING',
          threadId,
          group: {
            account: groupUser.account,
            domain: groupUser.domain,
            isLocal: false,
            name: projectedGroup.name,
            avatar: projectedGroup.avatar,
            description: groupUser.bio,
            profileRev: groupUser.profileRev,
          },
        },
      });
      if (feedId !== null)
        clientFeedUpdates.push({ userId: memberUserId, feedId });
    }
    if (membership.request.status !== 'ACCEPTED') {
      await this.cleanupProfileProjectionInTx(
        tx,
        memberUserId,
        member.account,
        groupUser.domain,
      );
      return intent;
    }
    const profile = await this.writeProfileStateToPeerInTx(
      tx,
      memberUserId,
      groupUser.domain,
    );
    return new Map([...intent, ...profile]);
  }

  /** Run the manager projection effect after the authored intent and pair fold have been applied. */
  private async writeGroupRequestEffectsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupUserId: number,
    memberUserId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
    status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' = 'REQUESTED',
    direction: 'APPLICATION' | 'INVITATION' = 'APPLICATION',
    createIfMissing = true,
    managerUserId?: number,
  ): Promise<void> {
    if (!clientFeedUpdates) return;
    const [groupIdentity, request, member, managers] = await Promise.all([
      tx.query.user.findFirst({
        where: eq(tables.user.id, groupUserId),
        columns: { account: true, domain: true },
      }),
      tx.query.relationshipIntent.findFirst({
        where: and(
          eq(
            tables.relationshipIntent.authorUserId,
            direction === 'APPLICATION' ? memberUserId : groupUserId,
          ),
          eq(
            tables.relationshipIntent.subjectUserId,
            direction === 'APPLICATION' ? groupUserId : memberUserId,
          ),
        ),
        columns: {
          id: true,
          status: true,
          note: true,
          requestedAt: true,
          expiresAt: true,
          updatedAt: true,
        },
      }),
      tx.query.user.findFirst({
        where: eq(tables.user.id, memberUserId),
        columns: {
          id: true,
          account: true,
          domain: true,
          name: true,
          avatar: true,
          bio: true,
          profileRev: true,
          isForeigner: true,
        },
      }),
      tx
        .select({ userId: tables.threadParticipant.userId })
        .from(tables.threadParticipant)
        .innerJoin(
          tables.user,
          eq(tables.user.id, tables.threadParticipant.userId),
        )
        .where(
          and(
            eq(tables.threadParticipant.threadId, threadId),
            inArray(tables.threadParticipant.role, [
              GroupRole.OWNER,
              GroupRole.ADMIN,
            ]),
            eq(tables.user.domain, 'local'),
            managerUserId === undefined
              ? undefined
              : eq(tables.threadParticipant.userId, managerUserId),
          ),
        ),
    ]);
    if (!groupIdentity || !request || !member) return;
    const existingManagers = createIfMissing
      ? new Set<number>()
      : new Set(
          (
            await tx
              .select({
                managerUserId: tables.groupRequestProjection.managerUserId,
              })
              .from(tables.groupRequestProjection)
              .where(
                and(
                  eq(tables.groupRequestProjection.threadId, threadId),
                  eq(tables.groupRequestProjection.memberUserId, memberUserId),
                  eq(tables.groupRequestProjection.direction, direction),
                ),
              )
          ).map((row) => row.managerUserId),
        );
    for (const manager of managers) {
      // Group creation writes the owner's symmetric authorization intents; it is not an application.
      if (manager.userId === memberUserId) continue;
      if (!createIfMissing && !existingManagers.has(manager.userId)) continue;
      const feedId = await this.clientStateFeed.writeGroupRequestInTx(tx, {
        managerUserId: manager.userId,
        threadId,
        memberUserId: member.id,
        direction,
        requestId: request.id,
        status,
        note: request.note,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt,
      });
      if (feedId === null) continue;
      clientFeedUpdates.push({ userId: manager.userId, feedId });
      clientFeedUpdates.push(
        ...(await this.clientStateFeed.recordProfileStateInTx(tx, member.id, [
          manager.userId,
        ])),
      );
      const headFeedId =
        await this.clientStateFeed.writeGroupJoinRequestHeadInTx(tx, {
          userId: manager.userId,
          account: groupIdentity.account,
          domain: this.config.domain,
          threadId,
          latestFeedId: feedId,
          latestRequestAt: request.requestedAt?.getTime() ?? Date.now(),
        });
      if (headFeedId !== null)
        clientFeedUpdates.push({ userId: manager.userId, feedId: headFeedId });
    }
  }

  /** Reconcile all retained applications when a local member gains or loses manager ownership. */
  async reconcileGroupJoinRequestManagerInTx(
    tx: DatabaseTransaction,
    threadId: number,
    managerUserId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<void> {
    const [manager, thread] = await Promise.all([
      tx.query.threadParticipant.findFirst({
        where: and(
          eq(tables.threadParticipant.threadId, threadId),
          eq(tables.threadParticipant.userId, managerUserId),
          inArray(tables.threadParticipant.role, [
            GroupRole.OWNER,
            GroupRole.ADMIN,
          ]),
        ),
        columns: { id: true },
      }),
      tx.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: { groupUserId: true },
      }),
    ]);
    if (!thread?.groupUserId) return;
    if (!manager) {
      const removed = await tx
        .delete(tables.groupRequestProjection)
        .where(
          and(
            eq(tables.groupRequestProjection.managerUserId, managerUserId),
            eq(tables.groupRequestProjection.threadId, threadId),
          ),
        )
        .returning({
          memberUserId: tables.groupRequestProjection.memberUserId,
        });
      for (const request of removed)
        await this.clientStateFeed.cleanupProfileStateIfUnreferencedInTx(
          tx,
          managerUserId,
          request.memberUserId,
        );
      return;
    }
    const requests = await tx
      .selectDistinctOn(
        [
          tables.groupRequestProjection.memberUserId,
          tables.groupRequestProjection.direction,
        ],
        {
          memberUserId: tables.groupRequestProjection.memberUserId,
          status: tables.groupRequestProjection.status,
          direction: tables.groupRequestProjection.direction,
        },
      )
      .from(tables.groupRequestProjection)
      .where(
        and(
          eq(tables.groupRequestProjection.threadId, threadId),
          sql`${tables.groupRequestProjection.expiresAt} > CURRENT_TIMESTAMP`,
        ),
      )
      .orderBy(
        tables.groupRequestProjection.memberUserId,
        tables.groupRequestProjection.direction,
        desc(tables.groupRequestProjection.feedId),
      );
    for (const request of requests)
      await this.writeGroupRequestEffectsInTx(
        tx,
        threadId,
        thread.groupUserId,
        request.memberUserId,
        clientFeedUpdates,
        request.status as 'REQUESTED' | 'ACCEPTED' | 'REVOKED',
        request.direction as 'APPLICATION' | 'INVITATION',
        true,
        managerUserId,
      );
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
          groupUserId: tables.messageThread.groupUserId,
          groupDomain: tables.user.domain,
        })
        .from(tables.messageThread)
        .innerJoin(
          tables.user,
          eq(tables.user.id, tables.messageThread.groupUserId),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      if (!thread?.groupUserId)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      if (
        !(await this.relationshipIntents.hasValidInviteInTx(
          tx,
          thread.groupUserId,
          memberUserId,
        ))
      )
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      const existing = await tx.query.threadParticipant.findFirst({
        where: and(
          eq(tables.threadParticipant.threadId, threadId),
          eq(tables.threadParticipant.userId, memberUserId),
        ),
        columns: { id: true },
      });
      const alreadyVisible =
        existing != null &&
        (await isThreadMutuallyAuthorized(tx, memberUserId, threadId));
      if (thread.groupDomain === 'local') {
        await assertServerGroupCapacityInTx(tx, threadId, memberUserId);
        await this.participantService.upsertMemberInTx(
          tx,
          threadId,
          memberUserId,
          GroupRole.MEMBER,
        );
      } else {
        await tx
          .update(tables.threadParticipant)
          .set({
            relationshipRev: sql`${tables.threadParticipant.relationshipRev} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tables.threadParticipant.threadId, threadId),
              eq(tables.threadParticipant.userId, memberUserId),
            ),
          );
      }
      await tx
        .insert(tables.threadAudience)
        .values({
          targetDomain: 'local',
          localUserId: memberUserId,
          threadId,
        })
        .onConflictDoNothing();
      const allocated = await this.writeMemberRelationshipIntentInTx(
        tx,
        threadId,
        memberUserId,
        'ACCEPTED',
        clientFeedUpdates,
      );
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
    const uniqueDomains = [...new Set(domains)];
    const results = await Promise.allSettled(
      uniqueDomains.map((domain) => this.pushDiscoveryHwm(domain)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected')
        this.logger.warn(
          `state-feed HWM push ${uniqueDomains[index]} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
    });
  }

  /** Materialize expired directions authored by this server as durable revocations. The expiry
   * boundary itself remains authoritative; this sweep only makes the already-effective negative
   * state explicit so clients and peers converge without retaining stale REQUESTED snapshots. */
  async revokeExpiredLocalRequests(): Promise<number> {
    const pendingClientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const expired = await tx.execute<{
        authorUserId: number;
        subjectUserId: number;
        authorAccount: string;
        authorDomain: string;
        authorIsGroup: boolean;
        subjectAccount: string;
        subjectDomain: string;
        subjectIsGroup: boolean;
        threadId: number | null;
      }>(sql`
        SELECT intent."authorUserId", intent."subjectUserId",
          author.account AS "authorAccount", author.domain AS "authorDomain",
          author."isGroup" AS "authorIsGroup",
          subject.account AS "subjectAccount", subject.domain AS "subjectDomain",
          subject."isGroup" AS "subjectIsGroup", pair."threadId"
        FROM "RelationshipIntent" intent
        JOIN "User" author ON author.id = intent."authorUserId"
        JOIN "User" subject ON subject.id = intent."subjectUserId"
        LEFT JOIN "RelationshipPair" pair
          ON pair."userLowId" = LEAST(intent."authorUserId", intent."subjectUserId")
         AND pair."userHighId" = GREATEST(intent."authorUserId", intent."subjectUserId")
        WHERE author.domain = 'local'
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" <= CURRENT_TIMESTAMP
        ORDER BY intent."expiresAt", intent."authorUserId", intent."subjectUserId"
      `);
      const allocated = new Map<string, bigint>();
      let count = 0;
      for (const request of expired.rows) {
        await this.relationshipIntents.lockPairInTx(
          tx,
          request.authorUserId,
          request.subjectUserId,
        );
        const updated = await tx.execute(sql`
          UPDATE "RelationshipIntent"
          SET status = 'REVOKED', note = '', "requestedAt" = NULL,
            "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "authorUserId" = ${request.authorUserId}
            AND "subjectUserId" = ${request.subjectUserId}
            AND status = 'REQUESTED' AND "expiresAt" <= CURRENT_TIMESTAMP
          RETURNING 1
        `);
        if ((updated.rowCount ?? 0) === 0) continue;
        count += 1;

        await this.relationshipIntents.setPairActiveInTx(
          tx,
          request.authorUserId,
          request.subjectUserId,
          false,
        );
        if (request.threadId !== null) {
          if (request.authorIsGroup || request.subjectIsGroup) {
            const memberUserId = request.authorIsGroup
              ? request.subjectUserId
              : request.authorUserId;
            const groupIsLocal = request.authorIsGroup
              ? request.authorDomain === 'local'
              : request.subjectDomain === 'local';
            if (groupIsLocal)
              await this.writeGroupRequestEffectsInTx(
                tx,
                request.threadId,
                request.authorIsGroup
                  ? request.authorUserId
                  : request.subjectUserId,
                memberUserId,
                pendingClientFeedUpdates,
                'REVOKED',
                request.authorIsGroup ? 'INVITATION' : 'APPLICATION',
                false,
              );
            if (!request.authorIsGroup || request.subjectDomain === 'local')
              await this.invite.writeGroupRequestClientStateInTx(
                tx,
                request.threadId,
                memberUserId,
                pendingClientFeedUpdates,
              );
          } else {
            pendingClientFeedUpdates.push(
              ...(await this.invite.writeFriendRequestClientStateInTx(
                tx,
                request.authorUserId,
                request.subjectUserId,
              )),
            );
          }
        }
        if (request.subjectDomain === 'local') continue;
        const revisions = await this.stateFeed.writeManyInTx(tx, [
          {
            peerDomain: request.subjectDomain,
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
    const [state] = await tx
      .select({
        groupUserId: tables.group.groupUserId,
        account: tables.user.account,
        name: tables.user.name,
        bio: tables.user.bio,
        avatar: tables.user.avatar,
        profileRev: tables.user.profileRev,
        rosterRev: tables.group.rosterRev,
        dissolvedAt: tables.group.dissolvedAt,
        ownerId: tables.group.ownerId,
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.messageThread.groupUserId),
      )
      .innerJoin(tables.group, eq(tables.group.groupUserId, tables.user.id))
      .where(
        and(
          eq(tables.messageThread.id, threadId),
          eq(tables.user.domain, 'local'),
        ),
      )
      .limit(1);
    if (!state) return new Map();
    const roster = await tx
      .select({
        account: tables.user.account,
        domain: tables.user.domain,
        role: tables.threadParticipant.role,
        userId: tables.user.id,
        name: tables.user.name,
        avatar: tables.user.avatar,
        isForeigner: tables.user.isForeigner,
        profileRev: tables.user.profileRev,
        remoteProfileRev: tables.user.remoteProfileRev,
      })
      .from(tables.threadParticipant)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.threadParticipant.userId),
      )
      .where(eq(tables.threadParticipant.threadId, threadId));
    const rosterAuthorization = await Promise.all(
      roster.map((member) =>
        isThreadMutuallyAuthorized(tx, member.userId, threadId),
      ),
    );
    const authorizedRoster = roster.filter(
      (_, index) => rosterAuthorization[index],
    );
    const clientGroupUpdates = await this.clientStateFeed.recordGroupStateInTx(
      tx,
      threadId,
    );
    clientFeedUpdates?.push(...clientGroupUpdates);
    const normalizeDomain = (domain: string) =>
      domain === 'local' ? this.config.domain : domain;
    const peerDomains = new Set(
      authorizedRoster
        .map((member) => member.domain)
        .filter((domain) => domain !== 'local'),
    );
    if (!peerDomains.size) return new Map();
    const wire = state.avatar
      ? await this.upload.readAvatarAsWire(state.avatar)
      : null;
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
    if (!this.groupMetaFeed) throw new Error('group meta feed is unavailable');
    const memberProjection = state.dissolvedAt
      ? []
      : await Promise.all(
          authorizedRoster.map(async (member) => {
            const memberWire = member.avatar
              ? await this.upload.readAvatarAsWire(member.avatar)
              : null;
            return {
              account: member.account,
              domain: normalizeDomain(member.domain),
              body: {
                role: member.role ?? GroupRole.MEMBER,
                profileRev: member.isForeigner
                  ? (member.remoteProfileRev ?? 0)
                  : member.profileRev,
                displayName: member.name,
                avatar: memberWire
                  ? {
                      digest: createHash('sha256')
                        .update(Buffer.from(memberWire.b64, 'base64'))
                        .digest('hex'),
                      mimeType: 'image/webp',
                      base64: memberWire.b64,
                      width: memberWire.w,
                      height: memberWire.h,
                    }
                  : null,
              },
            };
          }),
        );
    const groupMetaHeads = new Map<string, bigint>();
    for (const peerDomain of peerDomains)
      groupMetaHeads.set(
        peerDomain,
        await this.groupMetaFeed.reconcileInTx(
          tx,
          peerDomain,
          state.groupUserId,
          memberProjection,
        ),
      );
    const groupState = await this.stateFeed.writeManyInTx(
      tx,
      [...peerDomains].flatMap((peerDomain) => [
        {
          peerDomain,
          account: state.account,
          domain: this.config.domain,
          eventType: 'PROFILE' as const,
          subjectAccount: '',
          subjectDomain: 'local',
          revision: state.profileRev,
          body: {
            profileRev: state.profileRev,
            displayName: state.name,
            bio: state.bio,
            avatar,
          },
        },
        {
          peerDomain,
          account: state.account,
          domain: this.config.domain,
          eventType: 'GROUP_META_FEED_HEAD' as const,
          subjectAccount: '',
          subjectDomain: 'local',
          body: {
            groupMetaFeedEndId: groupMetaHeads.get(peerDomain)!.toString(),
          },
        },
      ]),
    );
    return groupState;
  }

  /** Public profile of a local user (GET /s2s/v1/users/:account). Null if not local / not found. */
  async getLocalUserProfile(address: S2SAddress): Promise<S2SProfile | null> {
    if (address.domain !== this.config.domain) return null;
    const u = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(address.account)),
        eq(tables.user.domain, 'local'),
      ),
    });
    if (!u || u.isForeigner) return null;
    return this.toS2SProfile(u);
  }

  /** Find or create a foreign User stub for account@<peer-domain>. Stubs never authenticate. */
  async ensureForeignUser(account: string, domain: string): Promise<number> {
    const acct = normalizeAccount(account); // case-insensitive
    const existing = await this.database.db.query.user.findFirst({
      where: and(eq(tables.user.account, acct), eq(tables.user.domain, domain)),
    });
    if (existing) return existing.id;
    const [created] = await this.database.db
      .insert(tables.user)
      .values({
        account: acct,
        domain,
        isForeigner: true,
        hashPwd: randomUUID(), // unusable — stubs never log in
        name: acct,
        avatar: '',
        bio: '',
        updatedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [tables.user.account, tables.user.domain],
      })
      .returning({ id: tables.user.id });
    if (!created) {
      const winner = await this.database.db.query.user.findFirst({
        where: and(
          eq(tables.user.account, acct),
          eq(tables.user.domain, domain),
        ),
        columns: { id: true },
      });
      if (!winner) throw new Error('failed to create foreign user');
      return winner.id;
    }
    return created.id;
  }

  private async ensureForeignUserInTransaction(
    tx: DatabaseTransaction,
    account: string,
    domain: string,
  ): Promise<number> {
    const acct = normalizeAccount(account);
    const existing = await tx.query.user.findFirst({
      where: and(eq(tables.user.account, acct), eq(tables.user.domain, domain)),
      columns: { id: true },
    });
    if (existing) return existing.id;
    const [created] = await tx
      .insert(tables.user)
      .values({
        account: acct,
        domain,
        isForeigner: true,
        hashPwd: randomUUID(),
        name: acct,
        avatar: '',
        bio: '',
        updatedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [tables.user.account, tables.user.domain],
      })
      .returning({ id: tables.user.id });
    if (created) return created.id;
    const winner = await tx.query.user.findFirst({
      where: and(eq(tables.user.account, acct), eq(tables.user.domain, domain)),
      columns: { id: true },
    });
    if (!winner) throw new Error('failed to create foreign user');
    return winner.id;
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
    const stub = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, userId),
      columns: { remoteProfileRev: true },
    });
    if (!stub || stub.remoteProfileRev !== null) return; // already localized (or gone)
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
    const base = await this.discovery.resolveBase(peerDomain);
    await this.sendSignedPost(new URL(`${base}${path}`), body, peerDomain);
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
    const release = await this.discovery.acquireRequestSlot(peerDomain);
    try {
      const operationStartedAt = new Date();
      const headers = await this.signature.signOutbound({
        method: 'POST',
        url,
        body,
      });
      let res: Response;
      try {
        res = await this.discovery.request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
          signal: AbortSignal.timeout(
            this.transportConfig.get().callTimeoutSec * 1000,
          ),
        });
      } catch (e) {
        await this.recognition.markTransportDegraded(
          peerDomain,
          `POST network/timeout: ${(e as Error).message}`,
          operationStartedAt,
        );
        throw new Error(
          `S2S POST to ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
        );
      }
      const status = res.status;
      if (status >= 200 && status < 300) {
        await this.markContactSuccess(peerDomain);
        if (status !== HttpStatus.NO_CONTENT) {
          const envelope = (await res.json().catch(() => undefined)) as
            | { code?: unknown; data?: unknown }
            | undefined;
          if (envelope?.code !== 0) {
            throw new S2sResponseError(
              `S2S POST to ${peerDomain} returned business code ${String(envelope?.code)}`,
              status,
              typeof envelope?.code === 'number'
                ? envelope.code
                : BusinessCode.FEDERATION_MALFORMED,
              envelope?.data,
            );
          }
        }
        return;
      }
      const errBody = await res.json().catch(() => undefined);
      const code = typeof errBody?.code === 'number' ? errBody.code : undefined;
      if (status === HttpStatus.SERVICE_UNAVAILABLE) {
        await this.recognition.markTransportDegraded(
          peerDomain,
          `POST HTTP ${status}`,
          operationStartedAt,
        );
      } else if (status === HttpStatus.CONFLICT && this.isFatalPeerCode(code)) {
        await this.markPeerHalted(peerDomain, code, errBody?.message);
      }
      throw new S2sResponseError(
        `S2S POST to ${peerDomain} rejected: HTTP ${status}`,
        status,
        code,
        errBody?.data,
      );
    } finally {
      release();
    }
  }

  /** GET a signed S2S endpoint (users / revision). Returns the parsed JSON. Throws on non-success. */
  private async getSigned<T>(
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<T> {
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}${path}`);
    const release = await this.discovery.acquireRequestSlot(peerDomain);
    try {
      const operationStartedAt = new Date();
      const headers = await this.signature.signOutbound({
        method: 'GET',
        url,
        body: '', // GET — the content-digest covers sha256("")
      });
      let res: Response;
      try {
        res = await this.discovery.request(url, {
          method: 'GET',
          headers: { ...headers },
          signal: AbortSignal.timeout(
            this.transportConfig.get().callTimeoutSec * 1000,
          ),
        });
      } catch (e) {
        await this.recognition.markTransportDegraded(
          peerDomain,
          `GET ${path} network/timeout: ${(e as Error).message}`,
          operationStartedAt,
        );
        throw new Error(
          `S2S GET ${path} from ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
        );
      }
      if (!res.ok) {
        const status = res.status;
        const body = await res.json().catch(() => undefined);
        const code = typeof body?.code === 'number' ? body.code : undefined;
        if (status === HttpStatus.SERVICE_UNAVAILABLE) {
          await this.recognition.markTransportDegraded(
            peerDomain,
            `GET ${path} HTTP ${status}`,
            operationStartedAt,
          );
        } else if (
          status === HttpStatus.CONFLICT &&
          this.isFatalPeerCode(code)
        ) {
          await this.markPeerHalted(peerDomain, code, body?.message);
        }
        throw new S2sResponseError(
          `S2S GET ${path} from ${peerDomain} rejected: HTTP ${status}`,
          status,
          code,
          body?.data,
        );
      }
      await this.markContactSuccess(peerDomain);
      if (maxResponseBytes !== undefined) {
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > maxResponseBytes) {
          throw new S2sResponseError(
            `S2S GET ${path} response exceeds ${maxResponseBytes} bytes`,
            HttpStatus.OK,
            BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
          );
        }
      }
      let boundedBody: unknown;
      if (maxResponseBytes === undefined) {
        boundedBody = await res.json();
      } else {
        const text = await res.text();
        if (Buffer.byteLength(text) > maxResponseBytes) {
          throw new S2sResponseError(
            `S2S GET ${path} response exceeds ${maxResponseBytes} bytes`,
            HttpStatus.OK,
            BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
          );
        }
        boundedBody = JSON.parse(text) as unknown;
      }
      const parsed = boundedBody as {
        code?: number;
        data?: unknown;
      };
      // Success bodies are ApiResult envelopes { code, message, data }. A non-zero code is a business
      // outcome delivered at HTTP 200 (a lookup target that doesn't exist → NOT_FOUND); the peer is healthy
      // and answered (markContactSuccess above already advanced liveness), so surface it as a typed
      // S2sResponseError WITHOUT degrading — callers' catch logic keeps working. Unwrapping `data` here means
      // every getSigned caller still receives the typed payload (res.messages / res.profileRev / …), not the
      // envelope — no call site changes. The !res.ok branch above carries the registered protocol statuses.
      if (typeof parsed?.code === 'number' && parsed.code !== BusinessCode.OK) {
        throw new S2sResponseError(
          `S2S GET ${path} from ${peerDomain} business error: code ${parsed.code}`,
          res.status,
          parsed.code,
          parsed.data,
        );
      }
      return (parsed?.data ?? parsed) as T;
    } finally {
      release();
    }
  }

  // ─── bidirectional server recognition ─────────────────────────────────────────

  /**
   * Establish or recover the two directional recognition facts before ordinary data-plane traffic.
   */
  async ensurePeerTrusted(domain: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (existing?.resetInProgress) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        `${domain} federation relationship is under administrative maintenance`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (existing?.trustLevel === 'available') {
      return;
    }
    if (existing?.trustLevel === 'halted') {
      const code = [
        BusinessCode.FEDERATION_PEER_BLOCKED,
        BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        BusinessCode.FEDERATION_PROTOCOL_VERSION_UNSUPPORTED,
      ].includes(existing.haltCode as BusinessCode)
        ? existing.haltCode!
        : BusinessCode.FEDERATION_IDENTITY_MISMATCH;
      throw new BusinessException(
        code,
        existing.haltReason ?? `${domain} federation relationship is halted`,
        HttpStatus.CONFLICT,
      );
    }
    await this.recognition.recover(domain);
  }

  /**
   * Recover one reconnect-sweep candidate without confusing availability with identity bootstrap.
   * Retry missing Recognize facts or a degraded transport without replacing the pinned root.
   */
  async recoverPeerTrust(domain: string): Promise<void> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
      columns: { trustLevel: true },
    });
    if (
      !peer ||
      !['unrecognized', 'establishing', 'degraded'].includes(peer.trustLevel)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
        `${domain} is not eligible for automatic recovery`,
        HttpStatus.CONFLICT,
      );
    }
    await this.recognition.recognize(domain);
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
    if (domain === this.config.domain) return true;
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    return existing?.trustLevel === 'available';
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
  private static readonly LAST_SUCCESS_WINDOW_MS = 60_000;
  /** Per-domain in-memory guard so the hot S2S path skips the liveness DB round trip entirely within
   *  the window (59 of 60 ops do zero DB work). Bounded by the (small) trusted-peer count; resets on
   *  restart — the conditional write below keeps correctness across restart + instances. */
  private readonly lastSuccessSentAt = new Map<string, number>();

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
    try {
      await this.recognition.markReachable(domain);
    } catch {
      // Reachability bookkeeping is secondary to the completed operation.
    }
    const now = Date.now();
    const last = this.lastSuccessSentAt.get(domain);
    if (
      last !== undefined &&
      now - last < FederationService.LAST_SUCCESS_WINDOW_MS
    )
      return;
    this.lastSuccessSentAt.set(domain, now);
    try {
      await this.database.db
        .update(tables.federatedPeer)
        .set({ lastSuccessAt: new Date(now) })
        .where(
          and(
            eq(tables.federatedPeer.domain, domain),
            eq(tables.federatedPeer.resetInProgress, false),
            or(
              isNull(tables.federatedPeer.lastSuccessAt),
              lt(
                tables.federatedPeer.lastSuccessAt,
                new Date(now - FederationService.LAST_SUCCESS_WINDOW_MS),
              ),
            ),
          ),
        );
    } catch {
      // Best-effort liveness watermark — never break the caller's op.
    }
  }

  /** Compatibility wrapper for callers that observed a successful signed round trip. */
  async markRecovered(domain: string): Promise<void> {
    await this.recognition.markReachable(domain);
  }

  private isFatalPeerCode(code: unknown): code is number {
    return [
      BusinessCode.FEDERATION_PEER_BLOCKED,
      BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      BusinessCode.FEDERATION_PROTOCOL_VERSION_UNSUPPORTED,
    ].includes(code as BusinessCode);
  }

  private async markPeerHalted(
    domain: string,
    code: number,
    message: unknown,
  ): Promise<void> {
    const reason =
      typeof message === 'string'
        ? message
        : `peer returned fatal federation code ${code}`;
    await this.database.db
      .update(tables.federatedPeer)
      .set({
        trustLevel: 'halted',
        remoteServiceReachable: false,
        haltedAt: new Date(),
        haltCode: code,
        haltReason: reason.slice(0, 255),
      })
      .where(eq(tables.federatedPeer.domain, domain));
    await this.logEvent(domain, 'halted', reason);
  }

  /** Admin block: forbid federation with a peer; recognition and ordinary inbound traffic both reject
   *  this durable policy state. Idempotent. Logs a `blocked` event. */
  async markBlocked(domain: string, note?: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (
      existing?.trustLevel === 'halted' &&
      existing.haltCode === BusinessCode.FEDERATION_PEER_BLOCKED
    )
      return;
    const now = new Date();
    await this.database.db
      .insert(tables.federatedPeer)
      .values({
        domain,
        trustLevel: 'halted',
        haltedAt: now,
        haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
        haltReason: note ?? 'blocked by local policy',
      })
      .onConflictDoUpdate({
        target: tables.federatedPeer.domain,
        set: {
          trustLevel: 'halted',
          haltedAt: now,
          haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
          haltReason: note ?? 'blocked by local policy',
        },
      });
    await this.logEvent(domain, 'halted', note ?? 'blocked by local policy');
  }

  /** Admin unblock reopens recognition without fabricating either directional confirmation. */
  async markUnblocked(domain: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (
      !existing ||
      existing.trustLevel !== 'halted' ||
      existing.haltCode !== BusinessCode.FEDERATION_PEER_BLOCKED ||
      existing.resetInProgress
    )
      return;
    const trustLevel = !existing.identityPinnedAt
      ? 'unrecognized'
      : existing.recognizesPeer &&
          existing.outboundRecognitionConfirmed &&
          existing.inboundRecognitionConfirmed &&
          existing.localServiceAvailable
        ? existing.remoteServiceReachable
          ? 'available'
          : 'degraded'
        : 'establishing';
    await this.database.db
      .update(tables.federatedPeer)
      .set({
        trustLevel,
        haltedAt: null,
        haltCode: null,
        haltReason: null,
      })
      .where(eq(tables.federatedPeer.domain, domain));
    await this.logEvent(domain, 'unblocked');
  }

  /** Append a lifecycle transition to the audit log. Best-effort: the peer-state mutation is the
   *  primary effect; a log failure must not break the caller's flow. */
  private async logEvent(
    domain: string,
    type: string,
    reason?: string,
  ): Promise<void> {
    try {
      await this.database.db.insert(tables.federatedPeerEvent).values({
        domain,
        type,
        reason: reason ? reason.slice(0, 255) : null,
      });
    } catch {
      // Swallow — audit row is secondary to the state mutation.
    }
  }

  /** Admin list: peers with their lifecycle columns, filtered by free-text domain + trust state. */
  async listPeers(opts: {
    skip: number;
    take: number;
    search?: string;
    status?: string;
  }) {
    const where = and(
      ...(opts.search
        ? [ilike(tables.federatedPeer.domain, `%${opts.search}%`)]
        : []),
      ...(opts.status
        ? [eq(tables.federatedPeer.trustLevel, opts.status)]
        : []),
    );
    const [list, total] = await Promise.all([
      this.database.db.query.federatedPeer.findMany({
        where,
        offset: opts.skip,
        limit: opts.take,
        orderBy: desc(tables.federatedPeer.createdAt),
      }),
      this.database.db
        .select({ value: count() })
        .from(tables.federatedPeer)
        .where(where)
        .then(([row]) => row.value),
    ]);
    return { list, total };
  }

  /** Admin timeline: a peer's lifecycle events, newest-first. */
  async peerEvents(domain: string, take = 100) {
    return this.database.db.query.federatedPeerEvent.findMany({
      where: eq(tables.federatedPeerEvent.domain, domain),
      orderBy: desc(tables.federatedPeerEvent.createdAt),
      limit: take,
    });
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
    const domain = peerDomain.trim().toLowerCase().replace(/\.+$/, '');
    if (confirmDomain.trim().toLowerCase().replace(/\.+$/, '') !== domain) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'confirmDomain must exactly match the peer domain',
        HttpStatus.BAD_REQUEST,
      );
    }
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
      columns: {
        trustLevel: true,
        haltCode: true,
        resetInProgress: true,
        rootKeyFingerprint: true,
        rootPublicKey: true,
        identityPinnedAt: true,
      },
    });
    if (
      peer?.trustLevel !== 'halted' ||
      peer.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH ||
      peer.resetInProgress ||
      !peer.identityPinnedAt ||
      !peer.rootKeyFingerprint ||
      !peer.rootPublicKey
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `${domain} is not an idle identity-mismatch halted peer with complete pinned evidence`,
        HttpStatus.CONFLICT,
      );
    }

    // The explicit admin action is also an instruction to discard a possibly polluted cached DNS route.
    this.discovery.invalidateBase(domain);
    const doc = await this.discovery.fetchWellKnown(domain);
    const publishedKey = doc.keys[0];
    const originalIdentityReturned =
      selectFederationProtocolVersion(doc.protocolVersions) ===
        FEDERATION_PROTOCOL_VERSION &&
      doc.rootKey.ed25519 === peer.rootPublicKey;
    if (!originalIdentityReturned || !publishedKey) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        `${domain} still does not present the original pinned identity`,
        HttpStatus.CONFLICT,
      );
    }

    await this.discovery.cacheDocument(domain, doc);
    await this.database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          trustLevel: tables.federatedPeer.trustLevel,
          haltCode: tables.federatedPeer.haltCode,
          resetInProgress: tables.federatedPeer.resetInProgress,
          rootKeyFingerprint: tables.federatedPeer.rootKeyFingerprint,
          rootPublicKey: tables.federatedPeer.rootPublicKey,
        })
        .from(tables.federatedPeer)
        .where(eq(tables.federatedPeer.domain, domain))
        .for('update')
        .limit(1);
      if (
        locked?.trustLevel !== 'halted' ||
        locked.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH ||
        locked.resetInProgress ||
        locked.rootKeyFingerprint !== peer.rootKeyFingerprint ||
        locked.rootPublicKey !== peer.rootPublicKey
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          `${domain} pinned identity changed during recovery`,
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .update(tables.federatedPeer)
        .set({
          trustLevel: 'degraded',
          remoteServiceReachable: false,
          haltedAt: null,
          haltCode: null,
          haltReason: null,
          degradedAt: null,
          degradationReason: null,
          lastSuccessAt: new Date(),
        })
        .where(eq(tables.federatedPeer.domain, domain));
      await tx.insert(tables.federatedPeerEvent).values({
        domain,
        type: 'recovered',
        reason: 'administrator verified the original pinned identity',
      });
    });
    return { domain, trustLevel: 'degraded' };
  }

  /** POST /s2s/v1/call — deliver ONE ephemeral WebRTC call frame (ring / lifecycle / SDP-ICE relay)
   *  to the peer server hosting the call's other participant. Awaitable so the caller's `initiate` can
   *  detect a ring failure (→ the `unreachable` terminal bubble). The persisted CALL record rides the
   *  pull-based message sync, NOT this frame. `peerDomain` is the server hosting the foreign participant. */
  async sendCallFrame(
    params: OutboundCallFrameParams,
    peerDomain: string,
  ): Promise<void> {
    const queueKey = JSON.stringify([peerDomain, params.callSid]);
    // `ringing` is advisory and does not change the call phase. It must not delay or poison `accepted`:
    // the endpoint may acknowledge alerting and accept concurrently, and a late ringing frame is a
    // historical no-op at an already-accepted receiver.
    if (params.op === 'ringing') {
      return this.postCallFrame(params, peerDomain);
    }
    const previous = this.callLifecycleTails.get(queueKey);
    const failed = this.callLifecycleFailures.get(queueKey);
    if (params.op === 'incoming') {
      this.callLifecycleFailures.delete(queueKey);
    } else if (failed && params.op !== failed.op) {
      throw failed.error;
    }
    if (params.op === 'signal') {
      await previous;
      const delivery = this.postCallFrame(params, peerDomain);
      if (params.kind !== 'answer') return delivery;
      const pending = this.callAnswerDeliveries.get(queueKey) ?? new Set();
      pending.add(delivery);
      this.callAnswerDeliveries.set(queueKey, pending);
      try {
        await delivery;
      } finally {
        pending.delete(delivery);
        if (pending.size === 0) this.callAnswerDeliveries.delete(queueKey);
      }
      return;
    }

    const lifecyclePredecessor =
      failed?.op === params.op
        ? (previous ?? Promise.resolve()).catch(() => undefined)
        : (previous ?? Promise.resolve());
    const pendingAnswers =
      params.op === 'connected'
        ? [...(this.callAnswerDeliveries.get(queueKey) ?? [])]
        : [];
    const predecessor = Promise.all([
      lifecyclePredecessor,
      ...pendingAnswers,
    ]).then(() => undefined);
    const current = predecessor.then(async () => {
      try {
        await this.postCallFrame(params, peerDomain);
        this.callLifecycleFailures.delete(queueKey);
      } catch (error) {
        this.callLifecycleFailures.set(queueKey, { op: params.op, error });
        throw error;
      }
    });
    this.callLifecycleTails.set(queueKey, current);
    try {
      await current;
    } finally {
      if (this.callLifecycleTails.get(queueKey) === current) {
        this.callLifecycleTails.delete(queueKey);
      }
    }
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
        id: params.signalId!,
        kind: params.kind!,
        data: params.payload!,
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
        payload: { startedAt: params.startedAt! },
      };
    } else if (params.op === 'ended') {
      frame = {
        ...base,
        op: 'ended',
        payload: { endReason: params.endReason! },
      };
    } else if (params.op === 'video-upgraded') {
      frame = { ...base, op: 'video-upgraded', callType: 'VIDEO' };
    } else {
      frame = { ...base, op: params.op };
    }
    await this.postSigned('/s2s/v1/call', JSON.stringify(frame), peerDomain);
  }

  /** Whether THIS server is the origin (roster + history authority) of a group thread: the group
   *  !-User row is homed locally (domain='local'). True for purely-local groups AND federated origins;
   *  false for a federated mirror (groupUser.domain = the origin's domain). */
  private isOriginThread(trd: {
    groupUser: { domain: string } | null;
  }): boolean {
    return trd.groupUser?.domain === 'local';
  }

  /** Resolve a wire address (account + domain) to a User row, normalizing the local domain: wire addresses
   *  use the real config.domain for locals, but the DB stores local users with domain="local". Foreign
   *  stubs are looked up by their peer domain verbatim. Returns the stub/local user or null. */
  private async resolveUserByWireAddress(
    account: string,
    fromDomain: string,
  ): Promise<{ id: number; isForeigner: boolean } | null> {
    const domain = fromDomain === this.config.domain ? 'local' : fromDomain;
    return (
      (await this.database.db.query.user.findFirst({
        where: and(
          eq(tables.user.account, normalizeAccount(account)),
          eq(tables.user.domain, domain),
        ),
        columns: { id: true, isForeigner: true },
      })) ?? null
    );
  }

  /** Resolve a group `!account` to its local thread (origin or mirror). The group account is the
   *  `!`-sigil User row's account (globally unique ULID) — looked up via the groupUser relation now that
   *  fedGroupAccount was folded into groupUser.account. findFirst: a server holds at most one thread per
   *  group (origin XOR mirror). Null if no such group here. */
  private async findGroupThread(groupAccount: string): Promise<{
    id: number;
    type: MessageThreadType;
    groupUserId: number | null;
    groupUser: {
      account: string;
      domain: string;
      group: { dissolvedAt: Date | null } | null;
    } | null;
  } | null> {
    return this.database.db.query.messageThread
      .findFirst({
        where: sql`EXISTS (
        SELECT 1 FROM "User" u
        WHERE u.id = ${tables.messageThread.groupUserId}
          AND u.account = ${normalizeAccount(groupAccount)}
          AND u."isGroup" = true
      )`,
        columns: {
          id: true,
          type: true,
          groupUserId: true,
        },
        with: {
          user: {
            columns: {
              account: true,
              domain: true,
            },
            with: { group: { columns: { dissolvedAt: true } } },
          },
        },
      })
      .then((row) => (row ? { ...row, groupUser: row.user } : null));
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
    signatureExpiresAtSec: number,
  ): Promise<void> {
    assertS2SCallFrame(body);
    if (body.op !== 'incoming') {
      await this.eventEmitter.emitAsync('call.frame.inbound', {
        peerDomain,
        signatureExpiresAtSec,
        frame: body,
      });
      return;
    }
    await this.callInboundLocks.runExclusive(
      JSON.stringify([peerDomain, body.callSid]),
      async () =>
        this.handleInboundIncoming(body, peerDomain, signatureExpiresAtSec),
    );
  }

  private async handleInboundIncoming(
    body: Extract<S2SCallFrame, { op: 'incoming' }>,
    peerDomain: string,
    signatureExpiresAtSec: number,
  ): Promise<void> {
    const preflight = await this.eventEmitter.emitAsync(
      'call.frame.incoming.preflight',
      { peerDomain, frame: body },
    );
    if (preflight?.some((handled) => handled === true)) return;
    const terminal = await this.database.db.query.callTombstone.findFirst({
      where: and(
        eq(tables.callTombstone.peerDomain, peerDomain),
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
        eq(tables.group.groupUserId, tables.messageThread.groupUserId),
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
   * Start one thread-bound S2S read. The shared advisory lock makes the preflight mutually exclusive
   * with reset start; the joined SELECT then observes the peer reset state and thread generation from
   * one PostgreSQL statement snapshot. The generation travels with the response and is rechecked by
   * the response-write gate before any returned data may be persisted.
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
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('federation-reset-global', 0))`,
      );
      const [state] = await tx
        .select({
          federationTruncated: tables.messageThread.federationTruncated,
          federationVersion: tables.messageThread.federationVersion,
          trustLevel: tables.federatedPeer.trustLevel,
          resetInProgress: tables.federatedPeer.resetInProgress,
        })
        .from(tables.messageThread)
        .innerJoin(
          tables.federatedPeer,
          eq(tables.federatedPeer.domain, peerDomain),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      if (
        !state ||
        state.federationTruncated ||
        state.trustLevel === 'halted' ||
        state.resetInProgress
      ) {
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
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('federation-reset-global', 0))`,
    );
    const [state] = await tx
      .select({
        federationTruncated: tables.messageThread.federationTruncated,
        federationVersion: tables.messageThread.federationVersion,
        trustLevel: tables.federatedPeer.trustLevel,
        resetInProgress: tables.federatedPeer.resetInProgress,
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.federatedPeer,
        eq(tables.federatedPeer.domain, peerDomain),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (
      !state ||
      state.federationTruncated ||
      state.federationVersion !== expectedFederationVersion ||
      state.trustLevel === 'halted' ||
      state.resetInProgress
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation response for thread ${threadId} from ${peerDomain}`,
      );
    }
  }

  async capturePeerResponseToken(domain: string): Promise<PeerResponseToken> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('federation-reset-global', 0))`,
      );
      const result = await tx.execute<{
        trustLevel: string;
        resetInProgress: boolean;
        resetGeneration: number;
        rootKeyFingerprint: string | null;
        recognizesPeer: boolean;
        outboundRecognitionConfirmed: boolean;
        inboundRecognitionConfirmed: boolean;
        localServiceAvailable: boolean;
      }>(sql`
        SELECT peer."trustLevel",
               peer."resetInProgress",
               COALESCE(reset."resetGeneration", 0)::int AS "resetGeneration",
               peer."rootKeyFingerprint",
               peer."recognizesPeer",
               peer."outboundRecognitionConfirmed",
               peer."inboundRecognitionConfirmed",
               peer."localServiceAvailable"
        FROM "FederatedPeer" peer
        LEFT JOIN "FederatedPeerReset" reset ON reset.domain = peer.domain
        WHERE peer.domain = ${domain}
      `);
      const state = result.rows[0];
      if (
        !state ||
        !['available', 'degraded'].includes(state.trustLevel) ||
        state.resetInProgress ||
        !state.recognizesPeer ||
        !state.outboundRecognitionConfirmed ||
        !state.inboundRecognitionConfirmed ||
        !state.localServiceAvailable ||
        !state.rootKeyFingerprint
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          `federation peer ${domain} is unavailable`,
        );
      }
      return {
        domain,
        resetGeneration: state.resetGeneration,
        rootKeyFingerprint: state.rootKeyFingerprint,
      };
    });
  }

  private async assertPeerResponseWritable(
    tx: DatabaseTransaction,
    token: PeerResponseToken,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('federation-reset-global', 0))`,
    );
    const result = await tx.execute<{
      trustLevel: string;
      resetInProgress: boolean;
      resetGeneration: number;
      rootKeyFingerprint: string | null;
      recognizesPeer: boolean;
      outboundRecognitionConfirmed: boolean;
      inboundRecognitionConfirmed: boolean;
      localServiceAvailable: boolean;
    }>(sql`
      SELECT peer."trustLevel",
             peer."resetInProgress",
             COALESCE(reset."resetGeneration", 0)::int AS "resetGeneration",
             peer."rootKeyFingerprint",
             peer."recognizesPeer",
             peer."outboundRecognitionConfirmed",
             peer."inboundRecognitionConfirmed",
             peer."localServiceAvailable"
      FROM "FederatedPeer" peer
      LEFT JOIN "FederatedPeerReset" reset ON reset.domain = peer.domain
      WHERE peer.domain = ${token.domain}
    `);
    const state = result.rows[0];
    if (
      !state ||
      !['available', 'degraded'].includes(state.trustLevel) ||
      state.resetInProgress ||
      !state.recognizesPeer ||
      !state.outboundRecognitionConfirmed ||
      !state.inboundRecognitionConfirmed ||
      !state.localServiceAvailable ||
      state.resetGeneration !== token.resetGeneration ||
      state.rootKeyFingerprint !== token.rootKeyFingerprint
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation response from ${token.domain}`,
      );
    }
  }

  /** Lightweight, ephemeral discovery wake-up. The receiver never persists this advertised HWM. */
  async pushDiscoveryHwm(domain: string): Promise<void> {
    // Startup/reconnect and state-only wake-ups are also reconstruction backstops. Fill before reading
    // the HWM so a message committed just before a crash is advertised after the new process rebuilds.
    await this.messageFeedIndexer?.fill(domain);
    await this.tombstoneFeed?.fill(domain);
    const allocatedThrough =
      await this.federationCursor.readAllocatedThrough(domain);
    const tombstoneFeedEndId =
      (await this.tombstoneFeed?.readAllocatedThrough(domain)) ?? 0n;
    const stateFeedHead =
      await this.database.db.query.peerStateFeedTarget.findFirst({
        where: eq(tables.peerStateFeedTarget.peerDomain, domain),
        columns: { allocatedThrough: true },
      });
    await this.postSigned(
      '/s2s/v1/feed-heads',
      JSON.stringify({
        origin: this.config.domain,
        stateFeedEndId: (stateFeedHead?.allocatedThrough ?? 0n).toString(),
        messageFeedEndId: allocatedThrough.toString(),
        tombstoneFeedEndId: tombstoneFeedEndId.toString(),
      }),
      domain,
    );
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

  private async handleThreadQueryForbidden(
    error: Error,
    domain: string,
    thread: FederationThreadAddress,
  ): Promise<void> {
    if (
      error instanceof S2sResponseError &&
      error.code === BusinessCode.FORBIDDEN
    ) {
      if ('peerAccount' in thread)
        await this.revokeLocalFriendAfterMessageQueryForbidden(domain, thread);
      throw new FederationMessageContextError(
        `thread query access was revoked for ${this.threadKey(thread)}`,
      );
    }
  }

  private throwIfThreadQueryForbidden(error: Error, threadKey: string): void {
    if (
      error instanceof S2sResponseError &&
      error.code === BusinessCode.FORBIDDEN
    )
      throw new FederationMessageContextError(
        `thread query access was revoked for ${threadKey}`,
      );
  }

  /** An authenticated P2P message-query denial is an authoritative access-closure fact. Converge
   * quickly by revoking only our authored direction; never manufacture the peer's intent. */
  private async revokeLocalFriendAfterMessageQueryForbidden(
    domain: string,
    thread: Extract<FederationThreadAddress, { peerAccount: string }>,
  ): Promise<void> {
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const statePeers = await this.database.db.transaction(async (tx) => {
      const [local, remote] = await Promise.all([
        tx.query.user.findFirst({
          where: and(
            eq(tables.user.account, normalizeAccount(thread.peerAccount)),
            eq(tables.user.isForeigner, false),
          ),
          columns: { id: true },
        }),
        tx.query.user.findFirst({
          where: and(
            eq(tables.user.account, normalizeAccount(thread.account)),
            eq(tables.user.domain, domain),
            eq(tables.user.isForeigner, true),
          ),
          columns: { id: true },
        }),
      ]);
      if (!local || !remote) return new Map<string, bigint>();
      const [localIntent, remoteIntent] = await Promise.all([
        tx.query.relationshipIntent.findFirst({
          where: and(
            eq(tables.relationshipIntent.authorUserId, local.id),
            eq(tables.relationshipIntent.subjectUserId, remote.id),
          ),
          columns: { status: true },
        }),
        tx.query.relationshipIntent.findFirst({
          where: and(
            eq(tables.relationshipIntent.authorUserId, remote.id),
            eq(tables.relationshipIntent.subjectUserId, local.id),
          ),
          columns: { status: true },
        }),
      ]);
      const positive = (status: string | undefined) =>
        status === 'REQUESTED' || status === 'ACCEPTED';
      if (!positive(localIntent?.status) || !positive(remoteIntent?.status))
        return new Map<string, bigint>();
      return this.writeFriendIntentInTx(
        tx,
        local.id,
        remote.id,
        false,
        '',
        clientFeedUpdates,
      );
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    await this.pushStateFeedDomains(statePeers.keys());
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
        .innerJoin(tables.user, eq(tables.user.id, tables.group.groupUserId))
        .where(
          and(
            eq(tables.user.account, item.account),
            eq(tables.user.domain, domain),
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
    if (requiredRevision !== undefined) {
      this.stateFeedPull.advertise(domain, requiredRevision);
    }
    const changed = new WeakMap<PeerStateFeedPage, StatePageEffect>();
    const groupMetaPages = new WeakMap<
      PeerStateFeedPage,
      Map<string, GroupMetaFeedPage>
    >();
    const drainClientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    await this.stateFeedPull.run(domain, {
      // The first page captures a source end; the pull worker freezes that as
      // `through` for the rest of this drain. A newer hint starts another fixed
      // drain after this one, so mark-and-sweep never races a moving source head.
      fetch: async (after, through) => {
        const page = await this.pullStateFeedPage(
          domain,
          after,
          after === undefined ? undefined : 100,
          through,
        );
        groupMetaPages.set(
          page,
          await this.prefetchGroupMetaFeeds(domain, page),
        );
        return page;
      },
      // A corrected state cursor is a replacement rebuild, not an incremental
      // continuation. Forget every per-group cursor atomically with accepting
      // the publisher's resume point so each subsequently advertised group is
      // fetched in full and can sweep stale member references.
      beginRebuild: async (tx) => {
        await tx.execute(sql`
          UPDATE "Group" mirror_group
          SET "remoteGroupMetaFeedId" = NULL, "updatedAt" = NOW()
          FROM "User" group_user
          WHERE group_user.id = mirror_group."groupUserId"
            AND group_user.domain = ${domain}
        `);
      },
      apply: async (tx, page) => {
        changed.set(
          page,
          await this.applyStateFeedPageInTx(
            tx,
            domain,
            page,
            groupMetaPages.get(page),
          ),
        );
      },
      afterCommit: async (page) => {
        const effect = changed.get(page) ?? {
          clientFeedUpdates: [],
          statePushDomains: [],
          localSystemMessages: [],
        };
        drainClientFeedUpdates.push(...effect.clientFeedUpdates);
        await this.pushStateFeedDomains(effect.statePushDomains);
        for (const status of effect.localSystemMessages)
          await this.publishLocalSystemMessage(status);
      },
      afterDrain: async () => {
        await this.sweepUnreferencedFederatedMemberProfiles(domain);
        this.clientStateFeed.notifyFeedUpdates(drainClientFeedUpdates);
      },
    });
    const cursor = await this.readStatePullCursor(domain);
    if (requiredRevision !== undefined && cursor < requiredRevision) {
      throw new Error(
        `state feed for ${domain} stopped at ${cursor.toString()} before required revision ${requiredRevision.toString()}`,
      );
    }
    return cursor;
  }

  private async sweepUnreferencedFederatedMemberProfiles(
    sourcePeerDomain: string,
  ): Promise<void> {
    await this.database.db.execute(sql`
      DELETE FROM "FederatedMemberProfile" candidate
      WHERE candidate."sourcePeerDomain" = ${sourcePeerDomain}
        AND NOT EXISTS (
          SELECT 1
          FROM "ThreadParticipant" participant
          JOIN "User" member_user ON member_user.id = participant."userId"
          JOIN "MessageThread" thread ON thread.id = participant."threadId"
            AND thread.type = 'GROUP'
          JOIN "User" group_user ON group_user.id = thread."groupUserId"
            AND group_user.domain = ${sourcePeerDomain}
          WHERE ${mutuallyAuthorizedSql(sql`participant."userId"`, sql`thread."groupUserId"`)}
            AND member_user.account = candidate."memberAccount"
            AND (CASE WHEN member_user.domain = 'local'
                      THEN ${this.config.domain}
                      ELSE member_user.domain END) = candidate."memberDomain"
        )
    `);
  }

  private async readStatePullCursor(domain: string): Promise<bigint> {
    const row = await this.database.db.query.peerStateFeedPullCursor.findFirst({
      where: eq(tables.peerStateFeedPullCursor.peerDomain, domain),
      columns: { committedThrough: true },
    });
    if (!row) throw new Error(`peer ${domain} has no state-feed pull cursor`);
    return row.committedThrough;
  }

  /** Materialize a stable address-derived identity shell. PROFILE is ordered after the confirming
   * ACCEPTED, so the initial row intentionally contains placeholders and is filled by a later
   * verified PROFILE item in the same or a subsequent drain. */
  private async materializeFederatedUserInTx(
    tx: DatabaseTransaction,
    account: string,
    domain: string,
  ): Promise<number> {
    const normalized = normalizeAccount(account);
    const existing = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalized),
        eq(tables.user.domain, domain),
      ),
      columns: { id: true },
    });
    if (existing) return existing.id;
    const [profile] = await tx
      .select()
      .from(tables.federatedProfile)
      .where(
        and(
          eq(tables.federatedProfile.account, normalized),
          eq(tables.federatedProfile.domain, domain),
        ),
      )
      .limit(1);
    const [created] = await tx
      .insert(tables.user)
      .values({
        account: normalized,
        domain,
        isForeigner: true,
        isGroup: normalized.startsWith('!'),
        hashPwd: randomUUID(),
        name: profile?.displayName ?? normalized,
        avatar: profile?.avatar ?? '',
        bio: profile?.bio ?? '',
        remoteProfileRev: profile?.revision ?? 0,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [tables.user.account, tables.user.domain],
      })
      .returning({ id: tables.user.id });
    if (created) return created.id;
    const winner = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalized),
        eq(tables.user.domain, domain),
      ),
      columns: { id: true },
    });
    if (!winner) throw new Error('failed to materialize federated user shell');
    return winner.id;
  }

  /** Ensure an incoming federated group request has a structurally complete retained conversation.
   * RelationshipIntent remains the sole authorization source, and no client state entry is published
   * until the user accepts the request. */
  private async ensureFederatedGroupRequestShellInTx(
    tx: DatabaseTransaction,
    groupAccount: string,
    groupDomain: string,
    localMemberId: number,
  ): Promise<{ groupUserId: number; threadId: number }> {
    const groupUserId = await this.materializeFederatedUserInTx(
      tx,
      groupAccount,
      groupDomain,
    );
    let thread = await tx.query.messageThread.findFirst({
      where: eq(tables.messageThread.groupUserId, groupUserId),
      columns: { id: true },
    });
    if (!thread) {
      const [created] = await tx
        .insert(tables.messageThread)
        .values({
          type: MessageThreadType.GROUP,
          groupUserId,
          updatedAt: new Date(),
        })
        .returning({ id: tables.messageThread.id });
      thread = created;
      await tx
        .insert(tables.group)
        .values({
          groupUserId,
          ownerId: groupUserId,
          rosterRev: 0,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: tables.group.groupUserId });
    }
    await tx
      .insert(tables.threadParticipant)
      .values({
        threadId: thread.id,
        userId: localMemberId,
        role: GroupRole.MEMBER,
        relationshipRev: 1,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [
          tables.threadParticipant.userId,
          tables.threadParticipant.threadId,
        ],
      });
    return { groupUserId, threadId: thread.id };
  }

  private async assertStateFeedBarrier(
    domain: string,
    requiredRevision: bigint,
  ): Promise<void> {
    const cursor = await this.readStatePullCursor(domain);
    if (cursor < requiredRevision) {
      throw new Error(
        `message feed blocked until ${domain} state cursor reaches ${requiredRevision.toString()} (currently ${cursor.toString()})`,
      );
    }
  }

  private async applyStateFeedPageInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    page: PeerStateFeedPage,
    groupMetaPages: ReadonlyMap<string, GroupMetaFeedPage> = new Map(),
  ): Promise<StatePageEffect> {
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const statePushDomains: string[] = [];
    const localSystemMessages: StatePageEffect['localSystemMessages'] = [];
    // Relationship state creates the authorized group shell before a group-meta revision is applied.
    // PROFILE then hydrates identity, and the group-meta pull materializes the complete member closure.
    const applyPriority = {
      RELATIONSHIP_INTENT: 0,
      PROFILE: 1,
      GROUP_META_FEED_HEAD: 2,
    } as const;
    for (const [itemIndex, item] of [...page.items]
      .sort((a, b) => applyPriority[a.eventType] - applyPriority[b.eventType])
      .entries()) {
      const savepoint = `federation_state_${itemIndex}`;
      const clientFeedUpdatesLength = clientFeedUpdates.length;
      const statePushLength = statePushDomains.length;
      const systemMessageLength = localSystemMessages.length;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        const wireItem = item as unknown as Record<string, unknown>;
        const allowedKeys = new Set([
          'account',
          'domain',
          'eventType',
          'feedId',
          'body',
          ...(item.eventType === 'RELATIONSHIP_INTENT' ? ['peerAccount'] : []),
        ]);
        if (
          Object.keys(wireItem).length !== allowedKeys.size ||
          Object.keys(wireItem).some((key) => !allowedKeys.has(key))
        )
          throw new PermanentFederationItemError(
            'state feed item contains invalid fields',
          );
        if (!item.body || typeof item.body !== 'object')
          throw new PermanentFederationItemError('invalid state feed body');
        const revision = Number(BigInt(item.feedId));
        if (!Number.isSafeInteger(revision) || revision < 0)
          throw new PermanentFederationItemError(
            'state feed ID exceeds local projection range',
          );
        if (item.eventType === 'PROFILE') {
          if (item.domain !== peerDomain)
            throw new PermanentFederationItemError(
              'PROFILE domain must match its publisher',
            );
          const body = item.body as {
            displayName?: unknown;
            bio?: unknown;
            avatar?: unknown;
          };
          if (
            typeof body.displayName !== 'string' ||
            typeof body.bio !== 'string'
          )
            throw new PermanentFederationItemError('invalid PROFILE body');
          const [projection] = await tx
            .select({ revision: tables.federatedProfile.revision })
            .from(tables.federatedProfile)
            .where(
              and(
                eq(tables.federatedProfile.account, item.account),
                eq(tables.federatedProfile.domain, item.domain),
              ),
            )
            .limit(1);
          if (projection && projection.revision >= revision) continue;
          let [stub] = await tx
            .select({
              id: tables.user.id,
              remoteProfileRev: tables.user.remoteProfileRev,
            })
            .from(tables.user)
            .where(
              and(
                eq(tables.user.account, item.account),
                eq(tables.user.domain, item.domain),
              ),
            )
            .limit(1);
          const pendingRequests = await tx
            .select({
              localUserId: tables.federatedFriendRequest.localUserId,
              note: tables.federatedFriendRequest.note,
              requestedAt: tables.federatedFriendRequest.requestedAt,
              expiresAt: tables.federatedFriendRequest.expiresAt,
            })
            .from(tables.federatedFriendRequest)
            .where(
              and(
                eq(tables.federatedFriendRequest.remoteAccount, item.account),
                eq(tables.federatedFriendRequest.remoteDomain, item.domain),
                eq(tables.federatedFriendRequest.direction, 'INCOMING'),
                eq(tables.federatedFriendRequest.status, 'REQUESTED'),
              ),
            );
          // A PROFILE is a dependent snapshot, never an unsolicited discovery mechanism. A human
          // profile without either an already-materialized identity or a preceding request is ignored.
          if (
            !stub &&
            !item.account.startsWith('!') &&
            pendingRequests.length === 0
          )
            continue;
          let avatar: string | null = null;
          if (body.avatar !== null) {
            const wire = body.avatar as {
              digest?: unknown;
              mimeType?: unknown;
              base64?: unknown;
              width?: unknown;
              height?: unknown;
            };
            if (
              !wire ||
              typeof wire.digest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(wire.digest) ||
              typeof wire.mimeType !== 'string' ||
              typeof wire.base64 !== 'string' ||
              !Number.isSafeInteger(wire.width) ||
              Number(wire.width) < 1 ||
              !Number.isSafeInteger(wire.height) ||
              Number(wire.height) < 1
            )
              throw new PermanentFederationItemError('invalid PROFILE avatar');
            const bytes = Buffer.from(wire.base64, 'base64');
            if (
              bytes.toString('base64') !== wire.base64 ||
              createHash('sha256').update(bytes).digest('hex') !== wire.digest
            )
              throw new PermanentFederationItemError(
                'PROFILE avatar digest mismatch',
              );
            avatar = await this.upload.saveAvatarFromWire({
              b64: wire.base64,
              w: Number(wire.width),
              h: Number(wire.height),
            });
          }
          await tx
            .insert(tables.federatedProfile)
            .values({
              domain: item.domain,
              account: normalizeAccount(item.account),
              revision,
              displayName: body.displayName,
              bio: body.bio,
              avatar,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                tables.federatedProfile.domain,
                tables.federatedProfile.account,
              ],
              set: {
                revision,
                displayName: body.displayName,
                bio: body.bio,
                avatar,
                updatedAt: new Date(),
              },
            });
          if (pendingRequests.length > 0) {
            await tx
              .update(tables.federatedFriendRequest)
              .set({
                displayName: body.displayName,
                avatar,
                profileRevision: revision,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(tables.federatedFriendRequest.remoteAccount, item.account),
                  eq(tables.federatedFriendRequest.remoteDomain, item.domain),
                  eq(tables.federatedFriendRequest.direction, 'INCOMING'),
                  eq(tables.federatedFriendRequest.status, 'REQUESTED'),
                ),
              );
            for (const pending of pendingRequests) {
              const localUser = await tx.query.user.findFirst({
                where: eq(tables.user.id, pending.localUserId),
                columns: { account: true, domain: true },
              });
              if (!localUser) continue;
              const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
                userId: pending.localUserId,
                account: normalizeAccount(item.account),
                domain: item.domain,
                eventType: 'RELATIONSHIP_INTENT',
                subjectAccount: localUser.account,
                subjectDomain: localUser.domain,
                body: {
                  status: 'REQUESTED',
                  note: pending.note,
                  requestedAt: pending.requestedAt?.getTime() ?? null,
                  expiresAt: pending.expiresAt?.getTime() ?? null,
                  direction: 'INCOMING',
                  localThreadId: null,
                  peer: {
                    id: 0,
                    account: normalizeAccount(item.account),
                    name: body.displayName,
                    avatar: avatar ?? '',
                    domain: item.domain,
                    isForeigner: true,
                  },
                },
              });
              if (clientFeedId !== null)
                clientFeedUpdates.push({
                  userId: pending.localUserId,
                  feedId: clientFeedId,
                });
            }
          }
          // A pending human PROFILE remains an Address projection until ACCEPTED state justifies a
          // stable User id. Group identities still need an inert mirror.
          if (!stub && !item.account.startsWith('!')) continue;
          if (!stub) {
            const [created] = await tx
              .insert(tables.user)
              .values({
                account: normalizeAccount(item.account),
                name: body.displayName,
                avatar: avatar ?? '',
                bio: body.bio,
                isForeigner: true,
                isGroup: true,
                domain: item.domain,
                remoteProfileRev: revision,
                updatedAt: new Date(),
              })
              .onConflictDoNothing()
              .returning({
                id: tables.user.id,
                remoteProfileRev: tables.user.remoteProfileRev,
              });
            stub =
              created ??
              (await tx.query.user.findFirst({
                where: and(
                  eq(tables.user.account, normalizeAccount(item.account)),
                  eq(tables.user.domain, item.domain),
                ),
                columns: { id: true, remoteProfileRev: true },
              }));
          }
          if (!stub || (stub.remoteProfileRev ?? -1) >= revision) continue;
          await tx
            .update(tables.user)
            .set({
              name: body.displayName,
              bio: body.bio,
              avatar: avatar ?? '',
              remoteProfileRev: revision,
              updatedAt: new Date(),
            })
            .where(eq(tables.user.id, stub.id));
          const consumerCandidates = await tx.execute<{
            userId: number;
            threadId: number;
          }>(sql`
          SELECT DISTINCT local_p."userId", local_p."threadId"
          FROM "ThreadParticipant" foreign_p
          JOIN "ThreadParticipant" local_p ON local_p."threadId" = foreign_p."threadId"
          JOIN "User" local_u ON local_u.id = local_p."userId"
          WHERE foreign_p."userId" = ${stub.id}
            AND local_u."isForeigner" = false
        `);
          const consumers = (
            await Promise.all(
              consumerCandidates.rows.map(async (candidate) => ({
                ...candidate,
                authorized:
                  (await isThreadMutuallyAuthorized(
                    tx,
                    stub.id,
                    candidate.threadId,
                  )) &&
                  (await isThreadMutuallyAuthorized(
                    tx,
                    candidate.userId,
                    candidate.threadId,
                  )),
              })),
            )
          ).filter((candidate) => candidate.authorized);
          clientFeedUpdates.push(
            ...(await this.clientStateFeed.recordProfileStateInTx(
              tx,
              stub.id,
              consumers.map((row) => row.userId),
            )),
          );
          const published = await this.publishGroupMemberProfileInTx(
            tx,
            stub.id,
            clientFeedUpdates,
          );
          statePushDomains.push(...published.keys());
        } else if (
          item.eventType === 'RELATIONSHIP_INTENT' &&
          !item.account.startsWith('!') &&
          !item.peerAccount?.startsWith('!')
        ) {
          const body = item.body as {
            status?: unknown;
            note?: unknown;
            requestedAt?: unknown;
            expiresAt?: unknown;
          };
          if (
            !item.peerAccount ||
            item.domain !== peerDomain ||
            !['REQUESTED', 'ACCEPTED', 'REVOKED'].includes(
              String(body.status),
            ) ||
            typeof body.note !== 'string' ||
            body.note.length > 255 ||
            (body.requestedAt !== null &&
              (!Number.isSafeInteger(body.requestedAt) ||
                Number(body.requestedAt) < 0)) ||
            (body.expiresAt !== null &&
              (!Number.isSafeInteger(body.expiresAt) ||
                Number(body.expiresAt) < 0)) ||
            (body.status === 'REQUESTED' &&
              (typeof body.requestedAt !== 'number' ||
                typeof body.expiresAt !== 'number')) ||
            (body.status === 'ACCEPTED' &&
              typeof body.requestedAt !== 'number') ||
            (body.status !== 'REQUESTED' && body.expiresAt !== null) ||
            Object.keys(body).some(
              (key) =>
                !['status', 'note', 'requestedAt', 'expiresAt'].includes(key),
            )
          )
            throw new PermanentFederationItemError(
              'invalid user RELATIONSHIP_INTENT body',
            );
          const requestedAt =
            typeof body.requestedAt === 'number'
              ? new Date(body.requestedAt)
              : null;
          const expiresAt =
            typeof body.expiresAt === 'number'
              ? new Date(body.expiresAt)
              : null;
          if (
            (requestedAt && Number.isNaN(requestedAt.getTime())) ||
            (expiresAt && Number.isNaN(expiresAt.getTime())) ||
            (requestedAt !== null &&
              expiresAt !== null &&
              (expiresAt <= requestedAt ||
                expiresAt.getTime() - requestedAt.getTime() >
                  7 * 24 * 60 * 60 * 1000))
          )
            throw new PermanentFederationItemError(
              'invalid user relationship request timestamps',
            );
          // Expired requests are ineffective inputs, not revocations and not a new
          // relationship transition. Advancing the feed cursor is sufficient.
          if (
            body.status === 'REQUESTED' &&
            expiresAt !== null &&
            expiresAt <= new Date()
          )
            continue;
          const [localUser] = await tx
            .select({
              id: tables.user.id,
              account: tables.user.account,
              name: tables.user.name,
              avatar: tables.user.avatar,
              domain: tables.user.domain,
              isForeigner: tables.user.isForeigner,
            })
            .from(tables.user)
            .where(
              and(
                eq(tables.user.account, normalizeAccount(item.peerAccount)),
                eq(tables.user.isForeigner, false),
              ),
            )
            .limit(1);
          let [remoteUser] = await tx
            .select({ id: tables.user.id, account: tables.user.account })
            .from(tables.user)
            .where(
              and(
                eq(tables.user.account, normalizeAccount(item.account)),
                eq(tables.user.domain, peerDomain),
                eq(tables.user.isForeigner, true),
              ),
            )
            .limit(1);
          if (!localUser)
            throw new PermanentFederationItemError(
              'user relationship local subject does not exist',
            );
          // Pending federation requests are keyed by immutable Address even when
          // this server happens to have materialized the same remote account for
          // another relationship. Stub existence must not switch persistence to
          // the local numeric-id RelationshipIntent path.
          if (body.status === 'REQUESTED') {
            const [profile] = await tx
              .select()
              .from(tables.federatedProfile)
              .where(
                and(
                  eq(tables.federatedProfile.domain, peerDomain),
                  eq(
                    tables.federatedProfile.account,
                    normalizeAccount(item.account),
                  ),
                ),
              )
              .limit(1);
            const pendingName =
              profile?.displayName ?? normalizeAccount(item.account);
            const pendingAvatar = profile?.avatar ?? null;
            const pendingProfileRevision = profile?.revision ?? 0;
            const applied = await tx.execute(sql`
            INSERT INTO "FederatedFriendRequest" (
              "localUserId", "remoteAccount", "remoteDomain", direction, status,
              note, "requestedAt", "expiresAt", "displayName", avatar,
              "profileRevision", "updatedAt"
            ) VALUES (
              ${localUser.id}, ${normalizeAccount(item.account)}, ${peerDomain},
              'INCOMING', 'REQUESTED', ${body.note}, ${requestedAt},
              ${expiresAt}, ${pendingName}, ${pendingAvatar}, ${pendingProfileRevision},
              CURRENT_TIMESTAMP
            )
            ON CONFLICT ("localUserId", "remoteDomain", "remoteAccount", direction)
            DO UPDATE SET status = 'REQUESTED', note = EXCLUDED.note,
              "requestedAt" = EXCLUDED."requestedAt",
              "expiresAt" = EXCLUDED."expiresAt", "displayName" = EXCLUDED."displayName",
              avatar = EXCLUDED.avatar, "profileRevision" = EXCLUDED."profileRevision",
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "FederatedFriendRequest".status IS DISTINCT FROM EXCLUDED.status
               OR "FederatedFriendRequest".note IS DISTINCT FROM EXCLUDED.note
               OR "FederatedFriendRequest"."requestedAt" IS DISTINCT FROM EXCLUDED."requestedAt"
               OR "FederatedFriendRequest"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
            RETURNING 1
          `);
            if (applied.rows[0]) {
              const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
                userId: localUser.id,
                account: normalizeAccount(item.account),
                domain: peerDomain,
                eventType: 'RELATIONSHIP_INTENT',
                subjectAccount: localUser.account,
                subjectDomain: localUser.domain,
                body: {
                  status: 'REQUESTED',
                  note: body.note,
                  requestedAt: requestedAt?.getTime() ?? null,
                  expiresAt: expiresAt?.getTime() ?? null,
                  direction: 'INCOMING',
                  localThreadId: null,
                  peer: {
                    id: 0,
                    account: normalizeAccount(item.account),
                    name: pendingName,
                    avatar: pendingAvatar ?? '',
                    domain: peerDomain,
                    isForeigner: true,
                  },
                },
              });
              if (clientFeedId !== null)
                clientFeedUpdates.push({
                  userId: localUser.id,
                  feedId: clientFeedId,
                });
            }
            const [crossed] = await tx
              .update(tables.federatedFriendRequest)
              .set({
                status: 'ACCEPTED',
                expiresAt: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(tables.federatedFriendRequest.localUserId, localUser.id),
                  eq(
                    tables.federatedFriendRequest.remoteAccount,
                    normalizeAccount(item.account),
                  ),
                  eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                  eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
                  eq(tables.federatedFriendRequest.status, 'REQUESTED'),
                  gt(tables.federatedFriendRequest.expiresAt, new Date()),
                ),
              )
              .returning({
                note: tables.federatedFriendRequest.note,
                requestedAt: tables.federatedFriendRequest.requestedAt,
              });
            if (crossed) {
              const confirmation = await this.stateFeed.writeManyInTx(tx, [
                {
                  peerDomain,
                  account: localUser.account,
                  domain: this.config.domain,
                  subjectAccount: normalizeAccount(item.account),
                  subjectDomain: peerDomain,
                  eventType: 'RELATIONSHIP_INTENT',
                  forceReindex: true,
                  body: {
                    status: 'ACCEPTED',
                    note: crossed.note,
                    requestedAt: crossed.requestedAt,
                    expiresAt: null,
                  },
                },
              ]);
              statePushDomains.push(...confirmation.keys());
            }
            if (!remoteUser) continue;
            const localDirection = await tx.query.relationshipIntent.findFirst({
              where: and(
                eq(tables.relationshipIntent.authorUserId, localUser.id),
                eq(tables.relationshipIntent.subjectUserId, remoteUser.id),
                or(
                  eq(tables.relationshipIntent.status, 'ACCEPTED'),
                  and(
                    eq(tables.relationshipIntent.status, 'REQUESTED'),
                    gt(tables.relationshipIntent.expiresAt, new Date()),
                  ),
                ),
              ),
              columns: { authorUserId: true },
            });
            // A request with no matching local direction remains address-only.
            // A crossed or already-confirmed pair continues into the shared
            // numeric-id state machine below so promotion and pair activation
            // commit atomically.
            if (!localDirection) continue;
          }
          if (body.status === 'REVOKED') {
            const revoked = await tx.execute<{
              displayName: string | null;
              avatar: string | null;
            }>(sql`
            UPDATE "FederatedFriendRequest"
            SET status = 'REVOKED', "requestedAt" = NULL,
              "expiresAt" = NULL, note = ${body.note}, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "localUserId" = ${localUser.id}
              AND "remoteDomain" = ${peerDomain}
              AND "remoteAccount" = ${normalizeAccount(item.account)}
              AND direction = 'INCOMING'
            RETURNING "displayName", avatar
          `);
            if (revoked.rows[0]) {
              const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
                userId: localUser.id,
                account: normalizeAccount(item.account),
                domain: peerDomain,
                eventType: 'RELATIONSHIP_INTENT',
                subjectAccount: localUser.account,
                subjectDomain: localUser.domain,
                body: {
                  status: 'REVOKED',
                  note: body.note,
                  requestedAt: null,
                  expiresAt: null,
                  direction: 'INCOMING',
                  localThreadId: null,
                  peer: {
                    id: 0,
                    account: normalizeAccount(item.account),
                    name:
                      revoked.rows[0].displayName ??
                      normalizeAccount(item.account),
                    avatar: revoked.rows[0].avatar ?? '',
                    domain: peerDomain,
                    isForeigner: true,
                  },
                },
              });
              if (clientFeedId !== null)
                clientFeedUpdates.push({
                  userId: localUser.id,
                  feedId: clientFeedId,
                });
              continue;
            }
            // Without a materialized peer there is no established friendship
            // state for this intent to revoke. A stale/no-op address revocation
            // is complete here.
            if (!remoteUser) continue;
          }
          let addressedOutgoing:
            | typeof tables.federatedFriendRequest.$inferSelect
            | undefined;
          if (body.status === 'ACCEPTED') {
            if (!remoteUser) {
              addressedOutgoing =
                await tx.query.federatedFriendRequest.findFirst({
                  where: and(
                    eq(tables.federatedFriendRequest.localUserId, localUser.id),
                    eq(
                      tables.federatedFriendRequest.remoteAccount,
                      normalizeAccount(item.account),
                    ),
                    eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                    eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
                    or(
                      eq(tables.federatedFriendRequest.status, 'ACCEPTED'),
                      and(
                        eq(tables.federatedFriendRequest.status, 'REQUESTED'),
                        gt(tables.federatedFriendRequest.expiresAt, new Date()),
                      ),
                    ),
                  ),
                });
              if (!addressedOutgoing) continue;
            }
          }
          if (!remoteUser && body.status === 'ACCEPTED') {
            const remoteUserId = await this.materializeFederatedUserInTx(
              tx,
              item.account,
              peerDomain,
            );
            remoteUser = {
              id: remoteUserId,
              account: normalizeAccount(item.account),
            };
            await tx
              .insert(tables.relationshipIntent)
              .values({
                authorUserId: localUser.id,
                subjectUserId: remoteUser.id,
                status:
                  addressedOutgoing!.status === 'ACCEPTED'
                    ? 'ACCEPTED'
                    : 'REQUESTED',
                note: addressedOutgoing!.note,
                requestedAt: addressedOutgoing!.requestedAt,
                expiresAt: addressedOutgoing!.expiresAt,
                updatedAt: new Date(),
              })
              .onConflictDoNothing();
            if (addressedOutgoing!.status === 'ACCEPTED') {
              const incoming = await tx.query.federatedFriendRequest.findFirst({
                where: and(
                  eq(tables.federatedFriendRequest.localUserId, localUser.id),
                  eq(
                    tables.federatedFriendRequest.remoteAccount,
                    normalizeAccount(item.account),
                  ),
                  eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                  eq(tables.federatedFriendRequest.direction, 'INCOMING'),
                  eq(tables.federatedFriendRequest.status, 'REQUESTED'),
                ),
              });
              if (incoming)
                await tx
                  .insert(tables.relationshipIntent)
                  .values({
                    authorUserId: remoteUser.id,
                    subjectUserId: localUser.id,
                    status: 'REQUESTED',
                    note: incoming.note,
                    requestedAt: incoming.requestedAt,
                    expiresAt: incoming.expiresAt,
                    updatedAt: new Date(),
                  })
                  .onConflictDoNothing();
            }
          }
          if (!remoteUser)
            throw new PermanentFederationItemError(
              'user relationship arrived without PROFILE',
            );
          const effect = await this.invite.applyRemoteFriendIntentInTx(tx, {
            localUserId: localUser.id,
            peerUserId: remoteUser.id,
            status:
              body.status === 'ACCEPTED'
                ? 'ACCEPTED'
                : body.status === 'REVOKED'
                  ? 'REVOKED'
                  : 'REQUESTED',
            note: body.note,
            requestedAt,
            expiresAt,
            origin: peerDomain,
          });
          if (
            body.status === 'REQUESTED' ||
            (body.status === 'ACCEPTED' && effect.added === true)
          )
            await tx
              .delete(tables.federatedFriendRequest)
              .where(
                and(
                  eq(tables.federatedFriendRequest.localUserId, localUser.id),
                  eq(
                    tables.federatedFriendRequest.remoteAccount,
                    normalizeAccount(item.account),
                  ),
                  eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                ),
              );
          if (effect.localStateRevision !== undefined) {
            const localDirection = await tx.query.relationshipIntent.findFirst({
              where: and(
                eq(tables.relationshipIntent.authorUserId, localUser.id),
                eq(tables.relationshipIntent.subjectUserId, remoteUser.id),
              ),
              columns: {
                status: true,
                note: true,
                requestedAt: true,
                expiresAt: true,
              },
            });
            if (!localDirection)
              throw new Error('local friend state disappeared');
            const localWireStatus =
              localDirection.status === 'ACCEPTED'
                ? 'ACCEPTED'
                : localDirection.status === 'REVOKED'
                  ? 'REVOKED'
                  : 'REQUESTED';
            const confirmation = await this.stateFeed.writeManyInTx(tx, [
              {
                peerDomain,
                account: localUser.account,
                domain: this.config.domain,
                subjectAccount: remoteUser.account,
                subjectDomain: peerDomain,
                eventType: 'RELATIONSHIP_INTENT',
                forceReindex: true,
                body: {
                  status: localWireStatus,
                  note: localDirection.note,
                  requestedAt: localDirection.requestedAt,
                  expiresAt: localDirection.expiresAt,
                },
              },
            ]);
            statePushDomains.push(...confirmation.keys());
          }
          void effect.requestCreated;
          clientFeedUpdates.push(...effect.clientFeedUpdates);
          if (effect.threadId !== undefined && effect.added === true) {
            localSystemMessages.push({
              actorUserId: localUser.id,
              threadId: effect.threadId,
              type: SystemMessageType.FRIEND_ADDED,
            });
          } else if (effect.threadId !== undefined && effect.removed === true) {
            const boundary = await this.message.writeSystemMessageInTx(
              tx,
              effect.threadId,
              SystemMessageType.FRIEND_REMOVED,
              remoteUser.id,
              {
                actorUserId: remoteUser.id,
                recipientUserIds: [localUser.id],
              },
            );
            await tx
              .update(tables.threadParticipant)
              .set({
                messageVisibleBeforeSeq: boundary.message.seq + 1,
                updatedAt: new Date(),
              })
              .where(eq(tables.threadParticipant.threadId, effect.threadId));
            localSystemMessages.push({
              actorUserId: remoteUser.id,
              threadId: effect.threadId,
              type: SystemMessageType.FRIEND_REMOVED,
              subjectUserId: remoteUser.id,
              message: boundary.message,
              recipientUserIds: [localUser.id],
            });
          }
        } else if (
          item.eventType === 'RELATIONSHIP_INTENT' &&
          (item.account.startsWith('!') || item.peerAccount?.startsWith('!'))
        ) {
          const inviteDirection = item.account.startsWith('!');
          if (
            !item.peerAccount ||
            item.domain !== peerDomain ||
            inviteDirection === item.peerAccount.startsWith('!')
          )
            throw new PermanentFederationItemError(
              'invalid group membership state key',
            );
          const body = item.body as {
            status?: unknown;
            note?: unknown;
            requestedAt?: unknown;
            expiresAt?: unknown;
          };
          if (
            !['REQUESTED', 'ACCEPTED', 'REVOKED'].includes(
              String(body.status),
            ) ||
            typeof body.note !== 'string' ||
            body.note.length > 255 ||
            (body.requestedAt !== null &&
              (!Number.isSafeInteger(body.requestedAt) ||
                Number(body.requestedAt) < 0)) ||
            (body.expiresAt !== null &&
              (!Number.isSafeInteger(body.expiresAt) ||
                Number(body.expiresAt) < 0)) ||
            Object.keys(body).some(
              (key) =>
                !['status', 'note', 'requestedAt', 'expiresAt'].includes(key),
            )
          )
            throw new PermanentFederationItemError(
              'invalid group membership state body',
            );
          const storageStatus = groupIntentStorageStatus(
            body.status as GroupIntentWireStatus,
          );
          const requestedAt =
            typeof body.requestedAt === 'number'
              ? new Date(body.requestedAt)
              : null;
          const expiresAt =
            typeof body.expiresAt === 'number'
              ? new Date(body.expiresAt)
              : null;
          if (
            (requestedAt !== null && Number.isNaN(requestedAt.getTime())) ||
            (expiresAt !== null && Number.isNaN(expiresAt.getTime())) ||
            (storageStatus === 'REQUESTED' &&
              (!requestedAt ||
                !expiresAt ||
                expiresAt <= requestedAt ||
                expiresAt.getTime() - requestedAt.getTime() >
                  7 * 24 * 60 * 60 * 1000)) ||
            (storageStatus === 'ACCEPTED' && requestedAt === null) ||
            (storageStatus !== 'REQUESTED' && expiresAt !== null)
          )
            throw new PermanentFederationItemError(
              'invalid group membership request timestamps',
            );
          // A delayed or replayed request that has already expired is a no-op.
          // Only an explicit REVOKED fact may drive revocation projections.
          if (
            storageStatus === 'REQUESTED' &&
            expiresAt !== null &&
            expiresAt <= new Date()
          )
            continue;
          if (inviteDirection && storageStatus === 'REQUESTED') {
            const [localMember] = await tx
              .select({ id: tables.user.id, account: tables.user.account })
              .from(tables.user)
              .where(
                and(
                  eq(tables.user.account, normalizeAccount(item.peerAccount)),
                  eq(tables.user.isForeigner, false),
                  eq(tables.user.isGroup, false),
                ),
              )
              .limit(1);
            if (!localMember)
              throw new PermanentFederationItemError(
                'group relationship local subject does not exist',
              );
            const groupAccount = normalizeAccount(item.account);
            const shell = await this.ensureFederatedGroupRequestShellInTx(
              tx,
              groupAccount,
              peerDomain,
              localMember.id,
            );
            await this.relationshipIntents.applyRemoteIntentInTx(tx, {
              groupUserId: shell.groupUserId,
              memberUserId: localMember.id,
              authorUserId: shell.groupUserId,
              status: storageStatus,
              note: body.note,
              requestedAt,
              expiresAt,
            });
            await tx
              .insert(tables.federatedFriendRequest)
              .values({
                localUserId: localMember.id,
                remoteAccount: groupAccount,
                remoteDomain: peerDomain,
                direction: 'INCOMING',
                status: 'REQUESTED',
                note: body.note,
                requestedAt,
                expiresAt,
                displayName: groupAccount,
                avatar: null,
                profileRevision: 0,
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [
                  tables.federatedFriendRequest.localUserId,
                  tables.federatedFriendRequest.remoteDomain,
                  tables.federatedFriendRequest.remoteAccount,
                  tables.federatedFriendRequest.direction,
                ],
                set: {
                  status: 'REQUESTED',
                  note: body.note,
                  requestedAt,
                  expiresAt,
                  updatedAt: new Date(),
                },
              });
            const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
              userId: localMember.id,
              account: groupAccount,
              domain: peerDomain,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: localMember.account,
              subjectDomain: this.config.domain,
              body: {
                status: body.status,
                note: body.note,
                requestedAt: body.requestedAt,
                expiresAt: body.expiresAt,
                threadId: shell.threadId,
                group: {
                  account: groupAccount,
                  domain: peerDomain,
                  isLocal: false,
                  name: groupAccount,
                  avatar: '',
                  description: '',
                  profileRev: 0,
                },
              },
            });
            if (clientFeedId !== null)
              clientFeedUpdates.push({
                userId: localMember.id,
                feedId: clientFeedId,
              });
            continue;
          }
          const [groupUser] = await tx
            .select({
              id: tables.user.id,
              account: tables.user.account,
              name: tables.user.name,
              avatar: tables.user.avatar,
              description: tables.user.bio,
              profileRev: tables.user.profileRev,
            })
            .from(tables.user)
            .where(
              and(
                eq(
                  tables.user.account,
                  normalizeAccount(
                    inviteDirection ? item.account : item.peerAccount,
                  ),
                ),
                inviteDirection
                  ? eq(tables.user.domain, peerDomain)
                  : eq(tables.user.isForeigner, false),
                eq(tables.user.isGroup, true),
              ),
            )
            .limit(1);
          let [member] = await tx
            .select({ id: tables.user.id })
            .from(tables.user)
            .where(
              and(
                eq(
                  tables.user.account,
                  normalizeAccount(
                    inviteDirection ? item.peerAccount : item.account,
                  ),
                ),
                inviteDirection
                  ? eq(tables.user.isForeigner, false)
                  : eq(tables.user.domain, peerDomain),
                eq(tables.user.isGroup, false),
              ),
            )
            .limit(1);
          if (!member && !inviteDirection) {
            const memberUserId = await this.materializeFederatedUserInTx(
              tx,
              item.account,
              peerDomain,
            );
            member = { id: memberUserId };
          }
          if (!groupUser || !member)
            throw new PermanentFederationItemError(
              'group relationship has no local group placeholder',
            );
          const membership =
            await this.relationshipIntents.applyRemoteIntentInTx(tx, {
              groupUserId: groupUser.id,
              memberUserId: member.id,
              authorUserId: inviteDirection ? groupUser.id : member.id,
              status: storageStatus,
              note: body.note,
              requestedAt,
              expiresAt,
            });
          if (!inviteDirection && membership.changed) {
            const originThread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupUserId, groupUser.id),
              columns: { id: true },
            });
            if (!originThread) throw new Error('origin group thread missing');
            await this.writeGroupRequestEffectsInTx(
              tx,
              originThread.id,
              groupUser.id,
              member.id,
              clientFeedUpdates,
              membership.shouldBeActive ? 'ACCEPTED' : storageStatus,
              storageStatus === 'ACCEPTED'
                ? inviteDirection
                  ? 'APPLICATION'
                  : 'INVITATION'
                : inviteDirection
                  ? 'INVITATION'
                  : 'APPLICATION',
              storageStatus === 'REQUESTED',
            );
          }
          if (inviteDirection && membership.shouldBeActive) {
            await this.relationshipIntents.setPairActiveInTx(
              tx,
              groupUser.id,
              member.id,
              true,
            );
            if (membership.publishAccepted) {
              const thread = await tx.query.messageThread.findFirst({
                where: eq(tables.messageThread.groupUserId, groupUser.id),
                columns: { id: true },
              });
              if (!thread) throw new Error('group relationship thread missing');
              const confirmation = await this.writeMemberRelationshipIntentInTx(
                tx,
                thread.id,
                member.id,
                'ACCEPTED',
                clientFeedUpdates,
              );
              statePushDomains.push(...confirmation.keys());
            }
          }
          if (
            inviteDirection &&
            membership.changed &&
            storageStatus === 'REVOKED'
          ) {
            await this.relationshipIntents.setPairActiveInTx(
              tx,
              groupUser.id,
              member.id,
              false,
            );
            const thread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupUserId, groupUser.id),
              columns: { id: true },
            });
            if (!thread)
              throw new PermanentFederationItemError(
                'group relationship placeholder thread is missing',
              );
          }
          if (inviteDirection && membership.changed) {
            const thread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupUserId, groupUser.id),
              columns: { id: true },
            });
            if (!thread)
              throw new PermanentFederationItemError(
                'group relationship placeholder thread is missing',
              );
            const threadId = thread.id;
            const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
              userId: member.id,
              account: groupUser.account,
              domain: peerDomain,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: normalizeAccount(item.peerAccount),
              subjectDomain: this.config.domain,
              body: {
                status: body.status,
                note: body.note,
                requestedAt: body.requestedAt,
                expiresAt: body.expiresAt,
                threadId,
                group: {
                  account: groupUser.account,
                  domain: peerDomain,
                  isLocal: false,
                  name: groupUser.name,
                  avatar: groupUser.avatar,
                  description: groupUser.description,
                  profileRev: groupUser.profileRev,
                },
              },
            });
            if (clientFeedId !== null)
              clientFeedUpdates.push({
                userId: member.id,
                feedId: clientFeedId,
              });
          }
          if (
            !inviteDirection &&
            storageStatus === 'ACCEPTED' &&
            !membership.shouldBeActive
          ) {
            const originThread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupUserId, groupUser.id),
              columns: { id: true },
            });
            if (!originThread) throw new Error('origin group thread missing');
            const rejection = await this.writeGroupRelationshipIntentInTx(
              tx,
              originThread.id,
              member.id,
              '',
              'REVOKED',
              clientFeedUpdates,
            );
            statePushDomains.push(...rejection.keys());
            this.logger.warn(
              `Rejected unsupported federated group acceptance for ${item.account}@${peerDomain}`,
            );
            continue;
          }
          if (
            !inviteDirection &&
            membership.changed &&
            membership.shouldBeActive
          ) {
            const [originThread] = await tx
              .select({
                id: tables.messageThread.id,
                ownerId: tables.group.ownerId,
              })
              .from(tables.messageThread)
              .innerJoin(
                tables.group,
                eq(tables.group.groupUserId, tables.messageThread.groupUserId),
              )
              .where(eq(tables.messageThread.groupUserId, groupUser.id))
              .for('update')
              .limit(1);
            if (!originThread) throw new Error('origin group thread missing');
            try {
              await assertServerGroupCapacityInTx(
                tx,
                originThread.id,
                member.id,
              );
            } catch (error) {
              if (
                !(error instanceof BusinessException) ||
                error.bizCode !== BusinessCode.GROUP_FULL
              )
                throw error;

              // Capacity is an origin-server policy, not a federation protocol
              // constant. Reject the request using the existing authoritative
              // membership state so older peers converge without learning about
              // this server's numerical limit.
              await this.relationshipIntents.setPairActiveInTx(
                tx,
                groupUser.id,
                member.id,
                false,
              );
              const rejection = await this.writeGroupRelationshipIntentInTx(
                tx,
                originThread.id,
                member.id,
                SERVER_GROUP_FULL_REASON,
                'REVOKED',
                clientFeedUpdates,
              );
              await tx
                .update(tables.group)
                .set({ rosterRev: sql`${tables.group.rosterRev} + 1` })
                .where(eq(tables.group.groupUserId, groupUser.id));
              const groupState = await this.writeGroupStateInTx(
                tx,
                originThread.id,
                clientFeedUpdates,
              );
              statePushDomains.push(...rejection.keys(), ...groupState.keys());
              this.logger.warn(
                `Rejected federated group join for ${item.peerAccount}@${peerDomain}: origin group is full`,
              );
              continue;
            }
            await this.relationshipIntents.setPairActiveInTx(
              tx,
              groupUser.id,
              member.id,
              true,
            );
            // The origin may still consider this member active when a mirror
            // compacts an unobserved leave followed immediately by a rejoin.
            // Re-emit the authoritative roster for every new member-authored revision even
            // when the pair itself needs no transition, otherwise that mirror
            // would wait forever for confirmation.
            await this.participantService.upsertMemberInTx(
              tx,
              originThread.id,
              member.id,
              GroupRole.MEMBER,
            );
            await openFederatedAudienceInTx(tx, peerDomain, originThread.id);
            localSystemMessages.push({
              actorUserId: originThread.ownerId,
              threadId: originThread.id,
              type: SystemMessageType.GROUP_JOINED,
              subjectUserId: member.id,
            });
            await tx
              .update(tables.group)
              .set({ rosterRev: sql`${tables.group.rosterRev} + 1` })
              .where(eq(tables.group.groupUserId, groupUser.id));
            const confirmation = await this.writeGroupRelationshipIntentInTx(
              tx,
              originThread.id,
              member.id,
              '',
              'ACCEPTED',
              clientFeedUpdates,
            );
            statePushDomains.push(...confirmation.keys());
          } else if (
            !inviteDirection &&
            membership.changed &&
            storageStatus === 'REVOKED'
          ) {
            const [originThread] = await tx
              .select({ id: tables.messageThread.id })
              .from(tables.messageThread)
              .where(eq(tables.messageThread.groupUserId, groupUser.id))
              .for('update')
              .limit(1);
            if (!originThread) throw new Error('origin group thread missing');
            const deactivated =
              await this.relationshipIntents.setPairActiveInTx(
                tx,
                groupUser.id,
                member.id,
                false,
              );
            // A rejected or otherwise pending applicant may revoke their authored
            // request while the relationship pair is already inactive. The request
            // projection was updated above; only an active member departure changes
            // the roster and produces a GROUP_LEFT boundary.
            if (!deactivated) continue;
            const localRecipients = await tx.execute<{ userId: number }>(sql`
              SELECT participant."userId"
              FROM "ThreadParticipant" participant
              JOIN "User" recipient ON recipient.id = participant."userId"
              WHERE participant."threadId" = ${originThread.id}
                AND recipient.domain = 'local'
                AND recipient."isDeleted" = false
                AND ${mutuallyAuthorizedSql(groupUser.id, sql`participant."userId"`)}
              ORDER BY participant."userId"
            `);
            const recipientUserIds = localRecipients.rows.map(
              (recipient) => recipient.userId,
            );
            const boundary = await this.message.writeSystemMessageInTx(
              tx,
              originThread.id,
              SystemMessageType.GROUP_LEFT,
              member.id,
              { actorUserId: member.id, recipientUserIds },
            );
            await tx
              .update(tables.threadParticipant)
              .set({
                messageVisibleBeforeSeq: boundary.message.seq + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(tables.threadParticipant.threadId, originThread.id),
                  eq(tables.threadParticipant.userId, member.id),
                ),
              );
            localSystemMessages.push({
              actorUserId: member.id,
              threadId: originThread.id,
              type: SystemMessageType.GROUP_LEFT,
              subjectUserId: member.id,
              message: boundary.message,
              recipientUserIds,
            });
            await tx
              .update(tables.group)
              .set({
                rosterRev: sql`${tables.group.rosterRev} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(tables.group.groupUserId, groupUser.id));
            const peerMembers = await tx.execute<{ count: number }>(sql`
            SELECT COUNT(*)::int AS count
            FROM "ThreadParticipant" participant
            JOIN "User" member_u ON member_u.id = participant."userId"
            WHERE participant."threadId" = ${originThread.id}
              AND ${mutuallyAuthorizedSql(groupUser.id, sql`participant."userId"`)}
              AND member_u."isForeigner" = true
              AND member_u.domain = ${peerDomain}
          `);
            const hasPeerMembers = (peerMembers.rows[0]?.count ?? 0) > 0;
            if (!hasPeerMembers)
              await closeFederatedAudienceInTx(tx, peerDomain, originThread.id);
            const groupState = hasPeerMembers
              ? await this.writeGroupStateInTx(
                  tx,
                  originThread.id,
                  clientFeedUpdates,
                )
              : await this.cleanupGroupProjectionInTx(
                  tx,
                  originThread.id,
                  groupUser.id,
                  groupUser.account,
                  peerDomain,
                  clientFeedUpdates,
                );
            statePushDomains.push(...groupState.keys());
          }
        } else if (item.eventType === 'GROUP_META_FEED_HEAD') {
          if (!item.account.startsWith('!') || item.domain !== peerDomain)
            throw new PermanentFederationItemError(
              'invalid GROUP_META_FEED_HEAD key',
            );
          const groupMetaFeedEndId = (
            item.body as { groupMetaFeedEndId?: unknown }
          ).groupMetaFeedEndId;
          if (
            typeof groupMetaFeedEndId !== 'string' ||
            !/^(0|[1-9]\d*)$/.test(groupMetaFeedEndId)
          )
            throw new PermanentFederationItemError(
              'invalid GROUP_META_FEED_HEAD body',
            );
          const groupPage = groupMetaPages.get(item.account);
          if (!groupPage) continue;
          if (BigInt(groupPage.scannedThrough) < BigInt(groupMetaFeedEndId))
            throw new Error(
              'group-meta page did not reach advertised revision',
            );
          const groupEffect = await this.applyGroupMetaFeedPageInTx(
            tx,
            peerDomain,
            item.account,
            groupPage,
          );
          if (groupEffect.threadId > 0)
            clientFeedUpdates.push(
              ...(await this.clientStateFeed.recordGroupStateInTx(
                tx,
                groupEffect.threadId,
              )),
            );
          statePushDomains.push(...groupEffect.statePushDomains);
          localSystemMessages.push(...groupEffect.systemMessages);
          // A newly active local member's profile must enter the outbound state
          // feed in the same transaction as the mirror roster. Otherwise a crash
          // after applying GROUP_META could permanently lose the profile publication.
          for (const userId of new Set(
            groupEffect.users
              .filter((effect) => effect.active)
              .map((effect) => effect.userId),
          )) {
            const profiles = await this.writeProfileStateInTx(
              tx,
              userId,
              clientFeedUpdates,
            );
            statePushDomains.push(...profiles.keys());
          }
        } else
          throw new PermanentFederationItemError(
            'unknown state feed event type',
          );
      } catch (error) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
        clientFeedUpdates.length = clientFeedUpdatesLength;
        statePushDomains.length = statePushLength;
        localSystemMessages.length = systemMessageLength;
        if (!(error instanceof PermanentFederationItemError)) throw error;
        this.logger.error(
          `ignored invalid state-feed item from ${peerDomain} at ${item.feedId}: ${error.message}`,
        );
      } finally {
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      }
    }
    return {
      clientFeedUpdates,
      statePushDomains,
      localSystemMessages,
    };
  }

  /** Publish a server-local timeline notice only after its state transaction commits. */
  private async publishLocalSystemMessage(status: {
    actorUserId: number;
    threadId: number;
    type: SystemMessageType;
    subjectUserId?: number;
    message?: Omit<Message, 'id'>;
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
  private async publishGroupMemberProfileInTx(
    tx: DatabaseTransaction,
    userId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const groups = await tx.execute<{ threadId: number }>(sql`
      SELECT DISTINCT participant."threadId"
      FROM "ThreadParticipant" participant
      JOIN "MessageThread" thread ON thread.id = participant."threadId" AND thread.type = 'GROUP'
      JOIN "User" group_u ON group_u.id = thread."groupUserId" AND group_u.domain = 'local'
      WHERE participant."userId" = ${userId}
    `);
    const result = new Map<string, bigint>();
    for (const group of groups.rows) {
      if (!(await isThreadMutuallyAuthorized(tx, userId, group.threadId)))
        continue;
      const state = await this.refreshGroupMemberProjectionInTx(
        tx,
        group.threadId,
        clientFeedUpdates,
      );
      for (const entry of state) result.set(...entry);
    }
    return result;
  }

  /** A member profile change is a group-meta semantic change and therefore advances the same group
   * revision used by roster mutations before publishing the compacted member projection. */
  private async refreshGroupMemberProjectionInTx(
    tx: DatabaseTransaction,
    threadId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const [thread] = await tx
      .select({ groupUserId: tables.messageThread.groupUserId })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupUserId) return new Map();
    await tx
      .update(tables.group)
      .set({ rosterRev: sql`${tables.group.rosterRev} + 1` })
      .where(eq(tables.group.groupUserId, thread.groupUserId));
    return this.writeGroupStateInTx(tx, threadId, clientFeedUpdates);
  }

  private async applyGroupMetaFeedPageInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    account: string,
    page: GroupMetaFeedPage,
  ) {
    if (
      page.account !== account ||
      (page.mode !== 'full' && page.mode !== 'delta') ||
      !/^(0|[1-9]\d*)$/.test(page.scannedThrough) ||
      !/^(0|[1-9]\d*)$/.test(page.groupMetaFeedEndId) ||
      page.hasMore !== false ||
      !Array.isArray(page.items)
    )
      throw new Error('invalid group-meta page');
    // Full mode is a replacement snapshot. Keep the pre-rebuild local member
    // projection keys in memory; every received UPSERT removes one, and after
    // the new participant references are committed the remainder is eligible
    // for reference-based garbage collection.
    const staleProfiles = new Map<
      string,
      { memberAccount: string; memberDomain: string }
    >();
    if (page.mode === 'full') {
      const currentProfiles = await tx
        .select({
          memberAccount: tables.federatedMemberProfile.memberAccount,
          memberDomain: tables.federatedMemberProfile.memberDomain,
        })
        .from(tables.federatedMemberProfile)
        .where(eq(tables.federatedMemberProfile.sourcePeerDomain, peerDomain));
      for (const profile of currentProfiles)
        staleProfiles.set(
          `${profile.memberDomain}\u0000${profile.memberAccount}`,
          profile,
        );
    }
    const groupAccount = normalizeAccount(account);
    const revision = BigInt(page.scannedThrough);
    const changes = new Map<
      string,
      {
        account: string;
        domain: string;
        beforeRole: GroupRole | null;
        afterRole: GroupRole | null;
      }
    >();
    let previousFeedId = 0n;
    for (const member of page.items) {
      if (!/^[1-9]\d*$/.test(member.feedId))
        throw new Error('invalid group-meta feed id');
      const feedId = BigInt(member.feedId);
      if (
        feedId <= previousFeedId ||
        feedId > BigInt(page.scannedThrough) ||
        typeof member.account !== 'string' ||
        typeof member.domain !== 'string' ||
        (member.operation !== 'UPSERT' && member.operation !== 'DELETE')
      )
        throw new Error('invalid group-meta member');
      previousFeedId = feedId;
      const memberAccount = normalizeAccount(member.account);
      const key = `${member.domain}\u0000${memberAccount}`;
      if (!changes.has(key)) {
        const previous = await tx.query.federatedGroupMember.findFirst({
          where: and(
            eq(tables.federatedGroupMember.sourcePeerDomain, peerDomain),
            eq(tables.federatedGroupMember.groupAccount, groupAccount),
            eq(tables.federatedGroupMember.memberAccount, memberAccount),
            eq(tables.federatedGroupMember.memberDomain, member.domain),
          ),
          columns: { role: true },
        });
        changes.set(key, {
          account: memberAccount,
          domain: member.domain,
          beforeRole: previous?.role ?? null,
          afterRole: previous?.role ?? null,
        });
      }
      if (member.operation === 'DELETE') {
        if (page.mode === 'full' || Object.keys(member.body as object).length)
          throw new Error('invalid group-meta deletion');
        await tx
          .delete(tables.federatedGroupMember)
          .where(
            and(
              eq(tables.federatedGroupMember.sourcePeerDomain, peerDomain),
              eq(tables.federatedGroupMember.groupAccount, groupAccount),
              eq(tables.federatedGroupMember.memberAccount, memberAccount),
              eq(tables.federatedGroupMember.memberDomain, member.domain),
            ),
          );
        changes.get(key)!.afterRole = null;
        continue;
      }
      const body = member.body as {
        role?: unknown;
        profileRev?: unknown;
        displayName?: unknown;
        avatar?: unknown;
      };
      if (
        !Object.values(GroupRole).includes(body.role as GroupRole) ||
        !Number.isSafeInteger(body.profileRev) ||
        Number(body.profileRev) < 0 ||
        typeof body.displayName !== 'string' ||
        body.displayName.length < 1
      )
        throw new Error('invalid group-meta member body');
      let avatar: string | null = null;
      if (body.avatar !== null) {
        const wire = body.avatar as {
          digest?: unknown;
          base64?: unknown;
          width?: unknown;
          height?: unknown;
        };
        if (
          !wire ||
          typeof wire.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(wire.digest) ||
          typeof wire.base64 !== 'string' ||
          !Number.isSafeInteger(wire.width) ||
          Number(wire.width) < 1 ||
          !Number.isSafeInteger(wire.height) ||
          Number(wire.height) < 1
        )
          throw new Error('invalid group-meta member avatar');
        const bytes = Buffer.from(wire.base64, 'base64');
        if (
          bytes.toString('base64') !== wire.base64 ||
          createHash('sha256').update(bytes).digest('hex') !== wire.digest
        )
          throw new Error('group-meta member avatar digest mismatch');
        avatar = await this.upload.saveAvatarFromWire({
          b64: wire.base64,
          w: Number(wire.width),
          h: Number(wire.height),
        });
      }
      await tx
        .insert(tables.federatedMemberProfile)
        .values({
          sourcePeerDomain: peerDomain,
          memberAccount,
          memberDomain: member.domain,
          revision: Number(body.profileRev),
          availability: 'AVAILABLE',
          displayName: body.displayName,
          avatar,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            tables.federatedMemberProfile.sourcePeerDomain,
            tables.federatedMemberProfile.memberAccount,
            tables.federatedMemberProfile.memberDomain,
          ],
          set: {
            revision: Number(body.profileRev),
            availability: 'AVAILABLE',
            displayName: body.displayName,
            avatar,
            updatedAt: new Date(),
          },
          setWhere: lte(
            tables.federatedMemberProfile.revision,
            Number(body.profileRev),
          ),
        });
      staleProfiles.delete(key);
      await tx
        .insert(tables.federatedGroupMember)
        .values({
          sourcePeerDomain: peerDomain,
          groupAccount,
          memberAccount,
          memberDomain: member.domain,
          role: body.role as GroupRole,
          seenAtFeedId: revision,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            tables.federatedGroupMember.sourcePeerDomain,
            tables.federatedGroupMember.groupAccount,
            tables.federatedGroupMember.memberAccount,
            tables.federatedGroupMember.memberDomain,
          ],
          set: {
            role: body.role as GroupRole,
            seenAtFeedId: revision,
            updatedAt: new Date(),
          },
        });
      changes.get(key)!.afterRole = body.role as GroupRole;
    }
    if (page.mode === 'full') {
      const removed = await tx
        .delete(tables.federatedGroupMember)
        .where(
          and(
            eq(tables.federatedGroupMember.sourcePeerDomain, peerDomain),
            eq(tables.federatedGroupMember.groupAccount, groupAccount),
            sql`${tables.federatedGroupMember.seenAtFeedId} <> ${revision}`,
          ),
        )
        .returning({
          account: tables.federatedGroupMember.memberAccount,
          domain: tables.federatedGroupMember.memberDomain,
          role: tables.federatedGroupMember.role,
        });
      for (const member of removed) {
        const key = `${member.domain}\u0000${member.account}`;
        changes.set(key, {
          account: member.account,
          domain: member.domain,
          beforeRole: member.role,
          afterRole: null,
        });
      }
    }
    const [memberCountRow, owners, activeMember] = await Promise.all([
      tx
        .select({ value: count() })
        .from(tables.federatedGroupMember)
        .where(
          and(
            eq(tables.federatedGroupMember.sourcePeerDomain, peerDomain),
            eq(tables.federatedGroupMember.groupAccount, groupAccount),
          ),
        )
        .then((rows) => rows[0]),
      tx
        .select({
          account: tables.federatedGroupMember.memberAccount,
          domain: tables.federatedGroupMember.memberDomain,
        })
        .from(tables.federatedGroupMember)
        .where(
          and(
            eq(tables.federatedGroupMember.sourcePeerDomain, peerDomain),
            eq(tables.federatedGroupMember.groupAccount, groupAccount),
            eq(tables.federatedGroupMember.role, GroupRole.OWNER),
          ),
        )
        .limit(2),
      tx.query.federatedGroupMember.findFirst({
        where: and(
          eq(tables.federatedGroupMember.sourcePeerDomain, peerDomain),
          eq(tables.federatedGroupMember.groupAccount, groupAccount),
          eq(tables.federatedGroupMember.memberDomain, this.config.domain),
        ),
        columns: { memberAccount: true },
      }),
    ]);
    const memberCount = memberCountRow?.value ?? 0;
    if (memberCount > 0 && owners.length !== 1)
      throw new Error('group-meta roster must have exactly one owner');
    const owner = owners[0];
    const effect = await this.applyGroupRosterChangesInTx(
      tx,
      peerDomain,
      account,
      revision,
      activeMember !== undefined,
      memberCount === 0,
      owner ?? null,
      [...changes.values()],
    );
    if (page.mode === 'full' && staleProfiles.size > 0) {
      for (const profile of staleProfiles.values()) {
        await tx.execute(sql`
          DELETE FROM "FederatedMemberProfile" candidate
          WHERE candidate."sourcePeerDomain" = ${peerDomain}
            AND candidate."memberAccount" = ${profile.memberAccount}
            AND candidate."memberDomain" = ${profile.memberDomain}
            AND NOT EXISTS (
              SELECT 1
              FROM "ThreadParticipant" participant
              JOIN "User" member_user ON member_user.id = participant."userId"
              JOIN "MessageThread" thread ON thread.id = participant."threadId"
                AND thread.type = 'GROUP'
              JOIN "User" group_user ON group_user.id = thread."groupUserId"
                AND group_user.domain = ${peerDomain}
              WHERE ${mutuallyAuthorizedSql(sql`participant."userId"`, sql`thread."groupUserId"`)}
                AND member_user.account = candidate."memberAccount"
                AND (CASE WHEN member_user.domain = 'local'
                          THEN ${this.config.domain}
                          ELSE member_user.domain END) = candidate."memberDomain"
            )
        `);
      }
    }
    return effect;
  }

  private async applyGroupRosterChangesInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    account: string,
    revision: bigint,
    active: boolean,
    dissolved: boolean,
    owner: { account: string; domain: string } | null,
    changes: ReadonlyArray<{
      account: string;
      domain: string;
      beforeRole: GroupRole | null;
      afterRole: GroupRole | null;
    }>,
  ): Promise<{
    threadId: number;
    users: Array<{ userId: number; active: boolean }>;
    statePushDomains: string[];
    systemMessages: StatePageEffect['localSystemMessages'];
  }> {
    if ((owner === null) !== dissolved)
      throw new Error('invalid federated group owner');
    const [mirror] = await tx
      .select({
        groupUserId: tables.group.groupUserId,
        threadId: tables.messageThread.id,
        remoteGroupMetaFeedId: tables.group.remoteGroupMetaFeedId,
        ownerId: tables.group.ownerId,
      })
      .from(tables.group)
      .innerJoin(tables.user, eq(tables.user.id, tables.group.groupUserId))
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.groupUserId, tables.group.groupUserId),
      )
      .where(
        and(
          eq(tables.user.account, account),
          eq(tables.user.domain, peerDomain),
        ),
      )
      .limit(1);
    if (
      !mirror ||
      (mirror.remoteGroupMetaFeedId !== null &&
        mirror.remoteGroupMetaFeedId >= revision)
    )
      return {
        threadId: mirror?.threadId ?? 0,
        users: [],
        statePushDomains: [],
        systemMessages: [],
      };
    await tx.execute(sql`
      SELECT id FROM "MessageThread"
      WHERE id = ${mirror.threadId}
      FOR UPDATE
    `);

    const materialized = new Map<
      string,
      { account: string; storedDomain: string }
    >();
    for (const change of changes) {
      if (change.beforeRole === change.afterRole) continue;
      const storedDomain =
        change.domain === this.config.domain ? 'local' : change.domain;
      materialized.set(JSON.stringify([storedDomain, change.account]), {
        account: change.account,
        storedDomain,
      });
    }
    if (owner) {
      const storedDomain =
        owner.domain === this.config.domain ? 'local' : owner.domain;
      materialized.set(JSON.stringify([storedDomain, owner.account]), {
        account: owner.account,
        storedDomain,
      });
    }
    const foreign = [...materialized.values()].filter(
      (member) => member.storedDomain !== 'local',
    );
    if (foreign.length > 0)
      await tx
        .insert(tables.user)
        .values(
          foreign.map((member) => ({
            account: member.account,
            domain: member.storedDomain,
            isForeigner: true,
            hashPwd: randomUUID(),
            name: member.account,
            avatar: '',
            bio: '',
            updatedAt: new Date(),
          })),
        )
        .onConflictDoNothing({
          target: [tables.user.account, tables.user.domain],
        });
    const addresses = [...materialized.values()];
    const resolvedUsers =
      addresses.length === 0
        ? []
        : await tx
            .select({
              id: tables.user.id,
              account: tables.user.account,
              domain: tables.user.domain,
            })
            .from(tables.user)
            .where(
              and(
                inArray(
                  tables.user.account,
                  addresses.map((member) => member.account),
                ),
                inArray(
                  tables.user.domain,
                  addresses.map((member) => member.storedDomain),
                ),
              ),
            );
    const userByAddress = new Map(
      resolvedUsers.map((resolved) => [
        JSON.stringify([resolved.domain, resolved.account]),
        resolved.id,
      ]),
    );
    const systemMessages: StatePageEffect['localSystemMessages'] = [];
    for (const change of changes) {
      if (change.beforeRole === change.afterRole) continue;
      const storedDomain =
        change.domain === this.config.domain ? 'local' : change.domain;
      const userId = userByAddress.get(
        JSON.stringify([storedDomain, change.account]),
      );
      if (userId === undefined) {
        if (storedDomain === 'local') continue;
        throw new Error('failed to materialize GROUP_META member change');
      }
      if (change.afterRole !== null)
        await tx
          .insert(tables.threadParticipant)
          .values({
            threadId: mirror.threadId,
            userId,
            role: change.afterRole,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              tables.threadParticipant.userId,
              tables.threadParticipant.threadId,
            ],
            set: { role: change.afterRole, updatedAt: new Date() },
          });
      let type: SystemMessageType | undefined;
      let actorUserId = userId;
      if (change.beforeRole === null && change.afterRole !== null)
        type = SystemMessageType.GROUP_JOINED;
      else if (change.beforeRole !== null && change.afterRole === null)
        type = SystemMessageType.GROUP_LEFT;
      else if (
        change.beforeRole === GroupRole.MEMBER &&
        change.afterRole === GroupRole.ADMIN
      ) {
        type = SystemMessageType.GROUP_ADMIN_GRANTED;
        actorUserId = mirror.ownerId;
      } else if (
        change.beforeRole === GroupRole.ADMIN &&
        change.afterRole === GroupRole.MEMBER
      ) {
        type = SystemMessageType.GROUP_ADMIN_REVOKED;
        actorUserId = mirror.ownerId;
      }
      if (type)
        systemMessages.push({
          actorUserId,
          subjectUserId: userId,
          threadId: mirror.threadId,
          type,
          ...(dissolved && type === SystemMessageType.GROUP_LEFT
            ? { recipientUserIds: [userId] }
            : {}),
        });
    }
    const ownerUserId = owner
      ? userByAddress.get(
          JSON.stringify([
            owner.domain === this.config.domain ? 'local' : owner.domain,
            owner.account,
          ]),
        )
      : mirror.ownerId;
    if (ownerUserId === undefined)
      throw new Error('GROUP_META owner is missing');
    if (ownerUserId !== mirror.ownerId)
      systemMessages.push({
        actorUserId: ownerUserId,
        subjectUserId: ownerUserId,
        threadId: mirror.threadId,
        type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
      });
    await tx
      .update(tables.group)
      .set({
        ownerId: ownerUserId,
        remoteGroupMetaFeedId: revision,
        dissolvedAt: dissolved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(tables.group.groupUserId, mirror.groupUserId));

    const localJoinDirections = await tx
      .select({
        userId: tables.relationshipIntent.authorUserId,
        account: tables.user.account,
        status: tables.relationshipIntent.status,
      })
      .from(tables.relationshipIntent)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.relationshipIntent.authorUserId),
      )
      .where(
        and(
          eq(tables.relationshipIntent.subjectUserId, mirror.groupUserId),
          eq(tables.user.isForeigner, false),
        ),
      );
    const localRoster = await tx
      .select({ account: tables.federatedGroupMember.memberAccount })
      .from(tables.federatedGroupMember)
      .where(
        and(
          eq(tables.federatedGroupMember.sourcePeerDomain, peerDomain),
          eq(
            tables.federatedGroupMember.groupAccount,
            normalizeAccount(account),
          ),
          eq(tables.federatedGroupMember.memberDomain, this.config.domain),
        ),
      );
    const localDesiredAccounts = new Set(localRoster.map((row) => row.account));
    const statePushDomains: string[] = [];
    for (const direction of localJoinDirections) {
      const locallyRejected = direction.status === 'REVOKED';
      const desired = localDesiredAccounts.has(direction.account);
      const isActive = active && desired && !locallyRejected;
      if (!isActive && direction.status === 'REQUESTED')
        await tx
          .update(tables.relationshipIntent)
          .set({ status: 'REVOKED', expiresAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(tables.relationshipIntent.subjectUserId, mirror.groupUserId),
              eq(tables.relationshipIntent.authorUserId, direction.userId),
              eq(tables.relationshipIntent.status, 'REQUESTED'),
            ),
          );
      if (locallyRejected && active && desired) {
        const allocated = await this.stateFeed.writeManyInTx(tx, [
          {
            peerDomain,
            account,
            domain: peerDomain,
            subjectAccount: direction.account,
            subjectDomain: this.config.domain,
            eventType: 'RELATIONSHIP_INTENT',
            body: {
              status: 'REVOKED',
              note: '',
              requestedAt: null,
              expiresAt: null,
            },
          },
        ]);
        statePushDomains.push(...allocated.keys());
      }
      await this.relationshipIntents.setPairActiveInTx(
        tx,
        mirror.groupUserId,
        direction.userId,
        isActive,
      );
      if (isActive)
        await tx
          .insert(tables.threadAudience)
          .values({
            targetDomain: 'local',
            localUserId: direction.userId,
            threadId: mirror.threadId,
          })
          .onConflictDoNothing();
      else
        await tx.execute(sql`
          DELETE FROM "ThreadAudience"
          WHERE "targetDomain" = 'local'
            AND "localUserId" = ${direction.userId}
            AND "threadId" = ${mirror.threadId}
        `);
    }
    return {
      threadId: mirror.threadId,
      users: localJoinDirections.map((direction) => ({
        userId: direction.userId,
        active:
          active &&
          localDesiredAccounts.has(direction.account) &&
          direction.status !== 'REVOKED',
      })),
      statePushDomains,
      systemMessages,
    };
  }

  /**
   * Fetch one durable discovery page. The peer token is captured before the network request and must
   * be checked by the page applier in the same transaction that advances committedThrough. This is the
   * peer-wide counterpart of getSignedForThread's federationVersion fence: a reset or identity change
   * while GET /missed is in flight makes the returned token stale and the complete page is discarded.
   */
  async pullMissedPage(
    domain: string,
    after?: bigint,
    take?: number,
    through?: bigint,
    excludeSelf?: boolean,
  ): Promise<{ page: FederationMessageFeedPage; token: PeerResponseToken }> {
    if (take !== undefined && (!Number.isSafeInteger(take) || take < 1)) {
      throw new Error('missed page size must be a positive safe integer');
    }
    if (
      after === undefined &&
      (take !== undefined || through !== undefined || excludeSelf !== undefined)
    ) {
      throw new Error('message feed bootstrap cannot include page parameters');
    }
    if (after !== undefined && through !== undefined && through < after) {
      throw new Error('missed through must be greater than or equal to after');
    }
    const query = new URLSearchParams();
    if (after !== undefined) query.set('after', after.toString());
    if (take !== undefined) query.set('take', take.toString());
    if (through !== undefined) query.set('through', through.toString());
    if (excludeSelf !== undefined) {
      query.set('excludeSelf', excludeSelf ? 'true' : 'false');
    }
    const token = await this.capturePeerResponseToken(domain);
    let page: FederationMessageFeedPage;
    try {
      page = await this.withTrustedPeer(domain, () =>
        this.getSigned<FederationMessageFeedPage>(
          `/s2s/v1/message-feed${query.size === 0 ? '' : `?${query.toString()}`}`,
          domain,
          16 * 1024 * 1024,
        ),
      );
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE
      ) {
        const data = error.data;
        const isRecord =
          typeof data === 'object' && data !== null && !Array.isArray(data);
        const keys = isRecord ? Object.keys(data) : [];
        const cursorData = data as
          | { resumeAfter?: unknown; resumeBefore?: unknown }
          | undefined;
        const parse = (value: unknown): bigint | null =>
          typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
            ? BigInt(value)
            : null;
        const resumeAfter = parse(cursorData?.resumeAfter);
        const resumeBefore = parse(cursorData?.resumeBefore);
        if (
          keys.length === 2 &&
          keys.includes('resumeAfter') &&
          keys.includes('resumeBefore') &&
          resumeAfter !== null &&
          resumeBefore !== null
        ) {
          throw new RemoteFeedCursorUnavailableError(resumeAfter, resumeBefore);
        }
      }
      throw error;
    }
    page.messages = await this.pullMessageQueriesForFeedPage(domain, page);
    return { page, token };
  }

  private async pullMessageQueriesForFeedPage(
    domain: string,
    page: FederationMessageFeedPage,
  ): Promise<FederationMessageFeedMessage[]> {
    const messages: FederationMessageFeedMessage[] = [];
    const cursors: NonNullable<FederationMessageFeedPage['queryCursors']> = [];
    for (const item of page.items) {
      if (!/^(0|[1-9]\d*)$/.test(item.messageEndSeq))
        throw new Error('peer returned an invalid message query end');
      const threadKey = this.threadKey(item.thread);
      const stored =
        await this.database.db.query.federationMessageQueryCursor.findFirst({
          where: and(
            eq(tables.federationMessageQueryCursor.peerDomain, domain),
            eq(tables.federationMessageQueryCursor.threadKey, threadKey),
          ),
          columns: { committedThrough: true },
        });
      let after =
        stored === undefined
          ? await this.bootstrapRemoteThreadQuery(
              domain,
              '/s2s/v1/messages',
              item.thread,
            )
          : BigInt(stored.committedThrough);
      const through = BigInt(item.messageEndSeq);
      if (through > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('peer returned an unsafe message query end');
      let cursorCorrected = false;
      while (after < through) {
        const query = this.threadQuery(item.thread);
        query.set('after', after.toString());
        query.set('through', through.toString());
        query.set('take', '100');
        let result: FederationMessageQueryPage;
        try {
          result = await this.withTrustedPeer(domain, () =>
            this.getSigned<FederationMessageQueryPage>(
              `/s2s/v1/messages?${query.toString()}`,
              domain,
              16 * 1024 * 1024,
            ),
          );
        } catch (error) {
          const mapped = this.mapFeedCursorUnavailable(error);
          if (mapped instanceof RemoteFeedCursorUnavailableError) {
            if (
              cursorCorrected ||
              mapped.resumeAfter === after ||
              mapped.resumeAfter < 0n
            )
              throw mapped;
            cursorCorrected = true;
            this.logger.warn(
              `message query cursor for peer ${domain} thread ${item.thread.account} is unavailable; resuming from ${mapped.resumeAfter.toString()}`,
            );
            after = mapped.resumeAfter;
            continue;
          }
          await this.handleThreadQueryForbidden(mapped, domain, item.thread);
          throw mapped;
        }
        if (
          !Array.isArray(result.messages) ||
          typeof result.hasMore !== 'boolean' ||
          !/^(?:0|[1-9]\d*)$/.test(result.scannedThrough)
        )
          throw new Error('peer returned a malformed message query page');
        const scanned = BigInt(result.scannedThrough);
        if (
          scanned < after ||
          scanned > through ||
          (result.hasMore && scanned === after)
        )
          throw new Error('peer returned an invalid message query boundary');
        let previousSeq = after;
        for (const returned of result.messages) {
          if (
            !Number.isSafeInteger(returned.seq) ||
            BigInt(returned.seq) <= previousSeq ||
            BigInt(returned.seq) > scanned
          )
            throw new Error('peer returned unordered message query items');
          previousSeq = BigInt(returned.seq);
        }
        messages.push(...result.messages);
        after = scanned;
        if (!result.hasMore) break;
      }
      cursors.push({ threadKey, committedThrough: Number(after) });
    }
    page.queryCursors = cursors;
    return messages;
  }

  private async bootstrapRemoteThreadQuery(
    domain: string,
    path: '/s2s/v1/messages' | '/s2s/v1/message-tombstones',
    thread: FederationThreadAddress,
  ): Promise<bigint> {
    const query = this.threadQuery(thread);
    try {
      await this.withTrustedPeer(domain, () =>
        this.getSigned<unknown>(
          `${path}?${query.toString()}`,
          domain,
          64 * 1024,
        ),
      );
    } catch (error) {
      const mapped = this.mapFeedCursorUnavailable(error);
      if (mapped instanceof RemoteFeedCursorUnavailableError)
        return mapped.resumeAfter;
      if (path === '/s2s/v1/messages')
        await this.handleThreadQueryForbidden(mapped, domain, thread);
      else this.throwIfThreadQueryForbidden(mapped, this.threadKey(thread));
      throw mapped;
    }
    throw new Error(
      `peer returned a query page without bootstrap cursor for ${path}`,
    );
  }

  private threadQuery(thread: FederationThreadAddress): URLSearchParams {
    const query = new URLSearchParams();
    query.set('account', thread.account);
    if (!('peerAccount' in thread)) {
      return query;
    }
    query.set('peerAccount', thread.peerAccount);
    return query;
  }

  private threadKey(thread: FederationThreadAddress): string {
    const canonical =
      'peerAccount' in thread
        ? ['P2P', thread.account, thread.peerAccount]
        : ['GROUP', thread.account];
    // PostgreSQL text cannot contain NUL, and wire identifiers may contain punctuation. Hash a
    // canonical JSON tuple to keep the durable local cursor key fixed-size and delimiter-safe.
    return `v1:${createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex')}`;
  }

  /** Drain one peer's durable global feed. Per-page tokens/effects are kept only for the lifetime of
   * this run; the durable cursor and staged messages remain the crash-recovery truth. */
  async pullMissedFromPeer(
    missedPull: FederationMessageFeedPullService,
    domain: string,
    requiredStateRevision: bigint,
  ): Promise<void> {
    const tokens = new WeakMap<FederationMessageFeedPage, PeerResponseToken>();
    const effects = new WeakMap<
      FederationMessageFeedPage,
      MissedPageEffect[]
    >();
    const forwardClosures = new WeakMap<
      FederationMessageFeedPage,
      Map<number, ForwardWireBundle>
    >();
    let isolateMissingContext = false;
    await this.assertStateFeedBarrier(domain, requiredStateRevision);
    const callbacks: FederationMessageFeedPullCallbacks = {
      fetch: async (after, trunc) => {
        const pulled = await this.pullMissedPage(
          domain,
          after,
          undefined,
          trunc,
        );
        const closures = new Map<number, ForwardWireBundle>();
        for (const [index, item] of (pulled.page.messages ?? []).entries()) {
          if (item.contentType !== ContentType.FORWARD) continue;
          let card: FederatedForwardCard;
          try {
            card = JSON.parse(item.content) as FederatedForwardCard;
          } catch {
            continue; // The transactional validator reports the malformed card consistently.
          }
          if (
            typeof card.bundleId !== 'string' ||
            Object.keys(card).some((key) => key !== 'bundleId')
          ) {
            continue;
          }
          closures.set(
            index,
            await this.getSigned<ForwardWireBundle>(
              `/s2s/v1/forward-bundles/${encodeURIComponent(card.bundleId)}`,
              domain,
              FORWARD_MAX_WIRE_JSON_BYTES + 64 * 1024,
            ),
          );
        }
        tokens.set(pulled.page, pulled.token);
        forwardClosures.set(pulled.page, closures);
        return pulled.page;
      },
      apply: async (tx, page) => {
        const token = tokens.get(page);
        if (!token) throw new Error('missing federation response token');
        effects.set(
          page,
          await this.applyMissedPageInTransaction(
            tx,
            domain,
            page,
            token,
            forwardClosures.get(page),
            isolateMissingContext,
          ),
        );
      },
      afterCommit: async (page) => {
        try {
          await this.publishMissedPageEffects(domain, effects.get(page) ?? []);
        } catch (error) {
          // The page and committedThrough are already durable. SSE is only a wake-up and pending downloads
          // remain retryable from their database rows, so a post-commit side-effect must never stop the
          // peer's cursor loop or cause the committed page to be requested as if it had rolled back.
          this.logger.warn(
            `post-commit missed effects failed for ${domain}: ${(error as Error).message}`,
          );
        } finally {
          tokens.delete(page);
          effects.delete(page);
          forwardClosures.delete(page);
        }
      },
    };
    try {
      await missedPull.run(domain, callbacks);
    } catch (error) {
      if (!(error instanceof FederationMessageContextError)) throw error;
      await this.pullStateFromPeer(domain);
      isolateMissingContext = true;
      try {
        await missedPull.run(domain, callbacks);
      } catch (retryError) {
        if (!(retryError instanceof FederationMessageContextError))
          throw retryError;
        this.logger.error(
          `message feed for ${domain} could not isolate an unknown thread after state recovery; cursor retained`,
        );
      }
    }
  }

  /** Apply one global /missed page inside the caller's cursor transaction. No network-visible side
   * effects happen here; the returned effects are published only after that transaction commits. */
  async applyMissedPageInTransaction(
    tx: DatabaseTransaction,
    domain: string,
    page: FederationMessageFeedPage,
    token: PeerResponseToken,
    prefetchedForwardClosures: ReadonlyMap<
      number,
      ForwardWireBundle
    > = new Map(),
    isolateMissingContext = false,
  ): Promise<MissedPageEffect[]> {
    await this.assertPeerResponseWritable(tx, token);
    const effects: MissedPageEffect[] = [];
    for (const [itemIndex, item] of (page.messages ?? []).entries()) {
      const savepoint = `federation_message_${itemIndex}`;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        this.assertFederatedMessageEnvelope(item);
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
          false,
        );
        const sourceTime = new Date(item.createdAt);
        if (
          !Number.isSafeInteger(item.createdAt) ||
          item.createdAt < 0 ||
          Number.isNaN(sourceTime.getTime()) ||
          (item.clientMessageId !== null &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              item.clientMessageId,
            )) ||
          (item.contentType === ContentType.CALL &&
            item.clientMessageId === null)
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
        );

        if (item.author.domain === this.config.domain) {
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
              eq(tables.message.creator, route.creatorId),
              eq(tables.message.seq, item.originSeq),
            ),
            columns: {
              id: true,
              createdAt: true,
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
            const existingReceipt =
              await tx.query.federationMessageReceipt.findFirst({
                where: and(
                  eq(tables.federationMessageReceipt.peerDomain, domain),
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
          const call = parseFederatedCallContent(item.content);
          if (
            !call ||
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
            callType: call.callType,
            status: call.status,
            callerId: route.creatorId,
            calleeId: route.recipients[0],
            ...(call.startedAt === undefined
              ? {}
              : { startedAt: call.startedAt }),
            ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
            ...(call.startedAt === undefined
              ? {}
              : { durationMs: call.endedAt - call.startedAt }),
          });
        }

        const existingMessage = await tx.query.message.findFirst({
          where: and(
            eq(tables.message.threadId, route.threadId),
            eq(tables.message.creator, route.creatorId),
            eq(tables.message.originSeq, item.seq),
          ),
          columns: {
            id: true,
            originServerTime: true,
          },
        });
        const existingPending = await tx.query.pendingMedia.findFirst({
          where: and(
            eq(tables.pendingMedia.threadId, route.threadId),
            eq(tables.pendingMedia.creatorId, route.creatorId),
            eq(tables.pendingMedia.originSeq, item.seq),
          ),
          columns: {
            id: true,
            originServerTime: true,
          },
        });
        if (existingMessage || existingPending) {
          const previousOriginTime =
            existingMessage?.originServerTime ??
            existingPending?.originServerTime;
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
          creator: route.creatorId,
          fetchedFromDomain: domain,
          message: {
            originSeq: item.seq,
            clientMessageId: item.clientMessageId,
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
            fromAccount: item.author.account,
            fromDomain: item.author.domain,
            toAccount: route.toAccount,
          },
        });
        if (stored.kind === 'pending') {
          effects.push({
            kind: 'pending',
            threadId: route.threadId,
            creatorId: route.creatorId,
            originSeq: item.seq,
            recipients: route.recipients,
            toAccount: route.toAccount,
            author: item.author,
            batchId: stored.batchId,
          });
          continue;
        }

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
        let deletionId: string | undefined;
        if (stored.message.isDeleted) {
          const deletion = await tx.query.deletedMessage.findFirst({
            where: and(
              eq(tables.deletedMessage.threadId, route.threadId),
              eq(tables.deletedMessage.seq, stored.message.seq),
            ),
            columns: { id: true },
          });
          deletionId = deletion?.id.toString();
        }
        effects.push({
          kind: 'message',
          threadId: route.threadId,
          creatorId: route.creatorId,
          originSeq: item.seq,
          recipients: route.recipients,
          toAccount: route.toAccount,
          author: item.author,
          message: stored.message,
          deletionId,
          forwardClosure,
          remoteForwardBundleId: forwardCard?.bundleId,
          localForwardBundleId: stored.localForwardBundleId,
        });
      } catch (error) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
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
    for (const cursor of page.queryCursors ?? []) {
      await tx
        .insert(tables.federationMessageQueryCursor)
        .values({
          peerDomain: domain,
          threadKey: cursor.threadKey,
          committedThrough: cursor.committedThrough,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            tables.federationMessageQueryCursor.peerDomain,
            tables.federationMessageQueryCursor.threadKey,
          ],
          set: {
            committedThrough: cursor.committedThrough,
            updatedAt: new Date(),
          },
        });
    }
    return effects;
  }

  /** Publish only committed /missed work. Messages already in Message fan immediately; pending media
   * starts its durable download and will fan from promotePendingMessage after its own commit. */
  async publishMissedPageEffects(
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
      if (effect.message!.isDeleted) {
        if (effect.deletionId) {
          for (const userId of effect.recipients) {
            this.sse.onDeletedMessageUpdated(
              userId,
              effect.threadId,
              effect.deletionId,
            );
          }
        }
      } else {
        const recipients = await this.unblockedRecipients(
          effect.threadId,
          effect.recipients,
        );
        for (const userId of recipients) {
          if (userId !== effect.creatorId) {
            this.sse.onNewMessage(
              userId,
              effect.threadId,
              effect.message!.seq,
              effect.message!.createdAt.getTime(),
            );
          }
        }
      }
      void this.signalOutbound(
        effect.threadId,
        effect.creatorId,
        effect.originSeq,
        domain,
      ).catch(() => undefined);
      if (effect.message!.isDeleted) {
        void this.signalDeletionOutbound(
          effect.threadId,
          effect.message!.seq,
        ).catch(() => undefined);
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
    if (
      item.contentType === ContentType.IMAGE ||
      item.contentType === ContentType.FILE ||
      item.contentType === ContentType.VIDEO ||
      item.contentType === ContentType.AUDIO ||
      item.contentType === ContentType.GALLERY
    ) {
      const parsed = JSON.parse(item.content) as Record<string, unknown>;
      const entries =
        item.contentType === ContentType.GALLERY
          ? (parsed['items'] as Array<Record<string, unknown>>)
          : [parsed];
      for (const entry of entries) {
        const descriptor = item.assets.find(
          (asset) => asset.digest === entry['digest'],
        );
        if (descriptor?.bytes !== entry['size']) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'missed asset size does not match message content',
            HttpStatus.BAD_REQUEST,
          );
        }
      }
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
    assertFields(
      item,
      [
        'thread',
        'author',
        'seq',
        'originSeq',
        'contentType',
        'content',
        'createdAt',
        'originCreatedAt',
        'clientMessageId',
        'assets',
      ],
      ['quoteTarget'],
    );
    const author = assertFields(item.author, ['account', 'domain']);
    if (
      typeof author['account'] !== 'string' ||
      typeof author['domain'] !== 'string' ||
      typeof item.content !== 'string' ||
      !Array.isArray(item.assets)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'federated message has invalid primitive fields',
        HttpStatus.BAD_REQUEST,
      );
    }
    const rawThread = item.thread as unknown as Record<string, unknown>;
    const thread = assertFields(
      rawThread,
      typeof rawThread?.['account'] === 'string' &&
        rawThread['account'].startsWith('!')
        ? ['account']
        : ['account', 'peerAccount'],
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
    if (item.quoteTarget) {
      assertFields(item.quoteTarget, ['targetSeq']);
    }
    for (const asset of item.assets) {
      assertFields(asset, ['digest', 'bytes']);
    }
  }

  private async resolveMissedThreadInTransaction(
    tx: DatabaseTransaction,
    item: FederationMessageFeedMessage,
    sourceDomain: string,
    allowClosedGroupAuthor = false,
  ): Promise<{
    threadId: number;
    creatorId: number;
    federationVersion: number;
    recipients: number[];
    toAccount: string;
  }> {
    const authorDomain =
      item.author.domain === this.config.domain ? 'local' : item.author.domain;
    const authorRows = await tx.execute<{ id: number }>(sql`
      SELECT id FROM "User"
      WHERE account = ${normalizeAccount(item.author.account)}
        AND domain = ${authorDomain}
      LIMIT 1
    `);
    const creatorId = authorRows.rows[0]?.id;
    if (!creatorId) {
      throw new FederationMessageContextError(
        'missed message author is not a known thread participant',
      );
    }

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
        JOIN "User" group_user ON group_user.id = thread."groupUserId"
        JOIN "ThreadParticipant" author_participant
          ON author_participant."threadId" = thread.id
         AND author_participant."userId" = ${creatorId}
        WHERE thread.type = 'GROUP'
          AND thread."federationTruncated" = false
          AND group_user.account = ${normalizeAccount(item.thread.account)}
          AND (
            ${mutuallyAuthorizedSql(sql`author_participant."userId"`, sql`thread."groupUserId"`)}
            OR (CASE WHEN group_user.domain = 'local' THEN ${this.config.domain} ELSE group_user.domain END) = ${sourceDomain}
            OR (
              ${allowClosedGroupAuthor}
              AND EXISTS (
                SELECT 1 FROM "RelationshipIntent" membership
                WHERE membership."subjectUserId" = thread."groupUserId"
                  AND membership."authorUserId" = ${creatorId}
                  AND membership.status = 'REVOKED'
              )
            )
          )
          AND EXISTS (
            SELECT 1 FROM "ThreadParticipant" local_participant
            JOIN "User" local_user ON local_user.id = local_participant."userId"
            WHERE local_participant."threadId" = thread.id
              AND local_user.domain = 'local'
              AND (
                ${mutuallyAuthorizedSql(sql`local_participant."userId"`, sql`thread."groupUserId"`)}
                OR (CASE WHEN group_user.domain = 'local' THEN ${this.config.domain} ELSE group_user.domain END) = ${sourceDomain}
              )
          )
        LIMIT 1
        FOR SHARE OF thread, author_participant
      `);
      threadRows = result.rows;
    } else {
      const selfAuthored = item.author.domain === this.config.domain;
      if (!selfAuthored && sourceDomain !== item.author.domain) {
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
        JOIN "ThreadParticipant" author_participant
          ON author_participant."threadId" = thread.id
         AND author_participant."userId" = ${creatorId}
        JOIN "ThreadParticipant" local_participant
          ON local_participant."threadId" = thread.id
        JOIN "User" local_user ON local_user.id = local_participant."userId"
        JOIN "ThreadParticipant" remote_participant
          ON remote_participant."threadId" = thread.id
        JOIN "User" remote_user ON remote_user.id = remote_participant."userId"
        WHERE thread.type = 'P2P'
          AND thread."federationTruncated" = false
          AND local_user.domain = 'local'
          AND local_user.account = ${normalizeAccount(item.thread.peerAccount)}
          AND remote_user.domain = ${sourceDomain}
          AND remote_user.account = ${normalizeAccount(item.thread.account)}
          AND EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            WHERE pair."threadId" = thread.id
          )
        LIMIT 1
        FOR SHARE OF thread, author_participant, local_participant, remote_participant
      `);
      threadRows = result.rows;
    }
    const route = threadRows[0];
    if (!route) {
      throw new FederationMessageContextError(
        'missed message has no retained local thread',
      );
    }
    const recipientRows = await tx.execute<{ userId: number }>(sql`
      SELECT participant."userId"
      FROM "ThreadParticipant" participant
      JOIN "User" member ON member.id = participant."userId"
      WHERE participant."threadId" = ${route.threadId}
        AND member.domain = 'local'
      FOR SHARE OF participant
    `);
    const recipientAuthorization = await Promise.all(
      recipientRows.rows.map((row) =>
        isThreadMutuallyAuthorized(tx, row.userId, route.threadId),
      ),
    );
    return {
      ...route,
      creatorId,
      recipients: recipientRows.rows
        .filter((_, index) => recipientAuthorization[index])
        .map((row) => row.userId),
    };
  }

  private async resolveTombstoneThreadInTransaction(
    tx: DatabaseTransaction,
    thread: FederationThreadAddress,
    sourceDomain: string,
  ): Promise<{
    threadId: number;
    federationVersion: number;
    recipients: number[];
    groupOriginDomain?: string;
  }> {
    if ('peerAccount' in thread) {
      const author = { account: thread.account, domain: sourceDomain };
      return this.resolveMissedThreadInTransaction(
        tx,
        { thread, author } as FederationMessageFeedMessage,
        sourceDomain,
        true,
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
      JOIN "User" group_user ON group_user.id = message_thread."groupUserId"
      WHERE message_thread.type = 'GROUP'
        AND message_thread."federationTruncated" = false
        AND group_user.account = ${normalizeAccount(thread.account)}
      LIMIT 1
      FOR SHARE OF message_thread
    `);
    const route = rows.rows[0];
    if (!route)
      throw new FederationMessageContextError(
        'tombstone has no retained local group thread',
      );
    const recipientRows = await tx.execute<{ userId: number }>(sql`
      SELECT participant."userId"
      FROM "ThreadParticipant" participant
      JOIN "User" member ON member.id = participant."userId"
      WHERE participant."threadId" = ${route.threadId}
        AND member.domain = 'local'
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
  private effectiveDomain(u: { isForeigner: boolean; domain: string }): string {
    return u.isForeigner ? u.domain : this.config.domain;
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
    if (trd.groupUser?.group?.dissolvedAt != null) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    const participants =
      await this.database.db.query.threadParticipant.findMany({
        where: eq(tables.threadParticipant.threadId, trd.id),
        with: {
          user: { columns: { account: true, domain: true, isForeigner: true } },
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
    digest: string,
    sourceSeq: number,
  ): Promise<{ absPath: string; bytes: number }> {
    // Resource authorization is deliberately independent from compacted feed-index lifetime. Durable
    // delivery proof allows already-authorized history to finish localizing its referenced resources.
    const candidates = await this.database.db
      .select({
        messageId: tables.message.id,
        threadId: tables.message.threadId,
        authorDomain: tables.user.domain,
        authorIsForeigner: tables.user.isForeigner,
        threadType: tables.messageThread.type,
        groupUserId: tables.messageThread.groupUserId,
      })
      .from(tables.message)
      .innerJoin(tables.user, eq(tables.user.id, tables.message.creator))
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, tables.message.threadId),
      )
      .innerJoin(
        tables.threadAudience,
        and(
          eq(tables.threadAudience.threadId, tables.message.threadId),
          eq(tables.threadAudience.targetDomain, signerDomain),
          isNull(tables.threadAudience.localUserId),
        ),
      )
      .where(
        and(
          eq(tables.user.account, normalizeAccount(fromAccount)),
          eq(tables.message.isDeleted, false),
          eq(tables.message.seq, sourceSeq),
        ),
      );
    let sourceMessage: { id: bigint; threadId: number } | undefined;
    for (const candidate of candidates) {
      if (
        this.effectiveDomain({
          domain: candidate.authorDomain,
          isForeigner: candidate.authorIsForeigner,
        }) !== fromDomain
      ) {
        continue;
      }
      if (
        !(await this.historicalThreadMatchesRecipient(
          candidate.threadId,
          candidate.threadType,
          candidate.groupUserId,
          toAccount,
          signerDomain,
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
    groupUserId: number | null,
    toAccount: string,
    signerDomain: string,
  ): Promise<boolean> {
    if (threadType === MessageThreadType.GROUP) {
      if (!toAccount.startsWith('!') || groupUserId === null) return false;
      const groupUser = await this.database.db.query.user.findFirst({
        where: and(
          eq(tables.user.id, groupUserId),
          eq(tables.user.account, normalizeAccount(toAccount)),
        ),
        columns: { id: true },
      });
      return groupUser !== undefined;
    }
    if (toAccount.startsWith('!')) return false;
    const recipient = await this.database.db
      .select({ id: tables.user.id })
      .from(tables.threadParticipant)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.threadParticipant.userId),
      )
      .where(
        and(
          eq(tables.threadParticipant.threadId, threadId),
          eq(tables.user.account, normalizeAccount(toAccount)),
          eq(tables.user.domain, signerDomain),
          eq(tables.user.isForeigner, true),
        ),
      )
      .limit(1);
    return recipient.length > 0;
  }

  async serveForwardBundleClosure(bundleId: string, signerDomain: string) {
    await this.requireForwardBundlePeerAccess(bundleId, signerDomain);
    return this.forwardBundles.buildClosure(bundleId);
  }

  private async requireForwardBundlePeerAccess(
    bundleId: string,
    signerDomain: string,
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
      columns: { id: true, isForeigner: true },
    });
    if (!toStub || !toStub.isForeigner) {
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
        columns: { groupUserId: true },
      });
      if (trd?.groupUserId == null) return;
      await tx
        .update(tables.group)
        .set({ dissolvedAt: new Date() })
        .where(eq(tables.group.groupUserId, trd.groupUserId));
      return undefined;
    });
  }

  /** Active local recipients of a thread; foreign stubs have no SSE connection on this server. */
  private async localActiveMemberIds(threadId: number): Promise<number[]> {
    const rows = await this.database.db
      .select({ userId: tables.threadParticipant.userId })
      .from(tables.threadParticipant)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.threadParticipant.userId),
      )
      .where(
        and(
          eq(tables.threadParticipant.threadId, threadId),
          eq(tables.user.isForeigner, false),
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
      creator: number | S2SAddress;
      fetchedFromDomain: string;
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
      message: incoming,
      expectedFederationVersion,
      incomingText,
      forwardCard,
      forwardClosure,
      originTime,
      hasUnavailableAssets = false,
      assetBytes,
      downloadAuth,
    } = params;
    await this.assertThreadResponseWritable(
      tx,
      threadId,
      fetchedFromDomain,
      expectedFederationVersion,
    );
    const creatorId =
      typeof creator === 'number'
        ? creator
        : await this.ensureForeignUserInTransaction(
            tx,
            creator.account,
            creator.domain,
          );
    await DeletedMessageService.lockFederatedIdentity(
      tx,
      threadId,
      fetchedFromDomain,
      incoming.originSeq,
    );
    const tombstone = await tx.query.federatedMessageTombstone.findFirst({
      where: and(
        eq(tables.federatedMessageTombstone.threadId, threadId),
        eq(tables.federatedMessageTombstone.sourceDomain, fetchedFromDomain),
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
        quoteTargetSeq,
      );
      if (!quotedMessage) {
        const quotedPending = await tx.query.pendingMedia.findFirst({
          where: and(
            eq(tables.pendingMedia.threadId, threadId),
            eq(tables.pendingMedia.originDomain, fetchedFromDomain),
            eq(tables.pendingMedia.originSeq, quoteTargetSeq),
          ),
          columns: { id: true },
        });
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

    // Media and messages quoting staged media are kept in the durable inbound inbox. Neither gets a
    // local seq until its files/dependency are ready, so receiver-visible quote coordinates are never
    // fabricated and both states survive a restart.
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
      await tx.insert(tables.pendingMedia).values({
        threadId,
        creatorId,
        contentType: incoming.contentType as ContentType,
        content: incoming.content,
        clientMessageId: incoming.clientMessageId,
        originSeq: incoming.originSeq,
        originServerTime: originTime,
        federationSourceDomain: fetchedFromDomain,
        direction: 'INBOUND',
        batchId,
        fileCnt: digests.length,
        originDomain: fetchedFromDomain,
        expectedFederationVersion,
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
    const [{ curSeq: seq }] = await tx
      .update(tables.messageThread)
      .set({ curSeq: sql`${tables.messageThread.curSeq} + 1` })
      .where(eq(tables.messageThread.id, threadId))
      .returning({ curSeq: tables.messageThread.curSeq });
    storedContent = contextualizeCasUrls(storedContent, threadId, seq);
    if (incomingText && incoming.quoteTarget) {
      const localQuoteSeq = await this.resolveLocalQuoteSeq(
        tx,
        threadId,
        fetchedFromDomain,
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
        creator: creatorId,
        seq,
        originSeq: incoming.originSeq,
        clientMessageId: incoming.clientMessageId,
        originServerTime: originTime,
        federationSourceDomain: fetchedFromDomain,
        isDeleted: tombstone !== undefined,
        updatedAt: new Date(),
      })
      .returning();
    let localDeletionId: bigint | null = null;
    if (tombstone) {
      const [createdDeletion] = await tx
        .insert(tables.deletedMessage)
        .values({
          threadId,
          seq,
          type: tombstone.type,
          federationSourceDomain: tombstone.sourceDomain,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [tables.deletedMessage.threadId, tables.deletedMessage.seq],
        })
        .returning({ id: tables.deletedMessage.id });
      localDeletionId = createdDeletion?.id ?? null;
      await tx
        .delete(tables.federatedMessageTombstone)
        .where(
          and(
            eq(tables.federatedMessageTombstone.threadId, threadId),
            eq(
              tables.federatedMessageTombstone.sourceDomain,
              fetchedFromDomain,
            ),
            eq(tables.federatedMessageTombstone.messageSeq, incoming.originSeq),
          ),
        );
    }
    await ClientMessageFeedWriter.publishMessage(tx, threadId, seq);
    if (localDeletionId !== null)
      await ClientMessageFeedWriter.publishTombstone(
        tx,
        threadId,
        localDeletionId,
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

  private async resolveLocalQuoteSeq(
    tx: DatabaseTransaction,
    threadId: number,
    sourceDomain: string,
    target: S2SQuoteTarget,
  ): Promise<number> {
    const message = await this.findQuoteTargetMessage(
      tx,
      threadId,
      sourceDomain,
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
    sourceSeq: number,
  ): Promise<{ id: bigint; seq: number } | undefined> {
    const direct = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.federationSourceDomain, sourceDomain),
        eq(tables.message.originSeq, sourceSeq),
      ),
      columns: { id: true, seq: true },
    });
    if (direct) return direct;
    const receipt = await tx.query.federationMessageReceipt.findFirst({
      where: and(
        eq(tables.federationMessageReceipt.peerDomain, sourceDomain),
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
    return (
      t === ContentType.IMAGE ||
      t === ContentType.FILE ||
      t === ContentType.VIDEO ||
      t === ContentType.AUDIO ||
      t === ContentType.GALLERY ||
      t === ContentType.LINK
    );
  }

  /** Map an inbound message contentType to the FileSyncProgress kind. LINK_CARD identifies optional
   * federated link-card artwork. GALLERY's
   * per-item rows are tagged BUNDLE because the per-item family lives in the message content. */
  private fileSyncKindFor(
    t: ContentType,
  ): 'IMAGE' | 'VIDEO' | 'FILE' | 'AUDIO' | 'LINK_CARD' | 'BUNDLE' {
    switch (t) {
      case ContentType.IMAGE:
        return 'IMAGE';
      case ContentType.LINK:
        return 'LINK_CARD';
      case ContentType.VIDEO:
        return 'VIDEO';
      case ContentType.AUDIO:
        return 'AUDIO';
      case ContentType.GALLERY:
        return 'BUNDLE';
      default:
        return 'FILE';
    }
  }

  /**
   * Drive one file's localization to a terminal state and update its FileSyncProgress row (§12.4/§12.6).
   * Dedup: a digest already local (live MediaAsset) skips the network fetch. A clean failure (transport
   * or digest mismatch) marks the row FAILED — no auto-retry; the message stays staged for an admin
   * (§12.7). A crash mid-fetch leaves the row DOWNLOADING, also admin-recoverable. saveCasFromStream's
   * per-digest lock + the dedup make concurrent batches over the same digest safe.
   */
  private async driveFileSync(
    progressId: bigint,
    digest: string,
    fetchChunks: (offset: number) => AsyncIterable<Buffer>,
  ): Promise<void> {
    // Load declared size + origin domain + the tick-once guard up front so quota is charged exactly once
    // per file across retries/crash-resume.
    const row = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.id, progressId),
      columns: {
        bytesTotal: true,
        originDomain: true,
        quotaCounted: true,
      },
    });
    const originDomain = row?.originDomain;
    const declaredBytes = row?.bytesTotal ?? 0n;
    try {
      const have = await this.database.db.query.mediaAsset.findFirst({
        where: and(
          eq(tables.mediaAsset.digest, digest),
          eq(tables.mediaAsset.isDeleted, false),
        ),
        columns: { digest: true },
      });
      if (!have) {
        // Charge file quota ONCE (quotaCounted guard): file cnt + declared bytes. Strict-before — preCheckFile
        // throws if the claim would exceed the daily cap (the file is left PENDING/FAILED, not re-charged on
        // retry). Skipped when originDomain is absent (e.g. outbound rows have no peer to charge).
        if (originDomain && !row?.quotaCounted) {
          await this.quota.preCheckFile(originDomain, 1, declaredBytes);
          await this.quota.tickLax(originDomain, 'files');
          if (declaredBytes > 0n)
            await this.quota.tickFileBytes(originDomain, declaredBytes);
          await this.database.db
            .update(tables.fileSyncProgress)
            .set({ quotaCounted: true })
            .where(eq(tables.fileSyncProgress.id, progressId));
        }
        const claimed = await this.database.db
          .update(tables.fileSyncProgress)
          .set({
            status: 'DOWNLOADING',
            bytesTotal: declaredBytes,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tables.fileSyncProgress.id, progressId),
              eq(tables.fileSyncProgress.status, 'PENDING'),
            ),
          )
          .returning({ id: tables.fileSyncProgress.id });
        if (claimed.length === 0) throw new FederationDownloadTerminatedError();
        let lastWrite = 0;
        const checkedChunks = async function* (
          service: FederationService,
          offset: number,
        ): AsyncGenerator<Buffer> {
          for await (const chunk of fetchChunks(offset)) {
            const current =
              await service.database.db.query.fileSyncProgress.findFirst({
                where: eq(tables.fileSyncProgress.id, progressId),
                columns: { status: true },
              });
            if (current?.status !== 'DOWNLOADING') {
              throw new FederationDownloadTerminatedError();
            }
            yield chunk;
          }
        };
        await this.upload.saveCasFromStream(
          '',
          (offset) => checkedChunks(this, offset),
          digest,
          {
            // No declaredBytes → no oversize detection (size unknown for this row); bytesTotal still tracked.
            declaredBytes:
              declaredBytes > 0n ? Number(declaredBytes) : undefined,
            onProgress: (received) => {
              // Throttle DB writes to ~every 256 KiB — progress is advisory; per-chunk writes would hammer NAS.
              if (received - lastWrite >= 256 * 1024) {
                lastWrite = received;
                void this.database.db
                  .update(tables.fileSyncProgress)
                  .set({
                    bytesReceived: BigInt(received),
                    updatedAt: new Date(),
                  })
                  .where(eq(tables.fileSyncProgress.id, progressId));
              }
            },
          },
        );
      }
      const completed = await this.database.db
        .update(tables.fileSyncProgress)
        .set({ status: 'SUCCEEDED', updatedAt: new Date() })
        .where(
          and(
            eq(tables.fileSyncProgress.id, progressId),
            inArray(
              tables.fileSyncProgress.status,
              have ? ['PENDING', 'DOWNLOADING'] : ['DOWNLOADING'],
            ),
          ),
        )
        .returning({ id: tables.fileSyncProgress.id });
      if (completed.length === 0) {
        throw new FederationDownloadTerminatedError();
      }
    } catch (error) {
      // Oversize: the stream exceeded the declared size — charge the excess toward file total size so the
      // breaker reflects reality, then surface as FAILED (the file is abandoned). Conservative: never subtract.
      if (error instanceof CasOversizeError && originDomain) {
        await this.quota.addFileBytesDelta(originDomain, error.extraBytes);
      }
      const quotaPaused =
        error instanceof BusinessException &&
        error.bizCode === BusinessCode.FEDERATION_QUOTA_EXCEEDED;
      if (!(error instanceof FederationDownloadTerminatedError)) {
        await this.database.db
          .update(tables.fileSyncProgress)
          .set({
            // Quota exhaustion is a pause, not a corrupt/permanent transfer failure. Keeping the task
            // PENDING lets the admin quota continuation re-drive it without rewriting failure state.
            status: quotaPaused ? 'PENDING' : 'FAILED',
            errorKind: quotaPaused
              ? 'QUOTA_PAUSED'
              : error instanceof Error
                ? error.message.slice(0, 255)
                : 'error',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tables.fileSyncProgress.id, progressId),
              inArray(tables.fileSyncProgress.status, [
                'PENDING',
                'DOWNLOADING',
              ]),
            ),
          );
      }
      throw error;
    }
  }

  /**
   * Drive every still-pending file of a batch to terminal, then attempt the message-level promote.
   * `fetchChunksFor(digest, offset)` is supplied by the caller (the pull loop, or `retryInboundBatch`)
   * bound to the right peer context, keeping this path free of any FederationService↔FileSync dependency
   * cycle. Fire-and-forget at the call site — it never blocks the pull drainer or the cursor (§12.6).
   *
   * Serialized per batchId so the fire-and-forget pull driver and an admin retry never double-drive the
   * same batch (and never reach promote concurrently for one). A retry that arrives while the original
   * driver still holds the lock simply waits, then re-queries: any newly-SUCCEEDED files are skipped, a
   * fully-promoted batch is gone (promote no-ops), and the rest are re-driven.
   */
  async runFileSyncBatch(
    batchId: string,
    fetchChunksFor: (digest: string, offset: number) => AsyncIterable<Buffer>,
  ): Promise<void> {
    await this.batchSyncLocks.runExclusive(batchId, async () => {
      const rows = await this.database.db.query.fileSyncProgress.findMany({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      });
      // Per-peer circuit breaker: if this batch's origin peer is tripped, start no new downloads for it
      // (in-flight downloads continue; promote is still allowed so an already-complete batch finalizes).
      const originDomain = rows[0]?.originDomain;
      if (originDomain && this.quota.isTripped(originDomain)) return;
      await Promise.all(
        rows.map((row) => {
          const peerDomain = row.originDomain ?? originDomain;
          if (!peerDomain) {
            return this.driveFileSync(row.id, row.digest, (offset) =>
              fetchChunksFor(row.digest, offset),
            );
          }
          return this.downloadScheduler
            .schedule(peerDomain, row.digest, () =>
              this.driveFileSync(row.id, row.digest, (offset) =>
                fetchChunksFor(row.digest, offset),
              ),
            )
            .then(async () => {
              // A coalesced waiter did not run its own task. Mark its logical progress row ready now
              // that the shared physical CAS transfer has completed.
              await this.database.db
                .update(tables.fileSyncProgress)
                .set({ status: 'SUCCEEDED', updatedAt: new Date() })
                .where(
                  and(
                    eq(tables.fileSyncProgress.id, row.id),
                    eq(tables.fileSyncProgress.status, 'PENDING'),
                  ),
                );
            });
        }),
      );
      await this.promotePendingMessage(batchId);
    });
  }

  async pullTombstonePage(
    domain: string,
    after?: bigint,
    take?: number,
    through?: bigint,
  ): Promise<{
    page: FederationMessageTombstonePage;
    token: PeerResponseToken;
  }> {
    if (after === undefined && (take !== undefined || through !== undefined)) {
      throw new Error('tombstone bootstrap cannot include page parameters');
    }
    if (after !== undefined && through !== undefined && through < after) {
      throw new Error(
        'tombstone through must be greater than or equal to after',
      );
    }
    const query = new URLSearchParams();
    if (after !== undefined) query.set('after', after.toString());
    if (take !== undefined) query.set('take', take.toString());
    if (through !== undefined) query.set('through', through.toString());
    const token = await this.capturePeerResponseToken(domain);
    let page: FederationMessageTombstonePage;
    try {
      page = await this.withTrustedPeer(domain, () =>
        this.getSigned<FederationMessageTombstonePage>(
          `/s2s/v1/message-tombstone-feed${query.size === 0 ? '' : `?${query.toString()}`}`,
          domain,
          4 * 1024 * 1024,
        ),
      );
    } catch (error) {
      throw this.mapFeedCursorUnavailable(error);
    }
    page.tombstones = await this.pullTombstoneQueriesForFeedPage(domain, page);
    return { page, token };
  }

  private async pullTombstoneQueriesForFeedPage(
    domain: string,
    page: FederationMessageTombstonePage,
  ): Promise<FederationMessageTombstoneItem[]> {
    const tombstones: FederationMessageTombstoneItem[] = [];
    const cursors: NonNullable<FederationMessageTombstonePage['queryCursors']> =
      [];
    for (const item of page.items) {
      if (!/^(0|[1-9]\d*)$/.test(item.tombstoneEndSeq))
        throw new Error('peer returned an invalid tombstone query end');
      const threadKey = this.threadKey(item.thread);
      const stored =
        await this.database.db.query.federationTombstoneQueryCursor.findFirst({
          where: and(
            eq(tables.federationTombstoneQueryCursor.peerDomain, domain),
            eq(tables.federationTombstoneQueryCursor.threadKey, threadKey),
          ),
          columns: { committedThrough: true },
        });
      let after =
        stored === undefined
          ? await this.bootstrapRemoteThreadQuery(
              domain,
              '/s2s/v1/message-tombstones',
              item.thread,
            )
          : stored.committedThrough;
      const through = BigInt(item.tombstoneEndSeq);
      let cursorCorrected = false;
      while (after < through) {
        const query = this.threadQuery(item.thread);
        query.set('after', after.toString());
        query.set('through', through.toString());
        query.set('take', '100');
        let result: FederationMessageTombstoneQueryPage;
        try {
          result = await this.withTrustedPeer(domain, () =>
            this.getSigned<FederationMessageTombstoneQueryPage>(
              `/s2s/v1/message-tombstones?${query.toString()}`,
              domain,
              4 * 1024 * 1024,
            ),
          );
        } catch (error) {
          const mapped = this.mapFeedCursorUnavailable(error);
          if (mapped instanceof RemoteFeedCursorUnavailableError) {
            if (cursorCorrected || mapped.resumeAfter === after) throw mapped;
            cursorCorrected = true;
            this.logger.warn(
              `tombstone query cursor for peer ${domain} thread ${item.thread.account} is unavailable; resuming from ${mapped.resumeAfter.toString()}`,
            );
            after = mapped.resumeAfter;
            continue;
          }
          this.throwIfThreadQueryForbidden(mapped, threadKey);
          throw mapped;
        }
        if (
          !Array.isArray(result.tombstones) ||
          typeof result.hasMore !== 'boolean' ||
          !/^(0|[1-9]\d*)$/.test(result.scannedThrough)
        )
          throw new Error('peer returned a malformed tombstone query page');
        const scanned = BigInt(result.scannedThrough);
        if (
          scanned < after ||
          scanned > through ||
          (result.hasMore && scanned === after)
        )
          throw new Error('peer returned an invalid tombstone query boundary');
        let previousDeletion = after;
        for (const returned of result.tombstones) {
          if (
            !/^[1-9]\d*$/.test(returned.deletionSeq) ||
            BigInt(returned.deletionSeq) <= previousDeletion ||
            BigInt(returned.deletionSeq) > scanned
          )
            throw new Error('peer returned unordered tombstone query items');
          previousDeletion = BigInt(returned.deletionSeq);
        }
        tombstones.push(...result.tombstones);
        after = scanned;
        if (!result.hasMore) break;
      }
      cursors.push({ threadKey, committedThrough: after.toString() });
    }
    page.queryCursors = cursors;
    return tombstones;
  }

  async pullTombstonesFromPeer(
    domain: string,
    requiredStateRevision: bigint,
  ): Promise<void> {
    if (!this.tombstonePull) return;
    const tokens = new WeakMap<
      FederationMessageTombstonePage,
      PeerResponseToken
    >();
    const effects = new WeakMap<
      FederationMessageTombstonePage,
      Array<{
        threadId: number;
        seq: number;
        deletedId: string;
        recipients: number[];
        publishFromGroupOrigin: boolean;
        systemMessage: { seq: number; createdAt: Date };
      }>
    >();
    let isolateMissingContext = false;
    await this.assertStateFeedBarrier(domain, requiredStateRevision);
    const callbacks: FederationMessageTombstonePullCallbacks = {
      fetch: async (after, trunc) => {
        const pulled = await this.pullTombstonePage(
          domain,
          after,
          after === undefined ? undefined : 100,
          trunc,
        );
        tokens.set(pulled.page, pulled.token);
        return pulled.page;
      },
      apply: async (tx, page) => {
        const token = tokens.get(page);
        if (!token) throw new Error('missing tombstone response token');
        await this.assertPeerResponseWritable(tx, token);
        const applied: Array<{
          threadId: number;
          seq: number;
          deletedId: string;
          recipients: number[];
          publishFromGroupOrigin: boolean;
          systemMessage: { seq: number; createdAt: Date };
        }> = [];
        for (const [itemIndex, item] of (page.tombstones ?? []).entries()) {
          const savepoint = `federation_tombstone_${itemIndex}`;
          const appliedLength = applied.length;
          await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
          try {
            if (
              !Number.isSafeInteger(item.messageSeq) ||
              item.messageSeq < 1 ||
              !Number.isSafeInteger(item.deletedAt) ||
              item.deletedAt < 0 ||
              ![MessageDeleteType.WITHDRAW, MessageDeleteType.REPORT].includes(
                item.type,
              )
            ) {
              throw new PermanentFederationItemError(
                'invalid federated tombstone',
              );
            }
            const route = await this.resolveTombstoneThreadInTransaction(
              tx,
              item.thread,
              domain,
            );
            const isGroup = !('peerAccount' in item.thread);
            const acceptingGroupSubmission =
              isGroup && route.groupOriginDomain === this.config.domain;
            if (isGroup) {
              const expectedSource = acceptingGroupSubmission
                ? domain
                : route.groupOriginDomain;
              if (domain !== expectedSource)
                throw new PermanentFederationItemError(
                  acceptingGroupSubmission
                    ? 'group deletion submission is not from the author domain'
                    : 'group tombstone is not from the group origin',
                );
              if (
                acceptingGroupSubmission &&
                item.type !== MessageDeleteType.WITHDRAW
              )
                throw new PermanentFederationItemError(
                  'a member domain may only submit its own withdrawal',
                );
            }
            const result = await this.deletedMessages.applyFederatedInTx(tx, {
              threadId: route.threadId,
              messageSeq: item.messageSeq,
              authorityDomain: route.groupOriginDomain ?? domain,
              sourceDomain: domain,
              remoteDeletedId: BigInt(item.deletionSeq),
              type: item.type,
              authorityDeletedAt: acceptingGroupSubmission
                ? undefined
                : new Date(item.deletedAt),
              allowPending: !acceptingGroupSubmission,
              federationSourceDomain: acceptingGroupSubmission ? null : domain,
              expectedFederationVersion: route.federationVersion,
            });
            if (result) {
              applied.push({
                threadId: route.threadId,
                seq: result.seq,
                deletedId: result.id,
                recipients: route.recipients,
                publishFromGroupOrigin: acceptingGroupSubmission,
                systemMessage: result.systemMessage,
              });
            }
          } catch (error) {
            await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
            applied.length = appliedLength;
            if (
              error instanceof FederationMessageContextError &&
              isolateMissingContext
            ) {
              this.logger.error(
                `ignored tombstone with unresolved context after state recovery from ${domain} at ${item.deletionSeq}: ${error.message}`,
              );
              continue;
            }
            if (!(error instanceof PermanentFederationItemError)) throw error;
            this.logger.error(
              `ignored invalid tombstone from ${domain} at ${item.deletionSeq}: ${error.message}`,
            );
          } finally {
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
          }
        }
        for (const cursor of page.queryCursors ?? []) {
          await tx
            .insert(tables.federationTombstoneQueryCursor)
            .values({
              peerDomain: domain,
              threadKey: cursor.threadKey,
              committedThrough: BigInt(cursor.committedThrough),
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                tables.federationTombstoneQueryCursor.peerDomain,
                tables.federationTombstoneQueryCursor.threadKey,
              ],
              set: {
                committedThrough: BigInt(cursor.committedThrough),
                updatedAt: new Date(),
              },
            });
        }
        effects.set(page, applied);
      },
      afterCommit: async (page) => {
        for (const effect of effects.get(page) ?? []) {
          for (const userId of effect.recipients) {
            this.sse.onDeletedMessageUpdated(
              userId,
              effect.threadId,
              effect.deletedId,
            );
            this.sse.onNewMessage(
              userId,
              effect.threadId,
              effect.systemMessage.seq,
              effect.systemMessage.createdAt.getTime(),
            );
          }
          if (effect.publishFromGroupOrigin)
            await this.signalDeletionOutbound(effect.threadId, effect.seq);
        }
        tokens.delete(page);
        effects.delete(page);
      },
    };
    try {
      await this.tombstonePull.run(domain, callbacks);
    } catch (error) {
      if (!(error instanceof FederationMessageContextError)) throw error;
      await this.pullStateFromPeer(domain);
      isolateMissingContext = true;
      try {
        await this.tombstonePull.run(domain, callbacks);
      } catch (retryError) {
        if (!(retryError instanceof FederationMessageContextError))
          throw retryError;
        this.logger.error(
          `tombstone feed for ${domain} could not isolate an unknown thread after state recovery; cursor retained`,
        );
      }
    }
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
    const batch = await this.database.db.query.pendingMedia.findFirst({
      where: eq(tables.pendingMedia.batchId, batchId),
    });
    if (!batch || batch.direction !== 'INBOUND') {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `inbound media batch ${batchId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
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
      !batch.originDomain ||
      batch.originSeq == null
    ) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        `inbound media batch ${batchId} has no persisted download route`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const originDomain = batch.originDomain;
    const originSeq = batch.originSeq;

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

  /**
   * Promote a staged inbound message once every referenced file is SUCCEEDED and any quote target has
   * a receiver-local seq (§12.5). Replicates storePulledMessageInTransaction's direct-path work — seq allocation,
   * CAS-URL contextualization, tombstone re-check (may have arrived while pending), MessageAsset authz
   * rows, last-message cache, quota — then SSE-fans the now-visible message and re-signals the hub. A
   * not-yet-ready batch (any file PENDING/DOWNLOADING/FAILED) is a no-op; a later runFileSyncBatch retry
   * re-attempts. On a successful promote the PendingMedia + FileSyncProgress rows are deleted.
   */
  private async promotePendingMessage(batchId: string): Promise<void> {
    const promoted = await this.database.db.transaction(async (tx) => {
      const batch = await tx.query.pendingMedia.findFirst({
        where: eq(tables.pendingMedia.batchId, batchId),
      });
      if (!batch) return null;
      // Barrier: every file must be SUCCEEDED (§12.5 — a failed file keeps the message staged for an
      // admin; it does NOT promote as broken). Derived, not counter-maintained.
      const outstanding = await tx.execute(sql`
        SELECT 1 FROM "FileSyncProgress"
        WHERE "batchId" = ${batchId} AND status <> 'SUCCEEDED'
        LIMIT 1
      `);
      if ((outstanding.rows ?? []).length > 0) return null;

      const threadId = batch.threadId;
      const creatorId = batch.creatorId;
      const originSeq = batch.originSeq!;
      if (!batch.originServerTime) {
        throw new Error('inbound pending media is missing originCreatedAt');
      }
      await this.assertThreadResponseWritable(
        tx,
        threadId,
        batch.originDomain!,
        batch.expectedFederationVersion!,
      );
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        threadId,
        batch.originDomain!,
        originSeq,
      );
      const tombstone = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(tables.federatedMessageTombstone.threadId, threadId),
          eq(
            tables.federatedMessageTombstone.sourceDomain,
            batch.originDomain!,
          ),
          eq(tables.federatedMessageTombstone.messageSeq, originSeq),
        ),
        columns: { type: true, sourceDomain: true },
      });
      let localQuoteSeq: number | undefined;
      const quoteTarget =
        batch.dependsOnOriginSeq === null
          ? undefined
          : { targetSeq: batch.dependsOnOriginSeq };
      if (!tombstone && quoteTarget) {
        const quoted = await this.findQuoteTargetMessage(
          tx,
          threadId,
          batch.originDomain!,
          quoteTarget.targetSeq,
        );
        // A zero-file dependent batch is intentionally retried by its target's successful promotion.
        if (!quoted) return null;
        localQuoteSeq = quoted.seq;
      }
      const [{ curSeq: seq }] = await tx
        .update(tables.messageThread)
        .set({ curSeq: sql`${tables.messageThread.curSeq} + 1` })
        .where(eq(tables.messageThread.id, threadId))
        .returning({ curSeq: tables.messageThread.curSeq });
      let storedContent = contextualizeCasUrls(batch.content, threadId, seq);
      if (localQuoteSeq !== undefined) {
        const text = parseTextMessageContent(batch.content);
        if (!text) throw new Error('pending quote has invalid text content');
        storedContent = stringifyTextMessageContent({
          text: text.text,
          quote: { seq: localQuoteSeq },
        });
      }
      const [message] = await tx
        .insert(tables.message)
        .values({
          contentType: batch.contentType as ContentType,
          content: storedContent,
          threadId,
          creator: creatorId,
          seq,
          originSeq,
          clientMessageId: batch.clientMessageId,
          originServerTime: batch.originServerTime,
          federationSourceDomain: batch.originDomain,
          isDeleted: tombstone !== undefined,
          updatedAt: new Date(),
        })
        .returning();
      let localDeletionId: bigint | null = null;
      if (tombstone) {
        const [createdDeletion] = await tx
          .insert(tables.deletedMessage)
          .values({
            threadId,
            seq,
            type: tombstone.type,
            federationSourceDomain: tombstone.sourceDomain,
            updatedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [tables.deletedMessage.threadId, tables.deletedMessage.seq],
          })
          .returning({ id: tables.deletedMessage.id });
        localDeletionId = createdDeletion?.id ?? null;
        await tx
          .delete(tables.federatedMessageTombstone)
          .where(
            and(
              eq(tables.federatedMessageTombstone.threadId, threadId),
              eq(
                tables.federatedMessageTombstone.sourceDomain,
                batch.originDomain!,
              ),
              eq(tables.federatedMessageTombstone.messageSeq, originSeq),
            ),
          );
      } else {
        for (const digest of extractDigests(batch.content)) {
          await tx
            .insert(tables.messageAsset)
            .values({ messageId: message.id, threadId, digest })
            .onConflictDoNothing();
        }
      }
      await ClientMessageFeedWriter.publishMessage(tx, threadId, seq);
      if (localDeletionId !== null)
        await ClientMessageFeedWriter.publishTombstone(
          tx,
          threadId,
          localDeletionId,
        );
      const arrival = message.createdAt;
      await tx
        .update(tables.messageThread)
        .set({
          lastMessageSeq: seq,
          lastMessagePreview: derivePreview(
            batch.contentType as ContentType,
            storedContent,
          ),
          lastMessageAt: arrival,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tables.messageThread.id, threadId),
            or(
              isNull(tables.messageThread.lastMessageAt),
              lt(tables.messageThread.lastMessageAt, arrival),
            ),
          ),
        );
      const recipients = await this.localActiveMemberIds(threadId);
      await tx
        .delete(tables.fileSyncProgress)
        .where(eq(tables.fileSyncProgress.batchId, batchId));
      await tx
        .delete(tables.pendingMedia)
        .where(eq(tables.pendingMedia.id, batch.id));
      await this.quota.tickLax(batch.originDomain!, 'messages', tx, 1);
      return {
        message,
        threadId,
        creatorId,
        originSeq,
        originDomain: batch.originDomain!,
        recipients,
      };
    });
    if (!promoted) return;
    const {
      message,
      threadId,
      creatorId,
      originSeq,
      originDomain,
      recipients,
    } = promoted;
    if (message.isDeleted) {
      const deletion = await this.database.db.query.deletedMessage.findFirst({
        where: and(
          eq(tables.deletedMessage.threadId, threadId),
          eq(tables.deletedMessage.seq, message.seq),
        ),
        columns: { id: true },
      });
      if (deletion) {
        for (const uid of recipients) {
          this.sse.onDeletedMessageUpdated(
            uid,
            threadId,
            deletion.id.toString(),
          );
        }
      }
    } else {
      const liveRecipients = await this.unblockedRecipients(
        threadId,
        recipients,
      );
      for (const uid of liveRecipients) {
        if (uid !== creatorId) {
          this.sse.onNewMessage(
            uid,
            threadId,
            message.seq,
            message.createdAt.getTime(),
          );
        }
      }
    }
    void this.signalOutbound(
      threadId,
      creatorId,
      originSeq,
      originDomain,
    ).catch(() => undefined);
    if (message.isDeleted) {
      void this.signalDeletionOutbound(threadId, message.seq).catch(
        () => undefined,
      );
    }

    // Wake every durable quote that was waiting for this wire coordinate. Each successful child
    // promotion performs the same lookup again, naturally draining quote chains without polling.
    const dependents = await this.database.db.query.pendingMedia.findMany({
      where: and(
        eq(tables.pendingMedia.threadId, threadId),
        eq(tables.pendingMedia.originDomain, originDomain),
        eq(tables.pendingMedia.dependsOnOriginSeq, originSeq),
      ),
      columns: { batchId: true },
    });
    for (const dependent of dependents) {
      await this.promotePendingMessage(dependent.batchId);
    }
  }

  /** Apply the participant's thread-scoped delivery block to federation-originated live signals too. */
  private async unblockedRecipients(
    threadId: number,
    candidateIds: number[],
  ): Promise<number[]> {
    const candidates = new Set(candidateIds);
    const participants =
      await this.participantService.getActiveParticipantUserIds(threadId);
    return participants
      .filter(
        (participant) =>
          !participant.blocked && candidates.has(participant.userId),
      )
      .map((participant) => participant.userId);
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
    // All digests processed (best-effort). Re-query for the final status, then signal every local
    // recipient so their card flips off the optimistic 'downloading': 'ready' = every digest has bytes
    // on disk + an authz row (the URL now serves 200), 'failed' = at least one digest is still inert
    // (shown as a retryable failure). `v` is a monotonic version so the client drops stale out-of-order
    // frames (a manual retry re-localize, or a reconnect replay). The manual relocalize endpoint calls
    // this same method, so its MEDIA_STATUS signal is produced here too — one push site, not two.
    const ready = await this.isMessageMediaReady(msg.id, msg.content);
    const recipients = await this.localActiveMemberIds(msg.threadId);
    for (const uid of recipients) {
      this.sse.onMediaStatus(uid, {
        threadId: msg.threadId,
        seq: msg.seq,
        status: ready ? MEDIA_STATUS.READY : MEDIA_STATUS.FAILED,
        v: Date.now(),
      });
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
  ): Promise<'ready' | 'failed'> {
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
    if (msg.creator === null)
      throw new Error('user-authored media message has no creator');
    const creator = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, msg.creator),
      columns: { account: true, domain: true, isForeigner: true },
    });
    if (!creator) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `media message ${threadId}/${seq} creator ${msg.creator} not found`,
      );
    }
    const { toAccount, peerDomain } = await this.resolveMediaContext(
      msg.threadId,
      msg.creator,
      creator.account,
      creator.domain,
    );
    const federationVersion = await this.readThreadFederationVersion(
      msg.threadId,
      peerDomain,
    );
    await this.localizeMedia(
      msg,
      peerDomain,
      creator.account,
      this.effectiveDomain(creator),
      toAccount,
      msg.originSeq ?? msg.seq,
      federationVersion,
    );
    return (await this.isMessageMediaReady(msg.id, msg.content))
      ? 'ready'
      : 'failed';
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
    const recipients = await this.localActiveMemberIds(msg.threadId);
    for (const uid of recipients) {
      this.sse.onMediaStatus(uid, {
        threadId: msg.threadId,
        seq: msg.seq,
        status: ready ? MEDIA_STATUS.READY : MEDIA_STATUS.FAILED,
        v: Date.now(),
      });
    }
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
    creatorUserId: number,
    creatorAccount: string,
    creatorDomain: string,
  ): Promise<{ toAccount: string; peerDomain: string }> {
    const thread = await this.database.db.query.messageThread
      .findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: {
          type: true,
        },
        with: { user: { columns: { account: true, domain: true } } },
      })
      .then((row) => (row ? { ...row, groupUser: row.user } : null));
    if (thread?.type === MessageThreadType.GROUP && thread.groupUser) {
      return {
        toAccount: thread.groupUser.account,
        peerDomain: thread.groupUser.domain,
      };
    }
    // P2P: the receiver is the thread's other active (non-creator) participant.
    const peer = await this.database.db.query.threadParticipant.findFirst({
      where: and(
        eq(tables.threadParticipant.threadId, threadId),
        ne(tables.threadParticipant.userId, creatorUserId),
      ),
      with: { user: { columns: { account: true } } },
    });
    return {
      toAccount: peer?.user.account ?? creatorAccount,
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
    if (msg.creator === null)
      throw new Error('user-authored forward message has no creator');
    const creator = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, msg.creator),
      columns: { account: true, domain: true, isForeigner: true },
    });
    if (!creator) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `forward message ${msg.threadId}/${msg.seq} creator ${msg.creator} not found`,
      );
    }
    const { toAccount } = await this.resolveMediaContext(
      msg.threadId,
      msg.creator,
      creator.account,
      creator.domain,
    );
    return {
      fromAccount: creator.account,
      fromDomain: this.effectiveDomain(creator),
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
    const chunkBytes = this.transportConfig.get().mediaChunkBytes;
    const base = await this.discovery.resolveBase(peerDomain);
    const params = new URLSearchParams({
      fromAccount,
      fromDomain,
      toAccount,
      seq: String(sourceSeq),
    });
    const path = `/s2s/v1/media/${digest}?${params.toString()}`;
    const url = new URL(`${base}${path}`);
    let offset = startOffset;
    let total: number | null = null;
    let markedAlive = false;

    while (total === null || offset < total) {
      const reqEnd =
        total === null
          ? chunkBytes - 1
          : Math.min(offset + chunkBytes - 1, total - 1);
      let unit = await this.requestRangeUnit(url, peerDomain, offset, reqEnd);
      if (!markedAlive) {
        await this.markContactSuccess(peerDomain);
        markedAlive = true;
      }
      total = unit.total;
      let unitLen = unit.end - unit.start + 1;

      // Accumulate the unit body with retry-on-abort. A body-read error or a byte-count mismatch
      // discards the partial buffer and re-requests the SAME range; NO degradation (the peer already
      // returned 2xx headers — it is alive, we just lost a stream).
      let buf: Buffer = Buffer.alloc(0);
      let retries = 0;
      while (buf.length !== unitLen) {
        try {
          const pieces: Buffer[] = [];
          for await (const piece of this.webBody(unit.res)) pieces.push(piece);
          buf = pieces.length === 0 ? Buffer.alloc(0) : Buffer.concat(pieces);
          if (buf.length !== unitLen) {
            throw new Error(
              `unit byte mismatch (got ${buf.length}, expected ${unitLen})`,
            );
          }
          const actualDigest = contentDigest(buf);
          if (unit.contentDigest && actualDigest !== unit.contentDigest) {
            throw new Error(`unit digest mismatch at offset ${offset}`);
          }
        } catch (e) {
          if (++retries > this.transportConfig.get().mediaMaxChunkRetries) {
            throw new Error(
              `media fetch retries exhausted at offset ${offset}: ${(e as Error).message}`,
            );
          }
          unit = await this.requestRangeUnit(
            url,
            peerDomain,
            offset,
            Math.min(offset + chunkBytes - 1, total - 1),
          );
          unitLen = unit.end - unit.start + 1;
          buf = Buffer.alloc(0);
        }
      }
      yield buf;
      offset += unitLen;
    }
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
  ): Promise<{
    res: Response;
    start: number;
    end: number;
    total: number;
    contentDigest?: string;
  }> {
    const operationStartedAt = new Date();
    const headers = await this.signature.signOutbound({
      method: 'GET',
      url,
      body: '', // GET — the content-digest covers sha256("")
    });
    let res: Response;
    try {
      res = await this.discovery.request(url, {
        method: 'GET',
        headers: { ...headers, range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(
          this.transportConfig.get().mediaChunkTimeoutSec * 1000,
        ),
      });
    } catch (e) {
      await this.recognition.markTransportDegraded(
        peerDomain,
        `GET media network/timeout: ${(e as Error).message}`,
        operationStartedAt,
      );
      throw new Error(
        `S2S media from ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
      );
    }
    if (res.status === 200) {
      await this.markContactSuccess(peerDomain);
      const error = await this.readMediaErrorEnvelope(res);
      if (error) {
        throw new S2sResponseError(
          `S2S media from ${peerDomain} returned business code ${error.code}`,
          res.status,
          error.code,
          error.data,
        );
      }
      throw new S2sResponseError(
        'S2S media peer ignored required Range request',
        res.status,
        BusinessCode.FEDERATION_MALFORMED,
      );
    }
    if (res.status === 206) {
      const cr = res.headers.get('content-range') ?? '';
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (!m) {
        await this.recognition.markTransportDegraded(
          peerDomain,
          `GET media 206 unparseable Content-Range: ${cr}`,
          operationStartedAt,
        );
        throw new Error(`S2S media 206 without parseable Content-Range: ${cr}`);
      }
      const returnedStart = Number(m[1]);
      const returnedEnd = Number(m[2]);
      const returnedTotal = Number(m[3]);
      const contentDigestHeader = res.headers.get('content-digest');
      if (
        returnedStart !== start ||
        returnedEnd < returnedStart ||
        returnedEnd > end ||
        returnedEnd >= returnedTotal
      ) {
        throw new Error(
          `S2S media returned unexpected Content-Range: ${cr} for bytes=${start}-${end}`,
        );
      }
      if (
        contentDigestHeader !== null &&
        !/^sha-256=:[A-Za-z0-9+/]{43}=:$/i.test(contentDigestHeader)
      ) {
        throw new Error('S2S media 206 with an invalid Content-Digest');
      }
      return {
        res,
        start: returnedStart,
        end: returnedEnd,
        total: returnedTotal,
        contentDigest: contentDigestHeader ?? undefined,
      };
    }
    const error = await this.readMediaErrorEnvelope(res);
    const code = error?.code;
    if (res.status === HttpStatus.SERVICE_UNAVAILABLE || res.status >= 500) {
      await this.recognition.markTransportDegraded(
        peerDomain,
        `GET media HTTP ${res.status}`,
        operationStartedAt,
      );
    } else if (
      res.status === HttpStatus.CONFLICT &&
      this.isFatalPeerCode(code)
    ) {
      await this.markPeerHalted(peerDomain, code, error?.message);
    }
    if (res.status === HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE) {
      const contentRange = res.headers.get('content-range') ?? '';
      if (
        code !== BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE ||
        !/^bytes \*\/\d+$/.test(contentRange)
      ) {
        throw new S2sResponseError(
          'S2S media returned malformed 416 response',
          res.status,
          BusinessCode.FEDERATION_MALFORMED,
        );
      }
    }
    throw new S2sResponseError(
      `S2S media from ${peerDomain} rejected: HTTP ${res.status}`,
      res.status,
      code,
      error?.data,
    );
  }

  private async readMediaErrorEnvelope(
    res: Response,
  ): Promise<{ code: number; message?: string; data?: unknown } | undefined> {
    const contentType = (res.headers.get('content-type') ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') return undefined;
    const text = await res.text();
    if (Buffer.byteLength(text) > 64 * 1024) return undefined;
    try {
      const parsed = JSON.parse(text) as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      };
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.code !== 'number' ||
        !Number.isSafeInteger(parsed.code) ||
        parsed.code === BusinessCode.OK ||
        typeof parsed.message !== 'string'
      ) {
        return undefined;
      }
      return {
        code: parsed.code,
        message: parsed.message,
        data: parsed.data,
      };
    } catch {
      return undefined;
    }
  }

  /** Iterate a fetch Response web body as Buffer chunks. Node's global ReadableStream (undici) is
   *  async-iterable at runtime; the cast bridges the TS lib's ReadableStream (not declared
   *  AsyncIterable) to the for-await syntax. */
  private async *webBody(res: Response): AsyncGenerator<Buffer> {
    if (!res.body) return;
    for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
      yield Buffer.from(piece);
    }
  }

  /**
   * Fetch a peer user's public profile (signed GET /s2s/v1/users/:account). Used by federated
   * resolve (the add-friend card), ensureForeignUserLocalized (send-friend-request safety net), and
   * initial invite/profile localization. Throws on any non-success (the caller
   * surfaces FEDERATION_DELIVERY_FAILED → user retries / inits).
   */
  async fetchRemoteUser(address: S2SAddress): Promise<S2SProfile> {
    return this.getSigned<S2SProfile>(
      `/s2s/v1/users/${encodeFederationResourceComponent(address.account)}`,
      address.domain,
    );
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
      columns: { avatar: true, remoteProfileRev: true },
    });
    if (!stub) return; // stub gone — nothing to localize
    if (
      stub.remoteProfileRev !== null &&
      profile.profileRev <= stub.remoteProfileRev
    ) {
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
      );
      const [stub] = await tx
        .select({ remoteProfileRev: tables.user.remoteProfileRev })
        .from(tables.user)
        .where(eq(tables.user.id, userId))
        .for('update')
        .limit(1);
      if (
        stub?.remoteProfileRev !== null &&
        stub?.remoteProfileRev !== undefined &&
        profile.profileRev <= stub.remoteProfileRev
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
    remoteProfileRev: number;
    avatar?: string;
  }> {
    let newAvatarUrl: string | null = null;
    if (profile.avatar) {
      try {
        newAvatarUrl = await this.upload.saveAvatarFromWire(profile.avatar);
      } catch {
        newAvatarUrl = null;
      }
    } else {
      newAvatarUrl = '';
    }
    const data: {
      name: string;
      bio: string;
      remoteProfileRev: number;
      avatar?: string;
    } = {
      name: profile.displayName,
      bio: profile.bio,
      remoteProfileRev: profile.profileRev,
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
