import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ContentType } from '../database/enums.js';
import { wirePayloadDigest } from '../federation/federated-message-content.js';
import { MessageService } from './message.service.js';
import type { OutboundFilePayload } from '../upload/file-content.js';
import {
  mediaAsset,
  message,
  messageAsset,
  pendingMedia,
  uploadSession,
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
  ownershipEvents: Array<{ kind: string; values?: object }>;
  stageQueries: SQL[];
  taskUpdates: SQL[];
}

function harness(options: {
  stageContent: string;
  quoteTarget?: Record<string, unknown> | null;
  clearedSeq?: number | null;
  taskMatches?: boolean;
  stageMissing?: boolean;
  loseStageLock?: boolean;
  committedOnRead?: number;
  taskOwner?: number;
  committedMessageMissing?: boolean;
}): PromotionHarness {
  const taskUpdates: SQL[] = [];
  const ownershipEvents: Array<{ kind: string; values?: object }> = [];
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  let insertedValues: Record<string, unknown> = {};
  const messageReturning = vi.fn(async () => [
    { ...baseMessageRow(), ...insertedValues },
  ]);
  const tx = {
    execute: vi.fn(async () => ({
      rows: options.loseStageLock ? [] : [{ id: 1n }],
    })),
    delete: vi.fn((table: unknown) => {
      expect(table).toBe(pendingMedia);
      return {
        where: async () => {
          ownershipEvents.push({ kind: 'delete-stage' });
        },
      };
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
    update: vi.fn((table: unknown) => {
      if (table === uploadSession) {
        return {
          set: (values: object) => ({
            where: (predicate: SQL) => ({
              returning: async () => {
                taskUpdates.push(predicate);
                ownershipEvents.push({ kind: 'assign-message', values });
                return options.taskMatches === false ? [] : [{ id: 7n }];
              },
            }),
          }),
        };
      }
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
      expect([mediaAsset, messageAsset]).toContain(table);
      return {
        values: (values: unknown) => {
          inserts.push({ table, values });
          return {
            thenable,
            onConflictDoUpdate: () => ({
              set: () => thenable(undefined),
            }),
            then: (resolve: () => unknown) => resolve(),
          };
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
  const stageQueries: SQL[] = [];
  let taskReads = 0;
  const svc = new MessageService(
    {
      db: {
        query: {
          uploadSession: {
            findMany: vi.fn(async () => {
              const committed =
                ++taskReads >= (options.committedOnRead ?? Infinity);
              return [
                {
                  id: 7n,
                  creatorId: options.taskOwner ?? 7,
                  digest: FILE_DIGEST,
                  messageId: committed ? 11n : null,
                  status: committed ? 'COMPLETED' : 'PENDING',
                },
              ];
            }),
          },
          message: {
            findFirst: vi.fn(async () =>
              options.committedMessageMissing
                ? undefined
                : { ...baseMessageRow(), content: '{}' },
            ),
          },
          pendingMedia: {
            findFirst: vi.fn(async (query: { where: SQL }) => {
              stageQueries.push(query.where);
              return options.stageMissing
                ? undefined
                : stageRow(options.stageContent);
            }),
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
  return {
    svc,
    inserts,
    messageReturning,
    ownershipEvents,
    stageQueries,
    taskUpdates,
  };
}

describe('MessageService.commitOutboundBatch staged quote', () => {
  const pendingMediaId = 1n;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([1, 2])(
    'returns the task-owned message for replay or a lock loser (read %i)',
    async (committedOnRead) => {
      const { svc, ownershipEvents } = harness({
        stageContent: '{}',
        committedOnRead,
        loseStageLock: true,
      });
      const result = await svc.commitOutboundBatch(pendingMediaId, undefined, [
        { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
      ]);
      expect(result).toMatchObject({
        newlyPromoted: false,
        message: { seq: 5, threadId: 1 },
      });
      expect(ownershipEvents).toEqual([]);
    },
  );

  it.each([{ stageMissing: true }, { loseStageLock: true }])(
    'rejects missing staging without a committed task result: %j',
    async (options) => {
      const { svc } = harness({ stageContent: '{}', ...options });
      await expect(
        svc.commitOutboundBatch(pendingMediaId, undefined, [
          { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
        ]),
      ).rejects.toThrow(/stage.*(missing|disappeared)/);
    },
  );

  it('does not delete staging if a selected task fails its ownership guard', async () => {
    const { svc, ownershipEvents } = harness({
      stageContent: '{}',
      taskMatches: false,
    });
    await expect(
      svc.commitOutboundBatch(pendingMediaId, undefined, [
        { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
      ]),
    ).rejects.toThrow('does not belong');
    expect(ownershipEvents.some((event) => event.kind === 'delete-stage')).toBe(
      false,
    );
  });

  it('rejects another owner even when their task already committed', async () => {
    const { svc } = harness({
      stageContent: '{}',
      committedOnRead: 1,
      taskOwner: 8,
    });
    await expect(
      svc.commitOutboundBatch(pendingMediaId, 7, [
        { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
      ]),
    ).rejects.toThrow('ownership');
  });

  it('rejects a missing committed message instead of returning null or recreating it', async () => {
    const { svc } = harness({
      stageContent: '{}',
      committedOnRead: 1,
      committedMessageMissing: true,
    });
    await expect(
      svc.commitOutboundBatch(pendingMediaId, undefined, [
        { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
      ]),
    ).rejects.toThrow('committed upload message is missing');
  });

  it('stores a durable quote but returns only client origin coordinates', async () => {
    const { svc, messageReturning } = harness({
      stageContent: JSON.stringify({ _quoteTargetSeq: 4 }),
      quoteTarget: quoteTargetRow(),
    });
    const result = await svc.commitOutboundBatch(pendingMediaId, undefined, [
      { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
    ]);
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
    const result = await svc.commitOutboundBatch(pendingMediaId, undefined, [
      { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
    ]);
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
      svc.commitOutboundBatch(pendingMediaId, undefined, [
        { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
      ]),
    ).rejects.toThrow('quoted message not found');
  });

  it('rejects a target at or below the thread clear boundary', async () => {
    const { svc } = harness({
      stageContent: JSON.stringify({ _quoteTargetSeq: 4 }),
      quoteTarget: quoteTargetRow(),
      clearedSeq: 4,
    });
    await expect(
      svc.commitOutboundBatch(pendingMediaId, undefined, [
        { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
      ]),
    ).rejects.toThrow('quoted message not found');
  });

  it('promotes without a quote lookup when no quote was staged', async () => {
    const {
      svc,
      inserts,
      ownershipEvents,
      stageQueries,
      taskUpdates,
      messageReturning,
    } = harness({ stageContent: '{}' });
    const result = await svc.commitOutboundBatch(pendingMediaId, undefined, [
      { sessionId: 7n, digest: FILE_DIGEST, payload: payload() },
    ]);
    expect(result?.newlyPromoted).toBe(true);
    const content = JSON.parse(result!.message.content as string);
    expect(content.quote).toBeUndefined();
    const query = new PgDialect().sqlToQuery(stageQueries[0]);
    expect(query.sql).toContain('"PendingMedia"."id"');
    expect(query.sql).not.toContain('clientMessageId');
    expect(query.params).toEqual([1n]);
    const taskUpdate = new PgDialect().sqlToQuery(taskUpdates[0]);
    expect(taskUpdate.sql).toContain('"UploadSession"."pendingMediaId"');
    expect(taskUpdate.sql).not.toContain('clientMessageId');
    expect(taskUpdate.params).toEqual([7n, 1n, 7, FILE_DIGEST]);
    expect((await messageReturning())[0]).toMatchObject({
      clientMessageId: stageRow('{}').clientMessageId,
    });
    expect(ownershipEvents).toEqual([
      {
        kind: 'assign-message',
        values: {
          messageId: 11n,
          pendingMediaId: null,
          status: 'COMPLETED',
          errorReason: null,
          completedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      },
      { kind: 'delete-stage' },
    ]);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].table).toBe(mediaAsset);
    expect((inserts[0].values as { digest: string }).digest).toBe(FILE_DIGEST);
    expect((inserts[1].values as Array<{ digest: string }>)[0].digest).toBe(
      FILE_DIGEST,
    );
  });
});
