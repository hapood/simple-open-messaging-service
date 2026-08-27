import { personalQuotaStatus } from './personal-quota-status';
import type { PersonalQuotaState } from '../../services/model';

function state(values: Array<[number, number]>): PersonalQuotaState {
  const [messages, files, requests] = values;
  return {
    usage: {
      messages: { count: messages[0], limit: messages[1] },
      files: { count: files[0], limit: files[1] },
      requests: { count: requests[0], limit: requests[1] },
    },
    breaker: {
      tripped: false,
      trippedDims: [],
      msg: { count: messages[0], limit: messages[1] },
      file: { count: files[0], limit: files[1] },
      fileBytes: { bytes: '0', limit: 0 },
    },
    resetAt: Date.UTC(2026, 7, 4),
  };
}

describe('personalQuotaStatus', () => {
  it('ignores disabled categories and warns at 80 percent', () => {
    expect(
      personalQuotaStatus(
        state([
          [0, 0],
          [8, 10],
          [0, 10],
        ]),
      ),
    ).toBe('warning');
  });

  it('reports exhaustion before warning', () => {
    expect(
      personalQuotaStatus(
        state([
          [10, 10],
          [9, 10],
          [0, 10],
        ]),
      ),
    ).toBe('exhausted');
  });

  it('reports an account with every capability disabled', () => {
    expect(
      personalQuotaStatus(
        state([
          [0, 0],
          [0, 0],
          [0, 0],
        ]),
      ),
    ).toBe('disabled');
  });
});
