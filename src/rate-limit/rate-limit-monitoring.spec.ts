import { describe, expect, it } from 'vitest';
import { rateLimitAdvice } from './rate-limit-monitoring.js';

const now = 2_000_000_000;

describe('rateLimitAdvice', () => {
  it('warns without enough or recent data', () => {
    expect(
      rateLimitAdvice({
        mode: 'shadow',
        evaluated: 10,
        wouldBlock: 0,
        blocked: 0,
        maxRetryAfterMs: 0,
        observationStartedAt: now - 31 * 60 * 1000,
        now,
      }).map((item) => item.code),
    ).toEqual(['insufficient-sample', 'stale']);
  });

  it('flags a high shadow ratio and long retry delay', () => {
    expect(
      rateLimitAdvice({
        mode: 'shadow',
        evaluated: 1_000,
        wouldBlock: 100,
        blocked: 0,
        maxRetryAfterMs: 30_000,
        lastActivityAt: now,
        observationStartedAt: now,
        now,
      }).map((item) => item.code),
    ).toEqual(['high-would-block', 'long-retry']);
  });

  it('marks a large low-hit shadow sample ready for human review', () => {
    expect(
      rateLimitAdvice({
        mode: 'shadow',
        evaluated: 2_000,
        wouldBlock: 5,
        blocked: 0,
        maxRetryAfterMs: 0,
        lastActivityAt: now,
        observationStartedAt: now,
        now,
      }).map((item) => item.code),
    ).toEqual(['review-ready']);
  });

  it('makes disabled policies visibly unsafe', () => {
    expect(
      rateLimitAdvice({
        mode: 'disabled',
        evaluated: 0,
        wouldBlock: 0,
        blocked: 0,
        maxRetryAfterMs: 0,
        observationStartedAt: now,
        now,
      })[0],
    ).toMatchObject({ code: 'disabled', level: 'critical' });
  });
});
