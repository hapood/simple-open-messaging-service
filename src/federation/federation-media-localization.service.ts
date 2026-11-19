import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { MediaStatus } from '../common/media-status.js';
import { DatabaseService } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import type { ForwardWireBundle } from '../forward/forward-bundle.service.js';
import { ForwardBundleService } from '../forward/forward-bundle.service.js';
import type { Message } from '../message/message.service.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';
import {
  extractDigestEntries,
  extractDigests,
} from '../upload/file-content.js';
import { FederationMediaTransferService } from './federation-media-transfer.service.js';
import { isFederatedMediaContentType } from './federation-inbound-file-sync.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { resolveMessageMediaRoute } from './media/media-download-context.js';

export interface FederationForwardAssetAuthorization {
  fromAccount: string;
  fromDomain: string;
  toAccount: string;
  sourceSeq: number;
}

/** Localizes peer-hosted message and forward-bundle assets into the local CAS. */
@Injectable()
export class FederationMediaLocalizationService
  implements BeforeApplicationShutdown
{
  private readonly logger = new Logger(FederationMediaLocalizationService.name);
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  async beforeApplicationShutdown(): Promise<void> {
    this.shutdown.abort(new Error('media localization shutting down'));
    const results = await Promise.allSettled([...this.active]);
    const errors = [
      ...new Set(
        results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        ),
      ),
    ];
    if (errors.length)
      throw new AggregateError(errors, 'media localization shutdown failed');
  }

  private async runLocalization<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    signal.throwIfAborted();
    // Admission is synchronous. Shutdown cannot miss an operation waiting on its first IO.
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    });
    const drained = work.catch((error: unknown) => {
      if (signal.aborted && error === signal.reason) return;
      throw error;
    });
    this.active.add(drained);
    // The owning caller still receives the original error; observe the drain promise
    // immediately so normal execution failures cannot create unhandled rejections.
    void drained.catch(() => undefined);
    try {
      const result = await work;
      signal.throwIfAborted();
      return result;
    } finally {
      this.active.delete(drained);
    }
  }

  constructor(
    private readonly database: DatabaseService,
    private readonly transfers: FederationMediaTransferService,
    private readonly mediaRanges: FederationMediaRangeClient,
    private readonly visibility: MessageVisibilityService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly inboundBatches: FederationInboundMediaBatchService,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly quota: QuotaService,
  ) {}

  async localizeForwardAssets(
    closure: ForwardWireBundle,
    peerDomain: string,
    authorization: FederationForwardAssetAuthorization,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    return this.runLocalization(signal, () =>
      this.localizeForwardAssetsWithSignal(
        closure,
        peerDomain,
        authorization,
        signal,
      ),
    );
  }

  private async localizeForwardAssetsWithSignal(
    closure: ForwardWireBundle,
    peerDomain: string,
    authorization: FederationForwardAssetAuthorization,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    let ready = true;
    // Only validated per-bundle manifests authorize downloads; the top-level assets array is a
    // convenience summary and is not an independent authority.
    for (const asset of this.forwardBundles.assetsFromClosure(closure)) {
      try {
        const namespaceId = await this.quota.activeNamespaceId(peerDomain);
        signal.throwIfAborted();
        await this.transfers.receive({
          signal,
          namespaceId,
          peerDomain,
          digest: asset.digest,
          declaredBytes: asset.bytes,
          chunks: (offset, signal) =>
            this.mediaRanges.fetch(
              peerDomain,
              asset.digest,
              authorization.fromAccount,
              authorization.fromDomain,
              authorization.toAccount,
              authorization.sourceSeq,
              offset,
              asset.bytes,
              signal,
            ),
        });
        signal.throwIfAborted();
      } catch (error) {
        // Preserve the original failure during cancellation. Only the exact signal
        // reason is an expected abort; cleanup/persistence errors must reach the owner.
        if (signal.aborted) throw error;
        this.logger.error(
          `Forward asset ${asset.digest} from ${peerDomain} could not be localized`,
          error,
        );
        ready = false;
        // Bundle JSON remains usable and a later manual localization can retry the asset.
      }
    }
    return ready;
  }

  async localizeMediaForMessage(
    userId: number,
    threadId: number,
    seq: number,
  ): Promise<MediaStatus> {
    const signal = this.shutdown.signal;
    return this.runLocalization(signal, () =>
      this.localizeVisibleMessage(userId, threadId, seq, signal),
    );
  }

  private async localizeVisibleMessage(
    userId: number,
    threadId: number,
    seq: number,
    signal: AbortSignal,
  ): Promise<MediaStatus> {
    const msg = await this.visibility.findVisibleByThreadSeq(
      userId,
      threadId,
      seq,
    );
    signal.throwIfAborted();
    if (!msg) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `no such message in thread [${threadId}]`,
      );
    }
    if (msg.contentType === ContentType.FORWARD) {
      return this.relocalizeForwardMessage(msg, signal);
    }
    if (!isFederatedMediaContentType(msg.contentType)) return 'ready';
    if (msg.creatorAccount === null) {
      throw new Error('user-authored media message has no creator');
    }
    if (msg.localState === 'STUB') {
      return this.readInboundMediaJobStatus(msg.id);
    }

    if (msg.localState === 'FAILED') {
      const retried = await this.inboundBatches.retryInboundMessage(msg);
      return retried ? 'pending' : this.readInboundMediaJobStatus(msg.id);
    }
    const { toAccount, peerDomain } = await resolveMessageMediaRoute(
      this.database,
      msg,
    );

    signal.throwIfAborted();
    await this.threadAccess.assertThreadExists(msg.threadId, peerDomain);
    signal.throwIfAborted();
    const admitted = await this.localizeMedia(
      msg,
      peerDomain,
      msg.creatorAccount,
      peerDomain,
      toAccount,
      msg.originSeq ?? msg.seq,
      signal,
    );
    return admitted && (await this.isMessageMediaReady(msg.id, msg.content))
      ? 'ready'
      : 'failed';
  }

  async resolveForwardAssetAuth(
    msg: Message,
  ): Promise<FederationForwardAssetAuthorization> {
    if (msg.creatorAccount === null) {
      throw new Error('user-authored forward message has no creator');
    }
    const route = await resolveMessageMediaRoute(this.database, msg);
    return {
      fromAccount: route.fromAccount,
      fromDomain: route.fromDomain,
      toAccount: route.toAccount,
      sourceSeq: route.sourceSeq,
    };
  }

  private async localizeMedia(
    msg: {
      id: bigint;
      threadId: number;
      content: string;
    },
    peerDomain: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
    sourceSeq: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    let ready = true;
    const namespaceId = await this.quota.activeNamespaceId(peerDomain);
    signal.throwIfAborted();
    for (const { digest, size } of extractDigestEntries(msg.content)) {
      try {
        if (size === undefined) throw new Error('missing media size');
        signal.throwIfAborted();
        await this.transfers.receive({
          signal,
          namespaceId,
          peerDomain,
          digest,
          declaredBytes: size,
          chunks: (offset, signal) =>
            this.mediaRanges.fetch(
              peerDomain,
              digest,
              fromAccount,
              fromDomain,
              toAccount,
              sourceSeq,
              offset,
              size,
              signal,
            ),
        });
        signal.throwIfAborted();
        await this.database.db.transaction(async (tx) => {
          await this.threadAccess.assertResponseWritable(
            tx,
            msg.threadId,
            peerDomain,
          );
          signal.throwIfAborted();
          await tx
            .insert(tables.messageAsset)
            .values({ messageId: msg.id, threadId: msg.threadId, digest })
            .onConflictDoNothing();
        });
      } catch (error) {
        // Preserve the original failure during cancellation. Only the exact signal
        // reason is an expected abort; cleanup/persistence errors must reach the owner.
        if (signal.aborted) throw error;
        this.logger.error(
          `Message asset ${digest} from ${peerDomain} could not be localized`,
          error,
        );
        ready = false;
        // Best effort per file: a later manual retry can localize an inert cross-origin URL.
      }
    }
    return ready;
  }

  private async isMessageMediaReady(
    messageId: bigint,
    content: string,
  ): Promise<boolean> {
    const digests = extractDigests(content);
    if (digests.length === 0) return true;
    const bindings = await this.database.db.query.messageAsset.findMany({
      where: and(
        eq(tables.messageAsset.messageId, messageId),
        inArray(tables.messageAsset.digest, digests),
      ),
      columns: { digest: true },
    });
    if (bindings.length !== digests.length) return false;
    const assets = await this.database.db.query.mediaAsset.findMany({
      where: and(
        inArray(tables.mediaAsset.digest, digests),
        eq(tables.mediaAsset.isDeleted, false),
      ),
      columns: { digest: true },
    });
    return assets.length === digests.length;
  }

  private async readInboundMediaJobStatus(
    messageId: bigint,
  ): Promise<MediaStatus> {
    const message = await this.database.db.query.message.findFirst({
      where: eq(tables.message.id, messageId),
      columns: { localState: true, isDeleted: true },
    });
    if (!message || message.isDeleted || message.localState === 'FAILED')
      return 'failed';
    if (message.localState === 'READY') return 'ready';
    const failed = await this.database.db.query.fileSyncProgress.findFirst({
      where: and(
        eq(tables.fileSyncProgress.messageId, messageId),
        eq(tables.fileSyncProgress.status, 'FAILED'),
      ),
      columns: { id: true },
    });
    // Completed bytes still await message materialization. Execution progress is
    // delivered by the runtime; temporary coordination is not a status authority.
    return failed ? 'failed' : 'pending';
  }

  private async relocalizeForwardMessage(
    msg: Message,
    signal: AbortSignal,
  ): Promise<'ready' | 'failed'> {
    const binding = await this.database.db.query.forwardMessage.findFirst({
      where: eq(tables.forwardMessage.messageId, msg.id),
      columns: { bundleId: true },
    });
    if (!binding) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'forward bundle binding not found',
      );
    }
    const root = await this.database.db.query.forwardBundle.findFirst({
      where: eq(tables.forwardBundle.id, binding.bundleId),
      columns: { sourceDomain: true, sourceBundleId: true },
    });
    if (!root) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'bundle not found');
    }
    const closure = await this.forwardBundles.buildClosure(binding.bundleId);
    if (root.sourceDomain && root.sourceBundleId) {
      const admitted = await this.localizeForwardAssets(
        closure,
        root.sourceDomain,
        await this.resolveForwardAssetAuth(msg),
        signal,
      );
      if (!admitted) return 'failed';
    }
    const digests = [
      ...new Set(
        this.forwardBundles
          .assetsFromClosure(closure)
          .map((asset) => asset.digest),
      ),
    ];
    const ready =
      digests.length === 0 ||
      (
        await this.database.db.query.mediaAsset.findMany({
          where: and(
            inArray(tables.mediaAsset.digest, digests),
            eq(tables.mediaAsset.isDeleted, false),
          ),
          columns: { digest: true },
        })
      ).length === digests.length;
    return ready ? 'ready' : 'failed';
  }
}
