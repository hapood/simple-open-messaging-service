import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  user,
  userQuotaDailyAllowance,
  userQuotaDailyUsage,
  userQuotaFileByteUsage,
  userQuotaPolicy,
} from '../database/schema.js';
import { BreakerFlags, type BreakerDim } from './breaker-flags.js';
import type {
  BreakerStatus,
  QuotaCategory,
  QuotaOverrides,
} from './quota.service.js';

type UserQuotaCategory = Exclude<QuotaCategory, 'signals'>;

/**
 * Daily-quota enforcement for LOCAL user accounts, scoped per `userId`. Mirrors the federated {@link QuotaService}
 * shape: a 3-dimension circuit breaker (msg cnt / file cnt / file total size) with an in-memory tripped flag that
 * pauses ONLY this user's sends + uploads, plus the legacy `requests` anti-spam counter. Foreign/group accounts are
 * rejected (personal quota is local-accounts only). The breaker flag is a cache over persisted daily counters and
 * self-heals lazily (the next overshooting tick re-marks it after a restart); file claims are always gated by the
 * authoritative {@link preCheckFile} read.
 */
@Injectable()
export class UserQuotaService {
  private readonly defaults: UserQuotaDefaults = {
    dailyMsgLimit: quotaIntEnv('SOMS_USER_QUOTA_DAILY_MSG_LIMIT', 1000),
    dailyRequestLimit: quotaIntEnv('SOMS_USER_QUOTA_DAILY_REQUEST_LIMIT', 50),
    dailyFileLimit: quotaIntEnv('SOMS_USER_QUOTA_DAILY_FILE_LIMIT', 100),
    dailyFileBytesLimit: BigInt(
      quotaIntEnv('SOMS_USER_QUOTA_DAILY_FILE_BYTES_LIMIT', 500 * 1024 * 1024),
    ),
  };
  private readonly breaker = new BreakerFlags();

  constructor(private readonly database: DatabaseService) {}

  async getState(userId: number): Promise<UserQuotaState> {
    await this.assertLocalAccount(userId);
    const [policy, rows, bytesRow, allowance] = await Promise.all([
      this.database.db.query.userQuotaPolicy.findFirst({
        where: eq(userQuotaPolicy.userId, userId),
      }),
      this.database.db
        .select({
          category: userQuotaDailyUsage.category,
          count: userQuotaDailyUsage.count,
        })
        .from(userQuotaDailyUsage)
        .where(
          and(
            eq(userQuotaDailyUsage.userId, userId),
            eq(userQuotaDailyUsage.date, utcToday()),
          ),
        ),
      this.database.db.query.userQuotaFileByteUsage.findFirst({
        where: and(
          eq(userQuotaFileByteUsage.userId, userId),
          eq(userQuotaFileByteUsage.date, utcToday()),
        ),
        columns: { bytes: true },
      }),
      this.getAllowance(userId),
    ]);
    const overrides = normalizeOverrides(policy ?? {});
    const limits = this.effectiveBreakerLimits(overrides, allowance);
    const counts = zeroCounts();
    for (const row of rows) {
      if (row.category in counts)
        counts[row.category as UserQuotaCategory] = row.count;
    }
    return {
      overrides,
      usage: userQuotaCategories.reduce(
        (result, category) => {
          result[category] = {
            count: counts[category],
            limit: this.effectiveLimit(overrides, category),
          };
          return result;
        },
        {} as UserQuotaState['usage'],
      ),
      breaker: {
        tripped: this.breaker.isTripped(String(userId), utcToday()),
        trippedDims: this.breaker.trippedDims(String(userId), utcToday()),
        msg: { count: counts.messages, limit: limits.msg },
        file: { count: counts.files ?? 0, limit: limits.file },
        fileBytes: {
          bytes: (bytesRow?.bytes ?? 0n).toString(),
          limit: limits.fileBytes,
        },
      },
    };
  }

