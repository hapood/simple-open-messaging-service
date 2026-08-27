import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
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
import { serializeBody } from '../common/serialize.interceptor.js';
import { STATE_FEED_PAGE_MAX_BYTES } from '../common/feed-page.js';

export type PeerStateEventType = (typeof peerStateEventType.enumValues)[number];
/** The `/s2s/v1` route is the schema version; bodies contain business state only. */
export type PeerStateBody = Record<string, unknown>;

export interface PeerStateFeedWrite {
  peerDomain: string;
  account: string;
  domain: string;
  eventType: PeerStateEventType;
  subjectAccount: string;
  subjectDomain: string;
  body: PeerStateBody;
  /** Reallocate the same body after one of its referenced compacted keys moved later. */
  forceReindex?: boolean;
}

export interface PeerStateFeedPage {
  items: Array<{
    account: string;
    eventType: PeerStateEventType;
    peerAccount?: string;
    feedId: string;
    body: unknown;
  }>;
  scannedThrough: string;
  stateFeedEndId: string;
  hasMore: boolean;
}

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;

const snapshotRevision = (
  eventType: PeerStateEventType,
  body: PeerStateBody,
): number | string | undefined => {
  if (eventType === 'GROUP_META_FEED_HEAD')
    return typeof body.groupMetaFeedEndId === 'string' &&
      /^(0|[1-9]\d*)$/.test(body.groupMetaFeedEndId)
      ? body.groupMetaFeedEndId
      : undefined;
  const value = eventType === 'PROFILE' ? body.profileRev : undefined;
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
};

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

  async deleteProjectionInTx(
    tx: DatabaseTransaction,
    key: Omit<PeerStateFeedWrite, 'body'>,
  ): Promise<void> {
    await tx
      .delete(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.peerDomain, key.peerDomain),
          eq(peerStateFeed.account, key.account),
          eq(peerStateFeed.domain, key.domain),
          eq(peerStateFeed.eventType, key.eventType),
          eq(peerStateFeed.subjectAccount, key.subjectAccount),
          eq(peerStateFeed.subjectDomain, key.subjectDomain),
        ),
      );
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
        a.subjectDomain.localeCompare(b.subjectDomain) ||
        a.subjectAccount.localeCompare(b.subjectAccount),
    );
    for (const write of ordered) {
      // State bodies are persisted as JSONB before the HTTP serializer sees them. Normalize at this
      // boundary so Date/BigInt use the same wire representation as every HTTP and SSE response.
      const body = serializeBody(write.body);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid peer state feed write');
      }
      const subjectAccount = write.subjectAccount;
      const subjectDomain = write.subjectDomain;
      const directional = write.eventType === 'RELATIONSHIP_INTENT';
      if (
        !write.domain ||
        (directional
          ? subjectAccount === '' || subjectDomain === ''
          : subjectAccount !== '' || subjectDomain !== 'local')
      ) {
        throw new Error(
          'state address key is incomplete or has an invalid directional subject',
        );
      }
      await this.initializePeerInTx(tx, write.peerDomain);
      // The allocator row is the per-peer serialization point. Locking before reading the compacted
      // key prevents two concurrent writers from both observing the old value and burning a feed ID.
      await tx
        .select({ feedId: peerStateFeedTarget.allocatedThrough })
        .from(peerStateFeedTarget)
        .where(eq(peerStateFeedTarget.peerDomain, write.peerDomain))
        .for('update')
        .limit(1);
      const [current] = await tx
        .select({
          body: peerStateFeed.body,
        })
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
      const nextSnapshotRevision = snapshotRevision(write.eventType, body);
      const currentSnapshotRevision = current
        ? snapshotRevision(write.eventType, current.body as PeerStateBody)
        : undefined;
      if (
        current &&
        nextSnapshotRevision !== undefined &&
        currentSnapshotRevision === nextSnapshotRevision
      ) {
        if (!isDeepStrictEqual(current.body, body))
          throw new Error(
            `${write.eventType} revision ${nextSnapshotRevision} changed without advancing`,
          );
        if (!write.forceReindex) continue;
      }
      if (
        current &&
        isDeepStrictEqual(current.body, body) &&
        !write.forceReindex
      )
        continue;
      const [allocated] = await tx
        .update(peerStateFeedTarget)
        .set({
          allocatedThrough: sql`${peerStateFeedTarget.allocatedThrough} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(peerStateFeedTarget.peerDomain, write.peerDomain))
        .returning({ feedId: peerStateFeedTarget.allocatedThrough });
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
          feedId: allocated.feedId,
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
            feedId: allocated.feedId,
            body,
            updatedAt: new Date(),
          },
        });
      result.set(write.peerDomain, allocated.feedId);
    }
    return result;
  }

  async readFeedEndId(peerDomain: string): Promise<bigint> {
    const [target] = await this.database.db
      .select({ feedId: peerStateFeedTarget.allocatedThrough })
      .from(peerStateFeedTarget)
      .where(eq(peerStateFeedTarget.peerDomain, peerDomain))
      .limit(1);
    return target?.feedId ?? 0n;
  }

  async rejectMissingAfter(peerDomain: string): Promise<never> {
    const [target] = await this.database.db
      .select({ peerDomain: peerStateFeedTarget.peerDomain })
      .from(peerStateFeedTarget)
      .where(eq(peerStateFeedTarget.peerDomain, peerDomain))
      .limit(1);
    if (!target) throw new Error(`peer ${peerDomain} has no state feed`);
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the state feed cursor',
      HttpStatus.OK,
      {
        resumeAfter: '0',
        resumeBefore: ((await this.readFeedEndId(peerDomain)) + 1n).toString(),
      },
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
    return this.database.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(peerStateFeedTarget)
        .where(eq(peerStateFeedTarget.peerDomain, peerDomain))
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
      if (after < 0n || after > stateFeedEndId) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
          'state feed cursor is outside the available coordinate space',
          HttpStatus.OK,
          { resumeAfter: '0', resumeBefore: (stateFeedEndId + 1n).toString() },
        );
      }
      const requestedScanEnd =
        through === undefined || through > stateFeedEndId
          ? stateFeedEndId
          : through;
      const scanEnd = requestedScanEnd;
      const rawRows = await tx
        .select()
        .from(peerStateFeed)
        .where(
          and(
            eq(peerStateFeed.peerDomain, peerDomain),
            gt(peerStateFeed.feedId, after),
            lte(peerStateFeed.feedId, scanEnd),
          ),
        )
        .orderBy(asc(peerStateFeed.feedId))
        .limit(take + 1);
      const rows = rawRows.slice(0, take);
      const items: PeerStateFeedPage['items'] = [];
      let bytes = 0;
      for (const row of rows) {
        const item: PeerStateFeedPage['items'][number] = {
          account: row.account,
          eventType: row.eventType,
          feedId: row.feedId.toString(),
          body: row.body,
          ...(row.eventType === 'RELATIONSHIP_INTENT'
            ? {
                peerAccount: row.subjectAccount,
              }
            : {}),
        };
        const itemBytes = Buffer.byteLength(JSON.stringify(item));
        if (items.length > 0 && bytes + itemBytes > STATE_FEED_PAGE_MAX_BYTES)
          break;
        items.push(item);
        bytes += itemBytes;
      }
      const last = items.at(-1);
      let scannedThrough: bigint;
      if (items.length < rows.length && last) {
        scannedThrough = BigInt(last.feedId);
      } else if (rawRows.length > take) {
        scannedThrough = rows.at(-1)?.feedId ?? after;
      } else {
        scannedThrough = scanEnd;
      }
      const hasMore = scannedThrough < scanEnd;
      return {
        items,
        scannedThrough: scannedThrough.toString(),
        stateFeedEndId: stateFeedEndId.toString(),
        hasMore,
      };
    });
  }
}
