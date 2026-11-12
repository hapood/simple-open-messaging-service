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
  const physicalController = new AbortController();
  const receive = vi.fn(async (input) => {
    if (failure) throw failure;
    for await (const _piece of input.chunks(0, physicalController.signal)) {
      /* Exercise resource generation checks. */
    }
  });
  const waitForStoppedDigest = vi.fn().mockResolvedValue(undefined);
  const sync = new FederationInboundFileSync(
    database as never,
    { isExhausted: vi.fn().mockResolvedValue(false) } as never,
    { receive, waitForStoppedDigest } as never,
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
    database,
    sync,
    physicalController,
    waitForStoppedDigest,
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
    expect(s.fetch).toHaveBeenCalledWith(
      s.row.digest,
      0,
      4,
      s.physicalController.signal,
    );
    expect(s.row).toMatchObject({ status: 'SUCCEEDED', bytesReceived: 4n });
    expect(s.promote).toHaveBeenCalledWith('batch');
  });

  it('does not emit late downloading progress after a stopped row rejects the write', async () => {
    const s = setup();
    s.database.db.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    } as never);
    const subject = s.sync as unknown as {
      writeProgress: (id: bigint, received: number) => Promise<void>;
      publishProgress: (id: bigint, received: number) => Promise<void>;
    };
    const publish = vi
      .spyOn(subject, 'publishProgress')
      .mockResolvedValue(undefined);
    await subject.writeProgress(1n, 100);
    expect(publish).not.toHaveBeenCalled();
  });

  it('aborts the task consumer, marks failure, and waits for stopped physical writers', async () => {
    const s = setup();
    s.receive.mockImplementation(
      async (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            'abort',
            () => reject(input.signal.reason),
            { once: true },
          );
        }),
    );
    const run = s.run();
    const rejected = expect(run).rejects.toThrow('stopped by administrator');
    await vi.waitFor(() => expect(s.receive).toHaveBeenCalledOnce());
    await s.sync.stopBatch('batch');
    await rejected;
    expect(s.row.status).toBe('FAILED');
    expect(s.waitForStoppedDigest).toHaveBeenCalledWith(s.row.digest);
    expect(s.promote).not.toHaveBeenCalled();
  });
});
