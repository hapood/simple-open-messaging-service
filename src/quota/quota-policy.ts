import { QUOTA_FIELDS, type QuotaLimits } from './daily-quota-ledger.js';

export const DEFAULT_MAX_FILE_BYTES = 1024 ** 3;
export const POLICY_FIELDS = [...QUOTA_FIELDS, 'maxFileBytes'] as const;
export type FileQuotaLimits = QuotaLimits & { maxFileBytes: number };
export interface QuotaOverrides {
  dailyMsgLimit?: number | null;
  dailyRequestLimit?: number | null;
  dailySignalLimit?: number | null;
  dailyFileLimit?: number | null;
  dailyFileBytesLimit?: bigint | null;
  maxFileBytes?: bigint | null;
}
export type QuotaPolicyView = {
  [K in keyof QuotaOverrides]?: number | null;
};
export function policyView(policy: QuotaOverrides): QuotaPolicyView {
  return Object.fromEntries(
    POLICY_FIELDS.map((field) => [
      field,
      policy[field] == null ? null : Number(policy[field]),
    ]),
  );
}
export function normalizeOverrides(input: QuotaOverrides): QuotaOverrides {
  return Object.fromEntries(
    POLICY_FIELDS.map((field) => {
      const value = input[field];
      if (value == null) return [field, null];
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error(`invalid ${field}`);
      return [
        field,
        field === 'dailyFileBytesLimit' || field === 'maxFileBytes'
          ? BigInt(n)
          : n,
      ];
    }),
  );
}
export function validateLimits(
  input: Record<string, unknown>,
): FileQuotaLimits {
  return Object.fromEntries(
    POLICY_FIELDS.map((field) => {
      const raw = input[field];
      if (
        typeof raw !== 'number' &&
        !(
          (field === 'dailyFileBytesLimit' || field === 'maxFileBytes') &&
          typeof raw === 'string' &&
          /^\d+$/.test(raw)
        )
      )
        throw new Error(`invalid ${field}`);
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`invalid ${field}`);
      return [field, value];
    }),
  ) as FileQuotaLimits;
}
