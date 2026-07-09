import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { FederationService } from './federation.service.js';

/** One outbound hint entry: the sender <fromUser> has new messages up to latestSeq for <toUser>. */
interface DirtyEntry {
  latestSeq: number;
  generatedAt: number;
}

/**
 * Volatile in-memory buffer of "which conversations have new messages the peer doesn't know about"
 * (the user-named `domain_new_msg_map`). Coalesces per-message notifies into per-(from,to) latest-seq
 * hints so a burst to one peer becomes ONE debounced push; on a peer outage the entries BUFFER here and
 * flush when the 60s reconnect sweep brings the peer back.
 *
 * NOT a source of truth (the Message table is) and NOT persisted — it survives a network outage (the
 * process lives) but NOT a process restart (pull-on-thread-open is the restart floor). Latest-seq-wins
 * means the map is bounded by ACTIVE CONVERSATION COUNT, never message count, so it cannot grow
 * unbounded during a long outage. See docs/federation-step2-design.md §2.3 + §4.1.
 */
@Injectable()
export class FederationBufferService implements OnModuleDestroy {
  private readonly logger = new Logger(FederationBufferService.name);
  /** per-domain → (fromUser → (toUser → entry)). Nested maps — no string-key separator needed. */
  private readonly domains = new Map<string, Map<string, Map<string, DirtyEntry>>>();
  /** One debounced flush timer per domain (cleared in onModuleDestroy). */
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  /** Debounce window: a burst collapses to one push. */
  private static readonly DEBOUNCE_MS = 500;
  /** Per-domain entry cap. On overflow, the older HALF is evicted in one shot. */
  private static readonly CAP_PER_DOMAIN = 10_000;
  /** Entries per push request (each ~80 B → ~80 KB, under the 1 MiB body limit). */
  private static readonly BATCH = 1000;

  constructor(
    private readonly federation: FederationService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Hook for the local send path: after a message is stored (originSeq assigned), mark the conversation
   * dirty for each foreign peer participant. For a P2P thread that's 0 (local-only) or 1 (the foreign
   * stub) peer; a group thread (Step 3) could have several. Local-only / non-federated threads are a
   * no-op. Best-effort: never throws into the send path (the debounce + sweep carry delivery).
   */
  async notifyOnSend(senderUserId: number, threadId: number, originSeq: number): Promise<void> {
    try {
      const participants = await this.prisma.threadParticipant.findMany({
        where: { threadId, leftAt: null },
        include: { user: { select: { account: true, domain: true, isForeigner: true } } },
      });
      const sender = participants.find((p) => p.userId === senderUserId);
      if (!sender) return;
      for (const p of participants) {
        if (p.userId === senderUserId || !p.user.isForeigner) continue;
        this.markDirty(p.user.domain, sender.user.account, p.user.account, originSeq);
      }
    } catch (e) {
      // Never break the send path — a transient DB error just skips this notify (pull-on-open covers it).
      this.logger.debug(`notifyOnSend(${threadId}) failed: ${(e as Error).message}`);
    }
  }

  /**
   * Mark a conversation dirty: the sender <fromUser> has new messages up to latestSeq for <toUser> on
   * <domain>. Latest-seq-wins (never regress — a stale notify must not overwrite a newer one). Enforces
   * the per-domain cap (half-eviction on overflow) and schedules a debounced flush.
   */
  markDirty(domain: string, fromUser: string, toUser: string, latestSeq: number): void {
    let byFrom = this.domains.get(domain);
    if (!byFrom) {
      byFrom = new Map();
      this.domains.set(domain, byFrom);
    }
    let byTo = byFrom.get(fromUser);
    if (!byTo) {
      byTo = new Map();
      byFrom.set(fromUser, byTo);
    }
    const existing = byTo.get(toUser);
    if (existing && existing.latestSeq >= latestSeq) return; // stale — never regress
    byTo.set(toUser, { latestSeq, generatedAt: Date.now() });
    if (this.countDomain(byFrom) > FederationBufferService.CAP_PER_DOMAIN) this.evictHalf(byFrom);
    this.scheduleFlush(domain);
  }

