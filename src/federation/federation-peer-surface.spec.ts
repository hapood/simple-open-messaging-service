vi.mock('../user/system-account.js', () => ({
  systemAccountIdInTx: vi.fn().mockResolvedValue(99),
}));
import { afterEach, describe, it, expect, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());

// loadFederationConfig() reads SOMS_DOMAIN via requireEnv at construction (field initializer), so it
// must be set before any service under test is constructed. Module-top runs before any test body.
process.env.SOMS_DOMAIN ??= 'chat.example';

import { S2sResponseError } from './federation-errors.js';
import { BusinessCode } from '../common/business-code.js';
import { ContentType, MessageThreadType } from '../database/enums.js';
import { UploadService } from '../upload/upload.service.js';
import {
  messageThread,
  threadAudience,
  identityNamespace,
} from '../database/schema.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationUserDirectoryService } from './federation-user-directory.service.js';
import { FederationCallBridgeService } from './federation-call-bridge.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import { FederationThreadResourceClient } from './federation-thread-resource-client.service.js';
import { FederationProfileService } from './federation-profile.service.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';
import { FederationInboundMessageStoreService } from './federation-inbound-message-store.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';
import { FederationInboundMessagePageService } from './federation-inbound-message-page.service.js';
import { FederationPeerResourceService } from './federation-peer-resource.service.js';
import { FederationInboundMessageCommitService } from './federation-inbound-message-commit.service.js';
import { FederationThreadQueryDenialService } from './federation-thread-query-denial.service.js';

describe('federated contact-card avatar limits', () => {
  const digest = 'a'.repeat(64);
  const content = JSON.stringify({
    account: 'alice',
    domain: 'peer.test',
    displayName: 'Alice',
    publicKey: 'p'.repeat(43) + '=',
    bio: '',
    avatarDigest: digest,
  });

  function validate(bytes: number) {
    const { inboundMessageValidator } = makeStubs();
    inboundMessageValidator.assertAssetDescriptors({
      contentType: ContentType.CONTACT_CARD,
      content,
      assets: [{ digest, bytes }],
    } as never);
  }

  it('accepts the shared profile-avatar decoded-byte ceiling', () => {
    expect(() => validate(UploadService.MAX_AVATAR_WIRE_BYTES)).not.toThrow();
  });

  it('rejects empty and oversized contact-card avatars', () => {
    expect(() => validate(0)).toThrow(
      'contact-card avatar exceeds the profile avatar size limit',
    );
    expect(() => validate(UploadService.MAX_AVATAR_WIRE_BYTES + 1)).toThrow(
      'contact-card avatar exceeds the profile avatar size limit',
    );
  });
});

