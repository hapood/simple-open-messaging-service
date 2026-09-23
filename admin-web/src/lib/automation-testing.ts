declare const __AUTOMATION_TESTING__: boolean;

export function automationTestId(value: string): Record<string, string> {
  return __AUTOMATION_TESTING__ ? { 'data-testid': value } : {};
}
