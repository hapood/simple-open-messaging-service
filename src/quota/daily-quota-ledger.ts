export const QUOTA_CATEGORIES = [
  'messages',
  'files',
  'requests',
  'signals',
] as const;
export type QuotaDimension =
  | 'messages'
  | 'files'
  | 'requests'
  | 'signals'
  | 'fileBytes';
export type QuotaCountDimension = Exclude<QuotaDimension, 'fileBytes'>;
export const QUOTA_FIELDS = [
  'dailyMsgLimit',
  'dailyRequestLimit',
  'dailySignalLimit',
  'dailyFileLimit',
  'dailyFileBytesLimit',
] as const;
export type QuotaLimits = Record<(typeof QUOTA_FIELDS)[number], number>;
export const QUOTA_FIELD: Record<QuotaDimension, keyof QuotaLimits> = {
  messages: 'dailyMsgLimit',
  files: 'dailyFileLimit',
  requests: 'dailyRequestLimit',
  signals: 'dailySignalLimit',
  fileBytes: 'dailyFileBytesLimit',
};
export const CALL_INVITATION_QUOTA_COST = 400;
export function retryAfterSeconds(now = Date.now()): number {
  return Math.max(
    1,
    Math.ceil(((Math.floor(now / 86400000) + 1) * 86400000 - now) / 1000),
  );
}

/** Process-local UTC daily accounting. Restart intentionally resets all usage and grants. */
export class DailyQuotaLedger {
  private day = -1;
  private readonly entries = new Map<
    string,
    {
      used: Record<QuotaDimension, bigint>;
      extra: Record<QuotaDimension, bigint>;
    }
  >();
  private zero(): Record<QuotaDimension, bigint> {
    return {
      messages: 0n,
      requests: 0n,
      signals: 0n,
      files: 0n,
      fileBytes: 0n,
    };
  }
  private entry(key: string) {
    const day = Math.floor(Date.now() / 86400000);
    if (day !== this.day) {
      this.entries.clear();
      this.day = day;
    }
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { used: this.zero(), extra: this.zero() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  keys(): string[] {
    this.entryForDay();
    return [...this.entries.keys()];
  }
  private entryForDay() {
    const day = Math.floor(Date.now() / 86400000);
    if (day !== this.day) {
      this.entries.clear();
      this.day = day;
    }
  }
  used(key: string, dim: QuotaDimension): bigint {
    return this.entry(key).used[dim];
  }
  limit(key: string, dim: QuotaDimension, limits: QuotaLimits): bigint {
    return BigInt(limits[QUOTA_FIELD[dim]]) + this.entry(key).extra[dim];
  }
  exhausted(key: string, dim: QuotaDimension, limits: QuotaLimits): boolean {
    return this.used(key, dim) >= this.limit(key, dim, limits);
  }
  /** No await between check and debit: concurrent tasks cannot over-admit a strict charge. */
  charge(
    key: string,
    dim: QuotaDimension,
    amount: bigint,
    limits: QuotaLimits,
    strict: boolean,
  ): boolean {
    if (amount < 0n) throw new Error('quota charge must be non-negative');
    const entry = this.entry(key);
    if (strict && entry.used[dim] + amount > this.limit(key, dim, limits))
      return false;
    entry.used[dim] += amount;
    return true;
  }
  grant(key: string, dim: QuotaDimension, amount: bigint): void {
    if (amount < 0n) throw new Error('quota grant must be non-negative');
    this.entry(key).extra[dim] += amount;
  }
}
