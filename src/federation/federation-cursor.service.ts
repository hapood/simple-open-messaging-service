import { HttpStatus, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  hasPostgresErrorCode,
  PG_LOCK_NOT_AVAILABLE,
} from '../database/database-error.js';
import { DatabaseService } from '../database/database.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  federationPullCursor,
  federationServeCursor,
} from '../database/schema.js';

export class FederationCursorError extends Error {
  constructor(
    public readonly reason:
      | 'NOT_INITIALIZED'
      | 'INVALID_CURSOR'
      | 'INVALID_SCANNED_THROUGH',
    message: string,
  ) {
    super(message);
    this.name = 'FederationCursorError';
  }
}

export interface FederationCursorInitialization {
  /** Initial floor this server exposes to the peer; retention may raise it later. */
  localRetainedAfter: bigint;
  /** Initial floor the peer exposes to this server; a cursor-reset response may raise it later. */
  remoteRetainedAfter: bigint;
}

export interface ServePageContext {
  tx: DatabaseTransaction;
  /** Stable source allocation upper bound captured while the peer cursor row is locked. */
  allocatedThrough: bigint;
  after: bigint;
  acknowledgedThrough: bigint;
  previouslyServedThrough: bigint;
  retry: boolean;
  degradation: {
    kind: 'HISTORY_TRUNCATED';
    truncatedThrough: bigint;
    since: Date;
  } | null;
}

export interface ServePageResult<T> {
  value: T;
  /** Last feed ID examined, including filtered/deleted entries. */
  scannedThrough: bigint;
}

/**
 * Owns the federation history floors and the source-side sequential missed cursor. A floor starts at
 * the handshake value and may only move forward when retained feed history is physically pruned.
 * servePage holds one peer row lock while its callback scans a page and records scannedThrough.
 */
@Injectable()
export class FederationCursorService {
  constructor(private readonly database: DatabaseService) {}

