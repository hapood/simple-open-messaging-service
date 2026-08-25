import { describe, it, expect, vi } from 'vitest';

// loadFederationConfig() reads SOMS_DOMAIN via requireEnv at construction (field initializer), so it
// must be set before `new FederationService(...)`. Module-top runs before any test body.
process.env.SOMS_DOMAIN ??= 'soms.io';

import {
  clientGroupIntentEndpoints,
  FederationService,
  S2sResponseError,
} from './federation.service.js';
import { BusinessCode } from '../common/business-code.js';
import { ContentType } from '../database/enums.js';
import { UploadService } from '../upload/upload.service.js';

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

describe('federated profile resource path', () => {
  it('canonically percent-encodes a group account', async () => {
    const { svc } = makeStubs();
    const getSigned = vi.fn().mockResolvedValue({});
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
});

describe('federated group join request', () => {
  it('writes the request with the resolved card snapshot without prefetching the remote profile', async () => {
    const { svc, database } = makeStubs();
    const fetchRemoteUser = vi.fn();
    const ensureShell = vi.fn().mockResolvedValue({
      groupUserId: 17,
      threadId: 23,
    });
    const writeIntent = vi.fn().mockResolvedValue(new Map([['peer.test', 5n]]));
    const pushStateFeedDomains = vi.fn().mockResolvedValue(undefined);
    database.db.transaction = vi.fn(async (operation) => operation({}));
    const target = svc as unknown as {
      fetchRemoteUser: typeof fetchRemoteUser;
      ensureFederatedGroupRequestShellInTx: typeof ensureShell;
      writeMemberRelationshipIntentInTx: typeof writeIntent;
      clientStateFeed: { notifyFeedUpdates: () => void };
      pushStateFeedDomains: typeof pushStateFeedDomains;
    };
    target.fetchRemoteUser = fetchRemoteUser;
    target.ensureFederatedGroupRequestShellInTx = ensureShell;
    target.writeMemberRelationshipIntentInTx = writeIntent;
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
      11,
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
  const database = {
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [{ authorized: true }] }),
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
  const svc = new FederationService(
    database as never,
    {} as never, // signature
    {
      acquireRequestSlot: async () => () => undefined,
      request: (...args: Parameters<typeof fetch>) => fetch(...args),
    } as never, // discovery
    {} as never, // upload
    {} as never, // participantService
    {} as never, // message
    {} as never, // invite
    sse as never,
    {} as never, // quota
    {} as never, // linkPreview
    {} as never, // forwardBundles
    {} as never, // messageVisibility
    deletedMessages as never,
    eventEmitter as never,
    recognition as never,
    { readAllocatedThrough: vi.fn().mockResolvedValue(0n) } as never, // federationCursor
    {} as never, // downloadScheduler
    {
      get: () => ({
        keyCacheTtlSec: 21_600,
        connectTimeoutSec: 12,
        callTimeoutSec: 12,
        mediaChunkBytes: 8 * 1024 * 1024,
        mediaChunkTimeoutSec: 120,
        mediaMaxChunkRetries: 5,
      }),
    } as never, // transportConfig
    {} as never, // stateFeedPull
    {} as never, // stateFeed
    {} as never, // clientStateFeed
    {} as never, // relationshipIntents
  );
  return {
    svc,
    database,
    store,
    sse,
    deletedMessages,
    eventEmitter,
    recognition,
  };
}

describe('FederationService inbound call preflight', () => {
  it('short-circuits an incoming retry before resolving either account', async () => {
    const { svc, eventEmitter } = makeStubs();
    eventEmitter.emitAsync.mockResolvedValueOnce([true]);
    const frame = {
      callSid: '550e8400-e29b-41d4-a716-446655440000',
      op: 'incoming' as const,
      callType: 'AUDIO' as const,
      payload: { fromAccount: 'alice', toAccount: 'bob' },
    };

    await svc.handleCallFrame(frame, 'peer.example', 1_700_000_300);

    expect(eventEmitter.emitAsync).toHaveBeenCalledExactlyOnceWith(
      'call.frame.incoming.preflight',
      { peerDomain: 'peer.example', frame },
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
        advertise: (domain: string, revision: bigint) => void;
        run: (
          domain: string,
          callbacks: {
            fetch: (after?: bigint, through?: bigint) => Promise<unknown>;
          },
        ) => Promise<void>;
      };
      pullStateFeedPage: typeof pullStateFeedPage;
      readStatePullCursor: (domain: string) => Promise<bigint>;
    };
    target.stateFeedPull = {
      advertise: vi.fn(),
      run: vi.fn(async (_domain, callbacks) => {
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
    const { svc, recognition } = makeStubs();
    const privateService = svc as unknown as {
      signature: { signOutbound: () => Record<string, string> };
      requestRangeUnit: (
        url: URL,
        domain: string,
        start: number,
        end: number,
      ) => Promise<{ contentDigest?: string }>;
    };
    privateService.signature = { signOutbound: () => ({}) };
    return { privateService, recognition };
  }

  it('accepts a valid 206 range when the peer omits the optional digest', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('abc', {
        status: 206,
        headers: { 'content-range': 'bytes 0-2/3' },
      }),
    );
    await expect(
      target().privateService.requestRangeUnit(
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
      target().privateService.requestRangeUnit(
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
    const { privateService, recognition } = target();
    await expect(
      privateService.requestRangeUnit(
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
      target().privateService.requestRangeUnit(
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
    const { svc } = makeStubs();
    const target = svc as unknown as {
      signature: { signOutbound: () => Record<string, string> };
      discovery: {
        resolveBase: (domain: string) => Promise<string>;
        acquireRequestSlot: (domain: string) => Promise<() => void>;
        request: typeof fetch;
      };
      getSigned(path: string, domain: string): Promise<unknown>;
    };
    target.signature = { signOutbound: () => ({}) };
    target.discovery = {
      resolveBase: async () => 'https://peer.test',
      acquireRequestSlot: async () => () => undefined,
      request: (...args) => fetch(...args),
    };

    await expect(
      target.getSigned('/resource', 'peer.test'),
    ).rejects.toMatchObject({
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

describe('FederationService thread-bound S2S preflight', () => {
  function installPreflight(state: {
    federationTruncated: boolean;
    federationVersion: number;
    trustLevel: string;
  }) {
    const { svc, database } = makeStubs();
    const limit = vi.fn().mockResolvedValue([state]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    const execute = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute, select }),
    );
    (database.db as { transaction?: typeof transaction }).transaction =
      transaction;
    const getSigned = vi.fn().mockResolvedValue({ messages: [] });
    const target = svc as unknown as {
      getSigned: typeof getSigned;
      withTrustedPeer: <T>(
        domain: string,
        action: () => Promise<T>,
      ) => Promise<T>;
      getSignedForThread: <T>(
        threadId: number,
        path: string,
        domain: string,
      ) => Promise<{ data: T; federationVersion: number }>;
    };
    target.getSigned = getSigned;
    target.withTrustedPeer = (_domain, action) => action();
    return { target, getSigned, execute, select, innerJoin, transaction };
  }

  it('takes the shared reset lock, performs one joined state read, and carries the captured version', async () => {
    const { target, getSigned, execute, select, innerJoin, transaction } =
      installPreflight({
        federationTruncated: false,
        federationVersion: 7,
        trustLevel: 'available',
      });

    await expect(
      target.getSignedForThread<{ messages: unknown[] }>(
        10,
        '/messages',
        'peer.test',
      ),
    ).resolves.toEqual({ data: { messages: [] }, federationVersion: 7 });
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(innerJoin).toHaveBeenCalledOnce();
    expect(getSigned).toHaveBeenCalledWith('/messages', 'peer.test', undefined);
  });

  it.each([
    ['reset domain', false, 'halted', true],
    ['truncated thread', true, 'available', false],
  ])(
    'does not send for a %s',
    async (_label, truncated, trustLevel, resetInProgress) => {
      const { target, getSigned } = installPreflight({
        federationTruncated: truncated,
        federationVersion: 7,
        trustLevel,
        resetInProgress,
      });

      await expect(
        target.getSignedForThread(10, '/messages', 'peer.test'),
      ).rejects.toThrow('federation thread 10 is unavailable');
      expect(getSigned).not.toHaveBeenCalled();
    },
  );

  it('attaches the captured version to an application error response', async () => {
    const { target, getSigned } = installPreflight({
      federationTruncated: false,
      federationVersion: 7,
      trustLevel: 'available',
    });
    getSigned.mockRejectedValueOnce(
      new S2sResponseError('gone', 200, BusinessCode.GROUP_DISSOLVED),
    );

    await expect(
      target.getSignedForThread(10, '/messages', 'peer.test'),
    ).rejects.toMatchObject({
      status: 200,
      code: BusinessCode.GROUP_DISSOLVED,
      federationVersion: 7,
    });
  });
});

describe('FederationService global missed transport', () => {
  it('captures the peer generation before issuing the signed page request', async () => {
    const { svc } = makeStubs();
    const token = {
      domain: 'peer.test',
      resetGeneration: 3,
      rootKeyFingerprint: 'sha256:test',
    };
    const page = {
      items: [],
      scannedThrough: '9',
      messageFeedEndId: '9',
      hasMore: false,
    };
    const order: string[] = [];
    const target = svc as unknown as {
      capturePeerResponseToken: (domain: string) => Promise<typeof token>;
      withTrustedPeer: <T>(
        domain: string,
        action: () => Promise<T>,
      ) => Promise<T>;
      getSigned: <T>(
        path: string,
        domain: string,
        maxResponseBytes?: number,
      ) => Promise<T>;
      pullMissedPage: (
        domain: string,
        after: bigint,
        take?: number,
      ) => Promise<{ page: typeof page; token: typeof token }>;
    };
    target.capturePeerResponseToken = vi.fn(async () => {
      order.push('token');
      return token;
    });
    target.withTrustedPeer = vi.fn(async (_domain, action) => action());
    target.getSigned = vi.fn(async () => {
      order.push('request');
      return page;
    });

    await expect(target.pullMissedPage('peer.test', 7n, 100)).resolves.toEqual({
      page,
      token,
    });
    expect(order).toEqual(['token', 'request']);
    expect(target.getSigned).toHaveBeenCalledWith(
      '/s2s/v1/message-feed?after=7&take=100',
      'peer.test',
      16 * 1024 * 1024,
    );
  });

  it.each([
    [0n, 0],
    [0n, 1.5],
    [0n, Number.MAX_SAFE_INTEGER + 1],
  ])(
    'rejects invalid cursor/page input before network I/O',
    async (after, take) => {
      const { svc } = makeStubs();
      const target = svc as unknown as {
        capturePeerResponseToken: ReturnType<typeof vi.fn>;
        pullMissedPage: (
          domain: string,
          after: bigint,
          take?: number,
        ) => Promise<unknown>;
      };
      target.capturePeerResponseToken = vi.fn();
      await expect(
        target.pullMissedPage('peer.test', after, take),
      ).rejects.toThrow();
      expect(target.capturePeerResponseToken).not.toHaveBeenCalled();
    },
  );
});

describe('FederationService thread-query revocation fallback', () => {
  it('revokes the local P2P direction on an authenticated message-query denial', async () => {
    const { svc } = makeStubs();
    const target = svc as unknown as {
      handleThreadQueryForbidden: (
        error: Error,
        domain: string,
        thread: { account: string; peerAccount: string },
      ) => Promise<void>;
      revokeLocalFriendAfterMessageQueryForbidden: ReturnType<typeof vi.fn>;
    };
    target.revokeLocalFriendAfterMessageQueryForbidden = vi
      .fn()
      .mockResolvedValue(undefined);

    await expect(
      target.handleThreadQueryForbidden(
        new S2sResponseError('revoked', 200, BusinessCode.FORBIDDEN),
        'peer.test',
        { account: 'peer', peerAccount: 'me' },
      ),
    ).rejects.toThrow(/thread query access was revoked/);
    expect(
      target.revokeLocalFriendAfterMessageQueryForbidden,
    ).toHaveBeenCalledWith('peer.test', {
      account: 'peer',
      peerAccount: 'me',
    });
  });

  it('does not revoke for retryable or non-message-query failures', async () => {
    const { svc } = makeStubs();
    const target = svc as unknown as {
      handleThreadQueryForbidden: (
        error: Error,
        domain: string,
        thread: { account: string; peerAccount: string },
      ) => Promise<void>;
      revokeLocalFriendAfterMessageQueryForbidden: ReturnType<typeof vi.fn>;
    };
    target.revokeLocalFriendAfterMessageQueryForbidden = vi.fn();

    await target.handleThreadQueryForbidden(
      new S2sResponseError(
        'busy',
        200,
        BusinessCode.FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE,
      ),
      'peer.test',
      { account: 'peer', peerAccount: 'me' },
    );
    expect(
      target.revokeLocalFriendAfterMessageQueryForbidden,
    ).not.toHaveBeenCalled();
  });
});

describe('FederationService thread-bound response write gate', () => {
  function installWriteGate(state: {
    federationTruncated: boolean;
    federationVersion: number;
    trustLevel: string;
  }) {
    const { svc } = makeStubs();
    const limit = vi.fn().mockResolvedValue([state]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    const execute = vi.fn().mockResolvedValue(undefined);
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
      tx: { execute, select },
      execute,
      select,
      innerJoin,
    };
  }

  it('accepts the response only while the joined reset state and version still match', async () => {
    const { target, tx, execute, select, innerJoin } = installWriteGate({
      federationTruncated: false,
      federationVersion: 7,
      trustLevel: 'available',
    });

    await expect(
      target.assertThreadResponseWritable(tx, 10, 'peer.test', 7),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(innerJoin).toHaveBeenCalledOnce();
  });

  it.each([
    ['changed version', false, 8, 'available', false],
    ['truncated thread', true, 7, 'available', false],
    ['reset domain', false, 7, 'halted', true],
  ])(
    'rejects a stale response for a %s',
    async (_label, truncated, version, trustLevel, resetInProgress) => {
      const { target, tx } = installWriteGate({
        federationTruncated: truncated,
        federationVersion: version,
        trustLevel,
        resetInProgress,
      });

      await expect(
        target.assertThreadResponseWritable(tx, 10, 'peer.test', 7),
      ).rejects.toThrow('stale federation response');
    },
  );
});

describe('FederationService peer-bound response write gate', () => {
  const token = {
    domain: 'peer.test',
    resetGeneration: 3,
    rootKeyFingerprint: 'sha256:root-a',
  };

  function installPeerGate(state: {
    trustLevel: string;
    resetGeneration: number;
    rootKeyFingerprint: string | null;
    recognizesPeer?: boolean;
    outboundRecognitionConfirmed?: boolean;
    inboundRecognitionConfirmed?: boolean;
    localServiceAvailable?: boolean;
  }) {
    const { svc } = makeStubs();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [state] });
    const target = svc as unknown as {
      assertPeerResponseWritable: (
        tx: { execute: typeof execute },
        value: typeof token,
      ) => Promise<void>;
    };
    return { target, tx: { execute } };
  }

  it('accepts a response while generation and root identity still match', async () => {
    const { target, tx } = installPeerGate({
      trustLevel: 'available',
      resetGeneration: 3,
      rootKeyFingerprint: 'sha256:root-a',
      recognizesPeer: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
      localServiceAvailable: true,
    });

    await expect(
      target.assertPeerResponseWritable(tx, token),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['reset generation changed', 4, 'sha256:root-a'],
    ['root identity changed', 3, 'sha256:root-b'],
  ])('rejects a stale response when %s', async (_label, generation, root) => {
    const { target, tx } = installPeerGate({
      trustLevel: 'available',
      resetGeneration: generation,
      rootKeyFingerprint: root,
      recognizesPeer: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
      localServiceAvailable: true,
    });

    await expect(target.assertPeerResponseWritable(tx, token)).rejects.toThrow(
      'stale federation response',
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
          .mockResolvedValue([
            { id: 22, domain: 'peer.example', isForeigner: true },
          ]),
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
          target: {
            creator: { account: string; domain: string };
            targetSeq: number;
          },
        ) => Promise<number>;
      }
    ).resolveLocalQuoteSeq.bind(svc);

    await expect(
      resolveLocalQuoteSeq(tx, 10, 'peer.example', {
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
          target: { targetSeq: number },
        ) => Promise<number>;
      }
    ).resolveLocalQuoteSeq.bind(svc);

    await expect(
      resolveLocalQuoteSeq(tx, 10, 'peer.example', { targetSeq: 44 }),
    ).resolves.toBe(12);
    expect(tx.query.federationMessageReceipt.findFirst).toHaveBeenCalled();
  });
});

const localUser = (userId: number, account: string) => ({
  userId,
  user: { account, domain: 'local', isForeigner: false },
});
const foreignUser = (userId: number, account: string, domain: string) => ({
  userId,
  user: { account, domain, isForeigner: true },
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

    await svc.signalOutbound(10, 1, 5, undefined);

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

    await svc.signalOutbound(10, 1, 5, 'b.com');

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

    await svc.signalOutbound(10, 1, 7, undefined);

    expect(push.mock.calls).toEqual([
      ['b.com', 10, 7],
      ['c.com', 10, 7],
    ]);

    // The source receives the acceptance copy as its receipt; other mirrors receive normal distribution.
    push.mockClear();
    await svc.signalOutbound(10, 1, 7, 'b.com');
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
    await svc.signalOutbound(10, 1, 7, undefined);
    expect(push).toHaveBeenCalledExactlyOnceWith('origin.com', 10, 7);

    // A copy pulled from the origin is queryable by that origin as a processing receipt.
    push.mockClear();
    await svc.signalOutbound(10, 1, 7, 'origin.com');
    expect(push).toHaveBeenCalledExactlyOnceWith('origin.com', 10, 7);
  });

  it('is a no-op when the thread is missing or the author is not a participant', async () => {
    const { svc, store } = makeStubs();
    const push = vi
      .spyOn(svc as never, 'offerAndPushMessage' as never)
      .mockResolvedValue(undefined as never);

    store.messageThread.findUnique.mockResolvedValue(null);
    store.threadParticipant.findMany.mockResolvedValue([]);
    await svc.signalOutbound(10, 1, 5, undefined);
    expect(push).not.toHaveBeenCalled();

    store.messageThread.findUnique.mockResolvedValue({
      groupUser: null,
    });
    store.threadParticipant.findMany.mockResolvedValue([
      foreignUser(99, 'x', 'b.com'),
    ]);
    await svc.signalOutbound(10, 1, 5, undefined); // author 1 is not in the roster
    expect(push).not.toHaveBeenCalled();
  });
});