  /** Compact state for an admin user-list page, fetched in two page-wide queries. */
  async getSummaries(
    userIds: number[],
  ): Promise<Map<number, UserQuotaSummary>> {
    if (userIds.length === 0) return new Map();
    const [policies, usageRows] = await Promise.all([
      this.database.db
        .select()
        .from(userQuotaPolicy)
        .where(inArray(userQuotaPolicy.userId, userIds)),
      this.database.db
        .select({
          userId: userQuotaDailyUsage.userId,
          category: userQuotaDailyUsage.category,
          count: userQuotaDailyUsage.count,
        })
        .from(userQuotaDailyUsage)
        .where(
          and(
            inArray(userQuotaDailyUsage.userId, userIds),
            eq(userQuotaDailyUsage.date, utcToday()),
          ),
        ),
    ]);
    const policyByUser = new Map(
      policies.map((policy) => [policy.userId, normalizeOverrides(policy)]),
    );
    const countsByUser = new Map<number, Record<UserQuotaCategory, number>>();
    for (const row of usageRows) {
      const counts = countsByUser.get(row.userId) ?? zeroCounts();
      if (row.category in counts)
        counts[row.category as UserQuotaCategory] = row.count;
      countsByUser.set(row.userId, counts);
    }
    return new Map(
      userIds.map((userId) => {
        const overrides = policyByUser.get(userId) ?? normalizeOverrides({});
        const counts = countsByUser.get(userId) ?? zeroCounts();
        const usage = userQuotaCategories.map((category) => ({
          count: counts[category],
          limit: this.effectiveLimit(overrides, category),
        }));
        return [
          userId,
          {
            status: quotaSummaryStatus(usage),
            hasOverrides: Object.values(overrides).some(
              (value) => value !== null && value !== undefined,
            ),
          },
        ];
      }),
    );
  }

  async setPolicy(userId: number, input: QuotaOverrides): Promise<void> {
    await this.assertLocalAccount(userId);
    const value = normalizeOverrides(input);
    await this.database.db
      .insert(userQuotaPolicy)
      .values({ userId, ...value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userQuotaPolicy.userId,
        set: { ...value, updatedAt: new Date() },
      });
  }

