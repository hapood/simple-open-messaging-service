import { describe, expect, it } from 'vitest';
import { userQuotaStatus } from './user-quota-panel';

describe('userQuotaStatus', () => {
  it('distinguishes a disabled capability from exhausted daily usage', () => {
    expect(userQuotaStatus(0, 0)).toBe('disabled');
    expect(userQuotaStatus(10, 10)).toBe('exhausted');
  });

  it('warns at 80 percent and remains healthy below it', () => {
    expect(userQuotaStatus(79, 100)).toBe('healthy');
    expect(userQuotaStatus(80, 100)).toBe('warning');
  });
});
