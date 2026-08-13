import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  peerStateFeed,
  peerStateFeedVersion,
  peerStateFeedTarget,
  peerStateEventType,
} from '../database/schema.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  hasPostgresErrorCode,
  PG_LOCK_NOT_AVAILABLE,
} from '../database/database-error.js';
import { serializeBody } from '../common/serialize.interceptor.js';

export type PeerStateEventType = (typeof peerStateEventType.enumValues)[number];
/** The `/s2s/v1` route is the schema version; bodies contain business state only. */
export type PeerStateBody = Record<string, unknown>;

export interface PeerStateFeedWrite {
  peerDomain: string;
  account: string;
  domain: string;
  eventType: PeerStateEventType;
  subjectAccount?: string;
  subjectDomain?: string;
  revision: number;
  body: PeerStateBody;
}

export interface PeerStateFeedPage {
  items: Array<{
    account: string;
    domain: string;
    eventType: PeerStateEventType;
    subjectAccount: string;
    subjectDomain: string;
    revision: string;
    feedId: string;
    body: unknown;
  }>;
  scannedThrough: string;
  stateFeedEndId: string;
  hasMore: boolean;
}

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;
const PAGE_BYTES = 4 * 1024 * 1024;
const ITEM_BYTES = 8 * 1024 * 1024;

@Injectable()
export class PeerStateFeedService {
  constructor(private readonly database: DatabaseService) {}

