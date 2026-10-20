import request from 'supertest';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  PersonalRequestPage,
  RequestEndpoint,
  RequestKind,
  RequestRecord,
} from '../../shared/relationship-request.js';
import { BusinessCode } from '../../src/common/business-code.js';

/** Fetch the receiver node's exact pending ID. IDs are node-local storage
 * coordinates: never borrow the sender's ID or resolve decisions by address. */
export async function waitForReceivedRequest(
  httpTarget: Parameters<typeof request>[0],
  token: string,
  flow: {
    kind: RequestKind;
    author: RequestEndpoint;
    receiver: RequestEndpoint;
  },
  timeoutMs = 30_000,
): Promise<RequestRecord> {
  const deadline = performance.now() + timeoutMs;
  const matches = (row: RequestRecord) =>
    row.kind === flow.kind &&
    row.direction === 'INCOMING' &&
    row.status === 'REQUESTED' &&
    row.author.account === flow.author.account &&
    row.author.namespaceId === flow.author.namespaceId &&
    row.receiver.account === flow.receiver.account &&
    row.receiver.namespaceId === flow.receiver.namespaceId;
  do {
    let before: string | undefined;
    const visited = new Set<string>();
    do {
      const response = await request(httpTarget)
        .post('/api/v1/relationship/requests')
        .set('Authorization', `Bearer ${token}`)
        .send({
          bucket: 'RECEIVED',
          take: 50,
          ...(before === undefined ? {} : { before }),
        })
        .timeout({
          deadline: Math.max(1, Math.ceil(deadline - performance.now())),
        });
      if (response.status !== 200 || response.body.code !== BusinessCode.OK)
        throw new Error(
          `received-request query failed: ${JSON.stringify(response.body)}`,
        );
      const page: PersonalRequestPage = response.body.data;
      const row = page.items.find(matches);
      if (row) return row;
      if (!page.hasMore) break;
      if (!page.before || visited.has(page.before))
        throw new Error('received-request pagination did not advance');
      visited.add(page.before);
      before = page.before;
    } while (performance.now() < deadline);
    if (performance.now() < deadline)
      await delay(Math.min(50, deadline - performance.now()));
  } while (performance.now() < deadline);
  throw new Error(
    `pending received request did not arrive: ${JSON.stringify(flow)}`,
  );
}
