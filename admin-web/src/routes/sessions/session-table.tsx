import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useIsAdminPlus } from '@/hooks/use-me';
import { useRevokeSession } from '@/hooks/use-sessions';
import { formatApiError } from '@/lib/format-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableBodyState } from '@/components/common/table-state';
import { Timestamp } from '@/components/common/timestamp';
import type { Session } from '@/types/api';

type SessionRow = Session & {
  userId?: number;
  user?: { id: number; account: string } | null;
};

/** Shared credential view for the global list, user detail, and quick-view dialog. */
export function SessionTable({
  sessions,
  loading = false,
  error,
  showUser = false,
}: {
  sessions: SessionRow[];
  loading?: boolean;
  error?: unknown;
  showUser?: boolean;
}) {
  const { t } = useTranslation();
  const canManage = useIsAdminPlus();
  const revoke = useRevokeSession();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const onRevoke = async (id: number) => {
    try {
      await revoke.mutateAsync(id);
      setConfirmingId(null);
      toast.success(t('userSessions.revoked'));
    } catch (error) {
      toast.error(formatApiError(error));
    }
  };
  return (
    <div className="overflow-x-auto rounded-md border text-sm leading-[20px]">
      <Table>
        <TableHeader>
          <TableRow>
            {showUser && <TableHead>{t('sessions.col.user')}</TableHead>}
            <TableHead>{t('userSessions.col.device')}</TableHead>
            <TableHead>{t('userSessions.col.client')}</TableHead>
            <TableHead>{t('userSessions.col.ua')}</TableHead>
            <TableHead>{t('userSessions.col.ip')}</TableHead>
            <TableHead>{t('userSessions.col.lastIp')}</TableHead>
            <TableHead>{t('userSessions.col.created')}</TableHead>
            <TableHead>{t('userSessions.col.lastActive')}</TableHead>
            <TableHead>{t('userSessions.col.inactivity')}</TableHead>
            <TableHead>{t('userSessions.col.expires')}</TableHead>
            {canManage && <TableHead>{t('userSessions.revoke')}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableBodyState
            loading={loading}
            error={error}
            empty={sessions.length === 0}
            colSpan={9 + Number(showUser) + Number(canManage)}
            emptyMessage={t('userSessions.empty')}
          >
            {sessions.map((session) => (
              <TableRow key={session.id}>
                {showUser && (
                  <TableCell>
                    <Link
                      className="font-medium hover:underline"
                      to={`/users/${session.userId}`}
                    >
                      {session.user?.account ?? `#${session.userId}`}
                    </Link>
                  </TableCell>
                )}
                <TableCell>{session.device ?? '—'}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant="secondary">
                      {t(`common.client.${session.client}`, {
                        defaultValue: session.client,
                      })}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell
                  className="max-w-[280px] truncate text-xs leading-[16px] text-muted-foreground"
                  title={session.userAgent ?? ''}
                >
                  {session.userAgent ?? '—'}
                </TableCell>
                <TableCell className="font-mono text-xs leading-[16px]">
                  {session.ip ?? '—'}
                </TableCell>
                <TableCell className="font-mono text-xs leading-[16px]">
                  {session.lastSeenIp ?? '—'}
                </TableCell>
                <TableCell>
                  <Timestamp value={session.createdAt} />
                </TableCell>
                <TableCell>
                  <Timestamp value={session.lastSeenAt} />
                </TableCell>
                <TableCell>
                  {t('userSessions.inactivityDays', {
                    count: session.autoTerminateDays,
                  })}
                </TableCell>
                <TableCell>
                  <Timestamp value={session.expiresAt} />
                </TableCell>
                {canManage && (
                  <TableCell>
                    {confirmingId === session.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={revoke.isPending}
                          onClick={() => setConfirmingId(null)}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={revoke.isPending}
                          onClick={() => void onRevoke(session.id)}
                        >
                          {t('userSessions.confirmRevoke')}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        disabled={revoke.isPending}
                        onClick={() => setConfirmingId(session.id)}
                      >
                        {t('userSessions.revoke')}
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBodyState>
        </TableBody>
      </Table>
    </div>
  );
}
