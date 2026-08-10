import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  peerStateFeed,
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
  eventType: PeerStateEventType;
  subjectAccount?: string;
  revision: number;
  body: PeerStateBody;
}

export interface PeerStateFeedPage {
  items: Array<{
    account: string;
    eventType: PeerStateEventType;
    subjectAccount: string;
    revision: string;
    rev: string;
    body: unknown;
  }>;
  scannedThrough: string;
  stateFeedRev: string;
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
        a.account.localeCompare(b.account) ||
        a.eventType.localeCompare(b.eventType) ||
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
      const directional =
        write.eventType === 'P2P_META' ||
        write.eventType === 'GROUP_INVITE_INTENT' ||
        write.eventType === 'GROUP_JOIN_INTENT';
      if (directional !== (subjectAccount !== '')) {
        throw new Error(
          'directional state requires subjectAccount and snapshots forbid it',
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
            eq(peerStateFeed.eventType, write.eventType),
            eq(peerStateFeed.subjectAccount, subjectAccount),
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
          eventType: write.eventType,
          subjectAccount,
          revision: write.revision,
          rev: allocated.rev,
          body,
        })
        .onConflictDoUpdate({
          target: [
            peerStateFeed.peerDomain,
            peerStateFeed.account,
            peerStateFeed.eventType,
            peerStateFeed.subjectAccount,
          ],
          set: {
            revision: write.revision,
            rev: allocated.rev,
            body,
            updatedAt: new Date(),
          },
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

  async serve(
    peerDomain: string,
    after: bigint,
    requestedTake?: number,
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
          throw new BusinessException(
            BusinessCode.FEDERATION_MISSED_CURSOR_INVALID,
            'state feed is not initialized',
            HttpStatus.CONFLICT,
          );
        }
        const stateFeedRev = target.allocatedThrough;
        if (
          after < target.startRev ||
          after < target.acknowledgedThrough ||
          after > stateFeedRev
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MISSED_CURSOR_INVALID,
            'after is outside the state feed range',
            HttpStatus.CONFLICT,
          );
        }
        const rows = await tx
          .select()
          .from(peerStateFeed)
          .where(
            and(
              eq(peerStateFeed.peerDomain, peerDomain),
              gt(peerStateFeed.rev, after),
              lte(peerStateFeed.rev, stateFeedRev),
            ),
          )
          .orderBy(asc(peerStateFeed.rev))
          .limit(take + 1);
        const items: PeerStateFeedPage['items'] = [];
        let bytes = 0;
        for (const row of rows.slice(0, take)) {
          const item = {
            account: row.account,
            eventType: row.eventType,
            subjectAccount: row.subjectAccount,
            revision: row.revision.toString(),
            rev: row.rev.toString(),
            body: row.body,
          };
          const itemBytes = Buffer.byteLength(JSON.stringify(item));
          if (itemBytes > ITEM_BYTES)
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'state feed item exceeds byte limit',
              HttpStatus.PAYLOAD_TOO_LARGE,
            );
          if (items.length > 0 && bytes + itemBytes > PAGE_BYTES) break;
          items.push(item);
          bytes += itemBytes;
        }
        const last = items.at(-1);
        const hasMore = rows.length > items.length;
        const scannedThrough =
          hasMore && last ? BigInt(last.rev) : stateFeedRev;
        await tx
          .update(peerStateFeedTarget)
          .set({
            acknowledgedThrough: after,
            lastServedThrough: scannedThrough,
            updatedAt: new Date(),
          })
          .where(eq(peerStateFeedTarget.peerDomain, peerDomain));
        return {
          items,
          scannedThrough: scannedThrough.toString(),
          stateFeedRev: stateFeedRev.toString(),
          hasMore,
        };
      });
    } catch (error) {
      if (hasPostgresErrorCode(error, PG_LOCK_NOT_AVAILABLE)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MISSED_CONCURRENT,
          `another state feed request for ${peerDomain} is running`,
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }
}