describe('thread-query FORBIDDEN convergence', () => {
  function forbiddenHarness(epoch: number) {
    const tx = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ localUserId: 1, remoteAccount: 'remote-user' }],
      }),
      query: {
        messageThread: {
          findFirst: vi.fn().mockResolvedValue({ authorizationEpoch: epoch }),
        },
      },
    };
    const relationshipIntents = {};
    const relationshipMutations = {};
    const clientStateFeed = { notifyFeedUpdates: vi.fn() };
    const tasks = {
      enqueueTaskInTx: vi.fn().mockResolvedValue({ taskId: 12n }),
    };
    const userIntents = {
      execute: vi
        .fn()
        .mockResolvedValue(
          epoch === 7
            ? { status: 'APPLIED' }
            : { status: 'NO_OP', reason: 'STALE_AUTHORIZATION' },
        ),
    };
    const service = new FederationThreadQueryDenialService(
      {
        db: { transaction: (run: (value: unknown) => unknown) => run(tx) },
      } as never,
      relationshipIntents as never,
      tasks as never,
      userIntents as never,
    );
    return {
      service,
      tx,
      relationshipIntents,
      relationshipMutations,
      clientStateFeed,
      tasks,
      userIntents,
    };
  }

  function groupForbiddenHarness(
    epoch: number,
    members: Array<{
      groupId: number;
      memberUserId: number | null;
      memberAccount?: string;
    }>,
    groupNamespaceId = 0,
  ) {
    const insertedValues = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ taskId: 77n }]),
    }));
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              groupAccount: '!group',
              groupNamespaceId,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ authorizationEpoch: epoch }] })
        .mockResolvedValueOnce({ rows: members })
        // Mirror-branch extras: the rounds fence bump, then the disband
        // admission's advisory lock, mirror read, and blocker scan.
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ dissolvedAt: null, authorizationEpoch: epoch + 1 }],
        })
        .mockResolvedValueOnce({ rows: [] }),
      insert: vi.fn(() => ({ values: insertedValues })),
      query: {
        messageThread: {
          findFirst: vi.fn().mockResolvedValue({
            type: 'GROUP',
            authorizationEpoch: epoch,
          }),
        },
      },
    };
    const relationshipIntents = {
      lockGroupBusinessScopeInTx: vi.fn().mockResolvedValue(undefined),
    };
    const relationshipMutations = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue(undefined),
      writeMemberRelationshipIntentInTx: vi
        .fn()
        .mockResolvedValue(new Map([['peer.test', 10n]])),
      writeGroupRelationshipIntentInTx: vi
        .fn()
        .mockResolvedValue(new Map([['peer.test', 11n]])),
    };
    const clientStateFeed = { notifyFeedUpdates: vi.fn() };
    const tasks = { enqueueTaskInTx: vi.fn() };
    const service = new FederationThreadQueryDenialService(
      {
        db: { transaction: (run: (value: unknown) => unknown) => run(tx) },
      } as never,
      relationshipIntents as never,
      tasks as never,
      {} as never,
    );
    return {
      service,
      tx,
      insertedValues,
      relationshipIntents,
      relationshipMutations,
      clientStateFeed,
      tasks,
    };
  }

  it('runs the authored revoke business transaction under the frozen epoch', async () => {
    const harness = forbiddenHarness(7);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('P2P_REVOKED');
    expect(harness.userIntents.execute).toHaveBeenCalledExactlyOnceWith(
      {
        userId: 1,
        decision: 'REVOKED',
        target: {
          account: 'remote-user',
          namespaceId: 5,
        },
      },
      {
        expectedAuthorization: {
          threadId: 31,
          epoch: 7,
        },
      },
    );
    expect(harness.tasks.enqueueTaskInTx).not.toHaveBeenCalled();
  });

  it('does not let an old denied round revoke a newer authorization epoch', async () => {
    const harness = forbiddenHarness(8);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('STALE');
    expect(harness.tasks.enqueueTaskInTx).not.toHaveBeenCalled();
    expect(harness.userIntents.execute).toHaveBeenCalledOnce();
  });

  it('leaves a denied mirror unchanged for a later state-feed push', async () => {
    const harness = groupForbiddenHarness(
      7,
      [
        { groupId: 4, memberUserId: 1 },
        { groupId: 4, memberUserId: 3 },
      ],
      5,
    );

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('MIRROR_WAITING_FOR_PUSH');
    expect(
      harness.relationshipMutations.lockGroupMutationInTx,
    ).not.toHaveBeenCalled();
    expect(
      harness.relationshipIntents.lockGroupBusinessScopeInTx,
    ).not.toHaveBeenCalled();
    expect(
      harness.relationshipMutations.writeMemberRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
    expect(harness.tasks.enqueueTaskInTx).not.toHaveBeenCalled();
    expect(harness.tx.execute).toHaveBeenCalledTimes(2);
    expect(harness.insertedValues).not.toHaveBeenCalled();
    expect(
      harness.relationshipMutations.writeGroupRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
  });

  it('queues authority cleanup without changing its thread epoch', async () => {
    const harness = groupForbiddenHarness(7, [
      {
        groupId: 4,
        memberUserId: null,
        memberAccount: 'remote-2',
      },
      {
        groupId: 4,
        memberUserId: null,
        memberAccount: 'remote-5',
      },
    ]);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('GROUP_REVOKE_QUEUED');
    expect(
      harness.relationshipMutations.writeGroupRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
    expect(harness.tasks.enqueueTaskInTx).toHaveBeenCalledWith(harness.tx, {
      scope: {
        type: 'GROUP',
        address: { account: '!group', profileNamespaceId: 0 },
      },
      taskType: 'REVOKE_FORBIDDEN_GROUP',
      actorUserId: 99,
      payload: {
        threadId: 31,
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 7,
      },
    });
    expect(harness.tx.execute).toHaveBeenCalledTimes(4);
    expect(
      harness.relationshipMutations.writeMemberRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
  });

  it('does not revoke authoritative group directions when the frozen epoch is stale', async () => {
    const harness = groupForbiddenHarness(8, [
      {
        groupId: 4,
        memberUserId: null,
        memberAccount: 'remote',
      },
    ]);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('STALE');
    expect(
      harness.relationshipMutations.writeMemberRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
    expect(
      harness.relationshipMutations.writeGroupRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
  });
});

describe('FederationProfileService resource path', () => {
  const canonicalProof = (account: string, domain: string) =>
    Buffer.from(JSON.stringify({ account, domain })).toString('base64');

  it('percent-encodes the account and sends a possession challenge under the pinned root', async () => {
    const { profiles, peerHttp, pinnedRoot } = makeStubs();
    const getSigned = vi.fn().mockImplementation(async (path: string) => {
      const url = new URL(`https://peer.test${path}`);
      expect(url.pathname).toBe('/s2s/v1/accounts/%21group');
      expect(url.searchParams.get('publicKey')).toBe(pinnedRoot);
      expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9+/=]+$/);
      return {
        account: '!group',
        displayName: 'Group',
        bio: '',
        avatar: null,
        profileRev: 1,
        proof: canonicalProof('!group', 'peer.test'),
      };
    });
    Object.assign(peerHttp, { get: getSigned });

    await profiles.fetchRemoteAccount(
      { account: '!group', domain: 'peer.test' },
      { kind: 'PIN' },
    );

    expect(getSigned).toHaveBeenCalledTimes(1);
  });

  it('challenges under the vouched root for card references', async () => {
    const { profiles, peerHttp } = makeStubs();
    const VOUCHED_ROOT = Buffer.from(
      ed25519.getPublicKey(Uint8Array.from(Buffer.alloc(32, 2))),
    ).toString('base64');
    const getSigned = vi.fn().mockImplementation(async (path: string) => {
      const url = new URL(`https://peer.test${path}`);
      expect(url.searchParams.get('publicKey')).toBe(VOUCHED_ROOT);
      return {
        account: 'alice',
        displayName: 'Alice',
        bio: '',
        avatar: null,
        profileRev: 1,
        proof: canonicalProof('alice', 'peer.test'),
      };
    });
    Object.assign(peerHttp, { get: getSigned });
    Object.assign(profiles, {
      profileNamespace: {
        readOne: vi.fn(async () => ({
          publisherNamespaceId: 12,
          profileNamespaceId: 5,
          domain: 'peer.test',
          rootPublicKey: VOUCHED_ROOT,
          updateFeedId: '4',
          expired: false,
        })),
      },
    });

    await profiles.fetchRemoteAccount(
      { account: 'alice', domain: 'peer.test' },
      {
        kind: 'VOUCH',
        publisherNamespaceId: 12,
        profileNamespaceId: 5,
        publicKey: VOUCHED_ROOT,
      },
    );
    expect(getSigned).toHaveBeenCalledTimes(1);
  });

  it('rejects an uncertifiable vouch without contacting the peer', async () => {
    const { profiles, peerHttp } = makeStubs();
    const getSigned = vi.fn();
    Object.assign(peerHttp, { get: getSigned });
    Object.assign(profiles, {
      profileNamespace: {
        readOne: vi.fn(async () => ({
          publisherNamespaceId: 12,
          profileNamespaceId: 5,
          domain: null,
          rootPublicKey: null,
          updateFeedId: '0',
          expired: true,
        })),
      },
    });
    await expect(
      profiles.fetchRemoteAccount(
        { account: 'alice', domain: 'peer.test' },
        {
          kind: 'VOUCH',
          publisherNamespaceId: 12,
          profileNamespaceId: 5,
          publicKey: 'v'.repeat(43) + '=',
        },
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
    });
    expect(getSigned).not.toHaveBeenCalled();
  });

  it('rejects a possession proof mismatch', async () => {
    const { profiles, peerHttp } = makeStubs();
    Object.assign(peerHttp, {
      get: vi.fn().mockResolvedValue({
        account: 'alice',
        displayName: 'Alice',
        bio: '',
        avatar: null,
        profileRev: 1,
        proof: canonicalProof('alice', 'other.test'),
      }),
    });
    await expect(
      profiles.fetchRemoteAccount(
        { account: 'alice', domain: 'peer.test' },
        { kind: 'PIN' },
      ),
    ).rejects.toMatchObject({
      code: BusinessCode.FEDERATION_MALFORMED,
      status: 200,
    });
  });

  it('rejects a public response that echoes namespaceId or has the wrong identity', async () => {
    const { profiles, peerHttp } = makeStubs();
    const getSigned = vi.fn().mockResolvedValue({
      namespaceId: 0,
      account: 'alice',
      domain: 'peer.test',
      displayName: 'Alice',
      bio: '',
      avatar: null,
      profileRev: 1,
    });
    Object.assign(peerHttp, { get: getSigned });
    await expect(
      profiles.fetchRemoteAccount(
        { account: 'alice', domain: 'peer.test' },
        { kind: 'PIN' },
      ),
    ).rejects.toMatchObject({
      code: BusinessCode.FEDERATION_MALFORMED,
      status: 200,
    });
  });

  it.each([0, -1])(
    'rejects a non-positive public profile revision (%i)',
    async (profileRev) => {
      const { profiles, peerHttp } = makeStubs();
      const getSigned = vi.fn().mockResolvedValue({
        account: 'alice',
        displayName: 'Alice',
        bio: '',
        avatar: null,
        profileRev,
        proof: canonicalProof('alice', 'peer.test'),
      });
      Object.assign(peerHttp, { get: getSigned });

      await expect(
        profiles.fetchRemoteAccount(
          { account: 'alice', domain: 'peer.test' },
          { kind: 'PIN' },
        ),
      ).rejects.toMatchObject({
        code: BusinessCode.FEDERATION_MALFORMED,
        status: 200,
      });
    },
  );

  it('projects the public profile with the canonical inline avatar shape', async () => {
    const { profiles } = makeStubs();
    const bytes = Buffer.from('avatar');
    const readAvatarAsWire = vi.fn().mockResolvedValue({
      b64: bytes.toString('base64'),
      w: 32,
      h: 24,
      mimeType: 'image/webp',
    });
    Object.assign(profiles, { upload: { readAvatarAsWire } });

    await expect(
      profiles.toS2SProfile({
        profileNamespaceId: 12,
        account: 'alice',
        name: 'Alice',
        avatar: '/uploads/avatars/alice.webp',
        bio: '',
        profileRev: 7,
      }),
    ).resolves.toEqual({
      namespaceId: 12,
      account: 'alice',
      displayName: 'Alice',
      bio: '',
      avatar: {
        mimeType: 'image/webp',
        base64: bytes.toString('base64'),
        width: 32,
        height: 24,
      },
      profileRev: 7,
    });
  });

  it('maps a validated public avatar into the internal avatar pipeline', async () => {
    const { profiles } = makeStubs();
    const bytes = Buffer.from('avatar');
    const saveAvatarFromWire = vi.fn().mockResolvedValue('/avatar.webp');
    const target = profiles as unknown as {
      upload: { saveAvatarFromWire: typeof saveAvatarFromWire };
      prepareForeignProfileData(profile: {
        account: string;
        displayName: string;
        bio: string;
        avatar: {
          mimeType: string;
          base64: string;
          width: number;
          height: number;
        };
        profileRev: number;
      }): Promise<unknown>;
    };
    target.upload = { saveAvatarFromWire };

    await expect(
      target.prepareForeignProfileData({
        account: 'alice',
        displayName: 'Alice',
        bio: '',
        avatar: {
          mimeType: 'image/webp',
          base64: bytes.toString('base64'),
          width: 32,
          height: 24,
        },
        profileRev: 7,
      }),
    ).resolves.toEqual({
      name: 'Alice',
      bio: '',
      avatar: '/avatar.webp',
    });
    expect(saveAvatarFromWire).toHaveBeenCalledExactlyOnceWith({
      b64: bytes.toString('base64'),
      w: 32,
      h: 24,
      mimeType: 'image/webp',
    });
  });
});

/** Build the peer-facing federation services wired with hand-rolled fakes (the project's spec
 *  style — direct construction, not the Nest DI container). */
function makeStubs() {
  const store = {
    messageThread: { findUnique: vi.fn() },
    accountThreadState: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
    mediaAsset: { findFirst: vi.fn() },
    deletedParticipant: { findFirst: vi.fn() },
  };
  const sse = {};
  const deletedMessages = {
    applyFederated: vi.fn(),
  };
  const eventEmitter = {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
  };
  const recognition = {
    markReachable: vi.fn(),
    markTransportDegraded: vi.fn(),
  };
  const signature = { signOutbound: vi.fn(() => ({})) };
  const discovery = {
    resolveBase: vi.fn(async () => 'https://peer.test'),
    acquireRequestSlot: vi.fn(async () => () => undefined),
    request: (...args: Parameters<typeof fetch>) => fetch(...args),
  };
  const transportConfig = {
    get: () => ({
      keyCacheTtlSec: 21_600,
      connectTimeoutSec: 12,
      callTimeoutSec: 12,
      mediaChunkBytes: 8 * 1024 * 1024,
      mediaChunkTimeoutSec: 120,
      mediaMaxChunkRetries: 5,
    }),
  };
  const database = {
    db: {
      // Rewired per scenario (some tests swap in their own transaction runner).
      transaction: vi.fn(),
      execute: vi.fn().mockResolvedValue({ rows: [{ authorized: true }] }),
      select: vi.fn(() => {
        let source: unknown;
        const resolve = async () => {
          if (source === identityNamespace)
            return [{ rootPublicKey: PINNED_ROOT }];
          if (source === messageThread) {
            const row = await store.messageThread.findUnique();
            return row
              ? [{ type: row.groupUser ? 'GROUP' : 'P2P' }]
              : [];
          }
          if (source === threadAudience)
            return [
              ...new Set(
                (await store.accountThreadState.findMany())
                  .map(
                    (participant: { user: { namespaceId: number } }) =>
                      participant.user.namespaceId,
                  )
                  .filter((namespaceId: number) => namespaceId !== 0),
              ),
            ].map((namespaceId) => ({ namespaceId }));
          return [];
        };
        const query = {
          from: (table: unknown) => {
            source = table;
            return query;
          },
          leftJoin: () => query,
          innerJoin: () => query,
          where: () => query,
          limit: () => query,
          then: (
            resolveResult: (rows: unknown[]) => unknown,
            reject: (reason: unknown) => unknown,
          ) => resolve().then(resolveResult, reject),
        };
        return query;
      }),
      query: {
        messageThread: {
          findFirst: async (...args: unknown[]) => {
            const row = await store.messageThread.findUnique(...args);
            return row ? { ...row, user: row.groupUser } : row;
          },
        },
        accountThreadState: {
          findMany: store.accountThreadState.findMany,
          findFirst: store.deletedParticipant.findFirst,
        },
        message: {
          findMany: async (...args: unknown[]) =>
            (await store.message.findMany(...args)).map(
              (row: Record<string, unknown>) => ({
                ...row,
                user: row.creatorItem,
              }),
            ),
        },
        mediaAsset: {
          findFirst: store.mediaAsset.findFirst,
        },
      },
    },
  };
  const peerLifecycle = new FederationPeerLifecycle(
    database as never,
    recognition as never,
    discovery as never,
  );
  const peerHttp = new FederationPeerHttp(
    signature as never,
    discovery as never,
    recognition as never,
    transportConfig as never,
    peerLifecycle,
  );
  const mediaRangeClient = new FederationMediaRangeClient(
    signature as never,
    discovery as never,
    recognition as never,
    transportConfig as never,
    peerLifecycle,
  );
  const inboundMediaBatches = new FederationInboundMediaBatchService(
    database as never,
    {} as never,
    {} as never,
    mediaRangeClient,
    sse as never,
  );
  const users = new FederationUserDirectoryService(database as never);
  const participantService = {};
  const quota = {};
  const forwardBundles = {};
  const callBridge = new FederationCallBridgeService(
    peerHttp,
    users,
    participantService as never,
    quota as never,
    eventEmitter as never,
  );
  const namespaces = {
    captureActive: vi.fn(async (domain: string) => ({
      domain,
      namespaceId: 1,
      rootKeyFingerprint: 'peer-root',
    })),
    captureActiveInTx: vi.fn(async (_tx: unknown, domain: string) => ({
      domain,
      namespaceId: 1,
      rootKeyFingerprint: 'peer-root',
    })),
    requireCapturedInTx: vi.fn(),
  };
  const threadAccess = new FederationThreadAccessService(
    database as never,
    namespaces as never,
  );
  const trustedPeers = new FederationTrustedPeerClient(peerHttp, peerLifecycle);
  const threadResources = new FederationThreadResourceClient(
    trustedPeers,
    threadAccess,
  );
  const upload = {};
  const PINNED_ROOT = Buffer.from(
    ed25519.getPublicKey(Uint8Array.from(Buffer.alloc(32, 1))),
  ).toString('base64');
  const profileNamespace = {
    readOne: vi.fn(async () => undefined),
    resolveBatch: vi.fn(async () => ({ entries: [], pendingRefreshes: [] })),
  };
  const refresh = {
    fetch: vi.fn(async () => undefined),
  };
  const profiles = new FederationProfileService(
    database as never,
    upload as never,
    peerHttp,
    profileNamespace as never,
    refresh as never,
  );
  const inboundMessageStore = new FederationInboundMessageStoreService(
    threadAccess,
    forwardBundles as never,
    quota as never,
    deletedMessages as never,
  );
  const inboundMessageRoutes = new FederationInboundMessageRouteService();
  const inboundMessageValidator =
    new FederationInboundMessageValidatorService();
  const inboundMessagePages = new FederationInboundMessagePageService(
    threadAccess,
    inboundMessageValidator,
    inboundMessageRoutes,
    inboundMessageStore,
  );
  const peerResources = new FederationPeerResourceService(
    database as never,
    forwardBundles as never,
  );
  const inboundMessageCommits = new FederationInboundMessageCommitService(
    database as never,
    threadAccess,
    inboundMessagePages,
    inboundMessageRoutes,
    deletedMessages as never,
    inboundMediaBatches,
  );
  const threadQueryDenials = new FederationThreadQueryDenialService(
    database as never,
    {} as never, // relationshipIntents
    {} as never, // durableTasks
    {} as never, // userIntents
  );
  return {
    database,
    callBridge,
    profiles,
    profileNamespace,
    pinnedRoot: PINNED_ROOT,
    store,
    sse,
    deletedMessages,
    eventEmitter,
    recognition,
    peerHttp,
    mediaRangeClient,
    threadAccess,
    trustedPeers,
    threadResources,
    inboundMessageStore,
    peerResources,
    inboundMessageCommits,
    threadQueryDenials,
    inboundMessageRoutes,
    inboundMessageValidator,
    upload,
  };
}

describe('FederationCallBridgeService inbound call preflight', () => {
  it('short-circuits an incoming retry before resolving either account', async () => {
    const { callBridge, eventEmitter } = makeStubs();
    eventEmitter.emitAsync.mockResolvedValueOnce([true]);
    const frame = {
      callId: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'incoming' as const,
      mediaType: 'AUDIO' as const,
      payload: { callerAccount: 'alice', calleeAccount: 'bob' },
    };

    await callBridge.handleFrame(frame, 'peer.example', 3, 1_700_000_300);

    expect(eventEmitter.emitAsync).toHaveBeenCalledExactlyOnceWith(
      'call.frame.incoming.preflight',
      {
        peerDomain: 'peer.example',
        namespaceId: 3,
        frame: {
          callSid: frame.callId,
          callType: frame.mediaType,
          payload: {
            fromAccount: frame.payload.callerAccount,
            toAccount: frame.payload.calleeAccount,
          },
          op: frame.operation,
        },
      },
    );
  });
});

describe('FederationMediaRangeClient optional range digest', () => {
  function target() {
    const { mediaRangeClient, recognition } = makeStubs();
    return { mediaRangeClient, recognition };
  }

  it('accepts a valid 206 range when the peer omits the optional digest', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('abc', {
        status: 206,
        headers: { 'content-range': 'bytes 0-2/3' },
      }),
    );
    await expect(
      target().mediaRangeClient.requestUnit(
        new URL('https://peer.test/file'),
        'peer.test',
        0,
        2,
      ),
    ).resolves.toMatchObject({ contentDigest: undefined });
    fetchMock.mockRestore();
  });

  it('rejects a supplied malformed range digest', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('abc', {
        status: 206,
        headers: {
          'content-range': 'bytes 0-2/3',
          'content-digest': 'not-a-digest',
        },
      }),
    );
    await expect(
      target().mediaRangeClient.requestUnit(
        new URL('https://peer.test/file'),
        'peer.test',
        0,
        2,
      ),
    ).rejects.toThrow('invalid Content-Digest');
    fetchMock.mockRestore();
  });

  it('surfaces an HTTP 200 JSON NOT_FOUND as a business error without demoting', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: BusinessCode.NOT_FOUND,
          message: 'file unavailable',
          data: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { mediaRangeClient, recognition } = target();
    await expect(
      mediaRangeClient.requestUnit(
        new URL('https://peer.test/file'),
        'peer.test',
        0,
        2,
      ),
    ).rejects.toMatchObject({ status: 200, code: BusinessCode.NOT_FOUND });
    expect(recognition.markReachable).toHaveBeenCalledOnce();
    expect(recognition.markTransportDegraded).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('accepts only the registered JSON envelope for a 416 response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE,
          message: 'requested range is not satisfiable',
          data: null,
        }),
        {
          status: 416,
          headers: {
            'content-type': 'application/json',
            'content-range': 'bytes */3',
          },
        },
      ),
    );
    await expect(
      target().mediaRangeClient.requestUnit(
        new URL('https://peer.test/file'),
        'peer.test',
        3,
        5,
      ),
    ).rejects.toMatchObject({
      status: 416,
      code: BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE,
    });
    fetchMock.mockRestore();
  });
});

