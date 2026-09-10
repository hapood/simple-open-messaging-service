import { describe, expect, it, vi } from 'vitest';
import { consumePendingThreadNavigation } from './pending-thread-navigation';

describe('pending native notification navigation', () => {
  it('opens a cold-start tap before acknowledging it', () => {
    const order: string[] = [];
    consumePendingThreadNavigation(
      {
        getPendingThreadId: () => '7',
        acknowledgeThreadId: (id) => order.push(`ack:${id}`),
      },
      (id) => order.push(`open:${id}`),
    );
    expect(order).toEqual(['open:7', 'ack:7']);
  });

  it('does not discard a tap if navigation fails', () => {
    const acknowledgeThreadId = vi.fn();
    expect(() =>
      consumePendingThreadNavigation(
        {
          getPendingThreadId: () => '7',
          acknowledgeThreadId,
        },
        () => {
          throw new Error('not ready');
        },
      ),
    ).toThrow('not ready');
    expect(acknowledgeThreadId).not.toHaveBeenCalled();
  });

  it('ignores absent and invalid targets', () => {
    const open = vi.fn();
    consumePendingThreadNavigation(undefined, open);
    for (const value of [null, '0', '-1', 'NaN', '2147483648']) {
      consumePendingThreadNavigation(
        { getPendingThreadId: () => value, acknowledgeThreadId: vi.fn() },
        open,
      );
    }
    expect(open).not.toHaveBeenCalled();
  });
});
