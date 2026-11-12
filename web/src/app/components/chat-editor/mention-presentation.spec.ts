import { Subject } from 'rxjs';
import { ChatMember, suggestionPopup } from './chat-editor.component';
import {
  AvatarPresentationService,
  initialAvatarView,
} from '../user-avatar/avatar-presentation.service';

// The popup consumes the common presentation pipeline without waiting for a
// whole page. These subjects stand in for independently pending item demands.
function labels(): string {
  return Array.from(document.querySelectorAll('.cb-mention-label'))
    .map((label) => label.textContent)
    .join('');
}

describe('mention item presentation', () => {
  it('shows the local page immediately, updates one item, and releases old consumers', () => {
    const alice = new Subject<ReturnType<typeof initialAvatarView>>();
    const bob = new Subject<ReturnType<typeof initialAvatarView>>();
    const resolve = vi.fn(({ profile }) =>
      profile.account === 'alice' ? alice : bob,
    );
    const popup = suggestionPopup({
      resolve,
    } as unknown as AvatarPresentationService);
    const member = (account: string): ChatMember => ({
      id: account,
      label: account,
      profile: {
        publisherNamespaceId: 0,
        profileNamespaceId: 12,
        account,
        rev: 3,
        linked: true,
        groupAccount: '!group',
      },
    });
    const items = [member('alice'), member('bob')];
    const command = vi.fn();
    popup.onStart({ items, command });
    try {
      expect(labels()).toBe('alicebob');
      expect(document.querySelectorAll('.cb-mention-avatar')).toHaveLength(2);
      const view = initialAvatarView({
        kind: 'snapshot',
        name: 'Alice ready',
        imageUrl: null,
      });
      alice.next(view);
      expect(labels()).toBe('Alice readybob');
      popup.onKeyDown({
        event: new KeyboardEvent('keydown', { key: 'ArrowDown' }),
      });
      expect(resolve).toHaveBeenCalledTimes(2);
      popup.onUpdate({ items: [member('bob')], command });
      expect(alice.observed).toBe(false);
      alice.next(view);
      expect(labels()).toBe('bob');
    } finally {
      popup.onExit();
    }
    expect(bob.observed).toBe(false);
    expect(document.querySelector('.cb-mention-popup')).toBeNull();
  });
});
