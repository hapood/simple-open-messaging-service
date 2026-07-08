import { Injectable, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { PrismaService } from '../prisma.service.js';
import { UploadService } from '../upload/upload.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { FriendshipService } from '../friendship/friendship.service.js';
import { SseService } from '../gateway/sse.service.js';
import { ContentType, Message, Prisma } from '../prisma/generated/client.js';
import { derivePreview } from '../message/message.service.js';
import { extractDigestEntries } from '../upload/file-content.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A federated user address on the wire: two separate fields (username + domain). The `@` separator
 *  is a UI input convention ONLY — the browser splits a typed `alice@bbb.com` into these two fields
 *  before any API call; S2S payloads + endpoints + consumer DTOs never carry an `@`-joined string. */
export interface S2SAddress {
  username: string;
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
 * A user's public profile as transmitted over S2S — the resolve endpoint (GET /api/v1/s2s/users/:username)
 * response body and the `profile` slot on the friend-request payload. `updatedAt` is the sender's
 * User.updatedAt in ms (the profile revision); receivers store it as the stub's remoteUpdatedAt so the
 * lightweight /revision probe can detect staleness without re-transferring the avatar.
 */
export interface S2SProfile {
  uniqName: string;
  domain: string;
  displayName: string;
  avatar: S2SAvatar | null;
  bio: string;
  updatedAt: number;
}

/** The shared signed body for every POSTed friend op (plain JSON). See docs/federation-protocol.md §4.
 *  The `id` is an origin-assigned ULID and the idempotent-dedup key (with `origin`). There is NO `type`
 *  field — the endpoint path (POST /friend-request | /friend-approve) IS the discriminator, exactly like
 *  every other S2S route. Cross-server messages do NOT use this body: they travel in the GET /messages
 *  response (docs/federation-step2-design.md §3.2). */
export interface S2SPayload {
  id: string; // origin-assigned ULID; dedup key with origin
  origin: string;
  from: S2SAddress; // sender identity (split fields — never an @-joined string)
  to: S2SAddress[]; // recipients (split fields)
  ts: number; // ms since epoch
}

/** POST /api/v1/s2s/friend-request body. Carries the requester's profile so the receiver creates the
 *  foreign stub localized (avatar/name/bio) inline — no nested S2S call inside the handler. */
export interface S2SFriendRequest extends S2SPayload {
  message?: string; // ≤255-char note
  profile: S2SProfile;
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
 * use the REAL config.domain for local users' wire addresses ({ username: <uniqName>, domain: <config.domain> }), never "local".
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
    private readonly friendship: FriendshipService,
    private readonly sse: SseService,
  ) {}

  /** The wire address of a LOCAL user: { username, domain } (domain = our real config.domain). */
  localAddress(uniqName: string): S2SAddress {
    return { username: uniqName, domain: this.config.domain };
  }

  /** This server's domain (config.domain) — for address-domain comparison in controllers. */
  get ourDomain(): string {
    return this.config.domain;
  }

  /** Find a LOCAL user id by username (domain="local"). Null if not found / not local / soft-deleted.
   *  The isDeleted gate matters here because S2S bypasses the token system: the local /uploads/* path is
   *  protected from admin-disabled users by tokenVersion (invalidateAllSessions bumps it on disable), but
   *  /get_file never touches tokens — so a disabled user's media would still flow out over federation
   *  unless we reject the soft-deleted row here. */
  async findLocalUserId(username: string): Promise<number | null> {
    const u = await this.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: username, domain: 'local' } },
    });
    return u && !u.isForeigner && !u.isDeleted ? u.id : null;
  }

  /** Look up a local user id from a full address (must be username@<our domain>). */
  async findLocalUserIdByAddress(address: S2SAddress): Promise<number | null> {
    if (address.domain !== this.config.domain) return null;
    return this.findLocalUserId(address.username);
  }

  /** Load a local user (full row) by id; throw if missing or not local. The single source for the
   *  `from` address + outbound profile builders, replacing the old localUniqName() helper. */
  private async requireLocalUser(userId: number): Promise<{
    id: number;
    uniqName: string;
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
    uniqName: string;
    name: string;
    avatar: string;
    bio: string;
    updatedAt: Date;
  }): Promise<S2SProfile> {
    const avatar = u.avatar
      ? await this.upload.readAvatarAsWire(u.avatar)
      : null;
    return {
      uniqName: u.uniqName,
      domain: this.config.domain,
      displayName: u.name,
      avatar,
      bio: u.bio,
      updatedAt: u.updatedAt.getTime(),
    };
  }

  /** Public profile of a local user (GET /api/v1/s2s/users/:username). Null if not local / not found. */
  async getLocalUserProfile(address: S2SAddress): Promise<S2SProfile | null> {
    if (address.domain !== this.config.domain) return null;
    const u = await this.prisma.user.findUnique({
      where: {
        uniqName_domain: { uniqName: address.username, domain: 'local' },
      },
    });
    if (!u || u.isForeigner) return null;
    return this.toS2SProfile(u);
  }

  /** Lightweight revision probe (GET /api/v1/s2s/users/:username/revision): just the profile revision,
   *  no avatar transfer. Receivers compare against the stub's remoteUpdatedAt to decide whether to
   *  re-pull the full profile. Null if not local / not found. */
  async getLocalUserRevision(
    address: S2SAddress,
  ): Promise<{ updatedAt: number } | null> {
    if (address.domain !== this.config.domain) return null;
    const u = await this.prisma.user.findUnique({
      where: {
        uniqName_domain: { uniqName: address.username, domain: 'local' },
      },
      select: { updatedAt: true, isForeigner: true },
    });
    if (!u || u.isForeigner) return null;
    return { updatedAt: u.updatedAt.getTime() };
  }

  /** Find or create a foreign User stub for username@<peer-domain>. Stubs never authenticate. */
  async ensureForeignUser(username: string, domain: string): Promise<number> {
    const existing = await this.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: username, domain } },
    });
    if (existing) return existing.id;
    const created = await this.prisma.user.create({
      data: {
        uniqName: username,
        domain,
        isForeigner: true,
        hashPwd: randomUUID(), // unusable — stubs never log in
        name: username,
        avatar: '',
        bio: '',
      },
    });
    return created.id;
  }

  /**
   * Resolve-on-demand safety net for send-friend-request: ensure a foreign stub has been localized
   * (profile pulled) at least once. No-op if already localized (remoteUpdatedAt set). If the caller
   * addresses a foreign user by id without a prior resolve (so the stub is a bare username), pull the
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
   * Triggered on-demand by the federated resolve path (a local user searching username@<untrusted-domain>).
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
   *  domain always reads trusted (a username@<our-domain> query is a local lookup, never a handshake).
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

  // ─── friend flows (synchronous) ──────────────────────────────────────────────

  /** POST a friend-request from a local user to a peer user address, carrying the sender's profile so
   *  the receiver creates the foreign stub localized. */
  async sendFriendRequest(
    fromLocalUserId: number,
    to: S2SAddress,
    message = '',
  ): Promise<void> {
    const from = await this.requireLocalUser(fromLocalUserId);
    const profile = await this.toS2SProfile(from);
    const payload: S2SFriendRequest = {
      id: ulid(),
      origin: this.config.domain,
      from: this.localAddress(from.uniqName),
      to: [{ username: to.username, domain: to.domain }],
      ts: Date.now(),
      message: (message ?? '').slice(0, 255),
      profile,
    };
    await this.postSigned(
      '/api/v1/s2s/friend-request',
      JSON.stringify(payload),
      to.domain,
    );
  }

  /** POST a friend-approve from a local user (the approver) to a peer user address (the requester). Pure
   *  state confirmation — carries NO profile: the requester already resolved + localized the approver's
   *  stub before sending the request, and any later profile change is picked up lazily by the chat-open
   *  /revision probe (syncForeignUserIfStale). Contrast friend-request, which MUST carry the sender's
   *  profile so the target can create the stub from scratch + render the request card. */
  async sendFriendApprove(
    localApproverId: number,
    to: S2SAddress,
  ): Promise<void> {
    const fromUniqName = (await this.requireLocalUser(localApproverId))
      .uniqName;
    const payload: S2SPayload = {
      id: ulid(),
      origin: this.config.domain,
      from: this.localAddress(fromUniqName),
      to: [{ username: to.username, domain: to.domain }],
      ts: Date.now(),
    };
    await this.postSigned(
      '/api/v1/s2s/friend-approve',
      JSON.stringify(payload),
      to.domain,
    );
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
    entries: Array<{ from: string; to: string; latestSeq: number }>,
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
    entries: Array<{ from: string; to: string; latestSeq: number }>;
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
   * if every push was lost (or after a process restart). Fire-and-forget by the caller (never blocks
   * opening); one cheap GET when already current. `latestSeq=MAX` forces a full catch-up attempt —
   * pullOneConversation returns once the peer serves everything > the old cursor.
   */
  async syncMessagesWithPeerByStubId(
    stubUserId: number,
    localUserId: number,
  ): Promise<void> {
    const [stub, local] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: stubUserId },
        select: { uniqName: true, domain: true, isForeigner: true },
      }),
      this.prisma.user.findUnique({
        where: { id: localUserId },
        select: { uniqName: true, isForeigner: true },
      }),
    ]);
    if (!stub || !stub.isForeigner || !local || local.isForeigner) return;
    await this.pullOneConversation(
      stub.domain,
      stub.uniqName,
      local.uniqName,
      Number.MAX_SAFE_INTEGER,
    );
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
    fromUsername: string,
    toUsername: string,
    signerDomain: string,
    after: number,
    take: number,
  ) {
    const { fromId, threadId } = await this.resolveFriendshipThread(
      fromUsername,
      toUsername,
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
      clientMessageId: m.clientMessageId,
      ts: m.createdAt.getTime(),
    }));
    const latest = await this.prisma.message.aggregate({
      where: { threadId, creator: fromId },
      _max: { originSeq: true },
    });
    return { messages, latestSeq: latest._max.originSeq ?? 0, hasMore };
  }

  /**
   * Resolve a chat-media file for a federated /get_file (the 3-check authz, §3.3). `from` is OUR local
   * user (the file's owner by virtue of authoring the message); `to` is the requester's user (a foreign
   * stub on signerDomain). Returns the on-disk absolute path + size to stream. Throws NOT_FOUND
   * (user/thread/file missing) or FORBIDDEN (not friends). The digest → file resolution globs the shard
   * dir (the extension isn't stored on MediaAsset — only the digest/refs); the receiver already knows
   * the ext from the message content URL, so the S2S Content-Type is incidental (octet-stream). */
  async resolveMediaFile(
    fromUsername: string,
    toUsername: string,
    signerDomain: string,
    digest: string,
  ): Promise<{ absPath: string; bytes: number }> {
    const { threadId } = await this.resolveFriendshipThread(
      fromUsername,
      toUsername,
      signerDomain,
    );
    // Check 3: the digest is referenced by a message in this thread (one indexed probe on @@index([digest])).
    const inThread = await this.prisma.mediaMessage.findFirst({
      where: { digest, threadId },
      select: { id: true },
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

  /** Find the APPROVED Friendship between two users (normalized either direction). Null if none / not approved. */
  private async findApprovedFriendship(a: number, b: number) {
    return this.prisma.friendship.findFirst({
      where: {
        OR: [
          { userAId: a, userBId: b },
          { userAId: b, userBId: a },
        ],
        status: 'APPROVED',
      },
    });
  }

  /** Shared authz prelude for every outbound S2S read (GET /messages pull + GET /get_file): proves `from`
   *  is a live local user (non-deleted), `to` is the requester's foreign stub on signerDomain, and the
   *  from↔to Friendship is APPROVED — returning fromId + threadId. Throws NOT_FOUND (user missing) /
   *  FORBIDDEN (not friends); the 403 doubles as the §9.4 lazy-unfriend signal to the peer. Consolidates
   *  the identical check-1/check-2 blocks serveOutboundMessages and resolveMediaFile used to inline. */
  private async resolveFriendshipThread(
    fromUsername: string,
    toUsername: string,
    signerDomain: string,
  ): Promise<{ fromId: number; threadId: number }> {
    const fromId = await this.findLocalUserId(fromUsername);
    if (fromId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `sender ${fromUsername} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    // `to` is the requester's user → on OUR side it's a foreign stub on the signer's domain.
    const toStub = await this.prisma.user.findUnique({
      where: {
        uniqName_domain: { uniqName: toUsername, domain: signerDomain },
      },
      select: { id: true, isForeigner: true },
    });
    if (!toStub || !toStub.isForeigner) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `recipient ${toUsername} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    const friendship = await this.findApprovedFriendship(fromId, toStub.id);
    if (!friendship?.threadId) {
      // Gate 2 failed: not approved friends. The 403 is also the rejection that teaches the peer about
      // a local-only unfriend (§9.4).
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'not friends',
        HttpStatus.FORBIDDEN,
      );
    }
    return { fromId, threadId: friendship.threadId };
  }

  // ─── Step 2: inbound hint queue + active pull (receiver side) ─────────────────
  //
  // pendingPulls is the RECEIVER's work queue (the dual of the outbound domainNewMsgMap). Populated by
  // a /new-msg-map push (POST) or by pulling the peer's map (§4.3 one-directional fallback); drained by
  // the message pull below. Volatile (restart → pull-on-open is the floor). Latest-seq-wins + the
  // originSeq unique index make push/pull overlap idempotent.

  private readonly pendingPulls = new Map<
    string,
    Map<string, Map<string, number>>
  >(); // domain→from→to→latestSeq
  /** Single-flight guard so only one drain runs per domain at a time (a push mid-drain just updates the map). */
  private readonly drainingPulls = new Set<string>();

  /**
   * Inbound /new-msg-map push (or map-pull result) → enqueue hints + trigger the drainer. `entries[].from`
   * is the PEER's user (a foreign stub here); `entries[].to` is OUR local user. Latest-seq-wins. Fire-and-
   * forget drain (the push handler ACKs fast; the pull runs out of band). Idempotent. Entry shape is
   * validated defensively (the signature covers integrity, not well-formedness).
   */
  receiveNewMsgMapPush(
    signerDomain: string,
    entries: ReadonlyArray<{
      from?: unknown;
      to?: unknown;
      latestSeq?: unknown;
    }>,
  ): void {
    let byFrom = this.pendingPulls.get(signerDomain);
    if (!byFrom) {
      byFrom = new Map();
      this.pendingPulls.set(signerDomain, byFrom);
    }
    for (const e of entries) {
      if (
        !e ||
        typeof e.from !== 'string' ||
        typeof e.to !== 'string' ||
        typeof e.latestSeq !== 'number'
      ) {
        continue;
      }
      let byTo = byFrom.get(e.from);
      if (!byTo) {
        byTo = new Map();
        byFrom.set(e.from, byTo);
      }
      const prev = byTo.get(e.to) ?? 0;
      if (e.latestSeq > prev) byTo.set(e.to, e.latestSeq); // latest-wins
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
        // Pull one conversation fully (loops /messages until caught up). On success drop the hint; on
        // failure leave it + stop (the sweep retries).
        const { from, to, latestSeq } = snap[0];
        const caughtUp = await this.pullOneConversation(
          domain,
          from,
          to,
          latestSeq,
        );
        if (caughtUp) {
          this.removePendingPull(domain, from, to);
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
   * Pull one conversation from the peer until the local cursor catches up to latestSeq. Returns true if
   * caught up OR the hint is stale/invalid (drop it); false on a transient failure (leave for the sweep).
   */
  private async pullOneConversation(
    domain: string,
    fromUsername: string,
    toLocalUsername: string,
    latestSeq: number,
  ): Promise<boolean> {
    try {
      const creatorId = await this.ensureForeignUser(fromUsername, domain);
      const toLocalUserId = await this.findLocalUserId(toLocalUsername);
      if (toLocalUserId === null) return true; // local user gone → drop the hint
      const friendship = await this.findApprovedFriendship(
        creatorId,
        toLocalUserId,
      );
      if (!friendship?.threadId) return true; // not friends (lazy-unfriend §9.4) → drop the hint
      const threadId = friendship.threadId;
      const cur = await this.prisma.message.aggregate({
        where: { threadId, creator: creatorId },
        _max: { originSeq: true },
      });
      let after = cur._max.originSeq ?? 0;
      if (latestSeq <= after) return true; // already current
      for (;;) {
        const res = await this.withTrustedPeer(domain, () =>
          this.getSigned<{
            messages: Array<{
              originSeq: number;
              contentType: string;
              content: string;
              clientMessageId: string | null;
              ts: number;
            }>;
            latestSeq: number;
            hasMore: boolean;
          }>(
            `/api/v1/s2s/messages?from=${encodeURIComponent(fromUsername)}&to=${encodeURIComponent(toLocalUsername)}&after=${after}&take=50`,
            domain,
          ),
        );
        for (const m of res.messages) {
          const created = await this.storePulledMessage(
            threadId,
            creatorId,
            toLocalUserId,
            m,
          );
          if (created && this.isMediaContentType(created.contentType)) {
            // Best-effort media localize: fetch each referenced digest via /get_file, store in local
            // CAS so it serves same-origin. A per-file failure leaves the message (cross-origin URL is
            // inert) for a later retry — never blocks the text pull.
            await this.localizeMedia(
              created,
              domain,
              fromUsername,
              toLocalUsername,
            );
          }
        }
        if (res.messages.length > 0) {
          after = res.messages[res.messages.length - 1].originSeq;
        }
        if (!res.hasMore) return true; // peer served everything > the old cursor → caught up
      }
    } catch {
      // Peer transiently down / signature failed / network — leave the hint for the reconnect sweep.
      return false;
    }
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
    toLocalUserId: number,
    m: { originSeq: number; contentType: string; content: string; ts: number },
  ): Promise<Message | null> {
    const created = await this.prisma.message
      .create({
        data: {
          contentType: m.contentType as ContentType,
          content: m.content,
          threadId,
          creator: creatorId,
          originSeq: m.originSeq,
          createdAt: new Date(m.ts),
        },
      })
      .catch((e: unknown) => {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          return null; // already pulled (push/pull race) — idempotent skip
        }
        throw e;
      });
    if (!created) return null;
    const ts = new Date(m.ts);
    // Conditionally advance the denormalized last-message cache — only if this pulled message is newer
    // than what's cached (a message the local user sent after this one must not be overwritten).
    await this.prisma.messageThread.updateMany({
      where: {
        id: threadId,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: ts } }],
      },
      data: {
        lastMessageId: created.id,
        lastMessagePreview: derivePreview(
          m.contentType as ContentType,
          m.content,
        ),
        lastMessageSenderId: creatorId,
        lastMessageAt: ts,
      },
    });
    this.sse.onNewMessage(
      toLocalUserId,
      serializeBody({ threadId, ...created }),
    );
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
    fromUsername: string,
    toLocalUsername: string,
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
            this.fetchMediaChunks(
              peerDomain,
              digest,
              fromUsername,
              toLocalUsername,
            ),
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
    fromUsername: string,
    toLocalUsername: string,
  ): AsyncGenerator<Buffer> {
    const chunkBytes = this.config.mediaChunkBytes;
    const base = await this.discovery.resolveBase(peerDomain);
    const path = `/api/v1/s2s/get_file?digest=${digest}&from=${encodeURIComponent(fromUsername)}&to=${encodeURIComponent(toLocalUsername)}`;
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

  /** Snapshot a domain's pending pulls as a flat list (for the drain loop). */
  private snapshotPendingPulls(
    domain: string,
  ): Array<{ from: string; to: string; latestSeq: number }> {
    const byFrom = this.pendingPulls.get(domain);
    if (!byFrom) return [];
    const out: Array<{ from: string; to: string; latestSeq: number }> = [];
    for (const [from, byTo] of byFrom) {
      for (const [to, latestSeq] of byTo) out.push({ from, to, latestSeq });
    }
    return out;
  }

  /** Remove one pending-pull hint (+ compact emptied buckets). */
  private removePendingPull(domain: string, from: string, to: string): void {
    const byFrom = this.pendingPulls.get(domain);
    if (!byFrom) return;
    const byTo = byFrom.get(from);
    if (!byTo) return;
    byTo.delete(to);
    if (byTo.size === 0) byFrom.delete(from);
    if (byFrom.size === 0) this.pendingPulls.delete(domain);
  }

  /**
   * Fetch a peer user's public profile (signed GET /api/v1/s2s/users/:username). Used by federated
   * resolve (the add-friend card), ensureForeignUserLocalized (send-friend-request safety net), and
   * the chat-open staleness re-pull (syncForeignUserIfStale). Throws on any non-success (the caller
   * surfaces FEDERATION_DELIVERY_FAILED → user retries / inits).
   */
  async fetchRemoteUser(address: S2SAddress): Promise<S2SProfile> {
    return this.getSigned<S2SProfile>(
      `/api/v1/s2s/users/${address.username}`,
      address.domain,
    );
  }

  /** Fetch only the peer user's profile revision (signed GET .../revision). Cheap staleness probe. */
  async fetchRemoteRevision(
    address: S2SAddress,
  ): Promise<{ updatedAt: number }> {
    return this.getSigned<{ updatedAt: number }>(
      `/api/v1/s2s/users/${address.username}/revision`,
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
      this.friendship.getApprovedPeerUserIds(userId),
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
        uniqName: true,
        domain: true,
        remoteUpdatedAt: true,
      },
    });
    if (!stub || !stub.isForeigner) return;
    const address: S2SAddress = {
      username: stub.uniqName,
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
