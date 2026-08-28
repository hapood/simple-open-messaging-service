import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import { pendingMedia } from '../database/schema.js';
import {
  FORWARD_MAX_WIRE_JSON_BYTES,
  type ForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { FederationDepartedMemberProfileConsumerService } from './federation-departed-member-profile-consumer.service.js';
import {
  encodeFederationResourceComponent,
  requireBundleId,
} from './federation-resource-request.js';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import {
  FederationService,
  S2sResponseError,
  type FederationThreadResourceResponse,
} from './federation.service.js';
import type {
  FederationMessageFeedMessage,
  FederationMessageQueryPage,
} from './federation-message-feed.service.js';
import {
  FederationThreadReverseRoundService,
  type FederationReverseMessageResult,
  type FederationThreadReverseRoundResult,
} from './federation-thread-reverse-round.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';

/** Connects one caller-owned reverse round to signed peer reads and durable local application.
 * Scheduling and per-direction single-flight ownership deliberately remain outside this service. */
@Injectable()
export class FederationThreadReverseRoundExecutorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rounds: FederationThreadReverseRoundService,
    private readonly federation: FederationService,
    private readonly departedProfiles: FederationDepartedMemberProfileConsumerService,
    private readonly sources: FederationThreadSourceService,
  ) {}

  async run(
    threadId: number,
    peerDomain: string,
    take?: number,
  ): Promise<FederationThreadReverseRoundResult> {
    const source = await this.sources.resolve(threadId, peerDomain);
    return this.rounds.run(
      threadId,
      peerDomain,
      {
        fetchMessages: (params) => this.fetchMessages(source, params),
        ...(source.kind === 'GROUP'
          ? {
              processDepartedMemberProfiles: ({
                before,
                through,
                take: pageTake,
              }: {
                threadId: number;
                peerDomain: string;
                before: number;
                through: number;
                take: number;
              }) =>
                this.departedProfiles.process(source, {
                  before,
                  through,
                  take: pageTake,
                }),
            }
          : {}),
        hasBlockingPendingAtFrontier: ({ frontierSeq }) =>
          this.hasPendingAtFrontier(threadId, peerDomain, frontierSeq),
        complete: (params) => this.commit(params),
      },
      take,
    );
  }

  private async fetchMessages(
    source: FederationReverseThreadSource,
    params: { before: number; through?: number; take: number },
  ): Promise<FederationReverseMessageResult> {
    const query = new URLSearchParams();
    query.set('account', source.selector.account);
    if ('peerAccount' in source.selector)
      query.set('peerAccount', source.selector.peerAccount);
    query.set('before', params.before.toString());
    if (params.through !== undefined)
      query.set('through', params.through.toString());
    query.set('take', params.take.toString());
    query.set('includeSelf', 'true');

    let response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    try {
      response =
        await this.federation.fetchThreadResource<FederationMessageQueryPage>(
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
          return { kind: 'history-boundary' };
        }
      }
      throw error;
    }

    this.assertMessagePage(source, response.data, params);
    const prefetchedForwardClosures = await this.prefetchForwardClosures(
      source,
      response,
    );
    await this.federation.applyReverseMessagePage({
      response,
      before: params.before,
      ...(params.through === undefined ? {} : { through: params.through }),
      prefetchedForwardClosures,
    });
    return {
      kind: 'page',
      scannedThrough: response.data.scannedThrough,
      hasMore: response.data.hasMore,
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
      typeof page.hasMore !== 'boolean'
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
      const bundleId = this.parseForwardBundleId(item);
      let closure = byBundleId.get(bundleId);
      if (!closure) {
        const response =
          await this.federation.fetchThreadResource<ForwardWireBundle>(
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
      dependency.peerToken.resetGeneration !==
        message.peerToken.resetGeneration ||
      dependency.peerToken.rootKeyFingerprint !==
        message.peerToken.rootKeyFingerprint
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `federation thread ${message.threadId} changed while fetching a forward bundle`,
      );
    }
  }

  private async hasPendingAtFrontier(
    threadId: number,
    peerDomain: string,
    frontierSeq: number,
  ): Promise<boolean> {
    const pending = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(pendingMedia.threadId, threadId),
        eq(pendingMedia.originDomain, peerDomain),
        eq(pendingMedia.originSeq, frontierSeq),
        eq(pendingMedia.useOriginSeqAsMessageSeq, true),
        ne(pendingMedia.status, 'tombstoned'),
      ),
      columns: { id: true },
    });
    return pending !== undefined;
  }

  private async commit(params: {
    threadId: number;
    peerDomain: string;
    frozenBeforeSeq: number;
    frozenClosureOriginSeq: number | null;
    nextBeforeSeq: number;
    closesReverseHistory: boolean;
  }): Promise<void> {
    await this.database.db.transaction((tx) =>
      FederationThreadSyncStateService.commitReverseProgressInTx(tx, {
        threadId: params.threadId,
        peerDomain: params.peerDomain,
        frozenBeforeSeq: params.frozenBeforeSeq,
        frozenClosureOriginSeq: params.frozenClosureOriginSeq,
        nextBeforeSeq: params.nextBeforeSeq,
        historyBoundaryReached: params.closesReverseHistory,
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
