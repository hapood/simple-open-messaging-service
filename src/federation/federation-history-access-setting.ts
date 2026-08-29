export const FEDERATION_HISTORY_ACCESS_SETTING_KEY =
  'federation:audience:historyAccessEnabled';

export function federationHistoryAccessEnabled(
  storedValue: string | undefined,
): boolean {
  return storedValue !== 'false';
}