describe('FederationPeerHttp JSON error data', () => {
  it('preserves structured data from an HTTP 200 business error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
          message: 'peer quota exceeded',
          data: { retryAfter: 60 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { peerHttp } = makeStubs();

    await expect(peerHttp.get('/resource', 'peer.test')).rejects.toMatchObject({
      status: 200,
      code: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
      data: { retryAfter: 60 },
    });
    fetchMock.mockRestore();
  });
});

describe('FederationPeerResourceService CAS error classification', () => {
  const digest = 'f'.repeat(64);

  function target() {
    const { peerResources, store } = makeStubs();
    return {
      resolveCasFile: peerResources.resolveCasFile.bind(peerResources),
      store,
    };
  }

  it('reports a missing database record as the NOT_FOUND business outcome', async () => {
    const { resolveCasFile, store } = target();
    store.mediaAsset.findFirst.mockResolvedValueOnce(undefined);

    await expect(resolveCasFile(digest)).rejects.toMatchObject({
      status: 200,
      bizCode: BusinessCode.NOT_FOUND,
    });
  });

  it('reports a missing CAS file as the NOT_FOUND business outcome', async () => {
    const { resolveCasFile, store } = target();
    store.mediaAsset.findFirst.mockResolvedValueOnce({ bytes: 1n });

    await expect(resolveCasFile(digest)).rejects.toMatchObject({
      status: 200,
      bizCode: BusinessCode.NOT_FOUND,
    });
  });

  it('reports an indeterminate database failure as a retryable service error', async () => {
    const { resolveCasFile, store } = target();
    store.mediaAsset.findFirst.mockRejectedValueOnce(new Error('offline'));

    await expect(resolveCasFile(digest)).rejects.toMatchObject({
      status: 503,
      bizCode: BusinessCode.INTERNAL,
    });
  });
});

