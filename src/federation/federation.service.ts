import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { PrismaService } from '../prisma.service.js';
import { UploadService } from '../upload/upload.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';

/** A `localpart@domain` handle (email form) split into its parts. */
export interface ParsedHandle {
  localpart: string;
  domain: string;
}

/** Parse a federated handle → { localpart, domain }. The handle is the email-style
 *  `alice@aaa.com` (NO leading `@` — email form, not the ActivityPub `@alice@aaa.com`). Local
 *  uniqNames never contain `@` (register regex), so any `<x>@<y>` input is unambiguously a federated
 *  handle; a bare localpart (no `@`) returns null → caller treats it as a local lookup. */
export function parseHandle(h: string): ParsedHandle | null {
  const m = /^([^@]+)@(.+)$/.exec(h);
  return m ? { localpart: m[1], domain: m[2] } : null;
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
 * A user's public profile as transmitted over S2S — the resolve endpoint (GET /api/v1/s2s/users/:handle)
 * response body and the `profile` slot on friend.request / friend.approve envelopes. `updatedAt` is the
 * sender's User.updatedAt in ms (the profile revision); receivers store it as the stub's remoteUpdatedAt
 * so the lightweight /revision probe can detect staleness without re-transferring the avatar.
 */
export interface S2SProfile {
  uniqName: string;
  domain: string;
  displayName: string;
  avatar: S2SAvatar | null;
  bio: string;
  updatedAt: number;
}

/** The on-the-wire S2S envelope (plain JSON). See docs/federation-protocol.md §4. */
export interface S2SEnvelope {
  type: string;
  durability: 'durable' | 'ephemeral';
  id: string; // origin-assigned ULID; dedup key with origin
  origin: string;
  from: string; // localpart@domain
  to: string[]; // [localpart@domain, ...]
  ts: number; // ms since epoch
  message?: string; // friend.request note (≤255)
  content?: unknown; // message payload (opaque; future E2EE slot)
  /** Sender's current profile, attached to friend.request / friend.approve so the receiver localizes the
   * stub (avatar/name/bio) from the envelope without a nested S2S call inside the inbox. */
  profile?: S2SProfile;
}

/**
 * Outbound S2S: SYNCHRONOUS inline delivery. Each send* method builds an envelope, signs it
 * (SignatureService), and POSTs it to the peer's inbox (DiscoveryService resolves the URL), all
 * inline within the caller's request. No outbox/worker — Step 1 friend-flow is low-volume and the
 * friendship ops are idempotent, so a peer that's momentarily down just fails the action and the
 * user retries (the receiver dedupes via S2SInboxSeen, so retries are safe). The async outbox +
 * worker return only if Step 2 (messages) needs durable cross-server retry.
 *
 * Transaction note: the DB state change (e.g. Friendship PENDING) commits in its own tx BEFORE the
 * send — an HTTP POST can't live inside a DB tx. If the POST fails, local state is committed but the
 * peer isn't notified; the user retries and the idempotent re-send succeeds once the peer is back.
 * That temporary, self-healing inconsistency is the cost of sync; acceptable for Step 1's idempotent
 * friend ops.
 *
 * Identity model: local users have domain="local" (isForeigner=false); federated peers are foreign
 * User stubs (domain=<peer>, isForeigner=true, unusable random hashPwd). Federation handles always
 * use the REAL config.domain for local users (<uniqName>@<config.domain>), never "local".
 *
 * Avatar localization: foreign stubs carry the peer's avatar/name/bio/remoteUpdatedAt, localized from
 * the profile embedded in friend.request/friend.approve envelopes (and refreshed via fetchRemoteUser on
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
  ) {}

  /** The federated handle of a LOCAL user: <uniqName>@<our real domain> (email form). */
  localHandle(uniqName: string): string {
    return `${uniqName}@${this.config.domain}`;
  }

  /** This server's domain (config.domain) — for handle-domain comparison in controllers. */
  get ourDomain(): string {
    return this.config.domain;
  }

  /** Find a LOCAL user id by localpart (domain="local"). Null if not found / not local. */
  async findLocalUserId(localpart: string): Promise<number | null> {
    const u = await this.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: localpart, domain: 'local' } },
    });
    return u && !u.isForeigner ? u.id : null;
  }

  /** Look up a local user id from a full handle (must be localpart@<our domain>). */
  async findLocalUserIdByHandle(handle: ParsedHandle): Promise<number | null> {
    if (handle.domain !== this.config.domain) return null;
    return this.findLocalUserId(handle.localpart);
  }

  /** Load a local user (full row) by id; throw if missing or not local. The single source for the
   *  `from` handle + outbound profile builders, replacing the old localUniqName() helper. */
  private async requireLocalUser(userId: number): Promise<{
    id: number;
    uniqName: string;
    name: string;
    avatar: string;
    bio: string;
    updatedAt: Date;
  }> {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.isForeigner) throw new Error(`user ${userId} is not a local user`);
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
    const avatar = u.avatar ? await this.upload.readAvatarAsWire(u.avatar) : null;
    return {
      uniqName: u.uniqName,
      domain: this.config.domain,
      displayName: u.name,
      avatar,
      bio: u.bio,
      updatedAt: u.updatedAt.getTime(),
    };
  }

  /** Public profile of a local user (GET /api/v1/s2s/users/:handle). Null if not local / not found. */
  async getLocalUserProfile(handle: ParsedHandle): Promise<S2SProfile | null> {
    if (handle.domain !== this.config.domain) return null;
    const u = await this.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: handle.localpart, domain: 'local' } },
    });
    if (!u || u.isForeigner) return null;
    return this.toS2SProfile(u);
  }

  /** Lightweight revision probe (GET /api/v1/s2s/users/:handle/revision): just the profile revision,
   *  no avatar transfer. Receivers compare against the stub's remoteUpdatedAt to decide whether to
   *  re-pull the full profile. Null if not local / not found. */
  async getLocalUserRevision(handle: ParsedHandle): Promise<{ updatedAt: number } | null> {
    if (handle.domain !== this.config.domain) return null;
    const u = await this.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: handle.localpart, domain: 'local' } },
      select: { updatedAt: true, isForeigner: true },
    });
    if (!u || u.isForeigner) return null;
    return { updatedAt: u.updatedAt.getTime() };
  }

  /** Find or create a foreign User stub for @localpart@<peer-domain>. Stubs never authenticate. */
  async ensureForeignUser(localpart: string, domain: string): Promise<number> {
    const existing = await this.prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: localpart, domain } },
    });
    if (existing) return existing.id;
    const created = await this.prisma.user.create({
      data: {
        uniqName: localpart,
        domain,
        isForeigner: true,
        hashPwd: randomUUID(), // unusable — stubs never log in
        name: localpart,
        avatar: '',
        bio: '',
      },
    });
    return created.id;
  }

  /**
   * Resolve-on-demand safety net for send-friend-request: ensure a foreign stub has been localized
   * (profile pulled) at least once. No-op if already localized (remoteUpdatedAt set). If the caller
   * addresses a foreign user by id without a prior resolve (so the stub is a bare localpart), pull the
   * profile now. Throws on peer failure so the controller surfaces FEDERATION_DELIVERY_FAILED (the
   * subsequent send would fail against the same peer anyway).
   */
  async ensureForeignUserLocalized(userId: number, handle: ParsedHandle): Promise<void> {
    const stub = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { remoteUpdatedAt: true },
    });
    if (!stub || stub.remoteUpdatedAt !== null) return; // already localized (or gone)
    const profile = await this.fetchRemoteUser(handle);
    await this.localizeForeignProfile(userId, profile);
  }

  /**
   * Sign + synchronously POST an envelope to a peer's inbox. Throws on any non-success
   * (4xx permanent / 5xx transient / network / timeout) — the caller surfaces it to the user, who
   * retries. 200/202 = accepted; 409 = idempotent duplicate (already processed). No retry here — the
   * receiver dedupes, and the user/caller drives retries.
   */
  private async sendEnvelope(envelope: S2SEnvelope, recipientDomain: string): Promise<void> {
    const inboxUrl = await this.discovery.resolveInboxUrl(recipientDomain);
    const url = new URL(inboxUrl);
    const body = JSON.stringify(envelope);
    const headers = this.signature.signOutbound({
      method: 'POST',
      path: url.pathname,
      authority: url.host,
      body,
    });
    let res: Response;
    try {
      res = await fetch(inboxUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(this.config.callTimeoutSec * 1000),
      });
    } catch (e) {
      throw new Error(
        `S2S POST to ${recipientDomain} failed (network/timeout): ${(e as Error).message}`,
      );
    }
    if (res.status === 200 || res.status === 202 || res.status === 409) return; // delivered or idempotent
    throw new Error(`S2S POST to ${recipientDomain} rejected: HTTP ${res.status}`);
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
      throw new Error(
        `S2S GET ${path} from ${peerDomain} failed (network/timeout): ${(e as Error).message}`,
      );
    }
    if (!res.ok) throw new Error(`S2S GET ${path} from ${peerDomain} rejected: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  // ─── trust establishment (init handshake) ────────────────────────────────────

  /**
   * Ensure mutual trust with a peer domain before any resolve/inbox traffic. Idempotent: a no-op if
   * the domain is already trusted. Otherwise the mutual init handshake — our signed POST /init proves
   * we control our domain (the peer fetches OUR .well-known to verify), they auto-accept us, and we
   * trust them back so our guard accepts their inbound and our signed GETs to them succeed. Throws on
   * any failure (peer unreachable / not a SOMS peer / init rejected) — the caller surfaces
   * FEDERATION_DELIVERY_FAILED so the user retries. No dangling trust: we add them to our allow-list
   * only AFTER their /init accepts us.
   *
   * Triggered on-demand by the federated resolve path (a local user searching @handle@<untrusted-domain>).
   * The reverse direction (their user searches ours) is covered by our inbound /init endpoint auto-accepting them.
   */
  async ensurePeerTrusted(domain: string): Promise<void> {
    const existing = await this.prisma.federatedPeer.findUnique({ where: { domain } });
    if (existing?.trustLevel === 'trusted') return; // mutual trust already established
    // Confirm they're a real SOMS peer (public .well-known fetch over HTTPS; also warms their key cache
    // so the signature on their reply traffic verifies without a cold fetch).
    await this.discovery.fetchWellKnown(domain);
    // Bootstrap mutual trust: they auto-accept us on verifying this init's signature.
    await this.sendInit(domain);
    // They trust us now → trust them back (idempotent upsert; re-init just refreshes lastSeenAt).
    await this.prisma.federatedPeer.upsert({
      where: { domain },
      create: { domain, trustLevel: 'trusted' },
      update: { trustLevel: 'trusted', lastSeenAt: new Date() },
    });
  }

  /** Whether mutual trust with a peer domain is ALREADY established — a pure local lookup of the
   *  FederatedPeer allow-list (a row at trustLevel 'trusted'). No network, no side effects. Our own
   *  domain always reads trusted (a localpart@<our-domain> query is a local lookup, never a handshake).
   *
   *  Used by the user-facing pre-flight (POST /user/peer-trust-status) so the client can tell
   *  FIRST-CONTACT — a handshake IS expected during the upcoming resolve, so show a "Connecting to
   *  <domain>…" affordance — from an already-trusted resolve (fast, no banner). This is a known
   *  server-side fact, NOT a latency guess: the rare already-trusted-but-failing case (the peer reset
   *  its server and lost the prior handshake, or rotated a broken key) re-handshakes inside the resolve
   *  and surfaces as an error there, not here. */
  async isPeerTrusted(domain: string): Promise<boolean> {
    if (domain === this.config.domain) return true;
    const existing = await this.prisma.federatedPeer.findUnique({ where: { domain } });
    return existing?.trustLevel === 'trusted';
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

  /** Send a friend.request from a local user to @localpart@<peer>, carrying the sender's profile. */
  async sendFriendRequest(fromLocalUserId: number, to: ParsedHandle, message = ''): Promise<void> {
    const from = await this.requireLocalUser(fromLocalUserId);
    const profile = await this.toS2SProfile(from);
    await this.sendEnvelope(
      {
        type: 'friend.request',
        durability: 'durable',
        id: ulid(),
        origin: this.config.domain,
        from: this.localHandle(from.uniqName),
        to: [`${to.localpart}@${to.domain}`],
        ts: Date.now(),
        message: (message ?? '').slice(0, 255),
        profile,
      },
      to.domain,
    );
  }

  /** Send a friend.approve from a local user (the approver) to @localpart@<peer> (the requester). Pure
   *  state confirmation — carries NO profile: the requester already resolved + localized the approver's
   *  stub before sending the request, and any later profile change is picked up lazily by the chat-open
   *  /revision probe (syncForeignUserIfStale). Contrast friend.request, which MUST carry the sender's
   *  profile so the target can create the stub from scratch + render the request card. */
  async sendFriendApprove(localApproverId: number, to: ParsedHandle): Promise<void> {
    const fromUniqName = (await this.requireLocalUser(localApproverId)).uniqName;
    await this.sendEnvelope(
      {
        type: 'friend.approve',
        durability: 'durable',
        id: ulid(),
        origin: this.config.domain,
        from: this.localHandle(fromUniqName),
        to: [`${to.localpart}@${to.domain}`],
        ts: Date.now(),
      },
      to.domain,
    );
  }

  /**
   * Fetch a peer user's public profile (signed GET /api/v1/s2s/users/:handle). Used by federated
   * resolve (the add-friend card), ensureForeignUserLocalized (send-friend-request safety net), and
   * the chat-open staleness re-pull (syncForeignUserIfStale). Throws on any non-success (the caller
   * surfaces FEDERATION_DELIVERY_FAILED → user retries / inits).
   */
  async fetchRemoteUser(handle: ParsedHandle): Promise<S2SProfile> {
    return this.getSigned<S2SProfile>(
      `/api/v1/s2s/users/${handle.localpart}@${handle.domain}`,
      handle.domain,
    );
  }

  /** Fetch only the peer user's profile revision (signed GET .../revision). Cheap staleness probe. */
  async fetchRemoteRevision(handle: ParsedHandle): Promise<{ updatedAt: number }> {
    return this.getSigned<{ updatedAt: number }>(
      `/api/v1/s2s/users/${handle.localpart}@${handle.domain}/revision`,
      handle.domain,
    );
  }

  // ─── inbound / re-pull localization ──────────────────────────────────────────

  /**
   * Localize a foreign stub from a received S2SProfile: decode + persist the avatar via the
   * shared saveAvatars pipeline, write name/avatar/bio, and stamp remoteUpdatedAt. Idempotent + gated
   * on the profile revision — skips entirely when profile.updatedAt is not newer than the stored
   * remoteUpdatedAt (so a re-delivered envelope or a no-change re-pull does no work). Avatar decode
   * failures (corrupt/oversized bytes from a compromised peer) are isolated: name/bio/remoteUpdatedAt
   * still advance and the existing avatar is kept, so a broken avatar can't break friend-flow (and
   * advancing remoteUpdatedAt prevents a probe retry-loop on the same broken bytes).
   */
  async localizeForeignProfile(userId: number, profile: S2SProfile): Promise<void> {
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

    const oldAvatar = stub.avatar;
    const data: { name: string; bio: string; remoteUpdatedAt: Date; avatar?: string } = {
      name: profile.displayName,
      bio: profile.bio,
      remoteUpdatedAt: new Date(profile.updatedAt),
    };
    if (newAvatarUrl !== null) data.avatar = newAvatarUrl;
    await this.prisma.user.update({ where: { id: userId }, data });

    // Clean up the previous localized avatar files only when we actually replaced them.
    if (newAvatarUrl !== null && oldAvatar && oldAvatar !== newAvatarUrl) {
      await this.upload.deleteByUrl(oldAvatar);
    }
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
      select: { isForeigner: true, uniqName: true, domain: true, remoteUpdatedAt: true },
    });
    if (!stub || !stub.isForeigner) return;
    const handle: ParsedHandle = { localpart: stub.uniqName, domain: stub.domain };
    try {
      const rev = await this.fetchRemoteRevision(handle);
      if (
        stub.remoteUpdatedAt !== null &&
        rev.updatedAt <= stub.remoteUpdatedAt.getTime()
      ) {
        return; // fresh
      }
      const profile = await this.fetchRemoteUser(handle);
      await this.localizeForeignProfile(userId, profile);
    } catch {
      // Best-effort: keep the cached profile. The next chat-open retries.
    }
  }
}
