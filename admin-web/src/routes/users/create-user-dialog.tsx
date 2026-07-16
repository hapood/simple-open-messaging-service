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
import { isPasswordLoginEnabled, PASSWORD_REGEX } from '@/lib/constants'
import { formatApiError } from '@/lib/format-error'
import { useCreateUser } from '@/hooks/use-user-mutations'
import { usePublicConfig } from '@/hooks/use-public-config'

// Account grammar mirrors the backend USER_ACCOUNT_RE (3-31: a leading letter, then letters/digits with
// single-dot separators). Validated client-side for early UX + again server-side.
const ACCOUNT_REGEX = /^(?=.{3,31}$)[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/

/** Create-user dialog (admin-provisioned account). The password field is shown — and required — only
 *  when password login is enabled (loginMode ALL / PASSWORD_ONLY); under APP_OTP_AND_QR the account is
 *  created passwordless and bootstrapped via the one-time code issued next. The loginMode is read from the
 *  public GET /config so the dialog stays correct for any mode without a hardcode. */
export function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const create = useCreateUser()
  const { data: config } = usePublicConfig()
  const passwordEnabled = config ? isPasswordLoginEnabled(config.loginMode) : false
  const [submitting, setSubmitting] = useState(false)

  const schema = useMemo(
    () =>
      z.object({
        account: z.string().regex(ACCOUNT_REGEX, t('createUser.accountHint')),
        name: z
          .string()
          .trim()
          .min(1, t('createUser.nameHint'))
          .max(30, t('createUser.nameHint')),
        password: passwordEnabled
          ? z
              .string()
              .min(1, t('createUser.passwordRequired'))
              .regex(PASSWORD_REGEX, t('createUser.passwordHint'))
          : z.string().optional(),
      }),
    [t, passwordEnabled],
  )
  type FormValues = z.infer<typeof schema>
  const {
    register,
    handleSubmit,
    reset: resetForm,
    formState: { errors },
  } = useForm<FormValues>()

  useEffect(() => {
    if (open) resetForm({ account: '', name: '', password: '' })
  }, [open, resetForm])

  const onSubmit = async (v: FormValues) => {
    const password = passwordEnabled && v.password ? v.password : undefined
    setSubmitting(true)
    try {
      const r = await create.mutateAsync({ account: v.account, name: v.name.trim(), password })
      toast.success(t('createUser.success', { account: r.account }))
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
          <DialogTitle>{t('createUser.title')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="cu-account">{t('createUser.account')}</Label>
            <Input id="cu-account" autoComplete="off" {...register('account')} />
            {errors.account ? (
              <p className="text-xs text-destructive">{errors.account.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('createUser.accountHint')}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="cu-name">{t('createUser.name')}</Label>
            <Input id="cu-name" autoComplete="off" {...register('name')} />
            {errors.name ? (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('createUser.nameHint')}</p>
            )}
          </div>
          {passwordEnabled ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="cu-pwd">{t('createUser.password')}</Label>
              <Input
                id="cu-pwd"
                type="password"
                autoComplete="new-password"
                {...register('password')}
              />
              {errors.password ? (
                <p className="text-xs text-destructive">{errors.password.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t('createUser.passwordHint')}</p>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('createUser.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
