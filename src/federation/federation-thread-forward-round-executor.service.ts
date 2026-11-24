import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import { DatabaseService } from '../database/database.service.js';
import {
  FORWARD_MAX_WIRE_JSON_BYTES,
  type InboundForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import {
  encodeFederationResourceComponent,
  requireBundleId,
} from './federation-resource-request.js';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationInboundMessageCommitService } from './federation-inbound-message-commit.service.js';
import { FederationInboundMessagePreparationService } from './federation-inbound-message-preparation.service.js';
import { FederationInboundMessageEffectsService } from './federation-inbound-message-effects.service.js';
import {
  FederationThreadResourceClient,
  type FederationThreadResourceResponse,
} from './federation-thread-resource-client.service.js';
import type {
  FederationMessageFeedMessage,
  FederationMessageQueryPage,
} from './federation-message-feed.service.js';
import type { FederationMessageTombstoneQueryPage } from './federation-message-tombstone-feed.service.js';
import {
  FederationThreadForwardRoundService,
  type FederationThreadForwardMessageRoundResult,
  type FederationThreadForwardTombstoneRoundResult,
} from './federation-thread-forward-round.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

interface BufferedForwardMessagePage {
  response: FederationThreadResourceResponse<FederationMessageQueryPage>;
  after: number;
  frozenTargetSeq: number;
  prefetchedForwardClosures: ReadonlyMap<number, InboundForwardWireBundle>;
}

interface BufferedForwardTombstonePage {
  response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
  frozenTargetSeq: number;
}

@Injectable()
export class FederationThreadForwardRoundExecutorService {
  constructor(
    private readonly rounds: FederationThreadForwardRoundService,
    private readonly threadResources: FederationThreadResourceClient,
    private readonly inboundMessageCommits: FederationInboundMessageCommitService,
    private readonly messageEffects: FederationInboundMessageEffectsService,
    private readonly sources: FederationThreadSourceService,
    private readonly database: DatabaseService,
    private readonly preparation: FederationInboundMessagePreparationService,
  ) {}

  async runMessages(
    threadId: number,
    namespaceId: number,
    signal: AbortSignal,
    take?: number,
  ): Promise<FederationThreadForwardMessageRoundResult> {
    signal.throwIfAborted();
    const source = await this.sources.resolve(threadId, namespaceId);
    let messageBatch: BufferedForwardMessagePage | undefined;
    let messageAdvance: { processed: number; target: number } | undefined;
    return this.rounds.runMessages(
      threadId,
      namespaceId,
      {
        process: async (params) => {
          signal.throwIfAborted();
          const result = await this.processMessages(source, params, signal);
          messageBatch = result.batch;
          messageAdvance = {
            processed: result.scannedThrough,
            target: params.through,
          };
        },
        complete: async ({ authorizationEpoch }) => {
          signal.throwIfAborted();
          let publish: (() => Promise<void>) | undefined;
          const messages = messageBatch
            ? await this.preparation.prepare(
                messageBatch.response,
                messageBatch.prefetchedForwardClosures,
                authorizationEpoch,
                signal,
              )
            : [];
          signal.throwIfAborted();
          await this.database.db.transaction(async (tx) => {
            signal.throwIfAborted();
            const threadLock =
              await FederationThreadSyncStateService.lockAuthorizationEpochInTx(
                tx,
                threadId,
                authorizationEpoch,
              );
            await FederationThreadSourceService.assertAudienceInTx(
              threadLock,
              source,
            );
            if (messageBatch && messages.length > 0) {
              const batch = messageBatch;
              const effects =
                await this.inboundMessageCommits.commitMessagePageInTx(tx, {
                  messages,
                  peerToken: batch.response.peerToken,
                  processedInterval: {
                    left: batch.after,
                    right: batch.response.data.scannedThrough,
                  },
                  threadLock,
                });
              if (effects.length > 0)
                publish = () =>
                  this.messageEffects.publish(
                    batch.response.peerDomain,
                    effects,
                  );
            }
            if (messageAdvance)
              await FederationThreadSyncStateService.advanceMessageProcessedThroughInTx(
                tx,
                threadId,
                messageAdvance.processed,
                messageAdvance.target,
                namespaceId,
              );
            signal.throwIfAborted();
          });
          await publish?.();
        },
      },
      signal,
      take,
    );
  }

