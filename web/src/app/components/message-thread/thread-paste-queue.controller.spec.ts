import { describe, expect, it, vi } from 'vitest';
import type { NativeUploadSelection } from '../../services/native-upload.service';
import { ThreadPasteQueueController } from './thread-paste-queue.controller';

function native(uploadId: string): NativeUploadSelection {
  return {
    uploadId,
    name: `${uploadId}.jpg`,
    size: 10,
    kind: 'image',
  } as NativeUploadSelection;
}

describe('ThreadPasteQueueController', () => {
  it('deduplicates native selections and owns discard on cancellation', () => {
    const discard = vi.fn();
    const queue = new ThreadPasteQueueController(discard);

    queue.appendNative([native('one'), native('one'), native('two')]);
    expect(queue.items().map((item) => item.id)).toEqual([
      'native:one',
      'native:two',
    ]);
    expect(queue.open()).toBe(true);

    queue.cancel();
    expect(discard.mock.calls).toEqual([['one'], ['two']]);
    expect(queue.open()).toBe(false);
  });

  it('transfers ownership without releasing items when taken for sending', () => {
    const discard = vi.fn();
    const queue = new ThreadPasteQueueController(discard);
    queue.appendNative([native('send')]);

    expect(queue.take()).toHaveLength(1);
    expect(queue.items()).toEqual([]);
    expect(discard).not.toHaveBeenCalled();
  });
});
