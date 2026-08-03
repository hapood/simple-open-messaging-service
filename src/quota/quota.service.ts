import { Injectable, HttpStatus } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { federatedPeer, quotaDailyUsage } from '../database/schema.js';
import {
  loadQuotaConfig,
  type QuotaConfig,
} from '../federation/federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Daily-quota enforcement for federated peer servers. A peer's domain is the trust and accounting
 * boundary: all users from that server share its counters. Local accounts use a separate userId-based
 * quota model and never consume these domain buckets.
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
 * Federation callers throw `BusinessException(FEDERATION_QUOTA_EXCEEDED, …, 429)` or
 * `FEDERATION_PAYLOAD_TOO_LARGE` (413); these capacity responses never demote the peer.
 */
@Injectable()
export class QuotaService {
  private readonly cfg: QuotaConfig = loadQuotaConfig();
  constructor(private readonly database: DatabaseService) {}

  // ── limit / cap resolution ───────────────────────────────────────────────

  /** Per-node override set (null/absent = use the global default for that field). */
  async getOverrides(domain: string): Promise<QuotaOverrides> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, domain),
      columns: {
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
    this.assertCapabilityEnabled(category, limit);
    const row = await this.database.db.query.quotaDailyUsage.findFirst({
      where: and(
        eq(quotaDailyUsage.domain, domain),
        eq(quotaDailyUsage.date, this.utcToday()),
        eq(quotaDailyUsage.category, category),
      ),
      columns: { count: true },
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
    tx?: DatabaseTransaction | LegacyRawTransaction,
    amount = 1,
  ): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('quota amount must be a positive safe integer');
    }
    const overrides = await this.getOverrides(domain);
    const limit = this.effectiveLimit(overrides, category);
    this.assertCapabilityEnabled(category, limit);
    const today = this.utcToday();
    const run = async (
      runner: DatabaseTransaction | LegacyRawTransaction,
    ): Promise<void> => {
      const rows =
        'execute' in runner
          ? (
              await runner.execute<{ count: number }>(sql`
                INSERT INTO "QuotaDailyUsage" ("domain", "date", "category", "count")
                VALUES (${domain}, ${today}, ${category}, ${amount})
                ON CONFLICT ("domain", "date", "category")
                DO UPDATE SET "count" = "QuotaDailyUsage"."count" + ${amount}
                RETURNING "count"`)
            ).rows
          : await runner.$queryRawUnsafe<{ count: number }[]>(
              'INSERT INTO "QuotaDailyUsage" ("domain", "date", "category", "count") VALUES ($1, $2, $3, $4) ON CONFLICT ("domain", "date", "category") DO UPDATE SET "count" = "QuotaDailyUsage"."count" + $4 RETURNING "count"',
              domain,
              today,
              category,
              amount,
            );
      const count = rows[0]?.count ?? amount;
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
    else await this.database.db.transaction(run);
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
    this.assertCapabilityEnabled(category, cap);
    if (bytes > cap) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
        `oversized ${category}: ${bytes} bytes > cap ${cap}`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { category, limit: cap, received: bytes },
      );
    }
  }

  private assertCapabilityEnabled(
    category: QuotaCategory,
    effectiveLimit: number,
  ): void {
    if (effectiveLimit !== 0) return;
    throw new BusinessException(
      BusinessCode.FEDERATION_CAPABILITY_DISABLED,
      `federation capability disabled: ${category}`,
      HttpStatus.FORBIDDEN,
      { category },
    );
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
    const rows = await this.database.db
      .select({
        domain: quotaDailyUsage.domain,
        category: quotaDailyUsage.category,
        count: quotaDailyUsage.count,
      })
      .from(quotaDailyUsage)
      .where(
        and(
          eq(quotaDailyUsage.date, this.utcToday()),
          inArray(quotaDailyUsage.domain, domains),
        ),
      );
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
    const cats: QuotaCategory[] = [
      'messages',
      'images',
      'largeFiles',
      'requests',
    ];
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
    const counts =
      (await this.countsToday([domain])).get(domain) ?? zeroCounts();
    return this.buildUsage(counts, overrides);
  }

  /** All federated peer quota nodes with overrides + today's usage. */
  async listNodes(): Promise<QuotaNode[]> {
    const peers = await this.database.db.query.federatedPeer.findMany({
      orderBy: asc(federatedPeer.domain),
      columns: {
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
    const domains = peers.map((p) => p.domain);
    const counts = await this.countsToday(domains);
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
        trustLevel: p.trustLevel,
        overrides,
        effectiveCaps: {
          images: this.effectiveCap(overrides, 'images'),
          largeFiles: this.effectiveCap(overrides, 'largeFiles'),
        },
        usage: this.buildUsage(counts.get(p.domain) ?? zeroCounts(), overrides),
      };
    });
    return peerNodes;
  }

  /** Set a node's override fields. Local → SystemSetting KV; peer → FederatedPeer columns (P2025 if the
   *  peer is unknown → the controller surfaces NOT_FOUND). A null/absent field means "use the default". */
  async setLimits(domain: string, overrides: QuotaOverrides): Promise<void> {
    const normalized = normalizeOverrides(overrides);
    const rows = await this.database.db
      .update(federatedPeer)
      .set({
        dailyMsgLimit: normalized.dailyMsgLimit ?? null,
        dailyImageLimit: normalized.dailyImageLimit ?? null,
        dailyLargeFileLimit: normalized.dailyLargeFileLimit ?? null,
        dailyRequestLimit: normalized.dailyRequestLimit ?? null,
        maxImageBytes: normalized.maxImageBytes ?? null,
        maxLargeFileBytes: normalized.maxLargeFileBytes ?? null,
      })
      .where(eq(federatedPeer.domain, domain))
      .returning({ domain: federatedPeer.domain });
    if (rows.length === 0) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'quota node not found',
      );
    }
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

/** One federated peer's quota state for the admin peer-detail surface. */
export interface QuotaNode {
  domain: string;
  trustLevel: string;
  overrides: QuotaOverrides;
  effectiveCaps: Record<'images' | 'largeFiles', number>;
  usage: Record<QuotaCategory, { count: number; limit: number }> | undefined;
}

/** A fresh all-zero per-category count record (the default for a node with no usage row today). */
function zeroCounts(): Record<QuotaCategory, number> {
  return { messages: 0, images: 0, largeFiles: 0, requests: 0, signals: 0 };
}

type LegacyRawTransaction = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
};

/** Coerce a loose/partial override object into a clean QuotaOverrides (numbers-or-null, no junk). */
function normalizeOverrides(
  src: Partial<QuotaOverrides> | null | undefined,
): QuotaOverrides {
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
