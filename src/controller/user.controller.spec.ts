import { describe, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { UserController } from './user.controller.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

function setup() {
  const clientStateFeed = {
    readEndId: vi.fn().mockResolvedValue(6),
    query: vi.fn().mockResolvedValue([]),
    rejectMissingAfter: vi.fn(),
  };
  const profileNamespaceFeed = {
    clientChangeEnd: vi.fn().mockResolvedValue(9n),
  };
  const controller = new UserController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    clientStateFeed as never,
    {} as never,
    profileNamespaceFeed as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const req = { user: { userId: 7 } } as unknown as FastifyRequest;
  return { controller, clientStateFeed, profileNamespaceFeed, req };
}

describe('UserController.resolveUser', () => {
  it('resolves an exact public local group as a group card', async () => {
    const groups = {
      findPublicLocalGroupByAccount: vi.fn().mockResolvedValue({
        id: 12,
        account: '!group',
        name: 'Group',
        avatar: '',
        description: 'Hello',
        profileRev: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };
    const keypairs = {
      localAddress: vi.fn((account: string) => ({
        account,
        domain: 'local.example',
      })),
    };
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      keypairs as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      groups as never,
    );
    await expect(
      controller.resolveUser({ account: '!GROUP' }),
    ).resolves.toMatchObject({
      id: 12,
      account: '!group',
      name: 'Group',
      bio: 'Hello',
      isGroup: true,
      namespaceId: 0,
    });
    expect(groups.findPublicLocalGroupByAccount).toHaveBeenCalledWith('!group');
  });
});

describe('UserController.queryStateFeed', () => {
  it('returns a fixed full-mode feed window', async () => {
    const { controller, clientStateFeed, req } = setup();
    clientStateFeed.query.mockResolvedValue([
      {
        feedId: 5,
        account: '' as const,
        domain: 'local' as const,
        eventType: 'INCOMING_INVITE_HEAD',
        subjectAccount: '',
        subjectNamespaceId: 0,
        body: { readThroughFeedId: 0 },
      },
    ]);

    await expect(
      controller.queryStateFeed(req, 'full', '0', '100', '6'),
    ).resolves.toEqual({
      mode: 'full',
      items: [
        expect.objectContaining({
          feedId: 5,
          eventType: 'INCOMING_INVITE_HEAD',
        }),
      ],
      scannedThrough: 6,
      stateFeedEndId: 6,
      profileNamespaceChangeEndId: 9,
      hasMore: false,
    });
    expect(clientStateFeed.query).toHaveBeenCalledWith(7, 'full', 0, 6);
  });

  it('returns the recovery error when the cursor is missing', async () => {
    const { controller, clientStateFeed, req } = setup();
    const error = new Error('cursor unavailable');
    clientStateFeed.rejectMissingAfter.mockRejectedValue(error);

    await expect(controller.queryStateFeed(req, 'delta')).rejects.toBe(error);
    expect(clientStateFeed.rejectMissingAfter).toHaveBeenCalledWith(7);
    expect(clientStateFeed.query).not.toHaveBeenCalled();
  });

  it('returns code 30006 data when the cursor is ahead of the feed', async () => {
    const { controller, clientStateFeed, req } = setup();

    await expect(
      controller.queryStateFeed(req, 'delta', '9', '100', '9'),
    ).rejects.toMatchObject({
      bizCode: 30006,
      data: { resumeAfter: 0, resumeBefore: 7 },
    });
    expect(clientStateFeed.query).not.toHaveBeenCalled();
  });
});

describe('UserController.resolveFederatedUserStream', () => {
  it('returns a transient federated group card from the peer account profile', async () => {
    const keypairs = {
      localAddress: vi.fn((account: string) => ({
        account,
        domain: 'local.example',
      })),
    };
    const peerLifecycle = {
      hasCompleteRecognition: vi.fn().mockResolvedValue(true),
      checkHealth: vi.fn().mockResolvedValue('available'),
      checkOutboundReady: vi.fn().mockResolvedValue(undefined),
    };
    const profiles = {
      fetchRemoteAccount: vi.fn().mockResolvedValue({
        account: '!group',
        displayName: 'Remote Group',
        avatar: null,
        bio: '',
        profileRev: 2,
      }),
    };
    const federationRecognition = {
      captureContext: vi.fn().mockResolvedValue({ namespaceId: 7 }),
    };
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      keypairs as never,
      peerLifecycle as never,
      profiles as never,
      federationRecognition as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const events = await lastValueFrom(
      controller
        .resolveFederatedUserStream({
          account: '!group',
          domain: 'peer.example',
        })
        .pipe(toArray()),
    );
    expect(profiles.fetchRemoteAccount).toHaveBeenCalledWith(
      {
        account: '!group',
        domain: 'peer.example',
      },
      { kind: 'PIN' },
    );
    expect(
      events.find((event) => event.type === 'resolved')?.data,
    ).toMatchObject({
      user: { isGroup: true, name: 'Remote Group', namespaceId: 7 },
    });
  });

  it('completes explicit recognition and Health before fetching a profile', async () => {
    const calls: string[] = [];
    const keypairs = {
      localAddress: vi.fn((account: string) => ({
        account,
        domain: 'local.example',
      })),
    };
    const peerLifecycle = {
      hasCompleteRecognition: vi.fn().mockResolvedValue(false),
      checkOutboundReady: vi.fn(async () => {
        calls.push('directions');
      }),
      checkHealth: vi.fn(async () => {
        calls.push('health');
        return 'degraded';
      }),
    };
    const profiles = {
      fetchRemoteAccount: vi.fn(async () => {
        calls.push('profile');
        return {
          account: 'bob',
          displayName: 'Bob',
          avatar: null,
          bio: '',
          profileRev: 1,
        };
      }),
    };
    const federationRecognition = {
      captureContext: vi.fn(async () => {
        calls.push('context');
        return { namespaceId: 7 };
      }),
      subscribeProgress: vi.fn(
        (_domain: string, listener: (stage: 'DISCOVERING') => void) => {
          listener('DISCOVERING');
          return vi.fn();
        },
      ),
      recognize: vi.fn(async () => {
        calls.push('recognize');
      }),
    };
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      keypairs as never,
      peerLifecycle as never,
      profiles as never,
      federationRecognition as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const events = await lastValueFrom(
      controller
        .resolveFederatedUserStream({ account: 'bob', domain: 'peer.example' })
        .pipe(toArray()),
    );

    expect(calls).toEqual([
      'recognize',
      'health',
      'directions',
      'profile',
      'context',
    ]);
    expect(
      events
        .filter((event) => event.type === 'progress')
        .map((event) => event.data),
    ).toContainEqual({ stage: 'WAITING_FOR_PEER' });
    expect(
      events
        .filter((event) => event.type === 'progress')
        .map((event) => event.data),
    ).toContainEqual({ stage: 'FETCHING_USER' });
    expect(
      events.find((event) => event.type === 'resolved')?.data,
    ).toMatchObject({ user: { name: 'Bob', namespaceId: 7 } });
  });

  it('unsubscribes recognition progress when the HTTP stream disconnects', async () => {
    let progress: (stage: string) => void = () => undefined;
    let resolveRecognition: () => void = () => undefined;
    const unsubscribe = vi.fn();
    const federationRecognition = {
      subscribeProgress: vi.fn(
        (_domain: string, listener: (stage: string) => void) => {
          progress = listener;
          return unsubscribe;
        },
      ),
      recognize: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRecognition = resolve;
          }),
      ),
      captureContext: vi.fn().mockResolvedValue({ namespaceId: 7 }),
    };
    const keypairs = {
      localAddress: vi.fn((account: string) => ({
        account,
        domain: 'local.example',
      })),
    };
    const peerLifecycle = {
      hasCompleteRecognition: vi.fn().mockResolvedValue(false),
    };
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      keypairs as never,
      peerLifecycle as never,
      {} as never,
      federationRecognition as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const events: string[] = [];
    const subscription = controller
      .resolveFederatedUserStream({ account: 'bob', domain: 'peer.example' })
      .subscribe((event) => events.push(event.type ?? ''));
    await vi.waitFor(() =>
      expect(federationRecognition.subscribeProgress).toHaveBeenCalledOnce(),
    );
    subscription.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledOnce();
    progress('DISCOVERING');
    resolveRecognition();
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(federationRecognition.captureContext).not.toHaveBeenCalled();
  });

  it('uses a VOUCH possession challenge when namespace coordinates are provided', async () => {
    const keypairs = {
      localAddress: vi.fn((account: string) => ({
        account,
        domain: 'local.example',
      })),
    };
    const peerLifecycle = {
      hasCompleteRecognition: vi.fn().mockResolvedValue(true),
      checkHealth: vi.fn().mockResolvedValue('available'),
      checkOutboundReady: vi.fn().mockResolvedValue(undefined),
    };
    const profiles = {
      fetchRemoteAccount: vi.fn().mockResolvedValue({
        account: 'alice',
        displayName: 'Alice',
        avatar: null,
        bio: '',
        profileRev: 3,
      }),
    };
    const federationRecognition = {
      captureContext: vi.fn().mockResolvedValue({ namespaceId: 7 }),
    };
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      keypairs as never,
      peerLifecycle as never,
      profiles as never,
      federationRecognition as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const events = await lastValueFrom(
      controller
        .resolveFederatedUserStream({
          account: 'alice',
          domain: 'peer.example',
          publisherNamespaceId: 12,
          profileNamespaceId: 5,
        })
        .pipe(toArray()),
    );
    expect(profiles.fetchRemoteAccount).toHaveBeenCalledWith(
      { account: 'alice', domain: 'peer.example' },
      { kind: 'VOUCH', publisherNamespaceId: 12, profileNamespaceId: 5 },
    );
    expect(
      events.find((event) => event.type === 'resolved')?.data,
    ).toMatchObject({ user: { name: 'Alice', namespaceId: 7 } });
  });

  it('falls back to PIN when only one namespace coordinate is provided', async () => {
    const keypairs = {
      localAddress: vi.fn((account: string) => ({
        account,
        domain: 'local.example',
      })),
    };
    const peerLifecycle = {
      hasCompleteRecognition: vi.fn().mockResolvedValue(true),
      checkHealth: vi.fn().mockResolvedValue('available'),
      checkOutboundReady: vi.fn().mockResolvedValue(undefined),
    };
    const profiles = {
      fetchRemoteAccount: vi.fn().mockResolvedValue({
        account: 'alice',
        displayName: 'Alice',
        avatar: null,
        bio: '',
        profileRev: 3,
      }),
    };
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      keypairs as never,
      peerLifecycle as never,
      profiles as never,
      {
        captureContext: vi.fn().mockResolvedValue({ namespaceId: 7 }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const events = await lastValueFrom(
      controller
        .resolveFederatedUserStream({
          account: 'alice',
          domain: 'peer.example',
          publisherNamespaceId: 12,
        })
        .pipe(toArray()),
    );
    expect(profiles.fetchRemoteAccount).toHaveBeenCalledWith(
      { account: 'alice', domain: 'peer.example' },
      { kind: 'PIN' },
    );
    expect(
      events.find((event) => event.type === 'resolved')?.data,
    ).toMatchObject({
      user: { account: 'alice', namespaceId: 7 },
    });
    expect(events.some((event) => event.type === 'failed')).toBe(false);
  });

  it('reports IDENTITY_LOST when a VOUCH challenge is uncertifiable', async () => {
    const keypairs = {
      localAddress: vi.fn((account: string) => ({
        account,
        domain: 'local.example',
      })),
    };
    const peerLifecycle = {
      hasCompleteRecognition: vi.fn().mockResolvedValue(true),
      checkHealth: vi.fn().mockResolvedValue('available'),
      checkOutboundReady: vi.fn().mockResolvedValue(undefined),
    };
    const profiles = {
      fetchRemoteAccount: vi
        .fn()
        .mockRejectedValue(
          new BusinessException(
            BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
            'vouched root key is uncertifiable',
          ),
        ),
    };
    const controller = new UserController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      keypairs as never,
      peerLifecycle as never,
      profiles as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const events = await lastValueFrom(
      controller
        .resolveFederatedUserStream({
          account: 'alice',
          domain: 'peer.example',
          publisherNamespaceId: 12,
          profileNamespaceId: 5,
        })
        .pipe(toArray()),
    );
    expect(profiles.fetchRemoteAccount).toHaveBeenCalledWith(
      { account: 'alice', domain: 'peer.example' },
      { kind: 'VOUCH', publisherNamespaceId: 12, profileNamespaceId: 5 },
    );
    expect(events.find((event) => event.type === 'failed')?.data).toMatchObject(
      { reason: 'IDENTITY_LOST' },
    );
  });
});
