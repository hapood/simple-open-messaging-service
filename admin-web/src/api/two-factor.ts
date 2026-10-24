import { request } from '@/api/client';
import type { TwoFactorStatus } from '@/types/api';

export function getTwoFactorStatus(): Promise<TwoFactorStatus> {
  return request<TwoFactorStatus>('/admin/2fa/status');
}
