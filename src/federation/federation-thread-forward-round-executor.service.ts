import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import {
  FORWARD_MAX_WIRE_JSON_BYTES,
  type ForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import {
  encodeFederationResourceComponent,
  requireBundleId,
} from './federation-resource-request.js';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import { FederationService, S2sResponseError } from './federation.service.js';
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
  prefetchedForwardClosures: ReadonlyMap<number, ForwardWireBundle>;
}

interface BufferedForwardTombstonePage {
  response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
  frozenTargetSeq: number;
}

@Injectable()
export class FederationThreadForwardRoundExecutorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rounds: FederationThreadForwardRoundService,
    private readonly threadResources: FederationThreadResourceClient,
    private readonly federation: FederationService,
    private readonly sources: FederationThreadSourceService,
  ) {}

  async runMessages(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    take?: number,
  ): Promise<FederationThreadForwardMessageRoundResult> {
    const source = await this.sources.resolve(
      threadId,
      peerDomain,
      namespaceId,
    );
    let messageBatch: BufferedForwardMessagePage | undefined;
    let messageAdvance: { processed: number; target: number } | undefined;
    return this.rounds.runMessages(
      threadId,
      peerDomain,
      namespaceId,
      {
        process: async (params) => {
          const result = await this.processMessages(source, params);
          messageBatch = result.batch;
          messageAdvance = {
            processed: result.scannedThrough,
            target: params.through,
          };
        },
        complete: async ({ authorizationEpoch }) => {
          let publish: (() => Promise<void>) | undefined;
          await this.database.db.transaction(async (tx) => {
            await FederationThreadSyncStateService.lockAuthorizationEpochInTx(
              tx,
              threadId,
              authorizationEpoch,
            );
            if (messageBatch) {
              const publication =
                await this.federation.applyForwardMessagePageInTransaction(
                  tx,
                  messageBatch,
                );
              publish = publication.publish;
            }
            if (messageAdvance)
              await FederationThreadSyncStateService.advanceMessageProcessedThroughInTx(
                tx,
                threadId,
                messageAdvance.processed,
                messageAdvance.target,
              );
          });
          await publish?.();
        },
      },
      take,
    );
  }

  async runTombstones(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    take?: number,
  ): Promise<FederationThreadForwardTombstoneRoundResult> {
    const source = await this.sources.resolve(
      threadId,
      peerDomain,
      namespaceId,
    );
    let tombstoneBatch: BufferedForwardTombstonePage | undefined;
    let deletionAdvance: { processed: number; target: number } | undefined;
    return this.rounds.runTombstones(
      threadId,
      peerDomain,
      namespaceId,
      {
        process: async (params) => {
          const result = await this.processTombstones(source, params);
          tombstoneBatch = result.batch;
          deletionAdvance = {
            processed: result.scannedThrough,
            target: params.through,
          };
        },
        complete: async ({ authorizationEpoch }) => {
          let publish: (() => Promise<void>) | undefined;
          await this.database.db.transaction(async (tx) => {
            await FederationThreadSyncStateService.lockAuthorizationEpochInTx(
              tx,
              threadId,
              authorizationEpoch,
            );
            if (tombstoneBatch) {
              const publication =
                await this.federation.applyForwardTombstonePageInTransaction(
                  tx,
                  tombstoneBatch,
                );
              publish = publication.publish;
            }
            if (deletionAdvance)
              await FederationThreadSyncStateService.advanceDeletionProcessedThroughInTx(
                tx,
                threadId,
                deletionAdvance.processed,
                deletionAdvance.target,
              );
          });
          await publish?.();
        },
      },
      take,
    );
  }

  private async processMessages(
    source: FederationReverseThreadSource,
    params: { after: number; through: number; take: number },
  ): Promise<{
    scannedThrough: number;
    batch?: BufferedForwardMessagePage;
  }> {
    const query = this.threadQuery(source);
    query.set('after', params.after.toString());
    query.set('through', params.through.toString());
    query.set('take', params.take.toString());
    query.set('includeSelf', 'true');
    let response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    try {
      response = await this.threadResources.fetch<FederationMessageQueryPage>(
        source.threadId,
        `/s2s/v1/messages?${query.toString()}`,
        source.peerDomain,
        16 * 1024 * 1024,
      );
    } catch (error) {
      const resumeAfter = this.resumeAfter(error, params.after, params.through);
      if (resumeAfter === null) throw error;
      return { scannedThrough: resumeAfter };
    }
    this.assertMessagePage(source, response.data, params);
    const closures = await this.prefetchForwardClosures(source, response);
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
  ): Promise<{
    scannedThrough: number;
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
          `/s2s/v1/message-tombstones?${query.toString()}`,
          source.peerDomain,
          4 * 1024 * 1024,
        );
    } catch (error) {
      const resumeAfter = this.resumeAfter(error, params.after, params.through);
      if (resumeAfter === null) throw error;
      return { scannedThrough: resumeAfter };
    }
    this.assertTombstonePage(source, response.data, params);
    return {
      scannedThrough: response.data.scannedThrough,
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
      thread?.account === source.selector.account &&
      ('peerAccount' in source.selector
        ? 'peerAccount' in thread &&
          thread.peerAccount === source.selector.peerAccount
        : !('peerAccount' in thread))
    );
  }

  private async prefetchForwardClosures(
    source: FederationReverseThreadSource,
    response: FederationThreadResourceResponse<FederationMessageQueryPage>,
  ): Promise<ReadonlyMap<number, ForwardWireBundle>> {
    const result = new Map<number, ForwardWireBundle>();
    const byBundleId = new Map<string, ForwardWireBundle>();
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
        this.malformed('peer returned an invalid FORWARD card');
      }
      let closure = byBundleId.get(bundleId);
      if (!closure) {
        const dependency = await this.threadResources.fetch<ForwardWireBundle>(
          source.threadId,
          `/s2s/v1/forward-bundles/${encodeFederationResourceComponent(bundleId)}`,
          source.peerDomain,
          FORWARD_MAX_WIRE_JSON_BYTES,
        );
        if (
          dependency.threadId !== response.threadId ||
          dependency.peerDomain !== response.peerDomain ||
          dependency.federationVersion !== response.federationVersion ||
          dependency.peerToken.domain !== response.peerToken.domain ||
          dependency.peerToken.namespaceId !== response.peerToken.namespaceId ||
          dependency.peerToken.rootKeyFingerprint !==
            response.peerToken.rootKeyFingerprint
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
    query.set('account', source.selector.account);
    if ('peerAccount' in source.selector)
      query.set('peerAccount', source.selector.peerAccount);
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
