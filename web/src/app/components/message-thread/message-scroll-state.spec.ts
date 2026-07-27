import { isMessageViewportAtBottom } from './message-scroll-state';

describe('message scroll state', () => {
  it('treats only the visible bottom zone as current, not the kernel prefetch edge', () => {
    expect(isMessageViewportAtBottom({ scrollTop: 900, scrollHeight: 1600, viewportHeight: 600 })).toBeFalse();
    expect(isMessageViewportAtBottom({ scrollTop: 910, scrollHeight: 1600, viewportHeight: 600 })).toBeTrue();
  });
});
