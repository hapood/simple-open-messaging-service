import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/auth/auth-context'
import { formatApiError } from '@/lib/format-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function LoginPage() {
  const { t } = useTranslation()
  const { login } = useAuth()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)

  // Rebuild the schema when the language changes so zod messages stay translated.
  const schema = useMemo(
    () =>
      z.object({
        account: z.string().min(1, t('login.accountRequired')),
        password: z.string().min(1, t('login.passwordRequired')),
      }),
    [t],
  )
  type FormValues = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: { account: 'admin', password: '' } })

  const onSubmit = async (v: FormValues) => {
    setSubmitting(true)
    try {
      await login(v.account, v.password)
      navigate('/users', { replace: true })
    } catch (e) {
      toast.error(formatApiError(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('login.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="account">{t('login.account')}</Label>
              <Input id="account" autoComplete="username" {...register('account')} />
              {errors.account && (
                <p className="text-xs text-destructive">{errors.account.message}</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t('login.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password')}
              />
              {errors.password && (
                <p className="text-xs text-destructive">{errors.password.message}</p>
              )}
            </div>
            <Button type="submit" disabled={submitting} className="mt-2">
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('login.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
