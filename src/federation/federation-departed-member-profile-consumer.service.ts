import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { isValidAccount, normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { threadMember, user } from '../database/schema.js';
import { UploadService } from '../upload/upload.service.js';
import { upsertSourceUserInTx } from '../user/source-user.js';
import {
  type DepartedMemberProfile,
  type DepartedMemberProfilePage,
} from './departed-member-profile-query.service.js';
import { requireDomain } from './federation-resource-request.js';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import { FederationService } from './federation.service.js';

/** Fetches and transactionally applies the reverse-only departed-author profile dependency. */
@Injectable()
export class FederationDepartedMemberProfileConsumerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly federation: FederationService,
  ) {}

  async fetch(
    source: Extract<FederationReverseThreadSource, { kind: 'GROUP' }>,
    params: { before: number; through: number; take: number },
  ): Promise<DepartedMemberProfile[]> {
    let before = params.before;
    const members: DepartedMemberProfile[] = [];
    while (before > params.through) {
      const query = new URLSearchParams();
      query.set('account', source.selector.account);
      query.set('before', before.toString());
      query.set('through', params.through.toString());
      query.set('take', params.take.toString());
      const response =
        await this.federation.fetchThreadResource<DepartedMemberProfilePage>(
          source.threadId,
          `/s2s/v1/departed-member-profiles?${query.toString()}`,
          source.peerDomain,
          4 * 1024 * 1024,
        );
      this.assertPage(response.data, before, params.through);
      await this.database.db.transaction((tx) =>
        this.federation.assertThreadResourceResponseWritableInTransaction(
          tx,
          response,
        ),
      );
      members.push(...response.data.members);
      if (!response.data.hasMore) return members;
      before = response.data.scannedThrough;
    }
    return members;
  }

  private assertPage(
    page: DepartedMemberProfilePage,
    before: number,
    through: number,
  ): void {
    if (
      !page ||
      !Array.isArray(page.members) ||
      !Number.isSafeInteger(page.scannedThrough) ||
      page.scannedThrough < through ||
      page.scannedThrough >= before ||
      typeof page.hasMore !== 'boolean' ||
      (page.hasMore && page.scannedThrough <= through) ||
      (!page.hasMore && page.scannedThrough !== through)
    ) {
      this.malformed(
        'peer returned an invalid departed-member profile boundary',
      );
    }
    let previous: DepartedMemberProfile | undefined;
    for (const member of page.members) {
      const account = normalizeAccount(member.account);
      requireDomain(member.domain, 'departed member domain');
      const orderedAfterPrevious =
        previous === undefined ||
        member.lastSentSeq < previous.lastSentSeq ||
        (member.lastSentSeq === previous.lastSentSeq &&
          (member.domain > previous.domain ||
            (member.domain === previous.domain && account > previous.account)));
      if (
        !isValidAccount(account) ||
        account.startsWith('!') ||
        !Number.isSafeInteger(member.lastSentSeq) ||
        member.lastSentSeq < page.scannedThrough ||
        member.lastSentSeq >= before ||
        !Number.isSafeInteger(member.profileRev) ||
        member.profileRev < 0 ||
        member.profileRev > 2_147_483_647 ||
        typeof member.displayName !== 'string' ||
        member.displayName.length < 1 ||
        member.displayName.length > 30 ||
        !orderedAfterPrevious
      ) {
        this.malformed('peer returned an invalid departed-member profile');
      }
      if (member.avatar !== null) {
        const bytes = Buffer.from(member.avatar.base64, 'base64');
        if (
          member.avatar.mimeType !== 'image/webp' ||
          !/^[a-f0-9]{64}$/.test(member.avatar.digest) ||
          bytes.toString('base64') !== member.avatar.base64 ||
          createHash('sha256').update(bytes).digest('hex') !==
            member.avatar.digest ||
          !Number.isSafeInteger(member.avatar.width) ||
          member.avatar.width < 1 ||
          !Number.isSafeInteger(member.avatar.height) ||
          member.avatar.height < 1
        ) {
          this.malformed('peer returned an invalid departed-member avatar');
        }
      }
      previous = { ...member, account };
    }
  }

  async applyInTransaction(
    tx: DatabaseTransaction,
    source: Extract<FederationReverseThreadSource, { kind: 'GROUP' }>,
    members: readonly DepartedMemberProfile[],
  ): Promise<void> {
    for (const member of members) {
      const account = normalizeAccount(member.account);
      const existing = await tx.query.user.findFirst({
        where: and(
          eq(user.account, account),
          eq(user.domain, member.domain),
          eq(user.sourceDomain, source.peerDomain),
          eq(user.namespaceId, source.namespaceId),
        ),
        columns: { bio: true },
      });
      const avatar = member.avatar
        ? await this.upload.saveAvatarFromWire({
            b64: member.avatar.base64,
            w: member.avatar.width,
            h: member.avatar.height,
          })
        : null;
      const userId = await upsertSourceUserInTx(tx, {
        account,
        domain: member.domain,
        sourceDomain: source.peerDomain,
        namespaceId: source.namespaceId,
        name: member.displayName,
        avatar,
        bio: existing?.bio ?? '',
        profileRev: member.profileRev,
      });
      await tx
        .insert(threadMember)
        .values({
          threadId: source.threadId,
          userId,
          role: null,
          left: true,
          lastSentSeq: member.lastSentSeq,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [threadMember.threadId, threadMember.userId],
          set: {
            lastSentSeq: sql`GREATEST(COALESCE(${threadMember.lastSentSeq}, 0), ${member.lastSentSeq})`,
            updatedAt: new Date(),
          },
        });
    }
  }

  private malformed(message: string): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}
