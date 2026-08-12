import {
  forwardRef,
  Injectable,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  mintUlid,
  normalizeAccount,
  isValidAccount,
} from '../common/account.js';
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
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  max,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { CasOversizeError, UploadService } from '../upload/upload.service.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import {
  FORWARD_MAX_WIRE_JSON_BYTES,
  ForwardBundleService,
  type ForwardWireClosure,
} from '../forward/forward-bundle.service.js';
import { contentDigest, SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { QuotaService } from '../quota/quota.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { InviteService } from '../invite/invite.service.js';
import { SseService, GROUP_SSE } from '../gateway/sse.service.js';
import {
  ThreadRevisionService,
  type PendingThreadRevision,
} from '../thread-revision/thread-revision.service.js';
import { derivePreview, MessageService } from '../message/message.service.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';
import {
  extractDigestEntries,
  extractDigests,
} from '../upload/file-content.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import { MEDIA_STATUS } from '../common/media-status.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { FederationMemoryFeedService } from './federation-memory-feed.service.js';
import { FEDERATION_MEMORY_FEED_ADVANCED } from './federation-memory-feed.events.js';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import {
  buildCallContent,
  parseFederatedCallContent,
  sameFederatedCallAddress,
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

import {
  FederationIdentityService,
  type SignedFederationIdentity,
} from './federation-identity.service.js';
import { FederationCursorService } from './federation-cursor.service.js';
import { FederationIgniteService } from './federation-ignite.service.js';
import {
  FEDERATED_MESSAGE_CONTENT_TYPES,
  type FederationMessageFeedPage,
} from './federation-message-feed.service.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import {
  FederationMessageFeedPullService,
  RemoteMessageFeedCursorResetError,
} from './federation-message-feed-pull.service.js';
import {
  PeerStateFeedService,
  type PeerStateBody,
  type PeerStateFeedPage,
} from './peer-state-feed.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import { GroupMembershipStateService } from '../group/group-membership-state.service.js';
import { SystemMessageType } from '../message/system-message.js';
import {
  assertServerGroupCapacityInTx,
  SERVER_GROUP_FULL_REASON,
} from '../group/group-capacity.js';
import {
  FEDERATION_PROTOCOL_VERSION,
  selectFederationProtocolVersion,
} from './federation-protocol.js';

/**
 * A non-2xx S2S response that is NOT a peer-liveness failure (i.e. a 4xx application response such as
 * 404 Not Found or 410 Gone, NOT 401/403/5xx which DO mark the peer demoted). Thrown by getSigned so the
 * caller can branch on `status` — e.g. the per-author group pull reacts to 410 GONE
 * (FEDERATION_GROUP_AUTHOR_LEFT) by soft-leaving the author instead of treating it as a transport error.
 * Carries the parsed body's business `code` (if any) for diagnostics. See design-review item C2.
 */
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
  creator: S2SAddress;
  originSeq: number;
}

interface FederatedForwardCard {
  version: number;
  bundleId: string;
  summaryLines: string[];
  messageCount: number;
  assetCount: number;
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
  restored: Array<{ userId: number; revision: number }>;
  forwardClosure?: ForwardWireClosure;
  remoteForwardBundleId?: string;
}

interface StatePageEffect {
  revisions: PendingThreadRevision[];
  statePushDomains: string[];
  localSystemMessages: Array<{
    actorUserId: number;
    threadId: number;
    type: SystemMessageType;
    subjectUserId?: number;
  }>;
}

