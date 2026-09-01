import { describe, expect, it, vi } from 'vitest';
import { ProfileResolutionCoordinatorService } from './profile-resolution-coordinator.service.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

describe('ProfileResolutionCoordinatorService durable references', () => {
  it('persists a message-author response as a disclosure-limited referenced version', async () => {
    const wire = {
      account: 'alice',
      domain: 'member.example',
      displayName: 'Alice in this group',
      avatar: null,
      profileRev: 9,
    };
    const peerHttp = { get: vi.fn().mockResolvedValue(wire) };
    const profiles = {
      materializeExactForeignProfile: vi.fn(),
      materializeReferencedUserProfile: vi.fn().mockResolvedValue(undefined),
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
    expect(profiles.materializeReferencedUserProfile).toHaveBeenCalledWith(
      { ...wire, bio: '' },
      'group-host.example',
      7,
    );
    expect(profiles.materializeExactForeignProfile).not.toHaveBeenCalled();
    expect(result).toEqual({
      account: 'alice',
      domain: 'member.example',
      rev: 9,
      name: 'Alice in this group',
      avatarBase64: null,
    });
  });
});
