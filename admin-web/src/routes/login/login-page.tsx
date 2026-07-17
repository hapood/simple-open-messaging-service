import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useAuth } from '@/auth/auth-context'
import { formatApiError } from '@/lib/format-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type Step = 'password' | 'twoFactor'

export function LoginPage() {
  const { t } = useTranslation()
  const { login, verifyTwoFactor } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('password')
  const [challengeToken, setChallengeToken] = useState('')
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

  const onPasswordSubmit = async (v: FormValues) => {
    setSubmitting(true)
    try {
      const r = await login(v.account, v.password)
      if ('twoFactorRequired' in r) {
        setChallengeToken(r.challengeToken)
        setStep('twoFactor')
      } else {
        navigate('/users', { replace: true })
      }
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
          <CardTitle className="flex items-center gap-2">
            {step === 'twoFactor' && (
              <button
                type="button"
                onClick={() => {
                  setStep('password')
                  setChallengeToken('')
                }}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('login.backToPassword')}
              >
                <ArrowLeft className="size-4" />
              </button>
            )}
            {step === 'password' ? t('login.title') : t('login.twoFactorTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {step === 'password' ? (
            <form onSubmit={handleSubmit(onPasswordSubmit)} className="flex flex-col gap-4">
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
          ) : (
            <TwoFactorStep
              challengeToken={challengeToken}
              submitting={submitting}
              setSubmitting={setSubmitting}
              onDone={() => navigate('/users', { replace: true })}
              verify={verifyTwoFactor}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** The 6-digit TOTP step (with a "use a backup code instead" fallback). Self-contained so the password
 *  step's react-hook-form state is not involved. */
function TwoFactorStep({
  challengeToken,
  submitting,
  setSubmitting,
  onDone,
  verify,
}: {
  challengeToken: string
  submitting: boolean
  setSubmitting: (v: boolean) => void
  onDone: () => void
  verify: (challengeToken: string, code?: string, backupCode?: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [useBackup, setUseBackup] = useState(false)
  const [code, setCode] = useState('')
  const [backupCode, setBackupCode] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      if (useBackup) {
        await verify(challengeToken, undefined, backupCode.trim())
      } else {
        await verify(challengeToken, code.trim(), undefined)
      }
      onDone()
    } catch (err) {
      toast.error(formatApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('login.twoFactorHint')}</p>
      {!useBackup ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="totp">{t('login.code')}</Label>
          <Input
            id="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="text-center font-mono text-lg tracking-[0.5em]"
            placeholder="000000"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="backup">{t('login.backupCode')}</Label>
          <Input
            id="backup"
            value={backupCode}
            onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
            className="font-mono"
            placeholder="ABCD-EFGH-IJKL-MNOP"
          />
        </div>
      )}
      <Button type="submit" disabled={submitting} className="mt-2">
        {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
        {t('login.verify')}
      </Button>
      <button
        type="button"
        className="text-center text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setUseBackup((v) => !v)}
      >
        {useBackup ? t('login.useAuthenticator') : t('login.useBackupCode')}
      </button>
    </form>
  )
}
