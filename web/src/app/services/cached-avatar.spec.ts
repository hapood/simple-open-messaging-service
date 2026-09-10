import { cachedAvatarDataUrl } from './cached-avatar';
import { threadNotificationIcon } from './thread-notification';
import { createP2PConversation } from './model';

describe('cached notification avatars', () => {
  const path = '/uploads/avatar.webp';
  it('uses cached bytes only when the current avatar path matches', async () => {
    const getAvatar = vi.fn().mockResolvedValue({
      path,
      blob: new Blob(['avatar'], { type: 'image/webp' }),
    });
    expect(await cachedAvatarDataUrl({ getAvatar }, 'u2', path)).toBe(
      'data:image/webp;base64,YXZhdGFy',
    );
    expect(
      await cachedAvatarDataUrl({ getAvatar }, 'u2', '/uploads/new.webp'),
    ).toBeUndefined();
    expect(getAvatar).toHaveBeenCalledWith('u2');
  });
  it('does not access storage for an empty or inline avatar', async () => {
    const getAvatar = vi.fn();
    expect(await cachedAvatarDataUrl({ getAvatar }, 'u2', '')).toBeUndefined();
    expect(
      await cachedAvatarDataUrl(
        { getAvatar },
        'u2',
        'data:image/png;base64,AA==',
      ),
    ).toBe('data:image/png;base64,AA==');
    expect(getAvatar).not.toHaveBeenCalled();
  });
  it('falls back to the app icon when cached avatar access fails', async () => {
    const getAvatar = vi.fn().mockRejectedValue(new Error('cache closed'));
    const item = createP2PConversation(7, {
      id: 2,
      account: 'peer',
      name: 'Peer',
      avatar: path,
    });
    expect(await threadNotificationIcon({ getAvatar }, item)).toBe(
      '/icons/icon-192.png',
    );
  });
});