describe('FederationPeerResourceService media authorization gates', () => {
  function target(options: {
    currentAudience: boolean;
    historicalPair: boolean;
    assetBound?: boolean;
  }) {
    const candidateWhere = vi.fn().mockResolvedValue(
      options.currentAudience
        ? [
            {
              messageId: 17n,
              threadId: 11,
              authorNamespaceId: 4,
              threadType: MessageThreadType.P2P,
              groupId: null,
            },
          ]
        : [],
    );
    const pairLimit = vi
      .fn()
      .mockResolvedValue(options.historicalPair ? [{ id: 3n }] : []);
    const select = vi.fn().mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: candidateWhere,
        }),
      }),
    });
    if (options.currentAudience) {
      select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: pairLimit }),
        }),
      });
    }
    const database = {
      db: {
        select,
        query: {
          messageAsset: {
            findFirst: vi
              .fn()
              .mockResolvedValue(
                options.assetBound === false ? null : { messageId: 17n },
              ),
          },
          forwardMessage: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
        },
      },
    };
    const service = new FederationPeerResourceService(
      database as never,
      {} as never,
    );
    vi.spyOn(service, 'resolveCasFile').mockResolvedValue({
      absPath: '/cas/asset',
      bytes: 4,
    });
    return { service, select };
  }

  it('requires current thread query authorization before inspecting historical coordinates', async () => {
    const { service, select } = target({
      currentAudience: false,
      historicalPair: true,
    });

    await expect(
      service.resolveMediaFile(
        'sender',
        'recipient',
        'local',
        'peer.example',
        4,
        'f'.repeat(64),
        9,
      ),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
    expect(select).toHaveBeenCalledOnce();
  });

  it('requires the P2P recipient to match the retained relationship pair', async () => {
    const { service, select } = target({
      currentAudience: true,
      historicalPair: false,
    });

    await expect(
      service.resolveMediaFile(
        'sender',
        'recipient',
        'local',
        'peer.example',
        4,
        'f'.repeat(64),
        9,
      ),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('rejects a digest that is not bound to the authorized source message', async () => {
    const { service } = target({
      currentAudience: true,
      historicalPair: true,
      assetBound: false,
    });

    await expect(
      service.resolveMediaFile(
        'sender',
        'recipient',
        'local',
        'peer.example',
        4,
        'f'.repeat(64),
        9,
      ),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
  });

  it('serves a message-bound asset after both authorization gates pass', async () => {
    const { service } = target({
      currentAudience: true,
      historicalPair: true,
    });

    await expect(
      service.resolveMediaFile(
        'sender',
        'recipient',
        'local',
        'peer.example',
        4,
        'f'.repeat(64),
        9,
      ),
    ).resolves.toEqual({ absPath: '/cas/asset', bytes: 4 });
  });
});

describe('FederationThreadResourceClient preflight', () => {
  function installPreflight(state?: { id: number }) {
    const { threadResources, trustedPeers, database } = makeStubs();
    const limit = vi.fn().mockResolvedValue(state ? [state] : []);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select }),
    );
    (database.db as { transaction?: typeof transaction }).transaction =
      transaction;
    const getSigned = vi.fn().mockResolvedValue({ messages: [] });
    Object.assign(trustedPeers, { get: getSigned });
    return { target: threadResources, getSigned, select, transaction };
  }

  it('captures the active namespace before asserting the thread exists', async () => {
    const { target, getSigned, select, transaction } = installPreflight({
      id: 10,
    });

    await expect(
      target.read<{ messages: unknown[] }>(10, '/messages', 'peer.test'),
    ).resolves.toEqual({ data: { messages: [] } });
    expect(transaction).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(getSigned).toHaveBeenCalledWith('/messages', 'peer.test', undefined);
  });

  it('does not send when the thread is missing', async () => {
    const { target, getSigned } = installPreflight();

    await expect(target.read(10, '/messages', 'peer.test')).rejects.toThrow(
      'stale federation response for thread 10 from peer.test',
    );
    expect(getSigned).not.toHaveBeenCalled();
  });

  it('propagates an application error response unchanged', async () => {
    const { target, getSigned } = installPreflight({ id: 10 });
    getSigned.mockRejectedValueOnce(
      new S2sResponseError('gone', 200, BusinessCode.GROUP_DISSOLVED),
    );

    await expect(
      target.read(10, '/messages', 'peer.test'),
    ).rejects.toMatchObject({
      status: 200,
      code: BusinessCode.GROUP_DISSOLVED,
    });
  });

  it('returns the peer token with a fetched resource', async () => {
    const { target } = installPreflight({ id: 10 });

    await expect(
      target.fetch<{ messages: unknown[] }>(10, '/messages', 'peer.test'),
    ).resolves.toEqual({
      data: { messages: [] },
      threadId: 10,
      peerDomain: 'peer.test',
      peerToken: {
        domain: 'peer.test',
        namespaceId: 1,
        rootKeyFingerprint: 'peer-root',
      },
    });
  });
});

