import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, Bell, Check, Copy, KeyRound, Loader2, Play, RefreshCw, ShieldCheck, Trash2, Upload, WandSparkles, X } from 'lucide-react'
import { useClearFirebaseConfig, useClearVapid, useGenerateVapid, useNotificationSettings, useSaveFirebaseConfig, useSaveVapid, useVapidHealthCheck } from '@/hooks/use-settings'
import { useMe } from '@/hooks/use-me'
import type { VapidHealthReport } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'
import { cn } from '@/lib/utils'

/** Push "Transport config" tab — the push-transmission credential suite (Web Push VAPID keypair,
 *  FCM status, and the deterministic VAPID health check). These cards previously lived under
 *  Settings; they move here so the Push page owns the whole push pipeline (devices + transport).
 *  RBAC travels with the cards: generate/save require ADMIN+, clear requires SUPER_ADMIN. */
export function TransportConfigPanel() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useNotificationSettings()
  const { data: me } = useMe()
  const role = me?.role
  const canEdit = role === 'ADMIN' || role === 'SUPER_ADMIN'
  const isSuper = role === 'SUPER_ADMIN'

  const generate = useGenerateVapid()
  const save = useSaveVapid()
  const clear = useClearVapid()
  const healthCheck = useVapidHealthCheck()
  const saveFirebase = useSaveFirebaseConfig()
  const clearFirebase = useClearFirebaseConfig()

  const [subject, setSubject] = useState('') // used by the initial Generate
  const [showPaste, setShowPaste] = useState(false)
  const [paste, setPaste] = useState({ subject: '', publicKey: '', privateKey: '' })
  const [report, setReport] = useState<VapidHealthReport | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const vapid = data?.vapid
  const configured = !!vapid?.configured
  const firebase = data?.firebase
  const fcmClientConfigured = !!firebase?.configured

  async function onGenerate() {
    try {
      await generate.mutateAsync({ subject: subject.trim() || undefined })
      toast.success(t('settings.vapid.generated'))
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  async function onRegenerate() {
    // Regenerate preserves the current contact subject (rotation breaks subscriptions regardless).
    try {
      await generate.mutateAsync({ subject: vapid?.subject || undefined })
      toast.success(t('settings.vapid.generated'))
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  async function onSavePaste() {
    try {
      await save.mutateAsync({
        subject: paste.subject.trim(),
        publicKey: paste.publicKey.trim(),
        privateKey: paste.privateKey.trim(),
      })
      toast.success(t('settings.vapid.saved'))
      setShowPaste(false)
      setPaste({ subject: '', publicKey: '', privateKey: '' })
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  async function onClear() {
    try {
      await clear.mutateAsync()
      toast.success(t('settings.vapid.cleared'))
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  async function onRunHealth() {
    try {
      const r = await healthCheck.mutateAsync()
      setReport(r)
      if (r.errors.length > 0 || (r.configured && !r.webPushConfigured)) {
        toast.warning(t('settings.health.toast.hasIssues'))
      } else {
        toast.success(t('settings.health.toast.ok'))
      }
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  async function onCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('settings.vapid.copied'))
    } catch {
      toast.error(t('settings.vapid.copyFailed'))
    }
  }

  // ---- Firebase client config (google-services.json upload) -------------------------------
  // Replacing an existing config is the same flow as the initial upload — re-open the picker. The server
  // re-parses + re-publishes; clients pick up the new fields on their next /push/firebase-config fetch and
  // re-initialize FirebaseApp (a server/project switch on the client side).
  function onPickFile() {
    fileInputRef.current?.click()
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Reset the input so picking the same file twice fires onChange again.
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      await saveFirebase.mutateAsync(text)
      toast.success(t('settings.fcm.saved'))
    } catch (err) {
      toast.error(formatApiError(err))
    }
  }

  async function onClearFirebase() {
    try {
      await clearFirebase.mutateAsync()
      toast.success(t('settings.fcm.cleared'))
    } catch (err) {
      toast.error(formatApiError(err))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Web Push (VAPID) — DB-backed, admin-managed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" />
            {t('settings.vapid.title')}
            <Badge variant={configured ? 'default' : 'outline'} className="ml-1">
              {configured ? t('settings.vapid.configured') : t('settings.vapid.notConfigured')}
            </Badge>
          </CardTitle>
          <CardDescription>{t('settings.vapid.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{formatApiError(error)}</p>
          ) : configured ? (
            <>
              <Field label={t('settings.vapid.subject')} value={vapid!.subject ?? ''} />
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-muted-foreground">{t('settings.vapid.publicKey')}</Label>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                    {vapid!.publicKey}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => onCopy(vapid!.publicKey ?? '')}>
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <span>{t('settings.vapid.privateHidden')}</span>
                {vapid!.updatedAt && (
                  <span>
                    {t('settings.vapid.updatedAt')} <Timestamp value={vapid!.updatedAt} />
                  </span>
                )}
              </div>
              <RotationWarning />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={onRegenerate} disabled={!canEdit || generate.isPending}>
                  {generate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  {t('settings.vapid.regenerate')}
                </Button>
                <Button variant="outline" size="sm" onClick={onClear} disabled={!isSuper || clear.isPending}>
                  {clear.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  {t('settings.vapid.clear')}
                </Button>
                {!isSuper && <span className="self-center text-xs text-muted-foreground">{t('settings.vapid.clearSuperOnly')}</span>}
                {!canEdit && <span className="self-center text-xs text-muted-foreground">{t('settings.vapid.adminOnly')}</span>}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="vapid-subject" className="text-xs text-muted-foreground">
                  {t('settings.vapid.subject')}
                </Label>
                <Input
                  id="vapid-subject"
                  value={subject}
                  onChange={(e) => setSubject((e.target as HTMLInputElement).value)}
                  placeholder={t('settings.vapid.subjectPlaceholder')}
                  className="max-w-md"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={onGenerate} disabled={!canEdit || generate.isPending}>
                  {generate.isPending ? <Loader2 className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
                  {t('settings.vapid.generate')}
                </Button>
                <Button variant="outline" onClick={() => setShowPaste((s) => !s)}>
                  {t('settings.vapid.pasteExisting')}
                </Button>
                {!canEdit && <span className="self-center text-xs text-muted-foreground">{t('settings.vapid.adminOnly')}</span>}
              </div>
              {showPaste && (
                <div className="mt-1 flex flex-col gap-3 rounded-lg border p-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="paste-subject" className="text-xs text-muted-foreground">
                      {t('settings.vapid.subject')}
                    </Label>
                    <Input
                      id="paste-subject"
                      value={paste.subject}
                      onChange={(e) => setPaste((p) => ({ ...p, subject: (e.target as HTMLInputElement).value }))}
                      placeholder="mailto:admin@example.com"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="paste-pub" className="text-xs text-muted-foreground">
                      {t('settings.vapid.publicKey')}
                    </Label>
                    <Input
                      id="paste-pub"
                      value={paste.publicKey}
                      onChange={(e) => setPaste((p) => ({ ...p, publicKey: (e.target as HTMLInputElement).value }))}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="paste-priv" className="text-xs text-muted-foreground">
                      {t('settings.vapid.privateKey')}
                    </Label>
                    <Input
                      id="paste-priv"
                      type="password"
                      value={paste.privateKey}
                      onChange={(e) => setPaste((p) => ({ ...p, privateKey: (e.target as HTMLInputElement).value }))}
                      className="font-mono text-xs"
                    />
                  </div>
                  <RotationWarning />
                  <Button
                    className="self-start"
                    size="sm"
                    onClick={onSavePaste}
                    disabled={save.isPending || !paste.subject.trim() || !paste.publicKey.trim() || !paste.privateKey.trim()}
                  >
                    {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
                    {t('settings.vapid.save')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* FCM client config (google-services.json) — DB-backed, admin-managed. The APK ships WITHOUT
          google-services.json (each operator runs their own Firebase project); the operator uploads theirs
          here, the server parses + publishes the 4 client fields at GET /push/firebase-config so Android
          clients initialize FirebaseApp at runtime. Independent of the send-side service-account below. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="size-4" />
            {t('settings.fcm.title')}
            <Badge variant={fcmClientConfigured ? 'default' : 'outline'} className="ml-1">
              {fcmClientConfigured ? t('settings.fcm.configured') : t('settings.fcm.notConfigured')}
            </Badge>
          </CardTitle>
          <CardDescription>{t('settings.fcm.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{formatApiError(error)}</p>
          ) : fcmClientConfigured ? (
            <>
              <Field label={t('settings.fcm.projectId')} value={firebase!.projectId ?? ''} />
              <Field label={t('settings.fcm.appId')} value={firebase!.appId ?? ''} />
              <Field label={t('settings.fcm.senderId')} value={firebase!.gcmSenderId ?? ''} />
              {firebase!.updatedAt && (
                <span className="text-xs text-muted-foreground">
                  {t('settings.fcm.updatedAt')} <Timestamp value={firebase!.updatedAt} />
                </span>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={onPickFile} disabled={!canEdit || saveFirebase.isPending}>
                  {saveFirebase.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  {t('settings.fcm.replace')}
                </Button>
                <Button variant="outline" size="sm" onClick={onClearFirebase} disabled={!isSuper || clearFirebase.isPending}>
                  {clearFirebase.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  {t('settings.fcm.clear')}
                </Button>
                {!isSuper && (
                  <span className="self-center text-xs text-muted-foreground">{t('settings.fcm.clearSuperOnly')}</span>
                )}
              </div>
            </>
          ) : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={onFilePicked}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={onPickFile} disabled={!canEdit || saveFirebase.isPending}>
                  {saveFirebase.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  {t('settings.fcm.upload')}
                </Button>
                {!canEdit && (
                  <span className="self-center text-xs text-muted-foreground">{t('settings.fcm.adminOnly')}</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.fcm.hint')}</p>
            </>
          )}
          {/* The SEND-side credential is a separate concern: the GOOGLE_APPLICATION_CREDENTIALS
              service-account JSON (env, not editable here). Surfaced so a half-configured server — client
              config uploaded but service-account missing, or vice versa — is visible at a glance. */}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
            <span className="font-medium">{t('settings.fcm.sendLabel')}</span>
            <Badge variant={data?.fcmConfigured ? 'default' : 'outline'}>
              {data?.fcmConfigured ? t('settings.fcm.configured') : t('settings.fcm.notConfigured')}
            </Badge>
            <span>{t('settings.fcm.sendHint')}</span>
          </div>
        </CardContent>
      </Card>

      {/* Health check — deterministic VAPID keypair validation */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            {t('settings.health.title')}
          </CardTitle>
          <CardDescription>{t('settings.health.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button className="self-start" size="sm" onClick={onRunHealth} disabled={healthCheck.isPending}>
            {healthCheck.isPending ? <Loader2 className="size-3.5 animate-spin" /> : report ? <RefreshCw className="size-3.5" /> : <Play className="size-3.5" />}
            {report ? t('settings.health.rerun') : t('settings.health.run')}
          </Button>
          {report && (
            <div className="flex flex-col gap-1.5">
              <CheckItem ok={report.configured} label={t('settings.health.configured')} />
              <CheckItem ok={report.publicKeyValid} label={t('settings.health.publicKeyValid')} />
              <CheckItem ok={report.privateKeyValid} label={t('settings.health.privateKeyValid')} />
              <CheckItem ok={report.pairMatches} label={t('settings.health.pairMatches')} />
              <CheckItem ok={report.subjectValid} label={t('settings.health.subjectValid')} />
              <CheckItem ok={report.fcmConfigured} label={t('settings.health.fcmConfigured')} />
              <CheckItem ok={report.firebaseClientConfigured} label={t('settings.health.firebaseClientConfigured')} />
              <CheckItem ok={report.webPushConfigured} label={t('settings.health.webPushConfigured')} />
              {report.errors.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  {report.errors.map((e, i) => (
                    <li key={i}>• {e}</li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {t('settings.health.domain')} <code className="font-mono">{report.somsDomain}</code>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <span className="break-all text-sm">{value}</span>
    </div>
  )
}

function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? Check : X
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={cn('size-4 shrink-0', ok ? 'text-emerald-500' : 'text-destructive')} />
      <span>{label}</span>
    </div>
  )
}

function RotationWarning() {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{t('settings.vapid.rotationWarning')}</span>
    </div>
  )
}
