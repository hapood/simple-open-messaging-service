import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  FederationMessageProvenanceService,
  type MessageProvenanceQuery,
} from './federation-message-provenance.service.js';

/**
 * Unit tests for `FederationMessageProvenanceService`. The protocol contract is verified here at
 * the service level: batch shape validation, duplicate detection, the two refusal forms (per-query
 * `declined` and whole-batch `FEDERATION_PROVENANCE_DECLINED`), and the `yes`/`no` answer from
 * retained digests. HTTP wiring and the `S2sSignatureGuard` are covered by the round-trip e2e.
 *
 * The drizzle query builder is mocked with a chainable stub so the tests do not need PostgreSQL.
 */
describe('FederationMessageProvenanceService', () => {
  /** Build a chainable mock of `database.db.select(...).from(...).where(...).limit(n)` that
   *  resolves to `rows`. Each call returns a fresh chain so successive queries can stage different
   *  result sets via `queue`. */
  function mockDb(queues: unknown[][]): {
    db: {
      select: ReturnType<typeof vi.fn>;
    };
    database: { db: { select: ReturnType<typeof vi.fn> } };
  } {
    const select = vi.fn(() => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(queues.shift() ?? []),
      };
      return chain;
    });
    return { db: { select }, database: { db: { select } } };
  }

  function p2pQuery(seq: number, digest: string): MessageProvenanceQuery {
    return { thread: { account: 'alice', peerAccount: 'bob' }, seq, contentDigest: digest };
  }

  function groupQuery(seq: number, digest: string): MessageProvenanceQuery {
    return { thread: { account: '!group' }, seq, contentDigest: digest };
  }

  it('rejects an empty queries array', async () => {
    const { database } = mockDb([]);
    const svc = new FederationMessageProvenanceService(database as never);
    await expect(svc.query([])).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects more than 64 queries', async () => {
    const { database } = mockDb([]);
    const svc = new FederationMessageProvenanceService(database as never);
    const queries = Array.from({ length: 65 }, (_, i) => p2pQuery(i + 1, 'd'));
    await expect(svc.query(queries)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects a duplicate (thread, seq) pair', async () => {
    const { database } = mockDb([]);
    const svc = new FederationMessageProvenanceService(database as never);
    const q = p2pQuery(1, 'd');
    await expect(svc.query([q, q])).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('distinguishes P2P and GROUP threads with the same seq for duplicate detection', async () => {
    // Same seq, different thread shape → not a duplicate.
    const { database } = mockDb([[], []]);
    const svc = new FederationMessageProvenanceService(database as never);
    const results = await svc.query([p2pQuery(1, 'd1'), groupQuery(1, 'd2')]);
    expect(results).toEqual([
      { thread: { account: 'alice', peerAccount: 'bob' }, seq: 1, known: 'no' },
      { thread: { account: '!group' }, seq: 1, known: 'no' },
    ]);
  });

  it('answers no when no retained message matches the digest and seq', async () => {
    const { database } = mockDb([[]]);
    const svc = new FederationMessageProvenanceService(database as never);
    const results = await svc.query([p2pQuery(1, 'abc')]);
    expect(results).toEqual([
      { thread: { account: 'alice', peerAccount: 'bob' }, seq: 1, known: 'no' },
    ]);
  });

  it('answers yes when a retained message matches and its thread resolves to the query thread', async () => {
    // queryOne: candidate lookup returns one row whose threadId resolves to a matching GROUP
    // thread. The second queue is the threadMatches lookup.
    const { database } = mockDb([
      [{ threadId: 7, seq: 1, contentDigest: 'abc' }], // candidate messages
      [{ type: 'GROUP', groupAccount: '!group' }], // threadMatches lookup
    ]);
    const svc = new FederationMessageProvenanceService(database as never);
    const results = await svc.query([groupQuery(1, 'abc')]);
    expect(results).toEqual([
      { thread: { account: '!group' }, seq: 1, known: 'yes' },
    ]);
  });

  it('answers no when a candidate matches the digest and seq but the thread does not resolve', async () => {
    const { database } = mockDb([
      [{ threadId: 7, seq: 1, contentDigest: 'abc' }],
      [{ type: 'GROUP', groupAccount: '!other' }], // different group account
    ]);
    const svc = new FederationMessageProvenanceService(database as never);
    const results = await svc.query([groupQuery(1, 'abc')]);
    expect(results).toEqual([
      { thread: { account: '!group' }, seq: 1, known: 'no' },
    ]);
  });

  it('returns per-query declined when shouldDeclineQuery is true for that query only', async () => {
    const { database } = mockDb([
      [{ threadId: 7, seq: 1, contentDigest: 'abc' }],
      [{ type: 'GROUP', groupAccount: '!group' }],
    ]);
    class DecliningService extends FederationMessageProvenanceService {
      protected shouldDeclineQuery(q: MessageProvenanceQuery): boolean {
        return q.thread.account === 'alice';
      }
    }
    const svc = new DecliningService(database as never);
    const results = await svc.query([
      p2pQuery(1, 'abc'), // declined (P2P, account alice)
      groupQuery(1, 'abc'), // answered yes
    ]);
    expect(results).toEqual([
      { thread: { account: 'alice', peerAccount: 'bob' }, seq: 1, known: 'declined' },
      { thread: { account: '!group' }, seq: 1, known: 'yes' },
    ]);
  });

  it('throws FEDERATION_PROVENANCE_DECLINED for the whole batch when shouldDeclineBatch is true', async () => {
    const { database } = mockDb([]);
    class BatchDecliningService extends FederationMessageProvenanceService {
      protected shouldDeclineBatch(): boolean {
        return true;
      }
    }
    const svc = new BatchDecliningService(database as never);
    await expect(svc.query([p2pQuery(1, 'abc')])).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PROVENANCE_DECLINED,
    });
  });

  it('whole-batch decline takes precedence over per-query decline and runs no lookups', async () => {
    const { database, db } = mockDb([]);
    let declined = false;
    class BothDecliningService extends FederationMessageProvenanceService {
      protected shouldDeclineBatch(): boolean {
        return true;
      }
      protected shouldDeclineQuery(): boolean {
        declined = true;
        return true;
      }
    }
    const svc = new BothDecliningService(database as never);
    await expect(svc.query([p2pQuery(1, 'abc')])).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PROVENANCE_DECLINED,
    });
    // The batch check short-circuits before any per-query work.
    expect(declined).toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('preserves result order and correlates by value', async () => {
    const { database } = mockDb([[], []]);
    const svc = new FederationMessageProvenanceService(database as never);
    const results = await svc.query([
      groupQuery(2, 'd2'),
      groupQuery(1, 'd1'),
    ]);
    expect(results.map((r) => r.seq)).toEqual([2, 1]);
    expect(results.map((r) => r.known)).toEqual(['no', 'no']);
  });

  it('reports HTTP 200 status on the whole-batch decline exception', async () => {
    const { database } = mockDb([]);
    class BatchDecliningService extends FederationMessageProvenanceService {
      protected shouldDeclineBatch(): boolean {
        return true;
      }
    }
    const svc = new BatchDecliningService(database as never);
    try {
      await svc.query([p2pQuery(1, 'abc')]);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BusinessException);
      expect((e as BusinessException).getStatus()).toBe(200);
    }
  });
});