  async runTombstones(
    threadId: number,
    namespaceId: number,
    signal: AbortSignal,
    take?: number,
  ): Promise<FederationThreadForwardTombstoneRoundResult> {
    signal.throwIfAborted();
    const source = await this.sources.resolve(threadId, namespaceId);
    let tombstoneBatch: BufferedForwardTombstonePage | undefined;
    let deletionAdvance: { processed: number; target: number } | undefined;
    let hasMore = false;
    const result = await this.rounds.runTombstones(
      threadId,
      namespaceId,
      {
        process: async (params) => {
          signal.throwIfAborted();
          const result = await this.processTombstones(source, params, signal);
          tombstoneBatch = result.batch;
          hasMore = result.hasMore;
          deletionAdvance = {
            processed: result.appliedThrough,
            target: params.through,
          };
        },
        complete: async ({ authorizationEpoch }) => {
          signal.throwIfAborted();
          await this.database.db.transaction(async (tx) => {
            signal.throwIfAborted();
            const threadLock =
              await FederationThreadSyncStateService.lockAuthorizationEpochInTx(
                tx,
                threadId,
                authorizationEpoch,
              );
            await FederationThreadSourceService.assertAudienceInTx(
              threadLock,
              source,
            );
            if (tombstoneBatch) {
              await this.inboundMessageCommits.applyTombstonesInTransaction(
                tx,
                { ...tombstoneBatch, threadLock },
              );
            }
            if (deletionAdvance)
              await FederationThreadSyncStateService.advanceDeletionProcessedThroughInTx(
                tx,
                threadId,
                deletionAdvance.processed,
                deletionAdvance.target,
                namespaceId,
              );
            signal.throwIfAborted();
          });
        },
      },
      signal,
      take,
    );
    return { ...result, hasMore };
  }

  private async processMessages(
    source: FederationReverseThreadSource,
    params: { after: number; through: number; take: number },
    signal: AbortSignal,
  ): Promise<{
    scannedThrough: number;
    batch?: BufferedForwardMessagePage;
  }> {
    const query = this.threadQuery(source);
    query.set('after', params.after.toString());
    query.set('through', params.through.toString());
    query.set('take', params.take.toString());
    query.set(
      'includeSelf',
      source.kind === 'GROUP' && source.localGroupAuthority ? 'false' : 'true',
    );
    let response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    try {
      response = await this.threadResources.fetch<FederationMessageQueryPage>(
        source.threadId,
        `/somfp/v1/messages?${query.toString()}`,
        source.namespaceId,
        signal,
        16 * 1024 * 1024,
      );
    } catch (error) {
      signal.throwIfAborted();
      const resumeAfter = this.resumeAfter(error, params.after, params.through);
      if (resumeAfter === null) throw error;
      return { scannedThrough: resumeAfter };
    }
    this.assertMessagePage(source, response.data, params);
    const closures = await this.prefetchForwardClosures(
      source,
      response,
      signal,
    );
    return {
      scannedThrough: response.data.scannedThrough,
      batch: {
        response,
        after: params.after,
        frozenTargetSeq: params.through,
        prefetchedForwardClosures: closures,
      },
    };
  }

  private async processTombstones(
    source: FederationReverseThreadSource,
    params: {
      after: number;
      through: number;
      maxMessageSeq?: number;
      take: number;
    },
    signal: AbortSignal,
  ): Promise<{
    appliedThrough: number;
    hasMore: boolean;
    batch?: BufferedForwardTombstonePage;
  }> {
    const query = this.threadQuery(source);
    query.set('after', params.after.toString());
    query.set('through', params.through.toString());
    query.set('take', params.take.toString());
    query.set('includeSelf', 'true');
    if (params.maxMessageSeq !== undefined)
      query.set('maxMessageSeq', params.maxMessageSeq.toString());
    let response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
    try {
      response =
        await this.threadResources.fetch<FederationMessageTombstoneQueryPage>(
          source.threadId,
          `/somfp/v1/message-tombstones?${query.toString()}`,
          source.namespaceId,
          signal,
          4 * 1024 * 1024,
        );
    } catch (error) {
      signal.throwIfAborted();
      const resumeAfter = this.resumeAfter(error, params.after, params.through);
      if (resumeAfter === null) throw error;
      const recovered = await this.processTombstones(
        source,
        { ...params, after: resumeAfter },
        signal,
      );
      return {
        ...recovered,
        appliedThrough:
          recovered.batch?.response.data.tombstones.at(-1)?.deletionSeq ??
          params.after,
      };
    }
    this.assertTombstonePage(source, response.data, params);
    return {
      // A source can scan past cutoff-blocked facts. Only applied facts move
      // our durable cursor; an exhausted cutoff waits for messages or a head.
      appliedThrough:
        response.data.tombstones.at(-1)?.deletionSeq ?? params.after,
      hasMore: response.data.hasMore && response.data.tombstones.length > 0,
      batch: { response, frozenTargetSeq: params.through },
    };
  }

  private resumeAfter(
    error: unknown,
    currentAfter: number,
    through: number,
  ): number | null {
    if (
      !(error instanceof S2sResponseError) ||
      error.code !== BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE ||
      typeof error.data !== 'object' ||
      error.data === null ||
      Array.isArray(error.data)
    )
      return null;
    const data = error.data as Record<string, unknown>;
    if (
      Object.keys(data).length !== 2 ||
      !Number.isSafeInteger(data['resumeAfter']) ||
      !Number.isSafeInteger(data['resumeBefore'])
    )
      return null;
    const resumeAfter = Number(data['resumeAfter']);
    const resumeBefore = Number(data['resumeBefore']);
    if (
      resumeAfter <= currentAfter ||
      resumeAfter > through ||
      resumeBefore <= resumeAfter
    )
      return null;
    return resumeAfter;
  }

