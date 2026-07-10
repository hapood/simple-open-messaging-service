import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Link2 } from 'lucide-react'
import type { SelfCheckCertInfo, SelfCheckChainNode } from '@/types/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

/** One label/value row in the certificate detail grid. */
function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('break-all text-xs', mono && 'font-mono')}>{children}</dd>
    </div>
  )
}

/** The trust chain walked from leaf → self-signed root, indented per depth. */
function ChainTree({ chain, complete }: { chain: SelfCheckChainNode[]; complete?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      {chain.map((node, i) => {
        const isRoot = i === chain.length - 1
        return (
          <div key={i} className="flex items-center gap-2" style={{ paddingLeft: i * 16 }}>
            {isRoot ? (
              <ShieldCheck className="size-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="break-all font-mono text-xs">{node.subjectCN ?? node.subject}</span>
            {node.selfSigned && (
              <Badge variant="outline" className="h-4 text-[10px]">
                root
              </Badge>
            )}
            {node.isCA && !node.selfSigned && (
              <Badge variant="secondary" className="h-4 text-[10px]">
                CA
              </Badge>
            )}
          </div>
        )
      })}
      <div
        className={cn(
          'mt-1 text-xs',
          complete
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-600 dark:text-amber-400',
        )}
      >
        {complete ? t('federation.selfCheck.cert.chainComplete') : t('federation.selfCheck.cert.chainIncomplete')}
      </div>
    </div>
  )
}

/** Full certificate dimensions + the trust chain. Rendered inside a tls-public per-IP probe block. */
export function CertDetail({
  cert,
  chain,
  chainComplete,
}: {
  cert: SelfCheckCertInfo
  chain?: SelfCheckChainNode[]
  chainComplete?: boolean
}) {
  const { t } = useTranslation()
  const expiryTone =
    cert.daysToExpiry < 7
      ? 'text-destructive'
      : cert.daysToExpiry < 30
        ? 'text-amber-600 dark:text-amber-400'
        : ''
  const keyDesc = [cert.publicKey.algorithm, cert.publicKey.bits ? `${cert.publicKey.bits} bit` : null, cert.publicKey.curve]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex flex-col gap-3">
      <dl className="divide-y divide-border">
        <Field label={t('federation.selfCheck.cert.subject')}>{cert.subjectCN ?? cert.subject}</Field>
        <Field label={t('federation.selfCheck.cert.issuer')}>{cert.issuerCN ?? cert.issuer}</Field>
        <Field label={t('federation.selfCheck.cert.serial')} mono>
          {cert.serialNumber}
        </Field>
        <Field label={t('federation.selfCheck.cert.sigAlg')}>{cert.signatureAlgorithm ?? '—'}</Field>
        <Field label={t('federation.selfCheck.cert.pubKey')} mono>
          {keyDesc || '—'}
        </Field>
        <Field label={t('federation.selfCheck.cert.validFrom')}>{cert.validFrom}</Field>
        <Field label={t('federation.selfCheck.cert.validTo')}>
          <span className={expiryTone}>{cert.validTo}</span>{' '}
          <span className={cn('text-[10px]', expiryTone)}>({t('federation.selfCheck.cert.daysLeft', { days: cert.daysToExpiry })})</span>
        </Field>
        <Field label={t('federation.selfCheck.cert.san')} mono>
          {cert.subjectAltName ?? '—'}
        </Field>
        <Field label={t('federation.selfCheck.cert.keyUsage')}>{cert.keyUsage?.join(', ') ?? '—'}</Field>
        <Field label={t('federation.selfCheck.cert.alpn')}>{cert.alpn ?? '—'}</Field>
        <Field label={t('federation.selfCheck.cert.sanMatched')}>
          {cert.sanMatched ? '✓' : '✗'}
        </Field>
        <Field label={t('federation.selfCheck.cert.fpSha256')} mono>
          <span className="text-[10px]">{cert.fingerprintSha256}</span>
        </Field>
        <Field label={t('federation.selfCheck.cert.fpSha1')} mono>
          <span className="text-[10px]">{cert.fingerprintSha1}</span>
        </Field>
      </dl>
      {chain && chain.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            {t('federation.selfCheck.cert.chainTitle')}
          </div>
          <ChainTree chain={chain} complete={chainComplete} />
        </div>
      )}
    </div>
  )
}
