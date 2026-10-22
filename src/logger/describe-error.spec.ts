import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { Logger as NestPinoLogger } from 'nestjs-pino';
import { describeError } from './describe-error.js';

function record(error: unknown) {
  let output = '';
  const logger = pino(
    { level: 'warn' },
    {
      write: (line: string) => {
        output += line;
      },
    },
  );
  const adapter = new NestPinoLogger(logger as never, {});
  adapter.warn(
    { msg: 'Federation request failed', error: describeError(error) },
    'UserController',
  );
  return JSON.parse(output);
}

describe('transport error diagnostics through Nest-Pino serialization', () => {
  it.each([
    'UND_ERR_DESTROYED',
    'UND_ERR_CONNECT_TIMEOUT',
    'ENOTFOUND',
    'CERT_HAS_EXPIRED',
  ])('preserves the nested %s error', (code) => {
    const cause = Object.assign(new Error('underlying failure'), { code });
    const row = record(new TypeError('fetch failed', { cause }));
    expect(row.msg).toBe('Federation request failed');
    expect(row.context).toBe('UserController');
    expect(row.error.message).toBe('fetch failed');
    expect(row.error.cause.code).toBe(code);
    expect(row.error.cause.stack).toContain('underlying failure');
  });
  it('preserves aggregate failures and bounds circular error chains', () => {
    const e = new Error('cycle');
    e.cause = e;
    const row = record(
      new AggregateError([e, new Error('other')], 'multiple failures'),
    );
    expect(row.error.errors[0].cause.circular).toBe(true);
    expect(row.error.errors[1].message).toBe('other');
  });
  it('does not copy credentials or arbitrary transport objects', () => {
    const error = Object.assign(
      new Error(
        'request https://user:credential@example.test/a?token=private failed',
      ),
      {
        headers: { authorization: 'private-header' },
        body: { password: 'private-password' },
      },
    );
    const serialized = JSON.stringify(record(error));
    for (const secret of [
      'credential',
      'private-header',
      'private-password',
      '=private',
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });
  it('bounds depth and accepts non-error thrown values', () => {
    let error = new Error('root');
    for (let i = 0; i < 20; i++) error = new Error('wrapper', { cause: error });
    expect(JSON.stringify(record(error))).toContain('truncated');
    expect(record({ password: 'secret-value' }).error.message).toBe(
      'Non-error value thrown',
    );
    expect(record('simple failure').error.message).toBe('simple failure');
  });
});
