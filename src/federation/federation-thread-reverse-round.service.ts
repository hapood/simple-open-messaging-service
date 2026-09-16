import { Injectable } from '@nestjs/common';
import {
  FEDERATION_THREAD_SEQUENCE_MAX,
  resolveFederationThreadRoundTake,
} from './federation-thread-round.constants.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { FederationThreadRoundRemoteError } from './federation-thread-round-error.js';

export type FederationReverseMessageResult =
  | { kind: 'page'; scannedThrough: number; hasMore: boolean }
  | { kind: 'history-boundary' };

/** Exact reverse network progress exists only for the lifetime of one scheduler process. */
export interface FederationReverseRoundContext {
  authorizationEpoch: number;
  gapId: bigint;
  gapBeforeSeq: number;
  nextBeforeSeq: number;
  throughSeq: number;
  messageSeqOffset: number;
}

export interface FederationThreadReverseRoundDriver {
  fetchMessages(params: {
    threadId: number;
    peerDomain: string;
    before: number;
    through: number;
    take: number;
  }): Promise<FederationReverseMessageResult>;
  complete(params: {
    threadId: number;
    peerDomain: string;
    context: FederationReverseRoundContext;
    closesGap: boolean;
  }): Promise<void>;
  markUnavailable(params: {
    threadId: number;
    peerDomain: string;
    context: FederationReverseRoundContext;
  }): Promise<void>;
}

export interface FederationThreadReverseRoundResult {
  beforeSeq: number;
  throughSeq: number | null;
  batchOldestSeq: number | null;
  nextBeforeSeq: number;
  fetchedMessages: boolean;
  closesReverseHistory: boolean;
  continuation: FederationReverseRoundContext | null;
}

/** Executes one scheduler quantum of an already-single-flighted reverse logical round. */
@Injectable()
export class FederationThreadReverseRoundService {
  constructor(private readonly states: FederationThreadSyncStateService) {}

  async run(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    driver: FederationThreadReverseRoundDriver,
    requestedTake?: number,
    continuation?: FederationReverseRoundContext,
  ): Promise<FederationThreadReverseRoundResult> {
    const take = resolveFederationThreadRoundTake(requestedTake);
    const context = await this.resolveContext(
      threadId,
      peerDomain,
      namespaceId,
      continuation,
    );
    if (context === null) {
      return {
        beforeSeq: 0,
        throughSeq: null,
        batchOldestSeq: null,
        nextBeforeSeq: 0,
        fetchedMessages: false,
        closesReverseHistory: true,
        continuation: null,
      };
    }
    this.assertContext(context);

    const beforeSeq = context.nextBeforeSeq;
    let result: FederationReverseMessageResult;
    try {
      result = await driver.fetchMessages({
        threadId,
        peerDomain,
        before: beforeSeq,
        through: context.throughSeq,
        take,
      });
    } catch (error) {
      throw new FederationThreadRoundRemoteError(
        error,
        context.authorizationEpoch,
      );
    }
    if (result.kind === 'history-boundary') {
      await driver.markUnavailable({ threadId, peerDomain, context });
      return {
        beforeSeq,
        throughSeq: context.throughSeq,
        batchOldestSeq: null,
        nextBeforeSeq: beforeSeq,
        fetchedMessages: true,
        closesReverseHistory: true,
        continuation: null,
      };
    }

    const batchOldestSeq = result.scannedThrough;
    this.assertBatchBoundary(batchOldestSeq, beforeSeq, context.throughSeq);
    const nextContext: FederationReverseRoundContext = {
      ...context,
      nextBeforeSeq: batchOldestSeq,
    };
    const closesReverseHistory =
      !result.hasMore || batchOldestSeq <= context.throughSeq;
    await driver.complete({
      threadId,
      peerDomain,
      context: nextContext,
      closesGap: closesReverseHistory,
    });
    return {
      beforeSeq,
      throughSeq: context.throughSeq,
      batchOldestSeq,
      nextBeforeSeq: batchOldestSeq,
      fetchedMessages: true,
      closesReverseHistory,
      continuation: null,
    };
  }

  private async createContext(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<FederationReverseRoundContext | null> {
    const window = await this.states.resolveReverseWindow(
      threadId,
      namespaceId,
    );
    if (window.gapId === null || window.throughSeq === null) return null;
    return {
      authorizationEpoch: window.authorizationEpoch,
      gapId: window.gapId,
      gapBeforeSeq: window.beforeSeq,
      nextBeforeSeq: window.beforeSeq,
      throughSeq: window.throughSeq,
      messageSeqOffset: window.messageSeqOffset,
    };
  }

  private async resolveContext(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    continuation?: FederationReverseRoundContext,
  ): Promise<FederationReverseRoundContext | null> {
    if (continuation) {
      const state = await this.states.require(threadId, namespaceId);
      if (
        state.authorizationEpoch === continuation.authorizationEpoch &&
        state.activeGapId !== null &&
        state.activeGapId === continuation.gapId
      ) {
        return continuation;
      }
    }
    return this.createContext(threadId, peerDomain, namespaceId);
  }

  private assertContext(context: FederationReverseRoundContext): void {
    this.assertBeforeCursor(context.gapBeforeSeq, 'reverse gap before seq');
    this.assertBeforeCursor(context.nextBeforeSeq, 'reverse next before seq');
    this.assertCoordinate(context.throughSeq, 'reverse through seq');
    if (
      context.throughSeq < 1 ||
      context.nextBeforeSeq <= context.throughSeq ||
      context.nextBeforeSeq > context.gapBeforeSeq
    ) {
      throw new Error('reverse round context has invalid inclusive boundaries');
    }
  }

  private assertBatchBoundary(
    scannedThrough: number,
    beforeSeq: number,
    throughSeq: number,
  ): void {
    this.assertCoordinate(scannedThrough, 'reverse scanned-through seq');
    if (scannedThrough < throughSeq || scannedThrough >= beforeSeq) {
      throw new Error(
        'reverse scanned-through seq must be within its requested interval',
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
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${label} must be an integer between 1 and ${maximum}`);
    }
  }
}
