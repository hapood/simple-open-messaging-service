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
import { isPasswordLoginEnabled, PASSWORD_REGEX, CODE } from '@/lib/constants'
import { ApiError } from '@/lib/api-error'
import { formatApiError } from '@/lib/format-error'
import { useCreateUser } from '@/hooks/use-user-mutations'
import { usePublicConfig } from '@/hooks/use-public-config'

// Account grammar mirrors the backend USER_ACCOUNT_RE: 1-30 chars, first char alphanumeric,
// then letters/digits/dot/underscore/hyphen. Validated client-side for early UX + again server-side.
const ACCOUNT_REGEX = /^[a-z0-9][a-z0-9._-]{0,29}$/i

/** Create-user dialog (admin-provisioned account). The password field is shown — and required — only
 *  when password login is enabled (loginMode ALL / PASSWORD_ONLY); under APP_OTP_AND_QR the account is
 *  created passwordless and bootstrapped via the one-time code issued next. The loginMode is read from the
 *  public GET /config so the dialog stays correct for any mode without a hardcode. */
export function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const create = useCreateUser()
  const { data: config } = usePublicConfig()
  const configReady = config !== undefined
  const passwordEnabled = config ? isPasswordLoginEnabled(config.loginMode) : false
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const schema = useMemo(
    () =>
      z.object({
        account: z.string().regex(ACCOUNT_REGEX, t('createUser.accountHint')),
        name: z
          .string()
          .trim()
          .min(1, t('createUser.nameHint'))
          .max(31, t('createUser.nameHint')),
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
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { account: '', name: '', password: '' },
  })

  useEffect(() => {
    if (open) {
      resetForm({ account: '', name: '', password: '' })
      clearErrors()
      setSubmitError(null)
    }
  }, [open, resetForm, clearErrors])

  const onSubmit = async (v: FormValues) => {
    if (!configReady) return
    setSubmitError(null)
    clearErrors()
    const parsed = schema.safeParse(v)
    if (!parsed.success) {
      const assigned = new Set<string>()
      for (const issue of parsed.error.issues) {
        const field = issue.path[0]
        if (
          (field === 'account' || field === 'name' || field === 'password') &&
          !assigned.has(field)
        ) {
          setError(field, { type: 'manual', message: issue.message })
          assigned.add(field)
        }
      }
      return
    }
    const password =
      passwordEnabled && parsed.data.password ? parsed.data.password : undefined
    setSubmitting(true)
    try {
      const r = await create.mutateAsync({
        account: parsed.data.account,
        name: parsed.data.name.trim(),
        password,
      })
      toast.success(t('createUser.success', { account: r.account }))
      onClose()
    } catch (e) {
      const message =
        e instanceof ApiError && e.code === CODE.ALREADY_EXISTS
          ? t('createUser.accountAlreadyExists')
          : formatApiError(e)
      setSubmitError(message)
      toast.error(message)
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
          {submitError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={submitting || !configReady}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('createUser.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
