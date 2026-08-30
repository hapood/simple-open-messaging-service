import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../database/database.service.js';
import { openFederatedAudienceInTx } from './federation-audience.js';

function transaction(settingValue?: string) {
  const values = vi.fn().mockReturnValue({
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  });
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ namespaceId: 7 }] }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ curSeq: 42 }]),
        }),
      }),
    }),
    query: {
      systemSetting: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            settingValue === undefined ? undefined : { value: settingValue },
          ),
      },
    },
    insert: vi.fn().mockReturnValue({ values }),
  };
  return { tx: tx as unknown as DatabaseTransaction, values };
}

describe('openFederatedAudienceInTx history access', () => {
  it('allows retained history by default', async () => {
    const { tx, values } = transaction();

    await openFederatedAudienceInTx(tx, 'peer.test', 11);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 11,
        targetDomain: 'peer.test',
        targetNamespaceId: 7,
        messageAccessAfterSeq: 0,
      }),
    );
  });

  it('starts at the current tail when retained history access is disabled', async () => {
    const { tx, values } = transaction('false');

    await openFederatedAudienceInTx(tx, 'peer.test', 11);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ messageAccessAfterSeq: 42 }),
    );
  });
});
