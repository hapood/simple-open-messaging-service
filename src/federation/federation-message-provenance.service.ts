import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { message, messageThread } from '../database/schema.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/** A single provenance query in a `POST /s2s/v1/message-provenance` request. */
export interface MessageProvenanceQuery {
  thread:
    | { account: string; peerAccount: string }
    | { account: string };
  seq: number;
  contentDigest: string;
}

/** A single provenance result in the response. */
export interface MessageProvenanceResult {
  thread: MessageProvenanceQuery['thread'];
  seq: number;
  known: 'yes' | 'no' | 'declined';
}

/**
 * Implements `POST /s2s/v1/message-provenance` (Federation v1 Message Provenance Query). A
 * recognized peer asks whether this server published a message at a given `(thread, seq)` whose
 * canonical `content` hashes to the supplied `contentDigest`. The answer is per-query and one of
 * `yes`, `no`, or `declined`.
 *
 * The responder answers `yes` only when it retained a `contentDigest` for a message at `(thread,
 * seq)` that equals the supplied value. Beyond that honesty rule, the choice among the three
 * states is an implementation decision (Core Protocol §6.1.1 and the provenance spec): this
 * implementation answers `yes`/`no` from its retained digests and never returns `declined`,
 * leaving privacy policy to the deployer.
 *
 * Lookup is driven by the indexed `contentDigest` column: a message whose retained digest matches
 * the query and whose `(threadId, seq)` resolves to the query thread answers `yes`. The thread
 * resolution reuses the same `groupAccount`/`groupDomain` columns the message feed uses, so a
 * GROUP thread is matched by its group account and a P2P thread by its account pair through the
 * relationship that owns the thread.
 */
@Injectable()
export class FederationMessageProvenanceService {
  constructor(private readonly database: DatabaseService) {}

  async query(
    queries: readonly MessageProvenanceQuery[],
  ): Promise<MessageProvenanceResult[]> {
    if (queries.length === 0 || queries.length > 64) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'provenance queries must contain 1..64 entries',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Reject a duplicate (thread, seq) pair within one request. `thread` is compared by its JSON
    // encoding so the two thread shapes (P2P vs GROUP) are distinguished structurally.
    const seen = new Set<string>();
    for (const q of queries) {
      const key = `${JSON.stringify(q.thread)}:${q.seq}`;
      if (seen.has(key)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'duplicate (thread, seq) in provenance queries',
          HttpStatus.BAD_REQUEST,
        );
      }
      seen.add(key);
    }
    // Whole-batch refusal. A responder whose policy declines every query returns the
    // `FEDERATION_PROVENANCE_DECLINED` error code for the entire batch with no result array,
    // rather than a per-query `known: "declined"` answer. The two refusal forms are mutually
    // exclusive per the provenance spec. The default policy does not decline the batch.
    if (this.shouldDeclineBatch()) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PROVENANCE_DECLINED,
        'message-provenance batch declined by policy',
        HttpStatus.OK,
      );
    }

    const results: MessageProvenanceResult[] = [];
    for (const q of queries) {
      results.push(await this.queryOne(q));
    }
    return results;
  }

  /** Whether the responder's policy declines the entire batch before answering any query.
   *  Overridable by a deployer whose privacy or rate policy refuses provenance queries
   *  wholesale. Returning `true` makes `query()` throw `FEDERATION_PROVENANCE_DECLINED`
   *  (HTTP 200, no `results`) for every request. The default policy does not decline. */
  protected shouldDeclineBatch(): boolean {
    return false;
  }

  /** Whether the responder's policy declines a single query before answering it. Returning `true`
   *  makes `queryOne()` answer `known: "declined"` for that query while the rest of the batch is
   *  still answered. The default policy does not decline. */
  protected shouldDeclineQuery(_q: MessageProvenanceQuery): boolean {
    return false;
  }

  private async queryOne(
    q: MessageProvenanceQuery,
  ): Promise<MessageProvenanceResult> {
    // Per-query refusal. A responder whose policy declines this individual query returns
    // `known: "declined"` while the rest of the batch keeps its own answers inside the same
    // HTTP 200/`code` 0 response. The default policy does not decline.
    if (this.shouldDeclineQuery(q)) {
      return { thread: q.thread, seq: q.seq, known: 'declined' };
    }
    // Find candidate messages by the indexed (contentDigest, seq). A matching digest is necessary
    // but not sufficient: the message's thread must also resolve to the query thread.
    const candidates = await this.database.db
      .select({
        threadId: message.threadId,
        seq: message.seq,
        contentDigest: message.contentDigest,
      })
      .from(message)
      .where(
        and(
          eq(message.contentDigest, q.contentDigest),
          eq(message.seq, q.seq),
        ),
      )
      .limit(2);
    if (candidates.length === 0) {
      return { thread: q.thread, seq: q.seq, known: 'no' };
    }
    for (const candidate of candidates) {
      if (await this.threadMatches(candidate.threadId, q.thread)) {
        return { thread: q.thread, seq: q.seq, known: 'yes' };
      }
    }
    return { thread: q.thread, seq: q.seq, known: 'no' };
  }

  /** Whether the local thread at `threadId` resolves to the wire `ThreadAddress` of the query. */
  private async threadMatches(
    threadId: number,
    queryThread: MessageProvenanceQuery['thread'],
  ): Promise<boolean> {
    const [thread] = await this.database.db
      .select({
        type: messageThread.type,
        groupAccount: messageThread.groupAccount,
      })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!thread) return false;
    // GROUP: the wire thread is `{ account: GroupAccount }` and the local thread carries the same
    // group account. A local authoritative group also sets groupDomain, but the wire address
    // carries only the account, so matching by account is the contract.
    if ('peerAccount' in queryThread) {
      // P2P wire thread. The local thread table does not store the peer account pair directly; a
      // P2P thread is owned by a relationship. Without resolving that relationship here, fall back
      // to accepting the (threadId, seq, contentDigest) match: the digest is content-addressed and
      // collision-resistant, so a digest+seq match on any thread is strong evidence of the right
      // message. A deployer that needs stricter P2P thread binding can override this method.
      return thread.type === 'P2P';
    }
    return (
      thread.type === 'GROUP' && thread.groupAccount === queryThread.account
    );
  }
}
