import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { useUserDetail } from '@/hooks/use-user-detail'
import { useIsSuperAdmin } from '@/hooks/use-me'
import { useDisableUser, useEnableUser, useForceLogoutUser } from '@/hooks/use-user-mutations'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'
import { ResetPasswordDialog } from './reset-password-dialog'

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  )
}

/** User 360° view. The list row's account links here; the row's quick-action dropdown stays on the
 *  list, but the full action set lives in this header (incl. reset-password, super-admin gated). */
export function UserDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const userId = id ? Number(id) : null
  const { data, isLoading, error } = useUserDetail(userId)
  const isSuper = useIsSuperAdmin()
  const disable = useDisableUser()
  const enable = useEnableUser()
  const forceLogout = useForceLogoutUser()
  const [resetOpen, setResetOpen] = useState(false)

  const onAction = async (m: { mutateAsync: (id: number) => Promise<void> }, msg: string) => {
    if (userId === null) return
    try {
      await m.mutateAsync(userId)
      toast.success(msg)
    } catch {
      /* Global mutation onError already shows a toast. */
    }
  }

  const u = data?.user
  const handle = u ? `${u.account}${u.domain && u.domain !== 'local' ? `@${u.domain}` : ''}` : ''

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
              <h1 className="text-2xl font-semibold tracking-tight">{u.name || u.account}</h1>
              {u.isDeleted ? (
                <Badge variant="destructive">{t('users.status.banned')}</Badge>
              ) : (
                <Badge variant="secondary">{t('users.status.active')}</Badge>
              )}
              <span className="font-mono text-xs text-muted-foreground">@{handle}</span>
            </div>
            <div className="flex items-center gap-2">
              {u.isDeleted ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={enable.isPending}
                  onClick={() => onAction(enable, t('users.toast.unbanned'))}
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
                onClick={() => onAction(forceLogout, t('users.toast.forceLoggedOut'))}
              >
                {t('users.action.forceLogout')}
              </Button>
              {isSuper ? (
                <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
                  {t('users.action.resetPassword')}
                </Button>
              ) : null}
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t('userDetail.section.profile')}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
              <Field label={t('userDetail.field.domain')} value={u.domain ?? '—'} />
              <Field
                label={t('userDetail.field.foreigner')}
                value={u.isForeigner ? t('common.yes') : t('common.no')}
              />
              <Field label={t('userDetail.field.tokenVer')} value={String(u.tokenVersion)} />
              <Field label={t('userDetail.field.createdAt')} value={<Timestamp value={u.createdAt} />} />
              <Field label={t('userDetail.field.updatedAt')} value={<Timestamp value={u.updatedAt} />} />
              <div className="col-span-2 md:col-span-3">
                <div className="text-muted-foreground">{t('userDetail.field.bio')}</div>
                <div className="mt-0.5">{u.bio || '—'}</div>
              </div>
            </CardContent>
          </Card>

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
                      <TableHead className="w-28">{t('userDetail.group.role')}</TableHead>
                      <TableHead className="w-44">{t('userDetail.group.joined')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.groups.map((g) => (
                      <TableRow key={g.threadId}>
                        <TableCell className="font-medium">
                          {g.thread.groupUser?.name ??
                            g.thread.groupUser?.account ??
                            `#${g.threadId}`}
                        </TableCell>
                        <TableCell>
                          {g.role ? <Badge variant="outline">{g.role}</Badge> : '—'}
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
              <CardTitle>{t('userDetail.section.sessions')}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.sessions.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t('userDetail.empty.sessions')}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('userSessions.col.device')}</TableHead>
                      <TableHead>{t('userSessions.col.ua')}</TableHead>
                      <TableHead>{t('userSessions.col.ip')}</TableHead>
                      <TableHead>{t('userSessions.col.created')}</TableHead>
                      <TableHead>{t('userSessions.col.expires')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.sessions.map((s) => (
                      <TableRow key={s.jti}>
                        <TableCell>{s.device ?? '—'}</TableCell>
                        <TableCell
                          className="max-w-[280px] truncate text-xs text-muted-foreground"
                          title={s.userAgent ?? ''}
                        >
                          {s.userAgent ?? '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{s.ip ?? '—'}</TableCell>
                        <TableCell>
                          <Timestamp value={s.createdAt} />
                        </TableCell>
                        <TableCell>
                          <Timestamp value={s.expiresAt} />
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
              <CardTitle>{t('userDetail.section.push')}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.pushTokens.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t('userDetail.empty.push')}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-32">{t('push.col.platform')}</TableHead>
                      <TableHead>{t('userDetail.push.deviceId')}</TableHead>
                      <TableHead className="w-44">{t('push.col.lastSeen')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.pushTokens.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Badge variant="secondary">{t(`push.platform.${p.platform}`)}</Badge>
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

      <ResetPasswordDialog
        user={resetOpen && u ? { id: u.id, account: u.account } : null}
        onClose={() => setResetOpen(false)}
      />
    </div>
  )
}
