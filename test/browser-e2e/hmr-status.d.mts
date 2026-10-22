export function requireHmrFrontend(options?: {
  maximumAgeMs?: number;
}): Promise<Record<'web' | 'admin', Record<string, unknown>>>;
