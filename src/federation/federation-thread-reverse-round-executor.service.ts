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
import { filterMirrorMessagePage } from './federation-mirror-message-filter.js';
import { FederationService, S2sResponseError } from './federation.service.js';
import {
  FederationThreadResourceClient,
  type FederationThreadResourceResponse,
} from './federation-thread-resource-client.service.js';
import type {
  FederationMessageFeedMessage,
  FederationMessageQueryPage,
} from './federation-message-feed.service.js';
import {
  FederationThreadReverseRoundService,
  type FederationReverseMessageResult,
  type FederationReverseRoundContext,
  type FederationThreadReverseRoundResult,
} from './federation-thread-reverse-round.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';

interface BufferedReverseMessageBatch {
  response: FederationThreadResourceResponse<FederationMessageQueryPage>;
  before: number;
  through?: number;
  prefetchedForwardClosures: ReadonlyMap<number, ForwardWireBundle>;
}

/** Connects one caller-owned reverse round to signed peer reads and durable local application.
 * Scheduling and per-direction single-flight ownership deliberately remain outside this service. */
@Injectable()
export class FederationThreadReverseRoundExecutorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rounds: FederationThreadReverseRoundService,
    private readonly threadResources: FederationThreadResourceClient,
    private readonly federation: FederationService,
    private readonly sources: FederationThreadSourceService,
  ) {}

  async run(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    take?: number,
    continuation?: FederationReverseRoundContext,
  ): Promise<FederationThreadReverseRoundResult> {
    const source = await this.sources.resolve(
      threadId,
      peerDomain,
      namespaceId,
    );
    let messageBatch: BufferedReverseMessageBatch | null = null;
    return this.rounds.run(
      threadId,
      peerDomain,
      namespaceId,
      {
        fetchMessages: async (params) => {
          const fetched = await this.fetchMessages(source, params);
          messageBatch = fetched.batch;
          return fetched.result;
        },
        complete: ({ context, closesGap }) => {
          if (!messageBatch)
            throw new Error('reverse round completed without a message batch');
          return this.commit(source, context, closesGap, messageBatch);
        },
        markUnavailable: ({ context }) => this.markUnavailable(source, context),
      },
      take,
      continuation,
    );
  }

  private async fetchMessages(
    source: FederationReverseThreadSource,
    params: { before: number; through?: number; take: number },
  ): Promise<{
    result: FederationReverseMessageResult;
    batch: BufferedReverseMessageBatch | null;
  }> {
    const query = new URLSearchParams();
    query.set('account', source.selector.account);
    if ('peerAccount' in source.selector)
      query.set('peerAccount', source.selector.peerAccount);
    query.set('before', params.before.toString());
    if (params.through !== undefined)
      query.set('through', params.through.toString());
    query.set('take', params.take.toString());
    query.set(
      'includeSelf',
      String(!(source.kind === 'GROUP' && source.localGroupAuthority)),
    );

    let response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    try {
      response = await this.threadResources.fetch<FederationMessageQueryPage>(
        source.threadId,
        `/s2s/v1/messages?${query.toString()}`,
        source.peerDomain,
        16 * 1024 * 1024,
      );
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE
      ) {
        const bounds = this.parseCursorUnavailable(error.data);
        if (bounds && params.before <= bounds.resumeAfter + 1) {
          return { result: { kind: 'history-boundary' }, batch: null };
        }
      }
      throw error;
    }

    this.assertMessagePage(source, response.data, params);
    response = {
      ...response,
      data: filterMirrorMessagePage(source, response.data),
    };
    const prefetchedForwardClosures = await this.prefetchForwardClosures(
      source,
      response,
    );
    return {
      result: {
        kind: 'page',
        scannedThrough: response.data.scannedThrough,
        hasMore: response.data.hasMore,
      },
      batch: {
        response,
        before: params.before,
        ...(params.through === undefined ? {} : { through: params.through }),
        prefetchedForwardClosures,
      },
    };
  }

  private parseCursorUnavailable(data: unknown): {
    resumeAfter: number;
    resumeBefore: number;
  } | null {
    if (typeof data !== 'object' || data === null || Array.isArray(data))
      return null;
    const value = data as Record<string, unknown>;
    if (
      Object.keys(value).length !== 2 ||
      !Number.isSafeInteger(value['resumeAfter']) ||
      Number(value['resumeAfter']) < 0 ||
      !Number.isSafeInteger(value['resumeBefore']) ||
      Number(value['resumeBefore']) < 1 ||
      Number(value['resumeBefore']) <= Number(value['resumeAfter'])
    )
      return null;
    return {
      resumeAfter: Number(value['resumeAfter']),
      resumeBefore: Number(value['resumeBefore']),
    };
  }

  private assertMessagePage(
    source: FederationReverseThreadSource,
    page: FederationMessageQueryPage,
    params: { before: number; through?: number },
  ): void {
    if (
      !page ||
      !Array.isArray(page.messages) ||
      !Number.isSafeInteger(page.scannedThrough) ||
      page.scannedThrough < 1 ||
      page.scannedThrough >= params.before ||
      (params.through !== undefined && page.scannedThrough < params.through) ||
      typeof page.hasMore !== 'boolean' ||
      (params.through !== undefined &&
        page.hasMore !== page.scannedThrough > params.through)
    ) {
      this.malformed('peer returned an invalid reverse message page boundary');
    }
    let previousSeq = params.before;
    for (const item of page.messages) {
      const expectedThread = source.selector;
      const threadMatches =
        item &&
        typeof item.thread === 'object' &&
        item.thread !== null &&
        item.thread.account === expectedThread.account &&
        ('peerAccount' in expectedThread
          ? 'peerAccount' in item.thread &&
            item.thread.peerAccount === expectedThread.peerAccount
          : !('peerAccount' in item.thread));
      if (
        !item ||
        !threadMatches ||
        !Number.isSafeInteger(item.seq) ||
        item.seq < page.scannedThrough ||
        item.seq >= previousSeq
      ) {
        this.malformed('peer returned messages outside strict reverse order');
      }
      previousSeq = item.seq;
    }
  }

  private async prefetchForwardClosures(
    source: FederationReverseThreadSource,
    messageResponse: FederationThreadResourceResponse<FederationMessageQueryPage>,
  ): Promise<ReadonlyMap<number, ForwardWireBundle>> {
    const result = new Map<number, ForwardWireBundle>();
    const byBundleId = new Map<string, ForwardWireBundle>();
    for (const [index, item] of messageResponse.data.messages.entries()) {
      if (item.contentType !== ContentType.FORWARD) continue;
      let bundleId: string;
      try {
        bundleId = this.parseForwardBundleId(item);
      } catch (error) {
        if (
          error instanceof BusinessException &&
          error.bizCode === BusinessCode.FEDERATION_MALFORMED
        ) {
          // Page application logs and isolates malformed cards in their own savepoints.
          continue;
        }
        throw error;
      }
      let closure = byBundleId.get(bundleId);
      if (!closure) {
        const response = await this.threadResources.fetch<ForwardWireBundle>(
          source.threadId,
          `/s2s/v1/forward-bundles/${encodeFederationResourceComponent(bundleId)}`,
          source.peerDomain,
          FORWARD_MAX_WIRE_JSON_BYTES,
        );
        this.assertSameAuthority(messageResponse, response);
        closure = response.data;
        byBundleId.set(bundleId, closure);
      }
      result.set(index, closure);
    }
    return result;
  }

  private parseForwardBundleId(item: FederationMessageFeedMessage): string {
    try {
      const content = JSON.parse(item.content) as Record<string, unknown>;
      if (
        !content ||
        typeof content !== 'object' ||
        Array.isArray(content) ||
        Object.keys(content).length !== 1 ||
        typeof content['bundleId'] !== 'string'
      )
        throw new Error('invalid FORWARD card');
      return requireBundleId(content['bundleId']);
    } catch {
      this.malformed('peer returned an invalid FORWARD card');
    }
  }

  private assertSameAuthority(
    message: FederationThreadResourceResponse<unknown>,
    dependency: FederationThreadResourceResponse<unknown>,
  ): void {
    if (
      dependency.threadId !== message.threadId ||
      dependency.peerDomain !== message.peerDomain ||
      dependency.federationVersion !== message.federationVersion ||
      dependency.peerToken.domain !== message.peerToken.domain ||
      dependency.peerToken.namespaceId !== message.peerToken.namespaceId ||
      dependency.peerToken.rootKeyFingerprint !==
        message.peerToken.rootKeyFingerprint
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `federation thread ${message.threadId} changed while fetching a forward bundle`,
      );
    }
  }

  private async commit(
    source: FederationReverseThreadSource,
    context: FederationReverseRoundContext,
    closesGap: boolean,
    batch: BufferedReverseMessageBatch,
  ): Promise<void> {
    let publish: (() => Promise<void>) | undefined;
    await this.database.db.transaction(async (tx) => {
      await FederationThreadSyncStateService.commitReverseBatchInTx(tx, {
        threadId: source.threadId,
        namespaceId: source.namespaceId,
        authorizationEpoch: context.authorizationEpoch,
        gapId: context.gapId,
        beforeSeq: batch.before,
        scannedThrough: context.nextBeforeSeq,
        throughSeq: context.throughSeq,
        closesGap,
        applyDependencies: async (threadLock) => {
          const applied =
            await this.federation.applyReverseMessagePageInTransaction(tx, {
              ...batch,
              threadLock,
              messageSeqOffset: context.messageSeqOffset,
            });
          publish = applied.publish;
          await this.federation.finalizeReverseMessageWindowInTransaction(tx, {
            threadLock,
            threadId: source.threadId,
            namespaceId: source.namespaceId,
            beforeSeq: batch.before,
            throughSeq: context.nextBeforeSeq,
          });
        },
      });
    });
    await publish?.();
  }

  private async markUnavailable(
    source: FederationReverseThreadSource,
    context: FederationReverseRoundContext,
  ): Promise<void> {
    await this.database.db.transaction((tx) =>
      FederationThreadSyncStateService.markReverseGapUnavailableInTx(tx, {
        threadId: source.threadId,
        namespaceId: source.namespaceId,
        authorizationEpoch: context.authorizationEpoch,
        gapId: context.gapId,
      }),
    );
  }

  private malformed(message: string): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}
