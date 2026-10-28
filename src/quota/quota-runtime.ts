import { HttpStatus } from '@nestjs/common';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { systemSetting } from '../database/schema.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DailyQuotaLedger,
  QUOTA_CATEGORIES,
  QUOTA_FIELDS,
  normalizeOverrides,
  retryAfterSeconds,
  validateLimits,
  type QuotaCountDimension,
  type QuotaDimension,
  type QuotaLimits,
  type QuotaOverrides,
} from './daily-quota-ledger.js';

export interface QuotaUsage {
  count: number;
  limit: number;
  remaining: number;
}
export interface BreakerStatus {
  entity: string;
  userId?: number;
  scope: 'peer' | 'user';
  tripped: boolean;
  trippedDims: QuotaDimension[];
  retryAfter: number;
  msg: QuotaUsage;
  file: QuotaUsage;
  requests: QuotaUsage;
  signals: QuotaUsage;
  fileBytes: { bytes: string; limit: number; remaining: number };
}
export interface QuotaGrant {
  addMsg?: number;
  addRequest?: number;
  addSignal?: number;
  addFile?: number;
  addFileBytes?: bigint;
}

/** Shared accounting for both scopes. Only policy is durable; usage and same-day grants are process-local.
 * Charges are conservative admission/processing costs, not SQL writes: a later business rollback does not
 * refund work already admitted. Strict checks and debits are synchronous after policy resolution. */
export abstract class QuotaRuntime {
  protected readonly ledger = new DailyQuotaLedger();
  protected constructor(
    protected readonly database: DatabaseService,
    protected defaults: QuotaLimits,
    private readonly prefix: string,
    readonly scope: 'peer' | 'user',
  ) {}
  protected abstract key(id: number, tx?: DatabaseTransaction): Promise<string>;
  protected abstract loadPolicy(
    key: string,
    tx?: DatabaseTransaction,
  ): Promise<QuotaOverrides>;

