import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import { forwardBundle, forwardBundleDependency } from '../database/schema.js';
import {
  digestManifest,
  FORWARD_MAX_WIRE_JSON_BYTES,
  ForwardBundleService,
  type ForwardManifest,
  type ForwardWireClosure,
} from './forward-bundle.service.js';

function sourceRow(childDepth: number) {
  return {
    id: 1n,
    seq: 7,
    threadId: 4,
    creator: 9,
    contentType: ContentType.FORWARD,
    content: JSON.stringify({ version: 1, bundleId: 'child' }),
    createdAt: new Date('2026-07-31T00:00:00Z'),
    updatedAt: new Date('2026-07-31T00:00:00Z'),
    isDeleted: false,
    clientMessageId: null,
    originSeq: 7,
    originServerTime: null,
    creatorItem: {
      account: 'alice',
      domain: 'local',
      name: 'Alice',
      avatar: '',
    },
    forwardMessage: {
      bundleId: '01childbundle00000000000000',
      bundle: { id: '01childbundle00000000000000', depth: childDepth },
    },
  };
}

function sourceQueryRow(childDepth: number) {
  const row = sourceRow(childDepth);
  return {
    ...row,
    user: row.creatorItem,
    forwardMessages: [
      { ...row.forwardMessage, forwardBundle: row.forwardMessage.bundle },
    ],
  };
}

function databaseFake(childDepth: number, tx?: unknown) {
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ value: 1 }]),
        })),
      })),
      query: {
        message: {
          findFirst: vi.fn().mockResolvedValue(sourceQueryRow(childDepth)),
        },
      },
      transaction: vi.fn(async (work: (client: unknown) => Promise<void>) =>
        work(tx),
      ),
    },
  };
}

describe('ForwardBundleService', () => {
  it('rejects forwarding an existing depth-3 bundle because the result would be depth 4', async () => {
    const service = new ForwardBundleService(databaseFake(3) as never);

    await expect(
      service.createFromMessages(9, [{ threadId: 4, seq: 7 }]),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FORWARD_MAX_DEPTH_EXCEEDED,
    });
  });

  it('stores children as a JSON array and a searchable dependency when result depth is 3', async () => {
    const createBundle = vi.fn().mockResolvedValue(undefined);
    const createDependencies = vi.fn().mockResolvedValue(undefined);
    const tx = {
      insert: vi.fn((table: unknown) => ({
        values:
          table === forwardBundle
            ? createBundle
            : table === forwardBundleDependency
              ? createDependencies
              : vi.fn(),
      })),
    };
    const service = new ForwardBundleService(databaseFake(2, tx) as never);
    const result = await service.createFromMessages(9, [
      { threadId: 4, seq: 7 },
    ]);

    expect(result.depth).toBe(3);
    const manifest = createBundle.mock.calls[0][0].manifest as ForwardManifest;
    expect(manifest.children).toEqual(['01childbundle00000000000000']);
    expect(createDependencies).toHaveBeenCalledWith([
      {
        parentBundleId: result.bundleId,
        childBundleId: '01childbundle00000000000000',
        ordinal: 0,
      },
    ]);
  });

  it('hashes manifests canonically rather than depending on object key insertion order', () => {
    const first = {
      schemaVersion: 1,
      bundleId: '01bundle0000000000000000000',
      depth: 1,
      children: [],
      messages: [],
    } as ForwardManifest;
    const second = {
      messages: [],
      children: [],
      depth: 1,
      bundleId: '01bundle0000000000000000000',
      schemaVersion: 1,
    } as ForwardManifest;
    expect(digestManifest(first)).toBe(digestManifest(second));
  });

  it('rejects a cyclic federated closure before writing any bundle', async () => {
    const manifestA: ForwardManifest = {
      schemaVersion: 1,
      bundleId: '01cyclea0000000000000000000',
      depth: 2,
      children: ['01cycleb0000000000000000000'],
      messages: [
        {
          sender: { displayName: 'A', account: 'a', domain: 'peer.test' },
          contentType: 'FORWARD',
          content: '{}',
          sentAt: 1,
          childBundleId: '01cycleb0000000000000000000',
        },
      ],
    };
    const manifestB: ForwardManifest = {
      schemaVersion: 1,
      bundleId: '01cycleb0000000000000000000',
      depth: 2,
      children: ['01cyclea0000000000000000000'],
      messages: [
        {
          sender: { displayName: 'B', account: 'b', domain: 'peer.test' },
          contentType: 'FORWARD',
          content: '{}',
          sentAt: 1,
          childBundleId: '01cyclea0000000000000000000',
        },
      ],
    };
    const closure: ForwardWireClosure = {
      schemaVersion: 1,
      rootBundleId: manifestA.bundleId,
      bundles: [
        {
          id: manifestA.bundleId,
          depth: 2,
          manifest: manifestA,
          manifestDigest: digestManifest(manifestA),
          assets: [],
        },
        {
          id: manifestB.bundleId,
          depth: 2,
          manifest: manifestB,
          manifestDigest: digestManifest(manifestB),
          assets: [],
        },
      ],
      assets: [],
    };
    const service = new ForwardBundleService({} as never);
    await expect(
      service.importClosure('peer.test', closure),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects federated closure JSON over the wire limit', async () => {
    const manifest: ForwardManifest = {
      schemaVersion: 1,
      bundleId: '01oversize00000000000000000',
      depth: 1,
      children: [],
      messages: [
        {
          sender: { displayName: 'A', account: 'a', domain: 'peer.test' },
          contentType: 'PURE_TEXT',
          content: 'x'.repeat(FORWARD_MAX_WIRE_JSON_BYTES),
          sentAt: 1,
        },
      ],
    };
    const service = new ForwardBundleService({} as never);
    await expect(
      service.importClosure('peer.test', {
        schemaVersion: 1,
        rootBundleId: manifest.bundleId,
        bundles: [
          {
            id: manifest.bundleId,
            depth: 1,
            manifest,
            manifestDigest: digestManifest(manifest),
            assets: [],
          },
        ],
        assets: [],
      }),
    ).rejects.toMatchObject<Partial<BusinessException>>({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });
});
