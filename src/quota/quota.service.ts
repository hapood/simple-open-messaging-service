import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import {
  loadFederationConfig,
  loadQuotaConfig,
  type QuotaConfig,
} from '../federation/federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Unified daily-quota enforcement for BOTH the local server (one aggregate bucket keyed by SOMS_DOMAIN
 * — all local users share it) and each federated peer (one bucket per peer domain). A "node" is just a
 * domain; the local node is the server's own SOMS_DOMAIN, peer nodes are their domains. One counter
 * table (QuotaDailyUsage, keyed domain+UTC-date+category) covers both.
 *
 * Four categories, enforced at the point where the data crosses our boundary:
 *  - `requests` — inbound friend ops (federation S2S POST) + outbound friend requests (local). Anti-spam.
 *  - `messages` — text messages (local send + federation pull→store).
 *  - `images` — image media (local upload + federation media ingest).
 *  - `largeFiles` — video/large-file media (local upload + federation media ingest), with a byte cap.
 *
 * Counter store: a DB table, NOT KvStoreService (that is a non-atomic in-process Map). The atomic
 * increment is `INSERT … ON CONFLICT DO UPDATE … RETURNING count`; thrown inside a transaction so an
 * over-limit increment rolls back → exact count (not the doc's ±1 slop) on the federation path.
 *
 * Error split: the tick does NOT throw a UI-specific error — it returns the outcome, and the CALLER
 * renders it. Federation callers throw `BusinessException(FEDERATION_QUOTA_EXCEEDED, …, 429)` /
 * `(FEDERATION_PAYLOAD_TOO_LARGE, …, 413)` (429/413 never demote the peer). Local callers `return`
 * an ApiResult `{ code: QUOTA_EXCEEDED, data: {category, limit, retryAfter} }` at HTTP 200.
 */
@Injectable()
export class QuotaService {
  private readonly cfg: QuotaConfig = loadQuotaConfig();
  /** This server's own domain — the local node's key. */
  private readonly ownDomain: string = loadFederationConfig().domain;

  /** SystemSetting KV key holding the LOCAL node's override JSON (peers use FederatedPeer columns). */
  static readonly LOCAL_KEY = 'quota:local';

  constructor(private readonly prisma: PrismaService) {}

  /** Whether `domain` is this server (the local aggregate node). */
  isLocal(domain: string): boolean {
    return domain === this.ownDomain;
  }

  /** This server's own domain (the local node). */
  get domain(): string {
    return this.ownDomain;
  }

  // ── limit / cap resolution ───────────────────────────────────────────────

  /** Per-node override set (null/absent = use the global default for that field). */
  async getOverrides(domain: string): Promise<QuotaOverrides> {
    if (this.isLocal(domain)) {
      const row = await this.prisma.systemSetting.findUnique({
        where: { key: QuotaService.LOCAL_KEY },
      });
      if (!row) return {};
      try {
        const parsed = JSON.parse(row.value) as Partial<QuotaOverrides>;
        return normalizeOverrides(parsed);
      } catch {
        return {};
      }
    }
    const peer = await this.prisma.federatedPeer.findUnique({
      where: { domain },
      select: {
        dailyMsgLimit: true,
        dailyImageLimit: true,
        dailyLargeFileLimit: true,
        dailyRequestLimit: true,
        maxImageBytes: true,
        maxLargeFileBytes: true,
      },
    });
    return peer ?? {};
  }

  /** Effective daily count limit for (overrides, category) = override ?? global default. */
  effectiveLimit(overrides: QuotaOverrides, category: QuotaCategory): number {
    switch (category) {
      case 'messages':
        return overrides.dailyMsgLimit ?? this.cfg.dailyMsgLimit;
      case 'images':
        return overrides.dailyImageLimit ?? this.cfg.dailyImageLimit;
      case 'largeFiles':
        return overrides.dailyLargeFileLimit ?? this.cfg.dailyLargeFileLimit;
      case 'requests':
        return overrides.dailyRequestLimit ?? this.cfg.dailyRequestLimit;
      case 'signals':
        // Federated WebRTC signal frames (offer/answer/ICE relay). No per-node override (global only) —
        // a dedicated budget so an ICE burst can't be starved by, or starve, the friend-op `requests` bucket.
        return this.cfg.dailySignalLimit;
    }
  }

  /** Effective single-item byte cap (images/largeFiles); MAX_SAFE_INTEGER for count-only categories. */
  effectiveCap(overrides: QuotaOverrides, category: QuotaCategory): number {
    if (category === 'images')
      return overrides.maxImageBytes ?? this.cfg.maxImageBytes;
    if (category === 'largeFiles')
      return overrides.maxLargeFileBytes ?? this.cfg.maxLargeFileBytes;
    return Number.MAX_SAFE_INTEGER;
  }

  // ── federation path: peek (read-only) + tick (atomic count+check, throws 429) ─────────

  /**
   * Read-only pre-check: reject fast if `domain` is already at/over its daily limit, WITHOUT writing.
   * Used on the synchronous S2S POST legs (invite / invite-accept) so an exhausted peer's retry does not
   * burn a dedup slot (peek runs before isOpSeen). Throws FEDERATION_QUOTA_EXCEEDED (429) if exhausted.
   * The subsequent {@link tick} is still the authoritative atomic check (peek-then-tick race is benign).
   */
  async peek(domain: string, category: QuotaCategory): Promise<void> {
    const overrides = await this.getOverrides(domain);
    const limit = this.effectiveLimit(overrides, category);
    const row = await this.prisma.quotaDailyUsage.findUnique({
      where: {
        domain_date_category: {
          domain,
          date: this.utcToday(),
          category,
        },
      },
      select: { count: true },
    });
    const count = row?.count ?? 0;
    if (count >= limit) {
      const retryAfter = this.retryAfterSeconds();
      throw new BusinessException(
        BusinessCode.FEDERATION_QUOTA_EXCEEDED,
        `daily quota exceeded: ${category} ${count}/${limit} (resets in ${retryAfter}s)`,
        HttpStatus.TOO_MANY_REQUESTS,
        { category, limit, retryAfter },
      );
    }
  }

  /**
   * Authoritative atomic count+check for the FEDERATION path. Increments the daily counter and throws
   * FEDERATION_QUOTA_EXCEEDED (429) if the post-increment count exceeds the limit. When `tx` is supplied
   * (e.g. storePulledMessage's message-write tx) the increment runs on it, so the throw rolls BOTH back
   * (no count burn, no seq gap); otherwise it opens its own transaction. Exact — never ±1 over.
   */
  async tick(
    domain: string,
    category: QuotaCategory,
    tx?: PrismaTx,
  ): Promise<void> {
    const overrides = await this.getOverrides(domain);
    const limit = this.effectiveLimit(overrides, category);
    const today = this.utcToday();
    const run = async (runner: PrismaTx): Promise<void> => {
      const rows = await runner.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "QuotaDailyUsage" ("domain", "date", "category", "count")
        VALUES (${domain}, ${today}, ${category}, 1)
        ON CONFLICT ("domain", "date", "category")
        DO UPDATE SET "count" = "QuotaDailyUsage"."count" + 1
        RETURNING "count"`;
      const count = rows[0]?.count ?? 1;
      if (count > limit) {
        const retryAfter = this.retryAfterSeconds();
        throw new BusinessException(
          BusinessCode.FEDERATION_QUOTA_EXCEEDED,
          `daily quota exceeded: ${category} ${count}/${limit} (resets in ${retryAfter}s)`,
          HttpStatus.TOO_MANY_REQUESTS,
          { category, limit, retryAfter },
        );
      }
    };
    if (tx) await run(tx);
    else await this.prisma.$transaction(run);
  }

  /**
   * LOCAL path variant: ticks the local aggregate bucket and RETURNS the outcome (does not throw) so the
   * caller can render `200 + QUOTA_EXCEEDED` with a structured `{category, limit, retryAfter}` body.
   *
   * Exact (not ±1): the increment runs in a transaction and, if the post-increment count exceeds the
   * limit, a sentinel aborts the tx so the over-limit increment rolls back (the bucket stays AT the
   * limit in storage; `exceeded` still reports the attempt). Mirrors the federation tick's exactness.
   */
  async tryTickLocal(category: QuotaCategory): Promise<QuotaTickOutcome> {
    const overrides = await this.getOverrides(this.ownDomain);
    const limit = this.effectiveLimit(overrides, category);
    const today = this.utcToday();
    const rollback = Symbol('quota-rollback');
    let outcome!: QuotaTickOutcome;
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ count: number }>>`
          INSERT INTO "QuotaDailyUsage" ("domain", "date", "category", "count")
          VALUES (${this.ownDomain}, ${today}, ${category}, 1)
          ON CONFLICT ("domain", "date", "category")
          DO UPDATE SET "count" = "QuotaDailyUsage"."count" + 1
          RETURNING "count"`;
        const count = rows[0]?.count ?? 1;
        outcome = {
          count,
          limit,
          retryAfter: this.retryAfterSeconds(),
          exceeded: count > limit,
        };
        if (outcome.exceeded) throw rollback; // abort → increment rolls back; only the sentinel is swallowed
      });
    } catch (e) {
      if (e !== rollback) throw e; // a real DB error propagates
    }
    return outcome;
  }

  /**
   * Federation media byte-cap: throw FEDERATION_PAYLOAD_TOO_LARGE (413) if `bytes` exceeds the single-item
   * cap for the category. Call BEFORE streaming/storing so nothing is written. No-op for count-only
   * categories (messages/requests). The over-limit item is permanently refused (no retry).
   */
  async assertUnderCap(
    domain: string,
    category: QuotaCategory,
    bytes: number,
  ): Promise<void> {
    if (category !== 'images' && category !== 'largeFiles') return;
    const overrides = await this.getOverrides(domain);
    const cap = this.effectiveCap(overrides, category);
    if (bytes > cap) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
        `oversized ${category}: ${bytes} bytes > cap ${cap}`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { category, limit: cap, received: bytes },
      );
    }
  }

  // ── time helpers ─────────────────────────────────────────────────────────

  /** Midnight UTC of "today" — the DATE row key. Explicit UTC (a local-time Date at 23:30 UTC+8 would
   *  otherwise drift the row into yesterday). */
  utcToday(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  /** Seconds remaining to the next 00:00 UTC (when the daily budget resets). */
  retryAfterSeconds(): number {
    const now = Date.now();
    const d = new Date(now);
    const nextMidnightUtc = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + 1,
    );
    return Math.max(1, Math.ceil((nextMidnightUtc - now) / 1000));
  }

  // ── admin surface ────────────────────────────────────────────────────────

  /** Today's per-category counts for `domains` in ONE query (no N+1 over peers). Returns a
   *  domain→{category→count} map; a domain absent from the result has all-zero counts. */
  private async countsToday(
    domains: string[],
  ): Promise<Map<string, Record<QuotaCategory, number>>> {
    const map = new Map<string, Record<QuotaCategory, number>>();
    if (domains.length === 0) return map;
    const rows = await this.prisma.quotaDailyUsage.findMany({
      where: { date: this.utcToday(), domain: { in: domains } },
      select: { domain: true, category: true, count: true },
    });
    for (const r of rows) {
      let dc = map.get(r.domain);
      if (!dc) {
        dc = zeroCounts();
        map.set(r.domain, dc);
      }
      if (r.category in dc) dc[r.category as QuotaCategory] = r.count;
    }
    return map;
  }

  /** Shape counts + overrides into the {count, limit} per-category view (shared by usageToday + listNodes). */
  private buildUsage(
    counts: Record<QuotaCategory, number>,
    overrides: QuotaOverrides,
  ): Record<QuotaCategory, { count: number; limit: number }> {
    const cats: QuotaCategory[] = ['messages', 'images', 'largeFiles', 'requests'];
    return cats.reduce(
      (acc, c) => {
        acc[c] = { count: counts[c], limit: this.effectiveLimit(overrides, c) };
        return acc;
      },
      {} as Record<QuotaCategory, { count: number; limit: number }>,
    );
  }

  /** Today's {count, limit} per category for one node (admin single-node read). */
  async usageToday(
    domain: string,
  ): Promise<Record<QuotaCategory, { count: number; limit: number }>> {
    const overrides = await this.getOverrides(domain);
    const counts = (await this.countsToday([domain])).get(domain) ?? zeroCounts();
    return this.buildUsage(counts, overrides);
  }

  /** All quota nodes (the local node first, then every federated peer) with overrides + today's usage.
   *  Three queries total regardless of peer count (peers, a batched usage fetch, the local KV override) —
   *  no N+1 per peer. */
  async listNodes(): Promise<QuotaNode[]> {
    const peers = await this.prisma.federatedPeer.findMany({
      orderBy: { domain: 'asc' },
      select: {
        domain: true,
        trustLevel: true,
        dailyMsgLimit: true,
        dailyImageLimit: true,
        dailyLargeFileLimit: true,
        dailyRequestLimit: true,
        maxImageBytes: true,
        maxLargeFileBytes: true,
      },
    });
    const domains = [this.ownDomain, ...peers.map((p) => p.domain)];
    const counts = await this.countsToday(domains);
    const localOverrides = await this.getOverrides(this.ownDomain);
    const local: QuotaNode = {
      domain: this.ownDomain,
      isLocal: true,
      trustLevel: null,
      overrides: localOverrides,
      usage: this.buildUsage(
        counts.get(this.ownDomain) ?? zeroCounts(),
        localOverrides,
      ),
    };
    const peerNodes: QuotaNode[] = peers.map((p) => {
      const overrides: QuotaOverrides = {
        dailyMsgLimit: p.dailyMsgLimit,
        dailyImageLimit: p.dailyImageLimit,
        dailyLargeFileLimit: p.dailyLargeFileLimit,
        dailyRequestLimit: p.dailyRequestLimit,
        maxImageBytes: p.maxImageBytes,
        maxLargeFileBytes: p.maxLargeFileBytes,
      };
      return {
        domain: p.domain,
        isLocal: false,
        trustLevel: p.trustLevel,
        overrides,
        usage: this.buildUsage(counts.get(p.domain) ?? zeroCounts(), overrides),
      };
    });
    return [local, ...peerNodes];
  }

  /** Set a node's override fields. Local → SystemSetting KV; peer → FederatedPeer columns (P2025 if the
   *  peer is unknown → the controller surfaces NOT_FOUND). A null/absent field means "use the default". */
  async setLimits(domain: string, overrides: QuotaOverrides): Promise<void> {
    const normalized = normalizeOverrides(overrides);
    if (this.isLocal(domain)) {
      await this.prisma.systemSetting.upsert({
        where: { key: QuotaService.LOCAL_KEY },
        create: {
          key: QuotaService.LOCAL_KEY,
          value: JSON.stringify(normalized),
        },
        update: { value: JSON.stringify(normalized) },
      });
      return;
    }
    await this.prisma.federatedPeer.update({
      where: { domain },
      data: {
        dailyMsgLimit: normalized.dailyMsgLimit ?? null,
        dailyImageLimit: normalized.dailyImageLimit ?? null,
        dailyLargeFileLimit: normalized.dailyLargeFileLimit ?? null,
        dailyRequestLimit: normalized.dailyRequestLimit ?? null,
        maxImageBytes: normalized.maxImageBytes ?? null,
        maxLargeFileBytes: normalized.maxLargeFileBytes ?? null,
      },
    });
  }
}

// ── types ──────────────────────────────────────────────────────────────────

export type QuotaCategory =
  | 'messages'
  | 'images'
  | 'largeFiles'
  | 'requests'
  | 'signals';

/** A per-node override set. null/absent = use the global default for that field. */
export interface QuotaOverrides {
  dailyMsgLimit?: number | null;
  dailyImageLimit?: number | null;
  dailyLargeFileLimit?: number | null;
  dailyRequestLimit?: number | null;
  maxImageBytes?: number | null;
  maxLargeFileBytes?: number | null;
}

/** Outcome of a local {@link QuotaService.tryTickLocal} — the caller renders the 200+code response. */
export interface QuotaTickOutcome {
  count: number;
  limit: number;
  retryAfter: number;
  exceeded: boolean;
}

/** One row of the admin Quotas page. */
export interface QuotaNode {
  domain: string;
  isLocal: boolean;
  trustLevel: string | null;
  overrides: QuotaOverrides;
  usage: Record<QuotaCategory, { count: number; limit: number }> | undefined;
}

/** A Prisma client or transaction client narrowed to the raw-query surface. The `tx` param lets tick
 *  join a caller's existing transaction (storePulledMessage); structurally compatible with both
 *  PrismaService and Prisma.TransactionClient (both expose $queryRaw). */
type PrismaTx = Pick<PrismaService, '$queryRaw'>;

/** A fresh all-zero per-category count record (the default for a node with no usage row today). */
function zeroCounts(): Record<QuotaCategory, number> {
  return { messages: 0, images: 0, largeFiles: 0, requests: 0, signals: 0 };
}

/** Coerce a loose/partial override object into a clean QuotaOverrides (numbers-or-null, no junk). */
function normalizeOverrides(src: Partial<QuotaOverrides> | null | undefined): QuotaOverrides {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    dailyMsgLimit: num(src?.dailyMsgLimit),
    dailyImageLimit: num(src?.dailyImageLimit),
    dailyLargeFileLimit: num(src?.dailyLargeFileLimit),
    dailyRequestLimit: num(src?.dailyRequestLimit),
    maxImageBytes: num(src?.maxImageBytes),
    maxLargeFileBytes: num(src?.maxLargeFileBytes),
  };
}
