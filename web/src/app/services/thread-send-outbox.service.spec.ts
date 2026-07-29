import { ThreadSendOutbox } from './thread-send-outbox.service';

describe('ThreadSendOutbox', () => {
  it('retains retry resources across thread bucket release and disposes them explicitly', () => {
    const outbox = new ThreadSendOutbox();
    const dispose = jasmine.createSpy('dispose');

    outbox.retainResource('cid-native', {
      type: 'native-attachment',
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
    const first = jasmine.createSpy('firstDispose');
    const second = jasmine.createSpy('secondDispose');
    outbox.retainResource('cid-1', {
      type: 'native-attachment',
      selection: {} as never,
      release: jasmine.createSpy('firstRelease'),
      discard: first,
    });
    outbox.retainResource('cid-2', {
      type: 'native-attachment',
      selection: {} as never,
      release: jasmine.createSpy('secondRelease'),
      discard: second,
    });

    outbox.clear();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(outbox.resource('cid-1')).toBeUndefined();
    expect(outbox.resource('cid-2')).toBeUndefined();
  });
});
