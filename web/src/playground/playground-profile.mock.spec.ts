import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { PlaygroundSocialState } from './playground-social-state';
import { PlaygroundUserService } from './playground-user.mock';
import { PlaygroundProfiles } from './playground-profile.mock';
import { playgroundAvatars } from './playground-avatars';

describe('playground self profile', () => {
  let state: PlaygroundSocialState;
  let users: PlaygroundUserService;
  let profiles: PlaygroundProfiles;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    state = TestBed.inject(PlaygroundSocialState);
    state.initialize();
    users = TestBed.inject(PlaygroundUserService);
    profiles = TestBed.inject(PlaygroundProfiles);
  });

  const demand = (account: string, rev: number) => ({
    publisherNamespaceId: 0,
    lookup: 'ACCOUNT_PROFILE' as const,
    target: { profileNamespaceId: 0, account, rev },
  });

  it('seeds seven published profiles and five unprofiled identities, including requests', async () => {
    expect(
      state.users
        .filter((user) => user.avatar)
        .map((user) => user.account)
        .sort(),
    ).toEqual([
      '!bookclub',
      '!playground',
      'alice',
      'ivy',
      'liam',
      'maya',
      'noah',
    ]);
    expect(state.users.filter((user) => !user.avatar)).toHaveLength(5);
    for (const user of state.users) {
      expect(user.profileRev).toBe(user.avatar ? 1 : 0);
      if (!user.avatar) {
        expect(user.name).toBe(user.account);
        expect(user.bio).toBe('');
      }
    }
    for (const { record } of state.requests) {
      if (record.direction === 'INCOMING') {
        expect(record.authorProfile.profileRev).toBe(
          state.user(record.author.account)?.profileRev,
        );
      }
    }
  });

  it('starts self without a profile and publishes each save as a new revision', async () => {
    expect(users.sessionProfile()?.profileRev).toBe(0);
    const changes = vi.fn();
    state.membersChanged$.subscribe(changes);
    const response = await firstValueFrom(
      users.updateProfile({ name: '  New Me  ', bio: 'Hello' }),
    );
    expect(response.code).toBe(0);
    expect(users.sessionProfile()).toMatchObject({
      name: 'New Me',
      bio: 'Hello',
      profileRev: 1,
    });
    expect(changes).toHaveBeenCalledWith([2]);
    expect(
      state.rosters.get(2)?.find((member) => member.account === 'me'),
    ).toMatchObject({
      name: 'New Me',
      bio: 'Hello',
      profileRev: 1,
      role: 'OWNER',
    });
    await firstValueFrom(users.updateProfile({ name: 'Second Me', bio: '' }));
    expect(users.sessionProfile()?.profileRev).toBe(2);
    expect(
      await firstValueFrom(profiles.resolve(demand('me', 1))),
    ).toMatchObject({ name: 'New Me', bio: 'Hello', rev: 1 });
    expect(
      await firstValueFrom(profiles.resolve(demand('me', 2))),
    ).toMatchObject({ name: 'Second Me', rev: 2 });
    expect(
      await firstValueFrom(profiles.resolve(demand('me', 0))),
    ).toMatchObject({ name: 'me', bio: '', avatarBlob: null });
    users.updateSessionProfile();
    expect(users.sessionProfile()?.name).toBe('Second Me');
  });

  it('decodes, retains and clears avatar bytes by revision without changing old snapshots', async () => {
    const avatarBase64 = playgroundAvatars['alice'].split(',')[1];
    expect(
      (
        await firstValueFrom(
          users.updateProfile({ name: 'Me', bio: '', avatarBase64 }),
        )
      ).code,
    ).toBe(0);
    const first = await firstValueFrom(profiles.resolve(demand('me', 1)));
    expect(first.avatarDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.avatarBlob?.type).toBe('image/webp');
    await firstValueFrom(users.updateProfile({ name: 'Me again', bio: '' }));
    expect(
      (await firstValueFrom(profiles.resolve(demand('me', 2)))).avatarDigest,
    ).toBe(first.avatarDigest);
    await firstValueFrom(
      users.updateProfile({ name: 'Me again', bio: '', avatarBase64: null }),
    );
    expect(
      (await firstValueFrom(profiles.resolve(demand('me', 3)))).avatarBlob,
    ).toBeNull();
    expect(
      (await firstValueFrom(profiles.resolve(demand('me', 1)))).avatarDigest,
    ).toBe(first.avatarDigest);
  });

  it('rejects invalid input atomically without publishing notifications', async () => {
    const changed = vi.fn();
    state.membersChanged$.subscribe(changed);
    for (const params of [
      { name: ' ', bio: '' },
      { name: '😀'.repeat(32), bio: '' },
      { name: 'Valid', bio: '😀'.repeat(121) },
      { name: 'Valid', bio: '', avatarBase64: 'not base64!' },
      { name: 'Valid', bio: '', avatarBase64: btoa('not an image') },
    ]) {
      expect((await firstValueFrom(users.updateProfile(params))).code).not.toBe(
        0,
      );
    }
    expect(state.self.profileRev).toBe(0);
    expect(users.sessionProfile()?.name).toBe('me');
    expect(changed).not.toHaveBeenCalled();
    expect(
      (
        await firstValueFrom(
          users.updateProfile({ name: '😀'.repeat(31), bio: '😀'.repeat(120) }),
        )
      ).code,
    ).toBe(0);
  });

  it('resolves seeded profiles exactly and never substitutes a current revision or foreign publisher', async () => {
    const alice = await firstValueFrom(profiles.resolve(demand('alice', 1)));
    expect(alice).toMatchObject({ name: 'Alice', rev: 1 });
    expect(alice.avatarBlob).not.toBeNull();
    expect(
      (await firstValueFrom(profiles.resolve(demand('alice', 2)))).avatarBlob,
    ).toBeNull();
    expect(
      (
        await firstValueFrom(
          profiles.resolve({ ...demand('alice', 1), publisherNamespaceId: 9 }),
        )
      ).avatarBlob,
    ).toBeNull();
    expect(
      (await firstValueFrom(profiles.resolve(demand('!playground', 1))))
        .avatarBlob,
    ).not.toBeNull();
    expect(
      (await firstValueFrom(profiles.resolve(demand('!bookclub', 0))))
        .avatarBlob,
    ).toBeNull();
    expect(
      (await firstValueFrom(profiles.resolve(demand('!bookclub', 1))))
        .avatarBlob,
    ).not.toBeNull();
  });
});
