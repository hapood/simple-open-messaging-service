import { describe, expect, it, vi } from 'vitest';
import { paintPinnedArrival } from './arrival-paint';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from './chat-item';

describe('pinned arrival paint', () => {
  const item = (self: boolean) => ({ data: { type: 'msg', isSelf: self } }) as CbItem<ChatItemData>;
  it('animates self content without requiring an outbox identity', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="msg-bubble"></div>';
    const animate = vi.spyOn(host.firstElementChild as HTMLElement, 'animate');
    paintPinnedArrival(item(true), host, [1]);
    expect(animate).toHaveBeenCalledOnce();
    animate.mockRestore();
  });
  it('animates only newly absorbed album members', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div data-media-message-id="1"></div><div data-media-message-id="2"></div>';
    const old = vi.spyOn(host.children[0] as HTMLElement, 'animate');
    const added = vi.spyOn(host.children[1] as HTMLElement, 'animate');
    paintPinnedArrival(item(true), host, [2]);
    expect(old).not.toHaveBeenCalled();
    expect(added).toHaveBeenCalledOnce();
    old.mockRestore();
    added.mockRestore();
  });
  it('does not animate another sender', () => {
    const host = document.createElement('div');
    const animate = vi.spyOn(host, 'animate');
    paintPinnedArrival(item(false), host, [1]);
    expect(animate).not.toHaveBeenCalled();
    animate.mockRestore();
  });
});
