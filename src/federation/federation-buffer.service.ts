import { Injectable, OnModuleDestroy, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { FederationService } from './federation.service.js';

/** One outbound hint entry. `from`/`fromDomain` identify the AUTHOR (a local user, or a foreign stub the
 *  origin re-propagates); `to` identifies the CONVERSATION — a peer user account (P2P) or the group
 *  `!account` (group). `left` marks a leave signal (handled on drain as a roster dissolve, not a pull). */
interface DirtyEntry {
  from: string;
  fromDomain: string;
  to: string;
  latestSeq: number;
  generatedAt: number;
  left?: boolean;
}

/** The on-wire shape pushed (POST /new-msg-map) and snapshotted (GET /new-msg-map). `fromDomain` is always
 *  present (every federated domain is distinct; the author may be foreign). No `@`-join, no internal ids. */
export interface NewMsgMapEntry {
  from: string;
  fromDomain: string;
  to: string;
  latestSeq: number;
  left?: boolean;
}

/**
 * Volatile in-memory buffer of "which conversations have new messages the peer doesn't know about"
 * (the user-named `domain_new_msg_map`). Coalesces per-message notifies into per-(from,fromDomain,to)
 * latest-seq hints so a burst to one peer becomes ONE debounced push; on a peer outage the entries BUFFER
 * here and flush when the 60s reconnect sweep brings the peer back.
 *
 * NOT a source of truth (the Message table is) and NOT persisted — it survives a network outage (the
 * process lives) but NOT a process restart (pull-on-thread-open is the restart floor). Latest-seq-wins
 * means the map is bounded by ACTIVE CONVERSATION COUNT, never message count, so it cannot grow
 * unbounded during a long outage. See docs/federation-step2-design.md §2.3 + §4.1 + §Phase-B.
 *
 * `signalOutbound` is the single routing entry for BOTH the local-send path (notifyOnSend) and the pulled
 * path (FederationService.storePulledMessage). It implements the origin-hub topology + the loop-safety
 * rule in one place: dest = (origin → all foreign member-domains; mirror → {originDomain}; P2P → foreign
 * peers) minus the `fetchedFromDomain` (the domain the message was just pulled from — it already has it).
 * That single exclude makes a mirror signal nothing (its only dest IS its fetch source) and the origin
 * re-signal only non-source mirrors. See docs + plan "Hub loop-safety".
 */
@Injectable()
export class FederationBufferService implements OnModuleDestroy {
  private readonly logger = new Logger(FederationBufferService.name);
  /** per-domain → (scopeKey → entry). scopeKey encodes (from, fromDomain, to, left?) with a \0 separator
   *  (accounts/domains are restricted to letters/digits/dots — never \0), so a message hint and a leave
   *  hint for the same (from, to) coexist without collision. */
  private readonly domains = new Map<string, Map<string, DirtyEntry>>();
  /** One debounced flush timer per domain (cleared in onModuleDestroy). */
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  /** Debounce window: a burst collapses to one push. */
  private static readonly DEBOUNCE_MS = 500;
  /** Per-domain entry cap. On overflow, the older HALF is evicted in one shot. */
  private static readonly CAP_PER_DOMAIN = 10_000;
  /** Entries per push request (each ~100 B → ~100 KB, under the 1 MiB body limit). */
  private static readonly BATCH = 1000;

  constructor(
    // Symmetric half of the FederationService ↔ FederationBufferService cycle (see FederationService
    // ctor for why the forwardRef is deliberate, not extracted into a transport module). We inject the
    // service only to flush dirty hints through its signed transport (pushNewMsgMap) + read ourDomain.
    @Inject(forwardRef(() => FederationService))
    private readonly federation: FederationService,
    private readonly prisma: PrismaService,
  ) {}

  /** scopeKey for the nested map (internal only — \0 cannot appear in accounts/domains). The trailing
   *  left-flag keeps a leave signal distinct from message hints for the same (from, to). */
  private scopeKey(e: { from: string; fromDomain: string; to: string; left?: boolean }): string {
    return `${e.from}\0${e.fromDomain}\0${e.to}\0${e.left ? 1 : 0}`;
  }

  /**
   * Hook for the local send path (MessageController.sendMessage): after a message is stored, route the
   * outbound hint. Thin wrapper over signalOutbound with no fetchedFromDomain (a local send is not pulled
   * from anyone — nothing to exclude). Best-effort: never throws into the send path.
   */
  async notifyOnSend(senderUserId: number, threadId: number, originSeq: number): Promise<void> {
    await this.signalOutbound(threadId, senderUserId, originSeq, undefined);
  }

  /**
   * The single origin-hub routing + loop-safety entry. Called by notifyOnSend (local send,
   * fetchedFromDomain undefined) AND by FederationService.storePulledMessage (pulled, fetchedFromDomain =
   * the domain the message was fetched from). Computes the destination domain set per topology, then
   * subtracts fetchedFromDomain (the fetch source already has the message). This one rule closes BOTH
   * symmetric back-notify paths:
   *   - mirror pulls from origin → its only dest (origin) == fetch source → signals nothing.
   *   - origin pulls from mirror X → re-signals every foreign domain EXCEPT X.
   * For P2P the author is skipped (a pulled P2P message's only foreign participant is the author → nobody
   * to signal; a local P2P send signals the single foreign peer). Best-effort: logs + swallows.
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
          select: {
            fedGroupAccount: true,
            originDomain: true,
            groupUser: { select: { account: true } },
          },
        }),
        this.prisma.threadParticipant.findMany({
          where: { threadId, leftAt: null },
          include: { user: { select: { account: true, domain: true, isForeigner: true } } },
        }),
      ]);
      if (!trd) return;
      const author = participants.find((p) => p.userId === authorUserId);
      if (!author) return;
      const authorDomain = author.user.isForeigner ? author.user.domain : this.federation.ourDomain;
      const authorAccount = author.user.account;

      if (!trd.fedGroupAccount) {
        // P2P (local-only or federated 1:1): signal each foreign peer participant EXCEPT the author. The
        // `to` is the peer's own account. A pulled P2P message's only foreign participant is the author →
        // nobody to signal (the receiver never re-propagates a 1:1 message).
        for (const p of participants) {
          if (p.userId === authorUserId || !p.user.isForeigner) continue;
          if (fetchedFromDomain && p.user.domain === fetchedFromDomain) continue;
          this.markDirty(p.user.domain, authorAccount, authorDomain, p.user.account, latestSeq);
        }
        return;
      }
      // GROUP federated. dest = (origin → all foreign member-domains; mirror → {originDomain}), minus the
      // fetch source. The `to` is the group `!account` (one hint per foreign domain, regardless of how
      // many local members it has — they share the mirror thread on that domain).
      const groupAccount = trd.groupUser?.account;
      if (!groupAccount) return;
      const destDomains = new Set<string>();
      if (trd.originDomain === this.federation.ourDomain) {
        for (const p of participants) if (p.user.isForeigner) destDomains.add(p.user.domain);
      } else {
        destDomains.add(trd.originDomain as string);
      }
      if (fetchedFromDomain) destDomains.delete(fetchedFromDomain);
      for (const d of destDomains) {
        this.markDirty(d, authorAccount, authorDomain, groupAccount, latestSeq);
      }
    } catch (e) {
      // Never break the caller (send/pull path) — a transient DB error just skips this notify.
      this.logger.debug(`signalOutbound(${threadId}) failed: ${(e as Error).message}`);
    }
  }

  /** Mark a conversation dirty: the author <from>/<fromDomain> has new messages up to latestSeq for <to>
   *  on <domain>. Latest-seq-wins for message hints (never regress — a stale notify must not overwrite a
   *  newer one); a leave hint is always written (keyed separately). Enforces the per-domain cap
   *  (half-eviction on overflow) and schedules a debounced flush. */
  markDirty(
    domain: string,
    from: string,
    fromDomain: string,
    to: string,
    latestSeq: number,
    left = false,
  ): void {
    let byScope = this.domains.get(domain);
    if (!byScope) {
      byScope = new Map();
      this.domains.set(domain, byScope);
    }
    const key = this.scopeKey({ from, fromDomain, to, left });
    const existing = byScope.get(key);
    if (existing && !left && existing.latestSeq >= latestSeq) return; // stale — never regress
    byScope.set(key, { from, fromDomain, to, latestSeq, generatedAt: Date.now(), left });
    if (byScope.size > FederationBufferService.CAP_PER_DOMAIN) this.evictHalf(byScope);
    this.scheduleFlush(domain);
  }

  /** Drop the older HALF of entries by generatedAt in one shot (not one-by-one — avoids thrashing at
   *  the cap boundary). Evicted conversations fall back to the slow-poll floor (§4.4). */
  private evictHalf(byScope: Map<string, DirtyEntry>): void {
    const flat = [...byScope.entries()].sort((a, b) => a[1].generatedAt - b[1].generatedAt);
    const drop = Math.floor(flat.length / 2);
    for (let i = 0; i < drop; i++) byScope.delete(flat[i][0]);
  }

  private scheduleFlush(domain: string): void {
    if (this.flushTimers.has(domain)) return; // a flush is already pending
    const t = setTimeout(() => {
      this.flushTimers.delete(domain);
      void this.flushDomain(domain).catch((e) =>
        this.logger.debug(`flush ${domain} failed: ${(e as Error).message}`),
      );
    }, FederationBufferService.DEBOUNCE_MS);
    this.flushTimers.set(domain, t);
  }

  /**
   * Flush ALL dirty entries for a domain to the peer, batched (BATCH per POST). On each batch's ack,
   * delete those entries; on failure, keep the rest buffered (the next markDirty reschedules, and the
   * reconnect sweep retries directly). Safe to re-run — the receiver dedupes by originSeq.
   */
  async flushDomain(domain: string): Promise<void> {
    const byScope = this.domains.get(domain);
    if (!byScope || byScope.size === 0) return;
    const flat = [...byScope.entries()].sort((a, b) => a[1].generatedAt - b[1].generatedAt);
    for (let i = 0; i < flat.length; i += FederationBufferService.BATCH) {
      const slice = flat.slice(i, i + FederationBufferService.BATCH);
      const entries = slice.map(([, e]) => this.toWire(e));
      const hasMore = i + FederationBufferService.BATCH < flat.length;
      try {
        await this.federation.pushNewMsgMap(domain, entries, hasMore);
        for (const [key] of slice) byScope.delete(key); // acked → drop
      } catch {
        return; // leave the rest buffered; rescheduled on next markDirty / sweep
      }
    }
    if (byScope.size === 0) this.domains.delete(domain);
  }

  /** Flatten a DirtyEntry to the on-wire NewMsgMapEntry (drops generatedAt). */
  private toWire(e: DirtyEntry): NewMsgMapEntry {
    return e.left
      ? { from: e.from, fromDomain: e.fromDomain, to: e.to, latestSeq: e.latestSeq, left: true }
      : { from: e.from, fromDomain: e.fromDomain, to: e.to, latestSeq: e.latestSeq };
  }

  /**
   * Snapshot OUR outbound hint entries for a requester domain (GET /api/v1/s2s/new-msg-map). The peer
   * pulls these to learn which conversations have new messages on our side — the one-directional fallback
   * (§4.3). NON-DESTRUCTIVE: entries are removed only on a successful PUSH ack, never on pull. The cursor
   * is a numeric offset; a shift between paginated calls at worst re-delivers a hint, which the receiver's
   * originSeq dedup absorbs harmlessly.
   */
  snapshotOutboundFor(
    domain: string,
    cursor: number,
    take: number,
  ): { entries: NewMsgMapEntry[]; cursor: number | null; hasMore: boolean } {
    const byScope = this.domains.get(domain);
    if (!byScope || byScope.size === 0) return { entries: [], cursor: null, hasMore: false };
    const flat = [...byScope.values()].sort((a, b) => a.generatedAt - b.generatedAt);
    const start = Math.max(0, cursor);
    const slice = flat.slice(start, start + take);
    const nextCursor = start + take;
    const hasMore = nextCursor < flat.length;
    return {
      entries: slice.map((e) => this.toWire(e)),
      cursor: hasMore ? nextCursor : null,
      hasMore,
    };
  }

  onModuleDestroy(): void {
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
  }
}
