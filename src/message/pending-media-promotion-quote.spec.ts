import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentType } from '../database/enums.js';
import { wirePayloadDigest } from '../federation/federated-message-content.js';
import { MessageService } from './message.service.js';
import type { OutboundFilePayload } from '../upload/file-content.js';
import {
  fileSyncProgress,
  message,
  messageAsset,
  pendingMedia,
} from '../database/schema.js';

vi.mock('../relationship/shared/relationship-authorization.js', () => ({
  isThreadMutuallyAuthorized: vi.fn(async () => true),
}));

const FILE_DIGEST = 'a'.repeat(64);
const QUOTE_DIGEST = 'e'.repeat(64);

function payload(): OutboundFilePayload {
  return {
    digest: FILE_DIGEST,
    url: `/uploads/msg-assets/aa/aa/${FILE_DIGEST}`,
    size: 12,
    family: 'IMAGE',
    name: 'cat.png',
    w: 640,
    h: 480,
  };
}

function stageRow(content: string) {
  return {
    id: 1n,
    batchId: '11111111-1111-4111-8111-111111111111',
    clientMessageId: '00000000-0000-4000-8000-000000000001',
    direction: 'OUTBOUND' as const,
    messageId: null,
    threadId: 1,
    creatorAccount: 'alice',
    publisherNamespaceId: 0,
    contentType: 'IMAGE' as ContentType,
    content,
    fileCnt: 1,
    status: 'pending',
    failReason: null,
    digest: null,
    originDomain: null,
    expectedAuthorizationEpoch: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function quoteTargetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 99n,
    threadId: 1,
    seq: 4,
    creatorAccount: 'bob',
    publisherNamespaceId: 0,
    profileNamespaceId: 0,
    isDeleted: false,
    contentType: 'PURE_TEXT',
    payloadDigest: QUOTE_DIGEST,
    ...overrides,
  };
}

function baseMessageRow() {
  return {
    id: 11n,
    threadId: 1,
    seq: 5,
    originSeq: 5,
    creatorAccount: 'alice',
    publisherNamespaceId: 0,
    profileNamespaceId: 0,
    profileRev: 1,
    clientMessageId: '00000000-0000-4000-8000-000000000001',
    contentType: 'IMAGE',
    isDeleted: false,
    localState: 'READY',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };
}

function thenable<T>(value: T) {
  return Promise.resolve(value);
}

interface PromotionHarness {
  svc: MessageService;
  inserts: Array<{ table: unknown; values: unknown }>;
  messageReturning: () => Promise<unknown[]>;
}

function harness(options: {
  stageContent: string;
  quoteTarget?: Record<string, unknown> | null;
  clearedSeq?: number | null;
}): PromotionHarness {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  let insertedValues: Record<string, unknown> = {};
  const messageReturning = vi.fn(async () => [
    { ...baseMessageRow(), ...insertedValues },
  ]);
  const tx = {
    delete: vi.fn((table: unknown) => {
      if (table === pendingMedia) {
        return {
          where: () => ({ returning: () => thenable([{ id: 1n }]) }),
        };
      }
      expect(table).toBe(fileSyncProgress);
      return { where: () => thenable(undefined) };
    }),
    select: vi.fn().mockImplementationOnce(() => {
      const promise = Promise.resolve([{ type: 'P2P', dissolvedAt: null }]);
      const builder = {
        from: () => builder,
        innerJoin: () => builder,
        leftJoin: () => builder,
        where: () => builder,
        limit: () => promise,
        then: promise.then.bind(promise),
      };
      return builder;
    }),
    update: vi.fn(() => {
      const builder = {
        set: () => builder,
        where: () => builder,
        returning: () => thenable([{ curSeq: 5 }]),
        then: (resolve: unknown) =>
          Promise.resolve(undefined).then(resolve as never),
      };
      return builder;
    }),
    insert: vi.fn((table: unknown) => {
      if (table === message) {
        return {
          values: (values: Record<string, unknown>) => {
            insertedValues = values;
            return { returning: messageReturning };
          },
        };
      }
      expect(table).toBe(messageAsset);
      return {
        values: (values: unknown) => {
          inserts.push({ table, values });
          return thenable(undefined);
        },
      };
    }),
    query: {
      account: { findFirst: vi.fn().mockResolvedValue({ id: 7 }) },
      message: {
        findFirst: vi
          .fn()
          .mockImplementation(async () =>
            options.quoteTarget === undefined ? undefined : options.quoteTarget,
          ),
      },
    },
  } as unknown as Record<string, unknown>;
  if (options.stageContent.includes('_quoteTargetSeq')) {
    (tx.select as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const promise = Promise.resolve([
        { clearedSeq: options.clearedSeq ?? null },
      ]);
      const builder = {
        from: () => builder,
        where: () => builder,
        then: promise.then.bind(promise),
      };
      return builder;
    });
  }
  const svc = new MessageService(
    {
      db: {
        query: {
          message: { findFirst: vi.fn().mockResolvedValue(null) },
          pendingMedia: {
            findFirst: vi
              .fn()
              .mockResolvedValue(stageRow(options.stageContent)),
          },
          fileSyncProgress: {
            findMany: vi.fn().mockResolvedValue([
              {
                digest: FILE_DIGEST,
                payload: payload(),
                status: 'SUCCEEDED',
                partId: '1',
                position: 0,
              },
            ]),
          },
        },
      },
    } as never,
    {} as never,
    {
      commitMessage: (_threadId: number, work: (tx: unknown) => unknown) =>
        Promise.resolve(work(tx)),
    } as never,
  );
  vi.spyOn(
    svc as unknown as { publishCommittedProfileWork: () => Promise<void> },
    'publishCommittedProfileWork',
  ).mockResolvedValue(undefined);
  return { svc, inserts, messageReturning };
}

