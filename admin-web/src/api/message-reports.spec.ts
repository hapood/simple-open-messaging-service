import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSelectedMessages } from './message-reports';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ request }));

describe('selected message deletion', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('submits single targets sequentially and retains failures for retry', async () => {
    let release!: (value: unknown) => void;
    request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ threadId: 7, messageSeq: 3, deletionSeq: 2 });
    const targets = [1, 2, 3].map((seq) => ({ threadId: 7, seq }));
    const pending = deleteSelectedMessages(targets);
    expect(request).toHaveBeenCalledTimes(1);
    release({ threadId: 7, messageSeq: 1, deletionSeq: 1 });
    expect(await pending).toEqual({ deleted: 2, failed: [targets[1]] });
    targets.forEach((target, index) =>
      expect(request).toHaveBeenNthCalledWith(
        index + 1,
        '/admin/messages/delete',
        target,
      ),
    );
  });

  it('retains a rejected deletion for retry', async () => {
    request.mockRejectedValue(new Error('message cannot be deleted'));
    const targets = [{ threadId: 1, seq: 1 }];
    expect(await deleteSelectedMessages(targets)).toEqual({
      deleted: 0,
      failed: targets,
    });
  });
});
