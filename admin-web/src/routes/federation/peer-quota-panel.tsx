import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Pencil } from 'lucide-react';
import { useSetQuotaNodeLimits } from '@/hooks/use-quotas';
import { useIsSuperAdmin } from '@/hooks/use-me';
import type { QuotaCategory, QuotaNode, QuotaOverrides } from '@/types/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatApiError } from '@/lib/format-error';

// Count dimensions surfaced as usage cards. `signals` is global-only and not shown here.
const CATEGORIES: QuotaCategory[] = ['messages', 'files', 'requests'];
type CountKey = 'dailyMsgLimit' | 'dailyFileLimit' | 'dailyRequestLimit';
const COUNT_FIELDS: { key: CountKey; cat: QuotaCategory }[] = [
  { key: 'dailyMsgLimit', cat: 'messages' },
  { key: 'dailyFileLimit', cat: 'files' },
  { key: 'dailyRequestLimit', cat: 'requests' },
];
const COUNT_OVERRIDE_BY_CATEGORY: Record<QuotaCategory, CountKey> = {
  messages: 'dailyMsgLimit',
  files: 'dailyFileLimit',
  requests: 'dailyRequestLimit',
};
const MB = 1024 * 1024;

export function quotaRisk(node: QuotaNode | undefined): number | undefined {
  if (!node) return undefined;
  return Math.max(
    ...CATEGORIES.map((category) => {
      const usage = node.usage[category];
      if (usage.limit === 0) return 1;
      return usage.count / usage.limit;
    }),
  );
}

export function PeerQuotaPanel({ node }: { node: QuotaNode }) {
  const { t } = useTranslation();
  const isSuper = useIsSuperAdmin();
  const [editing, setEditing] = useState(false);

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t('quota.peerTitle')}</CardTitle>
            <CardDescription>{t('quota.peerDesc')}</CardDescription>
          </div>
          {isSuper ? (
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {CATEGORIES.map((category) => {
              const usage = node.usage[category];
              const count = usage.count;
              const limit = usage.limit;
              const ratio = limit > 0 ? count / limit : 1;
              const percent = Math.min(100, Math.round(ratio * 100));
              const override =
                node.overrides[COUNT_OVERRIDE_BY_CATEGORY[category]];
              const status =
                limit === 0
                  ? 'disabled'
                  : ratio >= 1
                    ? 'exhausted'
                    : ratio >= 0.8
                      ? 'warning'
                      : 'healthy';
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
                    {limit === 0
                      ? t('quota.disabled')
                      : `${count.toLocaleString()} / ${limit.toLocaleString()}`}
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
                      style={{ width: `${limit === 0 ? 100 : percent}%` }}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={limit}
                      aria-valuenow={Math.min(count, limit)}
                    />
                  </div>
                  <div className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {limit === 0
                        ? t('quota.noTrafficAccepted')
                        : t('quota.remaining', {
                            count: Math.max(0, limit - count).toLocaleString(),
                          })}
                    </span>
                    <span>
                      {override == null
                        ? t('quota.source.default')
                        : t('quota.source.custom')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('quota.resetHint')}
          </p>
        </CardContent>
      </Card>
      {editing ? (
        <EditQuotaDialog node={node} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

function EditQuotaDialog({
  node,
  onClose,
}: {
  node: QuotaNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const setLimits = useSetQuotaNodeLimits();
  const [counts, setCounts] = useState<Record<CountKey, string>>({
    dailyMsgLimit: node.overrides.dailyMsgLimit?.toString() ?? '',
    dailyFileLimit: node.overrides.dailyFileLimit?.toString() ?? '',
    dailyRequestLimit: node.overrides.dailyRequestLimit?.toString() ?? '',
  });
  // File total size override, edited in MB (wire value is bytes).
  const [fileBytesMb, setFileBytesMb] = useState<string>(
    node.overrides.dailyFileBytesLimit == null
      ? ''
      : String(node.overrides.dailyFileBytesLimit / MB),
  );

  const parseCount = (value: string): number | null =>
    value.trim() === '' ? null : Number(value);
  const invalidCount = Object.values(counts).some((value) => {
    if (value.trim() === '') return false;
    const n = Number(value);
    return !Number.isSafeInteger(n) || n < 0;
  });
  const invalidMb = (() => {
    if (fileBytesMb.trim() === '') return false;
    const bytes = Number(fileBytesMb) * MB;
    return !Number.isSafeInteger(bytes) || bytes < 0;
  })();
  const invalid = invalidCount || invalidMb;

  const onSave = async () => {
    if (invalid) return;
    const overrides: QuotaOverrides = {
      dailyMsgLimit: parseCount(counts.dailyMsgLimit),
      dailyFileLimit: parseCount(counts.dailyFileLimit),
      dailyRequestLimit: parseCount(counts.dailyRequestLimit),
      dailyFileBytesLimit:
        fileBytesMb.trim() === '' ? null : Math.round(Number(fileBytesMb) * MB),
    };
    try {
      await setLimits.mutateAsync({ domain: node.domain, overrides });
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
          <DialogTitle>
            {t('quota.editTitle', { domain: node.domain })}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          {COUNT_FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label>{t(`quota.col.${field.cat}`)}</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={counts[field.key]}
                onChange={(event) =>
                  setCounts((state) => ({
                    ...state,
                    [field.key]: event.target.value,
                  }))
                }
                placeholder={t('quota.placeholder.default')}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label>{t('quota.breaker.dimFileBytes')} (MB)</Label>
            <Input
              type="number"
              min={0}
              value={fileBytesMb}
              onChange={(event) => setFileBytesMb(event.target.value)}
              placeholder={t('quota.placeholder.default')}
            />
          </div>
          <p className="col-span-2 text-xs text-muted-foreground">
            {invalid ? t('quota.invalid') : t('quota.editHint')}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('quota.cancel')}
          </Button>
          <Button onClick={onSave} disabled={invalid || setLimits.isPending}>
            {t('quota.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
