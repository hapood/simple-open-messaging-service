export function otpKey(node: string, account: string): string;
export function redactSecrets(
  value: unknown,
  secrets: Iterable<string>,
): string;
