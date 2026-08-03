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
  userQuotaDailyUsage,
  userQuotaPolicy,
} from '../database/schema.js';
import type { QuotaCategory, QuotaOverrides } from './quota.service.js';

type UserQuotaCategory = Exclude<QuotaCategory, 'signals'>;

@Injectable()
export class UserQuotaService {
  private readonly defaults: UserQuotaDefaults = {
    dailyMsgLimit: quotaIntEnv('SOMS_USER_QUOTA_DAILY_MSG_LIMIT', 1000),
    dailyImageLimit: quotaIntEnv('SOMS_USER_QUOTA_DAILY_IMAGE_LIMIT', 100),
    dailyLargeFileLimit: quotaIntEnv(
      'SOMS_USER_QUOTA_DAILY_LARGE_FILE_LIMIT',
      20,
    ),
    dailyRequestLimit: quotaIntEnv('SOMS_USER_QUOTA_DAILY_REQUEST_LIMIT', 50),
    maxImageBytes: quotaIntEnv(
      'SOMS_USER_QUOTA_MAX_IMAGE_BYTES',
      20 * 1024 * 1024,
    ),
    maxLargeFileBytes: quotaIntEnv(
      'SOMS_USER_QUOTA_MAX_LARGE_FILE_BYTES',
      200 * 1024 * 1024,
    ),
  };

  constructor(private readonly database: DatabaseService) {}

  async getState(userId: number): Promise<UserQuotaState> {
    await this.assertLocalAccount(userId);
    const [policy, rows] = await Promise.all([
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
    ]);
    const overrides = normalizeOverrides(policy ?? {});
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
      caps: {
        imageBytes: overrides.maxImageBytes ?? this.defaults.maxImageBytes,
        largeFileBytes:
          overrides.maxLargeFileBytes ?? this.defaults.maxLargeFileBytes,
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

  async assertWithinByteCap(
    userId: number,
    category: 'images' | 'largeFiles',
    bytes: number,
  ): Promise<void> {
    const policy = await this.database.db.query.userQuotaPolicy.findFirst({
      where: eq(userQuotaPolicy.userId, userId),
    });
    const overrides = normalizeOverrides(policy ?? {});
    const limit =
      category === 'images'
        ? (overrides.maxImageBytes ?? this.defaults.maxImageBytes)
        : (overrides.maxLargeFileBytes ?? this.defaults.maxLargeFileBytes);
    if (bytes > limit) {
      throw new BusinessException(
        BusinessCode.QUOTA_EXCEEDED,
        `personal upload size cap exceeded: ${category} ${bytes}/${limit}`,
        HttpStatus.OK,
        { category, limit, actual: bytes },
      );
    }
  }

  private effectiveLimit(
    overrides: QuotaOverrides,
    category: UserQuotaCategory,
  ): number {
    if (category === 'messages')
      return overrides.dailyMsgLimit ?? this.defaults.dailyMsgLimit;
    if (category === 'images')
      return overrides.dailyImageLimit ?? this.defaults.dailyImageLimit;
    if (category === 'largeFiles')
      return overrides.dailyLargeFileLimit ?? this.defaults.dailyLargeFileLimit;
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
  'images',
  'largeFiles',
  'requests',
];

function zeroCounts(): Record<UserQuotaCategory, number> {
  return { messages: 0, images: 0, largeFiles: 0, requests: 0 };
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
  return {
    dailyMsgLimit: value(input.dailyMsgLimit),
    dailyImageLimit: value(input.dailyImageLimit),
    dailyLargeFileLimit: value(input.dailyLargeFileLimit),
    dailyRequestLimit: value(input.dailyRequestLimit),
    maxImageBytes: value(input.maxImageBytes),
    maxLargeFileBytes: value(input.maxLargeFileBytes),
  };
}

export interface UserQuotaState {
  overrides: QuotaOverrides;
  usage: Record<UserQuotaCategory, { count: number; limit: number }>;
  caps: { imageBytes: number; largeFileBytes: number };
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
  dailyImageLimit: number;
  dailyLargeFileLimit: number;
  dailyRequestLimit: number;
  maxImageBytes: number;
  maxLargeFileBytes: number;
}