  /** Current source-side allocation upper bound for one peer. The row is created atomically during /init. */
  async readAllocatedThrough(peerDomain: string): Promise<bigint> {
    const [row] = await this.database.db
      .select({ allocatedThrough: federationServeCursor.allocatedThrough })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!row) {
      throw new FederationCursorError(
        'NOT_INITIALIZED',
        `peer ${peerDomain} has no initialized serve cursor`,
      );
    }
    return row.allocatedThrough;
  }

  /** Bootstrap discovery for callers that do not yet have a message-feed cursor. Always responds
   * with the standard cursor-invalid business result and the exact exclusive cursor to use next. */
  async rejectMissingAfter(peerDomain: string): Promise<never> {
    const current = await this.readCurrentCursor(peerDomain);
    if (!current) {
      throw new FederationCursorError(
        'NOT_INITIALIZED',
        `peer ${peerDomain} has no initialized serve cursor`,
      );
    }
    const availableCursor =
      current.retainedAfter > current.acknowledgedThrough
        ? current.retainedAfter
        : current.acknowledgedThrough;
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; resume from the available cursor',
      HttpStatus.OK,
      { resumeAfter: availableCursor.toString() },
    );
  }

  /** Creates (once) and returns the local floor that must be sent in the handshake request. */
  async prepareLocalStart(peerDomain: string): Promise<bigint> {
    return this.database.db.transaction((tx) =>
      this.prepareLocalStartInTx(tx, peerDomain),
    );
  }

  /** Reads the outbound floor before first trust, when the peer FK does not exist yet. */
  async prepareHandshakeStart(peerDomain: string): Promise<bigint> {
    const [cursor] = await this.database.db
      .select({ allocatedThrough: federationServeCursor.allocatedThrough })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    return cursor?.allocatedThrough ?? 0n;
  }

  async initializePeer(
    peerDomain: string,
    remoteRetainedAfter: bigint,
  ): Promise<FederationCursorInitialization> {
    return this.database.db.transaction((tx) =>
      this.initializePeerInTx(tx, peerDomain, remoteRetainedAfter),
    );
  }

  async initializePeerInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    remoteRetainedAfter: bigint,
  ): Promise<FederationCursorInitialization> {
    const localRetainedAfter = await this.prepareLocalStartInTx(tx, peerDomain);
    const [serve] = await tx
      .select()
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .for('update')
      .limit(1);
    if (!serve) throw new Error('federation serve cursor could not be created');

    let [pull] = await tx
      .select()
      .from(federationPullCursor)
      .where(eq(federationPullCursor.peerDomain, peerDomain))
      .for('update')
      .limit(1);
    if (!pull) {
      this.assertNonNegative(remoteRetainedAfter, 'remote retainedAfter');
      [pull] = await tx
        .insert(federationPullCursor)
        .values({
          peerDomain,
          retainedAfter: remoteRetainedAfter,
          committedThrough: remoteRetainedAfter,
        })
        .returning();
    }
    if (!pull) throw new Error('federation pull cursor could not be created');
    return {
      localRetainedAfter,
      remoteRetainedAfter: pull.retainedAfter,
    };
  }

  private async prepareLocalStartInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
  ): Promise<bigint> {
    await tx
      .insert(federationServeCursor)
      .values({
        peerDomain,
        allocatedThrough: 0n,
        retainedAfter: 0n,
        acknowledgedThrough: 0n,
        lastServedThrough: 0n,
      })
      .onConflictDoNothing();

    const [serve] = await tx
      .select()
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .for('update')
      .limit(1);
    if (!serve) throw new Error('federation serve cursor could not be created');
    return serve.retainedAfter;
  }

  async servePage<T>(
    peerDomain: string,
    after: bigint,
    scan: (context: ServePageContext) => Promise<ServePageResult<T>>,
  ): Promise<ServePageResult<T>> {
    try {
      return await this.database.db.transaction(async (tx) => {
        const [cursor] = await tx
          .select()
          .from(federationServeCursor)
          .where(eq(federationServeCursor.peerDomain, peerDomain))
          .for('update', { noWait: true })
          .limit(1);
        if (!cursor) {
          throw new FederationCursorError(
            'NOT_INITIALIZED',
            `peer ${peerDomain} has no initialized discovery cursor`,
          );
        }

        const availableCursor =
          cursor.retainedAfter > cursor.acknowledgedThrough
            ? cursor.retainedAfter
            : cursor.acknowledgedThrough;
        if (after < availableCursor) {
          throw new BusinessException(
            BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
            `requested cursor is below the retained floor for ${peerDomain}`,
            HttpStatus.OK,
            { resumeAfter: availableCursor.toString() },
          );
        }
        const validCursor =
          after === availableCursor ||
          after === cursor.acknowledgedThrough ||
          after === cursor.lastServedThrough;
        if (!validCursor || after > cursor.allocatedThrough) {
          throw new BusinessException(
            BusinessCode.FEDERATION_FEED_CURSOR_MISMATCH,
            'after is neither the confirmed nor last served message cursor',
            HttpStatus.OK,
            {
              acknowledgedThrough: cursor.acknowledgedThrough.toString(),
              lastServedThrough: cursor.lastServedThrough.toString(),
            },
          );
        }

        const effectiveAfter = after;
        const effectiveAllocatedThrough = cursor.allocatedThrough;
        const retry =
          effectiveAfter === cursor.acknowledgedThrough &&
          cursor.lastServedThrough > cursor.acknowledgedThrough;
        const result = await scan({
          tx,
          allocatedThrough: effectiveAllocatedThrough,
          after: effectiveAfter,
          acknowledgedThrough: effectiveAfter,
          previouslyServedThrough: cursor.lastServedThrough,
          retry,
          degradation:
            cursor.degradationReason === 'HISTORY_TRUNCATED' &&
            cursor.degradedThrough !== null &&
            cursor.degradedAt !== null
              ? {
                  kind: 'HISTORY_TRUNCATED',
                  truncatedThrough: cursor.degradedThrough,
                  since: cursor.degradedAt,
                }
              : null,
        });
        if (result.scannedThrough < effectiveAfter) {
          throw new FederationCursorError(
            'INVALID_SCANNED_THROUGH',
            'scannedThrough cannot move behind the request cursor',
          );
        }
        if (result.scannedThrough > effectiveAllocatedThrough) {
          throw new FederationCursorError(
            'INVALID_SCANNED_THROUGH',
            'scannedThrough cannot move beyond the allocated HWM',
          );
        }

        await tx
          .update(federationServeCursor)
          .set({
            allocatedThrough: effectiveAllocatedThrough,
            acknowledgedThrough: effectiveAfter,
            lastServedThrough: result.scannedThrough,
            updatedAt: new Date(),
          })
          .where(eq(federationServeCursor.peerDomain, peerDomain));
        return result;
      });
    } catch (error) {
      if (hasPostgresErrorCode(error, PG_LOCK_NOT_AVAILABLE)) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_REQUEST_IN_PROGRESS,
          `another missed request for ${peerDomain} is still running`,
          HttpStatus.OK,
        );
      }
      throw error;
    }
  }

  private async readCurrentCursor(peerDomain: string) {
    const [row] = await this.database.db
      .select({
        retainedAfter: federationServeCursor.retainedAfter,
        acknowledgedThrough: federationServeCursor.acknowledgedThrough,
        allocatedThrough: federationServeCursor.allocatedThrough,
      })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    return row;
  }

  private assertNonNegative(value: bigint, label: string): void {
    if (value < 0n) {
      throw new FederationCursorError(
        'INVALID_CURSOR',
        `${label} must be non-negative`,
      );
    }
  }
}
