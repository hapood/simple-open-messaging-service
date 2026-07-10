import { Injectable, HttpStatus, Inject, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mintUlid, normalizeAccount, isValidAccount } from '../common/account.js';
import { PrismaService } from '../prisma.service.js';
import { UploadService } from '../upload/upload.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { InviteService } from '../invite/invite.service.js';
import { SseService } from '../gateway/sse.service.js';
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
 * (on S2SProfile.avatar) means the user has no avatar. See docs/federation-protocol.md.
 */
export interface S2SAvatar {
  b64: string;
  w: number;
  h: number;
}

/**
 * A user's public profile as transmitted over S2S — the resolve endpoint (GET /api/v1/s2s/users/:account)
 * response body and the `profile` slot on the friend-request payload. `updatedAt` is the sender's
 * User.updatedAt in ms (the profile revision); receivers store it as the stub's remoteUpdatedAt so the
 * lightweight /revision probe can detect staleness without re-transferring the avatar.
 */
export interface S2SProfile {
  account: string;
  domain: string;
  displayName: string;
  avatar: S2SAvatar | null;
  bio: string;
  updatedAt: number;
}

/** Shared envelope for a posted S2S op (plain JSON, RFC 9421 signed). `id` is an origin-assigned ULID —
 *  the idempotent-dedup key with `origin`. The discriminator is a FIELD on the concrete payload
 *  (`kind` / `op`), NOT the path: add-friend and add-group share `/s2s/invite`, mirroring the unified
 *  local Invite model. Cross-server MESSAGES do not use these bodies — they travel in the GET /messages
 *  response (docs/federation-step2-design.md §3.2). */
interface S2SOpsBase {
  id: string; // origin-assigned ULID; dedup key with origin
  origin: string; // sending server's domain (== signer)
  ts: number; // ms since epoch
}

