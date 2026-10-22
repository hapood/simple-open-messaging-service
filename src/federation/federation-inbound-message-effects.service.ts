import { Injectable, Logger, Optional } from '@nestjs/common';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import {
  ForwardBundleService,
  type ForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { ProfileEvidenceProjectionService } from '../profile-resolution/profile-evidence-projection.service.js';
import { ProfileResolutionCoordinatorService } from '../profile-resolution/profile-resolution-coordinator.service.js';
import { loadFederationRuntimeConfig } from './federation.config.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';
import { FederationMediaLocalizationService } from './federation-media-localization.service.js';
import { type FederationMessagePageEffect as MissedPageEffect } from './federation-inbound-message-page.service.js';

/**
 * Publishes ancillary work for inbound message-query pages AFTER their source
 * transaction commits: pending media file sync batches, forward-bundle card
 * rebuilds under the configured forwarded-resource policy, profile demand
 * resolution, profile evidence projections, and forward-asset localization.
 * Message and tombstone fanout itself is admitted in the source transaction;
 * only effects that must not run inside it land here.
 */
@Injectable()
export class FederationInboundMessageEffectsService {
  private readonly config = loadFederationRuntimeConfig();
  private readonly logger = new Logger(
    FederationInboundMessageEffectsService.name,
  );

  constructor(
    private readonly mediaRangeClient: FederationMediaRangeClient,
    private readonly inboundMediaBatches: FederationInboundMediaBatchService,
    private readonly mediaLocalization: FederationMediaLocalizationService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly linkPreview: LinkPreviewService,
    @Optional()
    private readonly profileResolutions?: ProfileResolutionCoordinatorService,
    @Optional()
    private readonly profileEvidenceProjections?: ProfileEvidenceProjectionService,
  ) {}

  /** Publish ancillary work only; message and tombstone fanout is admitted in the source transaction. */
  async publish(domain: string, effects: MissedPageEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'pending') {
        void this.runFileSyncBatch(effect.batchId, (digest, offset) =>
          this.fetchMediaChunks(
            domain,
            digest,
            effect.author.account,
            domain,
            effect.toAccount,
            effect.originSeq,
            offset,
          ),
        ).catch(() => undefined);
        if (this.profileResolutions && effect.profileDemand) {
          void this.profileResolutions
            .resolveDemand(effect.profileDemand)
            .catch((error: unknown) =>
              this.logger.warn(
                `message profile resolution failed for ${effect.threadId}:${effect.seq}: ${(error as Error).message}`,
              ),
            );
        }
        if (
          this.profileEvidenceProjections &&
          effect.profileEvidenceProjection
        ) {
          void this.profileEvidenceProjections
            .resolve(effect.profileEvidenceProjection)
            .catch((error: unknown) =>
              this.logger.warn(
                `message profile evidence projection failed for ${effect.threadId}:${effect.seq}: ${(error as Error).message}`,
              ),
            );
        }
        continue;
      }
      if (
        this.config.forwardedResourcePolicy === 'rebuild' &&
        effect.localForwardBundleId &&
        !effect.message.isDeleted
      ) {
        await this.forwardBundles.rebuildUntrustedCards(
          effect.localForwardBundleId,
          (url) => this.linkPreview.buildCardContent(url),
        );
      }
      if (this.profileResolutions && effect.profileDemand) {
        void this.profileResolutions
          .resolveDemand(effect.profileDemand)
          .catch((error: unknown) =>
            this.logger.warn(
              `message profile resolution failed for ${effect.threadId}:${effect.message.seq}: ${(error as Error).message}`,
            ),
          );
      }
      if (this.profileEvidenceProjections && effect.profileEvidenceProjection) {
        void this.profileEvidenceProjections
          .resolve(effect.profileEvidenceProjection)
          .catch((error: unknown) =>
            this.logger.warn(
              `message profile evidence projection failed for ${effect.threadId}:${effect.message.seq}: ${(error as Error).message}`,
            ),
          );
      }
      if (
        effect.forwardClosure &&
        effect.remoteForwardBundleId &&
        !effect.message.isDeleted
      ) {
        await this.mediaLocalization.localizeForwardAssets(
          // importClosure validated this closure before the message was stored; the
          // effect only carries it on that success path.
          effect.forwardClosure as ForwardWireBundle,
          domain,
          await this.mediaLocalization.resolveForwardAssetAuth(effect.message),
        );
      }
    }
  }

  /**
   * Drive every pending file in a batch, then promote the staged message once all files succeed.
   * The extracted coordinator serializes concurrent retry and recovery attempts for the same batch.
   */
  private async runFileSyncBatch(
    batchId: string,
    fetchChunksFor: (digest: string, offset: number) => AsyncIterable<Buffer>,
  ): Promise<void> {
    await this.inboundMediaBatches.runFileSyncBatch(batchId, fetchChunksFor);
  }

  /**
   * Receiver-side resumable media fetch (Step 2 §4.5): yield a peer-hosted chat-media asset as ordered
   * Buffer chunks via signed Range GETs to /media/:digest, for saveCasFromStream to stream to disk. Each
   * yielded Buffer is ONE fully-accumulated Range unit (≤ mediaChunkBytes), so a body-read abort
   * discards only that unit upstream and is re-requested from the SAME offset — the writer never sees a
   * partial/duplicated slice, and resume is byte-exact. Offset advances by the peer's returned
   * Content-Range (the server may clamp the tail, RFC 7233 §4.2), NOT by the requested window.
   *
   * Degradation policy is STATUS-based (the fetch-throws-vs-body-abort proxy is unreliable at the header
   * boundary): a fetch rejection or 5xx → peer unreachable → markTransportDegraded + throw. Registered 200
   * business errors and 400/401/416 reject only this transfer without degrading. A body-read error AFTER
   * a 206 → retry the same unit, NO degradation (peer alive; lost a
   * stream). After mediaMaxChunkRetries consecutive failures → give up (throw; localizeMedia leaves it
   * inert). markContactSuccess fires ONCE per digest (after the first 2xx headers). If the peer returns
   * A peer that ignores Range and returns 200 is rejected: federation media requires exact resumable
   * ranges. Per-unit Content-Digest is optional, but when present it is verified before yielding; the
   * final CAS digest remains mandatory in both cases.
   */
  private async *fetchMediaChunks(
    peerDomain: string,
    digest: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
    sourceSeq: number,
    startOffset = 0,
  ): AsyncGenerator<Buffer> {
    yield* this.mediaRangeClient.fetch(
      peerDomain,
      digest,
      fromAccount,
      fromDomain,
      toAccount,
      sourceSeq,
      startOffset,
    );
  }
}
