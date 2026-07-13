import { Injectable, HttpStatus, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mintUlid, normalizeAccount, isValidAccount, isValidGroupAccount } from '../common/account.js';
import { PrismaService } from '../prisma.service.js';
import { UploadService } from '../upload/upload.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { QuotaService } from '../quota/quota.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { InviteService } from '../invite/invite.service.js';
import { SseService } from '../gateway/sse.service.js';
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';
import {
  ContentType,
  GroupRole,
  Message,
  MessageThreadType,
  Prisma,
} from '../prisma/generated/client.js';
import { derivePreview, stripMessageId, MessageService } from '../message/message.service.js';
import { FederationBufferService, type NewMsgMapEntry } from './federation-buffer.service.js';
import { extractDigestEntries } from '../upload/file-content.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'S2sResponseError';
    this.status = status;
    this.code = code;
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
  /** Debounce window for outbound hint flushes (a burst collapses to one push). */
  private static readonly FLUSH_DEBOUNCE_MS = 500;
  /** Entries per push request (each ~100 B → ~100 KB, under the 1 MiB body limit). */
  private static readonly FLUSH_BATCH = 1000;
  /** One debounced flush timer per dest domain (cleared in onModuleDestroy). */
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();
  /** Receiver-side debounce window: a group thread pulled within this skips a redundant whole-thread GET. */
  private static readonly GROUP_PULL_DEBOUNCE_MS = 500;
  /** Per-group-thread last pull timestamp (the receiver debounce on pullGroupWhole). */
  private readonly recentGroupPulls = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly signature: SignatureService,
    private readonly discovery: DiscoveryService,
    private readonly upload: UploadService,
    private readonly participantService: ThreadParticipantService,
    private readonly message: MessageService,
    private readonly invite: InviteService,
    private readonly sse: SseService,
    private readonly threadRevisionService: ThreadRevisionService,
    // ONE-WAY Fed → Buffer: the buffer is now PURE STORAGE (markDirty/snapshot/flushBatch); this class owns
    // signalOutbound + the debounce timer + flushDomain. The old two-way edge was a forwardRef cycle whose
    // `design:paramtypes` value references crashed ESM boot ("Cannot access 'FederationBufferService' before
    // initialization") — breaking it is what lets `node dist/src/main.js` start.
    private readonly buffer: FederationBufferService,
    private readonly quota: QuotaService,
  ) {}

  /** The wire address of a LOCAL user: { account, domain } (domain = our real config.domain). */
  localAddress(account: string): S2SAddress {
    return { account: account, domain: this.config.domain };
  }

  /** This server's domain (config.domain) — for address-domain comparison in controllers. */
  get ourDomain(): string {
    return this.config.domain;
  }

  // ─── outbound hint routing + debounced flush (owns what used to live in FederationBufferService) ────
  //
  // This class is the single owner of the outbound side: it ROUTES a new message to the right dest
  // domains (signalOutbound), WRITES the dirty hint to the pure-storage buffer, SCHEDULES a debounced
  // flush per domain, and FLUSHES over its own signed transport (pushNewMsgMap). The buffer holds no
  // timers + no back-reference here — a one-way Fed → Buffer edge (no cycle, no ESM TDZ).

  /** Hook for the local-send path (MessageController.sendMessage) + the pulled path (storePulledMessage):
   *  after a message lands, route the outbound hint. Best-effort — never throws into the caller. */
  async notifyOnSend(senderUserId: number, threadId: number, originSeq: number): Promise<void> {
    await this.signalOutbound(threadId, senderUserId, originSeq, undefined);
  }

  /** Best-effort: if a local user just left a federated GROUP MIRROR, nudge the origin so it discovers the
   *  leave (a normal per-author hint → the origin pulls → answers HTTP 410 GONE (FEDERATION_GROUP_AUTHOR_LEFT) →
   *  dissolves the leaver). No-op for a local group / when we ARE the origin. */
  async notifyGroupLeave(threadId: number, leaverUserId: number): Promise<void> {
    try {
      const trd = await this.prisma.messageThread.findUnique({
        where: { id: threadId },
        select: { groupUser: { select: { account: true, domain: true } } },
      });
      const originDomain = trd?.groupUser?.domain;
      if (!originDomain || originDomain === 'local') return; // origin / local group — no-op
      const groupAccount = trd.groupUser?.account;
      if (!groupAccount) return;
      const leaver = await this.prisma.user.findUnique({
        where: { id: leaverUserId },
        select: { account: true, domain: true, isForeigner: true },
      });
      if (!leaver) return;
      const cursor = await this.derivedOriginSeqCursor(threadId, leaverUserId);
      const latestSeq = Math.max(cursor + 1, 0);
      const leaverDomain = leaver.isForeigner ? leaver.domain : this.config.domain;
      // A NORMAL per-author hint (latestSeq beats the origin's derived cursor → the pull always fires).
      // The origin pulls → this mirror answers HTTP 410 (FEDERATION_GROUP_AUTHOR_LEFT — author soft-left) → the origin
      // softLeaveMemberAndBump's the leaver on its canonical roster. No `left` flag — the leave signal
      // lives on the per-author pull RESPONSE (the 50010 business code), not in the hint map.
      this.buffer.markDirty(originDomain, leaver.account, leaverDomain, groupAccount, latestSeq);
      this.scheduleFlush(originDomain);
    } catch (e) {
      this.logger.debug(`notifyGroupLeave(${threadId}) failed: ${(e as Error).message}`);
    }
  }

  /** The leaver's per-author origin-seq cursor on this thread (MAX over Message ∪ PendingMedia). Used by
   *  notifyGroupLeave so the leave hint's latestSeq beats the origin's per-author pull cursor (the origin
   *  pulls → sees the leaver soft-left → dissolves the roster entry). */
  private async derivedOriginSeqCursor(threadId: number, userId: number): Promise<number> {
    const [msg, pend] = await Promise.all([
      this.prisma.message.aggregate({
        where: { threadId, creator: userId },
        _max: { originSeq: true },
      }),
      this.prisma.pendingMedia.aggregate({
        where: { threadId, creatorId: userId },
        _max: { originSeq: true },
      }),
    ]);
    return Math.max(msg._max.originSeq ?? -1, pend._max.originSeq ?? -1);
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
        this.prisma.messageThread.findUnique({
          where: { id: threadId },
          select: { groupUser: { select: { account: true, domain: true } } },
        }),
        this.prisma.threadParticipant.findMany({
          where: { threadId, leftAt: null },
          include: { user: { select: { account: true, domain: true, isForeigner: true } } },
        }),
      ]);
      if (!trd) return;
      const author = participants.find((p) => p.userId === authorUserId);
      if (!author) return;
      const authorDomain = author.user.isForeigner ? author.user.domain : this.ourDomain;
      const authorAccount = author.user.account;

      const groupDomain = trd.groupUser?.domain; // 'local' = origin; <peer> = mirror; undefined = P2P
      if (!groupDomain) {
        // P2P (local-only or federated 1:1): signal each foreign peer participant EXCEPT the author + the
        // fetch source. A pulled P2P message's only foreign participant is the author → nobody to signal.
        for (const p of participants) {
          if (p.userId === authorUserId || !p.user.isForeigner) continue;
          if (fetchedFromDomain && p.user.domain === fetchedFromDomain) continue;
          this.buffer.markDirty(p.user.domain, authorAccount, authorDomain, p.user.account, latestSeq);
          this.scheduleFlush(p.user.domain);
        }
        return;
      }
      // GROUP federated. dest = (origin → all foreign member-domains; mirror → {originDomain}), minus the
      // fetch source. The `toAccount` is the group `!account` (one hint per foreign domain).
      const groupAccount = trd.groupUser?.account;
      if (!groupAccount) return;
      const destDomains = new Set<string>();
      if (groupDomain === 'local') {
        for (const p of participants) if (p.user.isForeigner) destDomains.add(p.user.domain);
      } else {
        destDomains.add(groupDomain);
      }
      if (fetchedFromDomain) destDomains.delete(fetchedFromDomain);
      for (const d of destDomains) {
        this.buffer.markDirty(d, authorAccount, authorDomain, groupAccount, latestSeq);
        this.scheduleFlush(d);
      }
    } catch (e) {
      // Never break the caller (send/pull path) — a transient DB error just skips this notify.
      this.logger.debug(`signalOutbound(${threadId}) failed: ${(e as Error).message}`);
    }
  }

  /** Schedule a debounced flush for a domain (one timer per domain; a burst collapses to one push). */
  private scheduleFlush(domain: string): void {
    if (this.flushTimers.has(domain)) return; // a flush is already pending
    const t = setTimeout(() => {
      this.flushTimers.delete(domain);
      void this.flushDomain(domain).catch((e) =>
        this.logger.debug(`flush ${domain} failed: ${(e as Error).message}`),
      );
    }, FederationService.FLUSH_DEBOUNCE_MS);
    this.flushTimers.set(domain, t);
  }

  /**
   * Flush ALL dirty entries for a domain to the peer, batched (FLUSH_BATCH per POST). On each batch's ack,
   * delete those entries; on failure, keep the rest buffered (the next notifyOnSend reschedules, and the
   * reconnect sweep retries directly). Safe to re-run — the receiver dedupes by originSeq.
   */
  async flushDomain(domain: string): Promise<void> {
    for (;;) {
      const batch = this.buffer.flushBatch(domain, FederationService.FLUSH_BATCH);
      if (batch.entries.length === 0) break;
      try {
        await this.pushNewMsgMap(domain, batch.entries, batch.hasMore);
        this.buffer.deleteKeys(domain, batch.keys); // acked → drop
      } catch {
        return; // leave the rest buffered; rescheduled on next notifyOnSend / sweep
      }
    }
    this.buffer.dropDomainIfEmpty(domain);
  }

  onModuleDestroy(): void {
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
  }

  /** Find a LOCAL user id by account (domain="local"). Null if not found / not local / soft-deleted.
   *  The isDeleted gate matters here because S2S bypasses the token system: the local /uploads/* path is
   *  protected from admin-disabled users by tokenVersion (invalidateAllSessions bumps it on disable), but
   *  /get_file never touches tokens — so a disabled user's media would still flow out over federation
   *  unless we reject the soft-deleted row here. */
  async findLocalUserId(account: string): Promise<number | null> {
    const u = await this.prisma.user.findUnique({
      where: { account_domain: { account: normalizeAccount(account), domain: 'local' } },
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
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
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
    const u = await this.prisma.user.findUnique({
      where: {
        account_domain: { account: normalizeAccount(address.account), domain: 'local' },
      },
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
    const u = await this.prisma.user.findUnique({
      where: {
        account_domain: { account: normalizeAccount(address.account), domain: 'local' },
      },
      select: { profileRev: true, isForeigner: true },
    });
    if (!u || u.isForeigner) return null;
    return { profileRev: u.profileRev };
  }

  /** Origin's roster revision for a group (GET /s2s/group/:account/roster-revision). Null if the group
   *  isn't local (not the origin) or has no Group row. `groupAccount` = the group's `!account`. */
  async getLocalGroupRosterRevision(groupAccount: string): Promise<{ rosterRev: number } | null> {
    const trd = await this.findGroupThread(groupAccount);
    if (!trd || !this.isOriginThread(trd) || trd.groupUserId == null) return null;
    const grp = await this.prisma.group.findUnique({
      where: { groupUserId: trd.groupUserId },
      select: { rosterRev: true },
    });
    return grp ? { rosterRev: grp.rosterRev } : null;
  }

  /** Find or create a foreign User stub for account@<peer-domain>. Stubs never authenticate. */
  async ensureForeignUser(account: string, domain: string): Promise<number> {
    const acct = normalizeAccount(account); // case-insensitive
    const existing = await this.prisma.user.findUnique({
      where: { account_domain: { account: acct, domain } },
    });
    if (existing) return existing.id;
    const created = await this.prisma.user.create({
      data: {
        account: acct,
        domain,
        isForeigner: true,
        hashPwd: randomUUID(), // unusable — stubs never log in
        name: acct,
        avatar: '',
        bio: '',
      },
    });
    return created.id;
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
    const stub = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { remoteProfileRev: true },
    });
    if (!stub || stub.remoteProfileRev !== null) return; // already localized (or gone)
    const profile = await this.fetchRemoteUser(address);
    await this.localizeForeignProfile(userId, profile);
  }

  /** Sign + synchronously POST an arbitrary JSON body to a peer S2S path (`${base}${path}`). The single
   *  signed-POST entry for every outbound S2S op — friend-request / friend-approve (Step 1) AND the
   *  new-msg-map push (Step 2). Same liveness/demote wiring as getSigned. */
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
    );
  }

  /** GET a signed S2S endpoint (users / revision). Returns the parsed JSON. Throws on non-success. */
  private async getSigned<T>(path: string, peerDomain: string): Promise<T> {
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}${path}`);
    const headers = this.signature.signOutbound({
      method: 'GET',
      path: url.pathname,
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
      );
    }
    await this.markContactSuccess(peerDomain);
    return (await res.json()) as T;
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
    const existing = await this.prisma.federatedPeer.findUnique({
      where: { domain },
    });
    if (existing?.trustLevel === 'trusted') return; // mutual trust already established
    if (existing?.trustLevel === 'blocked') {
      // Admin intent — refuse to (re-)handshake. Surfaced as FEDERATION_PEER_BLOCKED (distinct from a
      // delivery failure) so the client can show "blocked by your admin" rather than "unreachable".
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_BLOCKED,
        `${domain} is blocked by an admin`,
        HttpStatus.FORBIDDEN,
      );
    }
    // Confirm they're a real SOMS peer (public .well-known fetch over HTTPS; also warms their key cache
    // so the signature on their reply traffic verifies without a cold fetch).
    await this.discovery.fetchWellKnown(domain);
    // Bootstrap mutual trust: they auto-accept us on verifying this init's signature.
    await this.sendInit(domain);
    // They trust us now → trust them back (idempotent + transition-aware: logs discovered/trusted).
    await this.markTrusted(domain);
  }

  /** Whether mutual trust with a peer domain is ALREADY established — a pure local lookup of the
   *  FederatedPeer allow-list (a row at trustLevel 'trusted'). No network, no side effects. Our own
   *  domain always reads trusted (a account@<our-domain> query is a local lookup, never a handshake).
   *
   *  Used by the user-facing pre-flight (POST /user/peer-trust-status) so the client can tell
   *  FIRST-CONTACT — a handshake IS expected during the upcoming resolve, so show a "Connecting to
   *  <domain>…" affordance — from an already-trusted resolve (fast, no banner). This is a known
   *  server-side fact, NOT a latency guess: the rare already-trusted-but-failing case (the peer reset
   *  its server and lost the prior handshake, or rotated a broken key) re-handshakes inside the resolve
   *  and surfaces as an error there, not here. */
  async isPeerTrusted(domain: string): Promise<boolean> {
    if (domain === this.config.domain) return true;
    const existing = await this.prisma.federatedPeer.findUnique({
      where: { domain },
    });
    return existing?.trustLevel === 'trusted';
  }

  // ─── trust lifecycle (state machine + audit log) ──────────────────────────────
  //
  // FederatedPeer holds the CURRENT state (the cheap read path); FederatedPeerEvent is the append-only
  // log of every transition (the admin timeline). FederationService is the single owner: every
  // transition — runtime (init, op success/failure) and admin (block/unblock) — flows through these
  // methods, so the row + the event stay consistent. State machine:
  //   pending ──init ok──► trusted ──op failed──► demoted ──init ok──► trusted …   (+ blocked: admin)

  /** Best-practice liveness watermark window. "Last successful contact" is an admin observability
   *  signal whose consumer needs MINUTE granularity (is this peer up?), not sub-second — so write
   *  frequency is matched to that real precision need (see markContactSuccess). The window is the
   *  precision knob: lower it if a consumer genuinely needs finer. */
  private static readonly LAST_SUCCESS_WINDOW_MS = 60_000;
  /** Per-domain in-memory guard so the hot S2S path skips the liveness DB round trip entirely within
   *  the window (59 of 60 ops do zero DB work). Bounded by the (small) trusted-peer count; resets on
   *  restart — the conditional write below keeps correctness across restart + instances. */
  private readonly lastSuccessSentAt = new Map<string, number>();

  /** The single source of truth for trust establishment — used by outbound ensurePeerTrusted and the
   *  inbound S2sInitController. Idempotent + transition-aware: writes the FederatedPeer row AND the
   *  matching FederatedPeerEvent(s).
   *  - no row yet        → create `trusted`, stamp trustedAt/lastSuccessAt, log `discovered` + `trusted`.
   *  - `blocked`         → NO-OP (do not silently re-trust an admin-blocked peer).
   *  - pending | demoted → promote to `trusted`, reset trustedAt/lastSuccessAt, clear demote fields, log `trusted`.
   *  - already `trusted` → refresh lastSuccessAt only (idempotent re-init; no event spam). */
  async markTrusted(
    domain: string,
    opts?: { addedBy?: string },
  ): Promise<void> {
    const existing = await this.prisma.federatedPeer.findUnique({
      where: { domain },
    });
    const now = new Date();
    if (!existing) {
      await this.prisma.federatedPeer.create({
        data: {
          domain,
          trustLevel: 'trusted',
          addedBy: opts?.addedBy ?? null,
          trustedAt: now,
          lastSuccessAt: now,
          demotionCount: 0,
        },
      });
      await this.logEvent(domain, 'discovered');
      await this.logEvent(domain, 'trusted');
      return;
    }
    if (existing.trustLevel === 'blocked') return; // respect admin intent
    if (existing.trustLevel === 'trusted') {
      // Idempotent re-init: advance liveness, no transition, no event.
      await this.prisma.federatedPeer.update({
        where: { domain },
        data: { lastSuccessAt: now },
      });
      return;
    }
    // pending | demoted → (re-)establish trust.
    await this.prisma.federatedPeer.update({
      where: { domain },
      data: {
        trustLevel: 'trusted',
        trustedAt: now,
        lastSuccessAt: now,
        demotedAt: null,
        demoteReason: null,
      },
    });
    await this.logEvent(domain, 'trusted');
  }

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
      await this.prisma.federatedPeer.updateMany({
        where: {
          domain,
          OR: [
            { lastSuccessAt: null },
            {
              lastSuccessAt: {
                lt: new Date(now - FederationService.LAST_SUCCESS_WINDOW_MS),
              },
            },
          ],
        },
        data: { lastSuccessAt: new Date(now) },
      });
    } catch {
      // Best-effort liveness watermark — never break the caller's op.
    }
  }

  /** Record a failed signed S2S op. Always refreshes the latest failure (demotedAt + demoteReason) so
   *  the admin sees the most recent error; if the peer was `trusted` or `pending`, this is a real
   *  trusted→demoted transition — flip the state, bump demotionCount, log a `demoted` event, and PURGE
   *  the cached signing keys (a stale/rotated key is the likely cause; the next ensurePeerTrusted
   *  re-fetches them). `blocked` is admin intent → no-op. Self-healing: a demoted peer re-runs the init
   *  handshake on the next resolve (ensurePeerTrusted sees non-trusted). */
  async markDemoted(domain: string, reason: string): Promise<void> {
    const existing = await this.prisma.federatedPeer.findUnique({
      where: { domain },
    });
    if (!existing || existing.trustLevel === 'blocked') return;
    const now = new Date();
    const transitioned =
      existing.trustLevel === 'trusted' || existing.trustLevel === 'pending';
    await this.prisma.federatedPeer.update({
      where: { domain },
      data: {
        ...(transitioned
          ? { trustLevel: 'demoted', demotionCount: { increment: 1 } }
          : {}),
        demotedAt: now,
        demoteReason: reason.slice(0, 255),
      },
    });
    if (transitioned) {
      await this.prisma.s2SKeyCache.deleteMany({ where: { domain } });
      await this.logEvent(domain, 'demoted', reason);
    }
  }

  /** Admin block: forbid federation with a peer (ensurePeerTrusted refuses to re-handshake; the inbound
   *  guard rejects it since trustLevel !== 'trusted'). Idempotent. Logs a `blocked` event. */
  async markBlocked(domain: string, note?: string): Promise<void> {
    const existing = await this.prisma.federatedPeer.findUnique({
      where: { domain },
    });
    if (existing?.trustLevel === 'blocked') return;
    const now = new Date();
    await this.prisma.federatedPeer.upsert({
      where: { domain },
      create: { domain, trustLevel: 'blocked', blockedAt: now },
      update: { trustLevel: 'blocked', blockedAt: now },
    });
    await this.logEvent(domain, 'blocked', note);
  }

  /** Admin unblock: move the peer to `pending` so the next contact re-runs the init handshake to
   *  re-establish trust (it is NOT auto-re-trusted). Logs an `unblocked` event. No-op if not blocked. */
  async markUnblocked(domain: string): Promise<void> {
    const existing = await this.prisma.federatedPeer.findUnique({
      where: { domain },
    });
    if (!existing || existing.trustLevel !== 'blocked') return;
    await this.prisma.federatedPeer.update({
      where: { domain },
      data: { trustLevel: 'pending', blockedAt: null },
    });
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
      await this.prisma.federatedPeerEvent.create({
        data: { domain, type, reason: reason ? reason.slice(0, 255) : null },
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
    const where = {
      ...(opts.search
        ? { domain: { contains: opts.search, mode: 'insensitive' as const } }
        : {}),
      ...(opts.status ? { trustLevel: opts.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.federatedPeer.findMany({
        where,
        skip: opts.skip,
        take: opts.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.federatedPeer.count({ where }),
    ]);
    return { list, total };
  }

  /** Admin timeline: a peer's lifecycle events, newest-first. */
  async peerEvents(domain: string, take = 100) {
    return this.prisma.federatedPeerEvent.findMany({
      where: { domain },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Send a signed POST /api/v1/s2s/init to a peer so they auto-accept us into their allow-list. The
   *  body is minimal (`{}`); the signature (covering its content-digest) + keyId is what proves domain
   *  ownership. Throws on network/timeout/reject — the caller surfaces it. */
  private async sendInit(peerDomain: string): Promise<void> {
    const base = await this.discovery.resolveBase(peerDomain);
    const url = new URL(`${base}/api/v1/s2s/init`);
    const body = '{}';
    const headers = this.signature.signOutbound({
      method: 'POST',
      path: url.pathname,
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
  }): Promise<void> {
    const from = await this.requireLocalUser(params.fromLocalUserId);
    const payload: S2SInvite = {
      id: mintUlid(),
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
      const trd = await this.prisma.messageThread.findUnique({
        where: { id: params.threadId! },
        select: { curSeq: true, pullUntil: true, groupUser: { select: { domain: true } } },
      });
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
    await this.postSigned('/api/v1/s2s/invite', JSON.stringify(payload), params.to.domain);
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

  // ─── Step 3: cross-server group threads (origin-hub) ────────────────────────

  /** Ensure an origin group thread carries its federated id + originDomain (lazy, at the first
   *  cross-server invite — group.create itself is federation-agnostic). The federated id IS the group's
   *  `!account` (globally unique ULID) — the same value on the origin and every mirror, so it doubles as
   *  the on-wire group address (`to` / `group`), never an internal thread id. Idempotent. Returns it. */
  /** Return the group's federated id (its `!account`, the on-wire group address `to`/`group`). The id
   *  IS the group !-User row's account — set at group.create, so no lazy stamping is needed (the former
   *  fedGroupAccount/originDomain columns were folded into groupUser.account / groupUser.domain). */
  async ensureOriginFederatedId(threadId: number): Promise<string> {
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { groupUser: { select: { account: true } } },
    });
    if (!trd) throw new Error(`thread ${threadId} not found`);
    if (!trd.groupUser) throw new Error(`thread ${threadId} has no group user`);
    return trd.groupUser.account;
  }

  /** Whether THIS server is the origin (roster + history authority) of a group thread: the group
   *  !-User row is homed locally (domain='local'). True for purely-local groups AND federated origins;
   *  false for a federated mirror (groupUser.domain = the origin's domain). */
  private isOriginThread(trd: { groupUser: { domain: string } | null }): boolean {
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
    return this.prisma.user.findUnique({
      where: { account_domain: { account: normalizeAccount(account), domain } },
      select: { id: true, isForeigner: true },
    });
  }

  /** Resolve a group `!account` to its local thread (origin or mirror). The group account is the
   *  `!`-sigil User row's account (globally unique ULID) — looked up via the groupUser relation now that
   *  fedGroupAccount was folded into groupUser.account. findFirst: a server holds at most one thread per
   *  group (origin XOR mirror). Null if no such group here. */
  private async findGroupThread(groupAccount: string): Promise<{
    id: number;
    type: MessageThreadType;
    groupUserId: number | null;
    groupUser: { account: string; domain: string } | null;
  } | null> {
    return this.prisma.messageThread.findFirst({
      where: { groupUser: { account: normalizeAccount(groupAccount), isGroup: true } },
      select: {
        id: true,
        type: true,
        groupUserId: true,
        groupUser: { select: { account: true, domain: true } },
      },
    });
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
    if (body.profile) await this.localizeForeignProfile(foreignId, body.profile);
    const localId = await this.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${to.account} not found`,
        HttpStatus.NOT_FOUND,
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
    this.sse.onNotify(
      localId,
      serializeBody({ event: 'NOTIFY', type: 'FRIEND_REQUEST', fromUserId: foreignId, inviteId }),
    );
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
        HttpStatus.NOT_FOUND,
      );
    }
    // The inviter's stub must already exist (a passing friend gate ⇒ they're already friends ⇒ the stub
    // was created when they befriended). LOOK IT UP (don't ensure/create) — missing ⇒ not friends.
    const byStub = await this.prisma.user.findUnique({
      where: { account_domain: { account: normalizeAccount(by.account), domain: by.domain } },
    });
    if (byStub === null) {
      throw new BusinessException(BusinessCode.FORBIDDEN, 'not friends', HttpStatus.FORBIDDEN);
    }
    const byStubId = byStub.id;
    const p2pThreadId = await this.participantService.findP2PThreadBetween(byStubId, localId);
    if (p2pThreadId === null) {
      throw new BusinessException(BusinessCode.FORBIDDEN, 'not friends', HttpStatus.FORBIDDEN);
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
    const mirror = await this.prisma.messageThread.findUnique({
      where: { id: mirrorThreadId },
      select: { groupUserId: true },
    });
    const gu =
      mirror?.groupUserId != null
        ? await this.prisma.user.findUnique({
            where: { id: mirror.groupUserId },
            select: { remoteProfileRev: true, avatar: true },
          })
        : null;
    const rev = body.groupRevision ?? 0;
    const stale = gu == null || gu.remoteProfileRev == null || gu.remoteProfileRev < rev;
    let avatarUrl = gu?.avatar ?? '';
    if (stale && mirror?.groupUserId != null) {
      avatarUrl = body.groupAvatar ? await this.upload.saveAvatarFromWire(body.groupAvatar) : avatarUrl;
      await this.prisma.user.update({
        where: { id: mirror.groupUserId },
        data: {
          name: (body.groupName ?? '').slice(0, 255),
          avatar: avatarUrl,
          remoteProfileRev: rev,
        },
      });
    }
    // Mint the inbound Invite. NO card write — the card is the SENDER's responsibility (written into the
    // sender's P2P mirror), delivered to this server via the Step-2 message pull in Phase B. Phase A
    // ships the machinery (Invite + mirror + accept + roster fanout); the invitee's visible card arrives
    // with Phase-B messaging.
    await this.invite.createGroupInvite(byStubId, mirrorThreadId, localId, body.note ?? '', {
      origin: body.origin,
      originId: body.id,
    });
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
        HttpStatus.NOT_FOUND,
      );
    }
    const { threadId, created } = await this.invite.applyInboundFriendApprove(localId, foreignId);
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
        HttpStatus.NOT_FOUND,
      );
    }
    const accepterStubId = await this.ensureForeignUser(accepter.account, accepter.domain);
    await this.participantService.upsertMember(trd.id, accepterStubId, GroupRole.MEMBER);
    // Bump the roster revision so mirrors re-pull the roster on the next chat-open (lazy meta-pull).
    // The former bump-User.updatedAt hack is replaced by Group.rosterRev++ (identity is untouched).
    if (trd.groupUserId != null) {
      await this.prisma.group.update({
        where: { groupUserId: trd.groupUserId },
        data: { rosterRev: { increment: 1 } },
      });
    }
  }

  // ─── roster meta-pull (lazy, on chat-open — same shape as the profile sync) ──────────

  /** ORIGIN serves the canonical roster for a federated group (GET /s2s/group/:account/roster).
   *  Members carry WIRE addresses (a local member's domain is our real domain, never the "local" sentinel)
   *  so the pulling mirror can ensureForeignUser each. */
  async serveGroupRoster(
    groupAccount: string,
  ): Promise<{ members: { account: string; domain: string; role: GroupRole }[] } | null> {
    const trd = await this.findGroupThread(groupAccount);
    if (trd == null) return null;
    const rows = await this.prisma.threadParticipant.findMany({
      where: { threadId: trd.id, leftAt: null },
      select: { role: true, user: { select: { account: true, domain: true } } },
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
  ): Promise<{ members: { account: string; domain: string; role: GroupRole }[] } | null> {
    try {
      return await this.getSigned<{
        members: { account: string; domain: string; role: GroupRole }[];
      }>(`/api/v1/s2s/group/${encodeURIComponent(groupAccount)}/roster`, originDomain);
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
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: {
        groupUserId: true,
        groupUser: {
          select: {
            account: true,
            domain: true,
            remoteProfileRev: true,
            group: { select: { rosterRev: true, remoteRosterRev: true } },
          },
        },
      },
    });
    const gu = trd?.groupUser;
    if (!gu || gu.domain === 'local' || trd?.groupUserId == null) return;
    const groupUserId = trd.groupUserId;
    const grp = gu.group;
    const address: S2SAddress = { account: gu.account, domain: gu.domain };
    try {
      let profileChanged = false;
      let rosterChanged = false;
      const rev = await this.fetchRemoteRevision(address);
      if (gu.remoteProfileRev == null || rev.profileRev > gu.remoteProfileRev) {
        const profile = await this.fetchRemoteUser(address);
        await this.localizeForeignProfile(groupUserId, profile);
        profileChanged = true;
      }
      if (grp) {
        const rrev = await this.fetchRemoteRosterRevision(address);
        if (grp.remoteRosterRev == null || rrev.rosterRev > grp.remoteRosterRev) {
          const roster = await this.pullGroupRoster(gu.account, gu.domain);
          if (roster) {
            await this.reconcileRoster(threadId, roster.members);
            await this.prisma.group.update({ where: { groupUserId }, data: { remoteRosterRev: rrev.rosterRev } });
            rosterChanged = true;
          }
        }
      }
      if (profileChanged || rosterChanged) {
        const members = await this.participantService.getActiveParticipantUserIds(threadId);
        members.forEach((m) => {
          if (profileChanged) this.sse.onGroupEvent(m.userId, 'GROUP_UPDATED', { threadId });
          if (rosterChanged) this.sse.onGroupEvent(m.userId, 'GROUP_ROSTER_UPDATED', { threadId });
        });
      }
    } catch {
      // Best-effort — keep the cached meta; the next chat-open retries.
    }
  }

  /** Chat-open MESSAGE catch-up for a federated group MIRROR — the group twin of P2P's
   *  syncMessagesWithPeerByStubId. Pulls the whole thread from the origin (force — bypass the receiver
   *  debounce; an explicit open wants the freshest now), and storePulledMessage SSE-fans any newly-pulled
   *  messages to local members (= the "update → SSE push" step, reused verbatim from the push path).
   *
   *  This is the durable recovery for a group hint dropped by the debounce, or a transiently-lost push with
   *  no follow-up: without it, such a message sits on the origin until the NEXT message in the group
   *  re-triggers a pull (P2P already self-heals on every open; now groups do too). No-op for the origin and
   *  for a purely-local group — their messages are already local and were delivered via onNewMessage on
   *  send (the "local is simple" case). Best-effort + fire-and-forget-friendly: never blocks opening; a
   *  transient origin failure retries on the next open. */
  async syncGroupMessagesOnOpen(threadId: number): Promise<void> {
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { groupUser: { select: { account: true, domain: true } } },
    });
    // Only a federated MIRROR pulls here (groupUser.domain is the origin's domain, not 'local'). Origin /
    // local group: nothing to do (messages already local).
    const gu = trd?.groupUser;
    if (!gu || gu.domain === 'local') return;
    try {
      await this.pullGroupWhole(threadId, gu.domain, gu.account, true);
    } catch {
      // Best-effort — keep the cached thread; the next open / push retries.
    }
  }

  /** Reconcile a mirror's FOREIGN roster to match the origin's authoritative roster: upsert present
   *  foreign members, soft-leave active foreign members no longer on the origin. Local members are
   *  managed locally (a member with domain == ours IS a local user — skipped, never re-stubbed). */
  private async reconcileRoster(
    threadId: number,
    members: { account: string; domain: string; role: GroupRole }[],
  ): Promise<void> {
    const originForeignIds = new Set<number>();
    for (const m of members) {
      if (m.domain === this.config.domain) continue; // a local user (us) — managed locally
      const stubId = await this.ensureForeignUser(m.account, m.domain);
      originForeignIds.add(stubId);
      await this.participantService.upsertMember(threadId, stubId, m.role);
    }
    const localForeign = await this.prisma.threadParticipant.findMany({
      where: { threadId, leftAt: null, user: { isForeigner: true } },
      select: { userId: true },
    });
    for (const p of localForeign.filter((p) => !originForeignIds.has(p.userId))) {
      await this.participantService.softLeaveMember(threadId, p.userId);
    }
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
    const existing = await this.prisma.messageThread.findFirst({
      where: { groupUser: { account: normalizeAccount(params.fedGroupAccount), isGroup: true } },
      select: { id: true },
    });
    if (existing) return existing.id;
    // The mirror group-user REUSES the origin's `!account` (== fedGroupAccount) under the origin's domain
    // (account_domain uniqueness holds since the origin stores it under 'local').
    const groupUser = await this.prisma.user.create({
      data: {
        account: params.fedGroupAccount,
        domain: params.originDomain,
        isForeigner: true,
        isGroup: true,
        hashPwd: '', // empty — mirror group-user never logs in
        name: params.name.slice(0, 255),
        avatar: '',
        bio: '',
      },
    });
    const trd = await this.prisma.messageThread.create({
      data: {
        type: MessageThreadType.GROUP,
        groupUserId: groupUser.id,
        // Seed pullUntil from the invite's sinceSeq so the member pulls from invite-time latest, not the
        // full pre-join history. -1 (no sinceSeq) ⇒ pull everything (the safe default for an empty group).
        pullUntil: params.sinceSeq ?? -1,
      },
    });
    // Group-exclusive state: owner + roster revision. remoteRosterRev stays null until the first probe.
    await this.prisma.group.create({
      data: { groupUserId: groupUser.id, ownerId: params.ownerStubId, rosterRev: 0 },
    });
    // Record the origin owner on the mirror (roster authority is the origin).
    await this.prisma.threadParticipant.create({
      data: { userId: params.ownerStubId, threadId: trd.id, role: GroupRole.OWNER },
    });
    return trd.id;
  }

  /** True if (origin, opId) already applied. Reuses S2SFriendOpSeen as the generic op-seen table (the
   *  name is historical — it is just an (origin, opId) dedup index). Race-safe (P2002 = concurrent dup). */
  private async isOpSeen(origin: string, opId: string): Promise<boolean> {
    const existing = await this.prisma.s2SFriendOpSeen.findUnique({
      where: { origin_opId: { origin, opId } },
    });
    if (existing) return true;
    try {
      await this.prisma.s2SFriendOpSeen.create({ data: { origin, opId } });
      return false;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
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
   * Push a batch of OUR outbound hint entries (dirty conversations) to the peer's /new-msg-map. The
   * caller (FederationBufferService) deletes the pushed entries on success; on failure they stay
   * buffered and the debounce / reconnect sweep retries. `origin` is carried explicitly and the
   * receiver's guard binding-checks it === the signer domain. See §3.1.
   */
  async pushNewMsgMap(
    domain: string,
    entries: NewMsgMapEntry[],
    hasMore: boolean,
  ): Promise<void> {
    await this.withTrustedPeer(domain, () =>
      this.postSigned(
        '/api/v1/s2s/new-msg-map',
        JSON.stringify({
          origin: this.config.domain,
          entries,
          hasMore,
          generatedAt: Date.now(),
        }),
        domain,
      ),
    );
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

  /** Outbound signed GET of the peer's /new-msg-map (the one-directional fallback, §4.3) — the reconnect
   *  sweep harvests the peer's outbound hints for OUR users on recovery. Paginated by cursor. */
  async pullPeerNewMsgMap(
    domain: string,
    cursor: number,
  ): Promise<{
    entries: NewMsgMapEntry[];
    cursor: number | null;
    hasMore: boolean;
  }> {
    return this.getSigned(
      `/api/v1/s2s/new-msg-map?take=1000&cursor=${cursor}`,
      domain,
    );
  }

  /** Domains needing recovery (pending | demoted) — the reconnect sweep's work list. */
  async listRecoverablePeerDomains(): Promise<string[]> {
    const rows = await this.prisma.federatedPeer.findMany({
      where: { trustLevel: { in: ['pending', 'demoted'] } },
      select: { domain: true },
    });
    return rows.map((r) => r.domain);
  }

  /** Trusted peer domains — the slow poll's work list (it pulls their /new-msg-map to catch lost pushes
   *  via the one-directional fallback, §4.4). */
  async listTrustedPeerDomains(): Promise<string[]> {
    const rows = await this.prisma.federatedPeer.findMany({
      where: { trustLevel: 'trusted' },
      select: { domain: true },
    });
    return rows.map((r) => r.domain);
  }

  /**
   * Pull-on-thread-open (§4.4): drain everything available for the conversation between a local user
   * and a foreign stub. The restart floor for the volatile hint map — opening the chat catches up even
   * if every push was lost (or after a process restart). Fire-and-forget (never blocks opening); one cheap
   * GET when already current. Enqueues a MAX latestSeq hint + drains (the drain dedupes vs the local
   * cursor, so a MAX hint pulls only the genuine gap).
   */
  async syncMessagesWithPeerByStubId(
    stubUserId: number,
    localUserId: number,
  ): Promise<void> {
    const [stub, local] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: stubUserId },
        select: { account: true, domain: true, isForeigner: true },
      }),
      this.prisma.user.findUnique({
        where: { id: localUserId },
        select: { account: true, isForeigner: true },
      }),
    ]);
    if (!stub || !stub.isForeigner || !local || local.isForeigner) return;
    this.receiveNewMsgMapPush(stub.domain, [
      {
        fromAccount: stub.account,
        fromDomain: stub.domain,
        toAccount: local.account,
        latestSeq: Number.MAX_SAFE_INTEGER,
      },
    ]);
  }

  /**
   * Serve the SENDER's side of a 1:1 thread for a federated pull (GET /api/v1/s2s/messages). Returns
   * messages authored by OUR local user `fromAccount` for the peer user `toAccount` (a foreign stub on
   * signerDomain), with originSeq > `after`, ascending — the receiver stores them + advances its cursor.
   * Pulls ONLY the sender's side (never the requester's own authored messages). Gate 2: the from↔to Friendship MUST be
   * APPROVED (else 403 FORBIDDEN — also the lazy-unfriend signal of §9.4). Media digests are NOT
   * surfaced separately: the receiver extracts them from `content` via the same extractDigests() helper
   * the sender used, then fetches each via /get_file (§3.3).
   */
  async serveOutboundMessages(
    fromAccount: string,
    toAccount: string,
    signerDomain: string,
    after: number,
    take: number,
  ) {
    const { fromId, threadId } = await this.resolveFriendshipThread(
      fromAccount,
      toAccount,
      signerDomain,
    );
    const rows = await this.prisma.message.findMany({
      where: { threadId, creator: fromId, originSeq: { gt: after } },
      orderBy: { originSeq: 'asc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const messages = (hasMore ? rows.slice(0, take) : rows).map((m) => ({
      originSeq: m.originSeq ?? 0,
      contentType: m.contentType,
      content: m.content,
      ts: m.createdAt.getTime(),
    }));
    const latest = await this.prisma.message.aggregate({
      where: { threadId, creator: fromId },
      _max: { originSeq: true },
    });
    return { messages, latestSeq: latest._max.originSeq ?? -1, hasMore }; // 0-indexed: empty → -1
  }

  /** GET /api/v1/s2s/messages/before — the BACKWARD twin of serveOutboundMessages (reserved for external
   *  federation implementations; SOMS's own transport is forward-only). Returns messages with
   *  `seq < beforeSeq` (or, when `beforeSeq < 0`, the latest `take` with no upper bound), ordered so the
   *  batch is OLDEST-FIRST (descending query + reverse) for direct prepend. Same friendship gate + 0-indexed seq space. */
  async serveOutboundMessagesBefore(
    fromAccount: string,
    toAccount: string,
    signerDomain: string,
    beforeSeq: number,
    take: number,
  ) {
    const { fromId, threadId } = await this.resolveFriendshipThread(
      fromAccount,
      toAccount,
      signerDomain,
    );
    const rows = await this.prisma.message.findMany({
      where: {
        threadId,
        creator: fromId,
        ...(beforeSeq >= 0 ? { originSeq: { lt: beforeSeq } } : {}),
      },
      orderBy: { originSeq: 'desc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    // Desc query (newest-below-beforeSeq first) → slice → reverse to oldest-first so a caller prepends.
    const batch = (hasMore ? rows.slice(0, take) : rows).slice().reverse();
    const messages = batch.map((m) => ({
      originSeq: m.originSeq ?? 0,
      contentType: m.contentType,
      content: m.content,
      ts: m.createdAt.getTime(),
    }));
    const latest = await this.prisma.message.aggregate({
      where: { threadId, creator: fromId },
      _max: { originSeq: true },
    });
    return { messages, latestSeq: latest._max.originSeq ?? -1, hasMore };
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
        HttpStatus.NOT_FOUND,
      );
    }
    const participants = await this.prisma.threadParticipant.findMany({
      where: { threadId: trd.id, leftAt: null },
      include: { user: { select: { account: true, domain: true, isForeigner: true } } },
    });
    const signerIsMember = participants.some(
      (p) => this.effectiveDomain(p.user) === signerDomain,
    );
    if (!signerIsMember) {
      throw new BusinessException(BusinessCode.FORBIDDEN, 'not a member', HttpStatus.FORBIDDEN);
    }
    let authorId: number | undefined;
    if (fromAccount && fromDomain) {
      const author = participants.find(
        (p) =>
          p.user.account === normalizeAccount(fromAccount) &&
          this.effectiveDomain(p.user) === fromDomain,
      );
      if (!author) {
        throw new BusinessException(BusinessCode.FORBIDDEN, 'author not a member', HttpStatus.FORBIDDEN);
      }
      authorId = author.userId;
    }
    return { threadId: trd.id, authorId };
  }

  /** Resolve a per-author group pull's author membership with a LEAVE signal: an ACTIVE author → its
   *  userId; a SOFT-LEFT (or absent) author → throws BusinessException(FEDERATION_GROUP_AUTHOR_LEFT,
   *  HttpStatus.GONE) — the serving endpoint answers HTTP 410 GONE (body carries the business code) INSTEAD
   *  of a message payload. Distinct from resolveGroupThreadAccess's author check (which 403s) — this is
   *  the one path where "author no longer active" is a NORMAL outcome (the member left), not a forbidden
   *  one, so the origin reading it dissolves the leaver. 410 is a resource response, so getSigned does NOT
   *  demote the peer. Domain-matched via effectiveDomain (a foreign author stub on `fromDomain` matches;
   *  locals surface as our domain). See design-review item C2. */
  private async resolveGroupAuthorOrLeave(
    threadId: number,
    fromAccount: string,
    fromDomain: string,
  ): Promise<{ authorId: number }> {
    const p = await this.prisma.threadParticipant.findFirst({
      where: { threadId, user: { account: normalizeAccount(fromAccount) } },
      select: { userId: true, leftAt: true, user: { select: { isForeigner: true, domain: true } } },
    });
    if (!p || this.effectiveDomain(p.user) !== fromDomain || p.leftAt !== null) {
      throw new BusinessException(
        BusinessCode.FEDERATION_GROUP_AUTHOR_LEFT,
        `author ${fromAccount}@${fromDomain} left the group`,
        HttpStatus.GONE,
      );
    }
    return { authorId: p.userId };
  }

  /** Soft-leave a member on OUR canonical roster + bump the group-meta revision (the `!`-User.updatedAt
   *  mirrors compare on chat-open) so mirrors reconcile. Called when the ORIGIN detects a member left a
   *  mirror — the per-author hub-leg pull answered HTTP 410 (FEDERATION_GROUP_AUTHOR_LEFT). */
  private async softLeaveMemberAndBump(threadId: number, userId: number): Promise<void> {
    await this.participantService.softLeaveMember(threadId, userId);
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { groupUserId: true },
    });
    if (trd?.groupUserId != null) {
      await this.prisma.user.update({
        where: { id: trd.groupUserId },
        data: { updatedAt: new Date() },
      });
    }
  }

  /**
   * ALL-SENDERS group pull (mirror ← origin): serve every message in the group thread with thread `seq`
   * > `after`, ascending, across ALL creators. Each message carries its thread `seq` (the mirror's
   * pullUntil cursor — advanced page-by-page to the last stored message's seq, NOT jumped to the thread
   * max, so a >`take`-message catch-up fetches every page without skipping the middle) + its creator's
   * wire address (so the mirror resolves the right stub) + the copied `originSeq` (the dedup key).
   * Roster-gated. The one place serving is keyed by thread `seq` (a global per-thread order) rather than
   * per-author originSeq: a multi-author stream has no single originSeq space. See plan "Cursor model". */
  async serveOutboundMessagesGroup(
    groupAccount: string,
    after: number,
    take: number,
    signerDomain: string,
  ) {
    const { threadId } = await this.resolveGroupThreadAccess(
      groupAccount,
      undefined,
      undefined,
      signerDomain,
    );
    const rows = await this.prisma.message.findMany({
      where: { threadId, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: take + 1,
      include: { creatorItem: { select: { account: true, domain: true, isForeigner: true } } },
    });
    const hasMore = rows.length > take;
    const messages = (hasMore ? rows.slice(0, take) : rows).map((m) => ({
      seq: m.seq, // origin thread seq — the mirror advances pullUntil to this, page-by-page
      originSeq: m.originSeq ?? 0,
      creator: {
        account: m.creatorItem.account,
        domain: this.effectiveDomain(m.creatorItem),
      },
      contentType: m.contentType,
      content: m.content,
      ts: m.createdAt.getTime(),
    }));
    // latestSeq = the highest seq in THIS batch (the cursor the receiver lands on after storing it), NOT
    // the thread total — so a multi-page catch-up walks every page. -1 only when the batch is empty.
    const latestSeq = messages.length > 0 ? messages[messages.length - 1].seq : -1;
    return { messages, latestSeq, hasMore };
  }

  /**
   * PER-AUTHOR group pull (origin ← mirror, the hub aggregation leg): serve the author `fromAccount`'s
   * messages in the group with originSeq > `after` (originSeq space). The origin pulls each member-server's
   * NEW messages this way to aggregate them; the origin's cursor for a member is derived MAX(originSeq) per
   * author. Roster-gated; the author gate carries a LEAVE signal — a soft-left (or absent) author makes resolveGroupAuthorOrLeave throw, so the controller answers HTTP 410 GONE (body carries the business code) instead of a payload. 410 is a resource response, so getSigned does NOT demote the peer. The origin reads the 410 and dissolves the leaver. */
  async serveOutboundMessagesGroupFrom(
    groupAccount: string,
    fromAccount: string,
    fromDomain: string,
    after: number,
    take: number,
    signerDomain: string,
  ) {
    const { threadId } = await this.resolveGroupThreadAccess(
      groupAccount,
      undefined,
      undefined,
      signerDomain,
    );
    // Author gate with LEAVE signal: active → serve; soft-left/absent → resolveGroupAuthorOrLeave
    // throws (→ HTTP 410 GONE) before reaching here.
    const { authorId } = await this.resolveGroupAuthorOrLeave(threadId, fromAccount, fromDomain);
    const rows = await this.prisma.message.findMany({
      where: { threadId, creator: authorId, originSeq: { gt: after } },
      orderBy: { originSeq: 'asc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const messages = (hasMore ? rows.slice(0, take) : rows).map((m) => ({
      originSeq: m.originSeq ?? 0,
      contentType: m.contentType,
      content: m.content,
      ts: m.createdAt.getTime(),
    }));
    const latest = await this.prisma.message.aggregate({
      where: { threadId, creator: authorId },
      _max: { originSeq: true },
    });
    return { messages, latestSeq: latest._max.originSeq ?? -1, hasMore };
  }

  /**
   * ALL-SENDERS group pull, BACKWARD (the `seq < beforeSeq` twin of serveOutboundMessagesGroup, for
   * `/messages/before`). Serves the batch OLDEST-FIRST (descending query + reverse) so a caller prepends
   * it directly; the next-older page uses `messages[0].seq` as the new `beforeSeq`. Same roster gate +
   * self-exclusion (the requester's own authors are skipped — symmetric with the forward leg) + thread-seq
   * keying. `latestSeq` mirrors the forward leg (the NEWEST seq in this batch; -1 when empty). SOMS itself
   * is forward-only, so this has no internal caller — it exists for symmetry + external federated impls. */
  async serveOutboundMessagesGroupBefore(
    groupAccount: string,
    beforeSeq: number,
    take: number,
    signerDomain: string,
  ) {
    const { threadId } = await this.resolveGroupThreadAccess(
      groupAccount,
      undefined,
      undefined,
      signerDomain,
    );
    const rows = await this.prisma.message.findMany({
      where: {
        threadId,
        creatorItem: { domain: { not: signerDomain } }, // self-exclusion — never serve the requester's own authors
        ...(beforeSeq >= 0 ? { seq: { lt: beforeSeq } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: take + 1,
      include: { creatorItem: { select: { account: true, domain: true, isForeigner: true } } },
    });
    const hasMore = rows.length > take;
    // Desc query (newest-below-beforeSeq first) → slice → reverse to oldest-first so a caller prepends.
    const batch = (hasMore ? rows.slice(0, take) : rows).slice().reverse();
    const messages = batch.map((m) => ({
      seq: m.seq,
      originSeq: m.originSeq ?? 0,
      creator: {
        account: m.creatorItem.account,
        domain: this.effectiveDomain(m.creatorItem),
      },
      contentType: m.contentType,
      content: m.content,
      ts: m.createdAt.getTime(),
    }));
    // latestSeq = the NEWEST seq in this batch (mirrors the forward leg's batch cursor); -1 when empty.
    const latestSeq = messages.length > 0 ? messages[messages.length - 1].seq : -1;
    return { messages, latestSeq, hasMore };
  }

  /**
   * PER-AUTHOR group pull, BACKWARD (the `originSeq < beforeSeq` twin of serveOutboundMessagesGroupFrom,
   * for `/messages/before`). Same LEAVE signal as the forward per-author leg — a soft-left/absent author
   * returns HTTP 410 GONE (FEDERATION_GROUP_AUTHOR_LEFT) instead of a payload. Batch OLDEST-FIRST (descending +
   * reverse); `latestSeq` = the author's global MAX originSeq (JUMP — mirrors the forward per-author leg +
   * the P2P backward twin). SOMS is forward-only; no internal caller. */
  async serveOutboundMessagesGroupFromBefore(
    groupAccount: string,
    fromAccount: string,
    fromDomain: string,
    beforeSeq: number,
    take: number,
    signerDomain: string,
  ) {
    const { threadId } = await this.resolveGroupThreadAccess(
      groupAccount,
      undefined,
      undefined,
      signerDomain,
    );
    // Author gate with LEAVE signal: active → serve; soft-left/absent → resolveGroupAuthorOrLeave
    // throws (→ HTTP 410 GONE) before reaching here.
    const { authorId } = await this.resolveGroupAuthorOrLeave(threadId, fromAccount, fromDomain);
    const rows = await this.prisma.message.findMany({
      where: {
        threadId,
        creator: authorId,
        ...(beforeSeq >= 0 ? { originSeq: { lt: beforeSeq } } : {}),
      },
      orderBy: { originSeq: 'desc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const batch = (hasMore ? rows.slice(0, take) : rows).slice().reverse();
    const messages = batch.map((m) => ({
      originSeq: m.originSeq ?? 0,
      contentType: m.contentType,
      content: m.content,
      ts: m.createdAt.getTime(),
    }));
    const latest = await this.prisma.message.aggregate({
      where: { threadId, creator: authorId },
      _max: { originSeq: true },
    });
    return { messages, latestSeq: latest._max.originSeq ?? -1, hasMore };
  }


  async resolveMediaFile(
    fromAccount: string,
    toAccount: string,
    fromDomain: string | undefined,
    signerDomain: string,
    digest: string,
  ): Promise<{ absPath: string; bytes: number }> {
    // Group media (`toAccount` is the group `!account`): roster gate via resolveGroupThreadAccess. P2P
    // media: friendship gate via resolveFriendshipThread (`fromAccount` is the local owner). The 3rd
    // check (digest in thread) is identical for both — it keys on threadId, however resolved.
    const threadId = toAccount.startsWith('!')
      ? (
          await this.resolveGroupThreadAccess(
            toAccount,
            fromAccount,
            fromDomain,
            signerDomain,
          )
        ).threadId
      : (
          await this.resolveFriendshipThread(fromAccount, toAccount, signerDomain)
        ).threadId;
    // Check 3: the digest is referenced by a message in this thread (one indexed probe on @@index([digest])).
    const inThread = await this.prisma.mediaMessage.findFirst({
      where: { digest, threadId },
      select: { messageId: true },
    });
    if (!inThread) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'digest not in thread',
        HttpStatus.NOT_FOUND,
      );
    }
    // Resolve data/uploads/shards/<aa>/<bb>/<digest>.<ext> (ext via glob — not stored on the row).
    const shardDir = join(
      process.cwd(),
      'data',
      'uploads',
      'shards',
      digest.slice(0, 2),
      digest.slice(2, 4),
    );
    let names: string[];
    try {
      names = await readdir(shardDir);
    } catch {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'file unavailable',
        HttpStatus.NOT_FOUND,
      );
    }
    const name = names.find((f) => f.startsWith(`${digest}.`));
    if (!name) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'file unavailable',
        HttpStatus.NOT_FOUND,
      );
    }
    const absPath = join(shardDir, name);
    const s = await stat(absPath);
    return { absPath, bytes: s.size };
  }

  /** Shared authz prelude for every outbound S2S read (GET /messages pull + GET /get_file): proves
   *  `fromAccount` is a live local user (non-deleted), `toAccount` is the requester's foreign stub on
   *  signerDomain, and the from↔to Friendship is APPROVED — returning fromId + threadId. Throws NOT_FOUND
   *  (user missing) /
   *  FORBIDDEN (not friends); the 403 doubles as the §9.4 lazy-unfriend signal to the peer. Consolidates
   *  the identical check-1/check-2 blocks serveOutboundMessages and resolveMediaFile used to inline. */
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
        HttpStatus.NOT_FOUND,
      );
    }
    // `toAccount` is the requester's user → on OUR side it's a foreign stub on the signer's domain.
    const toStub = await this.prisma.user.findUnique({
      where: {
        account_domain: { account: normalizeAccount(toAccount), domain: signerDomain },
      },
      select: { id: true, isForeigner: true },
    });
    if (!toStub || !toStub.isForeigner) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `recipient ${toAccount} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    const threadId = await this.participantService.findP2PThreadBetween(fromId, toStub.id);
    if (threadId === null) {
      // Gate 2 failed: no active P2P thread (not friends — e.g. after a local-only unfriend). The 403
      // is also the rejection that teaches the peer about the severed edge (§9.4).
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'not friends',
        HttpStatus.FORBIDDEN,
      );
    }
    return { fromId, threadId };
  }

  // ─── Step 2/3: inbound hint queue + active pull (receiver side) ──────────────
  //
  // pendingPulls is the RECEIVER's work queue (the dual of the outbound buffer). Populated by a
  // /new-msg-map push (POST) or by pulling the peer's map (§4.3 one-directional fallback); drained by the
  // pull below. Volatile (restart → pull-on-open is the floor). Latest-seq-wins + the originSeq unique
  // index make push/pull overlap idempotent. Entries are account-based (fromAccount/fromDomain/toAccount
  // + latestSeq): `toAccount` is a peer user account (P2P) or the group `!account` (group).

  /** One queued pull hint. Mirrors the wire NewMsgMapEntry shape (fromAccount/fromDomain/toAccount/latestSeq). */
  private readonly pendingPulls = new Map<string, Map<string, NewMsgMapEntry>>();
  /** Single-flight guard so only one drain runs per domain at a time (a push mid-drain just updates the map). */
  private readonly drainingPulls = new Set<string>();

  /** scopeKey for pendingPulls (internal \0 separator; accounts/domains never contain \0). */
  private pullScopeKey(e: { fromAccount: string; fromDomain: string; toAccount: string }): string {
    return `${e.fromAccount}\0${e.fromDomain}\0${e.toAccount}`;
  }

  /**
   * Inbound /new-msg-map push (or map-pull result) → enqueue hints + trigger the drainer. Each entry's
   * `fromAccount`/`fromDomain` is the AUTHOR (a foreign stub here, or the origin re-signaling);
   * `toAccount` is OUR local user (P2P) or the group `!account` (group). Latest-seq-wins (a leave is now
   * signaled as a normal per-author hint whose latestSeq beats the cursor; the leave OUTCOME is the serve
   * side's HTTP 410, not a hint type). Fire-and-forget drain. Idempotent + defensively validated.
   */
  receiveNewMsgMapPush(
    signerDomain: string,
    entries: ReadonlyArray<{
      fromAccount?: unknown;
      fromDomain?: unknown;
      toAccount?: unknown;
      latestSeq?: unknown;
    }>,
  ): void {
    let byScope = this.pendingPulls.get(signerDomain);
    if (!byScope) {
      byScope = new Map();
      this.pendingPulls.set(signerDomain, byScope);
    }
    for (const e of entries) {
      if (
        !e ||
        typeof e.fromAccount !== 'string' ||
        typeof e.fromDomain !== 'string' ||
        typeof e.toAccount !== 'string' ||
        typeof e.latestSeq !== 'number'
      ) {
        continue;
      }
      const entry: NewMsgMapEntry = {
        fromAccount: e.fromAccount,
        fromDomain: e.fromDomain,
        toAccount: e.toAccount,
        latestSeq: e.latestSeq,
      };
      const key = this.pullScopeKey(entry);
      const prev = byScope.get(key);
      if (!prev || e.latestSeq > prev.latestSeq) {
        byScope.set(key, entry);
      }
    }
    void this.drainPendingPulls(signerDomain);
  }

  /**
   * Single-flight drain: process pending pulls for a domain sequentially. A push arriving mid-drain just
   * updates the map (the running loop re-reads it); on exit we re-trigger if new work arrived. Stops on a
   * pull failure (peer transiently down — the reconnect sweep retries). Bounded by the conversation count.
   */
  async drainPendingPulls(domain: string): Promise<void> {
    if (this.drainingPulls.has(domain)) return;
    this.drainingPulls.add(domain);
    let progressed = false; // did we clear ≥1 hint this drain? gates the re-trigger (anti-spin)
    try {
      for (;;) {
        const snap = this.snapshotPendingPulls(domain);
        if (snap.length === 0) break;
        // Dispatch one hint by shape: `toAccount` is a group → group pull (origin does per-author hub-leg,
        // mirror does whole-thread); else P2P per-author. On success drop the hint; on failure leave it +
        // stop (the sweep retries).
        const { key, entry } = snap[0];
        const caughtUp = await this.pullHint(domain, entry);
        if (caughtUp) {
          this.removePendingPullKey(domain, key);
          progressed = true;
        } else {
          break;
        }
      }
    } finally {
      this.drainingPulls.delete(domain);
      // Re-trigger ONLY if we made progress (so a push that arrived mid-drain gets drained). Without this
      // gate a persistently-failing hint (peer down) would spin: failed → break → re-trigger → fail again.
      // A no-progress drain leaves the hint for the reconnect sweep / the next push's own drain call.
      if (progressed && this.snapshotPendingPulls(domain).length > 0)
        void this.drainPendingPulls(domain);
    }
  }

  /**
   * Dispatch one hint by shape. Returns true if caught up OR stale/invalid (drop); false on transient
   * failure (leave for the sweep). `domain` is the SOURCE domain that pushed the hint (the peer to pull
   * from for P2P + the origin-hub per-author leg). `e.toAccount` distinguishes P2P (user account) from
   * group (`!account`).
   */
  private async pullHint(domain: string, e: NewMsgMapEntry): Promise<boolean> {
    if (e.toAccount.startsWith('!')) return this.pullGroup(domain, e);
    return this.pullP2P(domain, e);
  }

  /** P2P pull: the peer author `fromAccount`@`fromDomain`'s messages for our local user `toAccount`.
   *  Per-author, cursor DERIVED as MAX(originSeq) per (thread, creator) — the unchanged Step-2 mechanism.
   *  Derivation (not a stored cursor) is deliberate for P2P: it self-heals when the latest row vanishes
   *  (a lost store / a deleted message drops MAX, so pull-on-open re-fetches the gap — the §4.4 resilience
   *  backstop), and a fresh thread has no rows ⇒ -1 ⇒ first pull starts at seq 0. The group mirror path
   *  uses a STORED pullUntil instead (a new member has no local rows to derive from, + the sinceSeq seed).
   *  fetchedFromDomain = the peer (a pulled P2P message's only foreign participant is the author, so
   *  signalOutbound signals nobody — the receiver never re-propagates a 1:1 message). */
  private async pullP2P(domain: string, e: NewMsgMapEntry): Promise<boolean> {
    try {
      const creatorId = await this.ensureForeignUser(e.fromAccount, e.fromDomain);
      const toLocalUserId = await this.findLocalUserId(e.toAccount);
      if (toLocalUserId === null) return true; // local user gone → drop
      const threadId = await this.participantService.findP2PThreadBetween(
        creatorId,
        toLocalUserId,
      );
      if (threadId === null) return true; // not friends (lazy-unfriend §9.4) → drop
      const cur = await this.prisma.message.aggregate({
        where: { threadId, creator: creatorId },
        _max: { originSeq: true },
      });
      let after = cur._max.originSeq ?? -1; // 0-indexed: empty (thread, sender) → -1
      if (e.latestSeq <= after) return true; // already current
      for (;;) {
        const res = await this.withTrustedPeer(domain, () =>
          this.getSigned<{
            messages: Array<{
              originSeq: number;
              contentType: string;
              content: string;
              ts: number;
            }>;
            latestSeq: number;
            hasMore: boolean;
          }>(
            `/api/v1/s2s/messages?fromAccount=${encodeURIComponent(e.fromAccount)}&fromDomain=${encodeURIComponent(e.fromDomain)}&toAccount=${encodeURIComponent(e.toAccount)}&toDomain=${encodeURIComponent(this.ourDomain)}&afterSeq=${after}&take=50`,
            domain,
          ),
        );
        for (const m of res.messages) {
          const created = await this.storePulledMessage(
            threadId,
            creatorId,
            domain,
            [toLocalUserId],
            m,
          );
          if (created && this.isMediaContentType(created.contentType)) {
            await this.localizeMedia(created, domain, e.fromAccount, e.fromDomain, e.toAccount);
          }
        }
        if (res.messages.length > 0) {
          after = res.messages[res.messages.length - 1].originSeq;
        }
        if (!res.hasMore) return true;
      }
    } catch {
      return false; // peer down — leave for the sweep
    }
  }

  /** Group pull: route by OUR role. ORIGIN → per-author hub leg (pull the author's new messages from the
   *  pushing mirror `domain`, then re-signal the others). MIRROR → whole-thread pull from the origin via
   *  the stored pullUntil cursor. Non-member (no local thread) → drop. */
  private async pullGroup(domain: string, e: NewMsgMapEntry): Promise<boolean> {
    try {
      const trd = await this.findGroupThread(e.toAccount);
      if (!trd) return true; // not a member here → drop
      if (this.isOriginThread(trd)) return this.pullGroupFromAuthor(domain, trd.id, e);
      return this.pullGroupWhole(trd.id, trd.groupUser!.domain, e.toAccount);
    } catch {
      return false;
    }
  }

  /** MIRROR whole-thread pull (origin-hub): pull ALL senders' messages from the origin with thread seq >
   *  pullUntil, store each (creator resolved from the payload), advance pullUntil to latestSeq.
   *  fetchedFromDomain = origin → signalOutbound's exclude rule makes the mirror signal nothing.
   *
   *  `force` bypasses the receiver debounce — used only by the explicit chat-open path
   *  (syncGroupMessagesOnOpen): the user just opened the chat and wants the freshest NOW, so a read is
   *  never collapsed there (the debounce exists to collapse PUSH bursts, not user-initiated reads). A
   *  forced pull still refreshes the debounce timestamp, so a push landing right after the open is
   *  collapsed (the open already fetched everything). This is the durable recovery for a hint dropped by
   *  the debounce or a transiently-lost push with no follow-up: P2P self-heals on every open
   *  (syncMessagesWithPeerByStubId); groups self-heal the same way via this path — never relying on
   *  another push to arrive. */
  private async pullGroupWhole(
    threadId: number,
    originDomain: string,
    toAccount: string,
    force = false,
  ): Promise<boolean> {
    // Receiver-side debounce: a group mirror's whole-thread pull fetches ALL senders in one GET
    // (seq > pullUntil), so a burst of N author-hints for one group needs only ONE pull — the first
    // gets everything + advances pullUntil; the rest would return empty. Skip a PUSH's pull for this
    // thread within GROUP_PULL_DEBOUNCE_MS of the last (a forced open bypasses this — see `force`).
    // SAFE for the push path: no fetch → no failure → no demote; the first pull covered the burst, and
    // anything inside the window is recovered on the next chat-open (force) — never lost.
    if (!force) {
      const last = this.recentGroupPulls.get(threadId);
      if (last !== undefined && Date.now() - last < FederationService.GROUP_PULL_DEBOUNCE_MS) {
        return true; // recently pulled — skip the redundant empty GET
      }
    }
    this.recentGroupPulls.set(threadId, Date.now());
    const th = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { pullUntil: true },
    });
    let after = th?.pullUntil ?? -1;
    const recipients = await this.localActiveMemberIds(threadId);
    for (;;) {
      const res = await this.withTrustedPeer(originDomain, () =>
        this.getSigned<{
          messages: Array<{
            seq: number; // origin thread seq (the cursor)
            originSeq: number;
            creator: { account: string; domain: string };
            contentType: string;
            content: string;
            ts: number;
          }>;
          latestSeq: number;
          hasMore: boolean;
        }>(
          `/api/v1/s2s/messages?toAccount=${encodeURIComponent(toAccount)}&toDomain=${encodeURIComponent(this.ourDomain)}&afterSeq=${after}&take=50`,
          originDomain,
        ),
      );
      for (const m of res.messages) {
        const creatorId = await this.ensureForeignUser(m.creator.account, m.creator.domain);
        const created = await this.storePulledMessage(
          threadId,
          creatorId,
          originDomain,
          recipients,
          m,
        );
        if (created && this.isMediaContentType(created.contentType)) {
          // Group media: /get_file?toAccount=<group>&fromAccount=<creator> (roster-gated). Group account is `toAccount`.
          await this.localizeMedia(
            created,
            originDomain,
            m.creator.account,
            m.creator.domain,
            toAccount,
          );
        }
      }
      // Advance the cursor page-by-page to the last STORED message's thread seq (NOT res.latestSeq/the
      // thread total — that would skip the middle of a >`take`-message catch-up). Empty batch ⇒ no advance.
      if (res.messages.length > 0) {
        after = res.messages[res.messages.length - 1].seq;
        await this.prisma.messageThread.update({
          where: { id: threadId },
          data: { pullUntil: after },
        });
      }
      if (!res.hasMore) return true;
    }
  }

  /** ORIGIN per-author hub leg: pull the author `fromAccount`'s new group messages from the pushing
   *  mirror `domain` (originSeq space), store, then signalOutbound re-signals the OTHER member-domains
   *  (exclude `domain`). Cursor derived MAX(originSeq) per author — the origin tracks each member
   *  separately. LEAVE: if the mirror answers HTTP 410 GONE (FEDERATION_GROUP_AUTHOR_LEFT — the author
   *  soft-left there), the origin dissolves the leaver on its canonical roster + bumps the group meta
   *  (softLeaveMemberAndBump); mirrors reconcile on chat-open. 410 is a resource response → getSigned does
   *  NOT demote the peer. */
  private async pullGroupFromAuthor(
    domain: string,
    threadId: number,
    e: NewMsgMapEntry,
  ): Promise<boolean> {
    const creatorId = await this.ensureForeignUser(e.fromAccount, e.fromDomain);
    const cur = await this.prisma.message.aggregate({
      where: { threadId, creator: creatorId },
      _max: { originSeq: true },
    });
    let after = cur._max.originSeq ?? -1;
    if (e.latestSeq <= after) return true;
    const recipients = await this.localActiveMemberIds(threadId);
    try {
      for (;;) {
        const res = await this.withTrustedPeer(domain, () =>
          this.getSigned<{
            messages?: Array<{
              originSeq: number;
              contentType: string;
              content: string;
              ts: number;
            }>;
            latestSeq?: number;
            hasMore?: boolean;
          }>(
            `/api/v1/s2s/messages?toAccount=${encodeURIComponent(e.toAccount)}&fromAccount=${encodeURIComponent(e.fromAccount)}&fromDomain=${encodeURIComponent(e.fromDomain)}&toDomain=${encodeURIComponent(this.ourDomain)}&afterSeq=${after}&take=50`,
            domain,
          ),
        );
        const messages = res.messages ?? [];
        for (const m of messages) {
          const created = await this.storePulledMessage(
            threadId,
            creatorId,
            domain,
            recipients,
            m,
          );
          if (created && this.isMediaContentType(created.contentType)) {
            await this.localizeMedia(created, domain, e.fromAccount, e.fromDomain, e.toAccount);
          }
        }
        if (messages.length > 0) {
          after = messages[messages.length - 1].originSeq;
        }
        if (!res.hasMore) return true;
      }
    } catch (e) {
      // LEAVE signal — the author soft-left on the pushing mirror: resolveGroupAuthorOrLeave threw on
      // the serve side, so getSigned surfaces HTTP 410 GONE as an S2sResponseError. 410 is a resource
      // response (NOT 401/403/5xx) → getSigned did NOT demote the peer. Dissolve the leaver on our
      // canonical roster + bump the group meta; nothing further to pull from a leaver. See design-review
      // item C2.
      if (e instanceof S2sResponseError && e.status === HttpStatus.GONE) {
        await this.softLeaveMemberAndBump(threadId, creatorId);
        return true;
      }
      throw e;
    }
  }

  /**
   * The active LOCAL member userIds of a thread (foreign stubs excluded — they hold no SSE connection
   * here). Computed ONCE per pull batch by the caller and passed to storePulledMessage so the per-message
   * SSE fan is a synchronous loop (no async query between the row commit and the onNewMessage call — that
   * gap would let a DB-polling observer see the message before the SSE frame, breaking delivery atomicity
   * from the client's view). The sender (creatorId) is excluded by storePulledMessage.
   */
  private async localActiveMemberIds(threadId: number): Promise<number[]> {
    const rows = await this.prisma.threadParticipant.findMany({
      where: { threadId, leftAt: null, user: { isForeigner: false } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /**
   * Idempotently store one pulled message (dedup by the originSeq unique index). Advances the thread's
   * last-message cache only when newer than the current cache, and SSE-fans to the local recipient.
   * Returns the created Message (or null for a duplicate — no SSE, no cache rewrite). The caller runs
   * localizeMedia for media content types so the bytes land in local CAS (same-origin render).
   */
  private async storePulledMessage(
    threadId: number,
    creatorId: number,
    fetchedFromDomain: string,
    recipients: number[],
    m: { originSeq: number; contentType: string; content: string; ts: number },
  ): Promise<Message | null> {
    // The sender server's allocation time (payload `ts`) is stored as originServerTime (future use,
    // never displayed). The receiver's own createdAt defaults to now() — the local ARRIVAL time, which
    // is what the chatbox displays and what orders the conversation list. The protocol never trusts the
    // peer's clock for display; arrival time is locally monotonic and clock-skew-immune.
    const originTime = new Date(m.ts);
    // Allocate the RECEIVER's own per-thread seq from curSeq (same atomic path as a local send) and copy
    // the peer's originSeq verbatim — the dedup key + the value the receiver tracks as its pull cursor.
    // Wrapped in a tx so a P2002 dup-pull (same (threadId, creator, originSeq)) rolls the curSeq increment
    // back too (no seq gap from a deduped re-pull).
    const created = await this.prisma
      .$transaction(async (tx) => {
        const { curSeq: seq } = await tx.messageThread.update({
          where: { id: threadId },
          data: { curSeq: { increment: 1 } },
          select: { curSeq: true },
        });
        const msg = await tx.message.create({
          data: {
            contentType: m.contentType as ContentType,
            content: m.content,
            threadId,
            creator: creatorId,
            seq,
            originSeq: m.originSeq,
            originServerTime: originTime,
            // createdAt defaults to now() → the local arrival time
          },
        });
        // Quota: tick the peer's daily message budget ON THE SAME tx. Over-limit throws inside the tx →
        // rolls back the seq increment + this message too (no seq gap, no count burn); caught below as a
        // skip. `fetchedFromDomain` is always a peer (we pull FROM peers, never ourselves).
        await this.quota.tick(fetchedFromDomain, 'messages', tx);
        return msg;
      })
      .catch((e: unknown) => {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          return null; // already pulled (push/pull race) — idempotent skip (tx rolled back → no seq gap)
        }
        if (
          e instanceof BusinessException &&
          e.bizCode === BusinessCode.FEDERATION_QUOTA_EXCEEDED
        ) {
          // Peer's daily message budget exhausted — drop this message (tx rolled back: no seq gap, no
          // count burn). The drainer continues; further pulls from this peer today skip the same way.
          return null;
        }
        throw e;
      });
    if (!created) return null;
    // SSE FIRST, synchronously — fan to the pre-computed local recipients BEFORE any other await. A DB
    // polling observer (the client's reconcile / an e2e) must not see the committed row before the SSE
    // frame, so delivery is atomic from the client's view (no async gap between commit and onNewMessage).
    // Excludes the sender (creatorId) — for a pulled message the creator is a foreign stub, absent from
    // the local recipient set anyway. P2P → the single recipient; GROUP → every local member. Strips the
    // internal BigInt id (a throughput side-channel).
    const msgData = serializeBody({ ...stripMessageId(created) });
    for (const uid of recipients) {
      if (uid !== creatorId) this.sse.onNewMessage(uid, msgData);
    }
    const arrival = created.createdAt;
    // Conditionally advance the denormalized last-message cache — only if this pulled message is newer
    // than what's cached (a message the local user sent after this one must not be overwritten). Ordered
    // by ARRIVAL time (what the user sees), not the origin server time.
    await this.prisma.messageThread.updateMany({
      where: {
        id: threadId,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: arrival } }],
      },
      data: {
        lastMessageSeq: created.seq,
        lastMessagePreview: derivePreview(m.contentType as ContentType, m.content),
        lastMessageSenderId: creatorId,
        lastMessageAt: arrival,
      },
    });
    // Hub re-signal (origin only, via the exclude-fetch-source rule): fire-and-forget. A mirror's only
    // destination is the origin it just pulled from → excluded → signals nothing. The origin re-signals
    // the OTHER member-domains. See plan "Hub loop-safety".
    void this
      .signalOutbound(threadId, creatorId, m.originSeq, fetchedFromDomain)
      .catch(() => undefined);
    return created;
  }

  /** Whether a content type carries CAS media the receiver must localize from the peer. */
  private isMediaContentType(t: ContentType): boolean {
    return (
      t === ContentType.IMAGE ||
      t === ContentType.FILE ||
      t === ContentType.VIDEO ||
      t === ContentType.AUDIO
    );
  }

  /**
   * Receiver-side media localize (§3.3 / §4.5): for each CAS digest referenced by a pulled message,
   * fetch the bytes from the peer's /get_file and store them through the SAME CAS pipeline as a local
   * upload (sha256 → shard path → MediaAsset ref++), then write the MediaMessage authz row so the local
   * /uploads/shards/* gate admits the recipient. The content URL is already server-relative, so once the
   * file is local it serves same-origin with no rewrite. Integrity-checked (the re-hash must match the
   * advertised digest). Best-effort per file; a failure leaves the message with the peer's cross-origin
   * URL (inert) for a later retry.
   */
  private async localizeMedia(
    msg: { id: bigint; threadId: number; content: string; contentType: ContentType },
    peerDomain: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
  ): Promise<void> {
    // Quota category: IMAGE → 'images'; FILE/VIDEO/AUDIO → 'largeFiles'. MediaAsset stores no mime
    // (schema declares it redundant), so classify by the message contentType. Enforced inside
    // fetchMediaChunks after the byte size is known; the dedup path below (file already local) skips
    // fetchMediaChunks entirely — counted once on first pull.
    const category: 'images' | 'largeFiles' =
      msg.contentType === ContentType.IMAGE ? 'images' : 'largeFiles';
    for (const { digest, ext } of extractDigestEntries(msg.content)) {
      try {
        // Dedup: if the file is already local (prior fetch or a coincidental local upload), just ensure
        // the authz row exists and skip the network fetch.
        const have = await this.prisma.mediaAsset.findUnique({
          where: { digest },
          select: { refs: true },
        });
        if (!(have && have.refs > 0)) {
          // Stream the asset from the peer in resumable Range chunks → local CAS (no whole-file
          // buffer, no whole-transfer timeout). saveCasFromStream verifies the digest === advertised
          // and throws on mismatch (corrupt/tampered/truncated) — caught below, leaving the message
          // inert for a later retry.
          await this.upload.saveCasFromStream(
            ext,
            this.fetchMediaChunks(peerDomain, digest, fromAccount, fromDomain, toAccount, category),
            digest,
          );
        }
        await this.prisma.mediaMessage.createMany({
          data: { messageId: msg.id, threadId: msg.threadId, digest },
          skipDuplicates: true,
        });
      } catch {
        // Best-effort per file — never block the text pull. The cross-origin URL stays inert until a
        // later retry (pull-on-open / next push) re-runs localize.
      }
    }
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
   * 200 (no Range support) the whole body is streamed once, single-shot — never re-requested forever.
   */
  private async *fetchMediaChunks(
    peerDomain: string,
    digest: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
    category: 'images' | 'largeFiles',
  ): AsyncGenerator<Buffer> {
    const chunkBytes = this.config.mediaChunkBytes;
    const base = await this.discovery.resolveBase(peerDomain);
    const path = `/api/v1/s2s/get_file?digest=${digest}&fromAccount=${encodeURIComponent(fromAccount)}&fromDomain=${encodeURIComponent(fromDomain)}&toAccount=${encodeURIComponent(toAccount)}&toDomain=${encodeURIComponent(this.ourDomain)}`;
    const url = new URL(`${base}${path}`);
    let offset = 0;
    let total: number | null = null;
    let markedAlive = false;
    let quotaChecked = false;

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
      if (unit.fallback200) {
        // Quota: enforce the byte cap + tick ONCE before streaming. On the no-Range path Content-Length
        // is the only size hint; if absent the cap is best-effort (skipped) but the COUNT still ticks.
        if (!quotaChecked) {
          const len = Number(unit.res.headers.get('content-length') ?? 0);
          if (len > 0) await this.quota.assertUnderCap(peerDomain, category, len);
          await this.quota.tick(peerDomain, category);
          quotaChecked = true;
        }
        // Peer ignored Range: stream the full body once and stop (no resume, no loop).
        for await (const piece of this.webBody(unit.res)) yield piece;
        return;
      }
      total = unit.total;
      // Quota: the 206 Content-Range total is the authoritative size — enforce the byte cap + tick ONCE
      // before the first chunk. Over cap/limit → throws → saveCasFromStream gets no bytes (nothing
      // written); localizeMedia's catch leaves the message inert. 413/429 never demote the peer.
      if (!quotaChecked) {
        await this.quota.assertUnderCap(peerDomain, category, total);
        await this.quota.tick(peerDomain, category);
        quotaChecked = true;
      }
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
   *  the Response + the parsed Content-Range bounds, or `fallback200` when the peer served the whole
   *  file as 200 (Range unsupported). Throws — with markDemoted for auth/transport failures — on
   *  anything that isn't 200/206. Only url.pathname is signed (matching getSigned); the query travels
   *  unsigned by v0.1 design (the 3-check authz is the gate). */
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
    fallback200: boolean;
  }> {
    const headers = this.signature.signOutbound({
      method: 'GET',
      path: url.pathname,
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
    if (res.status === 200)
      return { res, start: 0, end: 0, total: 0, fallback200: true };
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
      return {
        res,
        start: Number(m[1]),
        end: Number(m[2]),
        total: Number(m[3]),
        fallback200: false,
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

  /** Snapshot a domain's pending pulls as a flat list of { key, entry } (for the drain loop). */
  private snapshotPendingPulls(
    domain: string,
  ): Array<{ key: string; entry: NewMsgMapEntry }> {
    const byScope = this.pendingPulls.get(domain);
    if (!byScope) return [];
    return [...byScope.entries()].map(([key, entry]) => ({ key, entry }));
  }

  /** Remove one pending-pull hint by scopeKey (+ drop the domain bucket when emptied). */
  private removePendingPullKey(domain: string, key: string): void {
    const byScope = this.pendingPulls.get(domain);
    if (!byScope) return;
    byScope.delete(key);
    if (byScope.size === 0) this.pendingPulls.delete(domain);
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
  ): Promise<void> {
    const stub = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatar: true, remoteProfileRev: true },
    });
    if (!stub) return; // stub gone — nothing to localize
    if (
      stub.remoteProfileRev !== null &&
      profile.profileRev <= stub.remoteProfileRev
    ) {
      return; // already at least as fresh as this profile
    }

    // Avatar is optional + fallible; resolve it before the tx so a failure can't poison the update.
    let newAvatarUrl: string | null = null; // null = leave the existing avatar untouched
    if (profile.avatar) {
      try {
        newAvatarUrl = await this.upload.saveAvatarFromWire(profile.avatar);
      } catch {
        newAvatarUrl = null; // keep the existing avatar; name/bio/remoteUpdatedAt still advance below
      }
    } else {
      newAvatarUrl = ''; // peer explicitly has no avatar → clear our localized copy
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
    await this.prisma.user.update({ where: { id: userId }, data });

    // Catch-up push: this federated stub just changed, so fan the fresh profile to every local friend
    // of this user — they refresh without each having to independently probe. Fire-and-forget so a slow
    // fan-out can't block the localization path. localizeForeignProfile's own "skip if not newer" guard
    // above means this only fires on a genuine profile change (no spam on a redelivered payload).
    void this.notifyPeersOfProfileUpdate(userId);

    // The previous localized avatar files are intentionally LEFT on disk — gcOrphanedAvatars reaps
    // them once they are no longer any User/Group's current avatar (no delete racing a render, and
    // re-localization on a transient profile-fetch hiccup no longer thrashes the disk).
  }

  /**
   * Fan a PEER_PROFILE_UPDATED push to every approved P2P peer of `userId`, carrying the FULL fresh
   * profile so each recipient's conversation list (and open chat header) refreshes with no extra
   * round-trip. Two callers: (a) local self-edits — UserController.updateProfile / updateAvatar; (b)
   * the federated catch-up in localizeForeignProfile above. Best-effort: callers `void` it so a slow
   * fan-out never blocks the triggering request, and a user with no friends / a missing row is a no-op.
   */
  async notifyPeersOfProfileUpdate(userId: number): Promise<void> {
    const peerIds = await this.participantService.getActiveP2PPeerUserIds(userId);
    if (peerIds.length === 0) return;
    // Signal-only: the client receives { userId } and HTTP-pulls the fresh profile itself (queryUserInfo),
    // matching the project's SSE-signal-only convention. No profile payload on the wire.
    peerIds.forEach((peerId) => this.sse.onPeerProfileUpdated(peerId, { userId }));
  }

  /**
   * Chat-open staleness sync: probe the peer's /revision; if newer than the stub's remoteUpdatedAt,
   * re-pull the full profile and re-localize. Best-effort — any failure (peer unreachable, profile
   * fetch error) is swallowed so a transient peer outage never blocks opening the conversation; the
   * cached profile is shown as-is and the next open retries. Local users are a no-op (their own
   * updatedAt is authoritative; there's nothing to sync).
   */
  async syncForeignUserIfStale(userId: number): Promise<void> {
    const stub = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
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
      const rev = await this.fetchRemoteRevision(address);
      if (
        stub.remoteProfileRev !== null &&
        rev.profileRev <= stub.remoteProfileRev
      ) {
        return; // fresh
      }
      const profile = await this.fetchRemoteUser(address);
      await this.localizeForeignProfile(userId, profile);
    } catch {
      // Best-effort: keep the cached profile. The next chat-open retries.
    }
  }
}
