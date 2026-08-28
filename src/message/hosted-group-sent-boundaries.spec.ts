import { describe, expect, it, vi } from 'vitest';
import { recordHostedGroupSentBoundaries } from './hosted-group-sent-boundaries.js';

describe('recordHostedGroupSentBoundaries', () => {
  it('executes the hosted-group-scoped boundary update', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await recordHostedGroupSentBoundaries(
      { execute } as never,
      42,
      { account: 'alice', domain: 'local' },
      7,
    );

    expect(execute).toHaveBeenCalledOnce();
  });
});
