import { describe, expect, it, vi } from 'vitest';
import { recordHostedGroupLastSentSeq } from './hosted-group-last-sent.js';

describe('recordHostedGroupLastSentSeq', () => {
  it('executes the hosted-group-scoped sequence update', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await recordHostedGroupLastSentSeq(
      { execute } as never,
      42,
      { account: 'alice', domain: 'local' },
      7,
    );

    expect(execute).toHaveBeenCalledOnce();
  });
});