  async initializePeerInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
  ): Promise<void> {
    await tx
      .insert(peerStateFeedTarget)
      .values({ peerDomain })
      .onConflictDoNothing();
  }

  /** Writes are ordered by peer and allocate a rev only when the compacted key advances. */
  async writeManyInTx(
    tx: DatabaseTransaction,
    writes: readonly PeerStateFeedWrite[],
  ): Promise<Map<string, bigint>> {
    const result = new Map<string, bigint>();
    const ordered = [...writes].sort(
      (a, b) =>
        a.peerDomain.localeCompare(b.peerDomain) ||
        a.domain.localeCompare(b.domain) ||
        a.account.localeCompare(b.account) ||
        a.eventType.localeCompare(b.eventType) ||
        (a.subjectDomain ?? '').localeCompare(b.subjectDomain ?? '') ||
        (a.subjectAccount ?? '').localeCompare(b.subjectAccount ?? ''),
    );
    for (const write of ordered) {
      // State bodies are persisted as JSONB before the HTTP serializer sees them. Normalize at this
      // boundary so Date/BigInt use the same wire representation as every HTTP and SSE response.
      const body = serializeBody(write.body);
      if (
        !Number.isInteger(write.revision) ||
        write.revision < 0 ||
        !body ||
        typeof body !== 'object'
      ) {
        throw new Error('invalid peer state feed write');
      }
      const subjectAccount = write.subjectAccount ?? '';
      const subjectDomain = write.subjectDomain ?? '';
      const directional =
        write.eventType === 'P2P_INTENT' ||
        write.eventType === 'GROUP_INVITE_INTENT' ||
        write.eventType === 'GROUP_JOIN_INTENT';
      if (
        !write.domain ||
        directional !== (subjectAccount !== '' && subjectDomain !== '')
      ) {
        throw new Error(
          'state address key is incomplete or has an invalid directional subject',
        );
      }
      await this.initializePeerInTx(tx, write.peerDomain);
      // The allocator row is the per-peer serialization point. Locking before reading the compacted
      // key prevents two concurrent writers from both observing the old revision and burning a rev.
      await tx
        .select({ rev: peerStateFeedTarget.allocatedThrough })
        .from(peerStateFeedTarget)
        .where(eq(peerStateFeedTarget.peerDomain, write.peerDomain))
        .for('update')
        .limit(1);
      const [current] = await tx
        .select({ revision: peerStateFeed.revision })
        .from(peerStateFeed)
        .where(
          and(
            eq(peerStateFeed.peerDomain, write.peerDomain),
            eq(peerStateFeed.account, write.account),
            eq(peerStateFeed.domain, write.domain),
            eq(peerStateFeed.eventType, write.eventType),
            eq(peerStateFeed.subjectAccount, subjectAccount),
            eq(peerStateFeed.subjectDomain, subjectDomain),
          ),
        )
        .limit(1);
      if (current && current.revision >= write.revision) continue;
      const [allocated] = await tx
        .update(peerStateFeedTarget)
        .set({
          allocatedThrough: sql`${peerStateFeedTarget.allocatedThrough} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(peerStateFeedTarget.peerDomain, write.peerDomain))
        .returning({ rev: peerStateFeedTarget.allocatedThrough });
      if (!allocated)
        throw new Error(`missing state feed target for ${write.peerDomain}`);
      await tx
        .insert(peerStateFeed)
        .values({
          peerDomain: write.peerDomain,
          account: write.account,
          domain: write.domain,
          eventType: write.eventType,
          subjectAccount,
          subjectDomain,
          revision: write.revision,
          rev: allocated.rev,
          body,
        })
        .onConflictDoUpdate({
          target: [
            peerStateFeed.peerDomain,
            peerStateFeed.account,
            peerStateFeed.domain,
            peerStateFeed.eventType,
            peerStateFeed.subjectAccount,
            peerStateFeed.subjectDomain,
          ],
          set: {
            revision: write.revision,
            rev: allocated.rev,
            body,
            updatedAt: new Date(),
          },
        });
      await tx.insert(peerStateFeedVersion).values({
        peerDomain: write.peerDomain,
        feedId: allocated.rev,
        account: write.account,
        domain: write.domain,
        eventType: write.eventType,
        subjectAccount,
        subjectDomain,
        revision: write.revision,
        body,
      });
      result.set(write.peerDomain, allocated.rev);
    }
    return result;
  }

  async readRev(peerDomain: string): Promise<bigint> {
    const [target] = await this.database.db
      .select({ rev: peerStateFeedTarget.allocatedThrough })
      .from(peerStateFeedTarget)
      .where(eq(peerStateFeedTarget.peerDomain, peerDomain))
      .limit(1);
    return target?.rev ?? 0n;
  }

  async rejectMissingAfter(peerDomain: string): Promise<never> {
    const [target] = await this.database.db
      .select({
        retainedAfter: peerStateFeedTarget.retainedAfter,
        acknowledgedThrough: peerStateFeedTarget.acknowledgedThrough,
      })
      .from(peerStateFeedTarget)
      .where(eq(peerStateFeedTarget.peerDomain, peerDomain))
      .limit(1);
    if (!target) throw new Error(`peer ${peerDomain} has no state feed`);
    const resumeAfter =
      target.retainedAfter > target.acknowledgedThrough
        ? target.retainedAfter
        : target.acknowledgedThrough;
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; resume from the available state cursor',
      HttpStatus.OK,
      { resumeAfter: resumeAfter.toString() },
    );
  }

  async serve(
    peerDomain: string,
    after: bigint,
    requestedTake?: number,
    through?: bigint,
  ): Promise<PeerStateFeedPage> {
    const take = requestedTake ?? DEFAULT_TAKE;
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take must be an integer from 1 to 200',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      return await this.database.db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(peerStateFeedTarget)
          .where(eq(peerStateFeedTarget.peerDomain, peerDomain))
          .for('update', { noWait: true })
          .limit(1);
        if (!target) {
          throw new Error(
            `peer ${peerDomain} has no initialized state-feed target`,
          );
        }
        const stateFeedEndId = target.allocatedThrough;
        if (through !== undefined && through < after) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'through must be greater than or equal to after',
            HttpStatus.BAD_REQUEST,
          );
        }
        const availableCursor =
          target.retainedAfter > target.acknowledgedThrough
            ? target.retainedAfter
            : target.acknowledgedThrough;
        if (after < availableCursor) {
          throw new BusinessException(
            BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
            'requested state cursor is below the retained floor',
            HttpStatus.OK,
            { resumeAfter: availableCursor.toString() },
          );
        }
        const requestedScanEnd =
          through === undefined || through > stateFeedEndId
            ? stateFeedEndId
            : through;
        const validCursor =
          after === availableCursor ||
          after === target.acknowledgedThrough ||
          after === target.lastServedThrough;
        if (!validCursor || after > stateFeedEndId) {
          throw new BusinessException(
            BusinessCode.FEDERATION_FEED_CURSOR_MISMATCH,
            'after is neither the confirmed nor last served state cursor',
            HttpStatus.OK,
            {
              acknowledgedThrough: target.acknowledgedThrough.toString(),
              lastServedThrough: target.lastServedThrough.toString(),
            },
          );
        }
        const retry =
          after === target.acknowledgedThrough &&
          target.lastServedThrough > target.acknowledgedThrough;
        const scanEnd = retry ? target.lastServedScanEnd : requestedScanEnd;
        const replayEnd = retry ? target.lastServedThrough : scanEnd;
        const rawRows = await tx
          .select()
          .from(peerStateFeedVersion)
          .where(
            and(
              eq(peerStateFeedVersion.peerDomain, peerDomain),
              gt(peerStateFeedVersion.feedId, after),
              lte(peerStateFeedVersion.feedId, replayEnd),
            ),
          )
          .orderBy(asc(peerStateFeedVersion.feedId))
          .limit(retry ? MAX_TAKE + 1 : take + 1);
        const scanRows = retry ? rawRows : rawRows.slice(0, take);
        const latestByKey = new Map<string, (typeof scanRows)[number]>();
        for (const row of scanRows) {
          latestByKey.set(
            `${row.domain}\u0000${row.account}\u0000${row.eventType}\u0000${row.subjectDomain}\u0000${row.subjectAccount}`,
            row,
          );
        }
        const rows = [...latestByKey.values()].sort((a, b) =>
          a.feedId < b.feedId ? -1 : a.feedId > b.feedId ? 1 : 0,
        );
        const items: PeerStateFeedPage['items'] = [];
        let bytes = 0;
        for (const row of rows.slice(0, take)) {
          const item = {
            account: row.account,
            domain: row.domain,
            eventType: row.eventType,
            subjectAccount: row.subjectAccount,
            subjectDomain: row.subjectDomain,
            revision: row.revision.toString(),
            feedId: row.feedId.toString(),
            body: row.body,
          };
          const itemBytes = Buffer.byteLength(JSON.stringify(item));
          if (itemBytes > ITEM_BYTES)
            throw new BusinessException(
              BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
              'state feed item exceeds byte limit',
              HttpStatus.OK,
            );
          if (items.length > 0 && bytes + itemBytes > PAGE_BYTES) break;
          items.push(item);
          bytes += itemBytes;
        }
        const last = items.at(-1);
        let scannedThrough: bigint;
        if (retry) {
          scannedThrough = target.lastServedThrough;
        } else if (items.length < rows.length && last) {
          scannedThrough = BigInt(last.feedId);
        } else if (rawRows.length > take) {
          scannedThrough = scanRows.at(-1)?.feedId ?? after;
        } else {
          scannedThrough = scanEnd;
        }
        const hasMore = scannedThrough < scanEnd;
        await tx
          .update(peerStateFeedTarget)
          .set({
            acknowledgedThrough: retry ? target.acknowledgedThrough : after,
            lastServedThrough: scannedThrough,
            lastServedScanEnd: scanEnd,
            updatedAt: new Date(),
          })
          .where(eq(peerStateFeedTarget.peerDomain, peerDomain));
        return {
          items,
          scannedThrough: scannedThrough.toString(),
          stateFeedEndId: stateFeedEndId.toString(),
          hasMore,
        };
      });
    } catch (error) {
      if (hasPostgresErrorCode(error, PG_LOCK_NOT_AVAILABLE)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_REQUEST_IN_PROGRESS,
          `another state feed request for ${peerDomain} is running`,
          HttpStatus.OK,
        );
      }
      throw error;
    }
  }
}
