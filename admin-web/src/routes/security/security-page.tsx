import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { toast } from 'sonner';
import { request } from '@/api/client';
import { useTwoFactorStatus } from '@/hooks/use-two-factor';
import {
  useWebAuthnCredentials,
  useWebAuthnStatus,
} from '@/hooks/use-webauthn';
import { forceLogout } from '@/auth/force-logout';
import { formatApiError } from '@/lib/format-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { QrCode } from '@/components/common/qr-code';
import { Timestamp } from '@/components/common/timestamp';
import type {
  TwoFactorSetupBundle,
  WebAuthnLoginBegin,
  WebAuthnRegBegin,
} from '@/types/api';

type Action =
  | 'password'
  | 'totp-enable'
  | 'totp-disable'
  | 'backup-regenerate'
  | 'passkey-add'
  | 'passkey-remove';
interface Selection {
  action: Action;
  target?: string;
}
interface CurrentAccount {
  account: string;
  name: string;
  role: string;
  currentIp: string;
  createdAt: number;
  userAgent: string | null;
}

/** Security mutations require fresh password + an enrolled factor, and revoke all own sessions. */
export function SecurityPage() {
  const { t } = useTranslation();
  // Do not refetch after revocation while the one-time recovery codes are shown.
  const [selection, setSelection] = useState<Selection | null>(null);
  const current = useQuery({
    enabled: selection === null,
    queryKey: ['account-current'],
    queryFn: () => request<CurrentAccount>('/admin/account/current'),
    staleTime: 0,
  });
  const totp = useTwoFactorStatus(selection === null);
  const passkey = useWebAuthnStatus(selection === null);
  const credentials = useWebAuthnCredentials(selection === null);
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    nickname: string;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const ready = !!totp.data && !!passkey.data && !totp.error && !passkey.error;
  const labels: Record<Action, string> = {
    password: t('security.account.changePassword'),
    'totp-enable': t('security.totp.enable'),
    'totp-disable': t('security.totp.disable'),
    'backup-regenerate': t('security.totp.regenerate'),
    'passkey-add': t('security.passkey.add'),
    'passkey-remove': t('security.passkey.remove'),
  };
  return (
    <div className="flex flex-col gap-4 leading-[20px]">
      <h1 className="text-2xl font-semibold leading-[32px]">
        {t('security.title')}
      </h1>
      <Card>
        <CardHeader>
          <CardTitle>{t('security.account.current')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {current.isPending ? (
            <p>{t('common.loading')}</p>
          ) : current.error ? (
            <p role="alert">{formatApiError(current.error)}</p>
          ) : (
            current.data && (
              <>
                <p>
                  {current.data.account} · {current.data.role}
                </p>
                <p>
                  {t('security.account.ip')}:{' '}
                  <code>{current.data.currentIp}</code>
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('security.account.ipHint')}
                </p>
                <p>
                  {t('adminSessions.col.created')}:{' '}
                  <Timestamp value={current.data.createdAt} />
                </p>
                <p className="break-all text-sm">
                  {current.data.userAgent ?? '—'}
                </p>
              </>
            )
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('security.account.password')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <p>{t('security.account.logoutWarning')}</p>
          <Button
            disabled={!ready}
            onClick={() => setSelection({ action: 'password' })}
          >
            {labels.password}
          </Button>
        </CardContent>
      </Card>
      {(totp.error || passkey.error || credentials.error) && (
        <p role="alert">
          {formatApiError(totp.error ?? passkey.error ?? credentials.error)}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            {t('security.totp.title')} ·{' '}
            {totp.isPending
              ? t('common.loading')
              : totp.data?.enabled
                ? t('security.totp.on')
                : t('security.totp.off')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <p>{t('security.totp.desc')}</p>
          {totp.data?.enabled && (
            <p>
              {t('security.totp.backupRemaining', {
                count: totp.data.backupCodesRemaining,
              })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(totp.data?.enabled
              ? (['totp-disable', 'backup-regenerate'] as const)
              : (['totp-enable'] as const)
            ).map((action) => (
              <Button
                key={action}
                variant="outline"
                disabled={!ready}
                onClick={() => setSelection({ action })}
              >
                {labels[action]}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('security.passkey.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p>{t('security.passkey.desc')}</p>
          {!window.isSecureContext && (
            <p>{t('security.passkey.notAvailable')}</p>
          )}
          {credentials.data?.map((credential) => (
            <div
              key={credential.id}
              className="flex flex-wrap items-center gap-3 border-b py-2"
            >
              <span>{credential.nickname ?? credential.id}</span>
              <span className="text-sm">
                {credential.backed
                  ? t('security.passkey.backed')
                  : t('security.passkey.single')}
              </span>
              <span className="text-sm">
                {credential.lastUsedAt ? (
                  <Timestamp value={credential.lastUsedAt} />
                ) : (
                  t('security.passkey.never')
                )}
              </span>
              <Button
                variant="outline"
                onClick={() =>
                  setRenameTarget({
                    id: credential.id,
                    nickname: credential.nickname ?? '',
                  })
                }
              >
                {t('security.passkey.rename')}
              </Button>
              <Button
                variant="outline"
                disabled={!ready}
                onClick={() =>
                  setSelection({
                    action: 'passkey-remove',
                    target: credential.id,
                  })
                }
              >
                {labels['passkey-remove']}
              </Button>
            </div>
          ))}
          <Button
            className="self-start"
            disabled={
              !ready || !window.isSecureContext || !passkey.data?.available
            }
            onClick={() => setSelection({ action: 'passkey-add' })}
          >
            {labels['passkey-add']}
          </Button>
        </CardContent>
      </Card>
      {renameTarget && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !renaming) setRenameTarget(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('security.passkey.rename')}</DialogTitle>
            </DialogHeader>
            <form
              className="flex flex-col gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
                setRenaming(true);
                try {
                  await request(
                    `/admin/webauthn/credentials/${encodeURIComponent(renameTarget.id)}/rename`,
                    { nickname: renameTarget.nickname.trim() },
                  );
                  await credentials.refetch();
                  setRenameTarget(null);
                } catch (err) {
                  toast.error(formatApiError(err));
                } finally {
                  setRenaming(false);
                }
              }}
            >
              <Label htmlFor="rename-passkey">
                {t('security.passkey.nicknameLabel')}
              </Label>
              <Input
                id="rename-passkey"
                maxLength={64}
                value={renameTarget.nickname}
                onChange={(event) =>
                  setRenameTarget({
                    ...renameTarget,
                    nickname: event.target.value,
                  })
                }
              />
              <Button disabled={renaming}>
                {t('security.passkey.rename')}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {selection && (
        <SecurityMutation
          key={`${selection.action}:${selection.target ?? ''}`}
          selection={selection}
          title={labels[selection.action]}
          totp={!!totp.data?.enabled}
          passkey={!!passkey.data?.enabled}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}

function SecurityMutation({
  selection,
  title,
  totp,
  passkey,
  onClose,
}: {
  selection: Selection;
  title: string;
  totp: boolean;
  passkey: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [factor, setFactor] = useState<'totp' | 'backup' | 'passkey'>(
    totp ? 'totp' : 'passkey',
  );
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [bundle, setBundle] = useState<TwoFactorSetupBundle | null>(null);
  const [setupCode, setSetupCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { action, target } = selection;

  const completed = (result?: { backupCodes?: string[] }) => {
    setPassword('');
    setNewPassword('');
    setConfirmation('');
    setCode('');
    setBundle(null);
    if (result?.backupCodes) setBackupCodes(result.backupCodes);
    else {
      toast.success(t('security.account.changed'));
      forceLogout();
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (bundle) {
        completed(
          await request<{ backupCodes: string[] }>('/admin/2fa/setup/verify', {
            pendingToken: bundle.pendingToken,
            code: setupCode,
          }),
        );
        return;
      }
      if (
        action === 'password' &&
        (newPassword !== confirmation ||
          !/^[a-zA-Z0-9.@!#$%^&*()]{6,20}$/.test(newPassword))
      ) {
        setError(t('security.account.passwordHint'));
        return;
      }
      const proof: {
        password: string;
        code?: string;
        backupCode?: string;
        pendingToken?: string;
        assertionResponse?: unknown;
      } = { password };
      if (totp || passkey) {
        if (factor === 'passkey') {
          const challenge = await request<WebAuthnLoginBegin>(
            '/admin/account/assertion',
            { password, action, target: target ? Number(target) : undefined },
          );
          proof.assertionResponse = await startAuthentication({
            optionsJSON: challenge.options,
          });
          proof.pendingToken = challenge.pendingToken;
        } else if (factor === 'backup') proof.backupCode = code.trim();
        else proof.code = code.trim();
      }
      if (action === 'totp-enable') {
        setBundle(
          await request<TwoFactorSetupBundle>('/admin/2fa/setup', proof),
        );
        setPassword('');
        setCode('');
        return;
      }
      if (action === 'passkey-add') {
        const begin = await request<WebAuthnRegBegin>(
          '/admin/webauthn/registration/begin',
          { ...proof, nickname: nickname.trim() || undefined },
        );
        const registrationResponse = await startRegistration({
          optionsJSON: begin.options,
        });
        await request('/admin/webauthn/registration/finish', {
          pendingToken: begin.pendingToken,
          registrationResponse,
        });
        completed();
        return;
      }
      const route =
        action === 'password'
          ? '/admin/account/password'
          : action === 'totp-disable'
            ? '/admin/2fa/disable'
            : action === 'backup-regenerate'
              ? '/admin/2fa/backup/regenerate'
              : `/admin/webauthn/credentials/${encodeURIComponent(target!)}/delete`;
      completed(
        await request<{ backupCodes?: string[] }>(route, {
          ...proof,
          ...(action === 'password' ? { newPassword } : {}),
        }),
      );
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !backupCodes) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto leading-[20px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t('security.account.logoutWarning')}
          </DialogDescription>
        </DialogHeader>
        {backupCodes ? (
          <div className="flex flex-col gap-4">
            <p>{t('security.totp.backupWarning')}</p>
            <div className="grid grid-cols-2 gap-2 font-mono">
              {backupCodes.map((value) => (
                <span key={value}>{value}</span>
              ))}
            </div>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(backupCodes.join('\n'));
                  toast.success(t('common.copied'));
                } catch {
                  toast.error(t('common.copyFailed'));
                }
              }}
            >
              {t('security.totp.copyAll')}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([backupCodes.join('\n')], { type: 'text/plain' }),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = 'soms-admin-recovery-codes.txt';
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              {t('security.totp.download')}
            </Button>
            <Button onClick={() => forceLogout()}>
              {t('security.totp.savedDone')}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            {bundle ? (
              <>
                <p>{t('security.setup.scanDesc')}</p>
                <div className="size-48 self-center bg-white p-2">
                  <QrCode value={bundle.otpauthUri} />
                </div>
                <Label>{t('security.setup.manualKey')}</Label>
                <code className="break-all">{bundle.secret}</code>
                <Label htmlFor="setup-code">
                  {t('security.setup.codeLabel')}
                </Label>
                <Input
                  id="setup-code"
                  value={setupCode}
                  onChange={(e) =>
                    setSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                  pattern="[0-9]{6}"
                />
              </>
            ) : (
              <>
                <Label htmlFor="security-password">
                  {t('security.account.currentPassword')}
                </Label>
                <Input
                  id="security-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                {action === 'password' && (
                  <>
                    <Label htmlFor="new-password">
                      {t('security.account.newPassword')}
                    </Label>
                    <Input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                    />
                    <Label htmlFor="confirm-password">
                      {t('security.account.confirmPassword')}
                    </Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                      required
                    />
                    <p className="text-sm">
                      {t('security.account.passwordHint')}
                    </p>
                  </>
                )}
                {action === 'passkey-add' && (
                  <>
                    <Label htmlFor="nickname">
                      {t('security.passkey.nicknameLabel')}
                    </Label>
                    <Input
                      id="nickname"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      maxLength={64}
                    />
                  </>
                )}
                {(totp || passkey) && (
                  <>
                    <Label htmlFor="security-factor">
                      {t('security.account.factor')}
                    </Label>
                    <select
                      id="security-factor"
                      className="h-10 rounded-md border bg-background px-3 leading-[20px]"
                      value={factor}
                      onChange={(e) => {
                        setFactor(e.target.value as typeof factor);
                        setCode('');
                      }}
                    >
                      {totp && (
                        <>
                          <option value="totp">
                            {t('security.totp.title')}
                          </option>
                          <option value="backup">
                            {t('login.backupCode')}
                          </option>
                        </>
                      )}
                      {passkey && (
                        <option
                          value="passkey"
                          disabled={!window.isSecureContext}
                        >
                          {t('security.passkey.title')}
                        </option>
                      )}
                    </select>
                    {factor !== 'passkey' && (
                      <>
                        <Label htmlFor="security-code">
                          {factor === 'backup'
                            ? t('login.backupCode')
                            : t('login.code')}
                        </Label>
                        <Input
                          id="security-code"
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          autoComplete="one-time-code"
                          required
                        />
                      </>
                    )}
                    {factor === 'passkey' && !window.isSecureContext && (
                      <p role="alert">{t('security.passkey.notAvailable')}</p>
                    )}
                  </>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={
                busy ||
                (!bundle &&
                  (totp || passkey) &&
                  factor === 'passkey' &&
                  !window.isSecureContext)
              }
            >
              {busy ? t('common.loading') : title}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
