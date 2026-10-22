import { describe, expect, it } from 'vitest';
import { quotaSummaryStatus } from './user-quota.service.js';

describe('quotaSummaryStatus', () => {
  it('ignores disabled categories when an enabled category remains healthy', () => {
    expect(
      quotaSummaryStatus([
        { count: 0, limit: 0 },
        { count: 2, limit: 10 },
      ]),
    ).toBe('healthy');
  });

  it('gives exhausted usage priority over warning usage', () => {
    expect(
      quotaSummaryStatus([
        { count: 80, limit: 100 },
        { count: 10, limit: 10 },
      ]),
    ).toBe('exhausted');
  });

  it('reports disabled only when every capability is disabled', () => {
    expect(quotaSummaryStatus([{ count: 0, limit: 0 }])).toBe('disabled');
  });
});
