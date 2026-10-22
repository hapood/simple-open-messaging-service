import { describe, expect, it, vi } from 'vitest';
import type { MediaTransferService } from '../../services/media-transfer.service';
import { ThreadTransferController } from './thread-transfer.controller';

describe('ThreadTransferController', () => {
  it('projects only non-audio transfers for the active thread', () => {
    const transfers = {
      tasks: () => [
        { clientMessageId: 'a', threadId: 1, kind: 'file', status: 'failed' },
        { clientMessageId: 'b', threadId: 2, kind: 'file', status: 'failed' },
        { clientMessageId: 'c', threadId: 1, kind: 'audio', status: 'failed' },
      ],
    } as unknown as MediaTransferService;
    const controller = new ThreadTransferController(transfers, () => 1);
    expect(controller.failed().map((task) => task.clientMessageId)).toEqual([
      'a',
    ]);
  });

  it('retries only retryable failed tasks', () => {
    const retry = vi.fn();
    const transfers = {
      tasks: () => [
        {
          clientMessageId: 'yes',
          threadId: 1,
          kind: 'file',
          status: 'failed',
          retryable: true,
        },
        {
          clientMessageId: 'no',
          threadId: 1,
          kind: 'file',
          status: 'failed',
          retryable: false,
        },
      ],
      retry,
    } as unknown as MediaTransferService;
    new ThreadTransferController(transfers, () => 1).retryFailed();
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith('yes');
  });
});
