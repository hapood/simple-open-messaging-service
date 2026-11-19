import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { DatabaseService } from '../../database/database.service.js';
import * as tables from '../../database/schema.js';
import { restageInboundMedia } from './restage-inbound-media.js';

async function fixture(localState = 'FAILED') {
  const digest = 'a'.repeat(64);
  const msg: typeof tables.message.$inferSelect = {
    id: 1n,
    threadId: 1,
    seq: 1,
    originSeq: 1,
    publisherNamespaceId: 1,
    creatorAccount: 'alice',
    profileNamespaceId: 1,
    contentType: 'FILE',
    content: JSON.stringify({
      url: `/uploads/msg-assets/aa/aa/${digest}`,
      name: 'file',
      size: 4,
    }),
    localState: 'FAILED',
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    payloadDigest: 'b'.repeat(64),
    profileRev: 0,
    clientMessageId: null,
    originServerTime: null,
    federationPayloadVerification: 'UNVERIFIED',
    federationEnvelopeDigest: null,
  };
  const sets: Array<{ table: unknown; values: object }> = [];
  const tx = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            for: () => ({
              limit: async () => [
                { localState, isDeleted: false, authorizationEpoch: 2 },
              ],
            }),
          }),
        }),
      }),
    }),
    query: {
      pendingMedia: {
        findFirst: vi.fn(async () => ({
          id: 2n,
          batchId: 'batch',
          status: 'pending',
        })),
      },
      fileSyncProgress: {
        findMany: vi.fn(async () => [
          { id: 3n, batchId: 'batch', digest, status: 'FAILED' },
        ]),
      },
    },
    update: (table: unknown) => ({
      set: (values: object) => ({
        where: async () => {
          sets.push({ table, values });
        },
      }),
    }),
  };
  const module = await Test.createTestingModule({
    providers: [
      {
        provide: DatabaseService,
        useValue: {
          db: {
            transaction: async (
              work: (transaction: typeof tx) => Promise<unknown>,
            ) => work(tx),
          },
        },
      },
    ],
  }).compile();
  onTestFinished(() => module.close());
  const route = {
    peerDomain: 'peer.test',
    fromAccount: 'alice',
    fromDomain: 'peer.test',
    toAccount: 'bob',
    sourceSeq: 1,
  };
  return {
    run: () => restageInboundMedia(module.get(DatabaseService), msg, route),
    sets,
    tx,
  };
}

describe('restage failed inbound media', () => {
  it('retries a failed message without a mirrored failed batch status', async () => {
    const s = await fixture();
    await expect(s.run()).resolves.toEqual({ batchId: 'batch', resetFiles: 1 });
    expect(s.sets).toContainEqual({
      table: tables.fileSyncProgress,
      values: expect.objectContaining({ status: 'PENDING', errorKind: null }),
    });
    expect(s.sets).toContainEqual({
      table: tables.message,
      values: expect.objectContaining({ localState: 'STUB' }),
    });
    const coordination = s.sets.find((entry) => entry.table === tables.pendingMedia);
    expect(coordination).toBeDefined();
    expect(coordination!.values).not.toHaveProperty('status');
    expect(coordination!.values).not.toHaveProperty('failReason');
  });

  it('does not reset an already retried message when given an old failed snapshot', async () => {
    const s = await fixture('STUB');
    await expect(s.run()).resolves.toBeNull();
    expect(s.sets).toEqual([]);
    expect(s.tx.query.fileSyncProgress.findMany).not.toHaveBeenCalled();
  });
});
