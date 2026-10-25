import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  CheckCircle2,
  CircleDashed,
  Globe,
  HardDrive,
  KeyRound,
  ListTodo,
  Radio,
  Repeat,
  UserCheck,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react';
import { useDashboard } from '@/hooks/use-dashboard';
import { useIsAdminPlus } from '@/hooks/use-me';
import type { DashboardFederation } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Timestamp } from '@/components/common/timestamp';
import { formatApiError } from '@/lib/format-error';
import { cn } from '@/lib/utils';

/** Compact human byte size: "1.2 GB" / "512 MB" / "0 B". */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function MetricTile({
  label,
  value,
  sub,
  to,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  to: string;
  icon: typeof Users;
}) {
  return (
    <Link
      to={to}
      className="group rounded-xl border bg-card p-4 transition hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{label}</span>
        <span className="rounded-md bg-muted/60 p-1.5 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="size-4" />
        </span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold tabular-nums sm:text-3xl">
          {value}
        </div>
        <ArrowRight className="mb-1 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      {sub ? (
        <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div>
      ) : null}
    </Link>
  );
}

const FED_ROWS: {
  key: keyof DashboardFederation;
  tone: string;
  dotColor: string;
}[] = [
  {
    key: 'available',
    tone: 'text-emerald-600 dark:text-emerald-400',
    dotColor: 'bg-emerald-500',
  },
  {
    key: 'establishing',
    tone: 'text-blue-600 dark:text-blue-400',
    dotColor: 'bg-blue-500',
  },
  {
    key: 'unrecognized',
    tone: 'text-muted-foreground',
    dotColor: 'bg-muted-foreground/60',
  },
  {
    key: 'degraded',
    tone: 'text-amber-600 dark:text-amber-400',
    dotColor: 'bg-amber-500',
  },
  {
    key: 'halted',
    tone: 'text-destructive',
    dotColor: 'bg-destructive',
  },
];

