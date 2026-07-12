import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { useQuotaNodes, useSetQuotaNodeLimits } from '@/hooks/use-quotas'
import { useIsSuperAdmin } from '@/hooks/use-me'
import type { QuotaCategory, QuotaNode, QuotaOverrides } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TableBodyState } from '@/components/common/table-state'
import { formatApiError } from '@/lib/format-error'

const CATEGORIES: QuotaCategory[] = ['messages', 'images', 'largeFiles', 'requests']

type CountKey = 'dailyMsgLimit' | 'dailyImageLimit' | 'dailyLargeFileLimit' | 'dailyRequestLimit'
type ByteKey = 'maxImageBytes' | 'maxLargeFileBytes'

/** Count-limit fields, each tied to the category whose usage it bounds. */
const COUNT_FIELDS: { key: CountKey; cat: QuotaCategory }[] = [
  { key: 'dailyMsgLimit', cat: 'messages' },
  { key: 'dailyImageLimit', cat: 'images' },
  { key: 'dailyLargeFileLimit', cat: 'largeFiles' },
  { key: 'dailyRequestLimit', cat: 'requests' },
]
/** Byte-cap fields, edited in MB. */
const BYTE_FIELDS: { key: ByteKey; cat: QuotaCategory }[] = [
  { key: 'maxImageBytes', cat: 'images' },
  { key: 'maxLargeFileBytes', cat: 'largeFiles' },
]

const MB = 1024 * 1024

/** Daily-quota admin page. Lists every node (the local server + each federated peer) with today's usage
 *  per category, and lets a super-admin set per-node overrides (empty field = use the global default). */
export function QuotasPage() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useQuotaNodes()
  const isSuper = useIsSuperAdmin()
  const [editing, setEditing] = useState<QuotaNode | null>(null)
  const nodes = data ?? []
  const colSpan = 1 + CATEGORIES.length + (isSuper ? 1 : 0)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('quota.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('quota.desc')}</p>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('quota.col.node')}</TableHead>
              {CATEGORIES.map((c) => (
                <TableHead key={c} className="text-right">{t(`quota.col.${c}`)}</TableHead>
              ))}
              {isSuper && <TableHead className="w-24" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={nodes.length === 0}
              colSpan={colSpan}
              emptyMessage={t('quota.empty')}
            >
              {nodes.map((n) => (
                <TableRow key={n.domain}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{n.domain}</span>
                      <Badge variant={n.isLocal ? 'default' : 'secondary'}>
                        {n.isLocal ? t('quota.local') : t('quota.peer')}
                      </Badge>
                      {!n.isLocal && n.trustLevel && (
                        <span className="text-xs text-muted-foreground">{n.trustLevel}</span>
                      )}
                    </div>
                  </TableCell>
                  {CATEGORIES.map((c) => {
                    const u = n.usage?.[c]
                    return <UsageCell key={c} count={u?.count ?? 0} limit={u?.limit ?? 0} />
                  })}
                  {isSuper && (
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(n)}>
                        <Pencil className="size-4" />
                        {t('quota.edit')}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>

      {editing && (
        <EditDialog key={editing.domain} node={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

/** count/limit cell, amber near the limit and destructive at/over it. */
function UsageCell({ count, limit }: { count: number; limit: number }) {
  const ratio = limit > 0 ? count / limit : 0
  const tone =
    count >= limit
      ? 'text-destructive'
      : ratio >= 0.8
        ? 'text-amber-600 dark:text-amber-500'
        : 'text-foreground'
  return (
    <TableCell className="text-right font-mono text-sm">
      <span className={tone}>
        {count.toLocaleString()} / {limit.toLocaleString()}
      </span>
    </TableCell>
  )
}

/** Edit a node's per-category overrides. Empty field → null (use the global default). */
function EditDialog({ node, onClose }: { node: QuotaNode; onClose: () => void }) {
  const { t } = useTranslation()
  const setLimits = useSetQuotaNodeLimits()

  // Seed from the node's current overrides; byte fields shown in MB.
  const [counts, setCounts] = useState<Record<CountKey, string>>({
    dailyMsgLimit: node.overrides.dailyMsgLimit?.toString() ?? '',
    dailyImageLimit: node.overrides.dailyImageLimit?.toString() ?? '',
    dailyLargeFileLimit: node.overrides.dailyLargeFileLimit?.toString() ?? '',
    dailyRequestLimit: node.overrides.dailyRequestLimit?.toString() ?? '',
  })
  const [mbs, setMbs] = useState<Record<ByteKey, string>>({
    maxImageBytes: node.overrides.maxImageBytes ? String(Math.round(node.overrides.maxImageBytes / MB)) : '',
    maxLargeFileBytes: node.overrides.maxLargeFileBytes ? String(Math.round(node.overrides.maxLargeFileBytes / MB)) : '',
  })

  const parseCount = (v: string): number | null => {
    const n = Number(v)
    return v.trim() === '' || !Number.isFinite(n) || n < 0 ? null : Math.floor(n)
  }
  const parseMb = (v: string): number | null => {
    const n = Number(v)
    return v.trim() === '' || !Number.isFinite(n) || n < 0 ? null : Math.floor(n * MB)
  }

  const onSave = async () => {
    const overrides: QuotaOverrides = {
      dailyMsgLimit: parseCount(counts.dailyMsgLimit),
      dailyImageLimit: parseCount(counts.dailyImageLimit),
      dailyLargeFileLimit: parseCount(counts.dailyLargeFileLimit),
      dailyRequestLimit: parseCount(counts.dailyRequestLimit),
      maxImageBytes: parseMb(mbs.maxImageBytes),
      maxLargeFileBytes: parseMb(mbs.maxLargeFileBytes),
    }
    try {
      await setLimits.mutateAsync({ domain: node.domain, overrides })
      toast.success(t('quota.toast.saved'))
      onClose()
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('quota.editTitle', { domain: node.domain })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            {COUNT_FIELDS.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label>{t(`quota.col.${f.cat}`)}</Label>
                <Input
                  type="number"
                  min={0}
                  value={counts[f.key]}
                  onChange={(e) => setCounts((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={t('quota.placeholder.default')}
                />
              </div>
            ))}
            {BYTE_FIELDS.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label>{t('quota.maxBytes', { cat: t(`quota.col.${f.cat}`) })}</Label>
                <Input
                  type="number"
                  min={0}
                  value={mbs[f.key]}
                  onChange={(e) => setMbs((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={t('quota.placeholder.default')}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('quota.editHint')}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('quota.cancel')}</Button>
          <Button onClick={onSave} disabled={setLimits.isPending}>{t('quota.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
