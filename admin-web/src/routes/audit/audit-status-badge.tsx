import { useTranslation } from 'react-i18next';
import type { AuditStatus } from '@/api/audit';
import { Badge } from '@/components/ui/badge';

export function AuditStatusBadge({ status }: { status: AuditStatus }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant={
        status === 'FAILED'
          ? 'destructive'
          : status === 'SUCCEEDED'
            ? 'default'
            : 'outline'
      }
    >
      {t(`audit.status.${status}`)}
    </Badge>
  );
}
