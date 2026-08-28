import { Injectable } from '@nestjs/common';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { resolveFederationThreadRoundTake } from './federation-thread-round.constants.js';

export interface FederationThreadForwardRoundDriver {
  processMessages(params: {
    threadId: number;
    peerDomain: string;
    after: number;
    through: number;
    take: number;
  }): Promise<{ blockedByPending: boolean }>;
  processTombstones(params: {
    threadId: number;
    peerDomain: string;
    after: number;
    through: number;
    maxMessageSeq: number;
    take: number;
  }): Promise<void>;
  complete(params: {
    threadId: number;
    peerDomain: string;
    messageTargetSeq: number;
    deletionTargetSeq: number;
  }): Promise<void>;
}

export interface FederationThreadForwardRoundResult {
  messageTargetSeq: number;
  deletionTargetSeq: number;
  processedMessages: boolean;
  processedTombstones: boolean;
  blockedByPending: boolean;
}

/** Executes one already-single-flighted forward round. Scheduling and wake-up coalescing are owned by
 * the caller; this service freezes durable targets once and never absorbs targets published mid-run. */
@Injectable()
export class FederationThreadForwardRoundService {
  constructor(private readonly states: FederationThreadSyncStateService) {}

  async run(
    threadId: number,
    peerDomain: string,
    driver: FederationThreadForwardRoundDriver,
    requestedTake?: number,
  ): Promise<FederationThreadForwardRoundResult> {
    const take = resolveFederationThreadRoundTake(requestedTake);
    const state = await this.states.require(threadId, peerDomain);
    const messageTargetSeq = state.messageTargetSeq;
    const deletionTargetSeq = state.deletionTargetSeq;
    const messageProcessedThrough = state.messageProcessedThroughSeq;
    const deletionProcessedThrough = state.deletionProcessedThroughSeq;
    this.assertCoordinate(messageProcessedThrough, 'processed message seq');
    this.assertCoordinate(deletionProcessedThrough, 'processed deletion seq');

    const processMessages = messageTargetSeq > messageProcessedThrough;
    const processTombstones = deletionTargetSeq > deletionProcessedThrough;
    if (!processMessages && !processTombstones) {
      return {
        messageTargetSeq,
        deletionTargetSeq,
        processedMessages: false,
        processedTombstones: false,
        blockedByPending: false,
      };
    }

    let messageResult: { blockedByPending: boolean } = {
      blockedByPending: false,
    };
    const work: Promise<void>[] = [];
    if (processMessages) {
      work.push(
        driver
          .processMessages({
            threadId,
            peerDomain,
            after: messageProcessedThrough,
            through: messageTargetSeq,
            take,
          })
          .then((result) => {
            messageResult = result;
          }),
      );
    }
    if (processTombstones) {
      work.push(
        driver.processTombstones({
          threadId,
          peerDomain,
          after: deletionProcessedThrough,
          through: deletionTargetSeq,
          maxMessageSeq: Math.max(messageProcessedThrough, messageTargetSeq),
          take,
        }),
      );
    }
    await Promise.all(work);
    await driver.complete({
      threadId,
      peerDomain,
      messageTargetSeq,
      deletionTargetSeq,
    });
    return {
      messageTargetSeq,
      deletionTargetSeq,
      processedMessages: processMessages,
      processedTombstones: processTombstones,
      blockedByPending: messageResult.blockedByPending,
    };
  }

  private assertCoordinate(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative safe integer`);
    }
  }
}
