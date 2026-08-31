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
import { ContentType } from '../database/enums.js';
import { UploadService } from '../upload/upload.service.js';
import { messageThread, threadMember } from '../database/schema.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationUserDirectoryService } from './federation-user-directory.service.js';
import { FederationCallBridgeService } from './federation-call-bridge.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import { FederationThreadResourceClient } from './federation-thread-resource-client.service.js';

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
    const relationshipCommands = {
      writeFriendIntentInTx: vi.fn().mockResolvedValue(allocated),
    };
    const clientStateFeed = { notifyFeedUpdates: vi.fn() };
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    Object.assign(service, {
      database: {
        db: { transaction: (run: (value: unknown) => unknown) => run(tx) },
      },
      relationshipIntents,
      relationshipCommands,
      clientStateFeed,
      pushStateFeedDomains: vi.fn(),
    });
    return {
      service,
      tx,
      relationshipIntents,
      relationshipCommands,
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
    const relationshipCommands = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue(undefined),
      writeMemberRelationshipIntentInTx: vi
        .fn()
        .mockResolvedValue(new Map([['peer.test', 10n]])),
      writeGroupRelationshipIntentInTx: vi
        .fn()
        .mockResolvedValue(new Map([['peer.test', 11n]])),
    };
    const clientStateFeed = { notifyFeedUpdates: vi.fn() };
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    Object.assign(service, {
      database: {
        db: { transaction: (run: (value: unknown) => unknown) => run(tx) },
      },
      relationshipIntents,
      relationshipCommands,
      clientStateFeed,
      pushStateFeedDomains: vi.fn(),
    });
    return {
      service,
      tx,
      relationshipIntents,
      relationshipCommands,
      clientStateFeed,
    };
  }

  it('revokes only the local P2P direction under the frozen epoch', async () => {
    const harness = forbiddenHarness(7);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('P2P_REVOKED');
    expect(
      harness.relationshipCommands.writeFriendIntentInTx,
    ).toHaveBeenCalledWith(harness.tx, 1, 2, false, '', expect.any(Array));
    expect(harness.clientStateFeed.notifyFeedUpdates).toHaveBeenCalledOnce();
  });

  it('does not let an old denied round revoke a newer authorization epoch', async () => {
    const harness = forbiddenHarness(8);

    await expect(
      harness.service.handleThreadQueryForbidden(31, 'peer.test', 5, 7),
    ).resolves.toBe('STALE');
    expect(
      harness.relationshipCommands.writeFriendIntentInTx,
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
      harness.relationshipCommands.lockGroupMutationInTx,
    ).toHaveBeenCalledWith(harness.tx, 31, 1, [1, 3]);
    expect(
      harness.relationshipIntents.lockGroupBusinessScopeInTx,
    ).toHaveBeenCalledWith(harness.tx, {
      account: '!group',
      domain: 'peer.test',
    });
    expect(
      harness.relationshipCommands.writeMemberRelationshipIntentInTx,
    ).toHaveBeenCalledTimes(2);
    expect(
      harness.relationshipCommands.writeMemberRelationshipIntentInTx,
    ).toHaveBeenNthCalledWith(
      1,
      harness.tx,
      31,
      1,
      'REVOKED',
      expect.any(Array),
    );
    expect(
      harness.relationshipCommands.writeMemberRelationshipIntentInTx,
    ).toHaveBeenNthCalledWith(
      2,
      harness.tx,
      31,
      3,
      'REVOKED',
      expect.any(Array),
    );
    expect(
      harness.relationshipCommands.writeGroupRelationshipIntentInTx,
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
      harness.relationshipCommands.writeGroupRelationshipIntentInTx,
    ).toHaveBeenCalledTimes(2);
    expect(
      harness.relationshipCommands.writeGroupRelationshipIntentInTx,
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
      harness.relationshipCommands.writeGroupRelationshipIntentInTx,
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
      harness.relationshipCommands.writeMemberRelationshipIntentInTx,
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
      harness.relationshipCommands.writeMemberRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
    expect(
      harness.relationshipCommands.writeGroupRelationshipIntentInTx,
    ).not.toHaveBeenCalled();
  });
});

