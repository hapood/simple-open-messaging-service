import { Injectable, type OnModuleInit, HttpStatus } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  federatedPeer,
  identityNamespace,
  quotaDailyAllowance,
  quotaDailyUsage,
  quotaFileByteUsage,
  systemSetting,
} from '../database/schema.js';
import type { QuotaConfig } from '../federation/federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { BreakerFlags, type BreakerDim } from './breaker-flags.js';

/**
 * Daily federation quota is scoped to an immutable verified identity namespace, not the peer's
 * domain. A new identity epoch starts with default limits and fresh counters. Local accounts have
 * separate userId-based quota tables. Count increments use DB-atomic upserts; synchronous over-limit
 * increments roll back inside their source transaction. Federation quota failures are HTTP 200
 * business outcomes and do not degrade transport health.
 */
@Injectable()
export class QuotaService implements OnModuleInit {
  private cfg: QuotaConfig = defaultFederationQuotaLimits();
  private readonly breaker = new BreakerFlags();
  constructor(private readonly database: DatabaseService) {}

  /** Rebuild today's breaker cache for every identity namespace on startup. */
  async onModuleInit(): Promise<void> {
    const row = await this.database.db.query.systemSetting.findFirst({
      where: eq(systemSetting.key, FEDERATION_QUOTA_DEFAULTS_KEY),
    });
    if (row) this.cfg = parseFederationQuotaLimits(row.value);
    await this.refreshAll();
  }

  getDefaultLimits(): QuotaConfig {
    return { ...this.cfg };
  }

  async setDefaultLimits(input: Record<string, unknown>): Promise<QuotaConfig> {
    const cfg = validateFederationQuotaLimits(input);
    const value = JSON.stringify(cfg);
    await this.database.db
      .insert(systemSetting)
      .values({ key: FEDERATION_QUOTA_DEFAULTS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemSetting.key, set: { value, updatedAt: new Date() } });
    this.cfg = cfg;
    await this.refreshAll();
    return this.getDefaultLimits();
  }

  async refreshAll(): Promise<void> {
    const namespaces = await this.database.db.query.identityNamespace.findMany({
      columns: { id: true },
    });
    for (const { id } of namespaces) await this.recomputeBreaker(id);
  }

