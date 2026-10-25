import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUserSessions } from '@/hooks/use-user-mutations';
import { SessionTable } from '@/routes/sessions/session-table';
import type { User } from '@/types/api';

export function SessionsDialog({
  user,
  onClose,
}: {
  user: User | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useUserSessions(user?.id ?? null);
  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {t('userSessions.title', { name: user?.account ?? '' })}
          </DialogTitle>
          <p className="text-sm leading-[20px] text-muted-foreground">
            {t('userDetail.sessionsDesc')}
          </p>
        </DialogHeader>
        <div className="max-h-[600px] overflow-auto">
          <SessionTable
            key={user?.id}
            sessions={data ?? []}
            loading={isLoading}
            error={error}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
