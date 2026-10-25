import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { PlaygroundSocialState } from './playground-social-state';
import { PlaygroundUserService } from './playground-user.mock';
import { PlaygroundGroupService } from './playground-group.mock';
import { PlaygroundMemberProfiles } from './playground-profile.mock';
import { currentGroupAnnouncement } from '../app/services/group-announcement';
import { parseIncomingRequestHead } from '../../../shared/relationship-request';

const snapshot = { displayName: 'Emma at request time', avatar: null };

describe('playground social contracts', () => {
  let state: PlaygroundSocialState;
  let users: PlaygroundUserService;
  let groups: PlaygroundGroupService;
  let members: PlaygroundMemberProfiles;
  beforeEach(() => {
    TestBed.configureTestingModule({});
    state = TestBed.inject(PlaygroundSocialState);
    state.initialize();
    users = TestBed.inject(PlaygroundUserService);
    groups = TestBed.inject(PlaygroundGroupService);
    members = TestBed.inject(PlaygroundMemberProfiles);
  });
  afterEach(() => vi.useRealTimers());

  it('pages the seven-day online window with decimal bigint IDs and no totals', async () => {
    const first = (
      await firstValueFrom(
        users.queryRelationshipRequests({ bucket: 'RECEIVED', take: 1 }),
      )
    ).data!;
    expect(first.items).toHaveLength(1);
    expect(BigInt(first.items[0].id)).toBeGreaterThan(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    expect(first.before).toBe(first.items[0].id);
    expect(first.hasMore).toBe(true);
    expect(first).not.toHaveProperty('total');
    expect(parseIncomingRequestHead(first.incomingHead)).toEqual(
      first.incomingHead,
    );
    const next = (
      await firstValueFrom(
        users.queryRelationshipRequests({
          bucket: 'RECEIVED',
          before: first.before!,
          take: 50,
        }),
      )
    ).data!;
    expect(next.items).toHaveLength(2);
    expect(
      next.items.every((record) => BigInt(record.id) < BigInt(first.before!)),
    ).toBe(true);
    expect(next.before).toBeNull();
    expect(next.hasMore).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 86400_000);
    expect(
      (
        await firstValueFrom(
          users.queryRelationshipRequests({ bucket: 'RECEIVED' }),
        )
      ).data!.items,
    ).toEqual([]);
  });

  it('marks only the observed incoming head read and never regresses it', async () => {
    expect(users.friendReqBadge()).toBe(true);
    const observed = { ...users.relationshipRequestHead() };
    state.addRequest('FRIEND', state.user('ivy')!, state.self, 'INCOMING');
    await users.observeIncomingRequestPage(observed);
    expect(users.friendReqBadge()).toBe(true);
    await users.observeIncomingRequestPage(users.relationshipRequestHead());
    expect(users.friendReqBadge()).toBe(false);
    await users.markRelationshipRequestsRead('0');
    expect(users.friendReqBadge()).toBe(false);
  });

  it('resolves exact accounts, not display-name or prefix searches', async () => {
    expect(
      (await firstValueFrom(users.resolveUser({ account: 'emma' }))).data?.name,
    ).toBe('Emma');
    expect(
      (await firstValueFrom(users.resolveUser({ account: 'emm' }))).code,
    ).not.toBe(0);
    expect(
      (
        await firstValueFrom(
          users.resolveFederatedUser({
            account: 'emma',
            domain: 'chat.example.test',
          }),
        )
      ).user.account,
    ).toBe('emma');
    await expect(
      firstValueFrom(
        users.resolveFederatedUser({ account: 'emma', domain: 'unknown.test' }),
      ),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('keeps outgoing snapshots and tombstones, and never applies an old ID to a new round', async () => {
    const params = { account: 'emma', namespaceId: 0, snapshot, note: 'Hello' };
    const command = users.requestRelationship(params);
    expect(await users.localRelationship(state.user('emma')!)).toBe('NONE');
    await firstValueFrom(command);
    expect(await users.localRelationship(state.user('emma')!)).toBe(
      'OUTGOING_PENDING',
    );
    const first = (
      await firstValueFrom(users.queryRelationshipRequests({ bucket: 'SENT' }))
    ).data!.items[0];
    expect(first).toMatchObject({
      direction: 'OUTGOING',
      snapshot,
      note: 'Hello',
    });
    await firstValueFrom(users.requestRelationship(params));
    expect(
      state.requests.filter(({ record }) => record.receiver.account === 'emma'),
    ).toHaveLength(1);
    expect(
      (
        await firstValueFrom(
          users.withdrawRelationshipRequest({ requestId: first.id }),
        )
      ).data,
    ).toEqual({ status: 'OK', threadId: null });
    await firstValueFrom(users.requestRelationship(params));
    expect(
      (
        await firstValueFrom(
          users.withdrawRelationshipRequest({ requestId: first.id }),
        )
      ).data,
    ).toEqual({ status: 'STALE_REQUEST' });
    const rows = (
      await firstValueFrom(users.queryRelationshipRequests({ bucket: 'SENT' }))
    ).data!.items.filter((item) => item.receiver.account === 'emma');
    expect(rows.map((row) => row.status)).toEqual(['REQUESTED', 'WITHDRAWN']);
    state.user('emma')!.name = 'Changed name';
    expect(rows[0]).toMatchObject({ snapshot });
  });

  it('accepts and rejects exact incoming requests and preserves history on unfriend', async () => {
    const maya = state.requests.find(
      ({ record }) => record.author.account === 'maya',
    )!.record;
    const noah = state.requests.find(
      ({ record }) => record.author.account === 'noah',
    )!.record;
    expect(
      (
        await firstValueFrom(
          users.withdrawRelationshipRequest({ requestId: maya.id }),
        )
      ).data?.status,
    ).toBe('STALE_REQUEST');
    const result = (
      await firstValueFrom(users.acceptRelationship({ requestId: maya.id }))
    ).data!;
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') throw new Error('Expected applied decision');
    expect(await users.localRelationship(state.user('maya')!)).toBe('FRIEND');
    await firstValueFrom(
      users.rejectRelationshipRequest({ requestId: noah.id }),
    );
    expect(await users.localRelationship(state.user('noah')!)).toBe('NONE');
    await firstValueFrom(
      users.revokeRelationship({ threadId: result.threadId! }),
    );
    expect(
      state.conversations
        .items()
        .find((item) => item.threadId === result.threadId),
    ).toMatchObject({
      friendshipActive: false,
      conversationState: 'READ_ONLY',
    });
    expect(await users.localRelationship(state.user('maya')!)).toBe('NONE');
  });

  it('treats reciprocal requests as consent instead of creating another pending round', async () => {
    const response = await firstValueFrom(
      users.requestRelationship({ account: 'maya', namespaceId: 0, snapshot }),
    );
    expect(response.data).toMatchObject({
      status: 'OK',
      threadId: expect.any(Number),
    });
    expect(await users.localRelationship(state.user('maya')!)).toBe('FRIEND');
    expect(
      state.requests.filter(
        ({ record }) =>
          record.author.account === 'maya' ||
          record.receiver.account === 'maya',
      ),
    ).toHaveLength(1);
    expect(
      state.requests.find(({ record }) => record.author.account === 'maya')
        ?.record.status,
    ).toBe('ACCEPTED');
  });

  it('returns EXPIRED without changing membership or accepting a stale round', async () => {
    const record = state.requests.find(
      ({ record }) => record.author.account === 'maya',
    )!.record;
    record.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(
      (await firstValueFrom(users.acceptRelationship({ requestId: record.id })))
        .data,
    ).toEqual({ status: 'EXPIRED' });
    expect(await users.localRelationship(state.user('maya')!)).toBe('NONE');
  });

  it('joins an invited group and supports a separate outgoing application', async () => {
    const invite = state.requests.find(
      ({ record }) =>
        record.kind === 'GROUP_INVITATION' && record.direction === 'INCOMING',
    )!.record;
    await firstValueFrom(users.joinGroupRequest({ requestId: invite.id }));
    expect(await users.localRelationship(state.user('!bookclub')!)).toBe(
      'FRIEND',
    );
    const group = state.conversations
      .items()
      .find(
        (item) => item.type === 'GROUP' && item.group.account === '!bookclub',
      )!;
    await firstValueFrom(groups.leaveGroup({ groupId: group.threadId }));
    await firstValueFrom(
      users.requestRelationship({
        account: '!bookclub',
        namespaceId: 0,
        snapshot,
      }),
    );
    expect(
      await users.hasPendingGroupApplication(state.user('!bookclub')!),
    ).toBe(true);
  });

  it('creates a group with only the owner and a complete group-meta projection', async () => {
    const result = (
      await firstValueFrom(
        groups.createGroup({ name: 'New team', description: 'Description' }),
      )
    ).data!;
    expect(
      await members.queryPage(result.threadId, { take: 50 }),
    ).toMatchObject([{ account: 'me', role: 'OWNER' }]);
    const thread = state.conversations
      .items()
      .find((item) => item.threadId === result.threadId)!;
    expect(thread).toMatchObject({
      role: 'OWNER',
      group: { name: 'New team', memberCount: 1 },
      groupMetaTargetFeedId: '1',
    });
    await expect(
      firstValueFrom(groups.leaveGroup({ groupId: result.groupId })),
    ).rejects.toThrow('Transfer ownership');
  });

  it('retains sent snapshots and rejects duplicate invitations without auto-joining', async () => {
    const params = {
      groupId: 2,
      users: [
        {
          account: 'liam',
          namespaceId: 0,
          snapshot: { displayName: 'Liam snapshot', avatar: null },
        },
      ],
    };
    const response = (await firstValueFrom(groups.inviteUsers(params))).data!;
    expect(response.invited).toEqual([{ account: 'liam', namespaceId: 0 }]);
    expect(response.skipped).toEqual([]);
    expect(await members.queryPage(2, { take: 50 })).toHaveLength(5);
    expect(
      (await firstValueFrom(groups.inviteUsers(params))).data!.skipped[0]
        .reason,
    ).toBe('ALREADY_INVITED');
    const invite = (
      await firstValueFrom(groups.queryInvitations({ groupId: 2 }))
    ).data!.items[0];
    expect(invite).toMatchObject({
      direction: 'OUTGOING',
      snapshot: params.users[0].snapshot,
    });
    await firstValueFrom(
      groups.revokeInvitation({ groupId: 2, requestId: invite.id }),
    );
    expect(
      (await firstValueFrom(groups.queryInvitations({ groupId: 2 }))).data!
        .items[0].status,
    ).toBe('WITHDRAWN');
  });

  it('applies group decisions only to the correct group and request kind', async () => {
    const page = (
      await firstValueFrom(groups.queryJoinRequests({ groupId: 2 }))
    ).data!;
    const ivy = page.items.find((record) => record.author.account === 'ivy')!;
    expect(
      (
        await firstValueFrom(
          groups.revokeInvitation({ groupId: 2, requestId: ivy.id }),
        )
      ).data?.status,
    ).toBe('STALE_REQUEST');
    expect(
      (await firstValueFrom(users.acceptRelationship({ requestId: ivy.id })))
        .data?.status,
    ).toBe('STALE_REQUEST');
    await firstValueFrom(
      groups.acceptJoinRequest({ groupId: 2, requestId: ivy.id }),
    );
    expect(
      await members.queryPage(2, { take: 50, search: 'Ivy' }),
    ).toMatchObject([{ account: 'ivy', role: 'MEMBER' }]);
    expect(
      state.conversations.items().find((item) => item.threadId === 2)?.group
        ?.memberCount,
    ).toBe(6);
    const jack = page.items.find((record) => record.author.account === 'jack')!;
    await firstValueFrom(
      groups.rejectJoinRequest({ groupId: 2, requestId: jack.id }),
    );
    expect(await members.queryPage(2, { take: 50, search: 'Jack' })).toEqual(
      [],
    );
    await firstValueFrom(
      groups.markJoinRequestsRead({
        groupId: 2,
        joinRequestReadFeedId: page.joinRequestEndFeedId,
      }),
    );
    expect(
      state.conversations.items().find((item) => item.threadId === 2)
        ?.joinRequestReadFeedId,
    ).toBe(2);
  });

  it('paginates roster identities and publishes role, kick, transfer and leave changes', async () => {
    const first = await members.queryPage(2, { take: 2 });
    const second = await members.queryPage(2, {
      take: 50,
      afterIdentity: first.at(-1)!.identityKey,
    });
    expect(
      new Set([...first, ...second].map((item) => item.identityKey)).size,
    ).toBe(5);
    await firstValueFrom(
      groups.setRole({
        groupId: 2,
        account: 'maya',
        namespaceId: 0,
        role: 'ADMIN',
      }),
    );
    expect(
      (await members.queryPage(2, { take: 1, search: 'Maya' }))[0].role,
    ).toBe('ADMIN');
    await firstValueFrom(
      groups.kickMember({ groupId: 2, account: 'noah', namespaceId: 0 }),
    );
    expect(await members.queryPage(2, { take: 50 })).toHaveLength(4);
    await firstValueFrom(
      groups.transferOwnership({ groupId: 2, account: 'maya', namespaceId: 0 }),
    );
    expect(
      state.conversations.items().find((item) => item.threadId === 2)?.role,
    ).toBe('ADMIN');
    expect(
      (await members.queryPage(2, { take: 1, search: 'Maya' }))[0],
    ).toMatchObject({ role: 'OWNER', isOwner: true });
    await expect(
      firstValueFrom(groups.dissolveGroup({ groupId: 2 })),
    ).rejects.toThrow('Group owner');
    await firstValueFrom(groups.leaveGroup({ groupId: 2 }));
    expect(
      state.conversations.items().find((item) => item.threadId === 2),
    ).toMatchObject({ conversationState: 'READ_ONLY', role: null });
  });

  it('updates group profile, announcement and read cursors without pretending to refresh a server', async () => {
    await firstValueFrom(
      groups.updateGroup({
        groupId: 2,
        name: 'Updated',
        description: 'New description',
        avatar: undefined,
      }),
    );
    await firstValueFrom(groups.setAnnouncement(2, 'Announcement'));
    const thread = () =>
      state.conversations.items().find((item) => item.threadId === 2)!;
    expect(thread().group).toMatchObject({
      name: 'Updated',
      description: 'New description',
    });
    expect(currentGroupAnnouncement(thread())).toEqual({
      feedId: '2',
      text: 'Announcement',
    });
    await firstValueFrom(groups.markAnnouncementRead(2, 2));
    await firstValueFrom(groups.markAnnouncementRead(2, 1));
    expect(thread().announcementReadFeedId).toBe(2);
    await firstValueFrom(groups.setAnnouncement(2, null));
    expect(currentGroupAnnouncement(thread())).toBeNull();
    expect(
      (await firstValueFrom(groups.dissolveGroup({ groupId: 2 }))).data?.status,
    ).toBe('PENDING');
    expect(thread()).toMatchObject({
      conversationState: 'READ_ONLY',
      group: { dissolvedAt: expect.any(Number) },
    });
  });
});
