import { Injectable, type OnModuleInit, HttpStatus } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  federatedPeer,
  quotaDailyAllowance,
  quotaDailyUsage,
  quotaFileByteUsage,
} from '../database/schema.js';
import {
  loadQuotaConfig,
  type QuotaConfig,
} from '../federation/federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { BreakerFlags, type BreakerDim } from './breaker-flags.js';

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
 * Federation callers return quota/capability outcomes as HTTP 200 business codes; these capacity
 * responses never demote the peer.
 */
@Injectable()
export class QuotaService implements OnModuleInit {
  private readonly cfg: QuotaConfig = loadQuotaConfig();
  private readonly breaker = new BreakerFlags();
  constructor(private readonly database: DatabaseService) {}

  /**
   * Startup self-heal: re-derive the in-memory breaker flags for every federated peer from today's persisted
   * counters. Without this, a restart would clear the flags and let one more pull/send through before the next
   * overshooting tick re-set them. Idempotent + cheap (one domain per reconcile).
   */
  async onModuleInit(): Promise<void> {
    await this.refreshAll();
  }

  /** Recompute every peer's breaker flags from persisted counters (startup + admin tooling). */
  async refreshAll(): Promise<void> {
    const peers = await this.database.db.query.federatedPeer.findMany({
      columns: { domain: true },
    });
    for (const { domain } of peers) {
      await this.recomputeBreaker(domain);
    }
  }

  // ── limit / cap resolution ───────────────────────────────────────────────

