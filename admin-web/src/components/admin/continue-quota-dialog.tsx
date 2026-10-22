import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatApiError } from '@/lib/format-error'
import { useContinuePeer, useContinueUser } from '@/hooks/use-quota'
import type { BreakerStatus } from '@/types/api'

const MB = 1024 * 1024

/** "Continue / add quota" dialog for one tripped circuit breaker. The three inputs are ADDITIVE bumps to
 *  today's effective limit (stack on top of the base + any earlier admin grant). File total size is entered in
 *  MB and converted to bytes. Shows current usage vs limit per tripped dimension, with a "need ≥ X" hint. */
export function ContinueQuotaDialog({
  breaker,
  onClose,
}: {
  breaker: BreakerStatus
  onClose: () => void
}) {
  const { t } = useTranslation()
  const isPeer = breaker.scope === 'peer'
  const peerMutation = useContinuePeer()
  const userMutation = useContinueUser()
  const mutation = isPeer ? peerMutation : userMutation

  const [addMsg, setAddMsg] = useState('')
  const [addFile, setAddFile] = useState('')
  const [addFileMb, setAddFileMb] = useState('')

  const num = (raw: string): number | null => {
    if (!raw.trim()) return 0
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const msg = num(addMsg)
  const file = num(addFile)
  const fileBytes = num(addFileMb)
  const invalid = msg === null || file === null || fileBytes === null

  const need = (over: number): string | null => (over > 0 ? Math.ceil(over).toLocaleString() : null)

  const save = async () => {
    if (invalid) return
    const input = {
      addMsg: msg! || undefined,
      addFile: file! || undefined,
      addFileBytes: fileBytes! ? Math.round(fileBytes! * MB) : undefined,
    }
    try {
      const result = isPeer
        ? await peerMutation.mutateAsync({ domain: breaker.entity, input })
        : await userMutation.mutateAsync({ userId: Number(breaker.entity), input })
      toast.success(
        result.tripped
          ? t('quota.breaker.toastStillTripped')
          : t('quota.breaker.toastResumed'),
      )
      onClose()
    } catch (error) {
      toast.error(formatApiError(error))
    }
  }

  const entityLabel = isPeer ? breaker.entity : `user ${breaker.entity}`
  const msgOver = breaker.msg.count - breaker.msg.limit
  const fileOver = breaker.file.count - breaker.file.limit
  const fileBytesOver = Number(breaker.fileBytes.bytes) - breaker.fileBytes.limit

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('quota.breaker.continueTitle', { entity: entityLabel })}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <TrippedRow
            label={t('quota.breaker.dimMsg')}
            count={breaker.msg.count}
            limit={breaker.msg.limit}
            needHint={need(msgOver)}
          />
          <TrippedRow
            label={t('quota.breaker.dimFile')}
            count={breaker.file.count}
            limit={breaker.file.limit}
            needHint={need(fileOver)}
          />
          <TrippedRow
            label={t('quota.breaker.dimFileBytes')}
            count={Number(breaker.fileBytes.bytes)}
            limit={breaker.fileBytes.limit}
            needHint={need(fileBytesOver)}
            isBytes
          />
          <div className="grid grid-cols-3 gap-3 pt-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t('quota.breaker.addMsg')}</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={addMsg}
                placeholder="0"
                onChange={(e) => setAddMsg(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('quota.breaker.addFile')}</Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={addFile}
                placeholder="0"
                onChange={(e) => setAddFile(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('quota.breaker.addFileBytes')}</Label>
              <Input
                type="number"
                min={0}
                value={addFileMb}
                placeholder="0"
                onChange={(e) => setAddFileMb(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {invalid ? t('quota.invalid') : t('quota.breaker.continueHint')}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('quota.cancel')}
          </Button>
          <Button disabled={invalid || mutation.isPending} onClick={save}>
            {t('quota.breaker.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TrippedRow({
  label,
  count,
  limit,
  needHint,
  isBytes,
}: {
  label: string
  count: number
  limit: number
  needHint: string | null
  isBytes?: boolean
}) {
  const { t } = useTranslation()
  const fmt = (n: number) =>
    isBytes ? `${(n / MB).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB` : n.toLocaleString()
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="text-right">
        <div className="font-mono text-destructive">
          {fmt(count)} / {fmt(limit)}
        </div>
        {needHint ? (
          <div className="text-xs text-muted-foreground">
            {t('quota.breaker.needHint', { amount: needHint })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
