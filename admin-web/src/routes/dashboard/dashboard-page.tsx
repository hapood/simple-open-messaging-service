import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleUserRound,
  Radio,
  ShieldCheck,
  UserPlus,
  UsersRound,
  XCircle,
} from 'lucide-react'
import { useDashboard } from '@/hooks/use-dashboard'
import type { DashboardFederation } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'

/** Compact human byte size: "1.2 GB" / "512 MB" / "0 B". */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function MetricTile({
  label,
  value,
  sub,
  to,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  to: string
}) {
  return (
    <Link
      to={to}
      className="group rounded-xl border bg-card p-4 transition hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-3xl font-semibold tabular-nums">{value}</div>
        <ArrowRight className="mb-1 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </Link>
  )
}

const FED_ROWS: { key: keyof DashboardFederation; tone: string }[] = [
  { key: 'trusted', tone: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'demoted', tone: 'text-amber-600 dark:text-amber-400' },
  { key: 'pending', tone: 'text-muted-foreground' },
  { key: 'blocked', tone: 'text-destructive' },
]

/** Landing overview. Tiles + federation breakdown + the last admin actions (sourced from
 *  AdminActionLog, written by the Phase 1 audit interceptor). Polled every 15s by useDashboard. */
export function DashboardPage() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useDashboard()
  const loading = isLoading && !data

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.desc')}</p>
        </div>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          {t('dashboard.autoRefresh')}
        </span>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(error) })}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricTile
          to="/connections"
          label={t('dashboard.tile.onlineNow')}
          value={loading ? <Skeleton className="h-8 w-16" /> : data!.online.uniqueUsers}
        />
        <MetricTile
          to="/connections"
          label={t('dashboard.tile.onlineConnections')}
          value={loading ? <Skeleton className="h-8 w-16" /> : data!.online.totalConnections}
        />
        <MetricTile
          to="/sessions"
          label={t('dashboard.tile.activeSessions')}
          value={loading ? <Skeleton className="h-8 w-16" /> : data!.activeSessions}
        />
        <MetricTile
          to="/media"
          label={t('dashboard.tile.storageUsage')}
          value={loading ? <Skeleton className="h-8 w-20" /> : formatBytes(Number(data!.media.bytes))}
          sub={
            loading
              ? undefined
              : t('dashboard.mediaSub', {
                  assets: data!.media.assetCount,
                  reclaimable: data!.media.reclaimable,
                })
          }
        />
      </div>

      <section>
        <div className="mb-3">
          <h2 className="font-semibold">{t('dashboard.workflows.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('dashboard.workflows.desc')}</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <WorkflowCard
            icon={Activity}
            title={t('dashboard.workflows.health.title')}
            desc={t('dashboard.workflows.health.desc')}
            actions={[
              {
                to: '/connections',
                icon: Radio,
                title: t('dashboard.workflows.health.current'),
                desc: t('dashboard.workflows.health.currentDesc'),
              },
              {
                to: '/federation',
                icon: CircleUserRound,
                title: t('dashboard.workflows.health.peers'),
                desc: t('dashboard.workflows.health.peersDesc'),
              },
              {
                to: '/federation/self-check',
                icon: ShieldCheck,
                title: t('dashboard.workflows.health.check'),
                desc: t('dashboard.workflows.health.checkDesc'),
              },
            ]}
          />
          <WorkflowCard
            icon={UsersRound}
            title={t('dashboard.workflows.users.title')}
            desc={t('dashboard.workflows.users.desc')}
            actions={[
              {
                to: '/users?create=1',
                icon: UserPlus,
                title: t('dashboard.workflows.users.create'),
                desc: t('dashboard.workflows.users.createDesc'),
                primary: true,
              },
              {
                to: '/users',
                icon: UsersRound,
                title: t('dashboard.workflows.users.manage'),
                desc: t('dashboard.workflows.users.manageDesc'),
              },
              {
                to: '/users',
                icon: Activity,
                title: t('dashboard.workflows.users.status'),
                desc: t('dashboard.workflows.users.statusDesc'),
              },
            ]}
          />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('dashboard.tile.federationHealth')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {FED_ROWS.map((r) => (
              <div key={r.key} className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm text-muted-foreground">{t(`federation.status.${r.key}`)}</span>
                <span className={`text-lg font-semibold tabular-nums ${r.tone}`}>
                  {loading ? '—' : data!.federation[r.key]}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>{t('dashboard.tile.recentActions')}</CardTitle>
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
                {t('dashboard.noRecentActions')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data!.recentActions.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                  >
                    {a.success ? (
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
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
                    <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">
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
  )
}

type WorkflowAction = {
  to: string
  icon: typeof Activity
  title: string
  desc: string
  primary?: boolean
}

function WorkflowCard({
  icon: Icon,
  title,
  desc,
  actions,
}: {
  icon: typeof Activity
  title: string
  desc: string
  actions: WorkflowAction[]
}) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 border-b bg-muted/25 p-5">
        <span className="rounded-xl bg-primary p-2.5 text-primary-foreground">
          <Icon className="size-5" />
        </span>
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">{desc}</p>
        </div>
      </div>
      <div className="grid gap-2 p-3 sm:grid-cols-3">
        {actions.map(({ to, icon: ActionIcon, title: actionTitle, desc: actionDesc, primary }) => (
          <Link
            key={`${to}-${actionTitle}`}
            to={to}
            className={[
              'group rounded-lg p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              primary ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'hover:bg-muted',
            ].join(' ')}
          >
            <ActionIcon className="mb-3 size-4" />
            <span className="flex items-center gap-1 text-sm font-medium">
              {actionTitle}
              <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
            </span>
            <span
              className={[
                'mt-1 block text-xs leading-relaxed',
                primary ? 'text-primary-foreground/75' : 'text-muted-foreground',
              ].join(' ')}
            >
              {actionDesc}
            </span>
          </Link>
        ))}
      </div>
    </Card>
  )
}
