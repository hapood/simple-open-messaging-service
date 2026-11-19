import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import { BusinessCode } from '../common/business-code.js';
import { ContentType } from '../database/enums.js';
import { FederationMediaLocalizationService } from './federation-media-localization.service.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

function setup(options?: {
  visibleMessage?: unknown;
  assets?: Array<{ digest: string; bytes: number }>;
}) {
  const mediaAssetFindFirst = vi.fn();
  const database = {
    db: {
      query: {
        mediaAsset: {
          findFirst: mediaAssetFindFirst,
          findMany: vi.fn(),
        },
        pendingMedia: { findFirst: vi.fn() },
        message: {
          findFirst: vi.fn().mockResolvedValue(options?.visibleMessage),
        },
        fileSyncProgress: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
  };
  const upload = { receive: vi.fn() };
  const mediaRanges = { fetch: vi.fn() };
  const visibility = {
    findVisibleByThreadSeq: vi.fn().mockResolvedValue(options?.visibleMessage),
  };
  const forwardBundles = {
    assetsFromClosure: vi.fn().mockReturnValue(options?.assets ?? []),
  };
  const service = new FederationMediaLocalizationService(
    database as never,
    upload as never,
    mediaRanges as never,
    visibility as never,
    forwardBundles as never,
    {} as never,
    {} as never,
    {
      activeNamespaceId: vi.fn().mockResolvedValue(3),
      assertFileSize: vi.fn().mockResolvedValue(1024 ** 3),
      claimFile: vi.fn().mockResolvedValue(undefined),
    } as never,
  );
  return {
    service,
    database,
    upload,
    mediaRanges,
    visibility,
    forwardBundles,
    mediaAssetFindFirst,
  };
}

describe('FederationMediaLocalizationService', () => {
  it('derives the P2P recipient from the active relationship pair', async () => {
    const threadLimit = vi
      .fn()
      .mockResolvedValue([{ type: 'P2P', group: null }]);
    const pairLimit = vi.fn().mockResolvedValue([
      {
        endpointAAccount: 'alice',
        endpointBAccount: 'alice',
      },
    ]);
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({ limit: threadLimit }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: pairLimit }),
        }),
      });
    const database = {
      db: {
        select,
        query: {
          identityNamespace: {
            findFirst: vi.fn().mockResolvedValue({ domain: 'peer.example' }),
          },
        },
      },
    };
    const service = new FederationMediaLocalizationService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.resolveForwardAssetAuth({
        threadId: 11,
        creatorAccount: 'alice',
        profileNamespaceId: 9,
        publisherNamespaceId: 3,
        originSeq: 9,
      } as never),
    ).resolves.toEqual({
      fromAccount: 'alice',
      fromDomain: 'peer.example',
      toAccount: 'alice',
      sourceSeq: 9,
    });
  });

  it('rejects P2P media localization without an active relationship pair', async () => {
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi
                  .fn()
                  .mockResolvedValue([{ type: 'P2P', group: null }]),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
    const service = new FederationMediaLocalizationService(
      {
        db: {
          select,
          query: {
            identityNamespace: {
              findFirst: vi.fn().mockResolvedValue({ domain: 'peer.example' }),
            },
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.resolveForwardAssetAuth({
        threadId: 11,
        creatorAccount: 'alice',
        profileNamespaceId: 9,
        publisherNamespaceId: 3,
        originSeq: 9,
      } as never),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
  });

  it('returns ready without transport work for a visible non-media message', async () => {
    const { service, mediaRanges } = setup({
      visibleMessage: { contentType: ContentType.PURE_TEXT },
    });

    await expect(service.localizeMediaForMessage(7, 11, 13)).resolves.toBe(
      'ready',
    );
    expect(mediaRanges.fetch).not.toHaveBeenCalled();
  });

  it('reports the durable job status for a visible inbound STUB', async () => {
    const { service } = setup({
      visibleMessage: {
        id: 17n,
        contentType: ContentType.IMAGE,
        creatorAccount: 'alice',
        profileNamespaceId: 9,
        publisherNamespaceId: 3,
        localState: 'STUB',
      },
    });

    await expect(service.localizeMediaForMessage(7, 11, 13)).resolves.toBe(
      'pending',
    );
  });

  it.each([
    {
      localState: 'READY',
      isDeleted: false,
      failedTask: false,
      expected: 'ready',
    },
    {
      localState: 'STUB',
      isDeleted: false,
      failedTask: true,
      expected: 'failed',
    },
    {
      localState: 'FAILED',
      isDeleted: false,
      failedTask: false,
      expected: 'failed',
    },
    {
      localState: 'READY',
      isDeleted: true,
      failedTask: false,
      expected: 'failed',
    },
  ])(
    'reads current message/task state instead of staging ($expected, $localState)',
    async ({ localState, isDeleted, failedTask, expected }) => {
      const s = setup({
        visibleMessage: {
          id: 17n,
          contentType: ContentType.IMAGE,
          creatorAccount: 'alice',
          localState: 'STUB',
        },
      });
      s.database.db.query.message.findFirst.mockResolvedValue({
        localState,
        isDeleted,
      });
      s.database.db.query.fileSyncProgress.findFirst.mockResolvedValue(
        failedTask ? { id: 1n } : undefined,
      );
      await expect(s.service.localizeMediaForMessage(7, 11, 13)).resolves.toBe(
        expected,
      );
      expect(s.database.db.query.pendingMedia.findFirst).not.toHaveBeenCalled();
      expect(s.upload.receive).not.toHaveBeenCalled();
    },
  );

  it('drains localization and its detached physical writer before Nest closes infrastructure', async () => {
    const s = setup({ assets: [{ digest: 'a'.repeat(64), bytes: 4 }] });
    const scheduler = new FederationDownloadScheduler({
      db: { query: { systemSetting: { findMany: async () => [] } } },
    } as never);
    let release!: () => void;
    let signal!: AbortSignal;
    const writer = vi.fn((_report, physical) => {
      signal = physical;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    s.upload.receive.mockImplementationOnce((input) =>
      scheduler.schedule(
        input.peerDomain,
        input.digest,
        writer,
        input.declaredBytes,
        input.signal,
      ),
    );
    const closeDatabase = vi.fn();
    const mod = await Test.createTestingModule({
      providers: [
        {
          provide: 'database',
          useValue: { onApplicationShutdown: closeDatabase },
        },
        { provide: FederationDownloadScheduler, useValue: scheduler },
        { provide: FederationMediaLocalizationService, useValue: s.service },
      ],
    }).compile();
    const work = expect(
      s.service.localizeForwardAssets(
        {} as never,
        'peer.example',
        {
          fromAccount: 'alice',
          fromDomain: 'peer.example',
          toAccount: 'bob',
          sourceSeq: 23,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('media localization shutting down');
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    const closing = mod.close();
    try {
      await work;
      expect(signal.aborted).toBe(true);
      expect(closeDatabase).not.toHaveBeenCalled();
      expect(scheduler.snapshot().active).toBe(1);
    } finally {
      release();
      await closing;
    }
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('waits for in-flight localization to exit and rejects new admission during shutdown', async () => {
    const s = setup();
    let release!: () => void;
    s.visibility.findVisibleByThreadSeq.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ contentType: ContentType.PURE_TEXT });
        }),
    );
    const rejected = expect(
      s.service.localizeMediaForMessage(7, 11, 13),
    ).rejects.toThrow('media localization shutting down');
    await vi.waitFor(() =>
      expect(s.visibility.findVisibleByThreadSeq).toHaveBeenCalledOnce(),
    );
    let closed = false;
    const shutdown = s.service.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    try {
      await expect(
        s.service.localizeMediaForMessage(7, 11, 14),
      ).rejects.toThrow('media localization shutting down');
      expect(closed).toBe(false);
      expect(s.visibility.findVisibleByThreadSeq).toHaveBeenCalledOnce();
    } finally {
      release();
      await rejected;
      await shutdown;
    }
  });

  it('preserves an in-flight database failure while draining shutdown', async () => {
    const s = setup();
    const failure = new Error('visibility database unavailable');
    let reject!: (error: Error) => void;
    s.visibility.findVisibleByThreadSeq.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const rejected = expect(
      s.service.localizeMediaForMessage(7, 11, 13),
    ).rejects.toBe(failure);
    await vi.waitFor(() =>
      expect(s.visibility.findVisibleByThreadSeq).toHaveBeenCalledOnce(),
    );
    const shutdown = expect(
      s.service.beforeApplicationShutdown(),
    ).rejects.toMatchObject({
      message: 'media localization shutdown failed',
      errors: [failure],
    });
    reject(failure);
    await rejected;
    await shutdown;
  });

  it('waits for a forwarded transfer adapter to release after abort', async () => {
    const s = setup({ assets: [{ digest: 'a'.repeat(64), bytes: 4 }] });
    let release!: () => void;
    let signal!: AbortSignal;
    s.upload.receive.mockImplementationOnce((input) => {
      signal = input.signal;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const rejected = expect(
      s.service.localizeForwardAssets(
        {} as never,
        'peer.example',
        {
          fromAccount: 'alice',
          fromDomain: 'peer.example',
          toAccount: 'bob',
          sourceSeq: 23,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('media localization shutting down');
    await vi.waitFor(() => expect(s.upload.receive).toHaveBeenCalledOnce());
    let closed = false;
    const shutdown = s.service.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    try {
      expect(signal.aborted).toBe(true);
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      release();
      await rejected;
      await shutdown;
    }
  });

  it('rejects a visibility result arriving after shutdown before starting further work', async () => {
    const s = setup();
    s.visibility.findVisibleByThreadSeq.mockImplementationOnce(async () => {
      s.service.beforeApplicationShutdown();
      return { contentType: ContentType.PURE_TEXT };
    });
    await expect(s.service.localizeMediaForMessage(7, 11, 13)).rejects.toThrow(
      'media localization shutting down',
    );
    expect(s.upload.receive).not.toHaveBeenCalled();
  });

  it('rejects a late inbound status instead of returning it after shutdown', async () => {
    const s = setup({
      visibleMessage: {
        id: 17n,
        contentType: ContentType.IMAGE,
        creatorAccount: 'alice',
        localState: 'STUB',
      },
    });
    s.database.db.query.message.findFirst.mockImplementationOnce(async () => {
      s.service.beforeApplicationShutdown();
      return { localState: 'READY', isDeleted: false };
    });
    await expect(s.service.localizeMediaForMessage(7, 11, 13)).rejects.toThrow(
      'media localization shutting down',
    );
  });

  it('does not return ready for a forwarded asset whose transport finishes after shutdown', async () => {
    const s = setup({ assets: [{ digest: 'a'.repeat(64), bytes: 4 }] });
    s.upload.receive.mockImplementationOnce(async () => {
      s.service.beforeApplicationShutdown();
    });
    await expect(
      s.service.localizeForwardAssets(
        {} as never,
        'peer.example',
        {
          fromAccount: 'alice',
          fromDomain: 'peer.example',
          toAccount: 'bob',
          sourceSeq: 23,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('media localization shutting down');
  });

  it.each(['caller', 'shutdown'] as const)(
    'propagates %s cancellation instead of treating it as best-effort failure',
    async (owner) => {
      const { service, upload } = setup({
        assets: [{ digest: 'a'.repeat(64), bytes: 4 }],
      });
      const controller = new AbortController();
      upload.receive.mockImplementation(async (input) => {
        if (owner === 'caller') controller.abort(new Error('caller stopped'));
        else service.beforeApplicationShutdown();
        input.signal.throwIfAborted();
      });
      await expect(
        service.localizeForwardAssets(
          {} as never,
          'peer.example',
          {
            fromAccount: 'alice',
            fromDomain: 'peer.example',
            toAccount: '!group',
            sourceSeq: 23,
          },
          controller.signal,
        ),
      ).rejects.toThrow(
        owner === 'caller'
          ? 'caller stopped'
          : 'media localization shutting down',
      );
      expect(upload.receive).toHaveBeenCalledOnce();
    },
  );

  it('refuses manual localization after shutdown', async () => {
    const { service } = setup({
      visibleMessage: { contentType: ContentType.PURE_TEXT },
    });
    service.beforeApplicationShutdown();
    await expect(service.localizeMediaForMessage(7, 11, 13)).rejects.toThrow(
      'media localization shutting down',
    );
  });

  it('preserves forwarded transfer cleanup errors during shutdown', async () => {
    const s = setup({ assets: [{ digest: 'a'.repeat(64), bytes: 4 }] });
    let rejectTransfer!: (error: unknown) => void;
    s.upload.receive.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTransfer = reject;
        }),
    );
    const failure = new AggregateError(
      [new Error('response cleanup failed')],
      'download cleanup failed',
    );
    const running = expect(
      s.service.localizeForwardAssets(
        {} as never,
        'peer.example',
        {
          fromAccount: 'alice',
          fromDomain: 'peer.example',
          toAccount: 'bob',
          sourceSeq: 23,
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    await vi.waitFor(() => expect(s.upload.receive).toHaveBeenCalledOnce());
    const shutdown = expect(
      s.service.beforeApplicationShutdown(),
    ).rejects.toMatchObject({
      message: 'media localization shutdown failed',
      errors: [failure],
    });
    rejectTransfer(failure);
    await running;
    await shutdown;
  });

  it('preserves a message asset failure when its caller is cancelled', async () => {
    const s = setup();
    const controller = new AbortController();
    const failure = new Error('file cleanup failed');
    s.upload.receive.mockImplementationOnce(async () => {
      controller.abort(new Error('caller stopped'));
      throw failure;
    });
    const subject = s.service as unknown as {
      localizeMedia: (
        message: { id: bigint; threadId: number; content: string },
        peer: string,
        from: string,
        domain: string,
        to: string,
        seq: number,
        signal: AbortSignal,
      ) => Promise<boolean>;
    };
    await expect(
      subject.localizeMedia(
        {
          id: 17n,
          threadId: 3,
          content: JSON.stringify({
            url: `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`,
            size: 4,
          }),
        },
        'peer.example',
        'alice',
        'peer.example',
        'bob',
        23,
        controller.signal,
      ),
    ).rejects.toBe(failure);
  });

  it('logs a forward asset failure and still attempts later assets', async () => {
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    const s = setup({
      assets: [
        { digest: first, bytes: 4 },
        { digest: second, bytes: 4 },
      ],
    });
    const failure = new AggregateError(
      [new Error('cleanup failed')],
      'publication failed',
    );
    s.upload.receive
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      await expect(
        s.service.localizeForwardAssets(
          {} as never,
          'peer.example',
          {
            fromAccount: 'alice',
            fromDomain: 'peer.example',
            toAccount: 'bob',
            sourceSeq: 23,
          },
          new AbortController().signal,
        ),
      ).resolves.toBe(false);
      expect(s.upload.receive).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        `Forward asset ${first} from peer.example could not be localized`,
        failure,
      );
    } finally {
      log.mockRestore();
    }
  });

  it('logs a message asset failure without logging private content', async () => {
    const s = setup();
    const digest = 'a'.repeat(64);
    const failure = new Error('file cleanup failed');
    s.upload.receive.mockRejectedValueOnce(failure);
    const subject = s.service as unknown as {
      localizeMedia: (
        message: { id: bigint; threadId: number; content: string },
        peer: string,
        from: string,
        domain: string,
        to: string,
        seq: number,
        signal: AbortSignal,
      ) => Promise<boolean>;
    };
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      await expect(
        subject.localizeMedia(
          {
            id: 17n,
            threadId: 3,
            content: JSON.stringify({
              url: `/uploads/msg-assets/aa/aa/${digest}`,
              size: 4,
              name: 'private.pdf',
            }),
          },
          'peer.example',
          'alice',
          'peer.example',
          'bob',
          23,
          new AbortController().signal,
        ),
      ).resolves.toBe(false);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        `Message asset ${digest} from peer.example could not be localized`,
        failure,
      );
    } finally {
      log.mockRestore();
    }
  });

  it('routes all forward assets through shared admission and IO, including cached digests', async () => {
    const present = 'a'.repeat(64);
    const missing = 'b'.repeat(64);
    const { service, upload, mediaRanges, mediaAssetFindFirst } = setup({
      assets: [
        { digest: present, bytes: 36 },
        { digest: missing, bytes: 36 },
      ],
    });
    mediaAssetFindFirst
      .mockResolvedValueOnce({ digest: present })
      .mockResolvedValueOnce(undefined);
    const chunks = (async function* () {
      yield Buffer.from('data');
    })();
    mediaRanges.fetch.mockReturnValue(chunks);
    const controller = new AbortController();
    upload.receive.mockImplementation(async (input) => {
      if (input.digest === missing)
        expect(input.chunks(32, controller.signal)).toBe(chunks);
    });

    await service.localizeForwardAssets(
      {} as never,
      'peer.example',
      {
        fromAccount: 'alice',
        fromDomain: 'peer.example',
        toAccount: '!group',
        sourceSeq: 23,
      },
      new AbortController().signal,
    );

    expect(upload.receive).toHaveBeenCalledTimes(2);
    expect(upload.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        digest: missing,
        declaredBytes: 36,
        namespaceId: 3,
        peerDomain: 'peer.example',
      }),
    );
    expect(mediaRanges.fetch).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
      missing,
      'alice',
      'peer.example',
      '!group',
      23,
      32,
      36,
      controller.signal,
    );
  });
});