  async onModuleInit(): Promise<void> {
    const rows = await this.database.db.query.systemSetting.findMany({
      where: (s, { inArray }) =>
        inArray(
          s.key,
          QUOTA_FIELDS.map((f) => this.prefix + f),
        ),
    });
    for (const row of rows) {
      const field = row.key.slice(this.prefix.length) as keyof QuotaLimits;
      const value = Number(row.value);
      if (
        QUOTA_FIELDS.includes(field) &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        this.defaults[field] = value;
    }
  }
  getDefaultLimits(): QuotaLimits {
    return { ...this.defaults };
  }
  async setDefaultLimits(input: Record<string, unknown>): Promise<QuotaLimits> {
    const values = validateLimits(input);
    await this.database.db.transaction(async (tx) => {
      for (const field of QUOTA_FIELDS)
        await tx
          .insert(systemSetting)
          .values({ key: this.prefix + field, value: String(values[field]) })
          .onConflictDoUpdate({
            target: systemSetting.key,
            set: { value: String(values[field]), updatedAt: new Date() },
          });
    });
    this.defaults = values;
    return this.getDefaultLimits();
  }
  protected limits(policy: QuotaOverrides): QuotaLimits {
    return Object.fromEntries(
      QUOTA_FIELDS.map((field) => [
        field,
        Number(policy[field] ?? this.defaults[field]),
      ]),
    ) as QuotaLimits;
  }
  async getOverrides(
    id: number,
    tx?: DatabaseTransaction,
  ): Promise<QuotaOverrides> {
    const key = await this.key(id, tx);
    return normalizeOverrides(await this.loadPolicy(key, tx));
  }
  protected async context(id: number, tx?: DatabaseTransaction) {
    const key = await this.key(id, tx);
    const policy = normalizeOverrides(await this.loadPolicy(key, tx));
    return { key, limits: this.limits(policy) };
  }
  private reject(dim: QuotaDimension): never {
    throw new BusinessException(
      this.scope === 'peer'
        ? BusinessCode.FEDERATION_QUOTA_EXCEEDED
        : BusinessCode.QUOTA_EXCEEDED,
      `daily quota exhausted: ${dim}`,
      HttpStatus.OK,
      { retryAfter: retryAfterSeconds() },
    );
  }
  async peek(
    id: number,
    category: QuotaCountDimension,
    amount = 1,
  ): Promise<void> {
    const { key, limits } = await this.context(id);
    if (
      this.ledger.used(key, category) + BigInt(amount) >
      this.ledger.limit(key, category, limits)
    )
      this.reject(category);
  }
  async tick(
    id: number,
    category: QuotaCountDimension,
    tx?: DatabaseTransaction,
    amount = 1,
  ): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new Error('invalid quota amount');
    const { key, limits } = await this.context(id, tx);
    if (!this.ledger.charge(key, category, BigInt(amount), limits, true))
      this.reject(category);
  }
  async tickStandalone(
    id: number,
    category: QuotaCountDimension,
    amount = 1,
  ): Promise<void> {
    return this.tick(id, category, undefined, amount);
  }
  async tickLax(
    id: number,
    category: QuotaCountDimension,
    tx?: DatabaseTransaction,
    amount = 1,
  ) {
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new Error('invalid quota amount');
    const { key, limits } = await this.context(id, tx);
    this.ledger.charge(key, category, BigInt(amount), limits, false);
    const count = Number(this.ledger.used(key, category));
    const limit = Number(this.ledger.limit(key, category, limits));
    return { count, limit, over: count >= limit };
  }
  async tickFileBytes(id: number, amount: bigint, tx?: DatabaseTransaction) {
    const { key, limits } = await this.context(id, tx);
    this.ledger.charge(key, 'fileBytes', amount, limits, false);
    const bytes = this.ledger.used(key, 'fileBytes');
    const limit = Number(this.ledger.limit(key, 'fileBytes', limits));
    return { bytes, limit, over: bytes >= BigInt(limit) };
  }
  async addFileBytesDelta(
    id: number,
    amount: bigint,
    tx?: DatabaseTransaction,
  ): Promise<void> {
    if (amount > 0n) await this.tickFileBytes(id, amount, tx);
  }
  /** Atomically admit both file dimensions in one synchronous memory operation. */
  async claimFile(
    id: number,
    count: number,
    bytes: bigint,
    tx?: DatabaseTransaction,
  ): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 0 || bytes < 0n)
      throw new Error('invalid file charge');
    const { key, limits } = await this.context(id, tx);
    if (
      this.ledger.used(key, 'files') + BigInt(count) >
      this.ledger.limit(key, 'files', limits)
    )
      this.reject('files');
    if (
      this.ledger.used(key, 'fileBytes') + bytes >
      this.ledger.limit(key, 'fileBytes', limits)
    )
      this.reject('fileBytes');
    this.ledger.charge(key, 'files', BigInt(count), limits, false);
    this.ledger.charge(key, 'fileBytes', bytes, limits, false);
  }
  async isExhausted(
    id: number,
    dimensions: QuotaDimension[],
  ): Promise<boolean> {
    const { key, limits } = await this.context(id);
    return dimensions.some((dim) => this.ledger.exhausted(key, dim, limits));
  }
  async assertCanSend(id: number): Promise<void> {
    if (await this.isExhausted(id, ['messages'])) this.reject('messages');
  }
  async assertCanPullMessages(id: number): Promise<void> {
    if (await this.isExhausted(id, ['messages']))
      throw new QuotaPausedError(retryAfterSeconds());
  }
  async assertCanConsumeState(id: number): Promise<void> {
    if (await this.isExhausted(id, ['requests', 'messages']))
      throw new QuotaPausedError(retryAfterSeconds());
  }
  retryAfterSeconds(): number {
    return retryAfterSeconds();
  }
  async addQuota(id: number, input: QuotaGrant): Promise<BreakerStatus> {
    const { key } = await this.context(id);
    for (const [dim, amount] of Object.entries({
      messages: input.addMsg,
      requests: input.addRequest,
      signals: input.addSignal,
      files: input.addFile,
      fileBytes: input.addFileBytes,
    })) {
      if (amount !== undefined)
        this.ledger.grant(key, dim as QuotaDimension, BigInt(amount));
    }
    return this.breakerStatus(id);
  }
  protected usage(
    key: string,
    dim: QuotaDimension,
    limits: QuotaLimits,
  ): QuotaUsage {
    const count = Number(this.ledger.used(key, dim));
    const limit = Number(this.ledger.limit(key, dim, limits));
    return { count, limit, remaining: Math.max(0, limit - count) };
  }
  async usageToday(
    id: number,
  ): Promise<Record<QuotaCountDimension, QuotaUsage>> {
    const { key, limits } = await this.context(id);
    return Object.fromEntries(
      QUOTA_CATEGORIES.map((dim) => [dim, this.usage(key, dim, limits)]),
    ) as Record<QuotaCountDimension, QuotaUsage>;
  }
  async breakerStatus(id: number): Promise<BreakerStatus> {
    const { key, limits } = await this.context(id);
    const dims: QuotaDimension[] = [...QUOTA_CATEGORIES, 'fileBytes'];
    const trippedDims = dims.filter((dim) =>
      this.ledger.exhausted(key, dim, limits),
    );
    const bytes = this.usage(key, 'fileBytes', limits);
    return {
      entity: key,
      scope: this.scope,
      tripped: trippedDims.length > 0,
      trippedDims,
      retryAfter: retryAfterSeconds(),
      msg: this.usage(key, 'messages', limits),
      file: this.usage(key, 'files', limits),
      requests: this.usage(key, 'requests', limits),
      signals: this.usage(key, 'signals', limits),
      fileBytes: {
        bytes: this.ledger.used(key, 'fileBytes').toString(),
        limit: bytes.limit,
        remaining: bytes.remaining,
      },
    };
  }
}
/** A local scheduler pause, not a transport failure or a remote protocol error. */
export class QuotaPausedError extends Error {
  constructor(readonly retryAfter: number) {
    super('local daily quota exhausted');
  }
}
