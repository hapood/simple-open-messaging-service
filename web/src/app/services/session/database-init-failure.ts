import { DatabaseRestorationError } from './database-restoration-error';

/** Local database initialization failures the user can rebuild or leave. */
export type DatabaseInitFailureKind = 'permission' | 'busy' | 'structural';

function errorText(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (typeof error === 'string') return { name: '', message: error };
  return { name: '', message: '' };
}

function isCorruption(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'localCacheCorruption' in error &&
    error.localCacheCorruption === true
  );
}

/** Permission, busy storage, and structural damage. Other failures are not restoration choices. */
export function classifyDatabaseInitFailure(
  error: unknown,
): DatabaseInitFailureKind | null {
  if (error instanceof DatabaseRestorationError) {
    return classifyDatabaseInitFailure(error.cause) ?? 'structural';
  }
  if (isCorruption(error)) return 'structural';
  const { name, message } = errorText(error);
  if (message.startsWith('SESSION_DATABASE_ERROR:')) return 'structural';
  if (
    name === 'SecurityError' ||
    name === 'NotAllowedError' ||
    /permission denied|access denied|not allowed/i.test(message)
  ) {
    return 'permission';
  }
  if (
    name === 'QuotaExceededError' ||
    /database is locked|sqlite_busy|storage busy|quota exceeded/i.test(message)
  ) {
    return 'busy';
  }
  return null;
}
