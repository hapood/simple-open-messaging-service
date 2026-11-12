import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  useDisableAdmin,
  useEnableAdmin,
  useResetAdminTwoFactor,
  useSetAdminRole,
} from '@/hooks/use-admins';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatApiError } from '@/lib/format-error';
import type { User, AdminRole } from '@/types/api';

export type AdminAccessTarget = {
  user: User;
  action: 'role' | 'toggle' | 'reset';
};
export function AdminAccessDialog({
  target,
  onClose,
}: {
  target: AdminAccessTarget | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const setRole = useSetAdminRole();
  const disable = useDisableAdmin();
  const enable = useEnableAdmin();
  const reset = useResetAdminTwoFactor();
  const [role, setSelectedRole] = useState<AdminRole>(
    target?.user.adminRole === 'ADMIN' ? 'ADMIN' : 'VIEWER',
  );
  const pending =
    setRole.isPending ||
    disable.isPending ||
    enable.isPending ||
    reset.isPending;
  const actionKey =
    target?.action === 'role'
      ? 'admins.action.setRole'
      : target?.action === 'reset'
        ? 'admins.action.reset2fa'
        : target?.user.adminEnabled
          ? 'admins.action.disable'
          : 'admins.action.enable';
  const submit = async () => {
    if (!target?.user.adminId || target.user.adminRole === 'SUPER_ADMIN')
      return;
    try {
      if (target.action === 'role')
        await setRole.mutateAsync({ id: target.user.adminId, role });
      else if (target.action === 'reset')
        await reset.mutateAsync(target.user.adminId);
      else if (target.user.adminEnabled)
        await disable.mutateAsync(target.user.adminId);
      else await enable.mutateAsync(target.user.adminId);
      toast.success(
        t(
          target.action === 'role'
            ? 'admins.toast.role'
            : target.action === 'reset'
              ? 'admins.toast.reset2fa'
              : target.user.adminEnabled
                ? 'admins.toast.disabled'
                : 'admins.toast.enabled',
        ),
      );
      onClose();
    } catch (error) {
      toast.error(formatApiError(error));
    }
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && !pending && onClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(actionKey)}</DialogTitle>
        </DialogHeader>
        <p className="text-sm leading-[20px]">
          {t(
            target?.action === 'role'
              ? 'admins.roleConfirm'
              : target?.action === 'reset'
                ? 'admins.reset2faConfirm'
                : 'users.adminAccessConfirm',
            { account: target?.user.account, name: target?.user.account },
          )}
        </p>
        {target?.action === 'role' && (
          <label className="flex flex-col gap-2 text-sm leading-[20px]">
            {t('admins.roleLabel')}
            <select
              className="h-9 rounded-md border bg-background px-3 leading-[20px]"
              value={role}
              disabled={pending}
              onChange={(event) =>
                setSelectedRole(event.target.value as AdminRole)
              }
            >
              <option value="VIEWER">{t('roles.viewer')}</option>
              <option value="ADMIN">{t('roles.admin')}</option>
            </select>
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={
              pending ||
              (target?.action === 'role' && role === target.user.adminRole)
            }
            onClick={() => void submit()}
          >
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
