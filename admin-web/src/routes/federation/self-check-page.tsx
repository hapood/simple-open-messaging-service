import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Clock,
  Copy,
  FileCheck2,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Settings,
} from 'lucide-react'
import { useFederationSelfCheck } from '@/hooks/use-federation'
import {
  DNS_RESOLVERS,
  NTP_SERVERS,
  type SelfCheckCheck,
  type SelfCheckGroup,
  type SelfCheckReport,
  type SelfCheckStatus,
} from '@/types/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'
import { cn } from '@/lib/utils'
import { CheckRow, STATUS_META } from './check-row'

/** Section groups, in display order. */
const GROUPS: { key: SelfCheckGroup; Icon: typeof Globe }[] = [
  { key: 'config', Icon: Settings },
  { key: 'dns', Icon: Globe },
  { key: 'tls', Icon: Lock },
  { key: 'well-known', Icon: FileCheck2 },
  { key: 'crypto', Icon: KeyRound },
  { key: 'clock', Icon: Clock },
]

const STATUSES: SelfCheckStatus[] = ['ok', 'warn', 'fail', 'skip']

/** The S2S handshake self-check page. Pick a reference clock + DNS resolver, run the probe set, and
 *  read the grouped results — each network check is broken down per resolved IP (SRV→DDNS or multi-A). */
export function SelfCheckPage() {
  const { t } = useTranslation()
  const [ntpServer, setNtpServer] = useState<string>(NTP_SERVERS[0].value)
  const [dnsResolver, setDnsResolver] = useState<string>(DNS_RESOLVERS[0].value)
  const [report, setReport] = useState<SelfCheckReport | null>(null)

  const run = useFederationSelfCheck()

  const onRun = async () => {
    try {
      const data = await run.mutateAsync({ ntpServer, dnsResolver })
      setReport(data)
      const fails = data.summary.fail
      if (fails > 0) toast.warning(t('federation.selfCheck.toast.hasFails', { count: fails }))
      else toast.success(t('federation.selfCheck.toast.ok'))
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  const onCopy = async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      toast.success(t('federation.selfCheck.toast.copied'))
    } catch {
      toast.error(t('federation.selfCheck.toast.copyFailed'))
    }
  }

  const grouped = useMemo(() => {
    const m = new Map<SelfCheckGroup, SelfCheckCheck[]>()
    if (report) for (const c of report.checks) {
      const arr = m.get(c.group) ?? []
      arr.push(c)
      m.set(c.group, arr)
    }
    return m
  }, [report])

  const ntpItems = useMemo(() => Object.fromEntries(NTP_SERVERS.map((o) => [o.value, o.value])), [])
  const dnsItems = useMemo(() => Object.fromEntries(DNS_RESOLVERS.map((o) => [o.value, o.value])), [])

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('federation.selfCheck.desc')}</p>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('federation.selfCheck.ntpServer')}</span>
            <Select value={ntpServer} onValueChange={(v) => setNtpServer(String(v))} items={ntpItems}>
              <SelectTrigger size="sm" className="w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NTP_SERVERS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    <span className="font-mono">{o.value}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{o.alias}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('federation.selfCheck.dnsResolver')}</span>
            <Select value={dnsResolver} onValueChange={(v) => setDnsResolver(String(v))} items={dnsItems}>
              <SelectTrigger size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DNS_RESOLVERS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    <span className="font-mono">{o.value}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{o.alias}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={onRun} disabled={run.isPending}>
            {run.isPending ? <Loader2 className="animate-spin" /> : report ? <RefreshCw /> : <Play />}
            {report ? t('federation.selfCheck.rerun') : t('federation.selfCheck.run')}
          </Button>

          <Button variant="outline" onClick={onCopy} disabled={!report}>
            <Copy />
            {t('federation.selfCheck.copyJson')}
          </Button>
        </CardContent>
      </Card>

      {report && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {STATUSES.map((s) => {
                  const meta = STATUS_META[s]
                  return (
                    <div key={s} className="flex items-center gap-2 rounded-lg border p-3">
                      <meta.Icon className={cn('size-5 shrink-0', meta.tone)} />
                      <div>
                        <div className="text-xl font-semibold leading-none">{report.summary[s]}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t(`federation.selfCheck.status.${s}`)}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <Meta label={t('federation.selfCheck.field.domain')} value={report.domain} mono />
                <Meta
                  label={t('federation.selfCheck.target')}
                  value={`${report.target.scheme}://${report.target.host}:${report.target.port}${report.target.hasSrv ? '' : ` (${t('federation.selfCheck.noSrv')})`}`}
                  mono
                />
                <Meta label={t('federation.selfCheck.field.ntpServer')} value={report.ntpServer} mono />
                <Meta label={t('federation.selfCheck.field.dnsResolver')} value={report.resolver} mono />
                <span>
                  {t('federation.selfCheck.runAt')} <Timestamp value={report.runAt} />
                </span>
                <span>
                  {t('federation.selfCheck.totalDuration')}{' '}
                  <span className="font-mono">{report.durationMs}ms</span>
                </span>
              </div>
            </CardContent>
          </Card>

          {GROUPS.map(({ key, Icon }) => {
            const checks = grouped.get(key)
            if (!checks || checks.length === 0) return null
            return (
              <section key={key} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 px-1">
                  <Icon className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-medium">{t(`federation.selfCheck.group.${key}`)}</h2>
                </div>
                <div className="flex flex-col gap-2">
                  {checks.map((c) => (
                    <CheckRow key={c.key} check={c} />
                  ))}
                </div>
              </section>
            )
          })}
        </>
      )}

      {!report && !run.isPending && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Globe className="size-8" />
          {t('federation.selfCheck.placeholder')}
        </div>
      )}
    </div>
  )
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span>
      {label} <span className={cn('text-foreground', mono && 'font-mono')}>{value}</span>
    </span>
  )
}
