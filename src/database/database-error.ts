export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_NOT_NULL_VIOLATION = '23502';
export const PG_CHECK_VIOLATION = '23514';
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK_DETECTED = '40P01';

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

export function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_UNIQUE_VIOLATION;
}

export function isRetryableTransactionError(error: unknown): boolean {
  return (
    isPostgresError(error) &&
    (error.code === PG_SERIALIZATION_FAILURE ||
      error.code === PG_DEADLOCK_DETECTED)
  );
}
