import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { startRegistration } from '@simplewebauthn/browser'
import { AlertTriangle, Copy, Fingerprint, KeyRound, Loader2, Lock, Smartphone, WandSparkles } from 'lucide-react'
import {
  useBeginTwoFactorSetup,
  useCompleteTwoFactorSetup,
  useDisableTwoFactor,
  useRegenerateBackupCodes,
  useTwoFactorStatus,
} from '@/hooks/use-two-factor'
import {
  useBeginWebAuthnRegistration,
  useCompleteWebAuthnRegistration,
  useRemoveWebAuthnCredential,
  useRenameWebAuthnCredential,
  useWebAuthnCredentials,
  useWebAuthnStatus,
} from '@/hooks/use-webauthn'
import { forceLogout } from '@/auth/force-logout'
import { formatApiError } from '@/lib/format-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { QrCode } from '@/components/common/qr-code'
import { Timestamp } from '@/components/common/timestamp'
import type { TwoFactorSetupBundle } from '@/types/api'

/** My Account — two-factor authentication self-service for the signed-in admin. Enroll an authenticator
 *  app (Google / Microsoft Authenticator), reveal/regenerate one-time backup codes, or disable. Enabling
 *  invalidates every existing session (the admin must re-login through the new 2FA challenge). */
export function SecurityPage() {
  const { t } = useTranslation()
  const { data, isLoading, error } = useTwoFactorStatus()
  const enabled = !!data?.enabled

  const [setupOpen, setSetupOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)
  const [regenOpen, setRegenOpen] = useState(false)

  const { data: waStatus } = useWebAuthnStatus()
  const { data: waCreds } = useWebAuthnCredentials()
  // The backend `available` hint is a TLS-mode guess; window.isSecureContext is the real browser gate.
  const waUsable = !!waStatus?.available && window.isSecureContext
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: string; nickname: string } | null>(null)
  const removeMut = useRemoveWebAuthnCredential()
  const onRemovePasskey = async (id: string) => {
    try {
      await removeMut.mutateAsync(id)
      toast.success(t('security.passkey.removedToast'))
    } catch (err) {
      toast.error(formatApiError(err))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('security.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('security.desc')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Smartphone className="size-4" />
            {t('security.totp.title')}
            <Badge variant={enabled ? 'default' : 'outline'} className="ml-1">
              {enabled ? t('security.totp.on') : t('security.totp.off')}
            </Badge>
          </CardTitle>
          <CardDescription>{t('security.totp.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{formatApiError(error)}</p>
          ) : enabled ? (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t('security.totp.enabledAt')}{' '}
                  {data?.enabledAt ? <Timestamp value={data.enabledAt} /> : '—'}
                </span>
                <span>{t('security.totp.backupRemaining', { count: data?.backupCodesRemaining ?? 0 })}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setRegenOpen(true)}>
                  <KeyRound className="size-3.5" />
                  {t('security.totp.regenerate')}
                </Button>
                <Button variant="outline" size="sm" className="text-destructive" onClick={() => setDisableOpen(true)}>
                  <Lock className="size-3.5" />
                  {t('security.totp.disable')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('security.totp.notEnabledHint')}</p>
              <Button size="sm" className="self-start" onClick={() => setSetupOpen(true)}>
                <WandSparkles className="size-4" />
                {t('security.totp.enable')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <SetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
      <DisableDialog open={disableOpen} onOpenChange={setDisableOpen} />
      <RegenerateDialog open={regenOpen} onOpenChange={setRegenOpen} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className="size-4" />
            {t('security.passkey.title')}
            <Badge variant={waStatus?.enabled ? 'default' : 'outline'} className="ml-1">
              {waStatus?.enabled ? t('security.totp.on') : t('security.totp.off')}
            </Badge>
          </CardTitle>
          <CardDescription>{t('security.passkey.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!waUsable ? (
            <p className="text-sm text-muted-foreground">{t('security.passkey.notAvailable')}</p>
          ) : waCreds && waCreds.length > 0 ? (
            <>
              <ul className="flex flex-col divide-y">
                {waCreds.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                    <span className="font-medium">{c.nickname ?? c.id}</span>
                    <Badge variant="outline">
                      {c.backed ? t('security.passkey.backed') : t('security.passkey.single')}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {t('security.passkey.lastUsed', {
                        when: c.lastUsedAt ? <Timestamp value={c.lastUsedAt} /> : t('security.passkey.never'),
                      })}
                    </span>
                    <div className="ml-auto flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRenameTarget({ id: c.id, nickname: c.nickname ?? '' })}
                      >
                        {t('security.passkey.rename')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        disabled={removeMut.isPending}
                        onClick={() => onRemovePasskey(c.id)}
                      >
                        {t('security.passkey.remove')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <Button variant="outline" size="sm" className="self-start" onClick={() => setEnrollOpen(true)}>
                <Fingerprint className="size-3.5" />
                {t('security.passkey.add')}
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('security.passkey.empty')}</p>
              <Button size="sm" className="self-start" onClick={() => setEnrollOpen(true)}>
                <Fingerprint className="size-4" />
                {t('security.passkey.add')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <WebAuthnEnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} />
      <RenamePasskeyDialog target={renameTarget} onClose={() => setRenameTarget(null)} />
    </div>
  )
}

/** Enrollment wizard: scan QR → enter first code → backup codes revealed ONCE → forced re-login. */
function SetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const begin = useBeginTwoFactorSetup()
  const complete = useCompleteTwoFactorSetup()
  const [bundle, setBundle] = useState<TwoFactorSetupBundle | null>(null)
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)

  // Fetch the setup bundle when the dialog opens (and clear stale state on close).
  useEffect(() => {
    if (!open) return
    setBackupCodes(null)
    setCode('')
    setBundle(null)
    begin.mutate(undefined, {
      onSuccess: setBundle,
      onError: (e) => {
        toast.error(formatApiError(e))
        onOpenChange(false)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onVerify = async () => {
    if (!bundle || code.length !== 6) return
    try {
      const r = await complete.mutateAsync({ pendingToken: bundle.pendingToken, code })
      setBackupCodes(r.backupCodes)
      toast.success(t('security.totp.enabledToast'))
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Block closing while backup codes are on screen — they must be acknowledged first.
        if (!v && backupCodes) return
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('security.setup.title')}</DialogTitle>
          {!backupCodes && <DialogDescription>{t('security.setup.scanDesc')}</DialogDescription>}
        </DialogHeader>

        {backupCodes ? (
          <BackupCodesReveal codes={backupCodes} onDone={() => forceLogout()} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex justify-center">
              <div className="size-48 rounded-lg bg-white p-2">
                {bundle ? (
                  <QrCode value={bundle.otpauthUri} aria-label={t('security.setup.qrAlt')} />
                ) : (
                  <div className="flex size-full items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">{t('security.setup.manualKey')}</Label>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {bundle?.secret ?? '…'}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!bundle}
                  onClick={() => copy(bundle?.secret ?? '', t('common.copied'), t('common.copyFailed'))}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="setup-code" className="text-xs text-muted-foreground">
                {t('security.setup.codeLabel')}
              </Label>
              <Input
                id="setup-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="text-center font-mono text-lg tracking-[0.5em]"
                placeholder="000000"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={onVerify} disabled={complete.isPending || code.length !== 6}>
                {complete.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t('security.setup.enable')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Backup-code reveal — used by enable + regenerate. Shows the codes ONCE with copy/download, then the
 *  caller's onDone (enable → forceLogout; regenerate → close). */
function BackupCodesReveal({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('security.totp.backupWarning')}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 rounded-lg border p-3 font-mono text-sm">
        {codes.map((c) => (
          <span key={c} className="text-center">
            {c}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => copy(codes.join('\n'), t('common.copied'), t('common.copyFailed'))}>
          <Copy className="size-3.5" />
          {t('security.totp.copyAll')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => downloadCodes(codes)}>
          {t('security.totp.download')}
        </Button>
      </div>
      <DialogFooter>
        <Button onClick={onDone}>{t('security.totp.savedDone')}</Button>
      </DialogFooter>
    </div>
  )
}

/** Disable 2FA: current password + a live TOTP or backup code. */
function DisableDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const disable = useDisableTwoFactor()
  const [password, setPassword] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [code, setCode] = useState('')
  const [backupCode, setBackupCode] = useState('')

  const submit = async () => {
    try {
      await disable.mutateAsync({
        password,
        code: useBackup ? undefined : code.trim() || undefined,
        backupCode: useBackup ? backupCode.trim() || undefined : undefined,
      })
      toast.success(t('security.totp.disabledToast'))
      setPassword('')
      setCode('')
      setBackupCode('')
      onOpenChange(false)
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('security.disable.title')}</DialogTitle>
          <DialogDescription>{t('security.disable.desc')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="dis-pwd" className="text-xs text-muted-foreground">
              {t('login.password')}
            </Label>
            <Input
              id="dis-pwd"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {!useBackup ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="dis-code" className="text-xs text-muted-foreground">
                {t('login.code')}
              </Label>
              <Input
                id="dis-code"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="text-center font-mono text-lg tracking-[0.5em]"
                placeholder="000000"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <Label htmlFor="dis-backup" className="text-xs text-muted-foreground">
                {t('login.backupCode')}
              </Label>
              <Input
                id="dis-backup"
                value={backupCode}
                onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
                className="font-mono"
                placeholder="ABCD-EFGH-IJKL-MNOP"
              />
            </div>
          )}
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setUseBackup((v) => !v)}
          >
            {useBackup ? t('login.useAuthenticator') : t('login.useBackupCode')}
          </button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={submit} disabled={disable.isPending || !password}>
            {disable.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            {t('security.totp.disable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Regenerate backup codes: one live TOTP or backup code → new set revealed ONCE. */
function RegenerateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const regen = useRegenerateBackupCodes()
  const [useBackup, setUseBackup] = useState(false)
  const [code, setCode] = useState('')
  const [backupCode, setBackupCode] = useState('')
  const [newCodes, setNewCodes] = useState<string[] | null>(null)

  useEffect(() => {
    if (!open) {
      setNewCodes(null)
      setCode('')
      setBackupCode('')
    }
  }, [open])

  const submit = async () => {
    try {
      const r = await regen.mutateAsync({
        code: useBackup ? undefined : code.trim() || undefined,
        backupCode: useBackup ? backupCode.trim() || undefined : undefined,
      })
      setNewCodes(r.backupCodes)
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && newCodes) return; onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('security.regen.title')}</DialogTitle>
          {!newCodes && <DialogDescription>{t('security.regen.desc')}</DialogDescription>}
        </DialogHeader>
        {newCodes ? (
          <BackupCodesReveal codes={newCodes} onDone={() => onOpenChange(false)} />
        ) : (
          <div className="flex flex-col gap-3">
            {!useBackup ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="reg-code" className="text-xs text-muted-foreground">
                  {t('login.code')}
                </Label>
                <Input
                  id="reg-code"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="text-center font-mono text-lg tracking-[0.5em]"
                  placeholder="000000"
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <Label htmlFor="reg-backup" className="text-xs text-muted-foreground">
                  {t('login.backupCode')}
                </Label>
                <Input
                  id="reg-backup"
                  value={backupCode}
                  onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
                  className="font-mono"
                  placeholder="ABCD-EFGH-IJKL-MNOP"
                />
              </div>
            )}
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setUseBackup((v) => !v)}
            >
              {useBackup ? t('login.useAuthenticator') : t('login.useBackupCode')}
            </button>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={submit} disabled={regen.isPending}>
                {regen.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t('security.totp.regenerate')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

async function copy(text: string, okMsg: string, errMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(okMsg)
  } catch {
    toast.error(errMsg)
  }
}

function downloadCodes(codes: string[]): void {
  const blob = new Blob([`SOMS Admin — 2FA backup codes\n\n${codes.join('\n')}\n`], {
    type: 'text/plain',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'soms-admin-2fa-backup-codes.txt'
  a.click()
  URL.revokeObjectURL(url)
}

/** Passkey enrollment wizard: re-auth password (+ optional label) → browser platform prompt → credential
 *  saved. No forced re-login (a passkey is an additive factor; existing sessions stay valid). */
function WebAuthnEnrollDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const begin = useBeginWebAuthnRegistration()
  const complete = useCompleteWebAuthnRegistration()

  useEffect(() => {
    if (!open) {
      setPassword('')
      setNickname('')
    }
  }, [open])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const r = await begin.mutateAsync({ password, nickname: nickname.trim() || undefined })
      // The browser drives the platform authenticator; the backend generated the registration options.
      const credential = await startRegistration({ optionsJSON: r.options })
      await complete.mutateAsync({ pendingToken: r.pendingToken, registrationResponse: credential })
      toast.success(t('security.passkey.addedToast'))
      onOpenChange(false)
    } catch (err) {
      // The user dismissing the OS prompt is a DOMException (NotAllowedError/AbortError) — not an error.
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return
      toast.error(formatApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('security.passkey.add')}</DialogTitle>
          <DialogDescription>{t('security.passkey.reauthLabel')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="wa-password">{t('security.passkey.reauthLabel')}</Label>
            <Input
              id="wa-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="wa-nickname">{t('security.passkey.nicknameLabel')}</Label>
            <Input
              id="wa-nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={64}
              placeholder={t('security.passkey.nicknamePlaceholder')}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('security.passkey.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Rename a saved passkey (the target is null when closed). */
function RenamePasskeyDialog({
  target,
  onClose,
}: {
  target: { id: string; nickname: string } | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [nickname, setNickname] = useState('')
  const rename = useRenameWebAuthnCredential()

  useEffect(() => {
    if (target) setNickname(target.nickname)
  }, [target])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!target) return
    try {
      await rename.mutateAsync({ id: target.id, nickname: nickname.trim().slice(0, 64) })
      onClose()
    } catch (err) {
      toast.error(formatApiError(err))
    }
  }

  return (
    <Dialog
      open={!!target}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('security.passkey.rename')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={64} />
          <DialogFooter>
            <Button type="submit" disabled={rename.isPending}>
              {t('security.passkey.rename')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