describe('FederationInboundMessageRouteService global missed transport', () => {
  it('resolves a remote message author as an address without creating a per-message User', async () => {
    const { inboundMessageRoutes } = makeStubs();
    const findUser = vi.fn();
    const insert = vi.fn();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ threadId: 10, toAccount: 'alice' }],
      })
      .mockResolvedValueOnce({ rows: [{ userId: 1 }] });
    const tx = {
      execute,
      insert,
      query: { user: { findFirst: findUser } },
    };
    const resolveMissedThread = (
      inboundMessageRoutes as unknown as {
        resolveMessage: (
          tx: unknown,
          item: unknown,
          sourceDomain: string,
          namespaceId: number,
          peerAssignedLocalNamespaceId: number,
        ) => Promise<unknown>;
      }
    ).resolveMessage.bind(inboundMessageRoutes);

    await expect(
      resolveMissedThread(
        tx,
        {
          thread: { account: 'bob', peerAccount: 'alice' },
          author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
        },
        'peer.test',
        7,
        44,
      ),
    ).resolves.toEqual({
      threadId: 10,
      toAccount: 'alice',
      authority: 'PEER',
      creatorAccount: 'bob',
      profileNamespaceId: 0,
      recipients: [1],
    });
    expect(findUser).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('FederationThreadAccessService thread-bound response write gate', () => {
  function installWriteGate(state?: { id: number }) {
    const { threadAccess } = makeStubs();
    const limit = vi.fn().mockResolvedValue(state ? [state] : []);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const target = threadAccess as unknown as {
      assertResponseWritable: (
        tx: unknown,
        threadId: number,
        domain: string,
      ) => Promise<void>;
    };
    return {
      target,
      tx: { select },
      select,
    };
  }

  it('accepts the response while the thread still exists', async () => {
    const { target, tx, select } = installWriteGate({ id: 10 });

    await expect(
      target.assertResponseWritable(tx, 10, 'peer.test'),
    ).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledOnce();
  });

  it('rejects a response after the thread disappears', async () => {
    const { target, tx } = installWriteGate();

    await expect(
      target.assertResponseWritable(tx, 10, 'peer.test'),
    ).rejects.toThrow('stale federation response');
  });
});

