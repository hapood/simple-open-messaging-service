import { Injectable } from '@nestjs/common';

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
 * PURE STORAGE for "which conversations have new messages the peer doesn't know about" (the
 * `domain_new_msg_map`). Holds dirty hints keyed by (dest domain → scopeKey), latest-seq-wins. NOT a source
 * of truth (the Message table is) and NOT persisted — it survives a network outage (the process lives) but
 * NOT a restart (pull-on-thread-open is the restart floor). Bounded by ACTIVE CONVERSATION COUNT (one entry
 * per (from, fromDomain, to), never per message), so it cannot grow unbounded during a long outage.
 *
 * Deliberately dependency-free (no FederationService, no PrismaService): the ROUTING (signalOutbound), the
 * debounce timer, and the flush-over-the-signed-transport (pushNewMsgMap) all live in FederationService — a
 * ONE-WAY FederationService → FederationBufferService edge. The old two-way edge (Buffer injected Fed for
 * pushNewMsgMap + ourDomain) was a forwardRef CYCLE whose `design:paramtypes` value references crashed
 * production boot under ESM ("Cannot access 'FederationBufferService' before initialization"). Breaking it
 * here is what lets `node dist/src/main.js` start. FederationService owns signalOutbound + scheduleFlush +
 * flushDomain; this class is just the Map.
 */
@Injectable()
export class FederationBufferService {
  /** per-domain → (scopeKey → entry). scopeKey encodes (from, fromDomain, to, left?) with a \0 separator
   *  (accounts/domains are restricted to letters/digits/dots — never \0), so a message hint and a leave
   *  hint for the same (from, to) coexist without collision. */
  private readonly domains = new Map<string, Map<string, DirtyEntry>>();
  /** Per-domain entry cap. On overflow, the older HALF is evicted in one shot. */
  private static readonly CAP_PER_DOMAIN = 10_000;

  /** scopeKey for the nested map (internal only — \0 cannot appear in accounts/domains). The trailing
   *  left-flag keeps a leave signal distinct from message hints for the same (from, to). */
  private scopeKey(e: { from: string; fromDomain: string; to: string; left?: boolean }): string {
    return `${e.from}\0${e.fromDomain}\0${e.to}\0${e.left ? 1 : 0}`;
  }

  /** Mark a conversation dirty: the author <from>/<fromDomain> has new messages up to latestSeq for <to>
   *  on <domain>. Latest-seq-wins for message hints (never regress — a stale notify must not overwrite a
   *  newer one); a leave hint is always written (keyed separately). Enforces the per-domain cap
   *  (half-eviction on overflow). STORAGE ONLY — the caller (FederationService.signalOutbound) schedules
   *  the debounced flush; this class owns no timers. */
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
  }

  /** Drop the older HALF of entries by generatedAt in one shot (not one-by-one — avoids thrashing at
   *  the cap boundary). Evicted conversations fall back to the slow-poll floor (§4.4). */
  private evictHalf(byScope: Map<string, DirtyEntry>): void {
    const flat = [...byScope.entries()].sort((a, b) => a[1].generatedAt - b[1].generatedAt);
    const drop = Math.floor(flat.length / 2);
    for (let i = 0; i < drop; i++) byScope.delete(flat[i][0]);
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
   * (§4.3). NON-DESTRUCTIVE: entries leave only on a successful PUSH ack (deleteKeys), never on pull. The
   * cursor is a numeric offset; a shift between paginated calls at worst re-delivers a hint, which the
   * receiver's originSeq dedup absorbs harmlessly.
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

  /** The next batch to flush for a domain, oldest-first, with the internal scopeKeys needed to ack it.
   *  NON-DESTRUCTIVE — FederationService.flushDomain calls deleteKeys only AFTER the push acks, so a failed
   *  push leaves the batch buffered for the next retry. */
  flushBatch(
    domain: string,
    batchSize: number,
  ): { entries: NewMsgMapEntry[]; keys: string[]; hasMore: boolean } {
    const byScope = this.domains.get(domain);
    if (!byScope || byScope.size === 0) return { entries: [], keys: [], hasMore: false };
    const flat = [...byScope.entries()].sort((a, b) => a[1].generatedAt - b[1].generatedAt);
    const slice = flat.slice(0, batchSize);
    return {
      entries: slice.map(([, e]) => this.toWire(e)),
      keys: slice.map(([k]) => k),
      hasMore: flat.length > batchSize,
    };
  }

  /** Delete the acked scopeKeys (after a successful push). */
  deleteKeys(domain: string, keys: string[]): void {
    const byScope = this.domains.get(domain);
    if (!byScope) return;
    for (const k of keys) byScope.delete(k);
  }

  /** Remove the domain bucket if empty (called after a flush drain). */
  dropDomainIfEmpty(domain: string): void {
    const byScope = this.domains.get(domain);
    if (byScope && byScope.size === 0) this.domains.delete(domain);
  }
}
