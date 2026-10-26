import { describe, expect, it, vi } from 'vitest';
import { createP2PConversation, type ConversationItem } from './model';
import { mergeThreadItems } from './thread-list-order';

function row(id: number, feed: number, pinnedAt: number | null = null) {
  return createP2PConversation({
    threadId: id,
    account: `peer-${id}`,
    publisherNamespaceId: 0,
    profileRev: 0,
    threadFeedId: feed,
    pinned: pinnedAt !== null,
    pinnedAt,
  });
}

const ids = (items: ConversationItem[]) => items.map((item) => item.threadId);

describe('thread list page updates', () => {
  it('uses the same algorithm for the first page, with pins ordered by last-set time', () => {
    expect(
      ids(
        mergeThreadItems(
          [],
          [row(1, 100, 10), row(2, 50, 20), row(3, 30), row(4, 40)],
        ),
      ),
    ).toEqual([2, 1, 4, 3]);
  });

  it('sorts only ordinary page rows and prepends the whole batch, not a global merge', () => {
    const old = [row(1, 1, 10), row(2, 100), row(3, 90), row(4, 80)];
    const page = [row(3, 20), row(5, 30)];
    const sort = vi.spyOn(Array.prototype, 'sort');
    let result: ConversationItem[];
    try {
      result = mergeThreadItems(old, page);
      expect(sort).toHaveBeenCalledTimes(1);
      expect(sort.mock.contexts[0]).toHaveLength(2);
    } finally {
      sort.mockRestore();
    }
    expect(ids(result!)).toEqual([1, 5, 3, 2, 4]);
    expect(result![3]).toBe(old[1]);
    expect(result![4]).toBe(old[3]);
    expect(ids(old)).toEqual([1, 2, 3, 4]);
    expect(ids(page)).toEqual([3, 5]);
  });

  it('inserts each pin at its timestamp position without sorting the pin page', () => {
    const old = [row(1, 1, 40), row(2, 2, 20), row(3, 3, 10), row(4, 4)];
    const sort = vi.spyOn(Array.prototype, 'sort');
    let result: ConversationItem[];
    try {
      result = mergeThreadItems(old, [
        row(5, 5, 15),
        row(6, 6, 50),
        row(7, 7, 30),
      ]);
      expect(sort).not.toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
    expect(ids(result!)).toEqual([6, 1, 7, 2, 5, 3, 4]);
  });

  it('stops searching at the head for a newly set pin', () => {
    const tail = row(2, 2, 10);
    const readTailTimestamp = vi.fn(() => 10);
    Object.defineProperty(tail, 'pinnedAt', { get: readTailTimestamp });
    const result = mergeThreadItems([row(1, 1, 20), tail], [row(3, 3, 30)]);
    expect(ids(result)).toEqual([3, 1, 2]);
    expect(readTailTimestamp).not.toHaveBeenCalled();
  });

  it('replaces a pin in place on message updates and moves it when re-pinned', () => {
    const old = [row(1, 1, 20), row(2, 2, 10), row(3, 3)];
    const updated = row(2, 100, 10);
    const splice = vi.spyOn(Array.prototype, 'splice');
    let result: ConversationItem[];
    try {
      result = mergeThreadItems(old, [updated]);
      expect(splice).not.toHaveBeenCalled();
    } finally {
      splice.mockRestore();
    }
    expect(ids(result!)).toEqual([1, 2, 3]);
    expect(result[1]).toBe(updated);
    expect(ids(mergeThreadItems(result, [row(2, 101, 30)]))).toEqual([2, 1, 3]);
  });

  it('removes old IDs from both sections before mixed pin/unpin insertion', () => {
    const old = [row(1, 1, 30), row(2, 2, 20), row(3, 100), row(4, 90)];
    const result = mergeThreadItems(old, [row(1, 5), row(4, 6, 25)]);
    expect(ids(result)).toEqual([4, 2, 1, 3]);
    expect(new Set(ids(result)).size).toBe(result.length);
  });

  it('uses the final row when the same ID occurs more than once in a page', () => {
    const final = row(1, 3);
    const result = mergeThreadItems(
      [row(1, 1, 10), row(2, 100)],
      [row(1, 2, 20), final],
    );
    expect(ids(result)).toEqual([1, 2]);
    expect(result[0]).toBe(final);
  });

  it('keeps hidden rows outside the sections and supports visibility changes', () => {
    const hidden = { ...row(2, 2), visible: false };
    const result = mergeThreadItems(
      [row(1, 1), hidden],
      [row(2, 3, 10), { ...row(1, 4), visible: false }],
    );
    expect(ids(result)).toEqual([2, 1]);
    expect(result[0].visible).not.toBe(false);
    expect(result[1].visible).toBe(false);
  });

  it('rejects missing or duplicate visible feed coordinates', () => {
    expect(() =>
      mergeThreadItems([], [{ ...row(1, 1), threadFeedId: undefined }]),
    ).toThrow('has no threadFeedId');
    expect(() => mergeThreadItems([row(1, 1)], [row(2, 1)])).toThrow(
      'Duplicate threadFeedId',
    );
  });
});
