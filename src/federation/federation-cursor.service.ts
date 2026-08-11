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
  localStartChangeId: bigint;
  /** Initial floor the peer exposes to this server; a cursor-reset response may raise it later. */
  remoteStartChangeId: bigint;
}

export interface ServePageContext {
  tx: DatabaseTransaction;
  /** Stable source HWM captured while the peer cursor row is locked. */
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
  /** Last change id examined, including filtered/deleted changes. */
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

  /** Current source-side HWM for one peer. The row is created atomically during /init. */
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
    remoteStartChangeId: bigint,
  ): Promise<FederationCursorInitialization> {
    return this.database.db.transaction((tx) =>
      this.initializePeerInTx(tx, peerDomain, remoteStartChangeId),
    );
  }

  async initializePeerInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    remoteStartChangeId: bigint,
  ): Promise<FederationCursorInitialization> {
    const localStartChangeId = await this.prepareLocalStartInTx(tx, peerDomain);
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
      this.assertNonNegative(remoteStartChangeId, 'remote startChangeId');
      [pull] = await tx
        .insert(federationPullCursor)
        .values({
          peerDomain,
          startChangeId: remoteStartChangeId,
          remoteHwm: remoteStartChangeId,
        })
        .returning();
    }
    if (!pull) throw new Error('federation pull cursor could not be created');
    return {
      localStartChangeId,
      remoteStartChangeId: pull.startChangeId,
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
        startChangeId: 0n,
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
    return serve.startChangeId;
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

        if (
          after < cursor.startChangeId ||
          after < cursor.acknowledgedThrough ||
          after > cursor.allocatedThrough
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MISSED_CURSOR_INVALID,
            `after is outside the allowed cursor range for ${peerDomain}`,
            HttpStatus.CONFLICT,
            this.cursorErrorData(
              after,
              cursor.startChangeId,
              cursor.acknowledgedThrough,
              cursor.allocatedThrough,
            ),
          );
        }

        const retry = after === cursor.acknowledgedThrough;
        const result = await scan({
          tx,
          allocatedThrough: cursor.allocatedThrough,
          after,
          acknowledgedThrough: after,
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
        if (result.scannedThrough < after) {
          throw new FederationCursorError(
            'INVALID_SCANNED_THROUGH',
            'scannedThrough cannot move behind the request cursor',
          );
        }
        if (result.scannedThrough > cursor.allocatedThrough) {
          throw new FederationCursorError(
            'INVALID_SCANNED_THROUGH',
            'scannedThrough cannot move beyond the allocated HWM',
          );
        }

        await tx
          .update(federationServeCursor)
          .set({
            acknowledgedThrough: after,
            lastServedThrough: result.scannedThrough,
            updatedAt: new Date(),
          })
          .where(eq(federationServeCursor.peerDomain, peerDomain));
        return result;
      });
    } catch (error) {
      if (hasPostgresErrorCode(error, PG_LOCK_NOT_AVAILABLE)) {
        const current = await this.readCurrentCursor(peerDomain);
        throw new BusinessException(
          BusinessCode.FEDERATION_MISSED_CONCURRENT,
          `another missed request for ${peerDomain} is still running`,
          HttpStatus.CONFLICT,
          current
            ? this.cursorErrorData(
                after,
                current.startChangeId,
                current.acknowledgedThrough,
                current.allocatedThrough,
              )
            : { requestedCursor: after.toString() },
        );
      }
      throw error;
    }
  }

  private cursorErrorData(
    requested: bigint,
    start: bigint,
    available: bigint,
    allocated: bigint,
  ) {
    return {
      requestedCursor: requested.toString(),
      availableCursor: available.toString(),
      startChangeId: start.toString(),
      allocatedThrough: allocated.toString(),
    };
  }

  private async readCurrentCursor(peerDomain: string) {
    const [row] = await this.database.db
      .select({
        startChangeId: federationServeCursor.startChangeId,
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
