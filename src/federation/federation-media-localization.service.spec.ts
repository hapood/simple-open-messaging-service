import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { ContentType } from '../database/enums.js';
import { FederationMediaLocalizationService } from './federation-media-localization.service.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

function setup(options?: {
  visibleMessage?: unknown;
  pendingStatus?: string;
  assets?: Array<{ digest: string }>;
}) {
  const mediaAssetFindFirst = vi.fn();
  const database = {
    db: {
      query: {
        mediaAsset: {
          findFirst: mediaAssetFindFirst,
          findMany: vi.fn(),
        },
        pendingMedia: {
          findFirst: vi
            .fn()
            .mockResolvedValue(
              options?.pendingStatus
                ? { status: options.pendingStatus }
                : undefined,
            ),
        },
      },
    },
  };
  const upload = { saveCasFromStream: vi.fn() };
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
        endpointADomain: 'peer.example',
        endpointANamespaceId: 4,
        endpointBAccount: 'alice',
      },
    ]);
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: threadLimit }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: pairLimit }),
        }),
      });
    const database = { db: { select } };
    const service = new FederationMediaLocalizationService(
      database as never,
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
        creatorDomain: 'peer.example',
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
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ type: 'P2P', group: null }]),
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
      { db: { select } } as never,
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
        creatorDomain: 'peer.example',
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
        creatorDomain: 'peer.example',
        localState: 'STUB',
      },
      pendingStatus: 'downloading',
    });

    await expect(service.localizeMediaForMessage(7, 11, 13)).resolves.toBe(
      'downloading',
    );
  });

  it('deduplicates forward assets and downloads missing ones with the admitted route', async () => {
    const present = 'a'.repeat(64);
    const missing = 'b'.repeat(64);
    const { service, upload, mediaRanges, mediaAssetFindFirst } = setup({
      assets: [{ digest: present }, { digest: missing }],
    });
    mediaAssetFindFirst
      .mockResolvedValueOnce({ digest: present })
      .mockResolvedValueOnce(undefined);
    const chunks = (async function* () {
      yield Buffer.from('data');
    })();
    mediaRanges.fetch.mockReturnValue(chunks);
    upload.saveCasFromStream.mockImplementation(
      async (
        _ext: string,
        fetchChunks: (offset: number) => AsyncIterable<Buffer>,
      ) => {
        expect(fetchChunks(32)).toBe(chunks);
      },
    );

    await service.localizeForwardAssets({} as never, 'peer.example', {
      fromAccount: 'alice',
      fromDomain: 'peer.example',
      toAccount: '!group',
      sourceSeq: 23,
    });

    expect(upload.saveCasFromStream).toHaveBeenCalledExactlyOnceWith(
      'bin',
      expect.any(Function),
      missing,
    );
    expect(mediaRanges.fetch).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
      missing,
      'alice',
      'peer.example',
      '!group',
      23,
      32,
    );
  });
});