  /** Total entries across a domain's nested map. */
  private countDomain(byFrom: Map<string, Map<string, DirtyEntry>>): number {
    let n = 0;
    for (const byTo of byFrom.values()) n += byTo.size;
    return n;
  }

  /** Flatten a domain's entries to [fromUser, toUser, entry], oldest generatedAt first. */
  private flatten(byFrom: Map<string, Map<string, DirtyEntry>>): Array<[string, string, DirtyEntry]> {
    const out: Array<[string, string, DirtyEntry]> = [];
    for (const [fromUser, byTo] of byFrom) {
      for (const [toUser, e] of byTo) out.push([fromUser, toUser, e]);
    }
    out.sort((a, b) => a[2].generatedAt - b[2].generatedAt);
    return out;
  }

  /** Drop the older HALF of entries by generatedAt in one shot (not one-by-one — avoids thrashing at
   *  the cap boundary). Evicted conversations fall back to the slow-poll floor (§4.4). */
  private evictHalf(byFrom: Map<string, Map<string, DirtyEntry>>): void {
    const flat = this.flatten(byFrom);
    const drop = Math.floor(flat.length / 2);
    for (let i = 0; i < drop; i++) {
      const [fromUser, toUser] = flat[i];
      byFrom.get(fromUser)?.delete(toUser);
    }
    this.compact(byFrom);
  }

  /** Remove emptied fromUser buckets to keep the nested structure tight. */
  private compact(byFrom: Map<string, Map<string, DirtyEntry>>): void {
    for (const [fromUser, byTo] of byFrom) {
      if (byTo.size === 0) byFrom.delete(fromUser);
    }
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
    const byFrom = this.domains.get(domain);
    if (!byFrom || this.countDomain(byFrom) === 0) return;
    const flat = this.flatten(byFrom);
    for (let i = 0; i < flat.length; i += FederationBufferService.BATCH) {
      const slice = flat.slice(i, i + FederationBufferService.BATCH);
      const entries = slice.map(([from, to, e]) => ({ from, to, latestSeq: e.latestSeq }));
      const hasMore = i + FederationBufferService.BATCH < flat.length;
      try {
        await this.federation.pushNewMsgMap(domain, entries, hasMore);
        for (const [fromUser, toUser] of slice) byFrom.get(fromUser)?.delete(toUser); // acked → drop
      } catch {
        return; // leave the rest buffered; rescheduled on next markDirty / sweep
      }
    }
    this.compact(byFrom);
    if (byFrom.size === 0) this.domains.delete(domain);
  }

  /**
   * Snapshot OUR outbound hint entries for a requester domain (GET /api/v1/s2s/new-msg-map). The peer
   * pulls these to learn which of its users have new messages on our side — the one-directional fallback
   * (§4.3). NON-DESTRUCTIVE: entries are removed only on a successful PUSH ack, never on pull. The
   * cursor is a numeric offset; a shift between paginated calls at worst re-delivers a hint, which the
   * receiver's originSeq dedup absorbs harmlessly.
   */
  snapshotOutboundFor(
    domain: string,
    cursor: number,
    take: number,
  ): { entries: Array<{ from: string; to: string; latestSeq: number }>; cursor: number | null; hasMore: boolean } {
    const byFrom = this.domains.get(domain);
    if (!byFrom || this.countDomain(byFrom) === 0) {
      return { entries: [], cursor: null, hasMore: false };
    }
    const flat = this.flatten(byFrom);
    const start = Math.max(0, cursor);
    const slice = flat.slice(start, start + take);
    const nextCursor = start + take;
    const hasMore = nextCursor < flat.length;
    return {
      entries: slice.map(([from, to, e]) => ({ from, to, latestSeq: e.latestSeq })),
      cursor: hasMore ? nextCursor : null,
      hasMore,
    };
  }

  onModuleDestroy(): void {
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
  }
}
