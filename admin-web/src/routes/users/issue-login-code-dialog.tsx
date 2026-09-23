import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Clock3, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CopyButton } from '@/components/common/copy-button'
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'
import { useIssueLoginCode } from '@/hooks/use-user-mutations'
import { automationTestId } from '@/lib/automation-testing'
import type { IssuedLoginCode } from '@/types/api'

/** Issue-login-code dialog. Two phases: a confirm step (the reveal-once warning — multiple codes may be
 *  active per account; issuing a new one doesn't revoke others or sign out existing sessions), then a
 *  reveal-once step showing the plaintext code with a copy button + a "can't be viewed again" note. The
 *  plaintext is held only in local state and is never retrievable after the dialog closes. */
export function IssueLoginCodeDialog({
  user,
  onClose,
}: {
  user: { id: number; account: string } | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const issue = useIssueLoginCode()
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [issued, setIssued] = useState<IssuedLoginCode | null>(null)

  useEffect(() => {
    if (user) setIssued(null)
  }, [user])

  const open = user !== null
  const validityMinutes = issued
    ? Math.max(1, Math.ceil((issued.expiresAt - issued.issuedAt) / 60_000))
    : null
  const onIssue = async () => {
    if (!user || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      const r = await issue.mutateAsync(user.id)
      setIssued(r)
      toast.success(t('issueLoginCode.success'))
    } catch (e) {
      toast.error(formatApiError(e))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('issueLoginCode.title', { name: user?.account ?? '' })}</DialogTitle>
        </DialogHeader>
        {issued ? (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm text-destructive">{t('issueLoginCode.note')}</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ilc-code">{t('issueLoginCode.codeLabel')}</Label>
              <div className="flex items-center gap-2">
                <Input id="ilc-code" readOnly value={issued.code} className="font-mono text-lg" />
                <CopyButton
                  value={issued.code}
                  copiedKey="issueLoginCode.copied"
                  copyFailedKey="issueLoginCode.copyFailed"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              <Clock3 className="size-4 shrink-0 text-muted-foreground" />
              <span>
                {t('issueLoginCode.validFor', { count: validityMinutes })}
                {' · '}
                {t('issueLoginCode.expiresAt')}{' '}
                <Timestamp value={issued.expiresAt} className="font-medium" />
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-sm text-muted-foreground">{t('issueLoginCode.warning')}</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                {...automationTestId('issue-login-code-confirm')}
                onClick={onIssue}
                disabled={submitting}
              >
                {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t('issueLoginCode.confirm')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
