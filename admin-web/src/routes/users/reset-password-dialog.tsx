import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
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
import { PASSWORD_REGEX } from '@/lib/constants'
import { formatApiError } from '@/lib/format-error'
import { useResetPassword } from '@/hooks/use-user-mutations'
import type { User } from '@/types/api'

export function ResetPasswordDialog({
  user,
  onClose,
}: {
  user: User | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const reset = useResetPassword()
  const [submitting, setSubmitting] = useState(false)

  // Rebuild the schema when the language changes so the zod message stays translated.
  const schema = useMemo(
    () => z.object({ newPassword: z.string().regex(PASSWORD_REGEX, t('resetPassword.invalid')) }),
    [t],
  )
  type FormValues = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    reset: resetForm,
    formState: { errors },
  } = useForm<FormValues>()

  useEffect(() => {
    if (user) resetForm({ newPassword: '' })
  }, [user, resetForm])

  const open = user !== null
  const onSubmit = async (v: FormValues) => {
    if (!user) return
    setSubmitting(true)
    try {
      await reset.mutateAsync({ id: user.id, newPassword: v.newPassword })
      toast.success(t('resetPassword.success'))
      onClose()
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
          <DialogTitle>{t('resetPassword.title', { name: user?.account ?? '' })}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="newPassword">{t('resetPassword.newPassword')}</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              {...register('newPassword')}
            />
            {errors.newPassword && (
              <p className="text-xs text-destructive">{errors.newPassword.message}</p>
            )}
            <p className="text-xs text-muted-foreground">{t('resetPassword.hint')}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('resetPassword.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
