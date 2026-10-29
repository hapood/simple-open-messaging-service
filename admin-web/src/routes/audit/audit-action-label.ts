import type { TFunction } from 'i18next';
import type auditMessages from '@/locales/en/audit.json';

type KnownAction = keyof typeof auditMessages.actions;
export function auditActionLabel(t: TFunction, action: string): string {
  return t(`audit.actions.${action as KnownAction}`, { defaultValue: action });
}
