import { Fragment, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  MinusCircle,
  ChevronDown,
} from 'lucide-react'
import type {
  SelfCheckCheck,
  SelfCheckStatus,
  SelfCheckIpTlsProbe,
  SelfCheckIpWellKnownProbe,
} from '@/types/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { CertDetail } from './cert-detail'

/** Status → icon + tone, shared by checks and per-IP probes. */
export const STATUS_META: Record<
  SelfCheckStatus,
  { Icon: typeof CheckCircle2; tone: string; chip: string }
> = {
  ok: {
    Icon: CheckCircle2,
    tone: 'text-emerald-500',
    chip: 'text-emerald-600 dark:text-emerald-400',
  },
  warn: {
    Icon: AlertTriangle,
    tone: 'text-amber-500',
    chip: 'text-amber-600 dark:text-amber-400',
  },
  fail: { Icon: XCircle, tone: 'text-destructive', chip: 'text-destructive' },
  skip: {
    Icon: MinusCircle,
    tone: 'text-muted-foreground',
    chip: 'text-muted-foreground',
  },
}

/** Render any evidence value: booleans as ✓/✗, arrays joined, null/undefined as —. */
function fmt(v: unknown): ReactNode {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? '✓' : '✗'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—'
  return String(v)
}

/** A key/value list built from raw evidence entries. Labels resolve through i18n with a field-name
 *  fallback (so a field the i18n bundle doesn't list yet still shows readably). */