describe('FederationThreadAccessService peer-bound response write gate', () => {
  const token = {
    domain: 'peer.test',
    namespaceId: 12,
    rootKeyFingerprint: 'sha256:root-a',
  };

  function installPeerGate() {
    const { threadAccess } = makeStubs();
    const requireCapturedInTx = vi.fn().mockResolvedValue(undefined);
    Object.assign(threadAccess, { namespaces: { requireCapturedInTx } });
    const target = threadAccess as unknown as {
      assertPeerResponseWritable: (
        tx: object,
        value: typeof token,
      ) => Promise<void>;
    };
    return { target, tx: {}, requireCapturedInTx };
  }

  it('checks the captured namespace before persisting a peer response', async () => {
    const { target, tx, requireCapturedInTx } = installPeerGate();

    await expect(
      target.assertPeerResponseWritable(tx, token),
    ).resolves.toBeUndefined();
    expect(requireCapturedInTx).toHaveBeenCalledWith(tx, token);
  });

  it('propagates rejection when the captured namespace is no longer valid', async () => {
    const { target, tx, requireCapturedInTx } = installPeerGate();
    requireCapturedInTx.mockRejectedValueOnce(
      new Error('captured namespace is unavailable'),
    );

    await expect(target.assertPeerResponseWritable(tx, token)).rejects.toThrow(
      'captured namespace is unavailable',
    );
  });
});