  /**
   * Authoritative atomic count+check for the `requests` anti-spam counter (and any caller that wants a throwing
   * per-category check). Throws QUOTA_EXCEEDED (10008, HTTP 200) if the post-increment count exceeds the limit.
   * NOT used for the breaker dimensions — those use {@link tickLax} (land-then-mark) so a message can land.
   */
  async tick(
    userId: number,
    category: UserQuotaCategory,
    tx: DatabaseTransaction,
    amount = 1,
  ): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('quota amount must be a positive safe integer');
    }
    const policy = await tx.query.userQuotaPolicy.findFirst({
      where: eq(userQuotaPolicy.userId, userId),
    });
    const limit = this.effectiveLimit(
      normalizeOverrides(policy ?? {}),
      category,
    );
    const result = await tx.execute<{ count: number }>(sql`
      INSERT INTO "UserQuotaDailyUsage" ("userId", "date", "category", "count")
      VALUES (${userId}, ${utcToday()}, ${category}, ${amount})
      ON CONFLICT ("userId", "date", "category")
      DO UPDATE SET "count" = "UserQuotaDailyUsage"."count" + ${amount}
      RETURNING "count"
    `);
    const count = result.rows[0]?.count ?? amount;
    if (count > limit) {
      throw new BusinessException(
        BusinessCode.QUOTA_EXCEEDED,
        `daily personal quota exceeded: ${category} ${count}/${limit}`,
        HttpStatus.OK,
        { category, limit, retryAfter: retryAfterSeconds() },
      );
    }
  }

  async tickStandalone(
    userId: number,
    category: UserQuotaCategory,
    amount = 1,
  ): Promise<void> {
    await this.database.db.transaction((tx) =>
      this.tick(userId, category, tx, amount),
    );
  }

  // ── circuit breaker (msg cnt / file cnt / file total size), per-user ────────────────────────────────

  /** Synchronous send/upload gate: throw QUOTA_EXCEEDED (10008, HTTP 200) if this user's breaker is tripped. */
  async assertCanSend(userId: number): Promise<void> {
    const today = utcToday();
    const dims = this.breaker.trippedDims(String(userId), today);
    if (dims.length > 0) {
      throw new BusinessException(
        BusinessCode.QUOTA_EXCEEDED,
        `daily quota exhausted (paused): ${dims.join(',')}`,
        HttpStatus.OK,
        { dims, retryAfter: retryAfterSeconds() },
      );
    }
  }

  isTripped(userId: number): boolean {
    return this.breaker.isTripped(String(userId), utcToday());
  }

  /** Non-throwing atomic increment for msg cnt / file cnt (land-then-mark). Marks the breaker if over. */
  async tickLax(
    userId: number,
    category: 'messages' | 'files',
    tx?: DatabaseTransaction,
    amount = 1,
  ): Promise<{ count: number; limit: number; over: boolean }> {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('quota amount must be a positive safe integer');
    }
    const limits = this.effectiveBreakerLimits(
      normalizeOverrides(await this.getPolicy(userId)),
      await this.getAllowance(userId),
    );
    const limit = category === 'messages' ? limits.msg : limits.file;
    const today = utcToday();
    const runner = tx ?? this.database.db;
    const rows = await runner
      .insert(userQuotaDailyUsage)
      .values({ userId, date: today, category, count: amount })
      .onConflictDoUpdate({
        target: [
          userQuotaDailyUsage.userId,
          userQuotaDailyUsage.date,
          userQuotaDailyUsage.category,
        ],
        set: { count: sql`${userQuotaDailyUsage.count} + ${amount}` },
      })
      .returning({ count: userQuotaDailyUsage.count });
    const count = rows[0]?.count ?? amount;
    const over = count > limit;
    if (over)
      this.breaker.mark(
        String(userId),
        category === 'messages' ? 'msg' : 'file',
        today,
      );
    return { count, limit, over };
  }

  /** Atomic increment of the file-total-size accumulator (bigint) at claim time; marks the breaker if over. */
  async tickFileBytes(
    userId: number,
    declaredBytes: bigint,
    tx?: DatabaseTransaction,
  ): Promise<{ bytes: bigint; limit: number; over: boolean }> {
    const limits = this.effectiveBreakerLimits(
      normalizeOverrides(await this.getPolicy(userId)),
      await this.getAllowance(userId),
    );
    const limit = BigInt(limits.fileBytes);
    const today = utcToday();
    const runner = tx ?? this.database.db;
    const rows = await runner
      .insert(userQuotaFileByteUsage)
      .values({ userId, date: today, bytes: declaredBytes })
      .onConflictDoUpdate({
        target: [userQuotaFileByteUsage.userId, userQuotaFileByteUsage.date],
        set: { bytes: sql`${userQuotaFileByteUsage.bytes} + ${declaredBytes}` },
      })
      .returning({ bytes: userQuotaFileByteUsage.bytes });
    const bytes = rows[0]?.bytes ?? declaredBytes;
    const over = bytes > limit;
    if (over) this.breaker.mark(String(userId), 'fileBytes', today);
    return { bytes, limit: limits.fileBytes, over };
  }

  /** Add `extraBytes` without a pre-check (download oversize); conservative, never subtracts; marks the breaker. */
  async addFileBytesDelta(
    userId: number,
    extraBytes: bigint,
    tx?: DatabaseTransaction,
  ): Promise<void> {
    if (extraBytes <= 0n) return;
    const today = utcToday();
    const runner = tx ?? this.database.db;
    await runner
      .insert(userQuotaFileByteUsage)
      .values({ userId, date: today, bytes: extraBytes })
      .onConflictDoUpdate({
        target: [userQuotaFileByteUsage.userId, userQuotaFileByteUsage.date],
        set: { bytes: sql`${userQuotaFileByteUsage.bytes} + ${extraBytes}` },
      });
    this.breaker.mark(String(userId), 'fileBytes', today);
  }

  /**
   * Strict-before file claim gate: refuse a download/upload if it would push file cnt OR file total size over today's
   * effective limit. Throws QUOTA_EXCEEDED (10008, HTTP 200) and marks the breaker.
   */
  async preCheckFile(
    userId: number,
    addCnt: number,
    addBytes: bigint,
    tx?: DatabaseTransaction,
  ): Promise<void> {
    const limits = this.effectiveBreakerLimits(
      normalizeOverrides(await this.getPolicy(userId)),
      await this.getAllowance(userId),
    );
    const today = utcToday();
    const runner = tx ?? this.database.db;
    const cntRow = await runner.query.userQuotaDailyUsage.findFirst({
      where: and(
        eq(userQuotaDailyUsage.userId, userId),
        eq(userQuotaDailyUsage.date, today),
        eq(userQuotaDailyUsage.category, 'files'),
      ),
      columns: { count: true },
    });
    const bytesRow = await runner.query.userQuotaFileByteUsage.findFirst({
      where: and(
        eq(userQuotaFileByteUsage.userId, userId),
        eq(userQuotaFileByteUsage.date, today),
      ),
      columns: { bytes: true },
    });
    const curCnt = cntRow?.count ?? 0;
    const curBytes = bytesRow?.bytes ?? 0n;
    const overCnt = curCnt + addCnt > limits.file;
    const overBytes = curBytes + addBytes > BigInt(limits.fileBytes);
    if (overCnt || overBytes) {
      if (overCnt) this.breaker.mark(String(userId), 'file', today);
      if (overBytes) this.breaker.mark(String(userId), 'fileBytes', today);
      throw new BusinessException(
        BusinessCode.QUOTA_EXCEEDED,
        `daily file quota exceeded: cnt ${curCnt + addCnt}/${limits.file} bytes ${(
          curBytes + addBytes
        ).toString()}/${limits.fileBytes}`,
        HttpStatus.OK,
        {
          category: 'files',
          limit: limits.file,
          retryAfter: retryAfterSeconds(),
        },
      );
    }
  }

  /** Admin "continue / add quota": additive bump to today's allowance, then reconcile. */
  async addQuota(
    userId: number,
    input: { addMsg?: number; addFile?: number; addFileBytes?: bigint },
  ): Promise<BreakerStatus> {
    const addMsg = Math.max(0, Math.trunc(input.addMsg ?? 0));
    const addFile = Math.max(0, Math.trunc(input.addFile ?? 0));
    const addFileBytes =
      input.addFileBytes && input.addFileBytes > 0n ? input.addFileBytes : 0n;
    const today = utcToday();
    await this.database.db
      .insert(userQuotaDailyAllowance)
      .values({
        userId,
        date: today,
        extraMsg: addMsg,
        extraFile: addFile,
        extraFileBytes: addFileBytes,
      })
      .onConflictDoUpdate({
        target: [userQuotaDailyAllowance.userId, userQuotaDailyAllowance.date],
        set: {
          extraMsg: sql`${userQuotaDailyAllowance.extraMsg} + ${addMsg}`,
          extraFile: sql`${userQuotaDailyAllowance.extraFile} + ${addFile}`,
          extraFileBytes: sql`${userQuotaDailyAllowance.extraFileBytes} + ${addFileBytes}`,
        },
      });
    await this.recomputeBreaker(userId);
    return this.breakerStatus(userId);
  }

  /** Re-derive this user's breaker dims from persisted counters (after addQuota / admin tooling). */
  async recomputeBreaker(userId: number): Promise<void> {
    const limits = this.effectiveBreakerLimits(
      normalizeOverrides(await this.getPolicy(userId)),
      await this.getAllowance(userId),
    );
    const today = utcToday();
    const [msgRow, fileRow, bytesRow] = await Promise.all([
      this.database.db.query.userQuotaDailyUsage.findFirst({
        where: and(
          eq(userQuotaDailyUsage.userId, userId),
          eq(userQuotaDailyUsage.date, today),
          eq(userQuotaDailyUsage.category, 'messages'),
        ),
        columns: { count: true },
      }),
      this.database.db.query.userQuotaDailyUsage.findFirst({
        where: and(
          eq(userQuotaDailyUsage.userId, userId),
          eq(userQuotaDailyUsage.date, today),
          eq(userQuotaDailyUsage.category, 'files'),
        ),
        columns: { count: true },
      }),
      this.database.db.query.userQuotaFileByteUsage.findFirst({
        where: and(
          eq(userQuotaFileByteUsage.userId, userId),
          eq(userQuotaFileByteUsage.date, today),
        ),
        columns: { bytes: true },
      }),
    ]);
    const over: BreakerDim[] = [];
    if ((msgRow?.count ?? 0) > limits.msg) over.push('msg');
    if ((fileRow?.count ?? 0) > limits.file) over.push('file');
    if ((bytesRow?.bytes ?? 0n) > BigInt(limits.fileBytes))
      over.push('fileBytes');
    this.breaker.reconcile(String(userId), over, today);
  }

  async breakerStatus(userId: number): Promise<BreakerStatus> {
    const limits = this.effectiveBreakerLimits(
      normalizeOverrides(await this.getPolicy(userId)),
      await this.getAllowance(userId),
    );
    const today = utcToday();
    const [msgRow, fileRow, bytesRow] = await Promise.all([
      this.database.db.query.userQuotaDailyUsage.findFirst({
        where: and(
          eq(userQuotaDailyUsage.userId, userId),
          eq(userQuotaDailyUsage.date, today),
          eq(userQuotaDailyUsage.category, 'messages'),
        ),
        columns: { count: true },
      }),
      this.database.db.query.userQuotaDailyUsage.findFirst({
        where: and(
          eq(userQuotaDailyUsage.userId, userId),
          eq(userQuotaDailyUsage.date, today),
          eq(userQuotaDailyUsage.category, 'files'),
        ),
        columns: { count: true },
      }),
      this.database.db.query.userQuotaFileByteUsage.findFirst({
        where: and(
          eq(userQuotaFileByteUsage.userId, userId),
          eq(userQuotaFileByteUsage.date, today),
        ),
        columns: { bytes: true },
      }),
    ]);
    const dims = this.breaker.trippedDims(String(userId), today);
    return {
      entity: String(userId),
      scope: 'user',
      tripped: dims.length > 0,
      trippedDims: dims,
      retryAfter: retryAfterSeconds(),
      msg: { count: msgRow?.count ?? 0, limit: limits.msg },
      file: { count: fileRow?.count ?? 0, limit: limits.file },
      fileBytes: {
        bytes: (bytesRow?.bytes ?? 0n).toString(),
        limit: limits.fileBytes,
      },
    };
  }

  /** All currently-tripped user breakers (admin dashboard banner). */
  async trippedBreakers(): Promise<BreakerStatus[]> {
    const today = utcToday();
    const keys = this.breaker.trippedEntities(today);
    return Promise.all(keys.map((k) => this.breakerStatus(Number(k))));
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────

  private async getPolicy(userId: number): Promise<QuotaOverrides> {
    const policy = await this.database.db.query.userQuotaPolicy.findFirst({
      where: eq(userQuotaPolicy.userId, userId),
    });
    return normalizeOverrides(policy ?? {});
  }

  private async getAllowance(
    userId: number,
  ): Promise<{ extraMsg: number; extraFile: number; extraFileBytes: bigint }> {
    const row = await this.database.db.query.userQuotaDailyAllowance.findFirst({
      where: and(
        eq(userQuotaDailyAllowance.userId, userId),
        eq(userQuotaDailyAllowance.date, utcToday()),
      ),
    });
    return {
      extraMsg: row?.extraMsg ?? 0,
      extraFile: row?.extraFile ?? 0,
      extraFileBytes: row?.extraFileBytes ?? 0n,
    };
  }

  private effectiveBreakerLimits(
    overrides: QuotaOverrides,
    allowance: { extraMsg: number; extraFile: number; extraFileBytes: bigint },
  ): { msg: number; file: number; fileBytes: number } {
    return {
      msg:
        (overrides.dailyMsgLimit ?? this.defaults.dailyMsgLimit) +
        allowance.extraMsg,
      file:
        (overrides.dailyFileLimit ?? this.defaults.dailyFileLimit) +
        allowance.extraFile,
      fileBytes:
        Number(
          overrides.dailyFileBytesLimit ?? this.defaults.dailyFileBytesLimit,
        ) + Number(allowance.extraFileBytes),
    };
  }

  private effectiveLimit(
    overrides: QuotaOverrides,
    category: UserQuotaCategory,
  ): number {
    if (category === 'messages')
      return overrides.dailyMsgLimit ?? this.defaults.dailyMsgLimit;
    if (category === 'files')
      return overrides.dailyFileLimit ?? this.defaults.dailyFileLimit;
    return overrides.dailyRequestLimit ?? this.defaults.dailyRequestLimit;
  }

  private async assertLocalAccount(userId: number): Promise<void> {
    const row = await this.database.db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: { isForeigner: true, isGroup: true },
    });
    if (!row)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'user not found');
    if (row.isForeigner || row.isGroup) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'personal quota is available only for local user accounts',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}