  /** Resolve a domain-facing admin request to its current, verified identity epoch. */
  async activeNamespaceId(domain: string): Promise<number> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(federatedPeer.domain, domain),
      columns: { activeNamespaceId: true },
    });
    if (peer?.activeNamespaceId == null) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'active quota namespace not found');
    }
    return peer.activeNamespaceId;
  }

  // ── limit / cap resolution ───────────────────────────────────────────────

  /** Per-namespace override set (null/absent = use the global default). */
  async getOverrides(
    namespaceId: number,
    tx?: DatabaseTransaction,
  ): Promise<QuotaOverrides> {
    const peer = await (tx ?? this.database.db).query.identityNamespace.findFirst({
      where: eq(identityNamespace.id, namespaceId),
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
   * Read-only pre-check: reject fast if the namespace is at/over its daily limit, WITHOUT writing.
   * Used on the synchronous S2S POST legs (invite / invite-accept) so an exhausted peer's retry does not
   * burn a dedup slot (peek runs before isOpSeen). Returns FEDERATION_QUOTA_EXCEEDED as an HTTP 200
   * business outcome if exhausted.
   * The subsequent {@link tick} is still the authoritative atomic check (peek-then-tick race is benign).
   */
  async peek(namespaceId: number, category: QuotaCategory): Promise<void> {
    const overrides = await this.getOverrides(namespaceId);
    const limit = this.effectiveLimit(overrides, category);
    this.assertCapabilityEnabled(category, limit);
    const row = await this.database.db.query.quotaDailyUsage.findFirst({
      where: and(
        eq(quotaDailyUsage.namespaceId, namespaceId),
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
        { retryAfter },
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
    namespaceId: number,
    category: QuotaCategory,
    tx?: DatabaseTransaction,
    amount = 1,
  ): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('quota amount must be a positive safe integer');
    }
    const today = this.utcToday();
    const run = async (runner: DatabaseTransaction): Promise<void> => {
      const overrides = await this.getOverrides(namespaceId, runner);
      const limit = this.effectiveLimit(overrides, category);
      this.assertCapabilityEnabled(category, limit);
      const { rows } = await runner.execute<{ count: number }>(sql`
        INSERT INTO "QuotaDailyUsage" ("namespaceId", "date", "category", "count")
        VALUES (${namespaceId}, ${today}, ${category}, ${amount})
        ON CONFLICT ("namespaceId", "date", "category")
        DO UPDATE SET "count" = "QuotaDailyUsage"."count" + ${amount}
        RETURNING "count"
      `);
      const count = rows[0]?.count ?? amount;
      if (count > limit) {
        const retryAfter = this.retryAfterSeconds();
        throw new BusinessException(
          BusinessCode.FEDERATION_QUOTA_EXCEEDED,
          `daily quota exceeded: ${category} ${count}/${limit} (resets in ${retryAfter}s)`,
          HttpStatus.OK,
          { retryAfter },
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

  /** Today's additive admin allowance for `namespaceId` (zeros if none granted today). */
  private async getAllowance(
    namespaceId: number,
    tx?: DatabaseTransaction,
  ): Promise<{ extraMsg: number; extraFile: number; extraFileBytes: bigint }> {
    const row = await (
      tx ?? this.database.db
    ).query.quotaDailyAllowance.findFirst({
      where: and(
        eq(quotaDailyAllowance.namespaceId, namespaceId),
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
    namespaceId: number,
    category: 'messages' | 'files',
    tx?: DatabaseTransaction,
    amount = 1,
  ): Promise<{ count: number; limit: number; over: boolean }> {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('quota amount must be a positive safe integer');
    }
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(namespaceId, tx),
      await this.getAllowance(namespaceId, tx),
    );
    const limit = category === 'messages' ? limits.msg : limits.file;
    const today = this.utcToday();
    const runner = tx ?? this.database.db;
    const rows = await runner
      .insert(quotaDailyUsage)
      .values({ namespaceId, date: today, category, count: amount })
      .onConflictDoUpdate({
        target: [
          quotaDailyUsage.namespaceId,
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
        String(namespaceId),
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
    namespaceId: number,
    declaredBytes: bigint,
    tx?: DatabaseTransaction,
  ): Promise<{ bytes: bigint; limit: number; over: boolean }> {
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(namespaceId, tx),
      await this.getAllowance(namespaceId, tx),
    );
    const limit = BigInt(limits.fileBytes);
    const today = this.utcToday();
    const runner = tx ?? this.database.db;
    const rows = await runner
      .insert(quotaFileByteUsage)
      .values({ namespaceId, date: today, bytes: declaredBytes })
      .onConflictDoUpdate({
        target: [quotaFileByteUsage.namespaceId, quotaFileByteUsage.date],
        set: { bytes: sql`${quotaFileByteUsage.bytes} + ${declaredBytes}` },
      })
      .returning({ bytes: quotaFileByteUsage.bytes });
    const bytes = rows[0]?.bytes ?? declaredBytes;
    const over = bytes > limit;
    if (over) this.breaker.mark(String(namespaceId), 'fileBytes', today);
    return { bytes, limit: limits.fileBytes, over };
  }

  /**
   * Add `extraBytes` to the file-total-size accumulator WITHOUT a pre-check — used when a download stream
   * overshoots its declared size (actual > declared). The excess must still count toward quota even though the
   * file is then abandoned (FAILED). Conservative: never subtracts on undersize. Non-throwing; marks the breaker.
   */
  async addFileBytesDelta(
    namespaceId: number,
    extraBytes: bigint,
    tx?: DatabaseTransaction,
  ): Promise<void> {
    if (extraBytes <= 0n) return;
    const today = this.utcToday();
    const runner = tx ?? this.database.db;
    await runner
      .insert(quotaFileByteUsage)
      .values({ namespaceId, date: today, bytes: extraBytes })
      .onConflictDoUpdate({
        target: [quotaFileByteUsage.namespaceId, quotaFileByteUsage.date],
        set: { bytes: sql`${quotaFileByteUsage.bytes} + ${extraBytes}` },
      });
    this.breaker.mark(String(namespaceId), 'fileBytes', today);
  }

  /**
   * Strict-before file claim gate: refuse to start a download/upload if it would push file cnt OR file total
   * size over today's effective limit. Throws FEDERATION_QUOTA_EXCEEDED (HTTP 200 business result; never degrades
   * the peer) and marks the
   * breaker. The read-then-check is not atomic with the subsequent {@link tickFileBytes}, but tickFileBytes
   * re-marks on the increment, so the worst case under concurrency is one extra claim before the breaker trips.
   */
  async preCheckFile(
    namespaceId: number,
    addCnt: number,
    addBytes: bigint,
  ): Promise<void> {
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(namespaceId),
      await this.getAllowance(namespaceId),
    );
    const today = this.utcToday();
    const cntRow = await this.database.db.query.quotaDailyUsage.findFirst({
      where: and(
        eq(quotaDailyUsage.namespaceId, namespaceId),
        eq(quotaDailyUsage.date, today),
        eq(quotaDailyUsage.category, 'files'),
      ),
      columns: { count: true },
    });
    const bytesRow = await this.database.db.query.quotaFileByteUsage.findFirst({
      where: and(
        eq(quotaFileByteUsage.namespaceId, namespaceId),
        eq(quotaFileByteUsage.date, today),
      ),
      columns: { bytes: true },
    });
    const curCnt = cntRow?.count ?? 0;
    const curBytes = bytesRow?.bytes ?? 0n;
    const overCnt = curCnt + addCnt > limits.file;
    const overBytes = curBytes + addBytes > BigInt(limits.fileBytes);
    if (overCnt || overBytes) {
      if (overCnt) this.breaker.mark(String(namespaceId), 'file', today);
      if (overBytes) this.breaker.mark(String(namespaceId), 'fileBytes', today);
      const retryAfter = this.retryAfterSeconds();
      throw new BusinessException(
        BusinessCode.FEDERATION_QUOTA_EXCEEDED,
        `daily file quota exceeded: cnt ${curCnt + addCnt}/${limits.file} bytes ${(
          curBytes + addBytes
        ).toString()}/${limits.fileBytes}`,
        HttpStatus.OK,
        { retryAfter },
      );
    }
  }

  /** Is this namespace's breaker currently tripped (any dimension)? Gate new downloads. */
  isTripped(namespaceId: number): boolean {
    return this.breaker.isTripped(String(namespaceId), this.utcToday());
  }

  /** Re-derive a namespace's breaker dims from persisted counters. */
  async recomputeBreaker(namespaceId: number): Promise<void> {
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(namespaceId),
      await this.getAllowance(namespaceId),
    );
    const today = this.utcToday();
    const msgRow = await this.database.db.query.quotaDailyUsage.findFirst({
      where: and(
        eq(quotaDailyUsage.namespaceId, namespaceId),
        eq(quotaDailyUsage.date, today),
        eq(quotaDailyUsage.category, 'messages'),
      ),
      columns: { count: true },
    });
    const fileRow = await this.database.db.query.quotaDailyUsage.findFirst({
      where: and(
        eq(quotaDailyUsage.namespaceId, namespaceId),
        eq(quotaDailyUsage.date, today),
        eq(quotaDailyUsage.category, 'files'),
      ),
      columns: { count: true },
    });
    const bytesRow = await this.database.db.query.quotaFileByteUsage.findFirst({
      where: and(
        eq(quotaFileByteUsage.namespaceId, namespaceId),
        eq(quotaFileByteUsage.date, today),
      ),
      columns: { bytes: true },
    });
    const over: BreakerDim[] = [];
    if ((msgRow?.count ?? 0) > limits.msg) over.push('msg');
    if ((fileRow?.count ?? 0) > limits.file) over.push('file');
    if ((bytesRow?.bytes ?? 0n) > BigInt(limits.fileBytes))
      over.push('fileBytes');
    this.breaker.reconcile(String(namespaceId), over, today);
  }

  /**
   * Admin "continue / add quota": add an ADDITIVE bump to today's allowance (persisted to QuotaDailyAllowance so a
   * restart does not lose it), then reconcile — dims now within (base+allowance) clear, dims still over stay
   * tripped. Returns the new status.
   */
  async addQuota(
    namespaceId: number,
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
        namespaceId,
        date: today,
        extraMsg: addMsg,
        extraFile: addFile,
        extraFileBytes: addFileBytes,
      })
      .onConflictDoUpdate({
        target: [quotaDailyAllowance.namespaceId, quotaDailyAllowance.date],
        set: {
          extraMsg: sql`${quotaDailyAllowance.extraMsg} + ${addMsg}`,
          extraFile: sql`${quotaDailyAllowance.extraFile} + ${addFile}`,
          extraFileBytes: sql`${quotaDailyAllowance.extraFileBytes} + ${addFileBytes}`,
        },
      });
    await this.recomputeBreaker(namespaceId);
    return this.breakerStatus(namespaceId);
  }

  /** Full breaker + usage snapshot for one peer (admin surfaces + client hint). */
  async breakerStatus(namespaceId: number): Promise<BreakerStatus> {
    const limits = await this.effectiveBreakerLimits(
      await this.getOverrides(namespaceId),
      await this.getAllowance(namespaceId),
    );
    const today = this.utcToday();
    const [msgRow, fileRow, bytesRow] = await Promise.all([
      this.database.db.query.quotaDailyUsage.findFirst({
        where: and(
          eq(quotaDailyUsage.namespaceId, namespaceId),
          eq(quotaDailyUsage.date, today),
          eq(quotaDailyUsage.category, 'messages'),
        ),
        columns: { count: true },
      }),
      this.database.db.query.quotaDailyUsage.findFirst({
        where: and(
          eq(quotaDailyUsage.namespaceId, namespaceId),
          eq(quotaDailyUsage.date, today),
          eq(quotaDailyUsage.category, 'files'),
        ),
        columns: { count: true },
      }),
      this.database.db.query.quotaFileByteUsage.findFirst({
        where: and(
          eq(quotaFileByteUsage.namespaceId, namespaceId),
          eq(quotaFileByteUsage.date, today),
        ),
        columns: { bytes: true },
      }),
    ]);
    const dims = this.breaker.trippedDims(String(namespaceId), today);
    return {
      entity: String(namespaceId),
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
    const ids = this.breaker.trippedEntities(today).map(Number);
    if (ids.length === 0) return [];
    const peers = await this.database.db
      .select({ namespaceId: federatedPeer.activeNamespaceId, domain: federatedPeer.domain })
      .from(federatedPeer)
      .where(inArray(federatedPeer.activeNamespaceId, ids));
    return Promise.all(peers.map(async ({ namespaceId, domain }) => ({
      ...(await this.breakerStatus(namespaceId!)),
      entity: domain,
    })));
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

  /** Today's counters keyed by immutable namespace ID. */
  private async countsToday(
    namespaceIds: number[],
  ): Promise<Map<number, Record<QuotaCategory, number>>> {
    const map = new Map<number, Record<QuotaCategory, number>>();
    if (namespaceIds.length === 0) return map;
    const rows = await this.database.db
      .select({
        namespaceId: quotaDailyUsage.namespaceId,
        category: quotaDailyUsage.category,
        count: quotaDailyUsage.count,
      })
      .from(quotaDailyUsage)
      .where(and(
        eq(quotaDailyUsage.date, this.utcToday()),
        inArray(quotaDailyUsage.namespaceId, namespaceIds),
      ));
    for (const row of rows) {
      let counts = map.get(row.namespaceId);
      if (!counts) {
        counts = zeroCounts();
        map.set(row.namespaceId, counts);
      }
      if (row.category in counts) counts[row.category as QuotaCategory] = row.count;
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

  async usageToday(namespaceId: number): Promise<Record<QuotaCategory, { count: number; limit: number }>> {
    const overrides = await this.getOverrides(namespaceId);
    const counts = (await this.countsToday([namespaceId])).get(namespaceId) ?? zeroCounts();
    return this.buildUsage(counts, overrides);
  }

  /** Domain remains a display/routing address; quota belongs to the active namespace. */
  async listNodes(): Promise<QuotaNode[]> {
    const peers = await this.database.db.query.federatedPeer.findMany({
      orderBy: asc(federatedPeer.domain),
      columns: { domain: true, trustLevel: true, activeNamespaceId: true },
    });
    const activePeers = peers.filter(
      (peer): peer is typeof peer & { activeNamespaceId: number } =>
        peer.activeNamespaceId !== null,
    );
    const namespaceIds = activePeers.map((peer) => peer.activeNamespaceId);
    const counts = await this.countsToday(namespaceIds);
    const overrides = await Promise.all(
      namespaceIds.map((id) => this.getOverrides(id)),
    );
    const overridesById = new Map(
      namespaceIds.map((id, i) => [id, overrides[i]]),
    );
    return activePeers.map((peer) => {
      const namespaceId = peer.activeNamespaceId;
      const settings = overridesById.get(namespaceId) ?? {};
      return {
        domain: peer.domain,
        namespaceId,
        trustLevel: peer.trustLevel,
        overrides: settings,
        usage: this.buildUsage(
          counts.get(namespaceId) ?? zeroCounts(),
          settings,
        ),
      };
    });
  }

  async setLimits(namespaceId: number, overrides: QuotaOverrides): Promise<void> {
    const normalized = normalizeOverrides(overrides);
    const rows = await this.database.db
      .update(identityNamespace)
      .set({
        dailyMsgLimit: normalized.dailyMsgLimit ?? null,
        dailyRequestLimit: normalized.dailyRequestLimit ?? null,
        dailyFileLimit: normalized.dailyFileLimit ?? null,
        dailyFileBytesLimit: normalized.dailyFileBytesLimit ?? null,
      })
      .where(eq(identityNamespace.id, namespaceId))
      .returning({ id: identityNamespace.id });
    if (rows.length === 0) throw new BusinessException(BusinessCode.NOT_FOUND, 'quota namespace not found');
    await this.recomputeBreaker(namespaceId);
  }
}

const FEDERATION_QUOTA_DEFAULTS_KEY = 'quota:federationDefaults';

function defaultFederationQuotaLimits(): QuotaConfig {
  return {
    dailyRequestLimit: 100,
    dailyMsgLimit: 5000,
    dailySignalLimit: 50_000,
    dailyFileLimit: 500,
    dailyFileBytesLimit: 5 * 1024 * 1024 * 1024,
  };
}

function parseFederationQuotaLimits(raw: string): QuotaConfig {
  return validateFederationQuotaLimits(
    JSON.parse(raw) as Record<string, unknown>,
  );
}

function validateFederationQuotaLimits(
  input: Record<string, unknown>,
): QuotaConfig {
  const value = (name: keyof QuotaConfig): number => {
    const candidate = input[name];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0)
      throw new Error(`${name} must be a non-negative safe integer`);
    return candidate as number;
  };
  return {
    dailyRequestLimit: value('dailyRequestLimit'),
    dailyMsgLimit: value('dailyMsgLimit'),
    dailySignalLimit: value('dailySignalLimit'),
    dailyFileLimit: value('dailyFileLimit'),
    dailyFileBytesLimit: value('dailyFileBytesLimit'),
  };
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
  namespaceId: number;
  trustLevel: string;
  overrides: QuotaOverrides;
  usage: Record<QuotaCategory, { count: number; limit: number }>;
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
