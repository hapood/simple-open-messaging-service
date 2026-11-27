import { isSessionSupersededError } from './session-identity';

function isLocalCacheCorruptionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'localCacheCorruption' in error &&
    error.localCacheCorruption === true
  );
}

/** Only structural local-database damage may authorize destructive startup recovery. */
export class DatabaseRestorationError extends Error {
  constructor(cause: unknown) {
    super('Session database restoration failed', { cause });
    this.name = 'DatabaseRestorationError';
  }
}

export function isDatabaseRestorationError(
  error: unknown,
): boolean {
  return (
    error instanceof DatabaseRestorationError ||
    isLocalCacheCorruptionError(error) ||
    (typeof error === 'string' && error.startsWith('SESSION_DATABASE_ERROR:'))
  );
}

/** Promote only classified database damage. Transport, permission and absence stay unchanged. */
export async function restoringDatabase<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isSessionSupersededError(error) || error instanceof DatabaseRestorationError)
      throw error;
    if (isLocalCacheCorruptionError(error))
      throw new DatabaseRestorationError(error);
    if (
      typeof error === 'string' &&
      error.startsWith('SESSION_DATABASE_ERROR:')
    )
      throw new DatabaseRestorationError(error);
    throw error;
  }
}
