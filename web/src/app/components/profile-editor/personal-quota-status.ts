import type { PersonalQuotaState } from '../../services/model';

export type PersonalQuotaStatus =
  | 'healthy'
  | 'warning'
  | 'exhausted'
  | 'disabled';

export function personalQuotaStatus(
  state: PersonalQuotaState,
): PersonalQuotaStatus {
  const active = Object.values(state.usage).filter(({ limit }) => limit > 0);
  if (active.length === 0) return 'disabled';
  if (active.some(({ count, limit }) => count >= limit)) return 'exhausted';
  if (active.some(({ count, limit }) => count / limit >= 0.8)) return 'warning';
  return 'healthy';
}
