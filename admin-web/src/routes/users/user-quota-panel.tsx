import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Pencil, TriangleAlert } from 'lucide-react';
import { useSetUserQuota, useUserQuota } from '@/hooks/use-user-detail';
import type {
  QuotaCategory,
  QuotaOverrides,
  UserQuotaState,
} from '@/types/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatApiError } from '@/lib/format-error';

const categories: QuotaCategory[] = ['messages', 'files', 'requests'];
const countFields = [
  ['dailyMsgLimit', 'messages'],
  ['dailyFileLimit', 'files'],
  ['dailyRequestLimit', 'requests'],
] as const;
const countOverrideByCategory = Object.fromEntries(
  countFields.map(([key, category]) => [category, key]),
) as Record<QuotaCategory, (typeof countFields)[number][0]>;
const MB = 1024 * 1024;

type QuotaStatus = 'healthy' | 'warning' | 'exhausted' | 'disabled';

export function userQuotaStatus(count: number, limit: number): QuotaStatus {
  if (limit === 0) return 'disabled';
  if (count >= limit) return 'exhausted';
  if (count / limit >= 0.8) return 'warning';
  return 'healthy';
}

export function UserQuotaPanel({
  userId,
  canManage,
}: {
  userId: number;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const quota = useUserQuota(userId, true);
  const [editing, setEditing] = useState(false);

  if (quota.isLoading) return <Skeleton className="h-40 w-full" />;
  if (quota.error || !quota.data)
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(quota.error) })}
        </CardContent>
      </Card>
    );

  const state = quota.data;
  return (
    <>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t('userQuota.title')}</CardTitle>
            <CardDescription>{t('userQuota.desc')}</CardDescription>
          </div>
          {canManage ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-4" />
              {t('quota.edit')}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            {categories.map((category) => {
              const item = state.usage[category];
              const status = userQuotaStatus(item.count, item.limit);
              const percent =
                item.limit === 0
                  ? 100
                  : Math.min(100, Math.round((item.count / item.limit) * 100));
              const override =
                state.overrides[countOverrideByCategory[category]];

              return (
                <div key={category} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {t(`quota.col.${category}`)}
                    </span>
                    <span>{t(`quota.status.${status}`)}</span>
                  </div>
                  <div
                    className={
                      status === 'exhausted' || status === 'disabled'
                        ? 'mt-1 font-mono text-lg text-destructive'
                        : status === 'warning'
                          ? 'mt-1 font-mono text-lg text-amber-600 dark:text-amber-500'
                          : 'mt-1 font-mono text-lg'
                    }
                  >
                    {item.limit === 0
                      ? t('quota.disabled')
                      : `${item.count.toLocaleString()} / ${item.limit.toLocaleString()}`}
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={
                        status === 'exhausted' || status === 'disabled'
                          ? 'h-full bg-destructive'
                          : status === 'warning'
                            ? 'h-full bg-amber-500'
                            : 'h-full bg-primary'
                      }
                      style={{ width: `${percent}%` }}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={item.limit}
                      aria-valuenow={Math.min(item.count, item.limit)}
                    />
                  </div>
                  <div className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {item.limit === 0
                        ? t('userQuota.noActionsAccepted')
                        : t('quota.remaining', {
                            count: Math.max(
                              0,
                              item.limit - item.count,
                            ).toLocaleString(),
                          })}
                    </span>
                    <span>
                      {override == null
                        ? t('userQuota.source.default')
                        : t('userQuota.source.custom')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <BreakerLine state={state} />
          <p className="text-xs text-muted-foreground">
            {t('userQuota.resetHint')}
          </p>
        </CardContent>
      </Card>
      {editing ? (
        <EditUserQuota
          userId={userId}
          value={state.overrides}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function BreakerLine({ state }: { state: UserQuotaState }) {
  const { t } = useTranslation();
  if (!state.breaker.tripped) return null;
  const dims = state.breaker.trippedDims
    .map((d) => t(`quota.breaker.dim${d === 'msg' ? 'Msg' : d === 'file' ? 'File' : 'FileBytes'}`))
    .join(', ');
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <TriangleAlert className="size-4 shrink-0" />
      <span>
        {t('quota.breaker.tripped')} · {dims}
      </span>
    </div>
  );
}

function EditUserQuota({
  userId,
  value,
  onClose,
}: {
  userId: number;
  value: QuotaOverrides;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const mutation = useSetUserQuota(userId);
  const [counts, setCounts] = useState<
    Record<(typeof countFields)[number][0], string>
  >(
    Object.fromEntries(
      countFields.map(([key]) => [key, value[key]?.toString() ?? '']),
    ) as Record<(typeof countFields)[number][0], string>,
  );
  const [fileBytesMb, setFileBytesMb] = useState<string>(
    value.dailyFileBytesLimit == null
      ? ''
      : String(value.dailyFileBytesLimit / MB),
  );
  const invalid =
    [...Object.values(counts), fileBytesMb].some((raw) => {
      if (!raw.trim()) return false;
      const n = Number(raw);
      return !Number.isFinite(n) || n < 0;
    }) ||
    Object.values(counts).some(
      (raw) => raw.trim() !== '' && !Number.isSafeInteger(Number(raw)),
    ) ||
    (fileBytesMb.trim() !== '' &&
      !Number.isSafeInteger(Number(fileBytesMb) * MB));

  const save = async () => {
    if (invalid) return;
    const overrides = {
      ...Object.fromEntries(
        countFields.map(([key]) => [
          key,
          counts[key].trim() ? Number(counts[key]) : null,
        ]),
      ),
      dailyFileBytesLimit:
        fileBytesMb.trim() === ''
          ? null
          : Math.round(Number(fileBytesMb) * MB),
    } as QuotaOverrides;
    try {
      await mutation.mutateAsync(overrides);
      toast.success(t('quota.toast.saved'));
      onClose();
    } catch (error) {
      toast.error(formatApiError(error));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('userQuota.editTitle')}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          {countFields.map(([key, category]) => (
            <div key={key} className="flex flex-col gap-1.5">
              <Label>{t(`quota.col.${category}`)}</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={counts[key]}
                placeholder={t('quota.placeholder.default')}
                onChange={(event) =>
                  setCounts((state) => ({
                    ...state,
                    [key]: event.target.value,
                  }))
                }
              />
            </div>
          ))}
          <div key="dailyFileBytesLimit" className="flex flex-col gap-1.5">
            <Label>{t('quota.breaker.dimFileBytes')} (MB)</Label>
            <Input
              type="number"
              min={0}
              value={fileBytesMb}
              placeholder={t('quota.placeholder.default')}
              onChange={(event) => setFileBytesMb(event.target.value)}
            />
          </div>
          <p className="col-span-2 text-xs text-muted-foreground">
            {invalid ? t('quota.invalid') : t('userQuota.editHint')}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('quota.cancel')}
          </Button>
          <Button disabled={invalid || mutation.isPending} onClick={save}>
            {t('quota.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