function KvList({ entries }: { entries: Array<[string, unknown]> }) {
  const { t } = useTranslation()
  return (
    <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-xs text-muted-foreground">
            {t(`federation.selfCheck.field.${k}`, { defaultValue: k })}
          </dt>
          <dd className="break-all font-mono text-xs">{fmt(v)}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** One per-IP TLS probe: status, reachability, and a collapsible full-certificate detail. */
function TlsIpBlock({ probe }: { probe: SelfCheckIpTlsProbe }) {
  const { t } = useTranslation()
  const meta = STATUS_META[probe.status]
  const [certOpen, setCertOpen] = useState(false)
  return (
    <div className="rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="h-5 font-mono text-[10px]">
          v{probe.family}
        </Badge>
        <span className="font-mono text-xs">{probe.ip}</span>
        <meta.Icon className={cn('size-3.5 shrink-0', meta.tone)} />
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {probe.detail}
        </span>
        {probe.cert && (
          <button
            type="button"
            className="shrink-0 text-[10px] text-primary hover:underline"
            onClick={() => setCertOpen((o) => !o)}
          >
            {certOpen
              ? t('federation.selfCheck.cert.hide')
              : t('federation.selfCheck.cert.show')}
          </button>
        )}
      </div>
      {certOpen && probe.cert && (
        <div className="mt-2">
          <CertDetail
            cert={probe.cert}
            chain={probe.chain}
            chainComplete={probe.chainComplete}
          />
        </div>
      )}
      {!probe.reachable && probe.code && (
        <div className="mt-1 font-mono text-[10px] text-muted-foreground">
          {probe.code} · {probe.errorClass}
        </div>
      )}
    </div>
  )
}

/** One per-IP .well-known probe: HTTP status, content-type, software, key validity. */
function WkIpBlock({ probe }: { probe: SelfCheckIpWellKnownProbe }) {
  const { t } = useTranslation()
  const meta = STATUS_META[probe.status]
  const detail = probe.code
    ? t(`federation.selfCheck.error.${probe.code}`, {
        defaultValue: probe.detail,
      })
    : probe.detail
  return (
    <div className="rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="h-5 font-mono text-[10px]">
          v{probe.family}
        </Badge>
        <span className="font-mono text-xs">{probe.ip}</span>
        <meta.Icon className={cn('size-3.5 shrink-0', meta.tone)} />
        <span className="flex-1 whitespace-normal text-xs text-muted-foreground">
          {detail}
        </span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
        {probe.httpVersion ? `HTTP/${probe.httpVersion}` : ''}
        {probe.httpStatus ? ` · HTTP ${probe.httpStatus}` : ''}
        {probe.contentType ? ` · ${probe.contentType}` : ''}
        {probe.phase ? ` · phase=${probe.phase}` : ''}
        {probe.code ? ` · ${probe.code}` : ''}
      </div>
    </div>
  )
}

/** Renders a check's evidence block, switched on the check key (each check has a distinct shape). */
function Evidence({ check }: { check: SelfCheckCheck }) {
  const ev = (check.evidence ?? {}) as Record<string, unknown>
  switch (check.key) {
    case 'config':
      return (
        <KvList
          entries={[
            ['domain', ev.domain],
            ['keyId', ev.keyId],
            ['allowInsecureHttp', ev.allowInsecureHttp],
            ['nodeEnv', ev.nodeEnv],
            ['tlsConfigured', ev.tlsConfigured],
            ['listenPort', ev.listenPort],
          ]}
        />
      )
    case 'key-file':
      return (
        <KvList
          entries={[
            ['path', ev.path],
            ['mode', ev.mode],
          ]}
        />
      )
    case 'key-age':
      return (
        <KvList
          entries={[
            ['createdAt', ev.createdAt],
            ['ageDays', ev.ageDays],
          ]}
        />
      )
    case 'dns-srv':
      return (
        <KvList
          entries={[
            ['record', ev.record],
            ['resolvedHost', ev.resolvedHost],
            ['resolvedPort', ev.resolvedPort],
          ]}
        />
      )
    case 'dns-a':
    case 'dns-aaaa':
      return <KvList entries={[['addresses', ev.addresses]]} />
    case 'tls-public': {
      const ips = (ev.ips ?? []) as SelfCheckIpTlsProbe[]
      const host = ev.host
        ? `host=${String(ev.host)} · sni=${String(ev.host)} · port=${String(ev.port ?? '')}`
        : ''
      return (
        <div className="flex flex-col gap-2">
          {host && (
            <div className="font-mono text-[10px] text-muted-foreground">
              {host}
            </div>
          )}
          {ips.map((p) => (
            <TlsIpBlock key={p.ip} probe={p} />
          ))}
        </div>
      )
    }
    case 'well-known': {
      const ips = (ev.ips ?? []) as SelfCheckIpWellKnownProbe[]
      return (
        <div className="flex flex-col gap-2">
          {ips.map((p) => (
            <WkIpBlock key={p.ip} probe={p} />
          ))}
        </div>
      )
    }
    case 'key-consistency':
      return (
        <KvList
          entries={[
            ['keyId', ev.keyId],
            ['keyIdDomain', ev.keyIdDomain],
            ['expectedDomain', ev.expectedDomain],
            ['keyMatch', ev.keyMatch],
            ['domainMatch', ev.domainMatch],
            ['localPubB64', ev.localPubB64],
            ['localPubSha256', ev.localPubSha256],
            ['publishedPubB64', ev.publishedPubB64],
            ['publishedKeyCount', ev.publishedKeyCount],
          ]}
        />
      )
    case 'sign-loopback':
      return (
        <KvList
          entries={[
            ['authority', ev.authority],
            ['verified', ev.verified],
            ['keyId', ev.keyId],
          ]}
        />
      )
    case 'clock-skew':
      return (
        <KvList
          entries={[
            ['ntpServer', ev.ntpServer],
            ['offsetSec', ev.offsetSec],
            ['roundTripMs', ev.roundTripMs],
          ]}
        />
      )
    case 'tls-loopback':
      return (
        <KvList
          entries={[
            ['host', ev.host],
            ['port', ev.port],
            ['originTls', ev.originTls],
          ]}
        />
      )
    default:
      return <KvList entries={Object.entries(ev)} />
  }
}

/** A single collapsible check row. Collapsed = status icon + title + detail + duration; expanded = evidence. */
export function CheckRow({ check }: { check: SelfCheckCheck }) {
  const { t } = useTranslation()
  const meta = STATUS_META[check.status]
  const hasEvidence = !!check.evidence && Object.keys(check.evidence).length > 0
  const [open, setOpen] = useState(
    check.status === 'fail' || check.status === 'warn',
  )
  const title = t(`federation.selfCheck.check.${check.key}`, {
    defaultValue: check.title,
  })
  const duration = check.blockedBy
    ? '—'
    : check.durationMs < 1
      ? '<1ms'
      : `${check.durationMs}ms`
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center gap-3 p-3 text-left"
        onClick={() => hasEvidence && setOpen((o) => !o)}
      >
        <meta.Icon className={cn('size-4 shrink-0', meta.tone)} />
        <span className="text-sm font-medium">{title}</span>
        <span className="flex-1 whitespace-normal text-xs text-muted-foreground">
          {check.detail}
        </span>
        {check.blockedBy && (
          <Badge
            variant="outline"
            className="text-[10px] text-muted-foreground"
          >
            {t('federation.selfCheck.blocked')}
          </Badge>
        )}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {duration}
        </span>
        {hasEvidence && (
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        )}
      </button>
      {open && hasEvidence && (
        <div className="border-t px-3 py-2">
          <Evidence check={check} />
        </div>
      )}
    </div>
  )
}
