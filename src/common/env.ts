/**
 * Read a required environment variable; throw if missing.
 * Fail-fast: the service must not boot without its required config.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

/**
 * Read an optional integer env var with a default. Returns the default when unset, empty, or not a
 * positive integer. Tunables (e.g. pool sizing) shouldn't fail-fast the boot the way a missing
 * required secret does — an invalid value silently falls back to the safe default rather than taking
 * the service down.
 */
export function optionalIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return defaultValue;
  return n;
}
