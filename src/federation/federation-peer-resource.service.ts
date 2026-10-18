import { groupStateSql } from '../group/shared/group-state.js';
import {
  groupState as groupStateTable,
  readGroupState,
  groupStateFields,
} from '../group/shared/group-state.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { and, eq, or, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { dataDirectory } from '../common/data-directory.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { MessageThreadType } from '../database/enums.js';
import { resolveAuthorizedFederationThreadInTx } from './federation-thread-query-authorization.js';
import * as tables from '../database/schema.js';
import { ForwardBundleService } from '../forward/forward-bundle.service.js';

function currentThreadResourceAuthorizationSql(
  threadId: typeof tables.message.threadId,
  signerNamespaceId: number,
) {
  return sql`(
    EXISTS (
      SELECT 1
      FROM "RelationshipPair" pair
      WHERE pair."threadId" = ${threadId}
        AND pair.kind = 'P2P'
        AND pair.active = true
        AND pair."endpointANamespaceId" = 0
        AND pair."endpointBNamespaceId" = ${signerNamespaceId}
    )
    OR EXISTS (
      SELECT 1
      FROM "ThreadAudience" audience
      JOIN "MessageThread" authorized_thread
        ON authorized_thread.id = audience."threadId"
      WHERE audience."threadId" = ${threadId}
        AND audience."targetNamespaceId" = ${signerNamespaceId}
        AND audience."localUserId" IS NULL
        AND (authorized_thread.type = 'P2P'
          OR authorized_thread."authorityNamespaceId" = 0)
    )
    OR EXISTS (
      SELECT 1
      FROM "MessageThread" mirror_thread
      JOIN ${groupStateSql} mirror_group ON mirror_group.id = mirror_thread.id
      JOIN "AccountThreadState" local_state
        ON local_state."threadId" = mirror_thread.id
      JOIN "Account" local_identity
        ON local_identity.id = local_state."accountId"
       AND local_identity."namespaceId" = 0
      JOIN "RelationshipPair" pair
        ON pair."threadId" = mirror_thread.id
       AND pair.kind = 'GROUP_MEMBER'
       AND pair."endpointAType" = 'USER'
       AND pair."endpointAAccount" = local_identity.account
       AND pair."endpointANamespaceId" = 0
       AND pair."endpointBType" = 'GROUP'
       AND pair."endpointBAccount" = mirror_group.account
       AND pair."endpointBNamespaceId" = ${signerNamespaceId}
      JOIN "RelationshipIntent" intent
        ON intent."authorAccount" = pair."endpointAAccount"
       AND intent."authorNamespaceId" = pair."endpointANamespaceId"
       AND intent."receiverAccount" = pair."endpointBAccount"
       AND intent."receiverNamespaceId" = pair."endpointBNamespaceId"
      WHERE mirror_thread.id = ${threadId}
        AND mirror_thread.type = 'GROUP'
        AND mirror_thread."authorityNamespaceId" = ${signerNamespaceId}
        AND (intent.status = 'ACCEPTED'
          OR (intent.status = 'REQUESTED'
            AND intent."expiresAt" > CURRENT_TIMESTAMP))
    )
  )`;
}

/** Authorizes peer reads of durable message assets and forward-bundle closures. */
@Injectable()
export class FederationPeerResourceService {
  private readonly logger = new Logger(FederationPeerResourceService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly forwardBundles: ForwardBundleService,
  ) {}

