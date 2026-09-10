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

    const result = await subject['resolve']({
      kind: 'message',
      threadId: 41,
      messageSeq: 23,
      account: 'alice',
      domain: 'member.example',
      rev: 9,
      namespaceId: 7,
      publisherDomain: 'group-host.example',
      publisherNamespaceId: 7,
      publisherMessageSeq: 81,
    });

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

    await subject['resolve']({
      kind: 'groupMember',
      threadId: 41,
      groupAccount: '!group',
      account: 'alice',
      domain: 'member.example',
      rev: 9,
      namespaceId: 12,
      publisherDomain: 'group-host.example',
      publisherNamespaceId: 7,
    });

    expect(peerHttp.get).toHaveBeenCalledWith(
      '/s2s/v1/group-member-profile?account=%21group&memberAccount=alice&memberDomain=member.example&rev=9',
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
        type: 'GROUP_MEMBER',
        threadId: 41,
        memberAccount: 'alice',
        memberDomain: 'member.test',
      }),
    ).resolves.toMatchObject({
      kind: 'groupMember',
      groupAccount: '!group',
      rev: 4,
      namespaceId: 9,
    });

    const query = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL).sql;
    expect(query).toContain('FROM "GroupMetaMemberFeed" member_fact');
    expect(query).toContain('FROM "RelationshipPair" viewer_pair');
    expect(query).not.toContain('ClientGroupMetaMemberFeed');
    expect(query).not.toContain('AccountThreadState');
  });
});
