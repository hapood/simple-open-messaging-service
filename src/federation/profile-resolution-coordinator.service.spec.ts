import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from './federation-errors.js';
import { ProfileResolutionCoordinatorService } from './profile-resolution-coordinator.service.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

const dialect = new PgDialect();

describe('ProfileResolutionCoordinatorService durable references', () => {
  it('preserves disclosed profile failure semantics from S2S responses', () => {
    const subject = new ProfileResolutionCoordinatorService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(
      subject['failureReason'](
        new S2sResponseError(
          'not disclosed',
          200,
          BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED,
        ),
      ),
    ).toBe('NOT_DISCLOSED');
    expect(
      subject['failureReason'](
        new S2sResponseError('not found', 200, BusinessCode.NOT_FOUND),
      ),
    ).toBe('NOT_FOUND');
  });

  it('rejects an exact revision-zero selector before authorization or I/O', async () => {
    const peerHttp = { get: vi.fn() };
    const subject = new ProfileResolutionCoordinatorService(
      {} as never,
      peerHttp as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      subject.start(1, {
        type: 'EXACT',
        account: 'alice',
        domain: 'peer.example',
        rev: 0,
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.VALIDATION_FAILED });
    expect(peerHttp.get).not.toHaveBeenCalled();
  });

  it('persists a message-author response as a complete profile version', async () => {
    const wire = {
      account: 'alice',
      domain: 'member.example',
      displayName: 'Alice in this group',
      bio: 'Member biography',
      avatar: null,
      profileRev: 9,
    };
    const peerHttp = { get: vi.fn().mockResolvedValue(wire) };
    const profiles = {
      materializeExactForeignProfile: vi.fn().mockResolvedValue(undefined),
      getStoredProfile: vi.fn().mockResolvedValue(wire),
    };
    const threadSources = {
      resolve: vi.fn().mockResolvedValue({
        selector: { account: '!group', peerAccount: 'local-user' },
      }),
    };
    const subject = new ProfileResolutionCoordinatorService(
      {} as never,
      peerHttp as never,
      profiles as never,
      threadSources as never,
      {} as never,
    );

    const result = await subject['fetch'](
      {
        namespaceId: 7,
        account: 'alice',
        domain: 'member.example',
        rev: 9,
      },
      {
        kind: 'message',
        threadId: 41,
        publisherDomain: 'group-host.example',
        publisherNamespaceId: 7,
        publisherMessageSeq: 81,
      },
    );

    expect(peerHttp.get).toHaveBeenCalledWith(
      '/s2s/v1/message-author-profile?account=%21group&peerAccount=local-user&messageSeq=81',
      'group-host.example',
    );
    expect(profiles.materializeExactForeignProfile).toHaveBeenCalledWith(
      wire,
      'group-host.example',
      7,
    );
    expect(profiles.getStoredProfile).toHaveBeenCalledWith(
      'alice',
      'member.example',
      7,
      9,
    );
    expect(result).toEqual({
      namespaceId: 7,
      account: 'alice',
      domain: 'member.example',
      rev: 9,
      name: 'Alice in this group',
      bio: 'Member biography',
      avatarBase64: null,
    });
  });

  it('uses the group-meta allocation coordinate for a member profile', async () => {
    const wire = {
      account: 'alice',
      domain: 'member.example',
      displayName: 'Alice',
      bio: 'Member biography',
      avatar: null,
      profileRev: 9,
    };
    const peerHttp = { get: vi.fn().mockResolvedValue(wire) };
    const profiles = {
      materializeExactForeignProfile: vi.fn().mockResolvedValue(undefined),
      getStoredProfile: vi.fn().mockResolvedValue(wire),
    };
    const subject = new ProfileResolutionCoordinatorService(
      {} as never,
      peerHttp as never,
      profiles as never,
      {} as never,
      {} as never,
    );

    await subject['fetch'](
      {
        namespaceId: 12,
        account: 'alice',
        domain: 'member.example',
        rev: 9,
      },
      {
        kind: 'groupMeta',
        publisherDomain: 'group-host.example',
        publisherNamespaceId: 7,
        groupAccount: '!group',
        subject: {
          type: 'MEMBER',
          account: 'alice',
          domain: 'member.example',
        },
      },
    );

    expect(peerHttp.get).toHaveBeenCalledWith(
      '/s2s/v1/group-meta-profile?account=%21group&subject=MEMBER&memberAccount=alice&memberDomain=member.example',
      'group-host.example',
    );
    expect(profiles.materializeExactForeignProfile).toHaveBeenCalledWith(
      wire,
      'group-host.example',
      12,
    );
  });

  it('authorizes a group member profile against the active relationship and canonical meta', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          groupAccount: '!group',
          publisherDomain: 'host.test',
          publisherNamespaceId: 7,
          memberNamespaceId: 9,
          profileRev: 4,
        },
      ],
    });
    const subject = new ProfileResolutionCoordinatorService(
      { db: { execute } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      subject['normalizeAndAuthorize'](3, {
        type: 'GROUP_META',
        threadId: 41,
        profileRev: 4,
        subject: {
          type: 'MEMBER',
          account: 'alice',
          domain: 'member.test',
        },
      }),
    ).resolves.toMatchObject({
      key: { account: 'alice', rev: 4, namespaceId: 9 },
      method: { kind: 'groupMeta', groupAccount: '!group' },
    });

    const query = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL).sql;
    expect(query).toContain('FROM "GroupMetaMemberFeed" member_fact');
    expect(query).toContain('FROM "RelationshipPair" viewer_pair');
    expect(query).not.toContain('ClientGroupMetaMemberFeed');
    expect(query).not.toContain('AccountThreadState');
  });

  it('notifies only the invoking evidence and leaves other pending methods to complete independently', () => {
    const sse = { onProfileAvailable: vi.fn() };
    const subject = new ProfileResolutionCoordinatorService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sse as never,
    );
    const expectedKey = {
      namespaceId: 7,
      account: 'alice',
      domain: 'peer.example',
      rev: 4,
    };
    const actualKey = { ...expectedKey, rev: 5 };
    const invoking = {
      method: {
        kind: 'message' as const,
        threadId: 9,
        publisherDomain: 'peer.example',
        publisherNamespaceId: 7,
        publisherMessageSeq: 12,
      },
      evidence: { type: 'MESSAGE_AUTHOR' as const, threadId: 9, messageSeq: 12, rev: 4 },
      users: new Set([1]),
    };
    const retained = {
      method: {
        kind: 'exact' as const,
        account: 'alice',
        domain: 'peer.example',
        rev: 4,
      },
      evidence: { type: 'EXACT' as const, account: 'alice', domain: 'peer.example', rev: 4 },
      users: new Set([3]),
    };
    const actual = {
      method: {
        kind: 'exact' as const,
        account: 'alice',
        domain: 'peer.example',
        rev: 5,
      },
      evidence: { type: 'EXACT' as const, account: 'alice', domain: 'peer.example', rev: 5 },
      users: new Set([2]),
    };
    const expectedKeyString = JSON.stringify([7, 'alice', 'peer.example', 4]);
    const actualKeyString = JSON.stringify([7, 'alice', 'peer.example', 5]);
    subject['pending'].set(expectedKeyString, {
      key: expectedKey,
      methods: new Map([
        ['message', invoking],
        ['exact-old', retained],
      ]),
      state: 'ACTIVE',
    });
    subject['pending'].set(actualKeyString, {
      key: actualKey,
      methods: new Map([['exact-new', actual]]),
      state: 'QUEUED',
    });
    subject['pendingMethodCount'] = 3;
    subject['queue'].push(actualKeyString);

    subject['complete'](expectedKeyString, 'message', invoking, {
      ...actualKey,
      name: 'Alice',
      bio: '',
      avatarBase64: null,
    });

    expect(subject['pending'].has(actualKeyString)).toBe(true);
    expect(subject['pending'].get(expectedKeyString)?.methods).toEqual(
      new Map([['exact-old', retained]]),
    );
    expect(subject['pendingMethodCount']).toBe(2);
    expect(subject['queue']).toContain(expectedKeyString);
    expect(subject['queue']).toContain(actualKeyString);
    expect(sse.onProfileAvailable.mock.calls).toEqual([
      [1, actualKey, invoking.evidence],
    ]);

    // The actual revision's different evidence finishes under its own method.
    subject['complete'](actualKeyString, 'exact-new', actual, {
      ...actualKey,
      name: 'Alice',
      bio: '',
      avatarBase64: null,
    });
    expect(sse.onProfileAvailable.mock.calls).toEqual([
      [1, actualKey, invoking.evidence],
      [2, actualKey, actual.evidence],
    ]);
  });
});
