import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { dataDirectory } from '../common/data-directory.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { MessageThreadType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { ForwardBundleService } from '../forward/forward-bundle.service.js';
import { loadFederationConfig } from './federation.config.js';

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
        groupId: tables.messageThread.groupId,
      })
      .from(tables.message)
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, tables.message.threadId),
      )
      .innerJoin(
        tables.threadAudience,
        and(
          eq(tables.threadAudience.threadId, tables.message.threadId),
          eq(tables.threadAudience.targetDomain, signerDomain),
          eq(tables.threadAudience.targetNamespaceId, signerNamespaceId),
          isNull(tables.threadAudience.localUserId),
        ),
      )
      .where(
        and(
          eq(tables.message.creatorAccount, normalizeAccount(fromAccount)),
          isNotNull(tables.message.creatorDomain),
          eq(tables.message.isDeleted, false),
          eq(tables.message.seq, sourceSeq),
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
      .innerJoin(
        tables.threadAudience,
        and(
          eq(tables.threadAudience.threadId, tables.message.threadId),
          eq(tables.threadAudience.targetDomain, signerDomain),
          eq(tables.threadAudience.targetNamespaceId, signerNamespaceId),
          isNull(tables.threadAudience.localUserId),
        ),
      )
      .where(
        and(
          eq(tables.forwardMessage.bundleId, bundleId),
          eq(tables.message.isDeleted, false),
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
      const group = await this.database.db.query.group.findFirst({
        where: and(
          eq(tables.group.id, groupId),
          eq(tables.group.account, normalizeAccount(toAccount)),
        ),
        columns: { id: true },
      });
      return group !== undefined;
    }
    if (toAccount.startsWith('!')) return false;
    const recipient = await this.database.db
      .select({ id: tables.user.id })
      .from(tables.threadMember)
      .innerJoin(tables.user, eq(tables.user.id, tables.threadMember.userId))
      .where(
        and(
          eq(tables.threadMember.threadId, threadId),
          eq(tables.user.account, normalizeAccount(toAccount)),
          eq(tables.user.domain, signerDomain),
          eq(tables.user.namespaceId, signerNamespaceId),
          ne(tables.user.domain, 'local'),
        ),
      )
      .limit(1);
    return recipient.length > 0;
  }
}
