import { Injectable } from '@nestjs/common';
import {
  FEDERATION_THREAD_SEQUENCE_MAX,
  resolveFederationThreadRoundTake,
} from './federation-thread-round.constants.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

export type FederationReverseMessageResult =
  | { kind: 'page'; scannedThrough: number; hasMore: boolean }
  | { kind: 'history-boundary' };

export interface FederationThreadReverseRoundDriver {
  fetchMessages(params: {
    threadId: number;
    peerDomain: string;
    before: number;
    through?: number;
    take: number;
  }): Promise<FederationReverseMessageResult>;
  processDepartedMemberProfiles?(params: {
    threadId: number;
    peerDomain: string;
    before: number;
    through: number;
    take: number;
  }): Promise<void>;
  hasBlockingPendingAtFrontier(params: {
    threadId: number;
    peerDomain: string;
    frontierSeq: number;
  }): Promise<boolean>;
  complete(params: {
    threadId: number;
    peerDomain: string;
    frozenBeforeSeq: number;
    frozenClosureOriginSeq: number | null;
    nextBeforeSeq: number;
    closesReverseHistory: boolean;
  }): Promise<void>;
}

export interface FederationThreadReverseRoundResult {
  beforeSeq: number;
  closureOriginSeq: number | null;
  batchOldestSeq: number | null;
  nextBeforeSeq: number;
  fetchedMessages: boolean;
  processedDepartedMemberProfiles: boolean;
  blockedByPending: boolean;
  closesReverseHistory: boolean;
}

/** Executes one already-single-flighted reverse construction round. The driver atomically publishes
 * the completed local window and commits its reverse position; scheduling remains caller-owned. */
@Injectable()
export class FederationThreadReverseRoundService {
  constructor(private readonly states: FederationThreadSyncStateService) {}

  async run(
    threadId: number,
    peerDomain: string,
    driver: FederationThreadReverseRoundDriver,
    requestedTake?: number,
  ): Promise<FederationThreadReverseRoundResult> {
    const take = resolveFederationThreadRoundTake(requestedTake);
    const state = await this.states.require(threadId, peerDomain);
    const beforeSeq = state.reverseNextBeforeSeq;
    const closureOriginSeq = state.reverseClosureOriginSeq;
    this.assertBeforeCursor(beforeSeq, 'reverse before seq');
    this.assertClosureTarget(closureOriginSeq, beforeSeq);

    if (state.historyBoundaryReached) {
      return {
        beforeSeq,
        closureOriginSeq,
        batchOldestSeq: null,
        nextBeforeSeq: beforeSeq,
        fetchedMessages: false,
        processedDepartedMemberProfiles: false,
        blockedByPending: false,
        closesReverseHistory: true,
      };
    }
    if (beforeSeq === 0) {
      await driver.complete({
        threadId,
        peerDomain,
        frozenBeforeSeq: 0,
        frozenClosureOriginSeq: null,
        nextBeforeSeq: 0,
        closesReverseHistory: true,
      });
      return {
        beforeSeq: 0,
        closureOriginSeq: null,
        batchOldestSeq: null,
        nextBeforeSeq: 0,
        fetchedMessages: false,
        processedDepartedMemberProfiles: false,
        blockedByPending: false,
        closesReverseHistory: true,
      };
    }
    if (
      await driver.hasBlockingPendingAtFrontier({
        threadId,
        peerDomain,
        frontierSeq: beforeSeq,
      })
    ) {
      return {
        beforeSeq,
        closureOriginSeq,
        batchOldestSeq: null,
        nextBeforeSeq: beforeSeq,
        fetchedMessages: false,
        processedDepartedMemberProfiles: false,
        blockedByPending: true,
        closesReverseHistory: false,
      };
    }

    const reusable = await this.states.deriveReusableReverseBatch({
      threadId,
      peerDomain,
      beforeSeq,
      closureOriginSeq,
      take,
    });
    let fetchedMessages = false;
    let batchOldestSeq: number;
    let closesReverseHistory = false;
    if (reusable.canSkipMessageQuery) {
      if (reusable.batchOldestSeq === null) {
        throw new Error('complete reusable reverse batch has no oldest seq');
      }
      batchOldestSeq = reusable.batchOldestSeq;
      this.assertBatchBoundary(batchOldestSeq, beforeSeq);
      closesReverseHistory = reusable.reachedClosureTarget;
    } else {
      const result = await driver.fetchMessages({
        threadId,
        peerDomain,
        before: beforeSeq,
        ...(closureOriginSeq === null ? {} : { through: closureOriginSeq }),
        take,
      });
      fetchedMessages = true;
      if (result.kind === 'history-boundary') {
        await driver.complete({
          threadId,
          peerDomain,
          frozenBeforeSeq: beforeSeq,
          frozenClosureOriginSeq: closureOriginSeq,
          nextBeforeSeq: beforeSeq,
          closesReverseHistory: true,
        });
        return {
          beforeSeq,
          closureOriginSeq,
          batchOldestSeq: null,
          nextBeforeSeq: beforeSeq,
          fetchedMessages,
          processedDepartedMemberProfiles: false,
          blockedByPending: false,
          closesReverseHistory: true,
        };
      }
      batchOldestSeq = result.scannedThrough;
      this.assertBatchBoundary(batchOldestSeq, beforeSeq);
      closesReverseHistory =
        !result.hasMore ||
        (closureOriginSeq !== null && batchOldestSeq <= closureOriginSeq);
    }

    let processedDepartedMemberProfiles = false;
    if (driver.processDepartedMemberProfiles) {
      await driver.processDepartedMemberProfiles({
        threadId,
        peerDomain,
        before: beforeSeq,
        through: batchOldestSeq,
        take,
      });
      processedDepartedMemberProfiles = true;
    }

    const nextBeforeSeq = batchOldestSeq;
    await driver.complete({
      threadId,
      peerDomain,
      frozenBeforeSeq: beforeSeq,
      frozenClosureOriginSeq: closureOriginSeq,
      nextBeforeSeq,
      closesReverseHistory,
    });
    return {
      beforeSeq,
      closureOriginSeq,
      batchOldestSeq,
      nextBeforeSeq,
      fetchedMessages,
      processedDepartedMemberProfiles,
      blockedByPending: false,
      closesReverseHistory,
    };
  }

  private assertBatchBoundary(batchOldestSeq: number, beforeSeq: number): void {
    this.assertCoordinate(batchOldestSeq, 'reverse scanned-through seq');
    if (batchOldestSeq === 0 || batchOldestSeq >= beforeSeq) {
      throw new Error(
        'reverse scanned-through seq must be positive and less than its before cursor',
      );
    }
  }

  private assertCoordinate(value: number, label: string): void {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > FEDERATION_THREAD_SEQUENCE_MAX
    ) {
      throw new Error(
        `${label} must be an integer between 0 and ${FEDERATION_THREAD_SEQUENCE_MAX}`,
      );
    }
  }

  private assertBeforeCursor(value: number, label: string): void {
    const maximum = FEDERATION_THREAD_SEQUENCE_MAX + 1;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new Error(`${label} must be an integer between 0 and ${maximum}`);
    }
  }

  private assertClosureTarget(
    closureOriginSeq: number | null,
    beforeSeq: number,
  ): void {
    if (closureOriginSeq === null) return;
    this.assertCoordinate(closureOriginSeq, 'reverse closure origin seq');
    if (closureOriginSeq === 0 || closureOriginSeq >= beforeSeq) {
      throw new Error(
        'reverse closure origin seq must be positive and less than its before cursor',
      );
    }
  }
}
