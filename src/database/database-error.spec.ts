import { describe, expect, it } from 'vitest';
import {
  isRetryableTransactionError,
  isUniqueViolation,
} from './database-error.js';

function postgresError(code: string): Error & { code: string } {
  return Object.assign(new Error(`PostgreSQL ${code}`), { code });
}

describe('database error classification', () => {
  it('recognizes a unique violation through Drizzle cause wrappers', () => {
    const wrapped = new Error('query failed', {
      cause: postgresError('23505'),
    });

    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(new Error('query failed'))).toBe(false);
  });

  it.each(['40001', '40P01'])(
    'recognizes retryable transaction code %s through cause wrappers',
    (code) => {
      const wrapped = new Error('transaction failed', {
        cause: new Error('query failed', { cause: postgresError(code) }),
      });

      expect(isRetryableTransactionError(wrapped)).toBe(true);
    },
  );

  it('does not classify permanent PostgreSQL errors as retryable', () => {
    expect(isRetryableTransactionError(postgresError('23503'))).toBe(false);
  });
});
