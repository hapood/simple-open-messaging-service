import { personalQuotaStatus } from './personal-quota-status';
import type { PersonalQuotaState } from '../../services/model';

function state(values: Array<[number, number]>): PersonalQuotaState {
  const [messages, images, largeFiles, requests] = values;
  return {
    usage: {
      messages: { count: messages[0], limit: messages[1] },
      images: { count: images[0], limit: images[1] },
      largeFiles: { count: largeFiles[0], limit: largeFiles[1] },
      requests: { count: requests[0], limit: requests[1] },
    },
    caps: { imageBytes: 1, largeFileBytes: 1 },
    resetAt: '2026-08-04T00:00:00.000Z',
  };
}

describe('personalQuotaStatus', () => {
  it('ignores disabled categories and warns at 80 percent', () => {
    expect(
      personalQuotaStatus(
        state([
          [0, 0],
          [8, 10],
          [0, 20],
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
          [0, 20],
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
          [0, 0],
        ]),
      ),
    ).toBe('disabled');
  });
});
