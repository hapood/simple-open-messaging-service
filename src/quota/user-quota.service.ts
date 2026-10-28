import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { account, userQuotaPolicy } from '../database/schema.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import {
  policyView,
  type QuotaPolicyView,
  normalizeOverrides,
  type QuotaOverrides,
} from './quota-policy.js';
import { DEFAULT_MAX_FILE_BYTES } from './quota-policy.js';
import type { QuotaCountDimension } from './daily-quota-ledger.js';
import {
  QuotaRuntime,
  type BreakerStatus,
  type QuotaUsage,
} from './quota-runtime.js';

@Injectable()
export class UserQuotaService extends QuotaRuntime {
  private readonly accounts = new Map<number, string>();
  constructor(database: DatabaseService) {
    super(
      database,
      {
        maxFileBytes: DEFAULT_MAX_FILE_BYTES,
        dailyRequestLimit: 50,
        dailyMsgLimit: 1000,
        dailySignalLimit: 10_000,
        dailyFileLimit: 100,
        dailyFileBytesLimit: 500 * 1024 ** 2,
      },
      'quota:localUser:',
      'user',
    );
  }
  protected async key(id: number, tx?: DatabaseTransaction): Promise<string> {
    const cached = this.accounts.get(id);
    if (cached !== undefined) return cached;
    const row = await (tx ?? this.database.db).query.account.findFirst({
      where: eq(account.id, id),
      columns: { account: true, kind: true },
    });
    if (!row || row.kind !== 'USER')
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'local user not found',
      );
    this.accounts.set(id, row.account);
    return row.account;
  }
  protected async loadPolicy(
    key: string,
    tx?: DatabaseTransaction,
  ): Promise<QuotaOverrides> {
    return (
      (await (tx ?? this.database.db).query.userQuotaPolicy.findFirst({
        where: eq(userQuotaPolicy.account, key),
      })) ?? {}
    );
  }
  async setPolicy(id: number, input: QuotaOverrides): Promise<void> {
    const key = await this.key(id);
    const values = normalizeOverrides(input);
    await this.database.db
      .insert(userQuotaPolicy)
      .values({ account: key, ...values })
      .onConflictDoUpdate({
        target: userQuotaPolicy.account,
        set: { ...values, updatedAt: new Date() },
      });
  }
  async getState(id: number): Promise<UserQuotaState> {
    return {
      overrides: policyView(await this.getOverrides(id)),
      usage: await this.usageToday(id),
      breaker: await this.breakerStatus(id),
    };
  }
  async getSummaries(ids: number[]): Promise<Map<number, UserQuotaSummary>> {
    if (!ids.length) return new Map();
    const rows = await this.database.db
      .select({ id: account.id, account: account.account })
      .from(account)
      .where(inArray(account.id, ids));
    for (const row of rows) this.accounts.set(row.id, row.account);
    const policies = await this.database.db
      .select()
      .from(userQuotaPolicy)
      .where(
        inArray(
          userQuotaPolicy.account,
          rows.map((row) => row.account),
        ),
      );
    const byAccount = new Map(policies.map((p) => [p.account, p]));
    return new Map(
      await Promise.all(
        rows.map(async (row) => {
          const overrides = normalizeOverrides(
            byAccount.get(row.account) ?? {},
          );
          const limits = this.limits(overrides);
          const usage = (
            ['messages', 'requests', 'signals', 'files'] as const
          ).map((dim) => this.usage(row.account, dim, limits));
          const bytes = this.usage(row.account, 'fileBytes', limits);
          return [
            row.id,
            {
              status: quotaSummaryStatus([...usage, bytes]),
              hasOverrides: Object.values(overrides).some(
                (value) => value != null,
              ),
            },
          ] as const;
        }),
      ),
    );
  }
  async breakerStatus(id: number): Promise<BreakerStatus> {
    return { ...(await super.breakerStatus(id)), userId: id };
  }
  async trippedBreakers(): Promise<BreakerStatus[]> {
    return (
      await Promise.all(
        [...this.accounts.keys()].map((id) => this.breakerStatus(id)),
      )
    ).filter((s) => s.tripped);
  }
}
export interface UserQuotaState {
  overrides: QuotaPolicyView;
  usage: Record<QuotaCountDimension, QuotaUsage>;
  breaker: BreakerStatus;
}
export interface UserQuotaSummary {
  status: 'healthy' | 'warning' | 'exhausted' | 'disabled';
  hasOverrides: boolean;
}
export function quotaSummaryStatus(
  usage: Array<{ count: number; limit: number }>,
): UserQuotaSummary['status'] {
  const enabled = usage.filter((u) => u.limit > 0);
  if (!enabled.length) return 'disabled';
  if (enabled.some((u) => u.count >= u.limit)) return 'exhausted';
  if (enabled.some((u) => u.count / u.limit >= 0.8)) return 'warning';
  return 'healthy';
}
