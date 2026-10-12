import { signal } from '@angular/core';
import { GroupInfoComponent } from './group-info.component';
import type { ResolvedMemberProfile } from '../../services/member-profile-store.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const queryPage = vi.fn();
  const state = {
    rosterRequest: 0,
    threadId: signal(42),
    memberQuery: signal(''),
    loading: signal(false),
    loadingMore: signal(false),
    readOnly: () => false,
    roster: signal<ResolvedMemberProfile[]>([]),
    rosterHasMore: signal(true),
    memberProfiles: { queryPage },
  };
  return {
    state,
    queryPage,
    component: state as unknown as GroupInfoComponent,
  };
}

const member = (name: string) =>
  ({ identityKey: '[0,"local","alice"]', name }) as ResolvedMemberProfile;

describe('GroupInfoComponent roster query ordering', () => {
  it('does not query the member roster after membership becomes read-only', async () => {
    const { state, component, queryPage } = harness();
    (component as unknown as { readOnly: () => boolean }).readOnly = () => true;

    await GroupInfoComponent.prototype.loadMembers.call(component);

    expect(queryPage).not.toHaveBeenCalled();
    expect(state.loading()).toBe(false);
  });

  it('does not let an older query overwrite a refreshed roster', async () => {
    const { state, component, queryPage } = harness();
    const old = deferred<ResolvedMemberProfile[]>();
    queryPage
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([member('New')]);
    const pending = GroupInfoComponent.prototype.loadMembers.call(component);
    await GroupInfoComponent.prototype.loadMembers.call(component);
    old.resolve([member('Old')]);
    await pending;
    expect(state.roster()[0].name).toBe('New');
    expect(state.loading()).toBe(false);
  });

  it('discards an old next page when a profile notification refreshes the roster', async () => {
    const { state, component, queryPage } = harness();
    state.roster.set([member('Old')]);
    const oldPage = deferred<ResolvedMemberProfile[]>();
    queryPage
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce([member('New')]);
    const pending =
      GroupInfoComponent.prototype.loadMoreMembers.call(component);
    await GroupInfoComponent.prototype.loadMembers.call(component);
    oldPage.resolve([member('Old page')]);
    await pending;
    expect(state.roster().map((row) => row.name)).toEqual(['New']);
    expect(state.loadingMore()).toBe(false);
  });
});

describe('GroupInfoComponent privileged-role action gating', () => {
  const localMember = {
    identityKey: '[0,"local","bob"]',
    name: 'Bob',
    account: 'bob',
    namespaceId: 0,
    role: 'MEMBER' as const,
    isOwner: false,
    avatar: '',
    bio: '',
    profileRev: 0,
    profileMessageSeq: null,
    profileResolved: false,
  } as ResolvedMemberProfile;
  const federatedMember = {
    identityKey: '[12,"bravo.test","charlie"]',
    name: 'Charlie',
    account: 'charlie',
    namespaceId: 12,
    role: 'MEMBER' as const,
    isOwner: false,
    avatar: '',
    bio: '',
    profileRev: 0,
    profileMessageSeq: null,
    profileResolved: false,
  } as ResolvedMemberProfile;
  const withRole = (role: 'OWNER' | 'ADMIN' | 'MEMBER') =>
    ({ isOwner: () => role === 'OWNER' }) as unknown as GroupInfoComponent;

  it('offers privileged-role actions only for local members when owner', () => {
    const component = withRole('OWNER');
    expect(
      GroupInfoComponent.prototype.canChangePrivilegedRole.call(
        component,
        localMember,
      ),
    ).toBe(true);
    expect(
      GroupInfoComponent.prototype.canChangePrivilegedRole.call(
        component,
        federatedMember,
      ),
    ).toBe(false);
  });

  it('offers them to no one when the caller is not the owner', () => {
    const component = withRole('ADMIN');
    expect(
      GroupInfoComponent.prototype.canChangePrivilegedRole.call(
        component,
        localMember,
      ),
    ).toBe(false);
  });
});
