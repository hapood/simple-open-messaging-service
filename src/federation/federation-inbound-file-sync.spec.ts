import { describe, expect, it, vi } from 'vitest';
import { FederationInboundFileSync } from './federation-inbound-file-sync.js';
import { FileSizeLimitError } from '../upload/file-size-limit.js';

function setup(failure?: Error) {
  const row = {
    id: 1n,
    digest: 'a'.repeat(64),
    batchId: 'batch',
    bytesTotal: 4n,
    publisherNamespaceId: 7,
    originDomain: 'peer.test',
    status: 'PENDING',
  };
  const database = {
    db: {
      query: {
        fileSyncProgress: {
          findMany: vi.fn().mockResolvedValue([row]),
          findFirst: vi.fn(async () => row),
        },
        pendingMedia: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
      update: vi.fn(() => ({
        set: (values: object) => ({
          where: () => {
            Object.assign(row, values);
            return Object.assign(Promise.resolve(), {
              returning: async () => [{ id: row.id }],
            });
          },
        }),
      })),
    },
  };
  const receive = vi.fn(async (input) => {
    if (failure) throw failure;
    for await (const _piece of input.chunks(0)) {
      /* Exercise resource generation checks. */
    }
  });
  const sync = new FederationInboundFileSync(
    database as never,
    { isExhausted: vi.fn().mockResolvedValue(false) } as never,
    { receive } as never,
    {} as never,
  );
  const fetch = vi.fn(() =>
    (async function* () {
      yield Buffer.from('data');
    })(),
  );
  const promote = vi.fn();
  const fail = vi.fn();
  return {
    row,
    receive,
    fetch,
    promote,
    fail,
    run: () => sync.runBatch('batch', fetch, promote, fail),
  };
}

describe('inbound attachment jobs', () => {
  it.each([new FileSizeLimitError(3, 4), new Error('shared transfer failed')])(
    'terminates each message job on a transfer/admission failure',
    async (error) => {
      const s = setup(error);
      await expect(s.run()).rejects.toBe(error);
      expect(s.fetch).not.toHaveBeenCalled();
      expect(s.row.status).toBe('FAILED');
      expect(s.fail).toHaveBeenCalledWith('batch');
      expect(s.promote).not.toHaveBeenCalled();
    },
  );
  it('promotes only after shared IO succeeds and forwards its descriptor', async () => {
    const s = setup();
    await s.run();
    expect(s.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        namespaceId: 7,
        peerDomain: 'peer.test',
        digest: s.row.digest,
        declaredBytes: 4,
      }),
    );
    expect(s.fetch).toHaveBeenCalledWith(s.row.digest, 0, 4);
    expect(s.row.status).toBe('SUCCEEDED');
    expect(s.promote).toHaveBeenCalledWith('batch');
  });
});
