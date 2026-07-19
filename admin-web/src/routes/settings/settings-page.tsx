import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Clock, Globe, Loader2 } from 'lucide-react'
import { useNotificationSettings, useSetOtpTtl } from '@/hooks/use-settings'
import { useMe } from '@/hooks/use-me'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatApiError } from '@/lib/format-error'

/** Admin Settings page — operator-managed runtime configuration that is NOT push transport (the
 *  VAPID keypair, FCM status, and VAPID health check live under Push → Transport config now). What
 *  remains here is the server identity (SOMS_DOMAIN, env, read-only) and the one-time-code validity
 *  window (DB-backed, admin-managed). RBAC: saving the TTL requires ADMIN+. */
export function SettingsPage() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useNotificationSettings()
  const { data: me } = useMe()
  const role = me?.role
  const canEdit = role === 'ADMIN' || role === 'SUPER_ADMIN'

  const setOtpTtl = useSetOtpTtl()
  const [ttlInput, setTtlInput] = useState('')
  // Sync the TTL input from the server value (initial load + after a save invalidates + refetches).
  useEffect(() => {
    if (typeof data?.otpTtlMinutes === 'number') setTtlInput(String(data.otpTtlMinutes))
  }, [data?.otpTtlMinutes])

  async function onSaveTtl() {
    const n = Number(ttlInput)
    if (!Number.isFinite(n)) return
    try {
      await setOtpTtl.mutateAsync(Math.trunc(n))
      toast.success(t('settings.otpTtl.saved'))
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.desc')}</p>
      </div>

      {/* Server identity — read-only (SOMS_DOMAIN env, the federation identity) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="size-4" />
            {t('settings.identity.title')}
          </CardTitle>
          <CardDescription>{t('settings.identity.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
            {data?.somsDomain ?? '—'}
          </code>
          <Badge variant={data?.somsDomain ? 'default' : 'outline'}>
            {data?.somsDomain ? t('settings.identity.set') : t('settings.identity.unset')}
          </Badge>
          <span className="text-xs text-muted-foreground">{t('settings.identity.envNote')}</span>
        </CardContent>
      </Card>

      {/* One-time-code validity window — DB-backed, admin-managed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" />
            {t('settings.otpTtl.title')}
          </CardTitle>
          <CardDescription>{t('settings.otpTtl.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{formatApiError(error)}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="otp-ttl" className="text-xs text-muted-foreground">
                  {t('settings.otpTtl.label')}
                </Label>
                <Input
                  id="otp-ttl"
                  type="number"
                  min={1}
                  max={1440}
                  value={ttlInput}
                  onChange={(e) => setTtlInput((e.target as HTMLInputElement).value)}
                  className="w-32"
                />
              </div>
              <span className="pb-2 text-xs text-muted-foreground">{t('settings.otpTtl.minutes')}</span>
              <Button
                size="sm"
                onClick={onSaveTtl}
                disabled={
                  !canEdit ||
                  setOtpTtl.isPending ||
                  ttlInput === '' ||
                  ttlInput === String(data?.otpTtlMinutes ?? '')
                }
              >
                {setOtpTtl.isPending && <Loader2 className="size-3.5 animate-spin" />}
                {t('settings.otpTtl.save')}
              </Button>
              {!canEdit && (
                <span className="pb-2 self-end text-xs text-muted-foreground">{t('settings.vapid.adminOnly')}</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