  private assertMessagePage(
    source: FederationReverseThreadSource,
    page: FederationMessageQueryPage,
    params: { after: number; through: number },
  ): void {
    if (
      !page ||
      !Array.isArray(page.messages) ||
      !Number.isSafeInteger(page.scannedThrough) ||
      page.scannedThrough < params.after ||
      page.scannedThrough > params.through ||
      (page.hasMore && page.scannedThrough === params.after) ||
      page.hasMore !== page.scannedThrough < params.through ||
      typeof page.hasMore !== 'boolean'
    )
      this.malformed('peer returned an invalid forward message page boundary');
    let previous = params.after;
    for (const item of page.messages) {
      if (
        !this.matchesSource(item, source) ||
        !Number.isSafeInteger(item.seq) ||
        item.seq <= previous ||
        item.seq > page.scannedThrough
      )
        this.malformed('peer returned messages outside strict forward order');
      previous = item.seq;
    }
  }

  private assertTombstonePage(
    source: FederationReverseThreadSource,
    page: FederationMessageTombstoneQueryPage,
    params: { after: number; through: number; maxMessageSeq?: number },
  ): void {
    if (
      !page ||
      !Array.isArray(page.tombstones) ||
      !Number.isSafeInteger(page.scannedThrough) ||
      page.scannedThrough < params.after ||
      page.scannedThrough > params.through ||
      (page.hasMore && page.scannedThrough === params.after) ||
      page.hasMore !== page.scannedThrough < params.through ||
      typeof page.hasMore !== 'boolean'
    )
      this.malformed('peer returned an invalid tombstone page boundary');
    let previous = params.after;
    for (const item of page.tombstones) {
      if (
        !this.matchesThread(item.thread, source) ||
        !Number.isSafeInteger(item.deletionSeq) ||
        !Number.isSafeInteger(item.messageSeq) ||
        item.messageSeq < 0 ||
        (params.maxMessageSeq !== undefined &&
          item.messageSeq > params.maxMessageSeq) ||
        item.deletionSeq <= previous ||
        item.deletionSeq > page.scannedThrough
      )
        this.malformed('peer returned tombstones outside strict forward order');
      previous = item.deletionSeq;
    }
  }

  private matchesSource(
    item: FederationMessageFeedMessage,
    source: FederationReverseThreadSource,
  ): boolean {
    return this.matchesThread(item.thread, source);
  }

  private matchesThread(
    thread: FederationMessageFeedMessage['thread'],
    source: FederationReverseThreadSource,
  ): boolean {
    return (
      thread?.account === source.demand.account &&
      ('peerAccount' in source.demand
        ? 'peerAccount' in thread &&
          thread.peerAccount === source.demand.peerAccount
        : !('peerAccount' in thread))
    );
  }

  private async prefetchForwardClosures(
    source: FederationReverseThreadSource,
    response: FederationThreadResourceResponse<FederationMessageQueryPage>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<number, InboundForwardWireBundle>> {
    const result = new Map<number, InboundForwardWireBundle>();
    const byBundleId = new Map<string, InboundForwardWireBundle>();
    for (const [index, item] of response.data.messages.entries()) {
      if (item.contentType !== ContentType.FORWARD) continue;
      let bundleId: string;
      try {
        const content = JSON.parse(item.content) as Record<string, unknown>;
        if (
          !content ||
          typeof content !== 'object' ||
          Array.isArray(content) ||
          Object.keys(content).length !== 1 ||
          typeof content['bundleId'] !== 'string'
        )
          throw new Error('invalid forward card');
        bundleId = requireBundleId(content['bundleId']);
      } catch {
        // Page application logs and isolates malformed cards in their own savepoints.
        continue;
      }
      let closure = byBundleId.get(bundleId);
      if (!closure) {
        const dependency =
          await this.threadResources.fetch<InboundForwardWireBundle>(
            source.threadId,
            `/somfp/v1/forward-bundles/${encodeFederationResourceComponent(bundleId)}`,
            source.namespaceId,
            signal,
            FORWARD_MAX_WIRE_JSON_BYTES,
          );
        if (
          dependency.threadId !== response.threadId ||
          dependency.peerDomain !== response.peerDomain ||
          dependency.peerToken.domain !== response.peerToken.domain ||
          dependency.peerToken.namespaceId !== response.peerToken.namespaceId ||
          dependency.peerToken.rootPublicKey !==
            response.peerToken.rootPublicKey
        )
          this.malformed('federation authority changed during message query');
        closure = dependency.data;
        byBundleId.set(bundleId, closure);
      }
      result.set(index, closure);
    }
    return result;
  }

  private threadQuery(source: FederationReverseThreadSource): URLSearchParams {
    const query = new URLSearchParams();
    query.set('account', source.demand.account);
    if ('peerAccount' in source.demand)
      query.set('peerAccount', source.demand.peerAccount);
    return query;
  }

  private malformed(message: string): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}
