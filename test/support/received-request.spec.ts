import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PersonalRequestPage,
  RequestRecord,
} from '../../shared/relationship-request.js';
import { BusinessCode } from '../../src/common/business-code.js';
import { waitForReceivedRequest } from './received-request.js';

const flow = {
  kind: 'FRIEND' as const,
  author: { account: 'author', namespaceId: 7 },
  receiver: { account: 'receiver', namespaceId: 0 },
};
function row(id: string, namespaceId = 7): RequestRecord {
  return {
    id,
    kind: 'FRIEND',
    direction: 'INCOMING',
    status: 'REQUESTED',
    note: '',
    author: { account: 'author', namespaceId },
    receiver: flow.receiver,
    authorProfile: {
      account: 'author',
      namespaceId,
      profileNamespaceId: 0,
      profileRev: 1,
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
const page = (
  items: RequestRecord[],
  before: string | null = null,
): PersonalRequestPage => ({
  items,
  before,
  hasMore: before !== null,
  incomingHead: { requestEndId: '10', requestReadId: '0' },
});

describe('receiver-node request lookup test helper', () => {
  let server: Server | undefined;
  const seen: Array<{
    body: Record<string, unknown>;
    auth: string | undefined;
  }> = [];
  async function serve(
    reply: (body: Record<string, unknown>, attempt: number) => object,
  ) {
    seen.length = 0;
    server = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body: Record<string, unknown> = JSON.parse(text);
      seen.push({ body, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply(body, seen.length)));
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing fixture port');
    return `http://127.0.0.1:${address.port}`;
  }
  afterEach(async () => {
    const active = server;
    if (active) {
      active.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        active.close((error) => (error ? reject(error) : resolve())),
      );
    }
    server = undefined;
  });

  it('paginates and matches both endpoint namespaces without accepting a same-account decoy', async () => {
    const wanted = row('8');
    const baseUrl = await serve((body) => ({
      code: BusinessCode.OK,
      data:
        body['before'] === undefined
          ? page([row('10', 99)], '9')
          : page([wanted]),
    }));
    expect(await waitForReceivedRequest(baseUrl, 'token', flow)).toEqual(
      wanted,
    );
    expect(seen).toEqual([
      { body: { bucket: 'RECEIVED', take: 50 }, auth: 'Bearer token' },
      {
        body: { bucket: 'RECEIVED', take: 50, before: '9' },
        auth: 'Bearer token',
      },
    ]);
  });
  it('also supports an in-process HTTP server without changing lookup semantics', async () => {
    await serve(() => ({ code: BusinessCode.OK, data: page([row('10')]) }));
    if (!server) throw new Error('missing fixture server');
    expect((await waitForReceivedRequest(server, 'token', flow)).id).toBe('10');
    expect(seen).toEqual([
      { body: { bucket: 'RECEIVED', take: 50 }, auth: 'Bearer token' },
    ]);
  });

  it('waits for a genuinely pending round rather than choosing a terminal record', async () => {
    const baseUrl = await serve((_body, attempt) => ({
      code: BusinessCode.OK,
      data: page(
        attempt === 1 ? [{ ...row('9'), status: 'REJECTED' }] : [row('10')],
      ),
    }));
    expect((await waitForReceivedRequest(baseUrl, 'token', flow)).id).toBe(
      '10',
    );
    expect(seen).toHaveLength(2);
  });
  it('fails on a repeated pagination cursor instead of spinning or guessing an ID', async () => {
    const baseUrl = await serve(() => ({
      code: BusinessCode.OK,
      data: page([], '9'),
    }));
    await expect(
      waitForReceivedRequest(baseUrl, 'token', flow),
    ).rejects.toThrow('pagination did not advance');
    expect(seen).toHaveLength(2);
  });
  it('does not treat a business rejection as an empty successful page', async () => {
    const baseUrl = await serve(() => ({ code: BusinessCode.FORBIDDEN }));
    await expect(
      waitForReceivedRequest(baseUrl, 'token', flow),
    ).rejects.toThrow('query failed');
    expect(seen).toHaveLength(1);
  });
  it('has a bounded wait when no round arrives', async () => {
    const baseUrl = await serve(() => ({
      code: BusinessCode.OK,
      data: page([]),
    }));
    await expect(
      waitForReceivedRequest(baseUrl, 'token', flow, 80),
    ).rejects.toThrow();
  });
});