interface S2SDeletedMessage {
  id: string;
  target: { creator: S2SAddress; originSeq: number };
  type: MessageDeleteType;
  deletedAt: number;
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
 * user retries (the compacted state key plus business revision makes retries safe). Step 2 messages do NOT
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
    private readonly threadRevisionService: ThreadRevisionService,
    private readonly quota: QuotaService,
    private readonly linkPreview: LinkPreviewService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly messageVisibility: MessageVisibilityService,
    private readonly deletedMessages: DeletedMessageService,
    // Inbound S2S call frames are bridged to CallsService via emitAsync('call.frame.inbound') rather
    // than a direct injection — FederationService must NOT inject CallsService (that would cycle: the
    // calls layer injects FederationService for outbound). The event bus breaks the edge cleanly.
    private readonly eventEmitter: EventEmitter2,
    private readonly federationIdentity: FederationIdentityService,
    private readonly federationCursor: FederationCursorService,
    private readonly federationInit: FederationIgniteService,
    private readonly downloadScheduler: FederationDownloadScheduler,
    private readonly stateFeedPull: PeerStateFeedPullService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly groupMembershipState: GroupMembershipStateService,
    @Optional()
    private readonly memoryMessageFeed?: FederationMemoryFeedService,
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
   * The single origin-hub routing + loop-safety entry. A message pulled directly from its author is
   * signalled back once because its allocated self-authored feed item is the delivery receipt. For a
   * third-party relay, fetchedFromDomain is subtracted because that source already has the message.
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
          where: and(
            eq(tables.threadParticipant.threadId, threadId),
            isNull(tables.threadParticipant.leftAt),
          ),
          with: {
            user: {
              columns: { account: true, domain: true, isForeigner: true },
            },
          },
        }),
      ]);
      if (!trd) return;
      const author = participants.find((p) => p.userId === authorUserId);
      if (!author) return;
      const authorDomain = this.effectiveDomain(author.user);
      if (fetchedFromDomain && authorDomain === fetchedFromDomain) {
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
        for (const p of participants) {
          if (p.userId === authorUserId || !p.user.isForeigner) continue;
          if (fetchedFromDomain && p.user.domain === fetchedFromDomain)
            continue;
          void this.offerAndPushMessage(
            p.user.domain,
            threadId,
            latestSeq,
          ).catch((e) =>
            this.logger.debug(
              `discovery HWM push ${p.user.domain} failed: ${(e as Error).message}`,
            ),
          );
        }
        return;
      }
      // GROUP federated. dest = (origin → all foreign member-domains; mirror → {originDomain}), minus the
      // fetch source. The `toAccount` is the group `!account` (one hint per foreign domain).
      const destDomains = new Set<string>();
      if (groupDomain === 'local') {
        for (const p of participants)
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
    await this.memoryMessageFeed?.offerCommitted(
      peerDomain,
      threadId,
      messageSeq,
    );
    await this.pushDiscoveryHwm(peerDomain);
  }

  @OnEvent(FEDERATION_MEMORY_FEED_ADVANCED)
  onMemoryMessageFeedAdvanced(event: { peerDomain: string }): void {
    void this.pushDiscoveryHwm(event.peerDomain).catch((error: unknown) =>
      this.logger.debug(
        `memory-feed HWM push ${event.peerDomain} failed: ${(error as Error).message}`,
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
        }
      : null;
    const peers = await tx.execute<{ domain: string }>(sql`
      SELECT DISTINCT peer_user.domain
      FROM "ThreadParticipant" mine
      JOIN "ThreadParticipant" peer_part ON peer_part."threadId" = mine."threadId" AND peer_part."leftAt" IS NULL
      JOIN "User" peer_user ON peer_user.id = peer_part."userId"
      WHERE mine."userId" = ${userId} AND mine."leftAt" IS NULL
        AND peer_user."isForeigner" = true AND peer_user.domain <> 'local'
    `);
    if (!peers.rows.length) return new Map();
    return this.stateFeed.writeManyInTx(
      tx,
      peers.rows.map(({ domain }) => ({
        peerDomain: domain,
        account: u.account,
        eventType: 'PROFILE' as const,
        revision: u.profileRev,
        body: {
          domain: this.config.domain,
          name: u.name,
          bio: u.bio,
          avatar,
          deleted: false,
        },
      })),
    );
  }

  /** Publish one local user's current profile to an explicitly addressed peer. This is used for the
   * first friendship intent, before a P2P ThreadAudience exists. */
  private async writeProfileStateToPeerInTx(
    tx: DatabaseTransaction,
    userId: number,
    peerDomain: string,
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
        eventType: 'PROFILE',
        revision: u.profileRev,
        body: {
          domain: this.config.domain,
          name: u.name,
          bio: u.bio,
          avatar: wire
            ? {
                digest: createHash('sha256')
                  .update(Buffer.from(wire.b64, 'base64'))
                  .digest('hex'),
                mimeType: 'image/webp',
                base64: wire.b64,
              }
            : null,
          deleted: false,
        },
      },
    ]);
  }

  /** A federated friend request, approval, rejection and deletion are all the same local intent
   * transition. The peer observes it through the compacted P2P_META key. */
  async writeFriendIntentInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    peerUserId: number,
    wantsFriend: boolean,
    note = '',
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
    await this.invite.writeLocalFriendIntentInTx(
      tx,
      localUserId,
      peerUserId,
      wantsFriend,
      note,
    );
    const request = await tx.execute<{
      status: 'REQUESTED' | 'FRIEND' | 'NOT_FRIEND';
      note: string;
      revision: number;
      requestedAt: Date | string | null;
      expiresAt: Date | string | null;
    }>(sql`
      SELECT status, note, revision, "requestedAt", "expiresAt" FROM "FriendRequest"
      WHERE "requesterUserId" = ${localUserId} AND "targetUserId" = ${peerUserId}
    `);
    const current = request.rows[0];
    if (!current) throw new Error('friend request write disappeared');
    const profile = await this.writeProfileStateToPeerInTx(
      tx,
      localUserId,
      remote.domain,
    );
    const relationship = await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain: remote.domain,
        account: local.account,
        subjectAccount: remote.account,
        eventType: 'P2P_META',
        revision: current.revision,
        body: {
          status: current.status,
          note: current.note,
          requestedAt: fromRawTimestamp(current.requestedAt),
          expiresAt: fromRawTimestamp(current.expiresAt),
        },
      },
    ]);
    return new Map([...profile, ...relationship]);
  }

  async writeGroupInviteIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    note = '',
    requested = true,
  ): Promise<Map<string, bigint>> {
    const [state] = await tx
      .select({
        groupUserId: tables.messageThread.groupUserId,
        groupAccount: tables.user.account,
        curSeq: tables.messageThread.curSeq,
        ownerId: tables.group.ownerId,
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
    const [member, owner] = await Promise.all([
      tx.query.user.findFirst({
        where: eq(tables.user.id, memberUserId),
        columns: { account: true, domain: true, isForeigner: true },
      }),
      tx.query.user.findFirst({
        where: eq(tables.user.id, state.ownerId),
        columns: { account: true, domain: true },
      }),
    ]);
    if (!member || !owner)
      throw new Error('group invite identities are invalid');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const membership = await this.groupMembershipState.writeLocalDirectionInTx(
      tx,
      {
        groupUserId: state.groupUserId,
        memberUserId,
        direction: 'INVITE',
        requested,
        note,
        expiresAt: requested ? expiresAt : null,
      },
    );
    if (!member.isForeigner) return new Map();
    const profile = requested
      ? await this.writeProfileStateToPeerInTx(
          tx,
          state.groupUserId,
          member.domain,
        )
      : new Map<string, bigint>();
    const intent = await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain: member.domain,
        account: state.groupAccount,
        subjectAccount: member.account,
        eventType: 'GROUP_INVITE_INTENT',
        revision: membership.request.revision,
        body: {
          status: membership.request.status,
          note: membership.request.note,
          requestedAt: membership.request.requestedAt,
          expiresAt: membership.request.expiresAt,
          owner: {
            account: owner.account,
            domain:
              owner.domain === 'local' ? this.config.domain : owner.domain,
          },
          sinceSeq: state.curSeq,
        },
      },
    ]);
    return new Map([...profile, ...intent]);
  }

  async writeGroupJoinIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    requested = true,
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
        columns: { account: true, domain: true },
      }),
      tx.query.user.findFirst({
        where: eq(tables.user.id, memberUserId),
        columns: { account: true, isForeigner: true },
      }),
    ]);
    if (!groupUser || !member || member.isForeigner)
      throw new Error('group join identities are invalid');
    const membership = await this.groupMembershipState.writeLocalDirectionInTx(
      tx,
      {
        groupUserId: thread.groupUserId,
        memberUserId,
        direction: 'JOIN',
        requested,
      },
    );
    if (groupUser.domain === 'local') {
      if (!requested) {
        await this.groupMembershipState.setPairActiveInTx(
          tx,
          thread.groupUserId,
          memberUserId,
          false,
        );
        return new Map();
      }
      if (!membership.shouldBeActive) return new Map();
      const activated = await this.groupMembershipState.setPairActiveInTx(
        tx,
        thread.groupUserId,
        memberUserId,
        true,
      );
      if (!activated) return new Map();
      await tx
        .update(tables.group)
        .set({ rosterRev: sql`${tables.group.rosterRev} + 1` })
        .where(eq(tables.group.groupUserId, thread.groupUserId));
      const state = await this.writeGroupStateInTx(tx, threadId);
      const profiles = await this.writeGroupMemberProfilesInTx(tx, threadId);
      return new Map([...state, ...profiles]);
    }
    const profile = requested
      ? await this.writeProfileStateToPeerInTx(
          tx,
          memberUserId,
          groupUser.domain,
        )
      : new Map<string, bigint>();
    const intent = await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain: groupUser.domain,
        account: groupUser.account,
        subjectAccount: member.account,
        eventType: 'GROUP_JOIN_INTENT',
        revision: membership.request.revision,
        body: {
          status: membership.request.status,
          note: membership.request.note,
          requestedAt: membership.request.requestedAt,
          expiresAt: null,
        },
      },
    ]);
    return new Map([...profile, ...intent]);
  }

  /** User-facing acceptance of a stored GROUP→USER request. This authors only the local JOIN
   * direction; a federated mirror remains inactive until the origin returns GROUP_META. */
  async acceptGroupRequest(
    threadId: number,
    memberUserId: number,
  ): Promise<void> {
    const result = await this.database.db.transaction(async (tx) => {
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
        !(await this.groupMembershipState.hasValidInviteInTx(
          tx,
          thread.groupUserId,
          memberUserId,
        ))
      )
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      let alreadyActive = false;
      if (thread.groupDomain === 'local') {
        await assertServerGroupCapacityInTx(tx, threadId, memberUserId);
        const existing = await tx.query.threadParticipant.findFirst({
          where: and(
            eq(tables.threadParticipant.threadId, threadId),
            eq(tables.threadParticipant.userId, memberUserId),
            isNull(tables.threadParticipant.leftAt),
          ),
          columns: { id: true },
        });
        alreadyActive = !!existing;
        await this.participantService.upsertMemberInTx(
          tx,
          threadId,
          memberUserId,
          GroupRole.MEMBER,
        );
        await tx
          .insert(tables.threadAudience)
          .values({
            targetDomain: 'local',
            localUserId: memberUserId,
            threadId,
          })
          .onConflictDoNothing();
      }
      const allocated = await this.writeGroupJoinIntentInTx(
        tx,
        threadId,
        memberUserId,
      );
      const revision =
        thread.groupDomain === 'local'
          ? await this.threadRevisionService.recordThreadAddInTx(
              tx,
              memberUserId,
              threadId,
            )
          : null;
      return {
        allocated,
        revision,
        shouldWriteStatus: thread.groupDomain === 'local' && !alreadyActive,
      };
    });
    if (result.revision !== null)
      this.threadRevisionService.notifyThreadRevision({
        userId: memberUserId,
        revision: result.revision,
      });
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
    await Promise.allSettled(
      [...new Set(domains)].map((domain) => this.pushDiscoveryHwm(domain)),
    );
  }

  /** Transactional authoritative GROUP_META + group PROFILE snapshot writer. */
  async writeGroupStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    finalPeerDomains: readonly string[] = [],
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
        membersCanInvite: tables.group.membersCanInvite,
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
      })
      .from(tables.threadParticipant)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.threadParticipant.userId),
      )
      .where(
        and(
          eq(tables.threadParticipant.threadId, threadId),
          isNull(tables.threadParticipant.leftAt),
        ),
      );
    const normalizeDomain = (domain: string) =>
      domain === 'local' ? this.config.domain : domain;
    const peerDomains = new Set([
      ...roster.map((m) => m.domain).filter((d) => d !== 'local'),
      ...finalPeerDomains,
    ]);
    if (!peerDomains.size) return new Map();
    const owner = roster.find((m) => m.userId === state.ownerId);
    if (!owner) throw new Error('group owner is absent from active roster');
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
        }
      : null;
    return this.stateFeed.writeManyInTx(
      tx,
      [...peerDomains].flatMap((peerDomain) => [
        {
          peerDomain,
          account: state.account,
          eventType: 'PROFILE' as const,
          revision: state.profileRev,
          body: {
            domain: this.config.domain,
            name: state.name,
            bio: state.bio,
            avatar,
            deleted: false,
          },
        },
        {
          peerDomain,
          account: state.account,
          eventType: 'GROUP_META' as const,
          revision: state.rosterRev,
          body: {
            active:
              state.dissolvedAt === null &&
              roster.some((m) => m.domain === peerDomain),
            dissolved: state.dissolvedAt !== null,
            membersCanInvite: state.membersCanInvite,
            owner: {
              account: owner.account,
              domain: normalizeDomain(owner.domain),
            },
            members: roster.map((m) => ({
              account: m.account,
              domain: normalizeDomain(m.domain),
              role: m.role ?? GroupRole.MEMBER,
            })),
          },
        },
      ]),
    );
  }

  /** Backfill every active member's latest known profile to all member servers. */
  private async writeGroupMemberProfilesInTx(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<Map<string, bigint>> {
    const members = await tx
      .select({
        account: tables.user.account,
        domain: tables.user.domain,
        name: tables.user.name,
        bio: tables.user.bio,
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
      .where(
        and(
          eq(tables.threadParticipant.threadId, threadId),
          isNull(tables.threadParticipant.leftAt),
        ),
      );
    const peerDomains = [
      ...new Set(
        members
          .filter((member) => member.isForeigner)
          .map((member) => member.domain),
      ),
    ];
    if (!peerDomains.length) return new Map();
    const snapshots = await Promise.all(
      members.map(async (member) => {
        const revision = member.isForeigner
          ? member.remoteProfileRev
          : member.profileRev;
        if (revision == null) return null;
        const wire = member.avatar
          ? await this.upload.readAvatarAsWire(member.avatar)
          : null;
        return {
          member,
          revision,
          avatar: wire
            ? {
                digest: createHash('sha256')
                  .update(Buffer.from(wire.b64, 'base64'))
                  .digest('hex'),
                mimeType: 'image/webp',
                base64: wire.b64,
              }
            : null,
        };
      }),
    );
    return this.stateFeed.writeManyInTx(
      tx,
      peerDomains.flatMap((peerDomain) =>
        snapshots.flatMap((snapshot) =>
          snapshot
            ? [
                {
                  peerDomain,
                  account: snapshot.member.account,
                  eventType: 'PROFILE' as const,
                  revision: snapshot.revision,
                  body: {
                    domain: snapshot.member.isForeigner
                      ? snapshot.member.domain
                      : this.config.domain,
                    name: snapshot.member.name,
                    bio: snapshot.member.bio,
                    avatar: snapshot.avatar,
                    deleted: false,
                  },
                },
              ]
            : [],
        ),
      ),
    );
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
   *  discovery HWM push. Same liveness/demote wiring as getSigned. */
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
   * trust-lifecycle wiring — `markContactSuccess` on 200/202/204/409 (delivered or idempotent),
   * `markDemoted` on network failure or non-success status (self-heal on next contact). Throws on any
   * non-success. Extracted so the friend-op POSTs and the Step 2 path POSTs share one transport.
   */
  private async sendSignedPost(
    url: URL,
    body: string,
    peerDomain: string,
  ): Promise<void> {
    const operationStartedAt = new Date();
    const headers = await this.signature.signOutbound({
      method: 'POST',
      url,
      body,
    });
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(this.config.callTimeoutSec * 1000),
      });
    } catch (e) {
      await this.markDemoted(
        peerDomain,
        `POST network/timeout: ${(e as Error).message}`,
        operationStartedAt,
      );
      throw new Error(
        `S2S POST to ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
      );
    }
    const status = res.status;
    if (status === 200 || status === 202 || status === 204 || status === 409) {
      await this.markContactSuccess(peerDomain); // delivered or idempotent → advance liveness
      if (status === 200 || status === 202) {
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
    // Trust/server failure (401/403 = signature/trust rejected; 5xx = peer broken) → demote so the
    // reconnect sweep self-heals. A quota refusal (429/413) or resource response (400/404/410) means the
    // peer is HEALTHY and answered — do NOT demote (a quota hit must never demote; see QuotaService).
    // Mirrors getSigned; surface a typed S2sResponseError so a caller can branch on the status.
    if (status === 401 || status === 403 || status >= 500) {
      await this.markDemoted(
        peerDomain,
        `POST HTTP ${status}`,
        operationStartedAt,
      );
    }
    const errBody = await res.json().catch(() => undefined);
    throw new S2sResponseError(
      `S2S POST to ${peerDomain} rejected: HTTP ${status}`,
      status,
      typeof errBody?.code === 'number' ? errBody.code : undefined,
      errBody?.data,
    );
  }

  /** GET a signed S2S endpoint (users / revision). Returns the parsed JSON. Throws on non-success. */
  private async getSigned<T>(
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<T> {
    const operationStartedAt = new Date();
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}${path}`);
    const headers = await this.signature.signOutbound({
      method: 'GET',
      url,
      body: '', // GET — the content-digest covers sha256("")
    });
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { ...headers },
        signal: AbortSignal.timeout(this.config.callTimeoutSec * 1000),
      });
    } catch (e) {
      await this.markDemoted(
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
      // Peer/trust failure (401/403 = signature/trust rejected — the sweep re-handshakes; 5xx = peer
      // broken) → demote so the reconnect sweep self-heals. Resource responses (400/404/410/…) mean the
      // peer is healthy and answered — do NOT demote; surface a typed error so the caller can react
      // (e.g. 410 GONE = the author left). See design-review item C2.
      if (status === 401 || status === 403 || status >= 500) {
        await this.markDemoted(
          peerDomain,
          `GET ${path} HTTP ${status}`,
          operationStartedAt,
        );
      }
      const body = await res.json().catch(() => undefined);
      throw new S2sResponseError(
        `S2S GET ${path} from ${peerDomain} rejected: HTTP ${status}`,
        status,
        typeof body?.code === 'number' ? body.code : undefined,
        body?.data,
      );
    }
    await this.markContactSuccess(peerDomain);
    if (maxResponseBytes !== undefined) {
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxResponseBytes) {
        throw new S2sResponseError(
          `S2S GET ${path} response exceeds ${maxResponseBytes} bytes`,
          HttpStatus.PAYLOAD_TOO_LARGE,
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
          HttpStatus.PAYLOAD_TOO_LARGE,
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
    // S2sResponseError WITHOUT demoting — callers' catch logic keeps working. Unwrapping `data` here means
    // every getSigned caller still receives the typed payload (res.messages / res.profileRev / …), not the
    // envelope — no call site changes. The !res.ok branch above still carries 400/401/410/5xx (notably the
    // 410 group-author-left leave signal, which the consumer detects via S2sResponseError.status).
    if (typeof parsed?.code === 'number' && parsed.code !== BusinessCode.OK) {
      throw new S2sResponseError(
        `S2S GET ${path} from ${peerDomain} business error: code ${parsed.code}`,
        res.status,
        parsed.code,
      );
    }
    return (parsed?.data ?? parsed) as T;
  }

  // ─── trust establishment (ignite handshake) ──────────────────────────────────

  /**
   * Ensure mutual trust with a peer domain before any resolve/friend-op traffic. Idempotent: a no-op if
   * the domain is already trusted. Otherwise the mutual ignite handshake proves
   * we control our domain (the peer fetches OUR .well-known to verify), they auto-accept us, and we
   * trust them back so our guard accepts their inbound and our signed GETs to them succeed. Throws on
   * any failure (peer unreachable / not a SOMS peer / init rejected) — the caller surfaces
   * FEDERATION_DELIVERY_FAILED so the user retries. No dangling trust: we add them to our allow-list
   * only AFTER their /init accepts us.
   *
   * Triggered on-demand by the federated resolve path (a local user searching account@<untrusted-domain>).
   * The reverse direction (their user searches ours) is covered by our inbound /init endpoint auto-accepting them.
   */
  async ensurePeerTrusted(domain: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (
      existing?.trustLevel === 'identity_lost' ||
      existing?.trustLevel === 'reset_in_progress'
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `${domain} identity is locked pending reset`,
        HttpStatus.LOCKED,
      );
    }
    if (existing?.trustLevel === 'trusted') {
      await this.verifyPeerIdentity(domain);
      return;
    }
    if (existing?.trustLevel === 'blocked') {
      // Admin intent — refuse to (re-)handshake. Surfaced as FEDERATION_PEER_BLOCKED (distinct from a
      // delivery failure) so the client can show "blocked by your admin" rather than "unreachable".
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_BLOCKED,
        `${domain} is blocked by an admin`,
        HttpStatus.FORBIDDEN,
      );
    }
    if (existing?.trustLevel === 'demoted') {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_NOT_TRUSTED,
        `${domain} is temporarily unavailable pending signed heartbeat recovery`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    // Only a new/pending peer bootstraps mutual trust and pins the signed pairwise identity.
    await this.sendInit(domain);
  }

  /**
   * Recover one reconnect-sweep candidate without confusing availability with identity bootstrap.
   * A pending first contact may retry the atomic/idempotent /ignite. A demoted established peer must
   * prove the already-pinned identity; it can never silently re-bootstrap.
   */
  async recoverPeerTrust(domain: string): Promise<void> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
      columns: { trustLevel: true },
    });
    if (peer?.trustLevel === 'pending') {
      await this.ensurePeerTrusted(domain);
      return;
    }
    if (peer?.trustLevel !== 'demoted') {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_NOT_TRUSTED,
        `${domain} is not eligible for automatic recovery`,
        HttpStatus.CONFLICT,
      );
    }
    await this.verifyPeerIdentity(domain);
    await this.markRecovered(domain);
  }

  /** Whether mutual trust with a peer domain is ALREADY established — a pure local lookup of the
   *  FederatedPeer allow-list (a row at trustLevel 'trusted'). No network, no side effects. Our own
   *  domain always reads trusted (a account@<our-domain> query is a local lookup, never a handshake).
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
    return existing?.trustLevel === 'trusted';
  }

  // ─── trust lifecycle (state machine + audit log) ──────────────────────────────
  //
  // FederatedPeer holds the CURRENT state (the cheap read path); FederatedPeerEvent is the append-only
  // log of every transition (the admin timeline). FederationService is the single owner: every
  // transition — runtime (init, op success/failure) and admin (block/unblock) — flows through these
  // methods, so the row + the event stay consistent. State machine:
  //   pending ──ignite ok──► trusted ──op failed──► demoted ──identity proof ok──► trusted …

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
   *  Observability-only: NO state machine consumes lastSuccessAt. Demotion is failure-driven (the
   *  matched markDemoted on a failed op), NOT staleness-driven; the reconnect sweep + slowPoll select
   *  targets by trustLevel, never by this watermark. So this write is benign bookkeeping — the explicit
   *  identity continuity and normal signed data requests provide liveness; advancing here is the
   *  higher-fidelity supplement that records every real successful contact. */
  async markContactSuccess(domain: string): Promise<void> {
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
            ne(tables.federatedPeer.trustLevel, 'reset_in_progress'),
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

  /** Record a failed signed S2S op. Always refreshes the latest failure (demotedAt + demoteReason) so
   *  the admin sees the most recent error; if the peer was `trusted` or `pending`, this is a real
   *  trusted→demoted transition — flip the state, bump demotionCount and log a `demoted` event.
   *  Pinned signing keys are continuity evidence and must never be purged by a transient failure.
   *  `blocked`, `identity_lost` and `reset_in_progress` are durable policy/maintenance states → no-op. */
  async markDemoted(
    domain: string,
    reason: string,
    operationStartedAt?: Date,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          trustLevel: tables.federatedPeer.trustLevel,
          lastSuccessAt: tables.federatedPeer.lastSuccessAt,
        })
        .from(tables.federatedPeer)
        .where(eq(tables.federatedPeer.domain, domain))
        .for('update')
        .limit(1);
      if (
        !existing ||
        existing.trustLevel === 'blocked' ||
        existing.trustLevel === 'identity_lost' ||
        existing.trustLevel === 'reset_in_progress' ||
        (operationStartedAt !== undefined &&
          existing.lastSuccessAt !== null &&
          existing.lastSuccessAt > operationStartedAt)
      )
        return;
      const transitioned =
        existing.trustLevel === 'trusted' || existing.trustLevel === 'pending';
      await tx
        .update(tables.federatedPeer)
        .set({
          ...(transitioned
            ? {
                trustLevel: 'demoted' as const,
                demotionCount: sql`${tables.federatedPeer.demotionCount} + 1`,
              }
            : {}),
          demotedAt: new Date(),
          demoteReason: reason.slice(0, 255),
        })
        .where(eq(tables.federatedPeer.domain, domain));
      if (transitioned)
        await tx.insert(tables.federatedPeerEvent).values({
          domain,
          type: 'demoted',
          reason: reason.slice(0, 255),
        });
    });
  }

  /** Promote a demoted peer only after its pinned identity and signed heartbeat have succeeded. */
  async markRecovered(domain: string): Promise<void> {
    const now = new Date();
    const transitioned = await this.database.db.transaction(async (tx) => {
      const [peer] = await tx
        .update(tables.federatedPeer)
        .set({
          trustLevel: 'trusted',
          lastSuccessAt: now,
          demotedAt: null,
          demoteReason: null,
        })
        .where(
          and(
            eq(tables.federatedPeer.domain, domain),
            eq(tables.federatedPeer.trustLevel, 'demoted'),
          ),
        )
        .returning({ domain: tables.federatedPeer.domain });
      if (!peer) return false;
      await tx.insert(tables.federatedPeerEvent).values({
        domain,
        type: 'recovered',
      });
      return true;
    });
    if (transitioned) this.lastSuccessSentAt.set(domain, now.getTime());
  }

  /** Admin block: forbid federation with a peer (ensurePeerTrusted refuses to re-handshake; the inbound
   *  guard rejects it since trustLevel !== 'trusted'). Idempotent. Logs a `blocked` event. */
  async markBlocked(domain: string, note?: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (existing?.trustLevel === 'blocked') return;
    const now = new Date();
    await this.database.db
      .insert(tables.federatedPeer)
      .values({ domain, trustLevel: 'blocked', blockedAt: now })
      .onConflictDoUpdate({
        target: tables.federatedPeer.domain,
        set: { trustLevel: 'blocked', blockedAt: now },
      });
    await this.logEvent(domain, 'blocked', note);
  }

  /** Admin unblock: move the peer to `pending` so the next contact re-runs the ignite handshake to
   *  re-establish trust (it is NOT auto-re-trusted). Logs an `unblocked` event. No-op if not blocked. */
  async markUnblocked(domain: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (!existing || existing.trustLevel !== 'blocked') return;
    await this.database.db
      .update(tables.federatedPeer)
      .set({ trustLevel: 'pending', blockedAt: null })
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

  /** Send a signed identity claim and pin the peer's signed response. */
  private async sendInit(peerDomain: string): Promise<void> {
    const preUpgradeKeys =
      await this.federationIdentity.getPreUpgradeCachedKeys(peerDomain);
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}/s2s/v1/ignite`);
    const localStartChangeId =
      await this.federationCursor.prepareHandshakeStart(peerDomain);
    const claim = this.federationIdentity.createClaim(
      peerDomain,
      undefined,
      localStartChangeId,
    );
    const body = JSON.stringify(claim);
    const headers = await this.signature.signOutbound({
      method: 'POST',
      url,
      body,
    });
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(this.config.callTimeoutSec * 1000),
      });
    } catch (e) {
      throw new Error(
        `S2S init to ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
      );
    }
    if (res.status !== 200 && res.status !== 202) {
      throw new Error(`S2S init to ${peerDomain} rejected: HTTP ${res.status}`);
    }
    const response = (await res.json()) as SignedFederationIdentity;
    await this.verifyAndPinIdentityResponse(
      peerDomain,
      claim.nonce,
      response,
      preUpgradeKeys,
      true,
    );
  }

  /** Reconnect identity check. A contradictory, correctly signed response permanently locks the peer. */
  async verifyPeerIdentity(peerDomain: string): Promise<void> {
    const operationStartedAt = new Date();
    const preUpgradeKeys =
      await this.federationIdentity.getPreUpgradeCachedKeys(peerDomain);
    const nonce = randomBytes(24).toString('base64url');
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}/s2s/v1/identity`);
    url.searchParams.set('nonce', nonce);
    const headers = await this.signature.signOutbound({
      method: 'GET',
      url,
      body: '',
    });
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.config.callTimeoutSec * 1000),
      });
    } catch (error) {
      await this.markDemoted(
        peerDomain,
        `GET identity network/timeout: ${(error as Error).message}`,
        operationStartedAt,
      );
      throw new Error(
        `S2S identity from ${peerDomain} failed (network/timeout): ${(error as Error).message}`,
      );
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403 || res.status >= 500) {
        await this.markDemoted(
          peerDomain,
          `GET identity HTTP ${res.status}`,
          operationStartedAt,
        );
      }
      throw new Error(
        `S2S identity from ${peerDomain} rejected: HTTP ${res.status}`,
      );
    }
    const response = (await res.json()) as SignedFederationIdentity;
    await this.verifyAndPinIdentityResponse(
      peerDomain,
      nonce,
      response,
      preUpgradeKeys,
      false,
    );
  }

  /**
   * Administrator-only, non-destructive recovery after a transient DNS/SRV hijack caused identity loss.
   * The operation never adopts what DNS currently serves: it succeeds only when well-known, the detached
   * identity proof, pairwise id, root fingerprint and signing key all match the evidence pinned before the
   * incident. Cursors, mirrors, authorization and trustedAt are preserved.
   */
  async manuallyRecoverPinnedIdentity(
    peerDomain: string,
    confirmDomain: string,
  ): Promise<{ domain: string; trustLevel: 'trusted' }> {
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
        pairwiseServerId: true,
        rootKeyFingerprint: true,
        identityPinnedAt: true,
      },
    });
    if (
      peer?.trustLevel !== 'identity_lost' ||
      !peer.identityPinnedAt ||
      !peer.pairwiseServerId ||
      !peer.rootKeyFingerprint
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `${domain} is not an identity-lost peer with complete pinned evidence`,
        HttpStatus.CONFLICT,
      );
    }

    // The explicit admin action is also an instruction to discard a possibly polluted cached DNS route.
    this.discovery.invalidateBase(domain);
    const doc = await this.discovery.fetchWellKnown(domain);
    const rootPublicKey = doc.rootKey?.ed25519;
    const computedFingerprint = rootPublicKey
      ? `sha256:${createHash('sha256')
          .update(Buffer.from(rootPublicKey, 'base64'))
          .digest('base64url')}`
      : undefined;
    const cachedKeys = await this.database.db.query.s2SKeyCache.findMany({
      where: eq(tables.s2SKeyCache.domain, domain),
      columns: { keyId: true, publicKey: true },
    });
    const publishedKey = doc.keys[0];
    const originalIdentityReturned =
      selectFederationProtocolVersion(doc.protocolVersions) ===
        FEDERATION_PROTOCOL_VERSION &&
      doc.rootKey?.fingerprint === peer.rootKeyFingerprint &&
      computedFingerprint === peer.rootKeyFingerprint &&
      doc.keys.length === 1 &&
      publishedKey?.ed25519 === rootPublicKey &&
      cachedKeys.length === 1 &&
      cachedKeys[0]?.keyId === publishedKey?.keyId &&
      cachedKeys[0]?.publicKey === publishedKey?.ed25519;
    if (!originalIdentityReturned || !publishedKey) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        `${domain} still does not present the original pinned identity`,
        HttpStatus.CONFLICT,
      );
    }

    const nonce = randomBytes(24).toString('base64url');
    const base = await this.discovery.resolveBase(domain);
    const url = new URL(`${base}/s2s/v1/identity`);
    url.searchParams.set('nonce', nonce);
    const headers = await this.signature.signOutbound({
      method: 'GET',
      url,
      body: '',
    });
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.config.callTimeoutSec * 1000),
      });
    } catch (error) {
      throw new BusinessException(
        BusinessCode.FEDERATION_DELIVERY_FAILED,
        `identity recovery probe for ${domain} failed: ${(error as Error).message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!res.ok) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
        `identity recovery probe for ${domain} returned HTTP ${res.status}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const response = (await res.json()) as SignedFederationIdentity;
    const claim = this.federationIdentity.verifySignedClaim(
      response,
      domain,
      this.config.domain,
      nonce,
      Uint8Array.from(Buffer.from(publishedKey.ed25519, 'base64')),
    );
    if (
      claim.pairwiseServerId !== peer.pairwiseServerId ||
      claim.rootKeyFingerprint !== peer.rootKeyFingerprint
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        `${domain} signed proof does not match the original pinned identity`,
        HttpStatus.CONFLICT,
      );
    }

    await this.discovery.cacheKeys(domain, doc.keys);
    await this.database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          trustLevel: tables.federatedPeer.trustLevel,
          pairwiseServerId: tables.federatedPeer.pairwiseServerId,
          rootKeyFingerprint: tables.federatedPeer.rootKeyFingerprint,
        })
        .from(tables.federatedPeer)
        .where(eq(tables.federatedPeer.domain, domain))
        .for('update')
        .limit(1);
      if (
        locked?.trustLevel !== 'identity_lost' ||
        locked.pairwiseServerId !== claim.pairwiseServerId ||
        locked.rootKeyFingerprint !== claim.rootKeyFingerprint
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
          trustLevel: 'trusted',
          identityLostAt: null,
          identityLostReason: null,
          demotedAt: null,
          demoteReason: null,
          lastSuccessAt: new Date(),
        })
        .where(eq(tables.federatedPeer.domain, domain));
      await tx.insert(tables.federatedPeerEvent).values({
        domain,
        type: 'recovered',
        reason: 'administrator verified the original pinned identity',
      });
    });
    return { domain, trustLevel: 'trusted' };
  }

  private async verifyAndPinIdentityResponse(
    peerDomain: string,
    nonce: string,
    response: SignedFederationIdentity,
    preUpgradeKeys: string[],
    initializeCursors: boolean,
  ): Promise<void> {
    const doc = await this.discovery.fetchWellKnown(peerDomain);
    const rootPublicKey = doc.rootKey?.ed25519;
    const computedFingerprint = rootPublicKey
      ? `sha256:${createHash('sha256')
          .update(Buffer.from(rootPublicKey, 'base64'))
          .digest('base64url')}`
      : undefined;
    if (
      selectFederationProtocolVersion(doc.protocolVersions) !==
        FEDERATION_PROTOCOL_VERSION ||
      doc.rootKey?.fingerprint !== response.rootKeyFingerprint ||
      computedFingerprint !== response.rootKeyFingerprint ||
      doc.keys.length !== 1 ||
      doc.keys[0]?.ed25519 !== rootPublicKey
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
        `well-known identity does not match response from ${peerDomain}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const signingKey = doc.keys.find((key) => key.keyId === response.keyId);
    if (!signingKey) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
        `identity response key is not published by ${peerDomain}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const claim = this.federationIdentity.verifySignedClaim(
      response,
      peerDomain,
      this.config.domain,
      nonce,
      Uint8Array.from(Buffer.from(signingKey.ed25519, 'base64')),
    );
    await this.discovery.cacheKeys(peerDomain, doc.keys);
    const legacyContinuityProven =
      rootPublicKey !== undefined && preUpgradeKeys.includes(rootPublicKey);
    if (initializeCursors) {
      if (claim.startChangeId === undefined) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
          `S2S init response from ${peerDomain} has no startChangeId`,
          HttpStatus.UNAUTHORIZED,
        );
      }
      await this.federationInit.pinResponse({
        domain: peerDomain,
        claim,
        legacyContinuityProven,
      });
    } else {
      await this.federationIdentity.pinOrVerify(
        peerDomain,
        claim,
        legacyContinuityProven,
      );
    }
  }

  /** POST /s2s/v1/call — deliver ONE ephemeral WebRTC call frame (ring / lifecycle / SDP-ICE relay)
   *  to the peer server hosting the call's other participant. Awaitable so the caller's `initiate` can
   *  detect a ring failure (→ the `unreachable` terminal bubble). The persisted CALL record rides the
   *  pull-based message sync, NOT this frame. `peerDomain` is the server hosting the foreign participant. */
  async sendCallFrame(
    params: OutboundCallFrameParams,
    peerDomain: string,
  ): Promise<void> {
    const queueKey = `${peerDomain}\u0000${params.callSid}`;
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
   *  not-found / not-friends rejects use HTTP 404 (NOT in postSigned's success- or demote-sets → the
   *  sender throws without demoting a healthy peer). */
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
      `${peerDomain}\u0000${body.callSid}`,
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
    const participants =
      await this.database.db.query.threadParticipant.findMany({
        where: eq(tables.threadParticipant.threadId, threadId),
        with: {
          user: { columns: { account: true, domain: true, isForeigner: true } },
        },
      });
    const local = participants.find((p) => p.userId === localUserId);
    const peer = participants.find((p) => p.userId !== localUserId);
    if (!local || local.leftAt !== null || !peer || peer.leftAt !== null) {
      throw new BusinessException(BusinessCode.FRIEND_NOT_FOUND, 'not friends');
    }
    void peer;
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
   * demoted/blocked peer is caught up front (not only after a failure). The op itself (sendSignedPost
   * / getSigned) already calls markDemoted on failure → self-heal on the next reconnect-sweep tick.
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
      // A peer restart can make both sides demote each other: its startup pull reaches us while we
      // still have it demoted, so it receives FEDERATION_PEER_NOT_TRUSTED and demotes us in turn.
      // Only this explicit trust-state response is recoverable here. The pinned-identity signed
      // heartbeat restores mutual reachability, after which the original operation is tried once.
      // Other 401/403 responses (bad signatures, identity changes, admin policy) remain terminal.
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.FEDERATION_PEER_NOT_TRUSTED
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
        state.trustLevel === 'reset_in_progress' ||
        state.trustLevel === 'identity_lost'
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          `federation thread ${threadId} is unavailable for ${peerDomain}`,
          HttpStatus.LOCKED,
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
      state.trustLevel === 'reset_in_progress' ||
      state.trustLevel === 'identity_lost'
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation response for thread ${threadId} from ${peerDomain}`,
        HttpStatus.LOCKED,
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
        resetGeneration: number;
        rootKeyFingerprint: string | null;
      }>(sql`
        SELECT peer."trustLevel",
               COALESCE(reset."resetGeneration", 0)::int AS "resetGeneration",
               peer."rootKeyFingerprint"
        FROM "FederatedPeer" peer
        LEFT JOIN "FederatedPeerReset" reset ON reset.domain = peer.domain
        WHERE peer.domain = ${domain}
      `);
      const state = result.rows[0];
      if (
        !state ||
        state.trustLevel !== 'trusted' ||
        !state.rootKeyFingerprint
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          `federation peer ${domain} is unavailable`,
          HttpStatus.LOCKED,
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
      resetGeneration: number;
      rootKeyFingerprint: string | null;
    }>(sql`
      SELECT peer."trustLevel",
             COALESCE(reset."resetGeneration", 0)::int AS "resetGeneration",
             peer."rootKeyFingerprint"
      FROM "FederatedPeer" peer
      LEFT JOIN "FederatedPeerReset" reset ON reset.domain = peer.domain
      WHERE peer.domain = ${token.domain}
    `);
    const state = result.rows[0];
    if (
      !state ||
      state.trustLevel !== 'trusted' ||
      state.resetGeneration !== token.resetGeneration ||
      state.rootKeyFingerprint !== token.rootKeyFingerprint
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `stale federation response from ${token.domain}`,
        HttpStatus.LOCKED,
      );
    }
  }

  /** Lightweight, ephemeral discovery wake-up. The receiver never persists this advertised HWM. */
  async pushDiscoveryHwm(domain: string): Promise<void> {
    // Startup/reconnect and state-only wake-ups are also reconstruction backstops. Fill before reading
    // the HWM so a message committed just before a crash is advertised after the new process rebuilds.
    await this.memoryMessageFeed?.fill(domain);
    const allocatedThrough =
      await this.federationCursor.readAllocatedThrough(domain);
    const stateFeedRev =
      await this.database.db.query.peerStateFeedTarget.findFirst({
        where: eq(tables.peerStateFeedTarget.peerDomain, domain),
        columns: { allocatedThrough: true },
      });
    await this.postSigned(
      '/s2s/v1/feed-revisions',
      JSON.stringify({
        origin: this.config.domain,
        stateFeedRev: (stateFeedRev?.allocatedThrough ?? 0n).toString(),
        messageFeedRev: allocatedThrough.toString(),
      }),
      domain,
    );
  }

  async pullStateFeedPage(
    domain: string,
    after: bigint,
    take = 100,
  ): Promise<PeerStateFeedPage> {
    if (after < 0n || !Number.isInteger(take) || take < 1 || take > 200)
      throw new Error('invalid state feed cursor/page size');
    return this.withTrustedPeer(domain, () =>
      this.getSigned<PeerStateFeedPage>(
        `/s2s/v1/state-feed?after=${after.toString()}&take=${take}`,
        domain,
        16 * 1024 * 1024,
      ),
    );
  }

  /** State is always drained before callers start message-feed. Each page and its cursor commit together. */
  pullStateFromPeer(domain: string): Promise<void> {
    const changed = new WeakMap<PeerStateFeedPage, StatePageEffect>();
    return this.stateFeedPull.run(domain, {
      fetch: (after) => this.pullStateFeedPage(domain, after),
      apply: async (tx, page) => {
        changed.set(page, await this.applyStateFeedPageInTx(tx, domain, page));
      },
      afterCommit: async (page) => {
        const effect = changed.get(page) ?? {
          revisions: [],
          statePushDomains: [],
          localSystemMessages: [],
        };
        for (const pending of effect.revisions)
          this.threadRevisionService.notifyThreadRevision(pending);
        await this.pushStateFeedDomains(effect.statePushDomains);
        for (const status of effect.localSystemMessages)
          await this.publishLocalSystemMessage(status);
      },
    });
  }

  private async applyStateFeedPageInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    page: PeerStateFeedPage,
  ): Promise<StatePageEffect> {
    const changed: PendingThreadRevision[] = [];
    const statePushDomains: string[] = [];
    const localSystemMessages: StatePageEffect['localSystemMessages'] = [];
    // GROUP_META materializes the roster stubs that relayed member PROFILE snapshots target. The pull
    // layer already validated wire rev ordering, so snapshot application may safely use dependency order.
    const applyPriority = {
      GROUP_META: 0,
      PROFILE: 1,
      GROUP_INVITE_INTENT: 2,
      GROUP_JOIN_INTENT: 2,
      P2P_META: 3,
    } as const;
    for (const item of [...page.items].sort(
      (a, b) => applyPriority[a.eventType] - applyPriority[b.eventType],
    )) {
      if (!item.body || typeof item.body !== 'object')
        throw new Error('invalid state feed body');
      const revision = Number(BigInt(item.revision));
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new Error('state revision exceeds local range');
      if (item.eventType === 'PROFILE') {
        if (item.subjectAccount !== '')
          throw new Error('PROFILE subject must be empty');
        const body = item.body as {
          name?: unknown;
          bio?: unknown;
          domain?: unknown;
          avatar?: unknown;
          deleted?: unknown;
        };
        if (
          typeof body.name !== 'string' ||
          typeof body.bio !== 'string' ||
          typeof body.domain !== 'string' ||
          typeof body.deleted !== 'boolean'
        )
          throw new Error('invalid PROFILE body');
        if (body.domain === this.config.domain) continue;
        let [stub] = await tx
          .select({
            id: tables.user.id,
            remoteProfileRev: tables.user.remoteProfileRev,
          })
          .from(tables.user)
          .where(
            and(
              eq(tables.user.account, item.account),
              eq(tables.user.domain, body.domain),
            ),
          )
          .limit(1);
        if (!stub && body.domain === peerDomain) {
          const [created] = await tx
            .insert(tables.user)
            .values({
              account: normalizeAccount(item.account),
              name: body.name,
              avatar: '',
              bio: body.bio,
              isForeigner: true,
              isGroup: item.account.startsWith('!'),
              domain: body.domain,
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
                eq(tables.user.domain, body.domain),
              ),
              columns: { id: true, remoteProfileRev: true },
            }));
        }
        if (!stub || (stub.remoteProfileRev ?? -1) >= revision) continue;
        if (body.domain !== peerDomain) {
          const authorized = await tx.execute<{ allowed: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1
              FROM "ThreadParticipant" member
              JOIN "MessageThread" thread ON thread.id = member."threadId" AND thread.type = 'GROUP'
              JOIN "User" group_u ON group_u.id = thread."groupUserId"
              WHERE member."userId" = ${stub.id} AND member."leftAt" IS NULL
                AND group_u.domain = ${peerDomain}
            ) AS allowed
          `);
          if (!authorized.rows[0]?.allowed)
            throw new Error(
              'PROFILE relay is not authorized by an origin group',
            );
        }
        let avatar: string | undefined;
        if (body.avatar === null) avatar = '';
        else {
          const wire = body.avatar as {
            digest?: unknown;
            mimeType?: unknown;
            base64?: unknown;
          };
          if (
            !wire ||
            typeof wire.digest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(wire.digest) ||
            typeof wire.mimeType !== 'string' ||
            typeof wire.base64 !== 'string'
          )
            throw new Error('invalid PROFILE avatar');
          const bytes = Buffer.from(wire.base64, 'base64');
          if (
            bytes.toString('base64') !== wire.base64 ||
            createHash('sha256').update(bytes).digest('hex') !== wire.digest
          )
            throw new Error('PROFILE avatar digest mismatch');
          avatar = await this.upload.saveAvatars(bytes);
        }
        await tx
          .update(tables.user)
          .set({
            name: body.name,
            bio: body.bio,
            avatar,
            isDeleted: body.deleted,
            remoteProfileRev: revision,
            updatedAt: new Date(),
          })
          .where(eq(tables.user.id, stub.id));
        const consumers = await tx.execute<{ userId: number }>(sql`
          SELECT DISTINCT local_p."userId"
          FROM "ThreadParticipant" foreign_p
          JOIN "ThreadParticipant" local_p ON local_p."threadId" = foreign_p."threadId"
          JOIN "User" local_u ON local_u.id = local_p."userId"
          WHERE foreign_p."userId" = ${stub.id} AND foreign_p."leftAt" IS NULL
            AND local_p."leftAt" IS NULL AND local_u."isForeigner" = false
        `);
        changed.push(
          ...(await this.threadRevisionService.recordProfileStateInTx(
            tx,
            stub.id,
            consumers.rows.map((row) => row.userId),
          )),
        );
        const relayed = await this.relayGroupMemberProfileInTx(tx, {
          sourcePeerDomain: peerDomain,
          account: item.account,
          domain: body.domain,
          revision,
          body: item.body as PeerStateBody,
          userId: stub.id,
        });
        statePushDomains.push(...relayed.keys());
      } else if (item.eventType === 'P2P_META') {
        const body = item.body as {
          status?: unknown;
          note?: unknown;
          requestedAt?: unknown;
          expiresAt?: unknown;
        };
        if (
          !item.subjectAccount ||
          !['REQUESTED', 'FRIEND', 'NOT_FRIEND'].includes(
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
          (body.status !== 'REQUESTED' && body.expiresAt !== null)
        )
          throw new Error('invalid P2P_META body');
        const requestedAt =
          typeof body.requestedAt === 'number'
            ? new Date(body.requestedAt)
            : null;
        const expiresAt =
          typeof body.expiresAt === 'number' ? new Date(body.expiresAt) : null;
        if (
          (requestedAt && Number.isNaN(requestedAt.getTime())) ||
          (expiresAt && Number.isNaN(expiresAt.getTime()))
        )
          throw new Error('invalid P2P_META request timestamps');
        const [localUser] = await tx
          .select({ id: tables.user.id, account: tables.user.account })
          .from(tables.user)
          .where(
            and(
              eq(tables.user.account, normalizeAccount(item.subjectAccount)),
              eq(tables.user.isForeigner, false),
            ),
          )
          .limit(1);
        const [remoteUser] = await tx
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
          throw new Error('P2P_META local subject does not exist');
        if (!remoteUser) throw new Error('P2P_META arrived without PROFILE');
        const effect = await this.invite.applyRemoteFriendIntentInTx(tx, {
          localUserId: localUser.id,
          peerUserId: remoteUser.id,
          status: body.status as 'REQUESTED' | 'FRIEND' | 'NOT_FRIEND',
          note: body.note,
          revision,
          requestedAt,
          expiresAt,
          origin: peerDomain,
        });
        if (effect.localStateRevision !== undefined) {
          const localDirection = await tx.query.friendRequest.findFirst({
            where: and(
              eq(tables.friendRequest.requesterUserId, localUser.id),
              eq(tables.friendRequest.targetUserId, remoteUser.id),
            ),
            columns: {
              status: true,
              note: true,
              requestedAt: true,
              expiresAt: true,
              revision: true,
            },
          });
          if (!localDirection)
            throw new Error('local friend state disappeared');
          const confirmation = await this.stateFeed.writeManyInTx(tx, [
            {
              peerDomain,
              account: localUser.account,
              subjectAccount: remoteUser.account,
              eventType: 'P2P_META',
              revision: localDirection.revision,
              body: {
                status: localDirection.status,
                note: localDirection.note,
                requestedAt: localDirection.requestedAt,
                expiresAt: localDirection.expiresAt,
              },
            },
          ]);
          statePushDomains.push(...confirmation.keys());
        }
        if (effect.requestCreated) {
          changed.push({
            userId: localUser.id,
            revision:
              await this.threadRevisionService.recordFriendRequestStateInTx(
                tx,
                localUser.id,
              ),
          });
        }
        if (effect.threadId !== undefined && effect.added !== undefined) {
          changed.push({
            userId: localUser.id,
            revision: effect.added
              ? await this.threadRevisionService.recordThreadAddInTx(
                  tx,
                  localUser.id,
                  effect.threadId,
                )
              : await this.threadRevisionService.recordThreadDeleteInTx(
                  tx,
                  localUser.id,
                  effect.threadId,
                ),
          });
        }
        if (effect.threadId !== undefined && effect.added === true) {
          localSystemMessages.push({
            actorUserId: localUser.id,
            threadId: effect.threadId,
            type: SystemMessageType.FRIEND_ADDED,
          });
        } else if (effect.threadId !== undefined && effect.removed === true) {
          localSystemMessages.push({
            actorUserId: remoteUser.id,
            threadId: effect.threadId,
            type: SystemMessageType.FRIEND_REMOVED,
            subjectUserId: localUser.id,
          });
        }
      } else if (
        item.eventType === 'GROUP_INVITE_INTENT' ||
        item.eventType === 'GROUP_JOIN_INTENT'
      ) {
        if (!item.account.startsWith('!') || !item.subjectAccount)
          throw new Error('invalid group membership state key');
        const body = item.body as {
          status?: unknown;
          note?: unknown;
          requestedAt?: unknown;
          expiresAt?: unknown;
          owner?: unknown;
          sinceSeq?: unknown;
        };
        const owner = body.owner as
          | { account?: unknown; domain?: unknown }
          | undefined;
        if (
          !['REQUESTED', 'MEMBER', 'NOT_MEMBER'].includes(
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
          (item.eventType === 'GROUP_INVITE_INTENT' &&
            (!owner ||
              typeof owner.account !== 'string' ||
              typeof owner.domain !== 'string' ||
              !Number.isSafeInteger(body.sinceSeq) ||
              Number(body.sinceSeq) < -1))
        )
          throw new Error('invalid group membership state body');
        const inviteDirection = item.eventType === 'GROUP_INVITE_INTENT';
        const [groupUser] = await tx
          .select({ id: tables.user.id })
          .from(tables.user)
          .where(
            and(
              eq(tables.user.account, normalizeAccount(item.account)),
              inviteDirection
                ? eq(tables.user.domain, peerDomain)
                : eq(tables.user.isForeigner, false),
              eq(tables.user.isGroup, true),
            ),
          )
          .limit(1);
        const [member] = await tx
          .select({ id: tables.user.id })
          .from(tables.user)
          .where(
            and(
              eq(tables.user.account, normalizeAccount(item.subjectAccount)),
              inviteDirection
                ? eq(tables.user.isForeigner, false)
                : eq(tables.user.domain, peerDomain),
              eq(tables.user.isGroup, false),
            ),
          )
          .limit(1);
        if (!groupUser || !member)
          throw new Error('group membership state arrived before profiles');
        const membership =
          await this.groupMembershipState.applyRemoteDirectionInTx(tx, {
            groupUserId: groupUser.id,
            memberUserId: member.id,
            direction: inviteDirection ? 'INVITE' : 'JOIN',
            status: body.status as 'REQUESTED' | 'MEMBER' | 'NOT_MEMBER',
            note: body.note,
            revision,
            requestedAt:
              typeof body.requestedAt === 'number'
                ? new Date(body.requestedAt)
                : null,
            expiresAt:
              typeof body.expiresAt === 'number'
                ? new Date(body.expiresAt)
                : null,
          });
        if (inviteDirection && membership.changed)
          await this.ensureGroupInviteMirrorInTx(tx, {
            groupUserId: groupUser.id,
            memberUserId: member.id,
            owner: owner as { account: string; domain: string },
            peerDomain,
            sinceSeq: body.sinceSeq as number,
            status: body.status as 'REQUESTED' | 'MEMBER' | 'NOT_MEMBER',
            note: body.note,
            expiresAt:
              typeof body.expiresAt === 'number'
                ? new Date(body.expiresAt)
                : null,
          });
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
            await assertServerGroupCapacityInTx(tx, originThread.id, member.id);
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
            await this.groupMembershipState.setPairActiveInTx(
              tx,
              groupUser.id,
              member.id,
              false,
            );
            const rejection = await this.writeGroupInviteIntentInTx(
              tx,
              originThread.id,
              member.id,
              SERVER_GROUP_FULL_REASON,
              false,
            );
            await tx
              .update(tables.group)
              .set({ rosterRev: sql`${tables.group.rosterRev} + 1` })
              .where(eq(tables.group.groupUserId, groupUser.id));
            const groupState = await this.writeGroupStateInTx(
              tx,
              originThread.id,
              [peerDomain],
            );
            statePushDomains.push(...rejection.keys(), ...groupState.keys());
            this.logger.warn(
              `Rejected federated group join for ${item.subjectAccount}@${peerDomain}: origin group is full`,
            );
            continue;
          }
          await this.groupMembershipState.setPairActiveInTx(
            tx,
            groupUser.id,
            member.id,
            true,
          );
          // The origin may still consider this member active when a mirror
          // compacts an unobserved leave followed immediately by a rejoin.
          // Re-emit the authoritative roster for every new JOIN revision even
          // when the pair itself needs no transition, otherwise that mirror
          // would wait forever for confirmation.
          await this.participantService.upsertMemberInTx(
            tx,
            originThread.id,
            member.id,
            GroupRole.MEMBER,
          );
          await tx
            .insert(tables.threadAudience)
            .values({
              targetDomain: peerDomain,
              localUserId: null,
              threadId: originThread.id,
            })
            .onConflictDoUpdate({
              target: [
                tables.threadAudience.targetDomain,
                tables.threadAudience.threadId,
              ],
              targetWhere: sql`${tables.threadAudience.targetDomain} <> 'local'`,
              set: { deliverThroughChangeId: null },
            });
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
          const groupState = await this.writeGroupStateInTx(
            tx,
            originThread.id,
          );
          const profiles = await this.writeGroupMemberProfilesInTx(
            tx,
            originThread.id,
          );
          statePushDomains.push(...groupState.keys(), ...profiles.keys());
        } else if (
          !inviteDirection &&
          membership.changed &&
          body.status === 'NOT_MEMBER'
        ) {
          const [originThread] = await tx
            .select({ id: tables.messageThread.id })
            .from(tables.messageThread)
            .where(eq(tables.messageThread.groupUserId, groupUser.id))
            .for('update')
            .limit(1);
          if (!originThread) throw new Error('origin group thread missing');
          const deactivated = await this.groupMembershipState.setPairActiveInTx(
            tx,
            groupUser.id,
            member.id,
            false,
          );
          if (!deactivated) continue;
          localSystemMessages.push({
            actorUserId: member.id,
            threadId: originThread.id,
            type: SystemMessageType.GROUP_LEFT,
            subjectUserId: member.id,
          });
          await tx
            .update(tables.threadParticipant)
            .set({ leftAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(tables.threadParticipant.threadId, originThread.id),
                eq(tables.threadParticipant.userId, member.id),
                isNull(tables.threadParticipant.leftAt),
              ),
            );
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
              AND participant."leftAt" IS NULL
              AND member_u."isForeigner" = true
              AND member_u.domain = ${peerDomain}
          `);
          if ((peerMembers.rows[0]?.count ?? 0) === 0)
            await tx.execute(sql`
              UPDATE "ThreadAudience" audience
              SET "deliverThroughChangeId" = 0
              WHERE audience."targetDomain" = ${peerDomain}
                AND audience."localUserId" IS NULL
                AND audience."threadId" = ${originThread.id}
                AND audience."deliverThroughChangeId" IS NULL
            `);
          const groupState = await this.writeGroupStateInTx(
            tx,
            originThread.id,
            [peerDomain],
          );
          statePushDomains.push(...groupState.keys());
        }
      } else if (item.eventType === 'GROUP_META') {
        // Group application is handled only by the authoritative origin; malformed/non-origin keys fail
        // closed. Full roster replacement is connected below through the existing roster applier.
        if (!item.account.startsWith('!') || item.subjectAccount !== '')
          throw new Error('invalid GROUP_META key');
        const groupEffect = await this.applyGroupStateSnapshotInTx(
          tx,
          peerDomain,
          item.account,
          revision,
          item.body as Record<string, unknown>,
        );
        statePushDomains.push(...groupEffect.statePushDomains);
        localSystemMessages.push(...groupEffect.systemMessages);
        for (const { userId, active } of groupEffect.users) {
          changed.push({
            userId,
            revision: active
              ? await this.threadRevisionService.recordThreadAddInTx(
                  tx,
                  userId,
                  groupEffect.threadId,
                )
              : await this.threadRevisionService.recordThreadDeleteInTx(
                  tx,
                  userId,
                  groupEffect.threadId,
                ),
          });
        }
        // A newly active local member's profile must enter the outbound state
        // feed in the same transaction as the mirror roster. Otherwise a crash
        // after applying GROUP_META could permanently lose the profile relay.
        for (const userId of new Set(
          groupEffect.users
            .filter((effect) => effect.active)
            .map((effect) => effect.userId),
        )) {
          const profiles = await this.writeProfileStateInTx(tx, userId);
          statePushDomains.push(...profiles.keys());
        }
      } else throw new Error('unknown state feed event type');
    }
    return {
      revisions: changed,
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
  }): Promise<void> {
    const message = await this.message.tryWriteSystemMessage(
      status.actorUserId,
      status.threadId,
      status.type,
      status.subjectUserId,
    );
    if (!message) return;
    try {
      const recipients =
        await this.participantService.getActiveParticipantUserIds(
          status.threadId,
        );
      for (const recipient of recipients) {
        if (!recipient.blocked && recipient.userId !== status.actorUserId)
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

  /** A group origin relays a member's authoritative PROFILE snapshot to every other member server. */
  private async relayGroupMemberProfileInTx(
    tx: DatabaseTransaction,
    profile: {
      sourcePeerDomain: string;
      account: string;
      domain: string;
      revision: number;
      body: PeerStateBody;
      userId: number;
    },
  ): Promise<Map<string, bigint>> {
    const targets = await tx.execute<{ domain: string }>(sql`
      SELECT DISTINCT target_u.domain
      FROM "ThreadParticipant" subject_p
      JOIN "MessageThread" thread ON thread.id = subject_p."threadId" AND thread.type = 'GROUP'
      JOIN "User" group_u ON group_u.id = thread."groupUserId" AND group_u.domain = 'local'
      JOIN "ThreadParticipant" target_p ON target_p."threadId" = thread.id AND target_p."leftAt" IS NULL
      JOIN "User" target_u ON target_u.id = target_p."userId"
      WHERE subject_p."userId" = ${profile.userId} AND subject_p."leftAt" IS NULL
        AND target_u."isForeigner" = true AND target_u.domain <> ${profile.sourcePeerDomain}
    `);
    return this.stateFeed.writeManyInTx(
      tx,
      targets.rows.map(({ domain }) => ({
        peerDomain: domain,
        account: profile.account,
        eventType: 'PROFILE' as const,
        revision: profile.revision,
        body: profile.body,
      })),
    );
  }

  /** Materialize the inert mirror required to display and accept a GROUP→USER request. The invited
   * local user is deliberately not added to the roster here; only the origin's later GROUP_META may
   * activate membership. */
  private async ensureGroupInviteMirrorInTx(
    tx: DatabaseTransaction,
    params: {
      groupUserId: number;
      memberUserId: number;
      owner: { account: string; domain: string };
      peerDomain: string;
      sinceSeq: number;
      status: 'REQUESTED' | 'MEMBER' | 'NOT_MEMBER';
      note: string;
      expiresAt: Date | null;
    },
  ): Promise<number> {
    const ownerDomain =
      params.owner.domain === this.config.domain
        ? 'local'
        : params.owner.domain;
    let ownerUser = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(params.owner.account)),
        eq(tables.user.domain, ownerDomain),
      ),
      columns: { id: true },
    });
    if (!ownerUser && ownerDomain !== 'local') {
      const id = await this.ensureForeignUserInTransaction(
        tx,
        params.owner.account,
        params.owner.domain,
      );
      ownerUser = { id };
    }
    if (!ownerUser) throw new Error('group invite owner does not exist');

    let thread = await tx.query.messageThread.findFirst({
      where: eq(tables.messageThread.groupUserId, params.groupUserId),
      columns: { id: true },
    });
    if (!thread) {
      const [created] = await tx
        .insert(tables.messageThread)
        .values({
          type: MessageThreadType.GROUP,
          groupUserId: params.groupUserId,
          pullUntil: params.sinceSeq,
          updatedAt: new Date(),
        })
        .returning({ id: tables.messageThread.id });
      thread = created;
      await tx.insert(tables.group).values({
        groupUserId: params.groupUserId,
        ownerId: ownerUser.id,
        rosterRev: 0,
        updatedAt: new Date(),
      });
      await tx
        .insert(tables.threadParticipant)
        .values({
          userId: ownerUser.id,
          threadId: thread.id,
          role: GroupRole.OWNER,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    void params.memberUserId;
    void params.peerDomain;
    void params.status;
    void params.note;
    void params.expiresAt;
    return thread.id;
  }

  private async applyGroupStateSnapshotInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    account: string,
    revision: number,
    body: Record<string, unknown>,
  ): Promise<{
    threadId: number;
    users: Array<{ userId: number; active: boolean }>;
    statePushDomains: string[];
    systemMessages: StatePageEffect['localSystemMessages'];
  }> {
    const active = body.active;
    const dissolved = body.dissolved;
    const membersCanInvite = body.membersCanInvite;
    const owner = body.owner as
      | { account?: unknown; domain?: unknown }
      | undefined;
    const members = body.members;
    if (
      typeof active !== 'boolean' ||
      typeof dissolved !== 'boolean' ||
      (membersCanInvite !== undefined &&
        typeof membersCanInvite !== 'boolean') ||
      !owner ||
      typeof owner.account !== 'string' ||
      typeof owner.domain !== 'string' ||
      !Array.isArray(members)
    )
      throw new Error('invalid GROUP_META body');
    const [mirror] = await tx
      .select({
        groupUserId: tables.group.groupUserId,
        threadId: tables.messageThread.id,
        remoteRosterRev: tables.group.remoteRosterRev,
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
    if (!mirror || (mirror.remoteRosterRev ?? -1) >= revision)
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
    const activeBefore = await tx
      .select({
        userId: tables.threadParticipant.userId,
        role: tables.threadParticipant.role,
      })
      .from(tables.threadParticipant)
      .where(
        and(
          eq(tables.threadParticipant.threadId, mirror.threadId),
          isNull(tables.threadParticipant.leftAt),
        ),
      );
    const localBefore = await tx
      .select({ userId: tables.threadParticipant.userId })
      .from(tables.threadParticipant)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.threadParticipant.userId),
      )
      .where(
        and(
          eq(tables.threadParticipant.threadId, mirror.threadId),
          eq(tables.user.isForeigner, false),
        ),
      );
    const localJoinDirections = await tx
      .select({
        userId: tables.groupMembershipRequest.memberUserId,
        account: tables.user.account,
        status: tables.groupMembershipRequest.status,
      })
      .from(tables.groupMembershipRequest)
      .innerJoin(
        tables.user,
        eq(tables.user.id, tables.groupMembershipRequest.memberUserId),
      )
      .where(
        and(
          eq(tables.groupMembershipRequest.groupUserId, mirror.groupUserId),
          eq(tables.groupMembershipRequest.direction, 'JOIN'),
          eq(tables.user.isForeigner, false),
        ),
      );
    const desired = new Map<number, GroupRole>();
    const localDesired = new Set<number>();
    for (const raw of members) {
      const member = raw as {
        account?: unknown;
        domain?: unknown;
        role?: unknown;
      };
      if (
        typeof member.account !== 'string' ||
        typeof member.domain !== 'string' ||
        !Object.values(GroupRole).includes(member.role as GroupRole)
      )
        throw new Error('invalid GROUP_META member');
      let userId: number;
      if (member.domain === this.config.domain) {
        const [local] = await tx
          .select({ id: tables.user.id })
          .from(tables.user)
          .where(
            and(
              eq(tables.user.account, member.account),
              eq(tables.user.isForeigner, false),
            ),
          )
          .limit(1);
        if (!local) continue;
        userId = local.id;
        localDesired.add(userId);
      } else
        userId = await this.ensureForeignUserInTransaction(
          tx,
          member.account,
          member.domain,
        );
      if (desired.has(userId)) throw new Error('duplicate GROUP_META member');
      desired.set(userId, member.role as GroupRole);
      await this.participantService.upsertMemberInTx(
        tx,
        mirror.threadId,
        userId,
        member.role as GroupRole,
      );
    }
    const removed = activeBefore
      .filter((row) => !desired.has(row.userId))
      .map((row) => row.userId);
    if (removed.length)
      await tx
        .update(tables.threadParticipant)
        .set({ leftAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(tables.threadParticipant.threadId, mirror.threadId),
            inArray(tables.threadParticipant.userId, removed),
          ),
        );
    const ownerDomain =
      owner.domain === this.config.domain ? 'local' : owner.domain;
    const [ownerUser] = await tx
      .select({ id: tables.user.id })
      .from(tables.user)
      .where(
        and(
          eq(tables.user.account, owner.account),
          eq(tables.user.domain, ownerDomain),
        ),
      )
      .limit(1);
    if (!ownerUser) throw new Error('GROUP_META owner is missing');
    await tx
      .update(tables.group)
      .set({
        ownerId: ownerUser.id,
        membersCanInvite: membersCanInvite ?? true,
        remoteRosterRev: revision,
        dissolvedAt: dissolved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(tables.group.groupUserId, mirror.groupUserId));
    if (!active)
      await tx
        .update(tables.threadParticipant)
        .set({ leftAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(tables.threadParticipant.threadId, mirror.threadId),
            isNull(tables.threadParticipant.leftAt),
          ),
        );
    const affectedLocalUsers = new Set([
      ...localBefore.map((row) => row.userId),
      ...localDesired,
      ...localJoinDirections.map((row) => row.userId),
    ]);
    const systemMessages = deriveLocalGroupSystemEvents(
      activeBefore,
      [...desired].map(([userId, role]) => ({ userId, role })),
      mirror.ownerId,
      ownerUser.id,
    ).map((event) => ({
      ...event,
      threadId: mirror.threadId,
    }));
    const statePushDomains: string[] = [];
    for (const userId of affectedLocalUsers) {
      const localDirection = localJoinDirections.find(
        (row) => row.userId === userId,
      );
      const locallyRejected = localDirection?.status === 'NOT_MEMBER';
      const isActive = active && localDesired.has(userId) && !locallyRejected;
      if (!isActive && localDirection?.status === 'REQUESTED')
        await tx
          .update(tables.groupMembershipRequest)
          .set({ status: 'NOT_MEMBER', updatedAt: new Date() })
          .where(
            and(
              eq(tables.groupMembershipRequest.groupUserId, mirror.groupUserId),
              eq(tables.groupMembershipRequest.memberUserId, userId),
              eq(tables.groupMembershipRequest.direction, 'JOIN'),
              eq(tables.groupMembershipRequest.status, 'REQUESTED'),
            ),
          );
      if (locallyRejected && active && localDesired.has(userId)) {
        const [refreshed] = await tx
          .update(tables.groupMembershipRequest)
          .set({
            revision: sql`${tables.groupMembershipRequest.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tables.groupMembershipRequest.groupUserId, mirror.groupUserId),
              eq(tables.groupMembershipRequest.memberUserId, userId),
              eq(tables.groupMembershipRequest.direction, 'JOIN'),
              eq(tables.groupMembershipRequest.status, 'NOT_MEMBER'),
            ),
          )
          .returning({ revision: tables.groupMembershipRequest.revision });
        if (refreshed && localDirection) {
          const allocated = await this.stateFeed.writeManyInTx(tx, [
            {
              peerDomain,
              account,
              subjectAccount: localDirection.account,
              eventType: 'GROUP_JOIN_INTENT',
              revision: refreshed.revision,
              body: {
                status: 'NOT_MEMBER',
                note: '',
                requestedAt: null,
                expiresAt: null,
              },
            },
          ]);
          statePushDomains.push(...allocated.keys());
        }
      }
      await this.groupMembershipState.setPairActiveInTx(
        tx,
        mirror.groupUserId,
        userId,
        isActive,
      );
      if (isActive)
        await tx
          .insert(tables.threadAudience)
          .values({
            targetDomain: 'local',
            localUserId: userId,
            threadId: mirror.threadId,
          })
          .onConflictDoUpdate({
            target: [
              tables.threadAudience.targetDomain,
              tables.threadAudience.localUserId,
              tables.threadAudience.threadId,
            ],
            targetWhere: sql`${tables.threadAudience.targetDomain} = 'local'`,
            set: { deliverThroughChangeId: null },
          });
      else
        await tx
          .update(tables.threadParticipant)
          .set({ leftAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(tables.threadParticipant.threadId, mirror.threadId),
              eq(tables.threadParticipant.userId, userId),
              isNull(tables.threadParticipant.leftAt),
            ),
          );
      if (!isActive)
        await tx.execute(sql`
          UPDATE "ThreadAudience" audience
          SET "deliverThroughChangeId" = 0
          WHERE audience."targetDomain" = 'local'
            AND audience."localUserId" = ${userId}
            AND audience."threadId" = ${mirror.threadId}
            AND audience."deliverThroughChangeId" IS NULL
        `);
    }
    return {
      threadId: mirror.threadId,
      users: [...affectedLocalUsers].map((userId) => ({
        userId,
        active:
          active &&
          desired.has(userId) &&
          localJoinDirections.find((row) => row.userId === userId)?.status !==
            'NOT_MEMBER',
      })),
      statePushDomains,
      systemMessages,
    };
  }

  /**
   * Fetch one durable discovery page. The peer token is captured before the network request and must
   * be checked by the page applier in the same transaction that advances remoteHwm. This is the
   * peer-wide counterpart of getSignedForThread's federationVersion fence: a reset or identity change
   * while GET /missed is in flight makes the returned token stale and the complete page is discarded.
   */
  async pullMissedPage(
    domain: string,
    after: bigint,
    take = 100,
  ): Promise<{ page: FederationMessageFeedPage; token: PeerResponseToken }> {
    if (after < 0n) throw new Error('missed cursor must be non-negative');
    if (!Number.isInteger(take) || take < 1 || take > 200) {
      throw new Error('missed page size must be an integer from 1 to 200');
    }
    const token = await this.capturePeerResponseToken(domain);
    let page: FederationMessageFeedPage;
    try {
      page = await this.withTrustedPeer(domain, () =>
        this.getSigned<FederationMessageFeedPage>(
          `/s2s/v1/message-feed?after=${after.toString()}&take=${take}`,
          domain,
          16 * 1024 * 1024,
        ),
      );
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.FEDERATION_MISSED_CURSOR_INVALID
      ) {
        const data = error.data as
          | {
              startChangeId?: unknown;
              availableCursor?: unknown;
              allocatedThrough?: unknown;
            }
          | undefined;
        const parse = (value: unknown): bigint | null =>
          typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
            ? BigInt(value)
            : null;
        const startChangeId = parse(data?.startChangeId);
        const availableCursor = parse(data?.availableCursor);
        const allocatedThrough = parse(data?.allocatedThrough);
        if (
          startChangeId !== null &&
          availableCursor !== null &&
          allocatedThrough !== null
        ) {
          throw new RemoteMessageFeedCursorResetError(
            startChangeId,
            availableCursor,
            allocatedThrough,
          );
        }
      }
      throw error;
    }
    return { page, token };
  }

  /** Drain one peer's durable global feed. Per-page tokens/effects are kept only for the lifetime of
   * this run; the durable cursor and staged messages remain the crash-recovery truth. */
  pullMissedFromPeer(
    missedPull: FederationMessageFeedPullService,
    domain: string,
  ): Promise<void> {
    const tokens = new WeakMap<FederationMessageFeedPage, PeerResponseToken>();
    const effects = new WeakMap<
      FederationMessageFeedPage,
      MissedPageEffect[]
    >();
    return missedPull.run(domain, {
      fetch: async (after) => {
        const pulled = await this.pullMissedPage(domain, after);
        tokens.set(pulled.page, pulled.token);
        return pulled.page;
      },
      apply: async (tx, page) => {
        const token = tokens.get(page);
        if (!token) throw new Error('missing federation response token');
        effects.set(
          page,
          await this.applyMissedPageInTransaction(tx, domain, page, token),
        );
      },
      afterCommit: async (page) => {
        try {
          await this.publishMissedPageEffects(domain, effects.get(page) ?? []);
        } catch (error) {
          // The page and remoteHwm are already durable. SSE is only a wake-up and pending downloads
          // remain retryable from their database rows, so a post-commit side-effect must never stop the
          // peer's cursor loop or cause the committed page to be requested as if it had rolled back.
          this.logger.warn(
            `post-commit missed effects failed for ${domain}: ${(error as Error).message}`,
          );
        } finally {
          tokens.delete(page);
          effects.delete(page);
        }
      },
    });
  }

  /** Apply one global /missed page inside the caller's cursor transaction. No network-visible side
   * effects happen here; the returned effects are published only after that transaction commits. */
  async applyMissedPageInTransaction(
    tx: DatabaseTransaction,
    domain: string,
    page: FederationMessageFeedPage,
    token: PeerResponseToken,
  ): Promise<MissedPageEffect[]> {
    await this.assertPeerResponseWritable(tx, token);
    const effects: MissedPageEffect[] = [];
    for (const [itemIndex, item] of page.messages.entries()) {
      const savepoint = `federation_message_${itemIndex}`;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
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
        if (
          !Number.isSafeInteger(item.originSeq) ||
          item.originSeq < 0 ||
          !Number.isSafeInteger(item.seq) ||
          item.seq < 0
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
        const originTime = new Date(item.createdAt);
        if (
          !Number.isFinite(item.createdAt) ||
          Number.isNaN(originTime.getTime())
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'missed message has invalid createdAt',
            HttpStatus.BAD_REQUEST,
          );
        }

        if (item.author.domain === this.config.domain) {
          const localSourceMessage = await tx.query.message.findFirst({
            where: and(
              eq(tables.message.threadId, route.threadId),
              eq(tables.message.creator, route.creatorId),
              eq(tables.message.seq, item.originSeq),
            ),
            columns: {
              id: true,
              originSeq: true,
              originServerTime: true,
            },
          });
          if (localSourceMessage) {
            if (
              localSourceMessage.originSeq === null &&
              localSourceMessage.originServerTime === null
            ) {
              await tx
                .update(tables.message)
                .set({
                  originSeq: item.originSeq,
                  originServerTime: originTime,
                })
                .where(eq(tables.message.id, localSourceMessage.id));
            } else if (
              localSourceMessage.originSeq !== item.originSeq ||
              localSourceMessage.originServerTime?.getTime() !==
                originTime.getTime()
            ) {
              this.logger.error(
                `refused to overwrite a conflicting self-authored message receipt: ${JSON.stringify(
                  {
                    messageId: localSourceMessage.id.toString(),
                    peerDomain: domain,
                    receiptOriginSeq: item.originSeq,
                    receiptOriginServerTime: originTime.toISOString(),
                    existingOriginSeq: localSourceMessage.originSeq,
                    existingOriginServerTime:
                      localSourceMessage.originServerTime?.toISOString() ??
                      null,
                  },
                )}`,
              );
            }
            continue;
          }
          this.logger.error(
            `self-authored missed message has no matching local source message: ${JSON.stringify(
              item,
            )}`,
          );
          continue;
        }
        const existingMessage = await tx.query.message.findFirst({
          where: and(
            eq(tables.message.threadId, route.threadId),
            eq(tables.message.creator, route.creatorId),
            eq(tables.message.originSeq, item.originSeq),
          ),
          columns: { id: true },
        });
        const existingPending = await tx.query.pendingMedia.findFirst({
          where: and(
            eq(tables.pendingMedia.threadId, route.threadId),
            eq(tables.pendingMedia.creatorId, route.creatorId),
            eq(tables.pendingMedia.originSeq, item.originSeq),
          ),
          columns: { id: true },
        });
        if (existingMessage || existingPending) continue;

        const incomingText =
          item.contentType === ContentType.PURE_TEXT
            ? parseTextMessageContent(item.content)
            : null;
        if (
          item.contentType === ContentType.PURE_TEXT &&
          (!incomingText ||
            Boolean(incomingText.quote) !== Boolean(item.quoteTarget))
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'invalid federated text quote',
            HttpStatus.BAD_REQUEST,
          );
        }
        this.assertMissedAssetDescriptors(item);

        let storedContent = item.content;
        if (item.contentType === ContentType.CALL) {
          const call = parseFederatedCallContent(item.content);
          const participantMatch =
            item.thread.type === 'P2P' &&
            item.thread.participants.some((participant) =>
              sameFederatedCallAddress(
                participant,
                call?.callee ?? {
                  account: '',
                  domain: '',
                },
              ),
            );
          if (
            !call ||
            item.thread.type !== 'P2P' ||
            !sameFederatedCallAddress(call.caller, item.author) ||
            !participantMatch ||
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
            ...(call.durationMs === undefined
              ? {}
              : { durationMs: call.durationMs }),
          });
        }

        let forwardCard: FederatedForwardCard | undefined;
        let forwardClosure: ForwardWireClosure | undefined;
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
            forwardCard.version !== 1 ||
            typeof forwardCard.bundleId !== 'string' ||
            !Array.isArray(forwardCard.summaryLines) ||
            forwardCard.summaryLines.length > 3
          ) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'invalid FORWARD card shape',
              HttpStatus.BAD_REQUEST,
            );
          }
          forwardClosure = await this.getSigned<ForwardWireClosure>(
            `/s2s/v1/forward-bundles/${encodeURIComponent(forwardCard.bundleId)}`,
            domain,
            FORWARD_MAX_WIRE_JSON_BYTES + 64 * 1024,
          );
        }

        const stored = await this.storePulledMessageInTransaction(tx, {
          threadId: route.threadId,
          creator: route.creatorId,
          fetchedFromDomain: domain,
          authorDomain: item.author.domain,
          message: {
            originSeq: item.originSeq,
            contentType: item.contentType,
            content: storedContent,
            ts: item.createdAt,
            quoteTarget: item.quoteTarget,
          },
          expectedFederationVersion: route.federationVersion,
          incomingText,
          forwardCard,
          forwardClosure,
          originTime,
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
            originSeq: item.originSeq,
            recipients: route.recipients,
            toAccount: route.toAccount,
            author: item.author,
            batchId: stored.batchId,
            restored: [],
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
        const restored =
          await this.threadRevisionService.restoreHiddenThreadsInTx(
            tx,
            route.threadId,
            route.recipients,
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
          originSeq: item.originSeq,
          recipients: route.recipients,
          toAccount: route.toAccount,
          author: item.author,
          message: stored.message,
          deletionId,
          restored,
          forwardClosure,
          remoteForwardBundleId: forwardCard?.bundleId,
        });
      } catch (error) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
        this.logger.error(
          `ignored invalid federated message: ${JSON.stringify({
            peerDomain: domain,
            changeId: item.changeId,
            author: item.author,
            thread: item.thread,
            reason: (error as Error).message,
          })}`,
          (error as Error).stack,
        );
      } finally {
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      }
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
            undefined,
            offset,
          ),
        ).catch(() => undefined);
        continue;
      }
      effect.restored.forEach((revision) =>
        this.threadRevisionService.notifyThreadRevision(revision),
      );
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
      if (
        effect.forwardClosure &&
        effect.remoteForwardBundleId &&
        !effect.message!.isDeleted
      ) {
        await this.localizeForwardAssets(
          effect.forwardClosure,
          domain,
          effect.remoteForwardBundleId,
          await this.resolveForwardAssetAuth(effect.message!),
        );
      }
    }
  }

  private assertMissedAssetDescriptors(
    item: FederationMessageFeedPage['messages'][number],
  ): void {
    const expected = new Set(extractDigests(item.content));
    const described = new Set<string>();
    for (const asset of item.assets) {
      if (
        !/^[a-f0-9]{64}$/.test(asset.digest) ||
        !/^(0|[1-9]\d*)$/.test(asset.bytes)
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'invalid missed asset descriptor',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (asset.status !== 'READY' || described.has(asset.digest)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'unavailable or duplicate missed asset descriptor',
          HttpStatus.BAD_REQUEST,
        );
      }
      described.add(asset.digest);
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

  private async resolveMissedThreadInTransaction(
    tx: DatabaseTransaction,
    item: FederationMessageFeedPage['messages'][number],
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
    if (item.thread.type === 'GROUP') {
      const isAuthoritativeOrigin = item.thread.domain === sourceDomain;
      const groupDomain =
        item.thread.domain === this.config.domain
          ? 'local'
          : item.thread.domain;
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
          AND group_user.domain = ${groupDomain}
          AND (
            author_participant."leftAt" IS NULL
            OR ${isAuthoritativeOrigin}
            OR (
              ${allowClosedGroupAuthor}
              AND EXISTS (
                SELECT 1 FROM "GroupMembershipRequest" membership
                WHERE membership."groupUserId" = thread."groupUserId"
                  AND membership."memberUserId" = ${creatorId}
                  AND membership.direction = 'JOIN'
                  AND membership.status = 'NOT_MEMBER'
              )
            )
          )
          AND EXISTS (
            SELECT 1 FROM "ThreadParticipant" local_participant
            JOIN "User" local_user ON local_user.id = local_participant."userId"
            WHERE local_participant."threadId" = thread.id
              AND local_user.domain = 'local'
              AND (
                local_participant."leftAt" IS NULL
                OR ${isAuthoritativeOrigin}
              )
          )
        LIMIT 1
        FOR SHARE OF thread, author_participant
      `);
      threadRows = result.rows;
    } else {
      const participants = item.thread.participants;
      const local = participants.find(
        (participant) => participant.domain === this.config.domain,
      );
      const selfAuthored = item.author.domain === this.config.domain;
      if (
        participants.length !== 2 ||
        !local ||
        (!selfAuthored && sourceDomain !== item.author.domain)
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
        JOIN "ThreadParticipant" author_participant
          ON author_participant."threadId" = thread.id
         AND author_participant."userId" = ${creatorId}
        JOIN "ThreadParticipant" local_participant
          ON local_participant."threadId" = thread.id
        JOIN "User" local_user ON local_user.id = local_participant."userId"
        WHERE thread.type = 'P2P'
          AND thread."federationTruncated" = false
          AND local_user.domain = 'local'
          AND local_user.account = ${normalizeAccount(local.account)}
          AND EXISTS (
            SELECT 1 FROM "FriendPair" pair
            WHERE pair."threadId" = thread.id
          )
        LIMIT 1
        FOR SHARE OF thread, author_participant, local_participant
      `);
      threadRows = result.rows;
    }
    const route = threadRows[0];
    if (!route) {
      throw new FederationMessageContextError(
        'missed message has no active local thread access',
      );
    }
    const recipientRows = await tx.execute<{ userId: number }>(sql`
      SELECT participant."userId"
      FROM "ThreadParticipant" participant
      JOIN "User" member ON member.id = participant."userId"
      WHERE participant."threadId" = ${route.threadId}
        AND (${item.thread.type === 'P2P'} OR participant."leftAt" IS NULL)
        AND member.domain = 'local'
      FOR SHARE OF participant
    `);
    return {
      ...route,
      creatorId,
      recipients: recipientRows.rows.map((row) => row.userId),
    };
  }

  /** Domains needing recovery (pending | demoted) — the reconnect sweep's work list. */
  async listRecoverablePeerDomains(): Promise<string[]> {
    const rows = await this.database.db.query.federatedPeer.findMany({
      where: inArray(tables.federatedPeer.trustLevel, ['pending', 'demoted']),
      columns: { domain: true },
    });
    return rows.map((r) => r.domain);
  }

  /** Trusted peers participating in startup and periodic global-HWM reconciliation. */
  async listTrustedPeerDomains(): Promise<string[]> {
    const rows = await this.database.db.query.federatedPeer.findMany({
      where: eq(tables.federatedPeer.trustLevel, 'trusted'),
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
        where: and(
          eq(tables.threadParticipant.threadId, trd.id),
          isNull(tables.threadParticipant.leftAt),
        ),
        with: {
          user: { columns: { account: true, domain: true, isForeigner: true } },
        },
      });
    const signerIsMember = participants.some(
      (p) => this.effectiveDomain(p.user) === signerDomain,
    );
    if (!signerIsMember) {
      throw new BusinessException(BusinessCode.FORBIDDEN, 'not a member');
    }
    let authorId: number | undefined;
    if (fromAccount && fromDomain) {
      const author = participants.find(
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
    forwardBundleId?: string,
  ): Promise<{ absPath: string; bytes: number }> {
    // Resource authorization is thread-audience based and deliberately independent from the ephemeral
    // lifetime of an in-memory feed reference. A retained/frozen audience may finish downloading resources
    // referenced by history after its feed changes have been acknowledged and garbage-collected.
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
          sql`COALESCE(${tables.message.originSeq}, ${tables.message.seq}) = ${sourceSeq}`,
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
    if (forwardBundleId) {
      const binding = await this.database.db.query.forwardMessage.findFirst({
        where: and(
          eq(tables.forwardMessage.messageId, sourceMessage.id),
          eq(tables.forwardMessage.bundleId, forwardBundleId),
        ),
        columns: { bundleId: true },
      });
      if (!binding) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'forward bundle is not bound to message',
        );
      }
      const closure = await this.forwardBundles.buildClosure(forwardBundleId);
      if (!closure.assets.some((asset) => asset.digest === digest)) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'digest not in forward bundle',
        );
      }
      return this.resolveCasFile(digest);
    }
    const binding = await this.database.db.query.messageAsset.findFirst({
      where: and(
        eq(tables.messageAsset.messageId, sourceMessage.id),
        eq(tables.messageAsset.digest, digest),
      ),
      columns: { messageId: true },
    });
    if (!binding) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'digest is not bound to message',
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
    const asset = await this.database.db.query.mediaAsset.findFirst({
      where: and(
        eq(tables.mediaAsset.digest, digest),
        eq(tables.mediaAsset.isDeleted, false),
      ),
      columns: { bytes: true },
    });
    if (!asset) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'file unavailable');
    }
    const absPath = join(
      process.cwd(),
      'data',
      'cas',
      digest.slice(0, 2),
      digest.slice(2, 4),
      digest,
    );
    try {
      const s = await stat(absPath);
      return { absPath, bytes: s.size };
    } catch {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'file unavailable');
    }
  }

  /** Shared authz prelude for authorized S2S media reads: proves
   *  `fromAccount` is a live local user (non-deleted), `toAccount` is the requester's foreign stub on
   *  signerDomain, and the from↔to Friendship is APPROVED — returning fromId + threadId. Throws NOT_FOUND
   *  (user missing) /
   *  FORBIDDEN (not friends); the 403 doubles as the §9.4 lazy-unfriend signal to the peer. Consolidates
   *  the same current P2P relationship required by message access. */
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
      // Gate 2 failed: no active P2P thread (not friends — e.g. after a local-only unfriend). The 403
      // is also the rejection that teaches the peer about the severed edge (§9.4).
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
    });
    const localMembers = await this.localActiveMemberIds(threadId);
    for (const userId of localMembers) {
      this.sse.onGroupEvent(userId, GROUP_SSE.GROUP_UPDATED, {
        groupId: threadId,
        threadId,
        dissolved: true,
      });
    }
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
          isNull(tables.threadParticipant.leftAt),
          eq(tables.user.isForeigner, false),
        ),
      );
    return rows.map((row) => row.userId);
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
      authorDomain: string;
      message: {
        originSeq: number;
        contentType: string;
        content: string;
        ts: number;
        quoteTarget?: S2SQuoteTarget;
      };
      expectedFederationVersion: number;
      incomingText: ReturnType<typeof parseTextMessageContent>;
      forwardCard?: FederatedForwardCard;
      forwardClosure?: ForwardWireClosure;
      originTime: Date;
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
      authorDomain,
      message: incoming,
      expectedFederationVersion,
      incomingText,
      forwardCard,
      forwardClosure,
      originTime,
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
      creatorId,
      incoming.originSeq,
    );
    const tombstone = await tx.query.federatedMessageTombstone.findFirst({
      where: and(
        eq(tables.federatedMessageTombstone.threadId, threadId),
        eq(tables.federatedMessageTombstone.creatorId, creatorId),
        eq(tables.federatedMessageTombstone.originSeq, incoming.originSeq),
      ),
      columns: { type: true },
    });

    // Media (non-deleted) is staged in PendingMedia + FileSyncProgress and promoted only after every
    // referenced file localizes (federation design doc §12). No seq/Message is allocated here — both
    // happen at promote time — so a not-yet-localized media message is invisible to receivers by design.
    if (
      !tombstone &&
      this.isMediaContentType(incoming.contentType as ContentType)
    ) {
      const batchId = randomUUID();
      const digests = extractDigestEntries(incoming.content);
      await tx.insert(tables.pendingMedia).values({
        threadId,
        creatorId,
        contentType: incoming.contentType as ContentType,
        content: incoming.content,
        originSeq: incoming.originSeq,
        direction: 'INBOUND',
        batchId,
        fileCnt: digests.length,
        originDomain: fetchedFromDomain,
        expectedFederationVersion,
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
            bytesTotal: BigInt(size ?? 0),
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
      storedContent = JSON.stringify({
        ...forwardCard,
        bundleId: localForwardBundleId,
      });
    }
    const [{ curSeq: seq }] = await tx
      .update(tables.messageThread)
      .set({ curSeq: sql`${tables.messageThread.curSeq} + 1` })
      .where(eq(tables.messageThread.id, threadId))
      .returning({ curSeq: tables.messageThread.curSeq });
    storedContent = contextualizeCasUrls(storedContent, threadId, seq);
    if (incomingText?.quote && incoming.quoteTarget) {
      const localQuoteSeq = await this.resolveLocalQuoteSeq(
        tx,
        threadId,
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
        originServerTime: originTime,
        isDeleted: tombstone !== undefined,
        updatedAt: new Date(),
      })
      .returning();
    if (tombstone) {
      await tx
        .insert(tables.deletedMessage)
        .values({
          threadId,
          seq,
          type: tombstone.type,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [tables.deletedMessage.threadId, tables.deletedMessage.seq],
        });
    }
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
        forwardClosure.bundles.length,
      );
    }
    return { kind: 'message', message, storedContent, localForwardBundleId };
  }

  private async resolveLocalQuoteSeq(
    tx: DatabaseTransaction,
    threadId: number,
    target: S2SQuoteTarget,
  ): Promise<number> {
    const candidates = await tx.query.user.findMany({
      where: eq(tables.user.account, normalizeAccount(target.creator.account)),
      columns: { id: true, domain: true, isForeigner: true },
    });
    const creator = candidates.find(
      (candidate) => this.effectiveDomain(candidate) === target.creator.domain,
    );
    if (!creator) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'quoted message creator is unknown',
        HttpStatus.BAD_REQUEST,
      );
    }
    const message = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.creator, creator.id),
        eq(tables.message.originSeq, target.originSeq),
      ),
      columns: { seq: true },
    });
    if (!message) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'quoted message is missing from the ordered pull stream',
        HttpStatus.BAD_REQUEST,
      );
    }
    return message.seq;
  }

  private async localizeForwardAssets(
    closure: ForwardWireClosure,
    peerDomain: string,
    remoteRootBundleId: string,
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
          asset.extension,
          (offset) =>
            this.fetchMediaChunks(
              peerDomain,
              asset.digest,
              authorization.fromAccount,
              authorization.fromDomain,
              authorization.toAccount,
              authorization.sourceSeq,
              remoteRootBundleId,
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
      t === ContentType.LINK ||
      t === ContentType.GALLERY
    );
  }

  /** Map an inbound message contentType to the FileSyncProgress kind (LINK's image counts as IMAGE;
   *  GALLERY's per-item rows are tagged BUNDLE — the per-item family lives in the message content). */
  private fileSyncKindFor(
    t: ContentType,
  ): 'IMAGE' | 'VIDEO' | 'FILE' | 'AUDIO' | 'BUNDLE' {
    switch (t) {
      case ContentType.IMAGE:
      case ContentType.LINK:
        return 'IMAGE';
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

  /**
   * Admin-driven retry of a stalled inbound media batch (design doc §12.7). Resets files frozen in
   * DOWNLOADING (a crashed driver) or FAILED back to PENDING, restores the admitted download route
   * persisted by global /missed (with a derivation fallback for legacy thread-pull batches), then
   * fire-and-forgets runFileSyncBatch. Returns the
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

    // Legacy thread-pull batches predate persisted route context. Keep the derivation fallback until
    // that transport is removed; new global /missed batches never depend on it.
    const creator = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, batch.creatorId),
      columns: { account: true, domain: true },
    });
    const thread = await this.database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, batch.threadId),
      columns: { groupUserId: true },
    });
    let toAccount: string | null = null;
    if (thread?.groupUserId != null) {
      const groupUser = await this.database.db.query.user.findFirst({
        where: eq(tables.user.id, thread.groupUserId),
        columns: { account: true },
      });
      toAccount = groupUser?.account ?? null;
    } else {
      const [localMember] = await this.database.db
        .select({ account: tables.user.account })
        .from(tables.threadParticipant)
        .innerJoin(
          tables.user,
          eq(tables.threadParticipant.userId, tables.user.id),
        )
        .where(
          and(
            eq(tables.threadParticipant.threadId, batch.threadId),
            isNull(tables.threadParticipant.leftAt),
            eq(tables.user.domain, 'local'),
          ),
        )
        .limit(1);
      toAccount = localMember?.account ?? null;
    }
    const fromAccount = persistedAuth?.fromAccount ?? creator?.account;
    const fromDomain = persistedAuth?.fromDomain ?? creator?.domain;
    toAccount = persistedAuth?.toAccount ?? toAccount;
    if (
      !fromAccount ||
      !fromDomain ||
      !toAccount ||
      !batch.originDomain ||
      batch.originSeq == null
    ) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        `cannot re-derive routing for batch ${batchId}`,
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
        undefined,
        offset,
      ),
    ).catch(() => undefined);

    return { batchId, resetFiles: reset.length };
  }

  /**
   * Promote a staged inbound media message into the Message table once every referenced file is
   * SUCCEEDED (§12.5). Replicates storePulledMessageInTransaction's direct-path work — seq allocation,
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
      await this.assertThreadResponseWritable(
        tx,
        threadId,
        batch.originDomain!,
        batch.expectedFederationVersion!,
      );
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        threadId,
        creatorId,
        originSeq,
      );
      const tombstone = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(tables.federatedMessageTombstone.threadId, threadId),
          eq(tables.federatedMessageTombstone.creatorId, creatorId),
          eq(tables.federatedMessageTombstone.originSeq, originSeq),
        ),
        columns: { type: true },
      });
      const [{ curSeq: seq }] = await tx
        .update(tables.messageThread)
        .set({ curSeq: sql`${tables.messageThread.curSeq} + 1` })
        .where(eq(tables.messageThread.id, threadId))
        .returning({ curSeq: tables.messageThread.curSeq });
      const storedContent = contextualizeCasUrls(batch.content, threadId, seq);
      const [message] = await tx
        .insert(tables.message)
        .values({
          contentType: batch.contentType as ContentType,
          content: storedContent,
          threadId,
          creator: creatorId,
          seq,
          originSeq,
          originServerTime: batch.createdAt,
          isDeleted: tombstone !== undefined,
          updatedAt: new Date(),
        })
        .returning();
      if (tombstone) {
        await tx
          .insert(tables.deletedMessage)
          .values({
            threadId,
            seq,
            type: tombstone.type,
            updatedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [tables.deletedMessage.threadId, tables.deletedMessage.seq],
          });
      } else {
        for (const digest of extractDigests(batch.content)) {
          await tx
            .insert(tables.messageAsset)
            .values({ messageId: message.id, threadId, digest })
            .onConflictDoNothing();
        }
      }
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
      const restored =
        await this.threadRevisionService.restoreHiddenThreadsInTx(
          tx,
          threadId,
          recipients,
        );
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
        restored,
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
      restored,
    } = promoted;
    restored.forEach((revision) =>
      this.threadRevisionService.notifyThreadRevision(revision),
    );
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
                undefined,
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
        root.sourceBundleId,
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
        isNull(tables.threadParticipant.leftAt),
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
   * Demote policy is STATUS-based (the fetch-throws-vs-body-abort proxy is unreliable at the header
   * boundary): a fetch rejection or 401/403/5xx → peer unreachable/rejecting → markDemoted + throw. A
   * 416 / other 4xx (non-auth) → throw WITHOUT demoting (offset wrong or file gone — not a trust
   * failure). A body-read error AFTER a 2xx → retry the same unit, NO demote (peer alive; lost a
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
    forwardBundleId?: string,
    startOffset = 0,
  ): AsyncGenerator<Buffer> {
    const chunkBytes = this.config.mediaChunkBytes;
    const base = await this.discovery.resolveBase(peerDomain);
    const params = new URLSearchParams({
      fromAccount,
      fromDomain,
      toAccount,
      seq: String(sourceSeq),
    });
    if (forwardBundleId) params.set('bundleId', forwardBundleId);
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
      // discards the partial buffer and re-requests the SAME range; NO demote (the peer already
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
          if (++retries > this.config.mediaMaxChunkRetries) {
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
   *  markDemoted for auth/transport failures — on
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
      res = await fetch(url, {
        method: 'GET',
        headers: { ...headers, range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(this.config.mediaChunkTimeoutSec * 1000),
      });
    } catch (e) {
      await this.markDemoted(
        peerDomain,
        `GET media network/timeout: ${(e as Error).message}`,
        operationStartedAt,
      );
      throw new Error(
        `S2S media from ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
      );
    }
    if (res.status === 200) {
      throw new Error('S2S media peer ignored required Range request');
    }
    if (res.status === 206) {
      const cr = res.headers.get('content-range') ?? '';
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (!m) {
        await this.markDemoted(
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
    // Auth/transport failures demote (peer unreachable / rejecting our signature); other 4xx (416/400/404)
    // fail this digest WITHOUT demoting (range/offset issue or file gone — not a trust failure).
    if (res.status === 401 || res.status === 403 || res.status >= 500) {
      await this.markDemoted(
        peerDomain,
        `GET media HTTP ${res.status}`,
        operationStartedAt,
      );
      throw new Error(
        `S2S media from ${peerDomain} rejected: HTTP ${res.status}`,
      );
    }
    throw new Error(
      `S2S media from ${peerDomain} HTTP ${res.status} (no demote)`,
    );
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
      `/s2s/v1/users/${address.account}`,
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
