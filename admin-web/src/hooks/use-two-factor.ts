import { useQuery } from '@tanstack/react-query';
import { getTwoFactorStatus } from '@/api/two-factor';

/** Pause while revealing recovery codes: successful security mutations revoke this session. */
export function useTwoFactorStatus(enabled = true) {
  return useQuery({
    queryKey: ['admin', '2fa', 'status'],
    queryFn: getTwoFactorStatus,
    enabled,
  });
}
