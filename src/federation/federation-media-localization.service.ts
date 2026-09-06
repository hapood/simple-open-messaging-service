import { Injectable } from '@nestjs/common';
import { and, eq, inArray, or } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { MediaStatus } from '../common/media-status.js';
import { DatabaseService } from '../database/database.service.js';
import { ContentType, MessageThreadType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import type { ForwardWireBundle } from '../forward/forward-bundle.service.js';
import { ForwardBundleService } from '../forward/forward-bundle.service.js';
import type { Message } from '../message/message.service.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';
import {
  extractDigestEntries,
  extractDigests,
} from '../upload/file-content.js';
import { UploadService } from '../upload/upload.service.js';
import { loadFederationConfig } from './federation.config.js';
import {
  federationFileSyncKind,
  isFederatedMediaContentType,
} from './federation-inbound-file-sync.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';

export interface FederationForwardAssetAuthorization {
  fromAccount: string;
  fromDomain: string;
  toAccount: string;
  sourceSeq: number;
}

/** Localizes peer-hosted message and forward-bundle assets into the local CAS. */
@Injectable()
export class FederationMediaLocalizationService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly mediaRanges: FederationMediaRangeClient,
    private readonly visibility: MessageVisibilityService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly inboundBatches: FederationInboundMediaBatchService,
    private readonly threadAccess: FederationThreadAccessService,
  ) {}

  async localizeForwardAssets(
    closure: ForwardWireBundle,
    peerDomain: string,
    authorization: FederationForwardAssetAuthorization,
  ): Promise<void> {
    // Only validated per-bundle manifests authorize downloads; the top-level assets array is a
    // convenience summary and is not an independent authority.
    for (const asset of this.forwardBundles.assetsFromClosure(closure)) {
      try {
        const have = await this.database.db.query.mediaAsset.findFirst({
          where: and(
            eq(tables.mediaAsset.digest, asset.digest),
            eq(tables.mediaAsset.isDeleted, false),
          ),
          columns: { digest: true },
        });
        if (have) continue;
        await this.upload.saveCasFromStream(
          'bin',
          (offset) =>
            this.mediaRanges.fetch(
              peerDomain,
              asset.digest,
              authorization.fromAccount,
              authorization.fromDomain,
              authorization.toAccount,
              authorization.sourceSeq,
              offset,
            ),
          asset.digest,
        );
      } catch {
        // Bundle JSON remains usable and a later manual localization can retry the asset.
      }
    }
  }

  async localizeMediaForMessage(
    userId: number,
    threadId: number,
    seq: number,
  ): Promise<MediaStatus> {
    const msg = await this.visibility.findVisibleByThreadSeq(
      userId,
      threadId,
      seq,
    );
    if (!msg) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `no such message in thread [${threadId}]`,
      );
    }
    if (msg.contentType === ContentType.FORWARD) {
      return this.relocalizeForwardMessage(msg);
    }
    if (!isFederatedMediaContentType(msg.contentType)) return 'ready';
    if (msg.creatorAccount === null || msg.creatorDomain === null) {
      throw new Error('user-authored media message has no creator');
    }
    if (msg.localState === 'STUB') {
      return this.readInboundMediaJobStatus(msg.id);
    }

    const { toAccount, peerDomain: threadPeerDomain } =
      await this.resolveMediaContext(
        msg.threadId,
        msg.creatorAccount,
        msg.creatorDomain,
        msg.creatorDomain === 'local' ? 0 : msg.sourceNamespaceId,
      );
    const sourcePeerDomain = await this.readSourceDomain(msg.sourceNamespaceId);
    const peerDomain = sourcePeerDomain ?? threadPeerDomain;
    if (msg.localState === 'FAILED') {
      if (msg.originSeq === null || sourcePeerDomain === null) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'failed placeholder has no retryable federation source',
        );
      }
      const batchId = await this.restageFailedInboundMessage(msg, {
        peerDomain,
        fromAccount: msg.creatorAccount,
        fromDomain:
          msg.creatorDomain === 'local'
            ? this.config.domain
            : msg.creatorDomain,
        toAccount,
      });
      if (batchId) {
        await this.inboundBatches.publishMessageStatus(
          { threadId: msg.threadId, seq: msg.seq },
          'pending',
        );
        void this.inboundBatches
          .runFileSyncBatch(batchId, (digest, offset) =>
            this.mediaRanges.fetch(
              peerDomain,
              digest,
              msg.creatorAccount!,
              msg.creatorDomain === 'local'
                ? this.config.domain
                : msg.creatorDomain!,
              toAccount,
              msg.originSeq!,
              offset,
            ),
          )
          .catch(() => undefined);
        return 'pending';
      }
      return this.readInboundMediaJobStatus(msg.id);
    }

    const federationVersion = await this.threadAccess.readFederationVersion(
      msg.threadId,
      peerDomain,
    );
    await this.localizeMedia(
      msg,
      peerDomain,
      msg.creatorAccount,
      msg.creatorDomain === 'local' ? this.config.domain : msg.creatorDomain,
      toAccount,
      msg.originSeq ?? msg.seq,
      federationVersion,
    );
    return (await this.isMessageMediaReady(msg.id, msg.content))
      ? 'ready'
      : 'failed';
  }

  async resolveForwardAssetAuth(
    msg: Message,
  ): Promise<FederationForwardAssetAuthorization> {
    if (msg.creatorAccount === null || msg.creatorDomain === null) {
      throw new Error('user-authored forward message has no creator');
    }
    const { toAccount } = await this.resolveMediaContext(
      msg.threadId,
      msg.creatorAccount,
      msg.creatorDomain,
      msg.creatorDomain === 'local' ? 0 : msg.sourceNamespaceId,
    );
    return {
      fromAccount: msg.creatorAccount,
      fromDomain:
        msg.creatorDomain === 'local' ? this.config.domain : msg.creatorDomain,
      toAccount,
      sourceSeq: msg.originSeq ?? msg.seq,
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
    expectedFederationVersion: number,
  ): Promise<void> {
    for (const { digest, ext } of extractDigestEntries(msg.content)) {
      try {
        const have = await this.database.db.query.mediaAsset.findFirst({
          where: and(
            eq(tables.mediaAsset.digest, digest),
            eq(tables.mediaAsset.isDeleted, false),
          ),
          columns: { digest: true },
        });
        if (!have) {
          await this.upload.saveCasFromStream(
            ext,
            (offset) =>
              this.mediaRanges.fetch(
                peerDomain,
                digest,
                fromAccount,
                fromDomain,
                toAccount,
                sourceSeq,
                offset,
              ),
            digest,
          );
        }
        await this.database.db.transaction(async (tx) => {
          await this.threadAccess.assertResponseWritable(
            tx,
            msg.threadId,
            peerDomain,
            expectedFederationVersion,
          );
          await tx
            .insert(tables.messageAsset)
            .values({ messageId: msg.id, threadId: msg.threadId, digest })
            .onConflictDoNothing();
        });
      } catch {
        // Best effort per file: a later manual retry can localize an inert cross-origin URL.
      }
    }
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
    const job = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(tables.pendingMedia.messageId, messageId),
        eq(tables.pendingMedia.direction, 'INBOUND'),
      ),
      columns: { status: true },
    });
    return job?.status === 'pending' ||
      job?.status === 'downloading' ||
      job?.status === 'ready' ||
      job?.status === 'failed'
      ? job.status
      : 'failed';
  }

  private async restageFailedInboundMessage(
    msg: Message,
    authorization: {
      peerDomain: string;
      fromAccount: string;
      fromDomain: string;
      toAccount: string;
    },
  ): Promise<string | null> {
    const digests = extractDigestEntries(msg.content);
    if (digests.length === 0) return null;
    if (msg.sourceNamespaceId === 0) {
      throw new Error('failed inbound message has no source namespace');
    }
    const namespaceId = msg.sourceNamespaceId;
    return this.database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          localState: tables.message.localState,
          authorizationEpoch: tables.messageThread.authorizationEpoch,
        })
        .from(tables.message)
        .innerJoin(
          tables.messageThread,
          eq(tables.messageThread.id, tables.message.threadId),
        )
        .where(eq(tables.message.id, msg.id))
        .for('update', { of: tables.message })
        .limit(1);
      if (!locked || locked.localState !== 'FAILED') return null;
      const pending = await tx.query.pendingMedia.findFirst({
        where: and(
          eq(tables.pendingMedia.messageId, msg.id),
          eq(tables.pendingMedia.direction, 'INBOUND'),
          eq(tables.pendingMedia.status, 'failed'),
        ),
        columns: { id: true, batchId: true },
      });
      if (!pending) return null;
      const batchId = pending.batchId;
      await tx
        .delete(tables.fileSyncProgress)
        .where(eq(tables.fileSyncProgress.batchId, batchId));
      await tx
        .update(tables.pendingMedia)
        .set({
          status: 'pending',
          failReason: null,
          fileCnt: digests.length,
          originDomain: authorization.peerDomain,
          namespaceId,
          expectedAuthorizationEpoch: locked.authorizationEpoch,
          updatedAt: new Date(),
        })
        .where(eq(tables.pendingMedia.id, pending.id));
      for (const { digest, size } of digests) {
        await tx.insert(tables.fileSyncProgress).values({
          batchId,
          digest,
          direction: 'INBOUND',
          kind: federationFileSyncKind(msg.contentType),
          status: 'PENDING',
          bytesTotal: BigInt(size ?? 0),
          originDomain: authorization.peerDomain,
          namespaceId,
          payload: authorization,
        });
      }
      await tx
        .update(tables.message)
        .set({ localState: 'STUB', updatedAt: new Date() })
        .where(eq(tables.message.id, msg.id));
      return batchId;
    });
  }

  private async relocalizeForwardMessage(
    msg: Message,
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
      await this.localizeForwardAssets(
        closure,
        root.sourceDomain,
        await this.resolveForwardAssetAuth(msg),
      );
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

  private async resolveMediaContext(
    threadId: number,
    creatorAccount: string,
    creatorDomain: string,
    authorNamespaceId: number,
  ): Promise<{ toAccount: string; peerDomain: string }> {
    const [thread] = await this.database.db
      .select({
        type: tables.messageThread.type,
        group: {
          account: tables.group.account,
          domain: tables.group.domain,
        },
      })
      .from(tables.messageThread)
      .leftJoin(tables.group, eq(tables.group.id, tables.messageThread.groupId))
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (thread?.type === MessageThreadType.GROUP && thread.group) {
      return {
        toAccount: thread.group.account,
        peerDomain: thread.group.domain,
      };
    }
    const [pair] = await this.database.db
      .select({
        endpointAAccount: tables.relationshipPair.endpointAAccount,
        endpointADomain: tables.relationshipPair.endpointADomain,
        endpointANamespaceId: tables.relationshipPair.endpointANamespaceId,
        endpointBAccount: tables.relationshipPair.endpointBAccount,
      })
      .from(tables.relationshipPair)
      .where(
        and(
          eq(tables.relationshipPair.threadId, threadId),
          eq(tables.relationshipPair.kind, 'P2P'),
          eq(tables.relationshipPair.active, true),
          or(
            and(
              eq(tables.relationshipPair.endpointAType, 'USER'),
              eq(tables.relationshipPair.endpointAAccount, creatorAccount),
              eq(tables.relationshipPair.endpointADomain, creatorDomain),
              eq(
                tables.relationshipPair.endpointANamespaceId,
                authorNamespaceId,
              ),
            ),
            and(
              eq(tables.relationshipPair.endpointBType, 'USER'),
              eq(tables.relationshipPair.endpointBAccount, creatorAccount),
              eq(tables.relationshipPair.endpointBDomain, creatorDomain),
              eq(
                tables.relationshipPair.endpointBNamespaceId,
                authorNamespaceId,
              ),
            ),
          ),
        ),
      )
      .limit(1);
    if (!pair) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'message thread is no longer mutually authorized',
      );
    }
    return {
      toAccount:
        pair.endpointAAccount === creatorAccount &&
        pair.endpointADomain === creatorDomain &&
        pair.endpointANamespaceId === authorNamespaceId
          ? pair.endpointBAccount
          : pair.endpointAAccount,
      peerDomain: creatorDomain,
    };
  }

  private async readSourceDomain(namespaceId: number): Promise<string | null> {
    if (namespaceId === 0) return null;
    const source = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.id, namespaceId),
      columns: { domain: true },
    });
    if (!source)
      throw new Error(`message source namespace ${namespaceId} is missing`);
    return source.domain;
  }
}
