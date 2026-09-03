export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_NOT_NULL_VIOLATION = '23502';
export const PG_CHECK_VIOLATION = '23514';
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK_DETECTED = '40P01';
export const PG_LOCK_NOT_AVAILABLE = '55P03';

export interface PostgresError extends Error {
  code: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
}

export function isPostgresError(error: unknown): error is PostgresError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** Drizzle may wrap the pg error in one or more Error.cause layers. */
export function hasPostgresErrorCode(error: unknown, code: string): boolean {
  return findPostgresError(error)?.code === code;
}

export function findPostgresError(error: unknown): PostgresError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (isPostgresError(current)) return current;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return hasPostgresErrorCode(error, PG_UNIQUE_VIOLATION);
}

export function isRetryableTransactionError(error: unknown): boolean {
  return (
    hasPostgresErrorCode(error, PG_SERIALIZATION_FAILURE) ||
    hasPostgresErrorCode(error, PG_DEADLOCK_DETECTED)
  );
}