describe('MessageService.promoteOutboundBatchIfReady staged quote', () => {
  const clientMessageId = '00000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores a durable quote but returns only client origin coordinates', async () => {
    const { svc, messageReturning } = harness({
      stageContent: JSON.stringify({ _quoteTargetSeq: 4 }),
      quoteTarget: quoteTargetRow(),
    });
    const result = await svc.promoteOutboundBatchIfReady(clientMessageId);
    expect(result?.newlyPromoted).toBe(true);
    const content = JSON.parse(result!.message.content as string);
    expect(content).toMatchObject({
      url: `/uploads/msg-assets/aa/aa/${FILE_DIGEST}`,
      quote: { namespaceId: 0, originSeq: 4 },
    });
    const stored = (await messageReturning())[0] as { content: string };
    expect(JSON.parse(stored.content).quote).toEqual({
      seq: 4,
      digest: QUOTE_DIGEST,
    });
  });

  it('derives payloadDigest over the durable wire projection with the quote digest', async () => {
    const { svc, messageReturning } = harness({
      stageContent: JSON.stringify({ _quoteTargetSeq: 4 }),
      quoteTarget: quoteTargetRow(),
    });
    const result = await svc.promoteOutboundBatchIfReady(clientMessageId);
    const content = ((await messageReturning())[0] as { content: string })
      .content;
    expect(result!.message.payloadDigest).toBe(
      wirePayloadDigest(
        'IMAGE' as ContentType,
        content,
        [{ digest: FILE_DIGEST, bytes: 12 }],
        QUOTE_DIGEST,
      ),
    );
  });

  it.each([
    ['a deleted target', quoteTargetRow({ isDeleted: true })],
    ['a SYSTEM target', quoteTargetRow({ contentType: 'SYSTEM' })],
    [
      'a target without payload digest',
      quoteTargetRow({ payloadDigest: null }),
    ],
    ['a missing target', null],
  ])('rejects promotion quoting %s', async (_label, target) => {
    const { svc } = harness({
      stageContent: JSON.stringify({ _quoteTargetSeq: 4 }),
      quoteTarget: target,
    });
    await expect(
      svc.promoteOutboundBatchIfReady(clientMessageId),
    ).rejects.toThrow('quoted message not found');
  });

  it('rejects a target at or below the thread clear boundary', async () => {
    const { svc } = harness({
      stageContent: JSON.stringify({ _quoteTargetSeq: 4 }),
      quoteTarget: quoteTargetRow(),
      clearedSeq: 4,
    });
    await expect(
      svc.promoteOutboundBatchIfReady(clientMessageId),
    ).rejects.toThrow('quoted message not found');
  });

  it('promotes without a quote lookup when no quote was staged', async () => {
    const { svc, inserts } = harness({ stageContent: '{}' });
    const result = await svc.promoteOutboundBatchIfReady(clientMessageId);
    expect(result?.newlyPromoted).toBe(true);
    const content = JSON.parse(result!.message.content as string);
    expect(content.quote).toBeUndefined();
    expect(inserts).toHaveLength(1);
    expect((inserts[0].values as Array<{ digest: string }>)[0].digest).toBe(
      FILE_DIGEST,
    );
  });
});