/** POST /api/v1/s2s/invite — deliver an invite (friend-add OR group-invite), unified. `kind`
 *  discriminates. FRIEND carries the sender's profile (stub localization); GROUP carries the group
 *  identity + a revision (the origin `!`-User.updatedAt) so the receiver's mirror update is
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
  groupRevision?: number; // origin group !-User.updatedAt (ms); gates the mirror avatar/name update
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
 * add an outbox either — they use coalesced-notify + active pull (docs/federation-step2-design.md).
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly signature: SignatureService,
    private readonly discovery: DiscoveryService,
    private readonly upload: UploadService,
    private readonly participantService: ThreadParticipantService,
    private readonly message: MessageService,
    private readonly invite: InviteService,
    private readonly sse: SseService,
    // Cyclic DI with FederationBufferService (it injects us back via the symmetric forwardRef in its
    // ctor). The cycle is inherent + contained to this module: THIS service pulls messages and, after
    // storing one, must tell the buffer to propagate the hint (storePulledMessage → signalOutbound); the
    // buffer holds dirty hints + must flush them through THIS service's signed transport (pushNewMsgMap)
    // + read ourDomain. forwardRef is the NestJS-sanctioned way to express a same-module service↔buffer
    // co-dependency. Breaking it would mean extracting a third transport module both depend on — extra
    // surface for no functional gain, so the cycle is kept deliberately.
    @Inject(forwardRef(() => FederationBufferService))
    private readonly buffer: FederationBufferService,
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
    updatedAt: Date;
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
    updatedAt: Date;
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
      updatedAt: u.updatedAt.getTime(),
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
   *  no avatar transfer. Receivers compare against the stub's remoteUpdatedAt to decide whether to
   *  re-pull the full profile. Null if not local / not found. */
  async getLocalUserRevision(
    address: S2SAddress,
  ): Promise<{ updatedAt: number } | null> {
    if (address.domain !== this.config.domain) return null;
    const u = await this.prisma.user.findUnique({
      where: {
        account_domain: { account: normalizeAccount(address.account), domain: 'local' },
      },
      select: { updatedAt: true, isForeigner: true },
    });
    if (!u || u.isForeigner) return null;
    return { updatedAt: u.updatedAt.getTime() };
  }

  /** Find or create a foreign User stub for account@<peer-domain>. Stubs never authenticate. */
  async ensureForeignUser(account: string, domain: string): Promise<number> {
    const acct = normalizeAccount(account); // case-insensitive (docs/account-naming.md §4)
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
      select: { remoteUpdatedAt: true },
    });
    if (!stub || stub.remoteUpdatedAt !== null) return; // already localized (or gone)
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
   * trust-lifecycle wiring — `markContactSuccess` on 200/202/409 (delivered or idempotent),
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
    if (res.status === 200 || res.status === 202 || res.status === 409) {
      await this.markContactSuccess(peerDomain); // delivered or idempotent → advance liveness
      return;
    }
    await this.markDemoted(peerDomain, `POST HTTP ${res.status}`);
    throw new Error(`S2S POST to ${peerDomain} rejected: HTTP ${res.status}`);
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
      await this.markDemoted(peerDomain, `GET ${path} HTTP ${res.status}`);
      throw new Error(
        `S2S GET ${path} from ${peerDomain} rejected: HTTP ${res.status}`,
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
   *  so a DB hiccup can never break the caller's real S2S op. */
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
    // !-User.updatedAt) so the receiver's mirror update is revision-gated:
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
        select: { curSeq: true, pullUntil: true, originDomain: true },
      });
      payload.sinceSeq =
        trd == null
          ? -1
          : trd.originDomain === this.config.domain
            ? trd.curSeq
            : trd.pullUntil;
      payload.groupName = params.groupName?.slice(0, 255);
      payload.groupAvatar = params.groupAvatarUrl
        ? await this.upload.readAvatarAsWire(params.groupAvatarUrl)
        : null;
      payload.groupRevision = params.groupRevision ?? Date.now();
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
  async ensureOriginFederatedId(threadId: number): Promise<string> {
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { fedGroupAccount: true, groupUserId: true },
    });
    if (!trd) throw new Error(`thread ${threadId} not found`);
    if (trd.fedGroupAccount) return trd.fedGroupAccount;
    const gu = trd.groupUserId != null
      ? await this.prisma.user.findUnique({ where: { id: trd.groupUserId }, select: { account: true } })
      : null;
    if (!gu) throw new Error(`thread ${threadId} has no group user`);
    await this.prisma.messageThread.update({
      where: { id: threadId },
      data: { fedGroupAccount: gu.account, originDomain: this.config.domain },
    });
    return gu.account;
  }

  /** Whether THIS server is the origin (roster + history authority) of a federated group thread. */
  private isOriginThread(trd: { fedGroupAccount: string | null; originDomain: string | null }): boolean {
    return trd.fedGroupAccount !== null && trd.originDomain === this.config.domain;
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
   *  fedGroupAccount (stored verbatim), so this is a direct lookup. Null if no such group here. */
  private async findGroupThread(groupAccount: string): Promise<{
    id: number;
    type: MessageThreadType;
    fedGroupAccount: string | null;
    originDomain: string | null;
    groupUserId: number | null;
  } | null> {
    return this.prisma.messageThread.findUnique({
      where: { fedGroupAccount: normalizeAccount(groupAccount) },
      select: {
        id: true,
        type: true,
        fedGroupAccount: true,
        originDomain: true,
        groupUserId: true,
      },
    });
  }

  /** Inbound POST /s2s/invite — receive an invite (friend OR group), unified. Dispatches on `kind`.
   *  Dedup via S2SFriendOpSeen + the Invite (origin, originId) unique. */
  async handleInvite(body: S2SInvite): Promise<void> {
    if (await this.isOpSeen(body.origin, body.id)) return;
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
      fedGroupAccount: body.group!,
      originDomain: body.origin,
      name: body.groupName ?? '',
      ownerStubId,
      // Seed the mirror's pull cursor so the new member pulls from the invite-time latest seq, NOT the
      // entire pre-join history. Absent (-1) ⇒ a peer that doesn't send sinceSeq gets the full history
      // (safe default; only matters when the group already had messages at invite time).
      sinceSeq: body.sinceSeq ?? -1,
    });
    // Revision-gated avatar/name refresh: skip when the peer's revision is not newer than the mirror's
    // remoteUpdatedAt (no avatar re-localization / orphan files on an unchanged group).
    const mirror = await this.prisma.messageThread.findUnique({
      where: { id: mirrorThreadId },
      select: { groupUserId: true },
    });
    const gu =
      mirror?.groupUserId != null
        ? await this.prisma.user.findUnique({
            where: { id: mirror.groupUserId },
            select: { remoteUpdatedAt: true, avatar: true },
          })
        : null;
    const rev = body.groupRevision ?? 0;
    const stale = gu == null || gu.remoteUpdatedAt == null || gu.remoteUpdatedAt.getTime() < rev;
    let avatarUrl = gu?.avatar ?? '';
    if (stale && mirror?.groupUserId != null) {
      avatarUrl = body.groupAvatar ? await this.upload.saveAvatarFromWire(body.groupAvatar) : avatarUrl;
      await this.prisma.user.update({
        where: { id: mirror.groupUserId },
        data: {
          name: (body.groupName ?? '').slice(0, 255),
          avatar: avatarUrl,
          remoteUpdatedAt: new Date(rev),
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
    if (await this.isOpSeen(body.origin, body.id)) return;
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
    await this.invite.applyInboundFriendApprove(localId, foreignId);
    this.sse.onNotify(
      localId,
      serializeBody({ event: 'NOTIFY', type: 'FRIEND_APPROVED', byUserId: foreignId }),
    );
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
    // Bump the group-meta revision (the group !-User.updatedAt) so mirrors re-pull the roster on the
    // next chat-open (lazy meta-pull). Equivalent to GroupService.bumpGroupMeta, inlined to avoid a
    // GroupService dependency here.
    if (trd.groupUserId != null) {
      await this.prisma.user.update({
        where: { id: trd.groupUserId },
        data: { updatedAt: new Date() },
      });
    }
  }

  // ─── roster meta-pull (lazy, on chat-open — same shape as the profile sync) ──────────

  /** ORIGIN serves the canonical roster for a federated group (GET /s2s/thread/roster?to=<groupAccount>).
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

  /** MIRROR pulls the origin's roster (signed GET /s2s/thread/roster?to=<groupAccount>). Null on peer failure. */
  private async pullGroupRoster(
    groupAccount: string,
    originDomain: string,
  ): Promise<{ members: { account: string; domain: string; role: GroupRole }[] } | null> {
    try {
      return await this.getSigned<{
        members: { account: string; domain: string; role: GroupRole }[];
      }>(`/api/v1/s2s/thread/roster?to=${encodeURIComponent(groupAccount)}`, originDomain);
    } catch {
      return null;
    }
  }

  /** Chat-open hook for a FEDERATED group MIRROR: probe the origin's group-meta revision (the group
   *  !-User.updatedAt); if newer than the mirror's remoteUpdatedAt, re-pull the identity (reuses the
   *  profile-sync path: fetchRemoteUser + localizeForeignProfile) + the roster (reconcile), then fan a
   *  GROUP_UPDATED SSE so local members refresh. A local group / when we ARE the origin is a no-op. */
  async syncGroupMetaIfStale(threadId: number): Promise<void> {
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { fedGroupAccount: true, originDomain: true, groupUserId: true },
    });
    if (!trd?.fedGroupAccount || !trd.originDomain || trd.originDomain === this.config.domain) return;
    if (trd.groupUserId == null) return;
    const gu = await this.prisma.user.findUnique({
      where: { id: trd.groupUserId },
      select: { account: true, remoteUpdatedAt: true },
    });
    if (!gu) return;
    const address: S2SAddress = { account: gu.account, domain: trd.originDomain };
    try {
      const rev = await this.fetchRemoteRevision(address);
      if (gu.remoteUpdatedAt !== null && rev.updatedAt <= gu.remoteUpdatedAt.getTime()) return; // fresh
      // Stale → identity (reuse) + roster reconcile.
      const profile = await this.fetchRemoteUser(address);
      await this.localizeForeignProfile(trd.groupUserId, profile);
      const roster = await this.pullGroupRoster(trd.fedGroupAccount, trd.originDomain);
      if (roster) await this.reconcileRoster(threadId, roster.members);
      // Nudge local members to refresh their roster/group-info view.
      const members = await this.participantService.getActiveParticipantUserIds(threadId);
      members.forEach((m) => this.sse.onGroupEvent(m.userId, 'GROUP_UPDATED', { threadId }));
      // Chat-open is also the cheap moment to flush any buffered group-message hints for the origin
      // (lost pushes / post-restart) — a no-op drain when nothing is buffered. Closes the chat-open
      // message gap without a dedicated group message-sync (the lazy pull handles it).
      void this.drainPendingPulls(trd.originDomain as string);
    } catch {
      // Best-effort — keep the cached meta; the next chat-open retries.
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
    const existing = await this.prisma.messageThread.findUnique({
      where: { fedGroupAccount: params.fedGroupAccount },
      select: { id: true },
    });
    if (existing) return existing.id;
    // The mirror group-user REUSES the origin's `!account` (== fedGroupAccount): the group account is
    // globally unique, so it is the stable cross-server address (a mirror writes the same account under
    // its own domain row — account_domain uniqueness still holds since origin stores it under 'local').
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
        fedGroupAccount: params.fedGroupAccount,
        originDomain: params.originDomain,
        groupUserId: groupUser.id,
        // Seed pullUntil from the invite's sinceSeq so the member pulls from invite-time latest, not the
        // full pre-join history. -1 (no sinceSeq) ⇒ pull everything (the safe default for an empty group).
        pullUntil: params.sinceSeq ?? -1,
      },
    });
    // Record the origin owner on the mirror (roster authority is the origin; the owner never crosses
    // domains, but the mirror must know who the owner is for display + Phase-B authority checks).
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
   * Throws FEDERATION_PEER_BLOCKED if the peer is admin-blocked. See docs/federation-step2-design.md §5.
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
        from: stub.account,
        fromDomain: stub.domain,
        to: local.account,
        latestSeq: Number.MAX_SAFE_INTEGER,
      },
    ]);
  }

  /**
   * Serve the SENDER's side of a 1:1 thread for a federated pull (GET /api/v1/s2s/messages). Returns
   * messages authored by OUR local user `from` for the peer user `to` (a foreign stub on signerDomain),
   * with originSeq > `after`, ascending — the receiver stores them + advances its cursor. Pulls ONLY the
   * sender's side (never the requester's own authored messages). Gate 2: the from↔to Friendship MUST be
   * APPROVED (else 403 FORBIDDEN — also the lazy-unfriend signal of §9.4). Media digests are NOT
   * surfaced separately: the receiver extracts them from `content` via the same extractDigests() helper
   * the sender used, then fetches each via /get_file (§3.3). See docs/federation-step2-design.md §3.2.
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
   * group). When `from` is given (per-author hub-leg pull), also prove the author is an active member and
   * return its userId. Throws NOT_FOUND (no such group) / FORBIDDEN (requester or author not a member).
   * `to`-is-group on the wire routes here; the group account resolves via findGroupThread.
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
   * PER-AUTHOR group pull (origin ← mirror, the hub aggregation leg): serve the author `from`'s messages
   * in the group with originSeq > `after` (the existing per-author query shape, originSeq space). The
   * origin pulls each member-server's NEW messages this way to aggregate them; the origin's cursor for a
   * member is derived MAX(originSeq) per author (unchanged Step-2 mechanism). Roster + author gated.
   */
  async serveOutboundMessagesGroupFrom(
    groupAccount: string,
    fromAccount: string,
    fromDomain: string,
    after: number,
    take: number,
    signerDomain: string,
  ) {
    const { threadId, authorId } = await this.resolveGroupThreadAccess(
      groupAccount,
      fromAccount,
      fromDomain,
      signerDomain,
    );
    if (authorId === undefined) {
      throw new BusinessException(BusinessCode.FORBIDDEN, 'author not a member', HttpStatus.FORBIDDEN);
    }
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
   * Resolve a chat-media file for a federated /get_file (the 3-check authz, §3.3). `from` is OUR local
   * user (the file's owner by virtue of authoring the message); `to` is the requester's user (a foreign
   * stub on signerDomain). Returns the on-disk absolute path + size to stream. Throws NOT_FOUND
   * (user/thread/file missing) or FORBIDDEN (not friends). The digest → file resolution globs the shard
   * dir (the extension isn't stored on MediaAsset — only the digest/refs); the receiver already knows
   * the ext from the message content URL, so the S2S Content-Type is incidental (octet-stream). */
  async resolveMediaFile(
    fromAccount: string,
    toAccount: string,
    fromDomain: string | undefined,
    signerDomain: string,
    digest: string,
  ): Promise<{ absPath: string; bytes: number }> {
    // Group media (`to` is the group `!account`): roster gate via resolveGroupThreadAccess. P2P media:
    // friendship gate via resolveFriendshipThread (`from` is the local owner). The 3rd check (digest in
    // thread) is identical for both — it keys on threadId, however resolved.
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
    // Resolve uploads/shards/<aa>/<bb>/<digest>.<ext> (ext via glob — not stored on the row).
    const shardDir = join(
      process.cwd(),
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

  /** Shared authz prelude for every outbound S2S read (GET /messages pull + GET /get_file): proves `from`
   *  is a live local user (non-deleted), `to` is the requester's foreign stub on signerDomain, and the
   *  from↔to Friendship is APPROVED — returning fromId + threadId. Throws NOT_FOUND (user missing) /
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
    // `to` is the requester's user → on OUR side it's a foreign stub on the signer's domain.
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
  // index make push/pull overlap idempotent. Entries are account-based (from/fromDomain/to + latestSeq,
  // + optional `left`): `to` is a peer user account (P2P) or the group `!account` (group).

  /** One queued pull hint. Mirrors the wire NewMsgMapEntry shape (from/fromDomain/to/latestSeq/left?). */
  private readonly pendingPulls = new Map<string, Map<string, NewMsgMapEntry>>();
  /** Single-flight guard so only one drain runs per domain at a time (a push mid-drain just updates the map). */
  private readonly drainingPulls = new Set<string>();

  /** scopeKey for pendingPulls (internal \0 separator; accounts/domains never contain \0). The left-flag
   *  keeps a leave hint distinct from message hints for the same (from, to). */
  private pullScopeKey(e: { from: string; fromDomain: string; to: string; left?: boolean }): string {
    return `${e.from}\0${e.fromDomain}\0${e.to}\0${e.left ? 1 : 0}`;
  }

  /**
   * Inbound /new-msg-map push (or map-pull result) → enqueue hints + trigger the drainer. Each entry's
   * `from`/`fromDomain` is the AUTHOR (a foreign stub here, or the origin re-signaling); `to` is OUR local
   * user (P2P) or the group `!account` (group). Latest-seq-wins for message hints; a leave hint is always
   * stored (keyed separately). Fire-and-forget drain. Idempotent + defensively validated.
   */
  receiveNewMsgMapPush(
    signerDomain: string,
    entries: ReadonlyArray<{
      from?: unknown;
      fromDomain?: unknown;
      to?: unknown;
      latestSeq?: unknown;
      left?: unknown;
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
        typeof e.from !== 'string' ||
        typeof e.fromDomain !== 'string' ||
        typeof e.to !== 'string' ||
        typeof e.latestSeq !== 'number'
      ) {
        continue;
      }
      const entry: NewMsgMapEntry = {
        from: e.from,
        fromDomain: e.fromDomain,
        to: e.to,
        latestSeq: e.latestSeq,
        ...(e.left ? { left: true } : {}),
      };
      const key = this.pullScopeKey(entry);
      const prev = byScope.get(key);
      if (e.left) {
        byScope.set(key, entry);
      } else if (!prev || e.latestSeq > prev.latestSeq) {
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
        // Dispatch one hint by shape: leave → roster dissolve; `to` is a group → group pull (origin does
        // per-author hub-leg, mirror does whole-thread); else P2P per-author. On success drop the hint; on
        // failure leave it + stop (the sweep retries).
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
   * from for P2P + the origin-hub per-author leg). `e.to` distinguishes P2P (user account) from group
   * (`!account`); `e.left` is a leave signal.
   */
  private async pullHint(domain: string, e: NewMsgMapEntry): Promise<boolean> {
    if (e.left) return this.handleLeaveHint(domain, e);
    if (e.to.startsWith('!')) return this.pullGroup(domain, e);
    return this.pullP2P(domain, e);
  }

  /** P2P pull: the peer author `from`@`fromDomain`'s messages for our local user `to`. Per-author, cursor
   *  DERIVED as MAX(originSeq) per (thread, creator) — the unchanged Step-2 mechanism. Derivation (not a
   *  stored cursor) is deliberate for P2P: it self-heals when the latest row vanishes (a lost store / a
   *  deleted message drops MAX, so pull-on-open re-fetches the gap — the §4.4 resilience backstop), and a
   *  fresh thread has no rows ⇒ -1 ⇒ first pull starts at seq 0. The group mirror path uses a STORED
   *  pullUntil instead (a new member has no local rows to derive from, + the sinceSeq seed). fetchedFromDomain
   *  = the peer (a pulled P2P message's only foreign participant is the author, so signalOutbound signals
   *  nobody — the receiver never re-propagates a 1:1 message). */
  private async pullP2P(domain: string, e: NewMsgMapEntry): Promise<boolean> {
    try {
      const creatorId = await this.ensureForeignUser(e.from, e.fromDomain);
      const toLocalUserId = await this.findLocalUserId(e.to);
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
            `/api/v1/s2s/messages?from=${encodeURIComponent(e.from)}&fromDomain=${encodeURIComponent(e.fromDomain)}&to=${encodeURIComponent(e.to)}&afterSeq=${after}&take=50`,
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
            await this.localizeMedia(created, domain, e.from, e.fromDomain, e.to);
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
      const trd = await this.findGroupThread(e.to);
      if (!trd) return true; // not a member here → drop
      if (this.isOriginThread(trd)) return this.pullGroupFromAuthor(domain, trd.id, e);
      return this.pullGroupWhole(trd.id, trd.originDomain as string, e);
    } catch {
      return false;
    }
  }

  /** MIRROR whole-thread pull (origin-hub): pull ALL senders' messages from the origin with thread seq >
   *  pullUntil, store each (creator resolved from the payload), advance pullUntil to latestSeq.
   *  fetchedFromDomain = origin → signalOutbound's exclude rule makes the mirror signal nothing. */
  private async pullGroupWhole(
    threadId: number,
    originDomain: string,
    e: NewMsgMapEntry,
  ): Promise<boolean> {
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
          `/api/v1/s2s/messages?to=${encodeURIComponent(e.to)}&afterSeq=${after}&take=50`,
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
          // Group media: /get_file?to=<group>&from=<creator> (roster-gated). Group account is `to`.
          await this.localizeMedia(
            created,
            originDomain,
            m.creator.account,
            m.creator.domain,
            e.to,
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

  /** ORIGIN per-author hub leg: pull the author `from`'s new group messages from the pushing mirror
   *  `domain` (originSeq space), store, then signalOutbound re-signals the OTHER member-domains (exclude
   *  `domain`). Cursor derived MAX(originSeq) per author — the origin tracks each member separately. */
  private async pullGroupFromAuthor(
    domain: string,
    threadId: number,
    e: NewMsgMapEntry,
  ): Promise<boolean> {
    const creatorId = await this.ensureForeignUser(e.from, e.fromDomain);
    const cur = await this.prisma.message.aggregate({
      where: { threadId, creator: creatorId },
      _max: { originSeq: true },
    });
    let after = cur._max.originSeq ?? -1;
    if (e.latestSeq <= after) return true;
    const recipients = await this.localActiveMemberIds(threadId);
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
          `/api/v1/s2s/messages?to=${encodeURIComponent(e.to)}&from=${encodeURIComponent(e.from)}&fromDomain=${encodeURIComponent(e.fromDomain)}&afterSeq=${after}&take=50`,
          domain,
        ),
      );
      for (const m of res.messages) {
        const created = await this.storePulledMessage(
          threadId,
          creatorId,
          domain,
          recipients,
          m,
        );
        if (created && this.isMediaContentType(created.contentType)) {
          await this.localizeMedia(created, domain, e.from, e.fromDomain, e.to);
        }
      }
      if (res.messages.length > 0) {
        after = res.messages[res.messages.length - 1].originSeq;
      }
      if (!res.hasMore) return true;
    }
  }

  /** Leave hint (`left:true`): the member `from` left the group on its server. Only the ORIGIN acts
   *  (roster authority): soft-leave the member + bump the group-meta revision (mirrors pick it up on the
   *  next chat-open meta-pull). A mirror drops it (it initiated its own local leave). Best-effort: the
   *  hint is volatile — a lost leave leaves the origin's roster stale (a future active-liveness check is
   *  the durable backstop, deferred). */
  private async handleLeaveHint(domain: string, e: NewMsgMapEntry): Promise<boolean> {
    try {
      const trd = await this.findGroupThread(e.to);
      if (!trd || !this.isOriginThread(trd)) return true; // not the origin → drop
      const leaver = await this.resolveUserByWireAddress(e.from, e.fromDomain);
      if (!leaver) return true;
      await this.participantService.softLeaveMember(trd.id, leaver.id);
      if (trd.groupUserId != null) {
        await this.prisma.user.update({
          where: { id: trd.groupUserId },
          data: { updatedAt: new Date() },
        });
      }
      return true;
    } catch {
      return false;
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
        return tx.message.create({
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
      })
      .catch((e: unknown) => {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          return null; // already pulled (push/pull race) — idempotent skip (tx rolled back → no seq gap)
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
    const msgData = serializeBody({ threadId, ...stripMessageId(created) });
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
    void this.buffer
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
    msg: { id: bigint; threadId: number; content: string },
    peerDomain: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
  ): Promise<void> {
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
            this.fetchMediaChunks(peerDomain, digest, fromAccount, fromDomain, toAccount),
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
  ): AsyncGenerator<Buffer> {
    const chunkBytes = this.config.mediaChunkBytes;
    const base = await this.discovery.resolveBase(peerDomain);
    const path = `/api/v1/s2s/get_file?digest=${digest}&from=${encodeURIComponent(fromAccount)}&fromDomain=${encodeURIComponent(fromDomain)}&to=${encodeURIComponent(toAccount)}`;
    const url = new URL(`${base}${path}`);
    let offset = 0;
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
      if (unit.fallback200) {
        // Peer ignored Range: stream the full body once and stop (no resume, no loop).
        for await (const piece of this.webBody(unit.res)) yield piece;
        return;
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
  ): Promise<{ updatedAt: number }> {
    return this.getSigned<{ updatedAt: number }>(
      `/api/v1/s2s/users/${address.account}/revision`,
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
      select: { avatar: true, remoteUpdatedAt: true },
    });
    if (!stub) return; // stub gone — nothing to localize
    if (
      stub.remoteUpdatedAt !== null &&
      profile.updatedAt <= stub.remoteUpdatedAt.getTime()
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
      remoteUpdatedAt: Date;
      avatar?: string;
    } = {
      name: profile.displayName,
      bio: profile.bio,
      remoteUpdatedAt: new Date(profile.updatedAt),
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
    const [user, peerIds] = await Promise.all([
      // Full row (same shape as the thread-list peerUser via queryUsers) so the client can replace its
      // cached peerUser wholesale — omit the self-only hasUrFriendReq + hashPwd, exactly like findUniqueUser.
      this.prisma.user.findUnique({
        where: { id: userId },
        omit: { hashPwd: true, hasUrFriendReq: true },
      }),
      this.participantService.getActiveP2PPeerUserIds(userId),
    ]);
    if (!user || peerIds.length === 0) return;
    // serializeBody converts Date → ms, so `updatedAt` lands as the same ms-epoch the client already
    // holds in peerUser.updatedAt — consistent with the thread-list + sync-peer-profile wire shape.
    const payload = serializeBody(user);
    peerIds.forEach((peerId) => this.sse.onPeerProfileUpdated(peerId, payload));
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
        remoteUpdatedAt: true,
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
        stub.remoteUpdatedAt !== null &&
        rev.updatedAt <= stub.remoteUpdatedAt.getTime()
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