  async resolveMediaFile(
    fromAccount: string,
    toAccount: string,
    fromDomain: string,
    signerDomain: string,
    signerNamespaceId: number,
    digest: string,
    sourceSeq: number,
  ): Promise<{ absPath: string; bytes: number }> {
    if (toAccount.startsWith('!')) {
      return this.resolveGroupMediaFile(
        fromAccount,
        toAccount,
        signerNamespaceId,
        sourceSeq,
        digest,
      );
    }
    const candidates = await this.database.db
      .select({
        messageId: tables.message.id,
        threadId: tables.message.threadId,
        authorNamespaceId: tables.message.profileNamespaceId,
        publisherNamespaceId: tables.message.publisherNamespaceId,
        threadType: tables.messageThread.type,
        groupId: tables.messageThread.id,
      })
      .from(tables.message)
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, tables.message.threadId),
      )
      .where(
        and(
          eq(tables.message.creatorAccount, normalizeAccount(fromAccount)),
          or(
            eq(tables.message.profileNamespaceId, signerNamespaceId),
            and(
              eq(tables.message.publisherNamespaceId, 0),
              eq(tables.message.profileNamespaceId, 0),
            ),
          ),
          eq(tables.message.isDeleted, false),
          eq(tables.message.seq, sourceSeq),
          currentThreadResourceAuthorizationSql(
            tables.message.threadId,
            signerNamespaceId,
          ),
        ),
      );
    let sourceMessage: { id: bigint; threadId: number } | undefined;
    for (const candidate of candidates) {
      if (
        candidate.authorNamespaceId !== signerNamespaceId &&
        !(
          candidate.publisherNamespaceId === 0 &&
          candidate.authorNamespaceId === 0
        )
      )
        continue;
      if (
        !(await this.historicalThreadMatchesRecipient(
          candidate.threadId,
          candidate.threadType,
          candidate.groupId,
          toAccount,
          signerDomain,
          signerNamespaceId,
        ))
      )
        continue;
      sourceMessage = { id: candidate.messageId, threadId: candidate.threadId };
      break;
    }
    if (!sourceMessage)
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'message was not historically delivered to peer',
      );
    return this.resolveMessageMedia(sourceMessage.id, digest);
  }

  private async resolveGroupMediaFile(
    fromAccount: string,
    groupAccount: string,
    signerNamespaceId: number,
    sourceSeq: number,
    digest: string,
  ): Promise<{ absPath: string; bytes: number }> {
    return this.database.db.transaction(
      async (tx) => {
        const authorized = await resolveAuthorizedFederationThreadInTx(
          tx,
          signerNamespaceId,
          { type: 'GROUP', account: normalizeAccount(groupAccount) },
        );
        const group = await readGroupState(
          tx,
          eq(groupStateTable.id, authorized.threadId),
        );
        if (!group || group.dissolvedAt !== null)
          throw new BusinessException(
            BusinessCode.FORBIDDEN,
            'group is unavailable',
          );
        // The signer is the reader, not necessarily the message author. An origin
        // serves its authorized group audience; a mirror serves only its own local
        // submissions back to that group's origin, never third-party copies.
        const originDistribution =
          authorized.groupQueryDirection === 'ORIGIN_DISTRIBUTION';
        const [source] = await tx
          .select({ id: tables.message.id })
          .from(tables.message)
          .where(
            and(
              eq(tables.message.threadId, authorized.threadId),
              eq(tables.message.creatorAccount, normalizeAccount(fromAccount)),
              eq(tables.message.seq, sourceSeq),
              eq(tables.message.isDeleted, false),
              eq(tables.message.localState, 'READY'),
              sql`${tables.message.seq} > ${authorized.messageAccessAfterSeq}`,
              originDistribution
                ? sql`EXISTS (
                SELECT 1 FROM "PeerStateFeed" head
                WHERE head."namespaceId" = ${signerNamespaceId}
                  AND head.account = ${normalizeAccount(groupAccount)}
                  AND head."eventType" = 'THREAD_CONTENT_HEAD'
                  AND head."subjectAccount" = '' AND head."subjectNamespaceId" = 0
                  AND ${tables.message.seq} <= CASE
                    WHEN (head.body ->> 'messageEndSeq') ~ '^[0-9]{1,10}$'
                    THEN (head.body ->> 'messageEndSeq')::numeric ELSE 0 END
              )`
                : and(
                    eq(tables.message.publisherNamespaceId, 0),
                    eq(tables.message.profileNamespaceId, 0),
                  ),
            ),
          );
        if (!source)
          throw new BusinessException(
            BusinessCode.FORBIDDEN,
            'message is not readable by peer',
          );
        return this.resolveMessageMedia(source.id, digest, tx);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async resolveMessageMedia(
    messageId: bigint,
    digest: string,
    store: Pick<DatabaseService['db'], 'query'> = this.database.db,
  ) {
    const binding = await store.query.messageAsset.findFirst({
      where: and(
        eq(tables.messageAsset.messageId, messageId),
        eq(tables.messageAsset.digest, digest),
      ),
      columns: { messageId: true },
    });
    if (binding) return this.resolveCasFile(digest);
    const forwardBinding = await store.query.forwardMessage.findFirst({
      where: eq(tables.forwardMessage.messageId, messageId),
      columns: { bundleId: true },
    });
    if (!forwardBinding)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'digest is not bound to message',
      );
    const closure = await this.forwardBundles.buildClosure(
      forwardBinding.bundleId,
    );
    if (!closure.assets.some((asset) => asset.digest === digest))
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'digest is not bound to forward message',
      );
    return this.resolveCasFile(digest);
  }

  async serveForwardBundleClosure(
    bundleId: string,
    signerDomain: string,
    signerNamespaceId: number,
  ) {
    const localBundleId =
      await this.forwardBundles.resolveWireBundleId(bundleId);
    const [visible] = await this.database.db
      .select({ messageId: tables.forwardMessage.messageId })
      .from(tables.forwardMessage)
      .innerJoin(
        tables.message,
        eq(tables.message.id, tables.forwardMessage.messageId),
      )
      .where(
        and(
          eq(tables.forwardMessage.bundleId, localBundleId),
          eq(tables.message.isDeleted, false),
          currentThreadResourceAuthorizationSql(
            tables.message.threadId,
            signerNamespaceId,
          ),
        ),
      )
      .limit(1);
    if (!visible)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'forward bundle not visible to peer',
      );
    return this.forwardBundles.buildClosure(localBundleId);
  }

  async resolveCasFile(
    digest: string,
  ): Promise<{ absPath: string; bytes: number }> {
    let asset: { bytes: bigint } | undefined;
    try {
      asset = await this.database.db.query.mediaAsset.findFirst({
        where: and(
          eq(tables.mediaAsset.digest, digest),
          eq(tables.mediaAsset.isDeleted, false),
        ),
        columns: { bytes: true },
      });
    } catch (error) {
      this.logger.warn(
        `Unable to verify media asset ${digest}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'media storage unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!asset)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'file unavailable');
    const absPath = dataDirectory(
      'cas',
      digest.slice(0, 2),
      digest.slice(2, 4),
      digest,
    );
    try {
      const file = await stat(absPath);
      if (!file.isFile() || BigInt(file.size) !== asset.bytes) {
        this.logger.warn(`Media asset ${digest} failed its CAS size check`);
        throw new BusinessException(
          BusinessCode.INTERNAL,
          'media storage unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      return { absPath, bytes: file.size };
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        this.logger.warn(
          `Unable to inspect media asset ${digest}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw new BusinessException(
          BusinessCode.INTERNAL,
          'media storage unavailable',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw new BusinessException(BusinessCode.NOT_FOUND, 'file unavailable');
    }
  }

  private async historicalThreadMatchesRecipient(
    threadId: number,
    threadType: MessageThreadType,
    groupId: number | null,
    toAccount: string,
    signerDomain: string,
    signerNamespaceId: number,
  ): Promise<boolean> {
    if (threadType === MessageThreadType.GROUP) {
      if (!toAccount.startsWith('!') || groupId === null) return false;
      const group = await readGroupState(
        this.database.db,
        and(
          eq(groupStateTable.id, groupId),
          eq(groupStateFields.account, normalizeAccount(toAccount)),
        ),
      );
      return group !== undefined;
    }
    if (toAccount.startsWith('!')) return false;
    const recipient = await this.database.db
      .select({ id: tables.relationshipPair.id })
      .from(tables.relationshipPair)
      .where(
        and(
          eq(tables.relationshipPair.threadId, threadId),
          eq(tables.relationshipPair.kind, 'P2P'),
          eq(tables.relationshipPair.endpointBType, 'USER'),
          eq(
            tables.relationshipPair.endpointBAccount,
            normalizeAccount(toAccount),
          ),
          eq(tables.relationshipPair.endpointBNamespaceId, signerNamespaceId),
        ),
      )
      .limit(1);
    return recipient.length > 0;
  }
}
