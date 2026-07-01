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
