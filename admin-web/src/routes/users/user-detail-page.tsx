import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { useUserDetail } from '@/hooks/use-user-detail';
import { useIsAdminPlus, useMe } from '@/hooks/use-me';
import { usePublicConfig } from '@/hooks/use-public-config';
import { isPasswordLoginEnabled } from '@/lib/constants';
import {
  useDisableUser,
  useEnableUser,
  useForceLogoutUser,
} from '@/hooks/use-user-mutations';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Timestamp } from '@/components/common/timestamp';
import { formatApiError } from '@/lib/format-error';
import { IssueLoginCodeDialog } from './issue-login-code-dialog';
import { GenerateInitialPasswordDialog } from './generate-initial-password-dialog';
import { LoginCodesSection } from './login-codes-section';
import { UserQuotaPanel } from './user-quota-panel';
import { SessionTable } from '@/routes/sessions/session-table';
import { UserAccessStatus } from './user-access-status';

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}

/** User 360° view. The list row's account links here; the row's quick-action dropdown stays on the
 *  list, but the full action set lives in this header (issue login code / generate initial password,
 *  admin-plus gated) and the login-code audit trail is a section below. */
export function UserDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const userId = id ? Number(id) : null;
  const { data, isLoading, error } = useUserDetail(userId);
  const canManage = useIsAdminPlus();
  const { data: publicConfig } = usePublicConfig();
  // Password bootstrap only exists when the deployment's loginMode includes password login; the
  // backend refuses LOGIN_METHOD_DISABLED otherwise, so the affordance disables instead of erroring.
  const passwordLoginEnabled = publicConfig
    ? isPasswordLoginEnabled(publicConfig.loginMode)
    : false;
  const disable = useDisableUser();
  const enable = useEnableUser();
  const forceLogout = useForceLogoutUser();
  const [dlg, setDlg] = useState<null | { kind: 'issue' | 'genpwd' }>(null);

  const onAction = async (
    m: { mutateAsync: (id: number) => Promise<void> },
    msg: string,
  ) => {
    if (userId === null) return;
    try {
      await m.mutateAsync(userId);
      toast.success(msg);
    } catch {
      /* Global mutation onError already shows a toast. */
    }
  };

  const u = data?.user;
  // The handle pairs the local account with the node domain from the /admin/me cache — the detail
  // payload itself carries no domain, and the users are all local persons.
  const { data: me } = useMe();
  const handle =
    u && me?.somsDomain ? `${u.account}@${me.somsDomain}` : (u?.account ?? '');
  const appSessionCount = data
    ? data.sessions.filter((s) => s.client === 'app').length
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/users"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('userDetail.back')}
      </Link>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {t('common.loadFailed', { message: formatApiError(error) })}
        </div>
      ) : !data || !u ? (
        <div className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
          {t('userDetail.notFound')}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                {u.name || u.account}
              </h1>
              {u.isDeleted ? (
                <Badge variant="destructive">{t('users.status.banned')}</Badge>
              ) : (
                <Badge variant="secondary">{t('users.status.active')}</Badge>
              )}
              <span className="font-mono text-xs text-muted-foreground">
                @{handle}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {canManage && u.namespaceId === 0 && !u.adminRole ? (
                <>
                  {u.isDeleted ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={enable.isPending}
                      onClick={() =>
                        onAction(enable, t('users.toast.unbanned'))
                      }
                    >
                      {t('users.action.unban')}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive"
                      disabled={disable.isPending}
                      onClick={() => onAction(disable, t('users.toast.banned'))}
                    >
                      {t('users.action.ban')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={forceLogout.isPending}
                    onClick={() =>
                      onAction(forceLogout, t('users.toast.forceLoggedOut'))
                    }
                  >
                    {t('users.action.forceLogout')}
                  </Button>
                  {!u.isDeleted ? (
                    <Button
                      aria-controls="issue-login-code-dialog"
                      aria-haspopup="dialog"
                      aria-expanded={dlg?.kind === 'issue'}
                      variant="outline"
                      size="sm"
                      onClick={() => setDlg({ kind: 'issue' })}
                    >
                      {t('users.action.issueLoginCode')}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!passwordLoginEnabled}
                    onClick={() => setDlg({ kind: 'genpwd' })}
                  >
                    {t('users.action.generateInitialPassword')}
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t('userDetail.section.profile')}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
              <Field
                label={t('userDetail.field.createdAt')}
                value={<Timestamp value={u.createdAt} />}
              />
              <Field
                label={t('userDetail.field.updatedAt')}
                value={<Timestamp value={u.updatedAt} />}
              />
              <div className="col-span-2 md:col-span-3">
                <div className="text-muted-foreground">
                  {t('userDetail.field.bio')}
                </div>
                <div className="mt-0.5">{u.bio || '—'}</div>
              </div>
            </CardContent>
          </Card>

          {u.adminRole && (
            <Card>
              <CardHeader>
                <CardTitle>{t('userDetail.adminAccess')}</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 text-sm leading-[20px] sm:grid-cols-2">
                <Field
                  label={t('users.backendRole')}
                  value={t(
                    u.adminRole === 'SUPER_ADMIN'
                      ? 'roles.super'
                      : u.adminRole === 'ADMIN'
                        ? 'roles.admin'
                        : 'roles.viewer',
                  )}
                />
                <Field
                  label={t('userDetail.adminAccess')}
                  value={t(
                    u.adminEnabled
                      ? 'userDetail.adminEnabled'
                      : 'users.adminAccessDisabled',
                  )}
                />
                <Field
                  label={t('userDetail.adminAuthenticator')}
                  value={t(
                    u.adminTwoFactorEnabled
                      ? 'security.totp.on'
                      : 'security.totp.off',
                  )}
                />
                <Field
                  label={t('userDetail.adminLastLogin')}
                  value={
                    u.adminLastLoginAt !== null ? (
                      <Timestamp value={u.adminLastLoginAt} />
                    ) : (
                      '—'
                    )
                  }
                />
              </CardContent>
            </Card>
          )}

          {userId !== null && (
            <UserAccessStatus
              userId={userId}
              account={u.account}
              disabled={u.isDeleted}
              pushRegistrations={data.pushTokens.length}
            />
          )}

          {u.namespaceId === 0 && userId !== null ? (
            <UserQuotaPanel userId={userId} canManage={canManage} />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t('userDetail.section.groups')}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.groups.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t('userDetail.empty.groups')}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('userDetail.group.name')}</TableHead>
                      <TableHead className="w-28">
                        {t('userDetail.group.role')}
                      </TableHead>
                      <TableHead className="w-44">
                        {t('userDetail.group.joined')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.groups.map((g) => (
                      <TableRow key={g.threadId}>
                        <TableCell className="font-medium">
                          {g.thread.group?.name ??
                            g.thread.group?.account ??
                            `#${g.threadId}`}
                        </TableCell>
                        <TableCell>
                          {g.role ? (
                            <Badge variant="outline">{g.role}</Badge>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell>
                          <Timestamp value={g.joinedAt} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle>{t('userDetail.section.sessions')}</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {t('userSessions.appCount', { count: appSessionCount })}
                </span>
              </div>
              <p className="text-sm leading-[20px] text-muted-foreground">
                {t('userDetail.sessionsDesc')}
              </p>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex gap-4 text-sm leading-[20px]">
                <Link
                  className="hover:underline"
                  to={`/sessions?userId=${userId}`}
                >
                  {t('userSessions.viewAll')}
                </Link>
                <Link
                  className="hover:underline"
                  to={`/connections?userId=${userId}`}
                >
                  {t('nav.connections')}
                </Link>
              </div>
              <SessionTable key={userId} sessions={data.sessions} />
            </CardContent>
          </Card>

          {u.namespaceId === 0 && userId !== null ? (
            <LoginCodesSection userId={userId} />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t('userDetail.section.push')}</CardTitle>
              <p className="text-sm leading-[20px] text-muted-foreground">
                {t('userDetail.push.desc')}
              </p>
            </CardHeader>
            <CardContent>
              {data.pushTokens.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t('userDetail.empty.push')}
                  <span className="mt-2 block leading-[20px]">
                    {t('userDetail.push.emptyHint')}
                  </span>
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32">
                        {t('push.col.platform')}
                      </TableHead>
                      <TableHead>{t('userDetail.push.deviceId')}</TableHead>
                      <TableHead className="w-44">
                        {t('push.col.lastSeen')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.pushTokens.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Badge variant="secondary">
                            {t(`push.platform.${p.platform}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {p.deviceId ?? '—'}
                        </TableCell>
                        <TableCell>
                          <Timestamp value={p.lastSeenAt} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <IssueLoginCodeDialog
        user={
          dlg?.kind === 'issue' && u ? { id: u.id, account: u.account } : null
        }
        onClose={() => setDlg(null)}
      />
      <GenerateInitialPasswordDialog
        user={
          dlg?.kind === 'genpwd' && u ? { id: u.id, account: u.account } : null
        }
        onClose={() => setDlg(null)}
      />
    </div>
  );
}
