import { describe, expect, it, vi } from 'vitest';
import { projectP2PMessageProfileInTx } from './project-p2p-message-profile-in-tx.js';

describe('projectP2PMessageProfileInTx', () => {
  it('projects only fenced exact P2P message profile coordinates', async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ accountId: 3 }] })
        .mockResolvedValueOnce({ rows: [{ id: 3 }] })
        .mockResolvedValueOnce({
          rows: [{ accountId: 3, threadFeedId: 12 }],
        }),
    };

    const changed = await projectP2PMessageProfileInTx(tx as never, {
      threadLock: { tx, threadId: 9 } as never,
      account: 'alice',
      domain: 'peer.test',
      namespaceId: 7,
      messageSeq: 6,
      profileRev: 4,
    });

    expect(changed).toEqual([{ accountId: 3, threadFeedId: 12 }]);
    expect(tx.execute).toHaveBeenCalledTimes(3);
    expect(tx.execute.mock.calls[2]![0]).toHaveProperty('queryChunks');
  });
});