/** Modern console overview with 4 metrics + 2x2 operational and telemetry cards. Polled every 15s. */
export function DashboardPage() {
  const { t } = useTranslation();
  const canManage = useIsAdminPlus();
  const { data, isLoading, error } = useDashboard();
  const loading = isLoading || !data;

  const totalPeers = data
    ? Object.values(data.federation).reduce((sum, count) => sum + count, 0)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Header bar: title + auto refresh indicator + quick create user button */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('dashboard.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('dashboard.desc')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {t('dashboard.autoRefresh')}
          </span>
          {canManage && (
            <Link
              to="/users?create=1"
              className={cn(
                buttonVariants({ variant: 'default', size: 'sm' }),
                'gap-1.5 shadow-sm',
              )}
            >
              <UserPlus className="size-4" />
              {t('dashboard.createUser')}
            </Link>
          )}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(error) })}
        </div>
      ) : null}

      {/* Top 4 Metric Tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricTile
          to="/connections"
          icon={Radio}
          label={t('dashboard.tile.onlineUsers')}
          value={
            loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              data!.online.uniqueUsers
            )
          }
          sub={
            loading
              ? undefined
              : t('dashboard.onlineSub', {
                  count: data!.online.totalConnections,
                })
          }
        />
        <MetricTile
          to="/users"
          icon={UserCheck}
          label={t('dashboard.tile.totalUsers')}
          value={loading ? <Skeleton className="h-8 w-16" /> : data!.totalUsers}
          sub={loading ? undefined : t('dashboard.totalUsersSub')}
        />
        <MetricTile
          to="/sessions"
          icon={KeyRound}
          label={t('dashboard.tile.activeSessions')}
          value={
            loading ? <Skeleton className="h-8 w-16" /> : data!.activeSessions
          }
          sub={loading ? undefined : t('dashboard.activeSessionsSub')}
        />
        <MetricTile
          to="/media"
          icon={HardDrive}
          label={t('dashboard.tile.storageUsage')}
          value={
            loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              formatBytes(Number(data!.media.bytes))
            )
          }
          sub={
            loading
              ? undefined
              : t('dashboard.mediaSub', {
                  assets: data!.media.assetCount,
                  live: data!.media.live,
                })
          }
        />
      </div>

      {/* 2x2 Grid: Durable Tasks, Media Transfers, Federation Health, Recent Actions */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Card 1: Durable Task Queue */}
        <Card className="flex flex-col justify-between">
          <CardHeader className="flex flex-row items-start justify-between pb-3">
            <div>
              <div className="flex items-center gap-2">
                <ListTodo className="size-4 text-primary" />
                <CardTitle>{t('dashboard.tasks.title')}</CardTitle>
              </div>
              <CardDescription className="mt-1">
                {t('dashboard.tasks.desc')}
              </CardDescription>
            </div>
            <Link
              to="/durable-tasks"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'gap-1 text-xs text-muted-foreground hover:text-foreground',
              )}
            >
              {t('dashboard.tasks.viewAll')}
              <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col justify-between rounded-lg border bg-muted/20 p-3">
                <span className="text-xs text-muted-foreground">
                  {t('dashboard.tasks.processing')}
                </span>
                <span className="mt-1 text-xl font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                  {loading ? '—' : data!.tasks.processing}
                </span>
              </div>
              <div className="flex flex-col justify-between rounded-lg border bg-muted/20 p-3">
                <span className="text-xs text-muted-foreground">
                  {t('dashboard.tasks.pending')}
                </span>
                <span className="mt-1 text-xl font-semibold tabular-nums text-muted-foreground">
                  {loading ? '—' : data!.tasks.pending}
                </span>
              </div>
              <div className="flex flex-col justify-between rounded-lg border bg-muted/20 p-3">
                <span className="text-xs text-muted-foreground">
                  {t('dashboard.tasks.failed')}
                </span>
                <span
                  className={cn(
                    'mt-1 text-xl font-semibold tabular-nums',
                    !loading && data!.tasks.failed > 0
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                  )}
                >
                  {loading ? '—' : data!.tasks.failed}
                </span>
              </div>
            </div>
            {!loading &&
              data!.tasks.processing === 0 &&
              data!.tasks.pending === 0 &&
              data!.tasks.failed === 0 && (
                <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  {t('dashboard.tasks.idle')}
                </div>
              )}
          </CardContent>
        </Card>

        {/* Card 2: Media Transfers */}
        <Card className="flex flex-col justify-between">
          <CardHeader className="flex flex-row items-start justify-between pb-3">
            <div>
              <div className="flex items-center gap-2">
                <Repeat className="size-4 text-primary" />
                <CardTitle>{t('dashboard.transfers.title')}</CardTitle>
              </div>
              <CardDescription className="mt-1">
                {t('dashboard.transfers.desc')}
              </CardDescription>
            </div>
            <Link
              to="/media"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'gap-1 text-xs text-muted-foreground hover:text-foreground',
              )}
            >
              {t('dashboard.transfers.viewAll')}
              <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col justify-between rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ArrowUpFromLine className="size-3" />
                  <span className="truncate">
                    {t('dashboard.transfers.uploads')}
                  </span>
                </div>
                <span className="mt-1 text-xl font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                  {loading ? '—' : data!.transfers.activeUploads}
                </span>
              </div>
              <div className="flex flex-col justify-between rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ArrowDownToLine className="size-3" />
                  <span className="truncate">
                    {t('dashboard.transfers.downloads')}
                  </span>
                </div>
                <span className="mt-1 text-xl font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                  {loading ? '—' : data!.transfers.activeDownloads}
                </span>
              </div>
              <div className="flex flex-col justify-between rounded-lg border bg-muted/20 p-3">
                <span className="text-xs text-muted-foreground">
                  {t('dashboard.transfers.failed')}
                </span>
                <span
                  className={cn(
                    'mt-1 text-xl font-semibold tabular-nums',
                    !loading && data!.transfers.failedTransfers > 0
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                  )}
                >
                  {loading ? '—' : data!.transfers.failedTransfers}
                </span>
              </div>
            </div>
            {!loading &&
              data!.transfers.activeUploads === 0 &&
              data!.transfers.activeDownloads === 0 &&
              data!.transfers.failedTransfers === 0 && (
                <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  {t('dashboard.transfers.idle')}
                </div>
              )}
          </CardContent>
        </Card>

        {/* Card 3: Federation Health */}
        <Card className="flex flex-col justify-between">
          <CardHeader className="flex flex-row items-start justify-between pb-3">
            <div>
              <div className="flex items-center gap-2">
                <Globe className="size-4 text-primary" />
                <CardTitle>{t('dashboard.federation.title')}</CardTitle>
              </div>
              <CardDescription className="mt-1">
                {loading
                  ? '...'
                  : totalPeers > 0
                    ? t('dashboard.federation.peersCount', {
                        count: totalPeers,
                      })
                    : t('dashboard.federation.noPeers')}
              </CardDescription>
            </div>
            <Link
              to="/federation"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'gap-1 text-xs text-muted-foreground hover:text-foreground',
              )}
            >
              {t('dashboard.federation.manage')}
              <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              {FED_ROWS.map((r) => (
                <div
                  key={r.key}
                  className="flex flex-col justify-between rounded-lg border bg-muted/20 p-2.5"
                >
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn('size-1.5 rounded-full', r.dotColor)} />
                    <span className="truncate">
                      {t(`federation.status.${r.key}`)}
                    </span>
                  </div>
                  <span
                    className={cn(
                      'mt-2 text-xl font-semibold tabular-nums',
                      r.tone,
                    )}
                  >
                    {loading ? '—' : data!.federation[r.key]}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Card 4: Recent Actions Audit */}
        <Card className="flex flex-col justify-between">
          <CardHeader className="flex flex-row items-start justify-between pb-3">
            <div>
              <CardTitle>{t('dashboard.recentActions.title')}</CardTitle>
              <CardDescription className="mt-1">
                {t('dashboard.recentActions.desc')}
              </CardDescription>
            </div>
            <Link
              to="/logs"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'gap-1 text-xs text-muted-foreground hover:text-foreground',
              )}
            >
              {t('dashboard.recentActions.viewAll')}
              <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : data!.recentActions.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t('dashboard.recentActions.noRecentActions')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data!.recentActions.slice(0, 5).map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                  >
                    {a.status === 'SUCCEEDED' ? (
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                    ) : a.status === 'STARTED' ? (
                      <CircleDashed className="size-4 shrink-0 text-amber-500" />
                    ) : (
                      <span title={a.errorMessage ?? undefined}>
                        <XCircle className="size-4 shrink-0 text-destructive" />
                      </span>
                    )}
                    <span className="font-mono text-xs">{a.action}</span>
                    {(a.targetLabel ?? a.targetId) ? (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {a.targetLabel ?? a.targetId}
                      </span>
                    ) : null}
                    <Badge
                      variant="outline"
                      className="ml-auto shrink-0 text-[10px]"
                    >
                      {a.adminRole}
                    </Badge>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <Timestamp value={a.at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