const userQuotaCategories: UserQuotaCategory[] = [
  'messages',
  'files',
  'requests',
];

function zeroCounts(): Record<UserQuotaCategory, number> {
  return { messages: 0, files: 0, requests: 0 };
}

function utcToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function retryAfterSeconds(): number {
  const now = new Date();
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function quotaIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeOverrides(input: QuotaOverrides): QuotaOverrides {
  const value = (candidate: unknown): number | null =>
    typeof candidate === 'number' &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
      ? candidate
      : null;
  const big = (candidate: unknown): bigint | null =>
    typeof candidate === 'bigint' && candidate >= 0n ? candidate : null;
  return {
    dailyMsgLimit: value(input.dailyMsgLimit),
    dailyRequestLimit: value(input.dailyRequestLimit),
    dailyFileLimit: value(input.dailyFileLimit),
    dailyFileBytesLimit: big(input.dailyFileBytesLimit),
  };
}

export interface UserQuotaState {
  overrides: QuotaOverrides;
  usage: Record<UserQuotaCategory, { count: number; limit: number }>;
  breaker: {
    tripped: boolean;
    trippedDims: BreakerDim[];
    msg: { count: number; limit: number };
    file: { count: number; limit: number };
    fileBytes: { bytes: string; limit: number };
  };
}

export type UserQuotaSummaryStatus =
  | 'healthy'
  | 'warning'
  | 'exhausted'
  | 'disabled';

export interface UserQuotaSummary {
  status: UserQuotaSummaryStatus;
  hasOverrides: boolean;
}

export function quotaSummaryStatus(
  usage: Array<{ count: number; limit: number }>,
): UserQuotaSummaryStatus {
  const enabled = usage.filter(({ limit }) => limit > 0);
  if (enabled.length === 0) return 'disabled';
  if (enabled.some(({ count, limit }) => count >= limit)) return 'exhausted';
  if (enabled.some(({ count, limit }) => count / limit >= 0.8))
    return 'warning';
  return 'healthy';
}

interface UserQuotaDefaults {
  dailyMsgLimit: number;
  dailyRequestLimit: number;
  dailyFileLimit: number;
  dailyFileBytesLimit: bigint;
}
