import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  group,
  messageThread,
  peerStateFeed,
  threadMember,
  user,
} from '../database/schema.js';
import { UploadService } from '../upload/upload.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationMessageFeedService } from './federation-message-feed.service.js';

export interface DepartedMemberProfile {
  account: string;
  domain: string;
  lastSentSeq: number;
  profileRev: number;
  displayName: string;
  avatar: {
    digest: string;
    mimeType: 'image/webp';
    base64: string;
    width: number;
    height: number;
  } | null;
}

export interface DepartedMemberProfilePage {
  members: DepartedMemberProfile[];
  scannedThrough: number;
  hasMore: boolean;
}

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;

@Injectable()
export class DepartedMemberProfileQueryService {
  private readonly localDomain = loadFederationConfig().domain;

  constructor(
    private readonly database: DatabaseService,
    private readonly messageFeed: FederationMessageFeedService,
    private readonly upload: UploadService,
  ) {}

  async query(
    peerDomain: string,
    account: string,
    before: number | undefined,
    requestedTake?: number,
    through?: number,
  ): Promise<DepartedMemberProfilePage> {
    if (
      requestedTake !== undefined &&
      (!Number.isSafeInteger(requestedTake) || requestedTake < 1)
    )
      this.malformed('invalid departed-member profile page size');
    const take = Math.min(requestedTake ?? DEFAULT_TAKE, MAX_TAKE);
    if (before === undefined) {
      const window = await this.window(peerDomain, account);
      throw new BusinessException(
        BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        'before is required; initialize the departed-member profile feed',
        HttpStatus.OK,
        {
          resumeAfter: window.resumeAfter,
          resumeBefore: window.resumeBefore,
        },
      );
    }
    if (through !== undefined && through < 0)
      this.malformed('through must be non-negative');
    if (through !== undefined && through > before)
      this.malformed('through must be less than or equal to before');

    const window = await this.window(peerDomain, account);
    const { threadId, resumeAfter, resumeBefore } = window;
    if (before <= resumeAfter + 1 || before > resumeBefore) {
      throw new BusinessException(
        BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        'departed-member profile query cursor is outside the available coordinate space',
        HttpStatus.OK,
        {
          resumeAfter,
          resumeBefore,
        },
      );
    }

    const queryStart = through ?? resumeAfter + 1;
    const queryBefore = Math.min(before, resumeBefore);
    const boundary = threadMember.lastSentSeq;
    const emptyWindow = queryBefore <= queryStart;
    const rows = emptyWindow
      ? []
      : await this.database.db
          .select({
            account: user.account,
            domain: user.domain,
            profileRev: user.profileRev,
            displayName: user.name,
            avatar: user.avatar,
            boundary,
          })
          .from(threadMember)
          .innerJoin(user, eq(user.id, threadMember.userId))
          .where(
            and(
              eq(threadMember.threadId, threadId),
              eq(threadMember.left, true),
              gte(boundary, queryStart),
              lt(boundary, queryBefore),
            ),
          )
          .orderBy(desc(boundary), asc(user.domain), asc(user.account))
          .limit(take + 1);
    let selected = rows.slice(0, take);
    let hasMore = false;
    let scannedThrough = queryStart;
    if (rows.length > take) {
      const selectionBoundary = selected.at(-1)!.boundary!;
      const tied = await this.database.db
        .select({
          account: user.account,
          domain: user.domain,
          profileRev: user.profileRev,
          displayName: user.name,
          avatar: user.avatar,
          boundary,
        })
        .from(threadMember)
        .innerJoin(user, eq(user.id, threadMember.userId))
        .where(
          and(
            eq(threadMember.threadId, threadId),
            eq(threadMember.left, true),
            eq(boundary, selectionBoundary),
          ),
        )
        .orderBy(asc(user.domain), asc(user.account));
      selected = [
        ...selected.filter((row) => row.boundary !== selectionBoundary),
        ...tied,
      ];
      const [remaining] = await this.database.db
        .select({ boundary })
        .from(threadMember)
        .where(
          and(
            eq(threadMember.threadId, threadId),
            eq(threadMember.left, true),
            lt(boundary, selectionBoundary),
            gte(boundary, queryStart),
          ),
        )
        .limit(1);
      if (remaining) {
        scannedThrough = selectionBoundary;
        hasMore = true;
      }
    }
    const members = await Promise.all(
      selected.map(async (member): Promise<DepartedMemberProfile> => {
        const wire = member.avatar
          ? await this.upload.readAvatarAsWire(member.avatar)
          : null;
        return {
          account: member.account,
          domain: member.domain === 'local' ? this.localDomain : member.domain,
          lastSentSeq: member.boundary!,
          profileRev: member.profileRev,
          displayName: member.displayName,
          avatar: wire
            ? {
                digest: createHash('sha256')
                  .update(Buffer.from(wire.b64, 'base64'))
                  .digest('hex'),
                mimeType: 'image/webp',
                base64: wire.b64,
                width: wire.w,
                height: wire.h,
              }
            : null,
        };
      }),
    );
    return {
      members,
      scannedThrough,
      hasMore,
    };
  }

  private async window(
    peerDomain: string,
    account: string,
  ): Promise<{
    threadId: number;
    resumeAfter: number;
    resumeBefore: number;
  }> {
    const authorized = await this.messageFeed.resolveAuthorizedThread(
      peerDomain,
      { type: 'GROUP', account },
    );
    const [state] = await this.database.db
      .select({
        originDomain: group.domain,
        head: peerStateFeed.body,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .leftJoin(
        peerStateFeed,
        and(
          eq(peerStateFeed.peerDomain, peerDomain),
          eq(peerStateFeed.account, account),
          eq(peerStateFeed.domain, this.localDomain),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          eq(peerStateFeed.subjectAccount, ''),
          eq(peerStateFeed.subjectDomain, 'local'),
        ),
      )
      .where(eq(messageThread.id, authorized.threadId))
      .limit(1);
    if (!state || state.originDomain !== 'local') {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'departed-member profiles are served only by the group origin',
        HttpStatus.OK,
      );
    }
    const advertisedEnd = (state.head as { messageEndSeq?: unknown } | null)
      ?.messageEndSeq;
    const currentEnd = Math.max(
      Number.isSafeInteger(advertisedEnd) && Number(advertisedEnd) > 0
        ? Number(advertisedEnd)
        : 0,
      authorized.messageAccessAfterSeq,
    );
    return {
      threadId: authorized.threadId,
      resumeAfter: authorized.messageAccessAfterSeq,
      resumeBefore: currentEnd + 1,
    };
  }

  private malformed(message: string): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}