describe('federated profile resource path', () => {
  it('canonically percent-encodes a group account', async () => {
    const { svc } = makeStubs();
    const getSigned = vi.fn().mockResolvedValue({ profileRev: 0 });
    const target = svc as unknown as {
      getSigned: typeof getSigned;
      fetchRemoteUser(address: {
        account: string;
        domain: string;
      }): Promise<unknown>;
    };
    target.getSigned = getSigned;

    await target.fetchRemoteUser({ account: '!group', domain: 'peer.test' });

    expect(getSigned).toHaveBeenCalledWith(
      '/s2s/v1/users/%21group',
      'peer.test',
    );
  });

  it('rejects a negative public profile revision', async () => {
    const { svc } = makeStubs();
    const getSigned = vi.fn().mockResolvedValue({ profileRev: -1 });
    const target = svc as unknown as {
      getSigned: typeof getSigned;
      fetchRemoteUser(address: {
        account: string;
        domain: string;
      }): Promise<unknown>;
    };
    target.getSigned = getSigned;

    await expect(
      target.fetchRemoteUser({ account: 'alice', domain: 'peer.test' }),
    ).rejects.toMatchObject({
      code: BusinessCode.FEDERATION_MALFORMED,
      status: 200,
    });
  });

  it('projects the public profile with the canonical inline avatar shape', async () => {
    const { svc } = makeStubs();
    const bytes = Buffer.from('avatar');
    const readAvatarAsWire = vi.fn().mockResolvedValue({
      b64: bytes.toString('base64'),
      w: 32,
      h: 24,
    });
    const target = svc as unknown as {
      upload: { readAvatarAsWire: typeof readAvatarAsWire };
      toS2SProfile(user: {
        account: string;
        name: string;
        avatar: string;
        bio: string;
        profileRev: number;
      }): Promise<unknown>;
    };
    target.upload = { readAvatarAsWire };

    await expect(
      target.toS2SProfile({
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
    const { svc } = makeStubs();
    const bytes = Buffer.from('avatar');
    const saveAvatarFromWire = vi.fn().mockResolvedValue('/avatar.webp');
    const target = svc as unknown as {
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
      profileRev: 7,
    });
    expect(saveAvatarFromWire).toHaveBeenCalledExactlyOnceWith({
      b64: bytes.toString('base64'),
      w: 32,
      h: 24,
    });
  });
});

describe('federated group join request', () => {
  it('writes the request with the resolved card snapshot without prefetching the remote profile', async () => {
    const { svc, database } = makeStubs();
    const fetchRemoteUser = vi.fn();
    const ensureShell = vi.fn().mockResolvedValue({
      groupId: 17,
      threadId: 23,
    });
    const writeIntent = vi.fn().mockResolvedValue(new Map([['peer.test', 5n]]));
    const pushStateFeedDomains = vi.fn().mockResolvedValue(undefined);
    database.db.transaction = vi.fn(async (operation) => operation({}));
    const target = svc as unknown as {
      fetchRemoteUser: typeof fetchRemoteUser;
      stateFeedConsumer: {
        ensureFederatedGroupRequestShellInTx: typeof ensureShell;
      };
      relationshipCommands: {
        writeMemberRelationshipIntentInTx: typeof writeIntent;
      };
      clientStateFeed: { notifyFeedUpdates: () => void };
      pushStateFeedDomains: typeof pushStateFeedDomains;
    };
    target.fetchRemoteUser = fetchRemoteUser;
    target.stateFeedConsumer = {
      ensureFederatedGroupRequestShellInTx: ensureShell,
    };
    target.relationshipCommands = {
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

    expect(fetchRemoteUser).not.toHaveBeenCalled();
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
});

/** Build a FederationService wired with hand-rolled fakes (the project's spec style — direct
 *  construction, not the Nest DI container). */
function makeStubs() {
  const store = {
    messageThread: { findUnique: vi.fn() },
    threadParticipant: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
    mediaAsset: { findFirst: vi.fn() },
    federationDeletedCursor: { findFirst: vi.fn().mockResolvedValue(null) },
    deletedParticipant: { findFirst: vi.fn() },
  };
  const sse = { onDeletedMessageUpdated: vi.fn() };
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
          if (source === threadMember)
            return store.threadParticipant.findMany();
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
        threadParticipant: {
          findMany: store.threadParticipant.findMany,
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
  const users = new FederationUserDirectoryService(database as never);
  const participantService = {};
  const quota = {};
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
  const svc = new FederationService(
    database as never,
    peerHttp,
    peerLifecycle,
    mediaRangeClient,
    {} as never, // inboundFileSync
    {} as never, // pendingMediaPromoter
    users,
    callBridge,
    threadAccess,
    trustedPeers,
    threadResources,
    {} as never, // upload
    participantService as never,
    {} as never, // message
    {} as never, // invite
    sse as never,
    quota as never,
    {} as never, // linkPreview
    {} as never, // forwardBundles
    {} as never, // messageVisibility
    deletedMessages as never,
    eventEmitter as never,
    {} as never, // stateFeedPull
    {} as never, // stateFeed
    {} as never, // clientStateFeed
    {} as never, // relationshipIntents
    {} as never, // groupRelationships
    {} as never, // threadContentHeads
    {} as never, // profileStatePublisher
    {} as never, // relationshipCommands
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

    await svc.handleCallFrame(frame, 'peer.example', 1_700_000_300);

    expect(eventEmitter.emitAsync).toHaveBeenCalledExactlyOnceWith(
      'call.frame.incoming.preflight',
      {
        peerDomain: 'peer.example',
        namespaceId: 1_700_000_300,
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
  it('passes the pull worker fixed drain bound to state-feed pages', async () => {
    const { svc } = makeStubs();
    const pullStateFeedPage = vi.fn().mockResolvedValue({
      items: [],
      scannedThrough: '5',
      stateFeedEndId: '5',
      hasMore: false,
    });
    const target = svc as unknown as {
      stateFeedPull: {
        advertise: (
          domain: string,
          namespaceId: number,
          revision: bigint,
        ) => void;
        run: (
          domain: string,
          namespaceId: number,
          callbacks: {
            fetch: (after?: bigint, through?: bigint) => Promise<unknown>;
          },
        ) => Promise<void>;
      };
      pullStateFeedPage: typeof pullStateFeedPage;
      readStatePullCursor: (
        domain: string,
        namespaceId: number,
      ) => Promise<bigint>;
    };
    target.stateFeedPull = {
      advertise: vi.fn(),
      run: vi.fn(async (_domain, _namespaceId, callbacks) => {
        await callbacks.fetch(2n, 5n);
      }),
    };
    target.pullStateFeedPage = pullStateFeedPage;
    target.readStatePullCursor = vi.fn().mockResolvedValue(5n);

    await svc.pullStateFromPeer('peer.test', 5n);

    expect(pullStateFeedPage).toHaveBeenCalledWith('peer.test', 2n, 100, 5n);
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

describe('FederationService CAS error classification', () => {
  const digest = 'f'.repeat(64);

  function target() {
    const { svc, store } = makeStubs();
    return {
      resolveCasFile: (
        svc as unknown as {
          resolveCasFile(
            value: string,
          ): Promise<{ absPath: string; bytes: number }>;
        }
      ).resolveCasFile.bind(svc),
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

describe('FederationService thread-bound response write gate', () => {
  function installWriteGate(state?: { federationVersion: number }) {
    const { svc } = makeStubs();
    const limit = vi.fn().mockResolvedValue(state ? [state] : []);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const target = svc as unknown as {
      assertThreadResponseWritable: (
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
      target.assertThreadResponseWritable(tx, 10, 'peer.test', 7),
    ).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledOnce();
  });

  it('rejects a response after the thread authorization version changes', async () => {
    const { target, tx } = installWriteGate({ federationVersion: 8 });

    await expect(
      target.assertThreadResponseWritable(tx, 10, 'peer.test', 7),
    ).rejects.toThrow('stale federation response');
  });

  it('rejects a response after the thread disappears', async () => {
    const { target, tx } = installWriteGate();

    await expect(
      target.assertThreadResponseWritable(tx, 10, 'peer.test', 7),
    ).rejects.toThrow('stale federation response');
  });
});

describe('FederationService peer-bound response write gate', () => {
  const token = {
    domain: 'peer.test',
    namespaceId: 12,
    rootKeyFingerprint: 'sha256:root-a',
  };

  function installPeerGate() {
    const { svc, threadAccess } = makeStubs();
    const requireCapturedInTx = vi.fn().mockResolvedValue(undefined);
    Object.assign(threadAccess, { namespaces: { requireCapturedInTx } });
    const target = svc as unknown as {
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

describe('FederationService quote coordinates', () => {
  it('maps a direct publisher targetSeq back to the receiver local seq', async () => {
    const { svc } = makeStubs();
    const legacy = {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 22, domain: 'peer.example' }]),
      },
      message: { findUnique: vi.fn().mockResolvedValue({ seq: 41 }) },
    };
    const tx = {
      query: {
        user: { findMany: legacy.user.findMany },
        message: { findFirst: legacy.message.findUnique },
      },
    };
    const resolveLocalQuoteSeq = (
      svc as unknown as {
        resolveLocalQuoteSeq: (
          tx: unknown,
          threadId: number,
          sourceDomain: string,
          namespaceId: number,
          target: {
            creator: { account: string; domain: string };
            targetSeq: number;
          },
        ) => Promise<number>;
      }
    ).resolveLocalQuoteSeq.bind(svc);

    await expect(
      resolveLocalQuoteSeq(tx, 10, 'peer.example', 12, {
        creator: { account: 'alice', domain: 'peer.example' },
        targetSeq: 7,
      }),
    ).resolves.toBe(41);
    expect(legacy.message.findUnique).toHaveBeenCalled();
  });

  it('maps a peer receipt targetSeq back to the original local message', async () => {
    const { svc } = makeStubs();
    const messageFindFirst = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 91n, seq: 12 });
    const tx = {
      query: {
        message: { findFirst: messageFindFirst },
        federationMessageReceipt: {
          findFirst: vi.fn().mockResolvedValue({ messageId: 91n }),
        },
      },
    };
    const resolveLocalQuoteSeq = (
      svc as unknown as {
        resolveLocalQuoteSeq: (
          tx: unknown,
          threadId: number,
          sourceDomain: string,
          namespaceId: number,
          target: { targetSeq: number },
        ) => Promise<number>;
      }
    ).resolveLocalQuoteSeq.bind(svc);

    await expect(
      resolveLocalQuoteSeq(tx, 10, 'peer.example', 12, { targetSeq: 44 }),
    ).resolves.toBe(12);
    expect(tx.query.federationMessageReceipt.findFirst).toHaveBeenCalled();
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

describe('FederationService.signalOutbound — fixed-topology routing', () => {
  // A persisted pulled copy is exposed once to its direct source as a processing receipt. Normal
  // authority distribution excludes that source, so each destination is notified at most once.

  it('P2P: signals every foreign peer except the author', async () => {
    const { svc, store } = makeStubs();
    const push = vi
      .spyOn(svc as never, 'offerAndPushMessage' as never)
      .mockResolvedValue(undefined as never);
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(
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
    const { svc, store } = makeStubs();
    const push = vi
      .spyOn(svc as never, 'offerAndPushMessage' as never)
      .mockResolvedValue(undefined as never);
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(
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
    const { svc, store } = makeStubs();
    const push = vi
      .spyOn(svc as never, 'offerAndPushMessage' as never)
      .mockResolvedValue(undefined as never);
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'local' },
    });
    // Two members on b.com (bob + dave) + one on c.com → dest set dedupes to {b.com, c.com}.
    store.threadParticipant.findMany.mockResolvedValue([
      localUser(1, 'alice'),
      foreignUser(2, 'bob', 'b.com'),
      foreignUser(4, 'dave', 'b.com'),
      foreignUser(3, 'carol', 'c.com'),
    ]);

    await svc.signalOutbound(
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
    await svc.signalOutbound(
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
    const { svc, store } = makeStubs();
    const push = vi
      .spyOn(svc as never, 'offerAndPushMessage' as never)
      .mockResolvedValue(undefined as never);
    store.messageThread.findUnique.mockResolvedValue({
      groupUser: { account: '!grp', domain: 'origin.com' },
    });
    store.threadParticipant.findMany.mockResolvedValue([localUser(1, 'alice')]);

    // A mirror's sole destination is the origin (the hub it pulls from).
    await svc.signalOutbound(
      10,
      { account: 'alice', domain: 'local' },
      7,
      undefined,
    );
    expect(push).toHaveBeenCalledExactlyOnceWith('origin.com', 10, 7);

    // A copy pulled from the origin is queryable by that origin as a processing receipt.
    push.mockClear();
    await svc.signalOutbound(
      10,
      { account: 'alice', domain: 'local' },
      7,
      'origin.com',
    );
    expect(push).toHaveBeenCalledExactlyOnceWith('origin.com', 10, 7);
  });

  it('is a no-op when the thread is missing or the author is not a participant', async () => {
    const { svc, store } = makeStubs();
    const push = vi
      .spyOn(svc as never, 'offerAndPushMessage' as never)
      .mockResolvedValue(undefined as never);

    store.messageThread.findUnique.mockResolvedValue(null);
    store.threadParticipant.findMany.mockResolvedValue([]);
    await svc.signalOutbound(
      10,
      { account: 'alice', domain: 'local' },
      5,
      undefined,
    );
    expect(push).not.toHaveBeenCalled();

    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      foreignUser(99, 'x', 'b.com'),
    ]);
    await svc.signalOutbound(
      10,
      { account: 'alice', domain: 'local' },
      5,
      undefined,
    ); // alice@local is not in the roster
    expect(push).not.toHaveBeenCalled();
  });
});