  /** Per-node override set (null/absent = use the global default for that field). */
  async getOverrides(domain: string): Promise<QuotaOverrides> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, domain),
      columns: {
        dailyMsgLimit: true,
        dailyRequestLimit: true,
        dailyFileLimit: true,
        dailyFileBytesLimit: true,
      },
    });
    return peer ?? {};
  }

  /** Effective daily count limit for (overrides, category) = override ?? global default. */
  effectiveLimit(overrides: QuotaOverrides, category: QuotaCategory): number {
    switch (category) {
      case 'messages':
        return overrides.dailyMsgLimit ?? this.cfg.dailyMsgLimit;
      case 'files':
        return overrides.dailyFileLimit ?? this.cfg.dailyFileLimit;
      case 'requests':
        return overrides.dailyRequestLimit ?? this.cfg.dailyRequestLimit;
      case 'signals':
        // Federated WebRTC signal frames (offer/answer/ICE relay). No per-node override (global only) —
        // a dedicated budget so an ICE burst can't be starved by, or starve, the friend-op `requests` bucket.
        return this.cfg.dailySignalLimit;
    }
  }

  // ── federation path: peek (read-only) + tick (atomic count+check, throws 429) ─────────

  /**
   * Read-only pre-check: reject fast if `domain` is already at/over its daily limit, WITHOUT writing.
   * Used on the synchronous S2S POST legs (invite / invite-accept) so an exhausted peer's retry does not
   * burn a dedup slot (peek runs before isOpSeen). Returns FEDERATION_QUOTA_EXCEEDED as an HTTP 200
   * business outcome if exhausted.
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
        HttpStatus.OK,
        { category, limit, retryAfter },
      );
    }
  }

  /**
   * Authoritative atomic count+check for the FEDERATION path. Increments the daily counter and throws
   * FEDERATION_QUOTA_EXCEEDED if the post-increment count exceeds the limit. When `tx` is supplied
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
          HttpStatus.OK,
          { category, limit, retryAfter },
        );
      }
    };
    if (tx) await run(tx);
    else await this.database.db.transaction(run);
  }

  private assertCapabilityEnabled(
    category: QuotaCategory,
    effectiveLimit: number,
  ): void {
    if (effectiveLimit !== 0) return;
    throw new BusinessException(
      BusinessCode.FEDERATION_CAPABILITY_DISABLED,
      `federation capability disabled: ${category}`,
      HttpStatus.OK,
      { category },
    );
  }

  // ── circuit breaker (3 dimensions: msg cnt / file cnt / file total size) ───────────────────────────
  //
  // Federation landing is land-then-count: msg may overshoot by ≤ one pull page, and that overshoot TRIPS the
  // breaker rather than rolling the page back (the page commits, the cursor advances, future pulls pause). File
  // claims are strict-before ({@link preCheckFile} rejects before the transfer starts). Both mark the in-memory
  // flag; {@link isTripped} gates new pull loops and downloads. Counters persist across restart; the flag is
  // re-derived in {@link onModuleInit} and after {@link addQuota}.

  /** Today's additive admin allowance for `domain` (zeros if none granted today). */
  private async getAllowance(
    domain: string,
  ): Promise<{ extraMsg: number; extraFile: number; extraFileBytes: bigint }> {
    const row = await this.database.db.query.quotaDailyAllowance.findFirst({
      where: and(
        eq(quotaDailyAllowance.domain, domain),
        eq(quotaDailyAllowance.date, this.utcToday()),
      ),
    });
    return {
      extraMsg: row?.extraMsg ?? 0,
      extraFile: row?.extraFile ?? 0,
      extraFileBytes: row?.extraFileBytes ?? 0n,
    };
  }

  /** Effective breaker limits for today = base (override ?? default) + admin allowance. fileBytes as a JS number
   *  (safe: caps are GiB-scale, well under 2^53). */
  private async effectiveBreakerLimits(
    overrides: QuotaOverrides,
    allowance: { extraMsg: number; extraFile: number; extraFileBytes: bigint },
  ): Promise<{ msg: number; file: number; fileBytes: number }> {
    return {
      msg:
        (overrides.dailyMsgLimit ?? this.cfg.dailyMsgLimit) +
        allowance.extraMsg,
      file:
        (overrides.dailyFileLimit ?? this.cfg.dailyFileLimit) +
        allowance.extraFile,
      fileBytes:
        Number(overrides.dailyFileBytesLimit ?? this.cfg.dailyFileBytesLimit) +
        Number(allowance.extraFileBytes),
    };
  }

  /**
   * Non-throwing atomic increment for federation LANDING (msg cnt / file cnt). Marks the breaker if the
   * post-increment count exceeds today's effective limit, but does NOT throw — the page that pushed over still
   * commits (cursor advances) and the overshoot trips the breaker to pause FUTURE pulls. Contrast {@link tick},
   * which throws + rolls back and is used on synchronous legs (invite).
   */
  async tickLax(
    domain: string,
    category: 'messages' | 'files',
    tx?: DatabaseTransaction,
    amount = 1,
  ): Promise<{ count: number; limit: number; over: boolean }> {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('quota amount must be a positive safe integer');
    }
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(domain),
      await this.getAllowance(domain),
    );
    const limit = category === 'messages' ? limits.msg : limits.file;
    const today = this.utcToday();
    const runner = tx ?? this.database.db;
    const rows = await runner
      .insert(quotaDailyUsage)
      .values({ domain, date: today, category, count: amount })
      .onConflictDoUpdate({
        target: [
          quotaDailyUsage.domain,
          quotaDailyUsage.date,
          quotaDailyUsage.category,
        ],
        set: { count: sql`${quotaDailyUsage.count} + ${amount}` },
      })
      .returning({ count: quotaDailyUsage.count });
    const count = rows[0]?.count ?? amount;
    const over = count > limit;
    if (over)
      this.breaker.mark(
        domain,
        category === 'messages' ? 'msg' : 'file',
        today,
      );
    return { count, limit, over };
  }

  /**
   * Atomic increment of the file-total-size accumulator (bigint) by `declaredBytes`, at download/upload CLAIM
   * time (before the transfer). Marks the breaker if over; does NOT throw ({@link preCheckFile} already gated, and
   * a concurrent push merely trips the breaker for the next claim). Guard at the caller with
   * `FileSyncProgress.quotaCounted` so a retry does not re-charge the same file.
   */
  async tickFileBytes(
    domain: string,
    declaredBytes: bigint,
    tx?: DatabaseTransaction,
  ): Promise<{ bytes: bigint; limit: number; over: boolean }> {
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(domain),
      await this.getAllowance(domain),
    );
    const limit = BigInt(limits.fileBytes);
    const today = this.utcToday();
    const runner = tx ?? this.database.db;
    const rows = await runner
      .insert(quotaFileByteUsage)
      .values({ domain, date: today, bytes: declaredBytes })
      .onConflictDoUpdate({
        target: [quotaFileByteUsage.domain, quotaFileByteUsage.date],
        set: { bytes: sql`${quotaFileByteUsage.bytes} + ${declaredBytes}` },
      })
      .returning({ bytes: quotaFileByteUsage.bytes });
    const bytes = rows[0]?.bytes ?? declaredBytes;
    const over = bytes > limit;
    if (over) this.breaker.mark(domain, 'fileBytes', today);
    return { bytes, limit: limits.fileBytes, over };
  }

  /**
   * Add `extraBytes` to the file-total-size accumulator WITHOUT a pre-check — used when a download stream
   * overshoots its declared size (actual > declared). The excess must still count toward quota even though the
   * file is then abandoned (FAILED). Conservative: never subtracts on undersize. Non-throwing; marks the breaker.
   */
  async addFileBytesDelta(
    domain: string,
    extraBytes: bigint,
    tx?: DatabaseTransaction,
  ): Promise<void> {
    if (extraBytes <= 0n) return;
    const today = this.utcToday();
    const runner = tx ?? this.database.db;
    await runner
      .insert(quotaFileByteUsage)
      .values({ domain, date: today, bytes: extraBytes })
      .onConflictDoUpdate({
        target: [quotaFileByteUsage.domain, quotaFileByteUsage.date],
        set: { bytes: sql`${quotaFileByteUsage.bytes} + ${extraBytes}` },
      });
    this.breaker.mark(domain, 'fileBytes', today);
  }

  /**
   * Strict-before file claim gate: refuse to start a download/upload if it would push file cnt OR file total
   * size over today's effective limit. Throws FEDERATION_QUOTA_EXCEEDED (429; never demotes the peer) and marks the
   * breaker. The read-then-check is not atomic with the subsequent {@link tickFileBytes}, but tickFileBytes
   * re-marks on the increment, so the worst case under concurrency is one extra claim before the breaker trips.
   */
  async preCheckFile(
    domain: string,
    addCnt: number,
    addBytes: bigint,
  ): Promise<void> {
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(domain),
      await this.getAllowance(domain),
    );
    const today = this.utcToday();
    const cntRow = await this.database.db.query.quotaDailyUsage.findFirst({
      where: and(
        eq(quotaDailyUsage.domain, domain),
        eq(quotaDailyUsage.date, today),
        eq(quotaDailyUsage.category, 'files'),
      ),
      columns: { count: true },
    });
    const bytesRow = await this.database.db.query.quotaFileByteUsage.findFirst({
      where: and(
        eq(quotaFileByteUsage.domain, domain),
        eq(quotaFileByteUsage.date, today),
      ),
      columns: { bytes: true },
    });
    const curCnt = cntRow?.count ?? 0;
    const curBytes = bytesRow?.bytes ?? 0n;
    const overCnt = curCnt + addCnt > limits.file;
    const overBytes = curBytes + addBytes > BigInt(limits.fileBytes);
    if (overCnt || overBytes) {
      if (overCnt) this.breaker.mark(domain, 'file', today);
      if (overBytes) this.breaker.mark(domain, 'fileBytes', today);
      const retryAfter = this.retryAfterSeconds();
      throw new BusinessException(
        BusinessCode.FEDERATION_QUOTA_EXCEEDED,
        `daily file quota exceeded: cnt ${curCnt + addCnt}/${limits.file} bytes ${(
          curBytes + addBytes
        ).toString()}/${limits.fileBytes}`,
        HttpStatus.OK,
        { category: 'files', limit: limits.file, retryAfter },
      );
    }
  }

  /** Is this peer's breaker currently tripped (any dimension)? Gate for async pull loops + new downloads. */
  isTripped(domain: string): boolean {
    return this.breaker.isTripped(domain, this.utcToday());
  }

  /** Re-derive `domain`'s breaker dims from persisted counters (startup self-heal + after {@link addQuota}). */
  async recomputeBreaker(domain: string): Promise<void> {
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(domain),
      await this.getAllowance(domain),
    );
    const today = this.utcToday();
    const msgRow = await this.database.db.query.quotaDailyUsage.findFirst({
      where: and(
        eq(quotaDailyUsage.domain, domain),
        eq(quotaDailyUsage.date, today),
        eq(quotaDailyUsage.category, 'messages'),
      ),
      columns: { count: true },
    });
    const fileRow = await this.database.db.query.quotaDailyUsage.findFirst({
      where: and(
        eq(quotaDailyUsage.domain, domain),
        eq(quotaDailyUsage.date, today),
        eq(quotaDailyUsage.category, 'files'),
      ),
      columns: { count: true },
    });
    const bytesRow = await this.database.db.query.quotaFileByteUsage.findFirst({
      where: and(
        eq(quotaFileByteUsage.domain, domain),
        eq(quotaFileByteUsage.date, today),
      ),
      columns: { bytes: true },
    });
    const over: BreakerDim[] = [];
    if ((msgRow?.count ?? 0) > limits.msg) over.push('msg');
    if ((fileRow?.count ?? 0) > limits.file) over.push('file');
    if ((bytesRow?.bytes ?? 0n) > BigInt(limits.fileBytes))
      over.push('fileBytes');
    this.breaker.reconcile(domain, over, today);
  }

  /**
   * Admin "continue / add quota": add an ADDITIVE bump to today's allowance (persisted to QuotaDailyAllowance so a
   * restart does not lose it), then reconcile — dims now within (base+allowance) clear, dims still over stay
   * tripped. Returns the new status.
   */
  async addQuota(
    domain: string,
    input: { addMsg?: number; addFile?: number; addFileBytes?: bigint },
  ): Promise<BreakerStatus> {
    const addMsg = Math.max(0, Math.trunc(input.addMsg ?? 0));
    const addFile = Math.max(0, Math.trunc(input.addFile ?? 0));
    const addFileBytes =
      input.addFileBytes && input.addFileBytes > 0n ? input.addFileBytes : 0n;
    const today = this.utcToday();
    await this.database.db
      .insert(quotaDailyAllowance)
      .values({
        domain,
        date: today,
        extraMsg: addMsg,
        extraFile: addFile,
        extraFileBytes: addFileBytes,
      })
      .onConflictDoUpdate({
        target: [quotaDailyAllowance.domain, quotaDailyAllowance.date],
        set: {
          extraMsg: sql`${quotaDailyAllowance.extraMsg} + ${addMsg}`,
          extraFile: sql`${quotaDailyAllowance.extraFile} + ${addFile}`,
          extraFileBytes: sql`${quotaDailyAllowance.extraFileBytes} + ${addFileBytes}`,
        },
      });
    await this.recomputeBreaker(domain);
    return this.breakerStatus(domain);
  }

  /** Full breaker + usage snapshot for one peer (admin surfaces + client hint). */
  async breakerStatus(domain: string): Promise<BreakerStatus> {
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(domain),
      await this.getAllowance(domain),
    );
    const today = this.utcToday();
    const [msgRow, fileRow, bytesRow] = await Promise.all([
      this.database.db.query.quotaDailyUsage.findFirst({
        where: and(
          eq(quotaDailyUsage.domain, domain),
          eq(quotaDailyUsage.date, today),
          eq(quotaDailyUsage.category, 'messages'),
        ),
        columns: { count: true },
      }),
      this.database.db.query.quotaDailyUsage.findFirst({
        where: and(
          eq(quotaDailyUsage.domain, domain),
          eq(quotaDailyUsage.date, today),
          eq(quotaDailyUsage.category, 'files'),
        ),
        columns: { count: true },
      }),
      this.database.db.query.quotaFileByteUsage.findFirst({
        where: and(
          eq(quotaFileByteUsage.domain, domain),
          eq(quotaFileByteUsage.date, today),
        ),
        columns: { bytes: true },
      }),
    ]);
    const dims = this.breaker.trippedDims(domain, today);
    return {
      entity: domain,
      scope: 'peer',
      tripped: dims.length > 0,
      trippedDims: dims,
      retryAfter: this.retryAfterSeconds(),
      msg: { count: msgRow?.count ?? 0, limit: limits.msg },
      file: { count: fileRow?.count ?? 0, limit: limits.file },
      fileBytes: {
        bytes: (bytesRow?.bytes ?? 0n).toString(),
        limit: limits.fileBytes,
      },
    };
  }

  /** All currently-tripped peer breakers (admin dashboard banner). */
  async trippedBreakers(): Promise<BreakerStatus[]> {
    const today = this.utcToday();
    const domains = this.breaker.trippedEntities(today);
    return Promise.all(domains.map((d) => this.breakerStatus(d)));
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
    const cats: QuotaCategory[] = ['messages', 'files', 'requests'];
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
        dailyRequestLimit: true,
        dailyFileLimit: true,
        dailyFileBytesLimit: true,
      },
    });
    const domains = peers.map((p) => p.domain);
    const counts = await this.countsToday(domains);
    const peerNodes: QuotaNode[] = peers.map((p) => {
      const overrides: QuotaOverrides = {
        dailyMsgLimit: p.dailyMsgLimit,
        dailyRequestLimit: p.dailyRequestLimit,
        dailyFileLimit: p.dailyFileLimit,
        dailyFileBytesLimit: p.dailyFileBytesLimit ?? null,
      };
      return {
        domain: p.domain,
        trustLevel: p.trustLevel,
        overrides,
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
        dailyRequestLimit: normalized.dailyRequestLimit ?? null,
        dailyFileLimit: normalized.dailyFileLimit ?? null,
        dailyFileBytesLimit: normalized.dailyFileBytesLimit ?? null,
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

export type QuotaCategory = 'messages' | 'files' | 'requests' | 'signals';

/** A per-node override set. null/absent = use the global default for that field. */
export interface QuotaOverrides {
  dailyMsgLimit?: number | null;
  dailyRequestLimit?: number | null;
  dailyFileLimit?: number | null;
  dailyFileBytesLimit?: bigint | null;
}

/** One federated peer's quota state for the admin peer-detail surface. */
export interface QuotaNode {
  domain: string;
  trustLevel: string;
  overrides: QuotaOverrides;
  usage: Record<QuotaCategory, { count: number; limit: number }> | undefined;
}

/** Snapshot of one entity's circuit breaker + usage (admin surfaces + client hint). `bytes` is a decimal
 *  string because file-total-size is a bigint that can exceed JS safe-integer range. */
export interface BreakerStatus {
  entity: string;
  scope: 'peer' | 'user';
  tripped: boolean;
  trippedDims: BreakerDim[];
  retryAfter: number;
  msg: { count: number; limit: number };
  file: { count: number; limit: number };
  fileBytes: { bytes: string; limit: number };
}

/** A fresh all-zero per-category count record (the default for a node with no usage row today). */
function zeroCounts(): Record<QuotaCategory, number> {
  return { messages: 0, files: 0, requests: 0, signals: 0 };
}

type LegacyRawTransaction = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
};

/** Coerce a loose/partial override object into a clean QuotaOverrides (numbers/bigint-or-null, no junk). */
function normalizeOverrides(
  src: Partial<QuotaOverrides> | null | undefined,
): QuotaOverrides {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const big = (v: unknown): bigint | null =>
    typeof v === 'bigint' && v >= 0n ? v : null;
  return {
    dailyMsgLimit: num(src?.dailyMsgLimit),
    dailyRequestLimit: num(src?.dailyRequestLimit),
    dailyFileLimit: num(src?.dailyFileLimit),
    dailyFileBytesLimit: big(src?.dailyFileBytesLimit),
  };
}
