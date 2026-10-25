import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { ALL_MENTION_ID } from '../../lib/message-entity';
import type { ChatMember } from '../chat-editor/chat-editor.component';
import { nativeMentionPresentation } from './native-mention-presentation';

const member: ChatMember = {
  id: '2/alice',
  label: 'Alice Friend',
  profile: {
    account: 'alice',
    publisherNamespaceId: 7,
    profileNamespaceId: 2,
    rev: 3,
    linked: true,
    groupAccount: '!room',
  },
};

describe('native mention presentation boundary', () => {
  const resolve = vi.fn();
  beforeEach(() => {
    resolve.mockReset().mockReturnValue(
      of({
        avatarBlob: new Blob(['x'], { type: 'image/webp' }),
      }),
    );
  });

  it('resolves pinned roster coordinates and serializes bytes only when subscribed by native', async () => {
    const presentation = nativeMentionPresentation([member], { resolve });
    expect(resolve).not.toHaveBeenCalled();
    expect(await firstValueFrom(presentation)).toEqual([
      {
        kind: 'user',
        id: '2/alice',
        label: 'Alice Friend',
        avatar: {
          kind: 'user',
          url: 'data:image/webp;base64,eA==',
          fallbackText: 'AF',
          colorSeed: '2/alice',
        },
      },
    ]);
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      publisherNamespaceId: 7,
      lookup: 'GROUP_MEMBER_PROFILE',
      groupAccount: '!room',
      target: { account: 'alice', profileNamespaceId: 2, rev: 3 },
    });
  });

  it('does not give network authority to a retained read-only member ref', async () => {
    await firstValueFrom(
      nativeMentionPresentation(
        [
          {
            ...member,
            profile: { ...member.profile!, linked: false },
          },
        ],
        { resolve },
      ),
    );
    expect(resolve).toHaveBeenCalledWith({
      evidence: null,
      demand: {
        publisherNamespaceId: 7,
        lookup: 'GROUP_MEMBER_PROFILE',
        groupAccount: '!room',
        target: { account: 'alice', profileNamespaceId: 2, rev: 3 },
      },
    });
  });

  it('keeps built-in audience mentions out of the profile pipeline', async () => {
    const items = await firstValueFrom(
      nativeMentionPresentation([{ id: ALL_MENTION_ID, label: 'Everyone' }], {
        resolve,
      }),
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(items).toEqual([
      {
        id: ALL_MENTION_ID,
        label: 'Everyone',
        kind: 'all',
        avatar: { kind: 'builtin', icon: 'everyone' },
      },
    ]);
  });

  it('uses initials instead of exposing a digest as an image URL', async () => {
    resolve.mockReturnValue(
      of({ avatarBlob: null, avatarDigest: 'a'.repeat(64) }),
    );
    const [item] = await firstValueFrom(
      nativeMentionPresentation([member], { resolve }),
    );
    expect(item.avatar).toEqual({
      kind: 'user',
      url: undefined,
      fallbackText: 'AF',
      colorSeed: member.id,
    });
  });

  it('does not drop the mention candidate when its profile is unavailable', async () => {
    resolve.mockReturnValue(throwError(() => new Error('unavailable')));
    const [item] = await firstValueFrom(
      nativeMentionPresentation([member], { resolve }),
    );
    expect(item.id).toBe(member.id);
    expect(item.avatar).toMatchObject({
      kind: 'user',
      fallbackText: 'AF',
      url: undefined,
    });
  });

  it('releases pending profile subscriptions when native stops waiting', () => {
    const pending = new Subject();
    resolve.mockReturnValue(pending);
    const publish = vi.fn();
    const subscription = nativeMentionPresentation([member], {
      resolve,
    }).subscribe(publish);
    expect(pending.observed).toBe(true);
    subscription.unsubscribe();
    expect(pending.observed).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('answers an empty page without scheduling profile work', async () => {
    expect(
      await firstValueFrom(nativeMentionPresentation([], { resolve })),
    ).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
