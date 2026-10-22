import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
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
import { formatApiError } from '@/lib/format-error'
import { useGenerateInitialPassword } from '@/hooks/use-user-mutations'

/** Generate-initial-password dialog (replaces the old admin-supplied reset-password). Two phases: a
 *  confirm step (the note that this is a one-time password, forces a set-own-password on next login, and
 *  revokes all existing sessions), then a reveal-once step showing the server-generated password with a
 *  copy button. The admin never authors the value — the server generates it. Refuses (LOGIN_METHOD_DISABLED)
 *  when password login is disabled. */
export function GenerateInitialPasswordDialog({
  user,
  onClose,
}: {
  user: { id: number; account: string } | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const generate = useGenerateInitialPassword()
  const [submitting, setSubmitting] = useState(false)
  const [password, setPassword] = useState<string | null>(null)

  useEffect(() => {
    if (user) setPassword(null)
  }, [user])

  const open = user !== null
  const onGenerate = async () => {
    if (!user) return
    setSubmitting(true)
    try {
      const r = await generate.mutateAsync(user.id)
      setPassword(r.password)
      toast.success(t('generateInitialPassword.success'))
    } catch (e) {
      toast.error(formatApiError(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('generateInitialPassword.title', { name: user?.account ?? '' })}
          </DialogTitle>
        </DialogHeader>
        {password !== null ? (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm text-destructive">{t('generateInitialPassword.note')}</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="gip-pwd">{t('generateInitialPassword.passwordLabel')}</Label>
              <div className="flex items-center gap-2">
                <Input id="gip-pwd" readOnly value={password} className="font-mono text-lg" />
                <CopyButton
                  value={password}
                  copiedKey="generateInitialPassword.copied"
                  copyFailedKey="generateInitialPassword.copyFailed"
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-sm text-muted-foreground">{t('generateInitialPassword.note')}</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('common.cancel')}
              </Button>
              <Button type="button" onClick={onGenerate} disabled={submitting}>
                {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t('generateInitialPassword.confirm')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
