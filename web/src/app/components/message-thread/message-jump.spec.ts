import { jumpToMessage } from './message-jump';
import type { ScrollerApi } from '../../lib/chat-box/chat-box-scroller';

describe('message jump routing', () => {
  function kernel() {
    const smoothScrollToMessage = vi.fn().mockResolvedValue(true);
    const scroller = { smoothScrollToMessage } as unknown as ScrollerApi;
    return { scroller, smoothScrollToMessage };
  }

  it('routes search through stable message identity with context reveal and highlighting', async () => {
    const { scroller, smoothScrollToMessage } = kernel();
    expect(await jumpToMessage(scroller, 42)).toBe(true);
    expect(smoothScrollToMessage).toHaveBeenCalledExactlyOnceWith(42, 20, true);
  });

  it('routes unread navigation through the same API without extra reveal', async () => {
    const { scroller, smoothScrollToMessage } = kernel();
    await jumpToMessage(scroller, 42, 0);
    expect(smoothScrollToMessage).toHaveBeenCalledExactlyOnceWith(42, 0, true);
  });

  it('forwards an explicitly requested reveal distance', async () => {
    const { scroller, smoothScrollToMessage } = kernel();
    await jumpToMessage(scroller, 42, 32);
    expect(smoothScrollToMessage).toHaveBeenCalledExactlyOnceWith(42, 32, true);
  });

  it('does not fabricate a result without an attached kernel', async () => {
    expect(await jumpToMessage(undefined, 42)).toBeUndefined();
  });
});
