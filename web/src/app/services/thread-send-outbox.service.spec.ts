import { ThreadSendOutbox } from './thread-send-outbox.service';

describe('ThreadSendOutbox', () => {
  it('retains retry resources across thread bucket release and disposes them explicitly', () => {
    const outbox = new ThreadSendOutbox();
    const dispose = vi.fn().mockName('dispose');

    outbox.retainResource('cid-native', {
      type: 'native-attachment',
      partId: 'part-native',
      selection: {} as never,
      release: dispose,
      discard: dispose,
    });
    outbox.releaseIfEmpty(42);

    expect(outbox.resource('cid-native')).toBeDefined();
    expect(dispose).not.toHaveBeenCalled();

    outbox.releaseResource('cid-native');
    expect(outbox.resource('cid-native')).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('clear disposes every retained native resource', () => {
    const outbox = new ThreadSendOutbox();
    const first = vi.fn().mockName('firstDispose');
    const second = vi.fn().mockName('secondDispose');
    outbox.retainResource('cid-1', {
      type: 'native-attachment',
      partId: 'part-1',
      selection: {} as never,
      release: vi.fn().mockName('firstRelease'),
      discard: first,
    });
    outbox.retainResource('cid-2', {
      type: 'native-attachment',
      partId: 'part-2',
      selection: {} as never,
      release: vi.fn().mockName('secondRelease'),
      discard: second,
    });

    outbox.clear();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(outbox.resource('cid-1')).toBeUndefined();
    expect(outbox.resource('cid-2')).toBeUndefined();
  });

  it('releases every preview owned by an atomic web gallery', () => {
    const outbox = new ThreadSendOutbox();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    outbox.retainResource('cid-gallery', {
      type: 'web-gallery',
      parts: [],
      previewUrls: ['blob:first', 'blob:second'],
    });

    outbox.releaseResource('cid-gallery');

    expect(vi.mocked(revoke).mock.calls).toEqual([
      ['blob:first'],
      ['blob:second'],
    ]);
  });
});
