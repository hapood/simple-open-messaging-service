import {
  Injectable,
  HttpStatus,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  mintUlid,
  normalizeAccount,
  isValidAccount,
  isValidGroupAccount,
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
import { isUniqueViolation } from '../database/database-error.js';
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
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { QuotaService } from '../quota/quota.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { InviteService } from '../invite/invite.service.js';
import { SseService, GROUP_SSE } from '../gateway/sse.service.js';
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';
import { derivePreview, MessageService } from '../message/message.service.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';
import {
  extractDigestEntries,
  extractDigests,
} from '../upload/file-content.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import { MEDIA_STATUS } from '../common/media-status.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import {
  FederationIdentityService,
  type SignedFederationIdentity,
} from './federation-identity.service.js';
import { FederationCursorService } from './federation-cursor.service.js';
import { FederationInitService } from './federation-init.service.js';
import type { FederationMissedPage } from './federation-missed.service.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import type { FederationMissedPullService } from './federation-missed-pull.service.js';
import { DiscoveryChangeService } from '../message/discovery-change.service.js';

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

/** Friend/group invite TTL (mirrors InviteService) — used for inbound friend invites. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A federated user address on the wire: two separate fields (account + domain). The `@` separator
 *  is a UI input convention ONLY — the browser splits a typed `alice@bbb.com` into these two fields
 *  before any API call; S2S payloads + endpoints + consumer DTOs never carry an `@`-joined string. */
export interface S2SAddress {
  account: string;
  domain: string;
}

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
 * A user's public profile as transmitted over S2S — the resolve endpoint (GET /api/v1/s2s/users/:account)
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

/** Shared envelope for a posted S2S op (plain JSON, RFC 9421 signed). `id` is an origin-assigned ULID —
 *  the idempotent-dedup key with `origin`. The discriminator is a FIELD on the concrete payload
 *  (`kind` / `op`), NOT the path: add-friend and add-group share `/s2s/invite`, mirroring the unified
 *  local Invite model. Cross-server MESSAGES do not use these bodies — they travel in the GET /messages
 *  response. */
interface S2SOpsBase {
  id: string; // origin-assigned ULID; dedup key with origin
  origin: string; // sending server's domain (== signer)
  ts: number; // ms since epoch
}

/** POST /api/v1/s2s/invite — deliver an invite (friend-add OR group-invite), unified. `kind`
 *  discriminates. FRIEND carries the sender's profile (stub localization); GROUP carries the group
 *  identity + a revision (the origin `!`-User.profileRev, Int) so the receiver's mirror update is
 *  revision-gated (no avatar re-localization when unchanged). The friend gate is `from`↔`to`. */
export interface S2SInvite extends S2SOpsBase {
  kind: 'FRIEND' | 'GROUP';
  from: S2SAddress; // inviter (local on the sender; foreign stub on the receiver)
  to: S2SAddress; // invitee (local on the receiver)
  note?: string; // ≤255-char invite message
  // FRIEND only — sender profile so the receiver creates the stub localized inline:
  profile?: S2SProfile;
  // GROUP only:
  group?: string; // the group's `!account` (== fedGroupAccount; the on-wire group address)
  groupName?: string;
  groupAvatar?: S2SAvatar | null;
  groupRevision?: number; // origin group !-User.profileRev (Int); gates the mirror avatar/name update
  owner?: S2SAddress; // group owner → foreign stub on the mirror (== from for an origin-create invite)
  sinceSeq?: number; // origin thread seq the invitee should start pulling from (-1 = full history; see below)
}

/** POST /api/v1/s2s/invite-accept — the recipient accepted an invite. FRIEND → the inviter's server
 *  creates the P2P thread (accept-wins); GROUP → the group ORIGIN adds the accepter to its roster +
 *  fans out a thread/member join. `inviteOriginId` correlates the sender's outgoing Invite. */
export interface S2SInviteAccept extends S2SOpsBase {
  kind: 'FRIEND' | 'GROUP';
  accepter: S2SAddress; // the user who accepted (local on the sender of THIS op)
  inviteOriginId?: string; // optional: the original invite's ULID (correlates the outgoing Invite)
  // FRIEND only — target = the inviter's domain:
  by?: S2SAddress;
  // GROUP only — target = the group ORIGIN domain:
  group?: string; // the group's `!account` (== fedGroupAccount)
}

/** POST /api/v1/s2s/invite-revoke — the original sender withdrew a still-pending FRIEND invite.
 * `inviteOriginId` is the shared correlation id stored on both servers. */
export interface S2SInviteRevoke extends S2SOpsBase {
  kind: 'FRIEND';
  from: S2SAddress;
  to: S2SAddress;
  inviteOriginId: string;
}

/** POST /api/v1/s2s/call — a federated 1:1 WebRTC call frame. Carries the EPHEMERAL realtime call
 *  signaling + lifecycle between two servers. The persisted CALL record is an ordinary Message that
 *  rides the existing pull-based sync — it needs NO frame. `op` discriminates:
 *    incoming              — the caller's server rings the callee's server
 *    accepted/declined/    — lifecycle transitions (the callee's side acted)
 *    cancelled/ended/missed
 *    signal                — an SDP/ICE relay frame (opaque, never persisted)
 *  `from` is always the RELAYING (signing) server's user → satisfies the guard's `from.domain ===
 *  signer` binding rule. No (origin, opId) dedup table: the receiver's in-memory call state machine +
 *  the callSid-keyed terminal bubble write (writeMsgToThread dedups on clientMessageId) make replays
 *  idempotent — a per-frame DB write would choke ICE candidate bursts. */
export type S2SCallOp =
  | 'incoming'
  | 'accepted'
  | 'ringing'
  | 'declined'
  | 'cancelled'
  | 'ended'
  | 'missed'
  | 'signal'
  | 'connected'
  | 'video-upgraded';

export interface S2SCallFrame extends S2SOpsBase {
  from: S2SAddress; // sender; from.domain === signer (binding rule)
  to: S2SAddress; // recipient; resolved to a local userId inbound
  callSid: string; // the call's idempotency key (== the terminal CALL bubble's clientMessageId)
  op: S2SCallOp;
  callType: 'AUDIO' | 'VIDEO';
  endReason?: string; // op==='ended' only → maps to the persisted CallOutcome (completed/failed)
  kind?: string; // op==='signal' only (the SDP/ICE frame kind)
  payload?: string; // op==='signal' only (opaque SDP/ICE — relayed verbatim, never persisted)
  // op==='connected' only: the real media-connect epoch-ms (the connect authority — NOT set on `accepted`,
  // which only means the callee answered / is negotiating). The origin stamps this verbatim.
  startedAt?: number;
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
 * user retries (the receiver dedupes via S2SFriendOpSeen, so retries are safe). Step 2 messages do NOT
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
export class FederationService implements OnModuleDestroy {
  private readonly config = loadFederationConfig();
  private readonly logger = new Logger(FederationService.name);
  /** Receiver-side debounce window: a group thread pulled within this skips a redundant whole-thread GET. */
  private static readonly GROUP_PULL_DEBOUNCE_MS = 500;
  /** Per-group-thread last pull timestamp (the receiver debounce on pullGroupWhole). */
  private readonly recentGroupPulls = new Map<number, number>();
  /** Serializes runFileSyncBatch per batchId so the fire-and-forget pull driver and an admin retry
   *  never double-drive the same batch (and never reach promote concurrently for one). */
  private readonly batchSyncLocks = new KeyedMutex();

  constructor(
    private readonly database: DatabaseService,
    private readonly signature: SignatureService,
    private readonly discovery: DiscoveryService,
    private readonly upload: UploadService,
    private readonly participantService: ThreadParticipantService,
    private readonly message: MessageService,
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
    private readonly federationInit: FederationInitService,
    private readonly downloadScheduler: FederationDownloadScheduler,
    private readonly discoveryChanges: DiscoveryChangeService = new DiscoveryChangeService(),
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
   * The single origin-hub routing + loop-safety entry. Computes the dest domain set for a new message,
   * then subtracts fetchedFromDomain (the domain the message was just pulled from — it already has it).
   * This one rule closes BOTH symmetric back-notify paths: a mirror pulling from origin signals nothing
   * (its only dest IS its fetch source); the origin re-signals every foreign domain EXCEPT the source.
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

      const groupDomain = trd.user?.domain; // 'local' = origin; <peer> = mirror; undefined = P2P
      if (!groupDomain) {
        // P2P (local-only or federated 1:1): signal each foreign peer participant EXCEPT the author + the
        // fetch source. A pulled P2P message's only foreign participant is the author → nobody to signal.
        for (const p of participants) {
          if (p.userId === authorUserId || !p.user.isForeigner) continue;
          if (fetchedFromDomain && p.user.domain === fetchedFromDomain)
            continue;
          void latestSeq;
          void this.pushDiscoveryHwm(p.user.domain).catch((e) =>
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
        void this.pushDiscoveryHwm(d).catch((e) =>
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

  onModuleDestroy(): void {}

  /** Find a LOCAL user id by account (domain="local"). Null if not found / not local / soft-deleted.
   *  The isDeleted gate matters here because S2S bypasses the token system: the local /uploads/* path is
   *  protected from admin-disabled users by session-token revocation (invalidateAllSessions revokes every
   *  SessionToken row on disable), but
   *  /get_file never touches tokens — so a disabled user's media would still flow out over federation
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

  /** Public profile of a local user (GET /api/v1/s2s/users/:account). Null if not local / not found. */
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

  /** Lightweight revision probe (GET /api/v1/s2s/users/:account/revision): just the profile revision,
   *  no avatar transfer. Receivers compare against the stub's remoteProfileRev to decide whether to
   *  re-pull the full profile. Null if not local / not found. */
  async getLocalUserRevision(
    address: S2SAddress,
  ): Promise<{ profileRev: number } | null> {
    if (address.domain !== this.config.domain) return null;
    const u = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(address.account)),
        eq(tables.user.domain, 'local'),
      ),
      columns: { profileRev: true, isForeigner: true },
    });
    if (!u || u.isForeigner) return null;
    return { profileRev: u.profileRev };
  }

  /** Origin's roster revision for a group (GET /s2s/group/:account/roster-revision). Null if the group
   *  isn't local (not the origin) or has no Group row. `groupAccount` = the group's `!account`. */
  async getLocalGroupRosterRevision(
    groupAccount: string,
  ): Promise<{ rosterRev: number } | null> {
    const trd = await this.findGroupThread(groupAccount);
    if (!trd || !this.isOriginThread(trd) || trd.groupUserId == null)
      return null;
    if (trd.groupUser?.group?.dissolvedAt != null) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    const grp = await this.database.db.query.group.findFirst({
      where: eq(tables.group.groupUserId, trd.groupUserId),
      columns: { rosterRev: true },
    });
    return grp ? { rosterRev: grp.rosterRev } : null;
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
    const headers = this.signature.signOutbound({
      method: 'POST',
      path: url.pathname,
      query: url.search || '?',
      authority: url.host,
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
      );
      throw new Error(
        `S2S POST to ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
      );
    }
    const status = res.status;
    if (status === 200 || status === 202 || status === 204 || status === 409) {
      await this.markContactSuccess(peerDomain); // delivered or idempotent → advance liveness
      return;
    }
    // Trust/server failure (401/403 = signature/trust rejected; 5xx = peer broken) → demote so the
    // reconnect sweep self-heals. A quota refusal (429/413) or resource response (400/404/410) means the
    // peer is HEALTHY and answered — do NOT demote (a quota hit must never demote; see QuotaService).
    // Mirrors getSigned; surface a typed S2sResponseError so a caller can branch on the status.
    if (status === 401 || status === 403 || status >= 500) {
      await this.markDemoted(peerDomain, `POST HTTP ${status}`);
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
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}${path}`);
    const headers = this.signature.signOutbound({
      method: 'GET',
      path: url.pathname,
      query: url.search || '?',
      authority: url.host,
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
        await this.markDemoted(peerDomain, `GET ${path} HTTP ${status}`);
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

  // ─── trust establishment (init handshake) ────────────────────────────────────

  /**
   * Ensure mutual trust with a peer domain before any resolve/friend-op traffic. Idempotent: a no-op if
   * the domain is already trusted. Otherwise the mutual init handshake — our signed POST /init proves
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
   * A pending first contact may retry the atomic/idempotent /init. A demoted established peer must
   * prove the already-pinned identity and complete a signed ping; it can never silently re-bootstrap.
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
    await this.pingPeer(domain);
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
  //   pending ──init ok──► trusted ──op failed──► demoted ──signed ping ok──► trusted …

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
   *  liveness channel is GET /s2s/ping (+ ensurePeerTrusted on trust refresh); advancing here is the
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
  async markDemoted(domain: string, reason: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (
      !existing ||
      existing.trustLevel === 'blocked' ||
      existing.trustLevel === 'identity_lost' ||
      existing.trustLevel === 'reset_in_progress'
    )
      return;
    const now = new Date();
    const transitioned =
      existing.trustLevel === 'trusted' || existing.trustLevel === 'pending';
    await this.database.db
      .update(tables.federatedPeer)
      .set({
        ...(transitioned
          ? {
              trustLevel: 'demoted',
              demotionCount: sql`${tables.federatedPeer.demotionCount} + 1`,
            }
          : {}),
        demotedAt: now,
        demoteReason: reason.slice(0, 255),
      })
      .where(eq(tables.federatedPeer.domain, domain));
    if (transitioned) {
      await this.logEvent(domain, 'demoted', reason);
    }
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

  /** Admin unblock: move the peer to `pending` so the next contact re-runs the init handshake to
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
    const url = new URL(`${base}/api/v1/s2s/init`);
    const localStartChangeId =
      await this.federationCursor.prepareHandshakeStart(peerDomain);
    const claim = this.federationIdentity.createClaim(
      peerDomain,
      undefined,
      localStartChangeId,
    );
    const body = JSON.stringify(claim);
    const headers = this.signature.signOutbound({
      method: 'POST',
      path: url.pathname,
      query: url.search || '?',
      authority: url.host,
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
    const payload = (await res.json()) as
      | { data?: SignedFederationIdentity }
      | SignedFederationIdentity;
    const response = (
      'data' in payload && payload.data ? payload.data : payload
    ) as SignedFederationIdentity;
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
    const preUpgradeKeys =
      await this.federationIdentity.getPreUpgradeCachedKeys(peerDomain);
    const nonce = randomBytes(24).toString('base64url');
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}/api/v1/s2s/identity`);
    url.searchParams.set('nonce', nonce);
    const headers = this.signature.signOutbound({
      method: 'GET',
      path: url.pathname,
      query: url.search || '?',
      authority: url.host,
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
      );
      throw new Error(
        `S2S identity from ${peerDomain} failed (network/timeout): ${(error as Error).message}`,
      );
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403 || res.status >= 500) {
        await this.markDemoted(peerDomain, `GET identity HTTP ${res.status}`);
      }
      throw new Error(
        `S2S identity from ${peerDomain} rejected: HTTP ${res.status}`,
      );
    }
    const payload = (await res.json()) as
      | { data?: SignedFederationIdentity }
      | SignedFederationIdentity;
    await this.verifyAndPinIdentityResponse(
      peerDomain,
      nonce,
      ('data' in payload && payload.data
        ? payload.data
        : payload) as SignedFederationIdentity,
      preUpgradeKeys,
      false,
    );
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
      doc.protocolVersion !== 1 ||
      doc.identityEpoch !== response.identityEpoch ||
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

  // ─── invite flows (synchronous, unified friend + group) ─────────────────────

  /** POST /api/v1/s2s/invite — deliver an invite (friend-add OR group-invite). The local Invite model
   *  holds both kinds in one table; the S2S layer mirrors that with one endpoint + a `kind` field.
   *  Federated delivery is synchronous + idempotent (the receiver dedupes via Invite (origin, originId)
   *  + S2SFriendOpSeen). For GROUP, the LOCAL group thread is lazily promoted to a federated origin
   *  (ensureOriginFederatedId mints the fedGroupAccount). */
  async sendInvite(params: {
    kind: 'FRIEND' | 'GROUP';
    fromLocalUserId: number;
    to: S2SAddress;
    note?: string;
    // GROUP only — caller supplies the group identity, a wire avatar, + the revision (origin
    // !-User.profileRev, Int) so the receiver's mirror update is revision-gated:
    threadId?: number;
    groupName?: string;
    groupAvatarUrl?: string; // LOCAL avatar path (/uploads/...) → converted to inline S2SAvatar here
    groupRevision?: number;
    owner?: S2SAddress;
    /** FRIEND correlation id shared with the sender's local Invite row. */
    opId?: string;
  }): Promise<void> {
    const from = await this.requireLocalUser(params.fromLocalUserId);
    const payload: S2SInvite = {
      id: params.opId ?? mintUlid(),
      origin: this.config.domain,
      kind: params.kind,
      from: this.localAddress(from.account),
      to: { account: params.to.account, domain: params.to.domain },
      ts: Date.now(),
      note: (params.note ?? '').slice(0, 255),
    };
    if (params.kind === 'FRIEND') {
      payload.profile = await this.toS2SProfile(from);
    } else {
      payload.group = await this.ensureOriginFederatedId(params.threadId!);
      // sinceSeq = the origin thread seq the invitee seeds its pullUntil with, so a new member starts
      // from "now" (post-invite) instead of pulling the whole pre-join history (the pullUntil=-1 default).
      // ORIGIN (us): our own curSeq (== the origin's latest). MIRROR: our pullUntil (the origin seq we've
      // caught up to — at worst slightly behind the origin's true latest; the gap closes on the next push).
      const trd = await this.database.db.query.messageThread
        .findFirst({
          where: eq(tables.messageThread.id, params.threadId!),
          columns: { curSeq: true, pullUntil: true },
          with: { user: { columns: { domain: true } } },
        })
        .then((row) => (row ? { ...row, groupUser: row.user } : null));
      payload.sinceSeq =
        trd == null || trd.groupUser == null
          ? -1
          : trd.groupUser.domain === 'local' // origin: our own curSeq; mirror: our pullUntil
            ? trd.curSeq
            : trd.pullUntil;
      payload.groupName = params.groupName?.slice(0, 255);
      payload.groupAvatar = params.groupAvatarUrl
        ? await this.upload.readAvatarAsWire(params.groupAvatarUrl)
        : null;
      payload.groupRevision = params.groupRevision ?? 0;
      payload.owner = params.owner ?? payload.from;
    }
    await this.postSigned(
      '/api/v1/s2s/invite',
      JSON.stringify(payload),
      params.to.domain,
    );
  }

  /** POST /api/v1/s2s/invite-accept — notify the other side that a local user accepted an invite. FRIEND
   *  → the inviter's server creates the P2P thread (accept-wins); GROUP → the group ORIGIN adds the
   *  accepter to its roster + fans out a thread/member join. `targetDomain` is the inviter's domain
   *  (FRIEND) or the group origin (GROUP); `inviteOriginId` correlates the sender's outgoing Invite. */
  async sendInviteAccept(params: {
    kind: 'FRIEND' | 'GROUP';
    fromLocalUserId: number; // the accepter (local)
    targetDomain: string;
    inviteOriginId?: string;
    by?: S2SAddress; // FRIEND: the original inviter
    group?: string; // GROUP: the group `!account` (== fedGroupAccount)
  }): Promise<void> {
    const accepter = await this.requireLocalUser(params.fromLocalUserId);
    const payload: S2SInviteAccept = {
      id: mintUlid(),
      origin: this.config.domain,
      kind: params.kind,
      accepter: this.localAddress(accepter.account),
      inviteOriginId: params.inviteOriginId,
      ts: Date.now(),
    };
    if (params.kind === 'FRIEND') payload.by = params.by;
    else payload.group = params.group;
    await this.postSigned(
      '/api/v1/s2s/invite-accept',
      JSON.stringify(payload),
      params.targetDomain,
    );
  }

  /** Withdraw a federated FRIEND invite. Awaited by the consumer endpoint: local state is changed only
   * after the peer acknowledges, so an unreachable peer cannot leave the two visible lists divergent. */
  async sendInviteRevoke(params: {
    fromLocalUserId: number;
    to: S2SAddress;
    inviteOriginId: string;
  }): Promise<void> {
    const from = await this.requireLocalUser(params.fromLocalUserId);
    const payload: S2SInviteRevoke = {
      id: mintUlid(),
      origin: this.config.domain,
      kind: 'FRIEND',
      from: this.localAddress(from.account),
      to: { account: params.to.account, domain: params.to.domain },
      inviteOriginId: params.inviteOriginId,
      ts: Date.now(),
    };
    await this.postSigned(
      '/api/v1/s2s/invite-revoke',
      JSON.stringify(payload),
      params.to.domain,
    );
  }

  /** POST /api/v1/s2s/call — deliver ONE ephemeral WebRTC call frame (ring / lifecycle / SDP-ICE relay)
   *  to the peer server hosting the call's other participant. Awaitable so the caller's `initiate` can
   *  detect a ring failure (→ the `unreachable` terminal bubble). The persisted CALL record rides the
   *  pull-based message sync, NOT this frame. `peerDomain` is the foreign participant's home domain. */
  async sendCallFrame(
    params: {
      fromLocalUserId: number;
      to: S2SAddress;
      callSid: string;
      op: S2SCallOp;
      callType: 'AUDIO' | 'VIDEO';
      endReason?: string;
      kind?: string;
      payload?: string;
      startedAt?: number;
    },
    peerDomain: string,
  ): Promise<void> {
    const from = await this.requireLocalUser(params.fromLocalUserId);
    const frame: S2SCallFrame = {
      id: mintUlid(),
      origin: this.config.domain,
      ts: Date.now(),
      from: this.localAddress(from.account),
      to: { account: params.to.account, domain: params.to.domain },
      callSid: params.callSid,
      op: params.op,
      callType: params.callType,
    };
    if (params.endReason !== undefined) frame.endReason = params.endReason;
    if (params.kind !== undefined) frame.kind = params.kind;
    if (params.payload !== undefined) frame.payload = params.payload;
    if (params.startedAt !== undefined) frame.startedAt = params.startedAt;
    await this.postSigned(
      '/api/v1/s2s/call',
      JSON.stringify(frame),
      peerDomain,
    );
  }

  // ─── Step 3: cross-server group threads (origin-hub) ────────────────────────

  /** Ensure an origin group thread carries its federated id + originDomain (lazy, at the first
   *  cross-server invite — group.create itself is federation-agnostic). The federated id IS the group's
   *  `!account` (globally unique ULID) — the same value on the origin and every mirror, so it doubles as
   *  the on-wire group address (`to` / `group`), never an internal thread id. Idempotent. Returns it. */
  /** Return the group's federated id (its `!account`, the on-wire group address `to`/`group`). The id
   *  IS the group !-User row's account — set at group.create, so no lazy stamping is needed (the former
   *  fedGroupAccount/originDomain columns were folded into groupUser.account / groupUser.domain). */
  async ensureOriginFederatedId(threadId: number): Promise<string> {
    const trd = await this.database.db.query.messageThread
      .findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: {},
        with: { user: { columns: { account: true } } },
      })
      .then((row) => (row ? { groupUser: row.user } : null));
    if (!trd) throw new Error(`thread ${threadId} not found`);
    if (!trd.groupUser) throw new Error(`thread ${threadId} has no group user`);
    return trd.groupUser.account;
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

  /** Inbound POST /s2s/invite — receive an invite (friend OR group), unified. Dispatches on `kind`.
   *  Dedup via S2SFriendOpSeen + the Invite (origin, originId) unique. Quota: peek (reject exhausted
   *  before dedup, so an over-limit retry burns no dedup slot) → dedup → tick on non-duplicate (replays
   *  never burn quota — tick runs only after isOpSeen returns false). */
  async handleInvite(body: S2SInvite): Promise<void> {
    await this.quota.peek(body.origin, 'requests');
    if (await this.isOpSeen(body.origin, body.id)) return;
    await this.quota.tick(body.origin, 'requests');
    if (body.kind === 'GROUP') return this.handleGroupInvite(body);
    return this.handleFriendInvite(body);
  }

  /** FRIEND: the sender's profile localizes the foreign stub; an incoming FRIEND Invite arms the badge
   *  + a live FRIEND_REQUEST NOTIFY. (was friend-op handleRequest) */
  private async handleFriendInvite(body: S2SInvite): Promise<void> {
    const from = this.requireS2SAddress(body.from);
    const to = this.requireS2SAddress(body.to);
    const foreignId = await this.ensureForeignUser(from.account, from.domain);
    if (body.profile)
      await this.localizeForeignProfile(foreignId, body.profile);
    const localId = await this.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${to.account} not found`,
      );
    }
    const inviteId = await this.invite.receiveInboundFriendInvite({
      fromUserId: foreignId,
      toUserId: localId,
      note: body.note ?? '',
      origin: body.origin,
      originId: body.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    this.sse.onNotify(localId, {
      event: 'NOTIFY',
      type: 'FRIEND_REQUEST',
      fromUserId: foreignId,
      inviteId,
    });
    // friendReqRev push (the mergeable badge signal) — MAX(createdAt) over the local recipient's incoming
    // FRIEND invites, just advanced by receiveInboundFriendInvite's PENDING create.
    void this.invite
      .friendReqState(localId)
      .then((s) => this.sse.onFriendReqRevUpdated(localId, s));
  }

  /** GROUP: friend-gate → find-or-create mirror (stores the OWNER participant) → REVISION-GATED avatar/
   *  name refresh → incoming GROUP Invite + a GROUP_INVITE card (same shape as a local invite). */
  private async handleGroupInvite(body: S2SInvite): Promise<void> {
    const by = this.requireS2SAddress(body.from);
    const to = this.requireS2SAddress(body.to);
    const owner = body.owner ? this.requireS2SAddress(body.owner) : by;
    // The group `!account` is an untrusted inbound payload field — a bare account string, NOT an
    // {account,domain} object, so requireS2SAddress doesn't cover it. Normalize + grammar-check it before
    // it lands as a mirror groupUser.account: a malformed/non-`!` peer value must not violate the account
    // invariant (case is folded — the contract is case-insensitive on write).
    const groupAccount = body.group ? normalizeAccount(body.group) : '';
    if (!isValidGroupAccount(groupAccount)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'invite group account missing or malformed',
        HttpStatus.BAD_REQUEST,
      );
    }
    const localId = await this.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${to.account} not found`,
      );
    }
    // The inviter's stub must already exist (a passing friend gate ⇒ they're already friends ⇒ the stub
    // was created when they befriended). LOOK IT UP (don't ensure/create) — missing ⇒ not friends.
    const byStub = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(by.account)),
        eq(tables.user.domain, by.domain),
      ),
    });
    if (!byStub) {
      throw new BusinessException(BusinessCode.FORBIDDEN, 'not friends');
    }
    const byStubId = byStub.id;
    const p2pThreadId = await this.participantService.findP2PThreadBetween(
      byStubId,
      localId,
    );
    if (p2pThreadId === null) {
      throw new BusinessException(BusinessCode.FORBIDDEN, 'not friends');
    }
    const ownerStubId =
      owner.account === by.account && owner.domain === by.domain
        ? byStubId
        : await this.ensureForeignUser(owner.account, owner.domain);
    const mirrorThreadId = await this.findOrCreateMirrorThread({
      fedGroupAccount: groupAccount,
      originDomain: body.origin,
      name: body.groupName ?? '',
      ownerStubId,
      // Seed the mirror's pull cursor so the new member pulls from the invite-time latest seq, NOT the
      // entire pre-join history. Absent (-1) ⇒ a peer that doesn't send sinceSeq gets the full history
      // (safe default; only matters when the group already had messages at invite time).
      sinceSeq: body.sinceSeq ?? -1,
    });
    // Revision-gated avatar/name refresh: skip when the peer's revision is not newer than the mirror's
    // remoteProfileRev (no avatar re-localization / orphan files on an unchanged group).
    const mirror = await this.database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, mirrorThreadId),
      columns: { groupUserId: true },
    });
    const gu =
      mirror?.groupUserId != null
        ? await this.database.db.query.user.findFirst({
            where: eq(tables.user.id, mirror.groupUserId),
            columns: { remoteProfileRev: true, avatar: true },
          })
        : null;
    const rev = body.groupRevision ?? 0;
    const stale =
      gu == null || gu.remoteProfileRev == null || gu.remoteProfileRev < rev;
    let avatarUrl = gu?.avatar ?? '';
    if (stale && mirror?.groupUserId != null) {
      avatarUrl = body.groupAvatar
        ? await this.upload.saveAvatarFromWire(body.groupAvatar)
        : avatarUrl;
      await this.database.db
        .update(tables.user)
        .set({
          name: (body.groupName ?? '').slice(0, 255),
          avatar: avatarUrl,
          remoteProfileRev: rev,
          updatedAt: new Date(),
        })
        .where(eq(tables.user.id, mirror.groupUserId));
    }
    // Mint the inbound Invite. NO card write — the card is the SENDER's responsibility (written into the
    // sender's P2P mirror), delivered to this server via the Step-2 message pull in Phase B. Phase A
    // ships the machinery (Invite + mirror + accept + roster fanout); the invitee's visible card arrives
    // with Phase-B messaging.
    await this.invite.createGroupInvite(
      byStubId,
      mirrorThreadId,
      localId,
      body.note ?? '',
      {
        origin: body.origin,
        originId: body.id,
      },
    );
  }

  /** Inbound POST /s2s/invite-accept — the other side accepted an invite. FRIEND → create THIS server's
   *  P2P thread (accept-wins); GROUP → we are the ORIGIN: add the accepter to our roster + fan out a
   *  thread/member join so the roster is consistent on every member-server. */
  async handleInviteAccept(body: S2SInviteAccept): Promise<void> {
    await this.quota.peek(body.origin, 'requests');
    if (await this.isOpSeen(body.origin, body.id)) return;
    await this.quota.tick(body.origin, 'requests');
    if (body.kind === 'GROUP') return this.handleGroupAccept(body);
    return this.handleFriendAccept(body);
  }

  /** Inbound federated withdrawal. Replays and already-terminal rows are successful no-ops: revoke is
   * idempotent, while ACCEPTED remains accepted (accept-wins for a cross-server race). */
  async handleInviteRevoke(body: S2SInviteRevoke): Promise<void> {
    await this.quota.peek(body.origin, 'requests');
    if (await this.isOpSeen(body.origin, body.id)) return;
    const from = this.requireS2SAddress(body.from);
    const to = this.requireS2SAddress(body.to);
    const foreignId = await this.ensureForeignUser(from.account, from.domain);
    const localId = await this.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${to.account} not found`,
      );
    }
    await this.invite.revokeInboundFriendInvite({
      fromUserId: foreignId,
      toUserId: localId,
      origin: body.origin,
      originId: body.inviteOriginId,
    });
  }

  /** Inbound POST /api/v1/s2s/call — receive ONE federated call frame. Resolves the wire identities to
   *  LOCAL ids (the sender → a foreigner stub; the recipient → a local userId) + the LOCAL P2P thread,
   *  then hands the frame to CallsService via `emitAsync('call.frame.inbound')` — NOT a direct injection
   *  (the calls layer injects FederationService for outbound; a back-edge would cycle). `emitAsync` (not
   *  `emit`) so the 202 ACK serializes BEHIND the callee-side mirror setup: the caller's first `offer`
   *  signal must not race ahead of the mirror it addresses.
   *
   *  Quota: `peek 'requests'` for the initiating `incoming` op ONLY (a call is one unit; an ICE burst
   *  must not exhaust the budget). The `tick` happens in CallsService AFTER the in-memory mirror-state
   *  guard, so a retried `incoming` (fresh ULID) burns no quota. No (origin, opId) dedup table — the
   *  receiver's call state machine + the callSid-keyed bubble write make replays idempotent. The
   *  not-found / not-friends rejects use HTTP 404 (NOT in postSigned's success- or demote-sets → the
   *  sender throws without demoting a healthy peer). */
  async handleCallFrame(body: S2SCallFrame): Promise<void> {
    if (body.op === 'incoming') {
      await this.quota.peek(body.origin, 'requests');
    }
    if (body.op === 'signal') {
      // Per-frame tick against the dedicated `signals` budget (a 429 here throws without demoting a
      // healthy peer → the caller's relay fails closed; the client re-gathers ICE). No peek — the tick's
      // atomic check+increment is authoritative.
      await this.quota.tick(body.origin, 'signals');
    }
    const from = this.requireS2SAddress(body.from);
    const to = this.requireS2SAddress(body.to);
    const peerStubId = await this.ensureForeignUser(from.account, from.domain);
    const localUserId = await this.findLocalUserIdByAddress(to);
    if (localUserId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${to.account} not found`,
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
      threadId,
      frame: body,
    });
  }

  /** FRIEND accept (was friend-op handleApprove): the foreign approver accepted our local user's invite.
   *  Accept-wins: form the P2P thread if not already friends. */
  private async handleFriendAccept(body: S2SInviteAccept): Promise<void> {
    const from = this.requireS2SAddress(body.accepter); // the approver → foreign stub here
    const to = body.by ? this.requireS2SAddress(body.by) : null; // the local requester
    const foreignId = await this.ensureForeignUser(from.account, from.domain);
    const localId = to ? await this.findLocalUserIdByAddress(to) : null;
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local requester not found`,
      );
    }
    const { threadId, created } = await this.invite.applyInboundFriendApprove(
      localId,
      foreignId,
    );
    if (created) {
      // Local user's thread list gained a P2P thread — bump threadRevision + push signal (replaces the
      // former FRIEND_APPROVED NOTIFY; the client pulls the delta).
      await this.threadRevisionService.recordThreadAdd(localId, threadId);
    }
  }

  /** GROUP accept — WE are the group ORIGIN. Add the accepter to OUR roster (the origin group thread),
   *  then fan out a thread/member join to every member-server. (Accept-wins: idempotent if already a
   *  member.) */
  private async handleGroupAccept(body: S2SInviteAccept): Promise<void> {
    // WE are the group ORIGIN: record the accepter on the canonical roster. Other member-servers learn
    // of the join LAZILY via the group-meta freshness probe on chat-open (the roster is PULLED like a
    // profile, not pushed) — see the roster-mutation design in the plan.
    const accepter = this.requireS2SAddress(body.accepter);
    const trd = await this.findGroupThread(body.group ?? '');
    if (trd == null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `group ${body.group} not found`,
      );
    }
    const accepterStubId = await this.ensureForeignUser(
      accepter.account,
      accepter.domain,
    );
    await this.database.db.transaction(async (tx) => {
      await this.participantService.upsertMemberInTx(
        tx,
        trd.id,
        accepterStubId,
        GroupRole.MEMBER,
      );
      await tx
        .insert(tables.threadAudience)
        .values({
          targetDomain: accepter.domain,
          localUserId: null,
          threadId: trd.id,
        })
        .onConflictDoNothing();
      // Membership and discovery access become visible atomically.
      if (trd.groupUserId != null) {
        await tx
          .update(tables.group)
          .set({ rosterRev: sql`${tables.group.rosterRev} + 1` })
          .where(eq(tables.group.groupUserId, trd.groupUserId));
      }
    });
  }

  // ─── roster meta-pull (lazy, on chat-open — same shape as the profile sync) ──────────

  /** ORIGIN serves the canonical roster for a federated group (GET /s2s/group/:account/roster).
   *  Members carry WIRE addresses (a local member's domain is our real domain, never the "local" sentinel)
   *  so the pulling mirror can ensureForeignUser each. */
  async serveGroupRoster(groupAccount: string): Promise<{
    members: { account: string; domain: string; role: GroupRole }[];
  } | null> {
    const trd = await this.findGroupThread(groupAccount);
    if (trd == null) return null;
    const rows = await this.database.db.query.threadParticipant.findMany({
      where: and(
        eq(tables.threadParticipant.threadId, trd.id),
        isNull(tables.threadParticipant.leftAt),
      ),
      columns: { role: true },
      with: { user: { columns: { account: true, domain: true } } },
    });
    return {
      members: rows.map((r) => ({
        account: r.user.account,
        domain: r.user.domain === 'local' ? this.config.domain : r.user.domain,
        role: r.role ?? GroupRole.MEMBER,
      })),
    };
  }

  /** MIRROR pulls the origin's roster (signed GET /s2s/group/:account/roster). Null on peer failure. */
  private async pullGroupRoster(
    groupAccount: string,
    originDomain: string,
  ): Promise<{
    members: { account: string; domain: string; role: GroupRole }[];
  } | null> {
    try {
      return await this.getSigned<{
        members: { account: string; domain: string; role: GroupRole }[];
      }>(
        `/api/v1/s2s/group/${encodeURIComponent(groupAccount)}/roster`,
        originDomain,
      );
    } catch {
      return null;
    }
  }

  /** Chat-open hook for a FEDERATED group MIRROR: dual-probe the origin's profile revision
   *  (User.profileRev) + roster revision (Group.rosterRev); if either is newer than the mirror's
   *  remoteProfileRev / remoteRosterRev, re-pull just the stale half (identity via fetchRemoteUser +
   *  localizeForeignProfile; roster via reconcile) and fan its OWN signal (GROUP_UPDATED for identity,
   *  GROUP_ROSTER_UPDATED for roster). A local group / when we ARE the origin is a no-op. */
  async syncGroupMetaIfStale(threadId: number): Promise<void> {
    const trd = await this.database.db.query.messageThread
      .findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: {
          groupUserId: true,
        },
        with: {
          user: {
            columns: {
              account: true,
              domain: true,
              remoteProfileRev: true,
            },
            with: {
              group: { columns: { rosterRev: true, remoteRosterRev: true } },
            },
          },
        },
      })
      .then((row) => (row ? { ...row, groupUser: row.user } : null));
    const gu = trd?.groupUser;
    if (!gu || gu.domain === 'local' || trd?.groupUserId == null) return;
    const groupUserId = trd.groupUserId;
    const grp = gu.group;
    const address: S2SAddress = { account: gu.account, domain: gu.domain };
    try {
      let profileChanged = false;
      let rosterChanged = false;
      const revResponse = await this.getSignedForThread<{
        profileRev: number;
      }>(
        threadId,
        `/api/v1/s2s/users/${address.account}/revision`,
        address.domain,
      );
      const rev = revResponse.data;
      if (gu.remoteProfileRev == null || rev.profileRev > gu.remoteProfileRev) {
        const profileResponse = await this.getSignedForThread<S2SProfile>(
          threadId,
          `/api/v1/s2s/users/${address.account}`,
          address.domain,
        );
        await this.localizeForeignProfile(groupUserId, profileResponse.data, {
          threadId,
          peerDomain: address.domain,
          expectedFederationVersion: profileResponse.federationVersion,
        });
        profileChanged = true;
      }
      if (grp) {
        const rrevResponse = await this.getSignedForThread<{
          rosterRev: number;
        }>(
          threadId,
          `/api/v1/s2s/group/${address.account}/roster-revision`,
          address.domain,
        );
        const rrev = rrevResponse.data;
        if (
          grp.remoteRosterRev == null ||
          rrev.rosterRev > grp.remoteRosterRev
        ) {
          const rosterResponse = await this.getSignedForThread<{
            members: {
              account: string;
              domain: string;
              role: GroupRole;
            }[];
          }>(
            threadId,
            `/api/v1/s2s/group/${encodeURIComponent(address.account)}/roster`,
            address.domain,
          );
          await this.reconcileRoster(
            threadId,
            rosterResponse.data.members,
            address.domain,
            rosterResponse.federationVersion,
            groupUserId,
            rrev.rosterRev,
          );
          rosterChanged = true;
        }
      }
      if (profileChanged || rosterChanged) {
        const members =
          await this.participantService.getActiveParticipantUserIds(threadId);
        members.forEach((m) => {
          if (profileChanged)
            this.sse.onGroupEvent(m.userId, 'GROUP_UPDATED', { threadId });
          if (rosterChanged)
            this.sse.onGroupEvent(m.userId, 'GROUP_ROSTER_UPDATED', {
              threadId,
            });
        });
      }
    } catch {
      // Best-effort — keep the cached meta; the next chat-open retries.
    }
  }

  /** Synchronous write gate for a federated GROUP mirror. A cheap signed revision probe lets the
   * origin return GROUP_DISSOLVED before the mirror persists a new message. Local-origin groups and
   * P2P threads are no-ops; their local guards remain authoritative. */
  async assertGroupWritable(threadId: number): Promise<void> {
    const trd = await this.database.db.query.messageThread
      .findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: {},
        with: { user: { columns: { account: true, domain: true } } },
      })
      .then((row) => (row ? { groupUser: row.user } : null));
    const group = trd?.groupUser;
    if (!group || group.domain === 'local') return;
    try {
      await this.getSignedForThread(
        threadId,
        `/api/v1/s2s/group/${group.account}/roster-revision`,
        group.domain,
      );
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.GROUP_DISSOLVED &&
        error.federationVersion !== undefined
      ) {
        await this.markGroupDissolved(
          threadId,
          group.domain,
          error.federationVersion,
        );
        throw new BusinessException(
          BusinessCode.GROUP_DISSOLVED,
          'group has been dissolved',
        );
      }
      // Preserve the existing offline-first send path for transient/unreachable peers. The outbound
      // hint remains buffered and will retry; only the authoritative terminal code blocks the write.
      return;
    }
  }

  /** Synchronous federated P2P write gate. Local friendships are already authoritative in the access
   * guard; a foreign peer is probed through the existing messages endpoint so its normal not-friends
   * business response converges this retained conversation to read-only before a new message is stored. */
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
    if (!peer.user.isForeigner) return;
    try {
      const result = await this.getSignedForThread<{
        active: boolean;
        revision: number;
        role: 'MEMBER' | null;
        reason: string | null;
      }>(
        threadId,
        `/api/v1/s2s/thread-access?localAccount=${encodeURIComponent(peer.user.account)}` +
          `&peerAccount=${encodeURIComponent(local.user.account)}`,
        peer.user.domain,
      );
      if (!result.data.active) {
        throw new BusinessException(
          BusinessCode.FRIEND_NOT_FOUND,
          result.data.reason ?? 'not friends',
        );
      }
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        (error.code === BusinessCode.FRIEND_NOT_FOUND ||
          error.code === BusinessCode.FORBIDDEN) &&
        error.federationVersion !== undefined
      ) {
        await this.markP2PFriendshipEnded(
          threadId,
          localUserId,
          peer.user.domain,
          error.federationVersion,
        );
        throw new BusinessException(
          BusinessCode.FRIEND_NOT_FOUND,
          'not friends',
        );
      }
      // Preserve offline-first behavior for transport failures. Only an authoritative business response
      // changes friendship state; the ordinary outbound hint remains retryable.
    }
  }

  /** Serve the unified current-access query without exposing internal thread ids. */
  async queryThreadAccess(
    localAccount: string,
    peerAccount: string | undefined,
    signerDomain: string,
  ): Promise<{
    active: boolean;
    revision: number;
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
    reason: string | null;
  }> {
    try {
      if (!localAccount.startsWith('!')) {
        const access = await this.resolveFriendshipThread(
          localAccount,
          peerAccount!,
          signerDomain,
        );
        const thread = await this.database.db.query.messageThread.findFirst({
          where: eq(tables.messageThread.id, access.threadId),
          columns: { federationVersion: true },
        });
        return {
          active: true,
          revision: thread?.federationVersion ?? 0,
          role: 'MEMBER',
          reason: null,
        };
      }
      const access = await this.resolveGroupThreadAccess(
        localAccount,
        undefined,
        undefined,
        signerDomain,
      );
      const [thread, participants] = await Promise.all([
        this.database.db.query.messageThread.findFirst({
          where: eq(tables.messageThread.id, access.threadId),
          columns: { federationVersion: true },
        }),
        this.database.db.query.threadParticipant.findMany({
          where: and(
            eq(tables.threadParticipant.threadId, access.threadId),
            isNull(tables.threadParticipant.leftAt),
          ),
          columns: { role: true },
          with: {
            user: { columns: { domain: true, isForeigner: true } },
          },
        }),
      ]);
      const participant = participants.find(
        (item) => this.effectiveDomain(item.user) === signerDomain,
      );
      return {
        active: true,
        revision: thread?.federationVersion ?? 0,
        role: participant?.role ?? 'MEMBER',
        reason: null,
      };
    } catch (error) {
      if (error instanceof BusinessException) {
        return {
          active: false,
          revision: 0,
          role: null,
          reason: error.message,
        };
      }
      throw error;
    }
  }

  /** Apply the lazy cross-server unfriend result without deleting the retained conversation. The existing
   * thread revision stream makes the caller's other devices re-hydrate friendshipActive=false. */
  private async markP2PFriendshipEnded(
    threadId: number,
    localUserId: number,
    peerDomain: string,
    expectedFederationVersion: number,
  ): Promise<void> {
    const pendingRevision = await this.database.db.transaction(async (tx) => {
      await this.assertThreadResponseWritable(
        tx,
        threadId,
        peerDomain,
        expectedFederationVersion,
      );
      const wasHidden = await this.threadRevisionService.isThreadHiddenInTx(
        tx,
        localUserId,
        threadId,
      );
      await tx
        .update(tables.threadParticipant)
        .set({ leftAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(tables.threadParticipant.threadId, threadId),
            isNull(tables.threadParticipant.leftAt),
          ),
        );
      if (wasHidden) return null;
      return this.threadRevisionService.recordThreadAddInTx(
        tx,
        localUserId,
        threadId,
      );
    });
    if (pendingRevision !== null) {
      this.threadRevisionService.notifyThreadRevision({
        userId: localUserId,
        revision: pendingRevision,
      });
    }
  }

  /** Reconcile a mirror's FOREIGN roster to match the origin's authoritative roster: upsert present
   *  foreign members, soft-leave active foreign members no longer on the origin. Local members are
   *  managed locally (a member with domain == ours IS a local user — skipped, never re-stubbed). */
  private async reconcileRoster(
    threadId: number,
    members: { account: string; domain: string; role: GroupRole }[],
    peerDomain: string,
    expectedFederationVersion: number,
    groupUserId: number,
    remoteRosterRev: number,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.assertThreadResponseWritable(
        tx,
        threadId,
        peerDomain,
        expectedFederationVersion,
      );
      const originForeignIds = new Set<number>();
      for (const m of members) {
        if (m.domain === this.config.domain) continue;
        const stubId = await this.ensureForeignUserInTransaction(
          tx,
          m.account,
          m.domain,
        );
        originForeignIds.add(stubId);
        await this.participantService.upsertMemberInTx(
          tx,
          threadId,
          stubId,
          m.role,
        );
      }
      const localForeign = await tx
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
            eq(tables.user.isForeigner, true),
          ),
        );
      const removedIds = localForeign
        .filter((participant) => !originForeignIds.has(participant.userId))
        .map((participant) => participant.userId);
      if (removedIds.length > 0) {
        await tx
          .update(tables.threadParticipant)
          .set({ leftAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(tables.threadParticipant.threadId, threadId),
              inArray(tables.threadParticipant.userId, removedIds),
              isNull(tables.threadParticipant.leftAt),
            ),
          );
      }
      await tx
        .update(tables.group)
        .set({ remoteRosterRev })
        .where(eq(tables.group.groupUserId, groupUserId));
    });
  }

  /** Idempotent mirror-thread find-or-create keyed by fedGroupAccount (@unique → one mirror per
   *  federated thread, even across multiple invited local users). A mirror is a `!`-User foreign stub
   *  (carries name/avatar/bio) + the GROUP thread; the origin OWNER is recorded as a ThreadParticipant
   *  {role:OWNER} so the mirror knows the owner. `sinceSeq` seeds the new thread's pullUntil (a re-invite
   *  of an existing mirror does NOT regress the cursor — the early-return keeps the live pullUntil). */
  private async findOrCreateMirrorThread(params: {
    fedGroupAccount: string;
    originDomain: string;
    name: string;
    ownerStubId: number;
    sinceSeq?: number;
  }): Promise<number> {
    const existing = await this.findGroupThread(params.fedGroupAccount);
    if (existing) return existing.id;
    // The mirror group-user REUSES the origin's `!account` (== fedGroupAccount) under the origin's domain
    // (account_domain uniqueness holds since the origin stores it under 'local').
    try {
      return await this.database.db.transaction(async (tx) => {
        const [groupUser] = await tx
          .insert(tables.user)
          .values({
            account: params.fedGroupAccount,
            domain: params.originDomain,
            isForeigner: true,
            isGroup: true,
            hashPwd: '', // empty — mirror group-user never logs in
            name: params.name.slice(0, 255),
            avatar: '',
            bio: '',
            updatedAt: new Date(),
          })
          .returning({ id: tables.user.id });
        const [trd] = await tx
          .insert(tables.messageThread)
          .values({
            type: MessageThreadType.GROUP,
            groupUserId: groupUser.id,
            // Seed pullUntil from the invite's sinceSeq so the member pulls from invite-time latest, not the
            // full pre-join history. -1 (no sinceSeq) ⇒ pull everything (the safe default for an empty group).
            pullUntil: params.sinceSeq ?? -1,
            updatedAt: new Date(),
          })
          .returning({ id: tables.messageThread.id });
        // Group-exclusive state: owner + roster revision. remoteRosterRev stays null until the first probe.
        await tx.insert(tables.group).values({
          groupUserId: groupUser.id,
          ownerId: params.ownerStubId,
          rosterRev: 0,
          updatedAt: new Date(),
        });
        // Record the origin owner on the mirror (roster authority is the origin).
        await tx.insert(tables.threadParticipant).values({
          userId: params.ownerStubId,
          threadId: trd.id,
          role: GroupRole.OWNER,
          updatedAt: new Date(),
        });
        return trd.id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findGroupThread(params.fedGroupAccount);
      if (!winner) throw error;
      return winner.id;
    }
  }

  /** True if (origin, opId) already applied. Reuses S2SFriendOpSeen as the generic op-seen table (the
   *  name is historical — it is just an (origin, opId) dedup index). Race-safe (P2002 = concurrent dup). */
  private async isOpSeen(origin: string, opId: string): Promise<boolean> {
    const existing = await this.database.db.query.s2SFriendOpSeen.findFirst({
      where: and(
        eq(tables.s2SFriendOpSeen.origin, origin),
        eq(tables.s2SFriendOpSeen.opId, opId),
      ),
    });
    if (existing) return true;
    try {
      await this.database.db
        .insert(tables.s2SFriendOpSeen)
        .values({ origin, opId });
      return false;
    } catch (e) {
      if (isUniqueViolation(e)) {
        return true;
      }
      throw e;
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
   * demoted/blocked peer is caught up front (not only after a failure). The op itself (sendSignedPost
   * / getSigned) already calls markDemoted on failure → self-heal on the next reconnect-sweep tick.
   * Throws FEDERATION_PEER_BLOCKED if the peer is admin-blocked.
   */
  private async withTrustedPeer<T>(
    domain: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.ensurePeerTrusted(domain);
    return fn();
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

  /** Outbound signed ping (GET /api/v1/s2s/ping) — the reconnect sweep's cheap first probe
   *  (reachability + mutual-key-validity) before the heavier re-handshake. Raw getSigned (NOT
   *  withTrustedPeer): a demoted peer is pinged directly; on failure it stays demoted for the next tick. */
  async pingPeer(domain: string): Promise<void> {
    await this.getSigned<{ domain: string; ts: number }>(
      '/api/v1/s2s/ping',
      domain,
    );
  }

  /** Lightweight, ephemeral discovery wake-up. The receiver never persists this advertised HWM. */
  async pushDiscoveryHwm(domain: string): Promise<void> {
    const allocatedThrough =
      await this.federationCursor.readAllocatedThrough(domain);
    await this.postSigned(
      '/api/v1/s2s/discovery-hwm',
      JSON.stringify({
        origin: this.config.domain,
        allocatedThrough: allocatedThrough.toString(),
      }),
      domain,
    );
  }

  /** Query the peer's current source HWM after reconnect or during reconciliation. */
  async pullDiscoveryHwm(domain: string): Promise<bigint> {
    const result = await this.getSigned<{ allocatedThrough: string }>(
      '/api/v1/s2s/discovery-hwm',
      domain,
    );
    if (!/^(0|[1-9]\d*)$/.test(result.allocatedThrough)) {
      throw new Error(`peer ${domain} returned an invalid discovery HWM`);
    }
    return BigInt(result.allocatedThrough);
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
  ): Promise<{ page: FederationMissedPage; token: PeerResponseToken }> {
    if (after < 0n) throw new Error('missed cursor must be non-negative');
    if (!Number.isInteger(take) || take < 1 || take > 200) {
      throw new Error('missed page size must be an integer from 1 to 200');
    }
    const token = await this.capturePeerResponseToken(domain);
    const page = await this.withTrustedPeer(domain, () =>
      this.getSigned<FederationMissedPage>(
        `/api/v1/s2s/missed?after=${after.toString()}&take=${take}`,
        domain,
        16 * 1024 * 1024,
      ),
    );
    return { page, token };
  }

  /** Drain one peer's durable global feed. Per-page tokens/effects are kept only for the lifetime of
   * this run; the durable cursor and staged messages remain the crash-recovery truth. */
  pullMissedFromPeer(
    missedPull: FederationMissedPullService,
    domain: string,
  ): Promise<void> {
    const tokens = new WeakMap<FederationMissedPage, PeerResponseToken>();
    const effects = new WeakMap<FederationMissedPage, MissedPageEffect[]>();
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
    page: FederationMissedPage,
    token: PeerResponseToken,
  ): Promise<MissedPageEffect[]> {
    await this.assertPeerResponseWritable(tx, token);
    const effects: MissedPageEffect[] = [];
    for (const item of page.messages) {
      if (!Number.isSafeInteger(item.originSeq) || item.originSeq < 0) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'missed message has invalid originSeq',
          HttpStatus.BAD_REQUEST,
        );
      }
      const route = await this.resolveMissedThreadInTransaction(
        tx,
        item,
        domain,
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
          } else {
            this.logger.error(
              `refused to overwrite source coordinates for self-authored missed message: ` +
                JSON.stringify({
                  messageId: localSourceMessage.id.toString(),
                  threadId: route.threadId,
                  seq: item.originSeq,
                  sourceDomain: domain,
                  existingOriginSeq: localSourceMessage.originSeq,
                  existingOriginServerTime:
                    localSourceMessage.originServerTime?.toISOString() ?? null,
                }),
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
          `/api/v1/s2s/forward-bundles/${encodeURIComponent(forwardCard.bundleId)}`,
          domain,
          FORWARD_MAX_WIRE_JSON_BYTES + 64 * 1024,
        );
      }

      const stored = await this.storePulledMessageInTransaction(tx, {
        threadId: route.threadId,
        creator: route.creatorId,
        fetchedFromDomain: domain,
        message: {
          originSeq: item.originSeq,
          contentType: item.contentType,
          content: item.content,
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
        for (const userId of effect.recipients) {
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
    item: FederationMissedPage['messages'][number],
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
    item: FederationMissedPage['messages'][number],
    sourceDomain: string,
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
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missed message author is not a known thread participant',
        HttpStatus.BAD_REQUEST,
      );
    }

    let threadRows: Array<{
      threadId: number;
      federationVersion: number;
      toAccount: string;
    }> = [];
    if (item.thread.type === 'GROUP') {
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
         AND author_participant."leftAt" IS NULL
        WHERE thread.type = 'GROUP'
          AND thread."federationTruncated" = false
          AND group_user.account = ${normalizeAccount(item.thread.account)}
          AND group_user.domain = ${groupDomain}
          AND EXISTS (
            SELECT 1 FROM "ThreadParticipant" local_participant
            JOIN "User" local_user ON local_user.id = local_participant."userId"
            WHERE local_participant."threadId" = thread.id
              AND local_participant."leftAt" IS NULL
              AND local_user.domain = 'local'
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
      if (
        participants.length !== 2 ||
        !local ||
        item.author.domain === this.config.domain ||
        sourceDomain !== item.author.domain
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
         AND author_participant."leftAt" IS NULL
        JOIN "ThreadParticipant" local_participant
          ON local_participant."threadId" = thread.id
         AND local_participant."leftAt" IS NULL
        JOIN "User" local_user ON local_user.id = local_participant."userId"
        WHERE thread.type = 'P2P'
          AND thread."federationTruncated" = false
          AND local_user.domain = 'local'
          AND local_user.account = ${normalizeAccount(local.account)}
        LIMIT 1
        FOR SHARE OF thread, author_participant, local_participant
      `);
      threadRows = result.rows;
    }
    const route = threadRows[0];
    if (!route) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missed message has no active local thread access',
        HttpStatus.BAD_REQUEST,
      );
    }
    const recipientRows = await tx.execute<{ userId: number }>(sql`
      SELECT participant."userId"
      FROM "ThreadParticipant" participant
      JOIN "User" member ON member.id = participant."userId"
      WHERE participant."threadId" = ${route.threadId}
        AND participant."leftAt" IS NULL
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
    // Authorization is historical, not derived from the current friendship/roster. DiscoveryChange is
    // durable proof that this signer had already been allocated the exact message; leaving a group or
    // removing a friend only stops future allocations. The request still binds the historical proof to
    // its author, recipient/group, source sequence and digest below.
    const candidates = await this.database.db
      .select({
        messageId: tables.message.id,
        threadId: tables.message.threadId,
        authorDomain: tables.user.domain,
        authorIsForeigner: tables.user.isForeigner,
        threadType: tables.messageThread.type,
        groupUserId: tables.messageThread.groupUserId,
      })
      .from(tables.discoveryChange)
      .innerJoin(
        tables.discoveryTarget,
        eq(tables.discoveryTarget.id, tables.discoveryChange.targetId),
      )
      .innerJoin(
        tables.message,
        eq(tables.message.id, tables.discoveryChange.messageId),
      )
      .innerJoin(tables.user, eq(tables.user.id, tables.message.creator))
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, tables.message.threadId),
      )
      .where(
        and(
          eq(tables.discoveryTarget.targetDomain, signerDomain),
          isNull(tables.discoveryTarget.localUserId),
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
      sourceMessage = {
        id: candidate.messageId,
        threadId: candidate.threadId,
      };
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
        tables.discoveryChange,
        eq(tables.discoveryChange.messageId, tables.message.id),
      )
      .innerJoin(
        tables.discoveryTarget,
        eq(tables.discoveryTarget.id, tables.discoveryChange.targetId),
      )
      .where(
        and(
          eq(tables.forwardMessage.bundleId, bundleId),
          eq(tables.message.isDeleted, false),
          eq(tables.discoveryTarget.targetDomain, signerDomain),
          isNull(tables.discoveryTarget.localUserId),
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
    await this.discoveryChanges.recordMessageInTx(tx, message.id, [
      fetchedFromDomain,
    ]);
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
      await this.discoveryChanges.recordMessageInTx(tx, message.id, [
        batch.originDomain!,
      ]);
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
      for (const uid of recipients) {
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

  /**
   * Receiver-side media localize (§3.3 / §4.5): for each CAS digest referenced by a pulled message,
   * fetch the bytes from the peer's /get_file and store them through the SAME CAS pipeline as a local
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
   * naming the peer /get_file source. GROUP → the thread's group-User account + its origin domain
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

  /**
   * Resolve the /get_file authorization for a stored FORWARD message's bundle assets. The forward
   * bundle's bytes are authorized by the FORWARD message's OWN identity bound to its bundle (see
   * resolveMediaFile's forwardBundleId branch): fromAccount/fromDomain = the forwarder, toAccount =
   * the thread receiver, sourceSeq = the forward message's seq (COALESCE(originSeq, seq)). Mirrors
   * localizeMediaForMessage's context resolution; extracted so both the pull-time and retry paths
   * derive the same authorization. */
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
   * Buffer chunks via signed Range GETs to /get_file, for saveCasFromStream to stream to disk. Each
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
    const path = forwardBundleId
      ? `/api/v1/s2s/get_file?digest=${digest}&bundleId=${encodeURIComponent(forwardBundleId)}&fromAccount=${encodeURIComponent(fromAccount)}&fromDomain=${encodeURIComponent(fromDomain)}&toAccount=${encodeURIComponent(toAccount)}&toDomain=${encodeURIComponent(this.ourDomain)}&seq=${sourceSeq}`
      : `/api/v1/s2s/get_file?digest=${digest}&fromAccount=${encodeURIComponent(fromAccount)}&fromDomain=${encodeURIComponent(fromDomain)}&toAccount=${encodeURIComponent(toAccount)}&toDomain=${encodeURIComponent(this.ourDomain)}&seq=${sourceSeq}`;
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
          const actualDigest = `sha-256=${createHash('sha256').update(buf).digest('base64')}`;
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

  /** One signed Range GET to /get_file, with status-based classification (see fetchMediaChunks). Returns
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
    const headers = this.signature.signOutbound({
      method: 'GET',
      path: url.pathname,
      query: url.search || '?',
      authority: url.host,
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
        `GET get_file network/timeout: ${(e as Error).message}`,
      );
      throw new Error(
        `S2S get_file from ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
      );
    }
    if (res.status === 200) {
      throw new Error('S2S get_file peer ignored required Range request');
    }
    if (res.status === 206) {
      const cr = res.headers.get('content-range') ?? '';
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (!m) {
        await this.markDemoted(
          peerDomain,
          `GET get_file 206 unparseable Content-Range: ${cr}`,
        );
        throw new Error(
          `S2S get_file 206 without parseable Content-Range: ${cr}`,
        );
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
          `S2S get_file returned unexpected Content-Range: ${cr} for bytes=${start}-${end}`,
        );
      }
      if (
        contentDigestHeader !== null &&
        !/^sha-256=[A-Za-z0-9+/]{43}=$/.test(contentDigestHeader)
      ) {
        throw new Error('S2S get_file 206 with an invalid Content-Digest');
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
      await this.markDemoted(peerDomain, `GET get_file HTTP ${res.status}`);
      throw new Error(
        `S2S get_file from ${peerDomain} rejected: HTTP ${res.status}`,
      );
    }
    throw new Error(
      `S2S get_file from ${peerDomain} HTTP ${res.status} (no demote)`,
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
   * Fetch a peer user's public profile (signed GET /api/v1/s2s/users/:account). Used by federated
   * resolve (the add-friend card), ensureForeignUserLocalized (send-friend-request safety net), and
   * the chat-open staleness re-pull (syncForeignUserIfStale). Throws on any non-success (the caller
   * surfaces FEDERATION_DELIVERY_FAILED → user retries / inits).
   */
  async fetchRemoteUser(address: S2SAddress): Promise<S2SProfile> {
    return this.getSigned<S2SProfile>(
      `/api/v1/s2s/users/${address.account}`,
      address.domain,
    );
  }

  /** Fetch only the peer user's profile revision (signed GET .../revision). Cheap staleness probe. */
  async fetchRemoteRevision(
    address: S2SAddress,
  ): Promise<{ profileRev: number }> {
    return this.getSigned<{ profileRev: number }>(
      `/api/v1/s2s/users/${address.account}/revision`,
      address.domain,
    );
  }

  /** Fetch only the origin's roster revision for a group (signed GET /s2s/group/:account/roster-revision).
   *  Cheap staleness probe, symmetric with fetchRemoteRevision for profile. */
  async fetchRemoteRosterRevision(
    address: S2SAddress,
  ): Promise<{ rosterRev: number }> {
    return this.getSigned<{ rosterRev: number }>(
      `/api/v1/s2s/group/${address.account}/roster-revision`,
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

    // Catch-up push: this federated stub just changed, so fan the fresh profile to every local friend
    // of this user — they refresh without each having to independently probe. Fire-and-forget so a slow
    // fan-out can't block the localization path. localizeForeignProfile's own "skip if not newer" guard
    // above means this only fires on a genuine profile change (no spam on a redelivered payload).
    void this.notifyPeersOfProfileUpdate(userId);

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
    const data = await this.prepareForeignProfileData(profile);
    return this.database.db.transaction(async (tx) => {
      await this.assertPeerResponseWritable(tx, peerToken);
      const userId = await this.ensureForeignUserInTransaction(
        tx,
        account,
        domain,
      );
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

  /**
   * Fan a PEER_PROFILE_UPDATED push to every approved P2P peer of `userId`, carrying the FULL fresh
   * profile so each recipient's conversation list (and open chat header) refreshes with no extra
   * round-trip. Two callers: (a) local self-edits — UserController.updateProfile / updateAvatar; (b)
   * the federated catch-up in localizeForeignProfile above. Best-effort: callers `void` it so a slow
   * fan-out never blocks the triggering request, and a user with no friends / a missing row is a no-op.
   */
  async notifyPeersOfProfileUpdate(userId: number): Promise<void> {
    const peerIds =
      await this.participantService.getActiveP2PPeerUserIds(userId);
    if (peerIds.length === 0) return;
    // Signal-only: the client receives { userId } and HTTP-pulls the fresh profile itself (queryUserInfo),
    // matching the project's SSE-signal-only convention. No profile payload on the wire.
    peerIds.forEach((peerId) =>
      this.sse.onPeerProfileUpdated(peerId, { userId }),
    );
  }

  /**
   * Chat-open staleness sync: probe the peer's /revision; if newer than the stub's remoteUpdatedAt,
   * re-pull the full profile and re-localize. Best-effort — any failure (peer unreachable, profile
   * fetch error) is swallowed so a transient peer outage never blocks opening the conversation; the
   * cached profile is shown as-is and the next open retries. Local users are a no-op (their own
   * updatedAt is authoritative; there's nothing to sync).
   */
  async syncForeignUserIfStale(userId: number): Promise<void> {
    const stub = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, userId),
      columns: {
        isForeigner: true,
        account: true,
        domain: true,
        remoteProfileRev: true,
      },
    });
    if (!stub || !stub.isForeigner) return;
    const address: S2SAddress = {
      account: stub.account,
      domain: stub.domain,
    };
    try {
      const peerToken = await this.capturePeerResponseToken(address.domain);
      const rev = await this.fetchRemoteRevision(address);
      if (
        stub.remoteProfileRev !== null &&
        rev.profileRev <= stub.remoteProfileRev
      ) {
        return; // fresh
      }
      const profile = await this.fetchRemoteUser(address);
      await this.localizeForeignProfile(userId, profile, { peerToken });
    } catch {
      // Best-effort: keep the cached profile. The next chat-open retries.
    }
  }
}
