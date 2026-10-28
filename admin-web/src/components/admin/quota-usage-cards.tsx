import { useTranslation } from 'react-i18next';
import type {
  QuotaCountDimension,
  QuotaOverrides,
  BreakerStatus,
} from '@/types/api';

/** Both policy scopes expose the same five dimensions. Values are process-local UTC-day usage. */
export function QuotaUsageCards({
  usage,
  fileBytes,
  overrides,
}: {
  usage: Record<QuotaCountDimension, { count: number; limit: number }>;
  fileBytes: BreakerStatus['fileBytes'];
  overrides: QuotaOverrides;
}) {
  const { t } = useTranslation();
  const fields = [
    ['messages', 'dailyMsgLimit'],
    ['requests', 'dailyRequestLimit'],
    ['signals', 'dailySignalLimit'],
    ['files', 'dailyFileLimit'],
    ['fileBytes', 'dailyFileBytesLimit'],
  ] as const;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 leading-[20px]">
      {fields.map(([dim, field]) => {
        const item =
          dim === 'fileBytes'
            ? { count: Number(fileBytes.bytes), limit: fileBytes.limit }
            : usage[dim];
        const status =
          item.limit === 0
            ? 'disabled'
            : item.count >= item.limit
              ? 'exhausted'
              : item.count / item.limit >= 0.8
                ? 'warning'
                : 'healthy';
        const percent =
          item.limit === 0
            ? 100
            : Math.min(100, Math.round((item.count / item.limit) * 100));
        const fmt = (n: number) =>
          dim === 'fileBytes'
            ? `${(n / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`
            : n.toLocaleString();
        return (
          <div key={dim} className="rounded-md border p-3">
            <div className="flex justify-between gap-2 text-xs leading-[16px]">
              <span>{t(`quota.col.${dim}`)}</span>
              <span>{t(`quota.status.${status}`)}</span>
            </div>
            <div
              className={`mt-1 font-mono text-lg leading-[24px] ${status === 'exhausted' || status === 'disabled' ? 'text-destructive' : ''}`}
            >
              {fmt(item.count)} / {fmt(item.limit)}
            </div>
            <div className="mt-2 h-[6px] overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary"
                style={{ width: `${percent}%` }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={item.limit}
                aria-valuenow={Math.min(item.count, item.limit)}
              />
            </div>
            <div className="mt-2 flex justify-between gap-2 text-xs leading-[16px]">
              <span>
                {t('quota.remaining', {
                  count: fmt(Math.max(0, item.limit - item.count)),
                })}
              </span>
              <span>
                {t(
                  overrides[field] == null
                    ? 'quota.source.default'
                    : 'quota.source.custom',
                )}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
