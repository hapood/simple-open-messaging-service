import { describe, expect, it } from 'vitest';
import {
  safeUnexpectedTaskError,
  unexpectedTaskDiagnostics,
} from './durable-task-error.js';

describe('safeUnexpectedTaskError', () => {
  it('reports a safe PostgreSQL code from a wrapped driver error', () => {
    const driverError = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
    });
    const wrapped = new Error('Failed query', { cause: driverError });

    expect(safeUnexpectedTaskError(wrapped)).toBe(
      'Unexpected task error (Error, code 40P01)',
    );
  });

  it('does not loop over a cyclic cause chain', () => {
    const error = new Error('cyclic') as Error & { cause?: unknown };
    error.cause = error;

    expect(safeUnexpectedTaskError(error)).toBe(
      'Unexpected task error (Error)',
    );
  });

  it('extracts a causal chain and detailed safe concurrency diagnostics', () => {
    const driverError = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
      detail: 'Process 10 waits for ShareLock; blocked by process 20.',
      where: 'while updating tuple in relation "Account"',
      table: 'Account',
      routine: 'DeadLockReport',
    });
    const wrapped = new Error('Failed query', { cause: driverError });

    expect(unexpectedTaskDiagnostics(wrapped)).toEqual({
      causes: [
        { name: 'Error', message: 'Failed query' },
        { name: 'Error', message: 'deadlock detected', code: '40P01' },
      ],
      database: {
        code: '40P01',
        detail: 'Process 10 waits for ShareLock; blocked by process 20.',
        where: 'while updating tuple in relation "Account"',
        table: 'Account',
        routine: 'DeadLockReport',
      },
    });
  });

  it('records non-database codes without treating them as PostgreSQL', () => {
    expect(
      unexpectedTaskDiagnostics(
        Object.assign(new Error('connection failed'), {
          code: 'ECONNRESET',
          detail: 'secret peer response',
        }),
      ),
    ).toEqual({
      causes: [
        { name: 'Error', message: 'connection failed', code: 'ECONNRESET' },
      ],
    });
  });

  it('omits value-bearing free text for constraint violations', () => {
    expect(
      unexpectedTaskDiagnostics(
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          detail: 'Key (account)=(secret) already exists.',
          table: 'Account',
          constraint: 'Account_account_key',
        }),
      ).database,
    ).toEqual({
      code: '23505',
      table: 'Account',
      constraint: 'Account_account_key',
    });
  });
});
