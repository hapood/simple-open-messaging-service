export const AUTO_TERMINATE_DAYS = [7, 30, 90, 180, 365] as const;
export type AutoTerminateDays = (typeof AUTO_TERMINATE_DAYS)[number];
export const DEFAULT_AUTO_TERMINATE_DAYS: AutoTerminateDays = 30;
export const AUTO_TERMINATE_PREFERENCE_KEY = 'session.autoTerminateDays';

export function isAutoTerminateDays(
  value: unknown,
): value is AutoTerminateDays {
  return AUTO_TERMINATE_DAYS.some((days) => days === value);
}
