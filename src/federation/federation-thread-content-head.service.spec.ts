import { describe, expect, it, vi } from 'vitest';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';

process.env.SOMS_DOMAIN ??= 'local.test';

function transaction(options?: {
  messageEndSeq?: number | null;
  tombstoneEndSeq?: number;
  threadType?: 'P2P' | 'GROUP';
  messageAccessAfterSeq?: number;
}) {
  const route = {
    messageAccessAfterSeq: options?.messageAccessAfterSeq ?? 3,
    threadType: options?.threadType ?? 'P2P',
    groupAccount: options?.threadType === 'GROUP' ? '!group' : null,
    account: options?.threadType === 'GROUP' ? null : 'alice',
    peerAccount: options?.threadType === 'GROUP' ? null : 'bob',
  };
  const execute = vi.fn().mockResolvedValue({ rows: [route] });
  let selectIndex = 0;
  const select = vi.fn(() => {
    selectIndex += 1;
    if (selectIndex === 1) {
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            {
              value:
                options && 'messageEndSeq' in options
                  ? options.messageEndSeq
                  : 12,
            },
          ]),
        })),
      };
    }
    return {
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi
            .fn()
            .mockResolvedValue([{ value: options?.tombstoneEndSeq ?? 4 }]),
        })),
      })),
    };
  });
  return { execute, select };
}

describe('FederationThreadContentHeadService', () => {
  it('writes message and tombstone targets as one P2P State Feed projection', async () => {
    const stateFeed = { writeManyInTx: vi.fn().mockResolvedValue(new Map()) };
    const service = new FederationThreadContentHeadService(
      {} as never,
      stateFeed as never,
      {} as never,
    );
    const tx = transaction();

    await service.refreshInTx(tx as never, 'peer.test', 7, 31);

    expect(stateFeed.writeManyInTx).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        peerDomain: 'peer.test',
        namespaceId: 7,
        account: 'alice',
        eventType: 'THREAD_CONTENT_HEAD',
        subjectAccount: 'bob',
        subjectDomain: 'peer.test',
        body: { messageEndSeq: 12, tombstoneEndSeq: 4 },
      }),
    ]);
  });

  it('uses the group address without a directional subject', async () => {
    const stateFeed = { writeManyInTx: vi.fn().mockResolvedValue(new Map()) };
    const service = new FederationThreadContentHeadService(
      {} as never,
      stateFeed as never,
      {} as never,
    );
    const tx = transaction({ threadType: 'GROUP', tombstoneEndSeq: 0 });

    await service.refreshInTx(tx as never, 'peer.test', 7, 31);

    expect(stateFeed.writeManyInTx).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        account: '!group',
        subjectAccount: '',
        subjectDomain: 'local',
        body: { messageEndSeq: 12, tombstoneEndSeq: 0 },
      }),
    ]);
  });

  it('publishes the reauthorization floor when no newer message exists', async () => {
    const stateFeed = { writeManyInTx: vi.fn() };
    const service = new FederationThreadContentHeadService(
      {} as never,
      stateFeed as never,
      {} as never,
    );
    const tx = transaction({ messageEndSeq: null });

    await service.refreshInTx(tx as never, 'peer.test', 7, 31);

    expect(stateFeed.writeManyInTx).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        body: { messageEndSeq: 3, tombstoneEndSeq: 4 },
      }),
    ]);
  });

  it('does not create a projection when both the message end and floor are zero', async () => {
    const stateFeed = { writeManyInTx: vi.fn() };
    const service = new FederationThreadContentHeadService(
      {} as never,
      stateFeed as never,
      {} as never,
    );
    const tx = transaction({ messageEndSeq: null, messageAccessAfterSeq: 0 });

    await service.refreshInTx(tx as never, 'peer.test', 7, 31);

    expect(stateFeed.writeManyInTx).not.toHaveBeenCalled();
  });
});
