import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Plus, Search } from 'lucide-react'
import {
  useAdmins,
  useCreateAdmin,
  useDisableAdmin,
  useEnableAdmin,
  useResetAdminTwoFactor,
  useSetAdminRole,
} from '@/hooks/use-admins'
import { useMe } from '@/hooks/use-me'
import { useListParams } from '@/hooks/use-list-params'
import type { AdminAccount, AdminRole } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Pagination } from '@/components/common/pagination'
import { TableBodyState } from '@/components/common/table-state'
import { Timestamp } from '@/components/common/timestamp'
import { formatApiError } from '@/lib/format-error'

const PAGE_SIZE = 50
const ROLE_OPTIONS: AdminRole[] = ['SUPER_ADMIN', 'ADMIN', 'VIEWER']
const ROLE_SHORT: Record<AdminRole, 'super' | 'admin' | 'viewer'> = {
  SUPER_ADMIN: 'super',
  ADMIN: 'admin',
  VIEWER: 'viewer',
}

/** Admin self-management (super-admin only on the backend). Inline role Select + enable/disable;
 *  an Add dialog promotes an existing user. Disabling/demoting revokes the admin's sessions at once. */
export function AdminsPage() {
  const { t } = useTranslation()
  const { searchInput, setSearchInput, search, page, setPage, skip, take } = useListParams({
    pageSize: PAGE_SIZE,
  })
  const { data, isLoading, error } = useAdmins({ skip, take, search: search || undefined })
  const create = useCreateAdmin()
  const disable = useDisableAdmin()
  const enable = useEnableAdmin()
  const setRole = useSetAdminRole()
  const reset2fa = useResetAdminTwoFactor()
  const { data: me } = useMe()
  const isSuper = me?.role === 'SUPER_ADMIN'
  const [addOpen, setAddOpen] = useState(false)
  const [userId, setUserId] = useState('')
  const [newRole, setNewRole] = useState<AdminRole>('VIEWER')
  const [resetTarget, setResetTarget] = useState<AdminAccount | null>(null)

  const total = data?.total ?? 0
  const roleItems = {
    SUPER_ADMIN: t('roles.super'),
    ADMIN: t('roles.admin'),
    VIEWER: t('roles.viewer'),
  }

  const onRole = async (id: number, role: AdminRole) => {
    try {
      await setRole.mutateAsync({ id, role })
      toast.success(t('admins.toast.role'))
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  const onToggle = async (a: AdminAccount) => {
    try {
      if (a.enabled) {
        await disable.mutateAsync(a.id)
        toast.success(t('admins.toast.disabled'))
      } else {
        await enable.mutateAsync(a.id)
        toast.success(t('admins.toast.enabled'))
      }
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  const onAdd = async () => {
    const uid = Number(userId)
    if (!Number.isFinite(uid) || uid <= 0) return
    try {
      await create.mutateAsync({ userId: uid, role: newRole })
      toast.success(t('admins.toast.created'))
      setAddOpen(false)
      setUserId('')
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  const onReset2fa = async () => {
    if (!resetTarget) return
    try {
      await reset2fa.mutateAsync(resetTarget.id)
      toast.success(t('admins.toast.reset2fa'))
      setResetTarget(null)
    } catch (e) {
      toast.error(formatApiError(e))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('admins.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('admins.desc')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-60">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder={t('users.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-8"
            />
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {t('admins.add')}
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('admins.col.account')}</TableHead>
              <TableHead className="w-40">{t('admins.col.role')}</TableHead>
              <TableHead className="w-24">{t('admins.col.status')}</TableHead>
              <TableHead className="w-24">{t('admins.col.twoFactor')}</TableHead>
              <TableHead className="w-44">{t('admins.col.lastLogin')}</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={(data?.list.length ?? 0) === 0}
              colSpan={6}
              emptyMessage={t('admins.empty')}
            >
              {data?.list.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="font-medium">{a.name || a.account}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      #{a.userId} · {a.account}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={a.role}
                      onValueChange={(v) => onRole(a.id, v as AdminRole)}
                      items={roleItems}
                    >
                      <SelectTrigger size="sm" className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {t(`roles.${ROLE_SHORT[r]}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {a.enabled ? (
                      <Badge variant="secondary">{t('users.status.active')}</Badge>
                    ) : (
                      <Badge variant="destructive">{t('users.status.banned')}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={a.twoFactorEnabled ? 'default' : 'outline'}>
                      {t(`security.totp.${a.twoFactorEnabled ? 'on' : 'off'}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {a.lastLoginAt ? <Timestamp value={a.lastLoginAt} /> : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className={a.enabled ? 'text-destructive' : undefined}
                        disabled={disable.isPending || enable.isPending}
                        onClick={() => onToggle(a)}
                      >
                        {a.enabled ? t('admins.action.disable') : t('admins.action.enable')}
                      </Button>
                      {isSuper && a.twoFactorEnabled && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={reset2fa.isPending}
                          onClick={() => setResetTarget(a)}
                        >
                          {reset2fa.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                          {t('admins.action.reset2fa')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end text-sm text-muted-foreground">
        <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admins.addTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm">{t('admins.userIdLabel')}</label>
              <Input
                type="number"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="42"
              />
              <p className="text-xs text-muted-foreground">{t('admins.userIdHint')}</p>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm">{t('admins.roleLabel')}</label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as AdminRole)} items={roleItems}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${ROLE_SHORT[r]}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={create.isPending} onClick={() => setAddOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={create.isPending || !userId} onClick={onAdd}>
              {create.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('admins.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resetTarget} onOpenChange={(v) => !v && setResetTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admins.action.reset2fa')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('admins.reset2faConfirm', { name: resetTarget?.name || resetTarget?.account })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={onReset2fa} disabled={reset2fa.isPending}>
              {reset2fa.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('admins.action.reset2fa')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
