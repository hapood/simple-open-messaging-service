import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

// loadFederationConfig() reads SOMS_DOMAIN via requireEnv at construction (field initializer), so it
// must be set before `new FederationService(...)`. Module-top runs before any test body.
process.env.SOMS_DOMAIN ??= 'chat.example';

import {
  clientGroupIntentEndpoints,
  FederationService,
  S2sResponseError,
} from './federation.service.js';
import { BusinessCode } from '../common/business-code.js';
import { ContentType, MessageThreadType } from '../database/enums.js';
import { UploadService } from '../upload/upload.service.js';
import { messageThread, threadAudience } from '../database/schema.js';
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
import { FederationMediaLocalizationService } from './federation-media-localization.service.js';
import { FederationInboundMessageStoreService } from './federation-inbound-message-store.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';
import { FederationInboundMessagePageService } from './federation-inbound-message-page.service.js';
import { FederationPeerResourceService } from './federation-peer-resource.service.js';
import { FederationInboundMessageCommitService } from './federation-inbound-message-commit.service.js';
import { FederationOutboundMessageSignalService } from './federation-outbound-message-signal.service.js';
import { FederationThreadQueryDenialService } from './federation-thread-query-denial.service.js';

describe('federated contact-card avatar limits', () => {
  const digest = 'a'.repeat(64);
  const content = JSON.stringify({
    account: 'alice',
    domain: 'peer.test',
    displayName: 'Alice',
    bio: '',
    avatarDigest: digest,
  });

  function validate(bytes: number) {
    const { svc } = makeStubs();
    const target = svc as unknown as {
      assertMissedAssetDescriptors(item: unknown): void;
    };
    target.assertMissedAssetDescriptors({
      contentType: ContentType.CONTACT_CARD,
      content,
      assets: [{ digest, bytes }],
    });
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

describe('client group intent compaction identity', () => {
  it('keeps group-authored and member-authored intents as distinct directed facts', () => {
    expect(clientGroupIntentEndpoints('!dev', 'alice', 'GROUP')).toEqual({
      account: '!dev',
      subjectAccount: 'alice',
    });
    expect(clientGroupIntentEndpoints('!dev', 'alice', 'MEMBER')).toEqual({
      account: 'alice',
      subjectAccount: '!dev',
    });
  });
});

describe('thread-query FORBIDDEN convergence', () => {
  function forbiddenHarness(epoch: number) {
    const tx = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ localUserId: 1, remoteUserId: 2 }],
      }),
      query: {
        messageThread: {
          findFirst: vi.fn().mockResolvedValue({ authorizationEpoch: epoch }),
        },
      },
    };
    const allocated = new Map([['peer.test', 9n]]);
    const relationshipIntents = {
      readP2PRelationshipInTx: vi.fn().mockResolvedValue({
        pair: { active: true, threadId: 31 },
        firstIntent: { status: 'ACCEPTED' },
        secondIntent: { status: 'ACCEPTED' },
      }),
    };
    const relationshipMutations = {
      writeP2PIntentInTx: vi.fn().mockResolvedValue(allocated),
    };
    const clientStateFeed = { notifyFeedUpdates: vi.fn() };
    const service = new FederationThreadQueryDenialService(
      {
        db: { transaction: (run: (value: unknown) => unknown) => run(tx) },
      } as never,
      relationshipIntents as never,
      relationshipMutations as never,
      clientStateFeed as never,
      { emit: vi.fn() } as never,
    );
    return {
      service,
      tx,
      relationshipIntents,
      relationshipMutations,
      clientStateFeed,
    };
  }

  function groupForbiddenHarness(
    epoch: number,
    members: Array<{
      groupId: number;
      groupDomain: string;
      memberUserId: number;
    }>,
  ) {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              groupAccount: '!group',
              groupDomain: members[0]?.groupDomain ?? 'peer.test',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ authorizationEpoch: epoch }] })
        .mockResolvedValueOnce({ rows: members }),
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
    const service = new FederationThreadQueryDenialService(
      {
        db: { transaction: (run: (value: unknown) => unknown) => run(tx) },
      } as never,
      relationshipIntents as never,
      relationshipMutations as never,
      clientStateFeed as never,
      { emit: vi.fn() } as never,
    );
    return {
      service,
      tx,
      relationshipIntents,
      relationshipMutations,
      clientStateFeed,
    };
  }

  it('revokes only the local P2P direction under the frozen epoch', async () => {
    const harness = forbiddenHarness(7);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('P2P_REVOKED');
    expect(
      harness.relationshipMutations.writeP2PIntentInTx,
    ).toHaveBeenCalledWith(harness.tx, 1, 2, false, '', expect.any(Array));
    expect(harness.clientStateFeed.notifyFeedUpdates).toHaveBeenCalledOnce();
  });

  it('does not let an old denied round revoke a newer authorization epoch', async () => {
    const harness = forbiddenHarness(8);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('STALE');
    expect(
      harness.relationshipMutations.writeP2PIntentInTx,
    ).not.toHaveBeenCalled();
  });

  it('revokes every local member direction for a remotely owned group', async () => {
    const harness = groupForbiddenHarness(7, [
      { groupId: 4, groupDomain: 'peer.test', memberUserId: 1 },
      { groupId: 4, groupDomain: 'peer.test', memberUserId: 3 },
    ]);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('GROUP_REVOKED');
    expect(
      harness.relationshipMutations.lockGroupMutationInTx,
    ).toHaveBeenCalledWith(harness.tx, 31, 1, [1, 3]);
    expect(
      harness.relationshipIntents.lockGroupBusinessScopeInTx,
    ).toHaveBeenCalledWith(harness.tx, {
      account: '!group',
      domain: 'peer.test',
    });
    expect(
      harness.relationshipMutations.writeMemberRelationshipIntentInTx,
    ).toHaveBeenCalledTimes(2);
    expect(
      harness.relationshipMutations.writeMemberRelationshipIntentInTx,
    ).toHaveBeenNthCalledWith(
      1,
      harness.tx,
      31,
      1,
      'REVOKED',
      expect.any(Array),
    );
    expect(
      harness.relationshipMutations.writeMemberRelationshipIntentInTx,
    ).toHaveBeenNthCalledWith(
      2,
      harness.tx,
      31,
      3,
      'REVOKED',
      expect.any(Array),
    );
    expect(
      harness.relationshipMutations.writeGroupRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
  });

  it('revokes every local-group direction for members hosted by the denied peer', async () => {
    const harness = groupForbiddenHarness(7, [
      { groupId: 4, groupDomain: 'local', memberUserId: 2 },
      { groupId: 4, groupDomain: 'local', memberUserId: 5 },
    ]);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('GROUP_REVOKED');
    expect(
      harness.relationshipMutations.writeGroupRelationshipIntentInTx,
    ).toHaveBeenCalledTimes(2);
    expect(
      harness.relationshipMutations.writeGroupRelationshipIntentInTx,
    ).toHaveBeenNthCalledWith(
      1,
      harness.tx,
      31,
      2,
      '',
      'REVOKED',
      expect.any(Array),
    );
    expect(
      harness.relationshipMutations.writeGroupRelationshipIntentInTx,
    ).toHaveBeenNthCalledWith(
      2,
      harness.tx,
      31,
      5,
      '',
      'REVOKED',
      expect.any(Array),
    );
    expect(
      harness.relationshipMutations.writeMemberRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
  });

  it('does not revoke group directions when the frozen epoch is stale', async () => {
    const harness = groupForbiddenHarness(8, [
      { groupId: 4, groupDomain: 'peer.test', memberUserId: 1 },
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
  it('canonically percent-encodes a group account', async () => {
    const { profiles, peerHttp } = makeStubs();
    const getSigned = vi.fn().mockResolvedValue({ profileRev: 1 });
    Object.assign(peerHttp, { get: getSigned });

    await profiles.fetchRemoteAccount({
      account: '!group',
      domain: 'peer.test',
    });

    expect(getSigned).toHaveBeenCalledWith(
      '/s2s/v1/accounts/%21group',
      'peer.test',
    );
  });

  it.each([0, -1])(
    'rejects a non-positive public profile revision (%i)',
    async (profileRev) => {
      const { profiles, peerHttp } = makeStubs();
      const getSigned = vi.fn().mockResolvedValue({ profileRev });
      Object.assign(peerHttp, { get: getSigned });

      await expect(
        profiles.fetchRemoteAccount({ account: 'alice', domain: 'peer.test' }),
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
        account: 'alice',
        name: 'Alice',
        avatar: '/uploads/avatars/alice.webp',
        bio: '',
        profileRev: 7,
      }),
    ).resolves.toEqual({
      account: 'alice',
      domain: 'chat.example',
      displayName: 'Alice',
      bio: '',
      avatar: {
        digest: createHash('sha256').update(bytes).digest('hex'),
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
        domain: string;
        displayName: string;
        bio: string;
        avatar: {
          digest: string;
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
        domain: 'peer.test',
        displayName: 'Alice',
        bio: '',
        avatar: {
          digest: createHash('sha256').update(bytes).digest('hex'),
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
      defaultProfileRev: 7,
    });
    expect(saveAvatarFromWire).toHaveBeenCalledExactlyOnceWith({
      b64: bytes.toString('base64'),
      w: 32,
      h: 24,
      mimeType: 'image/webp',
    });
  });
});

describe('federated group join request', () => {
  it('writes the request with the resolved card snapshot without prefetching the remote profile', async () => {
    const { svc, database } = makeStubs();
    const fetchRemoteAccount = vi.fn();
    const ensureShell = vi.fn().mockResolvedValue({
      groupId: 17,
      threadId: 23,
    });
    const writeIntent = vi.fn().mockResolvedValue(new Map([['peer.test', 5n]]));
    const pushStateFeedDomains = vi.fn().mockResolvedValue(undefined);
    database.db.transaction = vi.fn(async (operation) => operation({}));
    const target = svc as unknown as {
      fetchRemoteAccount: typeof fetchRemoteAccount;
      stateFeedConsumer: {
        ensureFederatedGroupRequestShellInTx: typeof ensureShell;
      };
      relationshipMutations: {
        writeMemberRelationshipIntentInTx: typeof writeIntent;
      };
      clientStateFeed: { notifyFeedUpdates: () => void };
      pushStateFeedDomains: typeof pushStateFeedDomains;
    };
    target.fetchRemoteAccount = fetchRemoteAccount;
    target.stateFeedConsumer = {
      ensureFederatedGroupRequestShellInTx: ensureShell,
    };
    target.relationshipMutations = {
      writeMemberRelationshipIntentInTx: writeIntent,
    };
    target.clientStateFeed = { notifyFeedUpdates: vi.fn() };
    target.pushStateFeedDomains = pushStateFeedDomains;

    await svc.requestFederatedGroupJoin(
      11,
      { account: '!group', domain: 'peer.test' },
      'hello',
      {
        displayName: 'Remote Group',
        avatar: 'group-avatar',
      },
    );

    expect(fetchRemoteAccount).not.toHaveBeenCalled();
    expect(ensureShell).toHaveBeenCalledWith(
      expect.anything(),
      '!group',
      'peer.test',
      1,
    );
    expect(writeIntent).toHaveBeenCalledWith(
      expect.anything(),
      23,
      11,
      'REQUESTED',
      expect.any(Array),
      'hello',
      {
        displayName: 'Remote Group',
        avatar: 'group-avatar',
      },
    );
    expect(pushStateFeedDomains).toHaveBeenCalledWith(
      expect.objectContaining({ [Symbol.iterator]: expect.any(Function) }),
    );
  });

  it('delegates remote-group revocation without a second client-feed write', async () => {
    const { svc, database } = makeStubs();
    const tx = {
      query: {
        group: {
          findFirst: vi.fn().mockResolvedValue({ id: 17 }),
        },
        messageThread: {
          findFirst: vi.fn().mockResolvedValue({ id: 23 }),
        },
      },
    };
    const writeIntent = vi.fn().mockResolvedValue(new Map([['peer.test', 6n]]));
    const notifyFeedUpdates = vi.fn();
    const writeClientFeed = vi.fn();
    const pushStateFeedDomains = vi.fn().mockResolvedValue(undefined);
    database.db.transaction = vi.fn(async (operation) => operation(tx));
    const target = svc as unknown as {
      relationshipMutations: {
        writeMemberRelationshipIntentInTx: typeof writeIntent;
      };
      clientStateFeed: {
        notifyFeedUpdates: typeof notifyFeedUpdates;
        writeInTx: typeof writeClientFeed;
      };
      pushStateFeedDomains: typeof pushStateFeedDomains;
    };
    target.relationshipMutations = {
      writeMemberRelationshipIntentInTx: writeIntent,
    };
    target.clientStateFeed = {
      notifyFeedUpdates,
      writeInTx: writeClientFeed,
    };
    target.pushStateFeedDomains = pushStateFeedDomains;

    await svc.revokeGroupJoinRequest(11, {
      account: '!group',
      domain: 'peer.test',
    });

    expect(writeIntent).toHaveBeenCalledWith(
      tx,
      23,
      11,
      'REVOKED',
      expect.any(Array),
    );
    expect(writeClientFeed).not.toHaveBeenCalled();
    expect(notifyFeedUpdates).toHaveBeenCalledWith(expect.any(Array));
    expect(pushStateFeedDomains).toHaveBeenCalledWith(
      expect.objectContaining({ [Symbol.iterator]: expect.any(Function) }),
    );
  });
});

/** Build a FederationService wired with hand-rolled fakes (the project's spec style — direct
 *  construction, not the Nest DI container). */
function makeStubs() {
  const store = {
    messageThread: { findUnique: vi.fn() },
    accountThreadState: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
    mediaAsset: { findFirst: vi.fn() },
    federationDeletedCursor: { findFirst: vi.fn().mockResolvedValue(null) },
    deletedParticipant: { findFirst: vi.fn() },
  };
  const sse = { onMediaStatus: vi.fn() };
  const deletedMessages = {
    applyFederated: vi.fn(),
    advanceFederatedCursor: vi.fn(),
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
      execute: vi.fn().mockResolvedValue({ rows: [{ authorized: true }] }),
      select: vi.fn(() => {
        let source: unknown;
        const resolve = async () => {
          if (source === messageThread) {
            const row = await store.messageThread.findUnique();
            return row
              ? [
                  {
                    type: row.groupUser ? 'GROUP' : 'P2P',
                    groupDomain: row.groupUser?.domain ?? null,
                  },
                ]
              : [];
          }
          if (source === threadAudience)
            return [
              ...new Set(
                (await store.accountThreadState.findMany())
                  .map((participant) => participant.user.domain)
                  .filter((domain) => domain !== 'local'),
              ),
            ].map((domain) => ({ domain }));
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
        federationDeletedCursor: {
          findFirst: store.federationDeletedCursor.findFirst,
        },
        message: {
          findMany: async (...args: unknown[]) =>
            (await store.message.findMany(...args)).map((row) => ({
              ...row,
              user: row.creatorItem,
            })),
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
    {} as never,
    sse as never,
    { signalMessage: vi.fn().mockResolvedValue(undefined) } as never,
  );
  const users = new FederationUserDirectoryService(database as never);
  const participantService = {};
  const quota = {};
  const forwardBundles = {};
  const callBridge = new FederationCallBridgeService(
    database as never,
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
  const profiles = new FederationProfileService(
    database as never,
    upload as never,
    peerHttp,
    threadAccess,
    users,
  );
  const mediaLocalization = new FederationMediaLocalizationService(
    database as never,
    upload as never,
    mediaRangeClient,
    {} as never, // messageVisibility
    forwardBundles as never,
    inboundMediaBatches,
    threadAccess,
  );
  const inboundMessageStore = new FederationInboundMessageStoreService(
    threadAccess,
    forwardBundles as never,
    quota as never,
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
  const statePull = {
    pullStateFromPeer: vi.fn().mockResolvedValue(5n),
  };
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
  const outboundMessageSignals = new FederationOutboundMessageSignalService(
    database as never,
    {} as never, // threadContentHeads
    eventEmitter as never,
  );
  const threadQueryDenials = new FederationThreadQueryDenialService(
    database as never,
    {} as never, // relationshipIntents
    {} as never, // relationshipMutations
    {} as never, // clientStateFeed
    eventEmitter as never,
  );
  const svc = new FederationService(
    database as never,
    peerLifecycle,
    mediaRangeClient,
    inboundMediaBatches,
    users,
    callBridge,
    threadAccess,
    profiles,
    mediaLocalization,
    inboundMessageRoutes,
    inboundMessageValidator,
    inboundMessagePages,
    statePull as never,
    {} as never, // localSystemMessages
    peerResources,
    inboundMessageCommits,
    outboundMessageSignals,
    threadQueryDenials,
    upload as never,
    participantService as never,
    {} as never, // invite
    quota as never,
    {} as never, // linkPreview
    forwardBundles as never,
    eventEmitter as never,
    {} as never, // stateFeed
    {} as never, // clientStateFeed
    {} as never, // relationshipIntents
    {} as never, // groupRelationships
    {} as never, // relationshipMutations
    namespaces as never,
    {} as never, // stateFeedConsumer
  );
  return {
    svc,
    database,
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
    profiles,
    inboundMessageStore,
    statePull,
    peerResources,
    inboundMessageCommits,
    outboundMessageSignals,
    threadQueryDenials,
    upload,
  };
}

describe('FederationService inbound call preflight', () => {
  it('short-circuits an incoming retry before resolving either account', async () => {
    const { svc, eventEmitter } = makeStubs();
    eventEmitter.emitAsync.mockResolvedValueOnce([true]);
    const frame = {
      callId: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'incoming' as const,
      mediaType: 'AUDIO' as const,
      payload: { callerAccount: 'alice', calleeAccount: 'bob' },
    };

    await svc.handleCallFrame(frame, 'peer.example', 3, 1_700_000_300);

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

describe('FederationService state-feed drain window', () => {
  it('delegates the bounded drain to the state-pull owner', async () => {
    const { svc, statePull } = makeStubs();

    await expect(svc.pullStateFromPeer('peer.test', 5n)).resolves.toBe(5n);

    expect(statePull.pullStateFromPeer).toHaveBeenCalledWith('peer.test', 5n);
  });
});

describe('FederationService optional range digest', () => {
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

describe('FederationService JSON error data', () => {
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
  }) {
    const candidateWhere = vi.fn().mockResolvedValue(
      options.currentAudience
        ? [
            {
              messageId: 17n,
              threadId: 11,
              authorDomain: 'local',
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
            findFirst: vi.fn().mockResolvedValue({ messageId: 17n }),
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
        'chat.example',
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
        'chat.example',
        'peer.example',
        4,
        'f'.repeat(64),
        9,
      ),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
    expect(select).toHaveBeenCalledTimes(2);
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
        'chat.example',
        'peer.example',
        4,
        'f'.repeat(64),
        9,
      ),
    ).resolves.toEqual({ absPath: '/cas/asset', bytes: 4 });
  });
});

describe('FederationThreadResourceClient preflight', () => {
  function installPreflight(state?: { federationVersion: number }) {
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

  it('captures the active namespace before carrying the thread authorization version', async () => {
    const { target, getSigned, select, transaction } = installPreflight({
      federationVersion: 7,
    });

    await expect(
      target.read<{ messages: unknown[] }>(10, '/messages', 'peer.test'),
    ).resolves.toEqual({ data: { messages: [] }, federationVersion: 7 });
    expect(transaction).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(getSigned).toHaveBeenCalledWith('/messages', 'peer.test', undefined);
  });

  it('does not send when the thread is missing', async () => {
    const { target, getSigned } = installPreflight();

    await expect(target.read(10, '/messages', 'peer.test')).rejects.toThrow(
      'federation thread 10 is unavailable',
    );
    expect(getSigned).not.toHaveBeenCalled();
  });

  it('attaches the captured version to an application error response', async () => {
    const { target, getSigned } = installPreflight({ federationVersion: 7 });
    getSigned.mockRejectedValueOnce(
      new S2sResponseError('gone', 200, BusinessCode.GROUP_DISSOLVED),
    );

    await expect(
      target.read(10, '/messages', 'peer.test'),
    ).rejects.toMatchObject({
      status: 200,
      code: BusinessCode.GROUP_DISSOLVED,
      federationVersion: 7,
    });
  });

  it('returns the peer token and thread version with a fetched resource', async () => {
    const { target } = installPreflight({ federationVersion: 7 });

    await expect(
      target.fetch<{ messages: unknown[] }>(10, '/messages', 'peer.test'),
    ).resolves.toEqual({
      data: { messages: [] },
      threadId: 10,
      peerDomain: 'peer.test',
      federationVersion: 7,
      peerToken: {
        domain: 'peer.test',
        namespaceId: 1,
        rootKeyFingerprint: 'peer-root',
      },
    });
  });
});

describe('FederationService global missed transport', () => {
  it('resolves a remote message author as an address without creating a per-message User', async () => {
    const { svc } = makeStubs();
    const findUser = vi.fn();
    const insert = vi.fn();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ threadId: 10, federationVersion: 3, toAccount: 'alice' }],
      })
      .mockResolvedValueOnce({ rows: [{ userId: 1 }] });
    const tx = {
      execute,
      insert,
      query: { user: { findFirst: findUser } },
    };
    const resolveMissedThread = (
      svc as unknown as {
        resolveMissedThreadInTransaction: (
          tx: unknown,
          item: unknown,
          sourceDomain: string,
        ) => Promise<unknown>;
      }
    ).resolveMissedThreadInTransaction.bind(svc);

    await expect(
      resolveMissedThread(
        tx,
        {
          thread: { account: 'bob', peerAccount: 'alice' },
          authorRef: 'THREAD_ACCOUNT',
        },
        'peer.test',
      ),
    ).resolves.toEqual({
      threadId: 10,
      federationVersion: 3,
      toAccount: 'alice',
      creatorAccount: 'bob',
      creatorDomain: 'peer.test',
      recipients: [1],
    });
    expect(findUser).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('FederationThreadAccessService thread-bound response write gate', () => {
  function installWriteGate(state?: { federationVersion: number }) {
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
        version: number,
      ) => Promise<void>;
    };
    return {
      target,
      tx: { select },
      select,
    };
  }

  it('accepts the response while the thread authorization version still matches', async () => {
    const { target, tx, select } = installWriteGate({
      federationVersion: 7,
    });

    await expect(
      target.assertResponseWritable(tx, 10, 'peer.test', 7),
    ).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledOnce();
  });

  it('rejects a response after the thread authorization version changes', async () => {
    const { target, tx } = installWriteGate({ federationVersion: 8 });

    await expect(
      target.assertResponseWritable(tx, 10, 'peer.test', 7),
    ).rejects.toThrow('stale federation response');
  });

  it('rejects a response after the thread disappears', async () => {
    const { target, tx } = installWriteGate();

    await expect(
      target.assertResponseWritable(tx, 10, 'peer.test', 7),
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


const localUser = (userId: number, account: string) => ({
  userId,
  user: { account, domain: 'local' },
});
const foreignUser = (userId: number, account: string, domain: string) => ({
  userId,
  user: { account, domain },
});

describe('FederationOutboundMessageSignalService — fixed-topology routing', () => {
  // A persisted pulled copy is exposed once to its direct source as a processing receipt. Normal
  // authority distribution excludes that source, so each destination is notified at most once.

  it('P2P: signals every foreign peer except the author', async () => {
    const { outboundMessageSignals, store } = makeStubs();
    const push = vi
      .spyOn(outboundMessageSignals as never, 'offerAndPush' as never)
      .mockResolvedValue(undefined as never);
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.accountThreadState.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await outboundMessageSignals.signalMessage(
      10,
      { account: 'alice', domain: 'local' },
      5,
      undefined,
    );

    expect(push.mock.calls).toEqual([
      ['b.com', 10, 5],
      ['c.com', 10, 5],
    ]);
  });

  it('P2P: returns a receipt to fetchedFromDomain and signals other destinations', async () => {
    const { outboundMessageSignals, store } = makeStubs();
    const push = vi
      .spyOn(outboundMessageSignals as never, 'offerAndPush' as never)
      .mockResolvedValue(undefined as never);
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.accountThreadState.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await outboundMessageSignals.signalMessage(
      10,
      { account: 'alice', domain: 'local' },
      5,
      'b.com',
    );

    expect(push.mock.calls).toEqual([
      ['b.com', 10, 5],
      ['c.com', 10, 5],
    ]);
  });

  it('GROUP origin: returns a receipt to the submission source and distributes to other mirrors', async () => {
    const { outboundMessageSignals, store } = makeStubs();
    const push = vi
      .spyOn(outboundMessageSignals as never, 'offerAndPush' as never)
      .mockResolvedValue(undefined as never);
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'local' },
    });
    // Two members on b.com (bob + dave) + one on c.com → dest set dedupes to {b.com, c.com}.
    store.accountThreadState.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(4, 'dave', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await outboundMessageSignals.signalMessage(
      10,
      { account: 'alice', domain: 'local' },
      7,
      undefined,
    );

    expect(push.mock.calls).toEqual([
      ['b.com', 10, 7],
      ['c.com', 10, 7],
    ]);

    // The source receives the acceptance copy as its receipt; other mirrors receive normal distribution.
    push.mockClear();
    await outboundMessageSignals.signalMessage(
      10,
      { account: 'alice', domain: 'local' },
      7,
      'b.com',
    );
    expect(push.mock.calls).toEqual([
      ['b.com', 10, 7],
      ['c.com', 10, 7],
    ]);
  });

  it('GROUP mirror: signals only the origin, including as a processing receipt', async () => {
    const { outboundMessageSignals, store } = makeStubs();
    const push = vi
      .spyOn(outboundMessageSignals as never, 'offerAndPush' as never)
      .mockResolvedValue(undefined as never);
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'origin.com' },
    });
    store.accountThreadState.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, '!grp', 'origin.com'),
    ]);

    // A mirror's sole destination is the origin (the hub it pulls from).
    await outboundMessageSignals.signalMessage(
      10,
      { account: 'alice', domain: 'local' },
      7,
      undefined,
    );
    expect(push).toHaveBeenCalledExactlyOnceWith('origin.com', 10, 7);

    // A copy pulled from the origin is queryable by that origin as a processing receipt.
    push.mockClear();
    await outboundMessageSignals.signalMessage(
      10,
      { account: 'alice', domain: 'local' },
      7,
      'origin.com',
    );
    expect(push).toHaveBeenCalledExactlyOnceWith('origin.com', 10, 7);
  });

  it('is a no-op when the thread is missing or the author is not a participant', async () => {
    const { outboundMessageSignals, store, database } = makeStubs();
    const push = vi
      .spyOn(outboundMessageSignals as never, 'offerAndPush' as never)
      .mockResolvedValue(undefined as never);

    store.messageThread.findUnique.mockResolvedValue(null);
    store.accountThreadState.findMany.mockResolvedValue([]);
    await outboundMessageSignals.signalMessage(
      10,
      { account: 'alice', domain: 'local' },
      5,
      undefined,
    );
    expect(push).not.toHaveBeenCalled();

    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.accountThreadState.findMany.mockResolvedValue([
      foreignUser(99, 'x', 'b.com'),
    ]);
    database.db.execute.mockResolvedValueOnce({
      rows: [{ authorized: false }],
    });
    await outboundMessageSignals.signalMessage(
      10,
      { account: 'alice', domain: 'local' },
      5,
      undefined,
    ); // alice@local is not in the roster
    expect(push).not.toHaveBeenCalled();
  });
});
