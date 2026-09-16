import { groupStateSql } from '../group/business/shared/group-state.js';
import {
  groupState as groupStateTable,
  readGroupState,
  groupStateFields,
} from '../group/business/shared/group-state.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { dataDirectory } from '../common/data-directory.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { MessageThreadType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { ForwardBundleService } from '../forward/forward-bundle.service.js';
import { loadFederationConfig } from './federation.config.js';

function currentThreadResourceAuthorizationSql(
  threadId: typeof tables.message.threadId,
  signerDomain: string,
  signerNamespaceId: number,
) {
  return sql`(
    EXISTS (
      SELECT 1
      FROM "ThreadAudience" audience
      JOIN "MessageThread" authorized_thread
        ON authorized_thread.id = audience."threadId"
      LEFT JOIN ${groupStateSql} authorized_group
        ON authorized_group.id = authorized_thread.id
      WHERE audience."threadId" = ${threadId}
        AND audience."targetDomain" = ${signerDomain}
        AND audience."targetNamespaceId" = ${signerNamespaceId}
        AND audience."localUserId" IS NULL
        AND (authorized_thread.type = 'P2P'
          OR authorized_group.domain = 'local')
    )
    OR EXISTS (
      SELECT 1
      FROM "MessageThread" mirror_thread
      JOIN ${groupStateSql} mirror_group ON mirror_group.id = mirror_thread.id
      JOIN "AccountThreadState" local_state
        ON local_state."threadId" = mirror_thread.id
      JOIN "Account" local_identity
        ON local_identity.id = local_state."accountId"
       AND local_identity.domain = 'local'
       AND local_identity."namespaceId" = 0
      JOIN "RelationshipPair" pair
        ON pair."threadId" = mirror_thread.id
       AND pair.kind = 'GROUP_MEMBER'
      JOIN "RelationshipIntent" intent
        ON intent."pairId" = pair.id
       AND ((pair."endpointAType" = 'GROUP'
             AND pair."endpointAAccount" = mirror_group.account
             AND pair."endpointADomain" = mirror_group.domain
             AND pair."endpointANamespaceId" = ${signerNamespaceId}
             AND pair."endpointBType" = 'USER'
             AND pair."endpointBAccount" = local_identity.account
             AND pair."endpointBDomain" = 'local'
             AND pair."endpointBNamespaceId" = ${signerNamespaceId}
             AND intent."authorSide" = 'B')
         OR (pair."endpointBType" = 'GROUP'
             AND pair."endpointBAccount" = mirror_group.account
             AND pair."endpointBDomain" = mirror_group.domain
             AND pair."endpointBNamespaceId" = ${signerNamespaceId}
             AND pair."endpointAType" = 'USER'
             AND pair."endpointAAccount" = local_identity.account
             AND pair."endpointADomain" = 'local'
             AND pair."endpointANamespaceId" = ${signerNamespaceId}
             AND intent."authorSide" = 'A'))
      WHERE mirror_thread.id = ${threadId}
        AND mirror_thread.type = 'GROUP'
        AND mirror_group.domain = ${signerDomain}
        AND mirror_group."namespaceId" = ${signerNamespaceId}
        AND (intent.status = 'ACCEPTED'
          OR (intent.status = 'REQUESTED'
            AND intent."expiresAt" > CURRENT_TIMESTAMP))
    )
  )`;
}

/** Authorizes peer reads of durable message assets and forward-bundle closures. */
@Injectable()
export class FederationPeerResourceService {
  private readonly config = loadFederationConfig();
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
    const candidates = await this.database.db
      .select({
        messageId: tables.message.id,
        threadId: tables.message.threadId,
        authorDomain: sql<string>`${tables.message.creatorDomain}`,
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
          isNotNull(tables.message.creatorDomain),
          eq(tables.message.isDeleted, false),
          eq(tables.message.seq, sourceSeq),
          currentThreadResourceAuthorizationSql(
            tables.message.threadId,
            signerDomain,
            signerNamespaceId,
          ),
        ),
      );
    let sourceMessage: { id: bigint; threadId: number } | undefined;
    for (const candidate of candidates) {
      if (this.effectiveDomain(candidate.authorDomain) !== fromDomain) continue;
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
    const binding = await this.database.db.query.messageAsset.findFirst({
      where: and(
        eq(tables.messageAsset.messageId, sourceMessage.id),
        eq(tables.messageAsset.digest, digest),
      ),
      columns: { messageId: true },
    });
    if (binding) return this.resolveCasFile(digest);
    const forwardBinding =
      await this.database.db.query.forwardMessage.findFirst({
        where: eq(tables.forwardMessage.messageId, sourceMessage.id),
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
    const [visible] = await this.database.db
      .select({ messageId: tables.forwardMessage.messageId })
      .from(tables.forwardMessage)
      .innerJoin(
        tables.message,
        eq(tables.message.id, tables.forwardMessage.messageId),
      )
      .where(
        and(
          eq(tables.forwardMessage.bundleId, bundleId),
          eq(tables.message.isDeleted, false),
          currentThreadResourceAuthorizationSql(
            tables.message.threadId,
            signerDomain,
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
    return this.forwardBundles.buildClosure(bundleId);
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

  private effectiveDomain(domain: string): string {
    return domain === 'local' ? this.config.domain : domain;
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
          or(
            and(
              eq(tables.relationshipPair.endpointAType, 'USER'),
              eq(
                tables.relationshipPair.endpointAAccount,
                normalizeAccount(toAccount),
              ),
              eq(tables.relationshipPair.endpointADomain, signerDomain),
              eq(
                tables.relationshipPair.endpointANamespaceId,
                signerNamespaceId,
              ),
            ),
            and(
              eq(tables.relationshipPair.endpointBType, 'USER'),
              eq(
                tables.relationshipPair.endpointBAccount,
                normalizeAccount(toAccount),
              ),
              eq(tables.relationshipPair.endpointBDomain, signerDomain),
              eq(
                tables.relationshipPair.endpointBNamespaceId,
                signerNamespaceId,
              ),
            ),
          ),
        ),
      )
      .limit(1);
    return recipient.length > 0;
  }
}
