import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  watchMountedMessageDeletions,
  type MessageDeletionFact,
} from './mounted-message-deletion';

function setup() {
  const deletedLive$ = new Subject<{
    threadId: number;
    deletions: MessageDeletionFact[];
  }>();
  let resolve!: (facts: MessageDeletionFact[]) => void;
  const getMessageDeletions = vi.fn(() => {
    expect(deletedLive$.observed).toBe(true);
    return new Promise<MessageDeletionFact[]>((done) => {
      resolve = done;
    });
  });
  const store = { deletedLive$, getMessageDeletions };
  const owner = new AbortController();
  const onDeleted = vi.fn();
  const onError = vi.fn();
  const mount = () =>
    watchMountedMessageDeletions(
      store,
      42,
      [10],
      owner.signal,
      onDeleted,
      onError,
    );
  return {
    store,
    owner,
    onDeleted,
    onError,
    mount,
    resolve: (facts: MessageDeletionFact[]) => resolve(facts),
  };
}
const admin = { seq: 10, type: 'MODERATION_REMOVAL' } as const;
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('mounted message deletion recheck', () => {
  it('subscribes before checking a body read before a missed pre-mount admin deletion', async () => {
    const test = setup();
    // The cache body was read before this notification, but no DOM owner existed yet.
    test.store.deletedLive$.next({ threadId: 42, deletions: [admin] });
    const dispose = test.mount();
    expect(test.store.getMessageDeletions).toHaveBeenCalledWith(42, [10]);
    test.resolve([admin]);
    await settle();
    expect(test.onDeleted).toHaveBeenCalledExactlyOnceWith(admin);
    dispose();
    expect(test.store.deletedLive$.observed).toBe(false);
  });

  it('defers a signal during creation until mounting completes and ignores other coordinates', async () => {
    const test = setup();
    const dispose = test.mount();
    test.store.deletedLive$.next({ threadId: 99, deletions: [admin] });
    test.store.deletedLive$.next({
      threadId: 42,
      deletions: [{ ...admin, seq: 11 }, admin],
    });
    expect(test.onDeleted).not.toHaveBeenCalled();
    await settle();
    test.resolve([admin]);
    await settle();
    expect(test.onDeleted).toHaveBeenCalledExactlyOnceWith(admin);
    dispose();
  });

  it('discards an old query after unmount even if a successor mounts the same seq', async () => {
    const test = setup();
    const dispose = test.mount();
    const oldResolve = test.resolve;
    // Capture the old promise's resolver before installing the successor.
    const oldPromise = test.store.getMessageDeletions.mock.results[0].value;
    dispose();
    oldResolve([admin]);
    const successor = test.mount();
    await oldPromise;
    await settle();
    expect(test.onDeleted).not.toHaveBeenCalled();
    test.resolve([]);
    await settle();
    expect(test.onDeleted).not.toHaveBeenCalled();
    successor();
  });

  it('cancels queued events and pending results when the owner generation ends', async () => {
    const test = setup();
    test.mount();
    test.store.deletedLive$.next({ threadId: 42, deletions: [admin] });
    test.owner.abort();
    test.resolve([admin]);
    await settle();
    expect(test.onDeleted).not.toHaveBeenCalled();
    expect(test.store.deletedLive$.observed).toBe(false);
  });
});
