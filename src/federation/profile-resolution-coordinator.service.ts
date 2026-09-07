import { groupStateSql } from '../group/group-state.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { isThreadMutuallyAuthorized } from '../relationship/relationship-authorization.js';
import { encodeFederationResourceComponent } from './federation-resource-request.js';
import type { S2SProfile } from './federation-profile.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationProfileService } from './federation-profile.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';
import { loadFederationConfig } from './federation.config.js';

export interface ResolvedClientProfile {
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}

export type ProfileResolutionStart =
  | { status: 'READY'; profile: ResolvedClientProfile }
  | { status: 'PENDING'; requestId: string };

type Selector =
  | { account: string; domain: string; rev: number }
  | { threadId: number; messageSeq: number }
  | { threadId: number; memberAccount: string; memberDomain: string };

interface InFlight {
  requestId: string;
  users: Set<number>;
}

/** Application-wide exact-profile resolver with single-flight and a 1,000-entry access-ordered LRU. */
@Injectable()
export class ProfileResolutionCoordinatorService {
  private readonly logger = new Logger(
    ProfileResolutionCoordinatorService.name,
  );
  private readonly config = loadFederationConfig();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly cache = new Map<string, ResolvedClientProfile>();

  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
    private readonly profiles: FederationProfileService,
    private readonly threadSources: FederationThreadSourceService,
    private readonly sse: SseService,
  ) {}

  async start(
    userId: number,
    selector: Selector,
  ): Promise<ProfileResolutionStart> {
    this.assertSelector(selector);
    const normalized = await this.normalizeAndAuthorize(userId, selector);
    const key = JSON.stringify(normalized);
    const cached = this.cache.get(key);
    if (cached) {
      this.touch(key, cached);
      return { status: 'READY', profile: cached };
    }
    const durable = await this.readDurable(normalized);
    if (durable) {
      this.touch(key, durable);
      return { status: 'READY', profile: durable };
    }
    if (
      normalized.domain === this.config.domain &&
      normalized.namespaceId === 0
    ) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'local profile revision is unavailable',
      );
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      existing.users.add(userId);
      return { status: 'PENDING', requestId: existing.requestId };
    }
    const flight: InFlight = {
      requestId: randomUUID(),
      users: new Set([userId]),
    };
    this.inFlight.set(key, flight);
    void this.resolve(normalized)
      .then((profile) => {
        this.touch(key, profile);
        for (const recipient of flight.users) {
          this.sse.onProfileResolved(recipient, {
            requestId: flight.requestId,
            profile,
          });
        }
      })
      .catch((error: unknown) => {
        const reason = this.failureReason(error);
        const detail =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        const logMessage = `profile resolution ${flight.requestId} failed for ${normalized.account}@${normalized.domain} rev ${normalized.rev}: ${reason} (${detail})`;
        if (reason === 'TEMPORARILY_UNAVAILABLE') this.logger.warn(logMessage);
        else this.logger.debug(logMessage);
        for (const recipient of flight.users) {
          this.sse.onProfileFailed(recipient, {
            requestId: flight.requestId,
            reason,
          });
        }
      })
      .finally(() => {
        if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
      });
    return { status: 'PENDING', requestId: flight.requestId };
  }

  private async normalizeAndAuthorize(userId: number, selector: Selector) {
    if ('threadId' in selector && 'messageSeq' in selector) {
      if (
        !(await isThreadMutuallyAuthorized(
          this.database.db,
          userId,
          selector.threadId,
        ))
      ) {
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'thread is not available',
        );
      }
      const [message] = await this.database.db
        .select({
          profileRev: tables.message.profileRev,
          account: tables.message.creatorAccount,
          domain: tables.message.creatorDomain,
          namespaceId: tables.message.creatorNamespaceId,
          sourceDomain: sql<string | null>`CASE
            WHEN ${tables.message.sourceNamespaceId} = 0 THEN NULL
            ELSE ${tables.identityNamespace.domain}
          END`,
          sourceNamespaceId: tables.message.sourceNamespaceId,
          originSeq: tables.message.originSeq,
        })
        .from(tables.message)
        .innerJoin(
          tables.identityNamespace,
          eq(tables.identityNamespace.id, tables.message.sourceNamespaceId),
        )
        .where(
          and(
            eq(tables.message.threadId, selector.threadId),
            eq(tables.message.seq, selector.messageSeq),
            eq(tables.message.localState, 'READY'),
          ),
        )
        .limit(1);
      if (!message?.account || !message.domain) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message author is unavailable',
        );
      }
      if (message.profileRev === 0) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message author has no profile',
        );
      }
      return {
        kind: 'message' as const,
        threadId: selector.threadId,
        messageSeq: selector.messageSeq,
        account: message.account,
        domain:
          message.domain === 'local' ? this.config.domain : message.domain,
        rev: message.profileRev,
        namespaceId: message.namespaceId,
        publisherDomain: message.sourceDomain,
        publisherNamespaceId: message.sourceNamespaceId,
        publisherMessageSeq: message.originSeq,
      };
    }
    if ('threadId' in selector) {
      const memberDomain =
        selector.memberDomain.toLowerCase() === 'local'
          ? this.config.domain
          : selector.memberDomain.toLowerCase();
      const rows = await this.database.db.execute<{
        groupAccount: string;
        publisherDomain: string;
        publisherNamespaceId: number;
        memberNamespaceId: number;
        profileRev: number;
      }>(sql`
        SELECT group_state.account AS "groupAccount",
               group_state.domain AS "publisherDomain",
               group_state."namespaceId" AS "publisherNamespaceId",
               latest."memberNamespaceId",
               (latest.body ->> 'profileRev')::integer AS "profileRev"
        FROM "MessageThread" thread
        JOIN ${groupStateSql} group_state ON group_state.id = thread.id
        JOIN "Account" viewer_identity ON viewer_identity.id = ${userId}
        JOIN LATERAL (
          SELECT member_fact."memberNamespaceId",
                 member_fact.operation,
                 member_fact.body
          FROM "GroupMetaMemberFeed" member_fact
          WHERE member_fact."threadId" = group_state.id
            AND member_fact."memberAccount" = ${normalizeAccount(selector.memberAccount)}
            AND member_fact."memberDomain" = ${memberDomain === this.config.domain ? 'local' : memberDomain}
          ORDER BY member_fact."feedId" DESC
          LIMIT 1
        ) latest ON true
        WHERE thread.id = ${selector.threadId}
          AND thread.type = 'GROUP'
          AND EXISTS (
            SELECT 1 FROM "RelationshipPair" viewer_pair
            WHERE viewer_pair."threadId" = thread.id
              AND viewer_pair.kind = 'GROUP_MEMBER'
              AND viewer_pair.active = true
              AND ((viewer_pair."endpointAType" = 'USER'
                    AND viewer_pair."endpointAAccount" = viewer_identity.account
                    AND viewer_pair."endpointADomain" = viewer_identity.domain)
                OR (viewer_pair."endpointBType" = 'USER'
                    AND viewer_pair."endpointBAccount" = viewer_identity.account
                    AND viewer_pair."endpointBDomain" = viewer_identity.domain))
          )
          AND latest.operation = 'UPSERT'
          AND jsonb_typeof(latest.body -> 'profileRev') = 'number'
        LIMIT 1
      `);
      const allocated = rows.rows[0];
      if (!allocated || allocated.profileRev < 1) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'group member profile is unavailable',
        );
      }
      return {
        kind: 'groupMember' as const,
        threadId: selector.threadId,
        groupAccount: allocated.groupAccount,
        account: normalizeAccount(selector.memberAccount),
        domain: memberDomain,
        rev: allocated.profileRev,
        namespaceId: allocated.memberNamespaceId,
        publisherDomain:
          allocated.publisherDomain === 'local'
            ? this.config.domain
            : allocated.publisherDomain,
        publisherNamespaceId: allocated.publisherNamespaceId,
      };
    }
    const account = selector.account.toLowerCase();
    const domain = selector.domain.toLowerCase();
    const allowed = await this.database.db.execute(sql`
      SELECT 1
      FROM "Account" self
      WHERE self.id = ${userId}
        AND (
          (self.account = ${account} AND ${domain} = ${this.config.domain})
          OR EXISTS (
            SELECT 1 FROM "RelationshipIntent" intent
            JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
            WHERE intent."profileRev" = ${selector.rev}
              AND (intent.status = 'ACCEPTED'
                OR (intent.status = 'REQUESTED'
                  AND intent."expiresAt" > CURRENT_TIMESTAMP))
              AND ((intent."authorSide" = 'A'
                AND pair."endpointAAccount" = ${account}
                AND pair."endpointADomain" = ${domain}
                AND pair."endpointBAccount" = self.account)
              OR (intent."authorSide" = 'B'
                AND pair."endpointBAccount" = ${account}
                AND pair."endpointBDomain" = ${domain}
                AND pair."endpointAAccount" = self.account))
          )
          OR EXISTS (
            SELECT 1
            FROM "RelationshipIntent" intent
            JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
            JOIN ${groupStateSql} local_group ON (
              (intent."authorSide" = 'A'
                AND pair."endpointAAccount" = ${account}
                AND pair."endpointADomain" = ${domain}
                AND pair."endpointBType" = 'GROUP'
                AND local_group.account = pair."endpointBAccount")
              OR (intent."authorSide" = 'B'
                AND pair."endpointBAccount" = ${account}
                AND pair."endpointBDomain" = ${domain}
                AND pair."endpointAType" = 'GROUP'
                AND local_group.account = pair."endpointAAccount")
            )
            JOIN LATERAL (
              SELECT member_fact.operation, member_fact.body
              FROM "GroupMetaMemberFeed" member_fact
              WHERE member_fact."threadId" = local_group.id
                AND member_fact."memberAccount" = self.account
                AND member_fact."memberDomain" = 'local'
                AND member_fact."memberNamespaceId" = 0
              ORDER BY member_fact."feedId" DESC
              LIMIT 1
            ) manager ON true
            WHERE intent."profileRev" = ${selector.rev}
              AND (intent.status = 'ACCEPTED'
                OR (intent.status = 'REQUESTED'
                  AND intent."expiresAt" > CURRENT_TIMESTAMP))
              AND local_group.domain = 'local'
              AND local_group."namespaceId" = 0
              AND manager.operation = 'UPSERT'
              AND manager.body ->> 'role' IN ('OWNER', 'ADMIN')
          )
          OR EXISTS (
            SELECT 1 FROM ${groupStateSql} group_profile
            JOIN "MessageThread" thread ON thread.id = group_profile.id
            JOIN "AccountThreadState" participant ON participant."threadId" = thread.id
            WHERE participant."accountId" = self.id
              AND group_profile.account = ${account}
              AND group_profile.domain = ${domain}
              AND group_profile."profileRev" = ${selector.rev}
          )
        )
      LIMIT 1
    `);
    if (allowed.rows.length === 0) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile is not available',
      );
    }
    const namespace = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
      columns: { activeNamespaceId: true },
    });
    return {
      kind: 'account' as const,
      account,
      domain,
      rev: selector.rev,
      namespaceId:
        domain === this.config.domain ? 0 : (namespace?.activeNamespaceId ?? 0),
    };
  }

  private async readDurable(
    selector: Awaited<ReturnType<typeof this.normalizeAndAuthorize>>,
  ) {
    const profile = await this.profiles.getStoredProfile(
      selector.account,
      selector.domain,
      selector.namespaceId,
      selector.rev,
    );
    return profile ? this.clientProfile(profile) : null;
  }

  private async resolve(
    selector: Awaited<ReturnType<typeof this.normalizeAndAuthorize>>,
  ) {
    if (selector.namespaceId === 0) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile revision is unavailable',
      );
    }
    let profile: S2SProfile;
    if (selector.kind === 'message') {
      if (!selector.publisherDomain || selector.publisherNamespaceId === 0) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message publisher is unavailable',
        );
      }
      const source = await this.threadSources.resolve(
        selector.threadId,
        selector.publisherDomain,
        selector.publisherNamespaceId,
      );
      const query = new URLSearchParams({ account: source.selector.account });
      if ('peerAccount' in source.selector)
        query.set('peerAccount', source.selector.peerAccount);
      if (selector.publisherMessageSeq === null) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message publisher sequence is unavailable',
        );
      }
      query.set('messageSeq', selector.publisherMessageSeq.toString());
      profile = await this.peerHttp.get<S2SProfile>(
        `/s2s/v1/message-author-profile?${query.toString()}`,
        selector.publisherDomain,
      );
    } else if (selector.kind === 'groupMember') {
      if (selector.publisherNamespaceId === 0) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'locally allocated group member profile is unavailable',
        );
      }
      const query = new URLSearchParams({
        account: selector.groupAccount,
        memberAccount: selector.account,
        memberDomain: selector.domain,
        rev: selector.rev.toString(),
      });
      profile = await this.peerHttp.get<S2SProfile>(
        `/s2s/v1/group-member-profile?${query.toString()}`,
        selector.publisherDomain,
      );
    } else {
      profile = await this.peerHttp.get<S2SProfile>(
        `/s2s/v1/profiles/${encodeFederationResourceComponent(selector.account)}?rev=${selector.rev}`,
        selector.domain,
      );
    }
    if (
      profile.account.toLowerCase() !== selector.account ||
      profile.domain !== selector.domain ||
      profile.profileRev !== selector.rev
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'peer returned a different profile revision',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.profiles.materializeExactForeignProfile(
      profile,
      selector.kind === 'account' ? selector.domain : selector.publisherDomain!,
      selector.namespaceId,
    );
    const materialized = await this.readDurable(selector);
    if (!materialized) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'materialized profile revision is unavailable',
      );
    }
    return materialized;
  }

  private clientProfile(profile: S2SProfile): ResolvedClientProfile {
    return {
      account: profile.account,
      domain: profile.domain,
      rev: profile.profileRev,
      name: profile.displayName,
      bio: profile.bio,
      avatarBase64: profile.avatar?.base64 ?? null,
    };
  }

  private touch(key: string, profile: ResolvedClientProfile): void {
    this.cache.delete(key);
    this.cache.set(key, profile);
    while (this.cache.size > 1000)
      this.cache.delete(this.cache.keys().next().value!);
  }

  private assertSelector(selector: Selector): void {
    if (
      selector === null ||
      typeof selector !== 'object' ||
      Array.isArray(selector)
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid profile selector',
      );
    if ('threadId' in selector && 'messageSeq' in selector) {
      if (
        Object.keys(selector).some(
          (key) => key !== 'threadId' && key !== 'messageSeq',
        ) ||
        !Number.isSafeInteger(selector.threadId) ||
        selector.threadId < 1 ||
        !Number.isSafeInteger(selector.messageSeq) ||
        selector.messageSeq < 1
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'invalid message profile selector',
        );
      }
    } else if ('threadId' in selector) {
      if (
        Object.keys(selector).some(
          (key) =>
            key !== 'threadId' &&
            key !== 'memberAccount' &&
            key !== 'memberDomain',
        ) ||
        !Number.isSafeInteger(selector.threadId) ||
        selector.threadId < 1 ||
        !selector.memberAccount ||
        !selector.memberDomain
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'invalid group member profile selector',
        );
      }
    } else if (
      Object.keys(selector).some(
        (key) => key !== 'account' && key !== 'domain' && key !== 'rev',
      ) ||
      !selector.account ||
      !selector.domain ||
      !Number.isSafeInteger(selector.rev) ||
      selector.rev < 1
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid exact profile selector',
      );
    }
  }

  private failureReason(
    error: unknown,
  ): 'NOT_FOUND' | 'NOT_DISCLOSED' | 'TEMPORARILY_UNAVAILABLE' {
    const code =
      error instanceof BusinessException
        ? error.bizCode
        : error instanceof S2sResponseError
          ? error.code
          : undefined;
    if (code === BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED)
      return 'NOT_DISCLOSED';
    if (code === BusinessCode.NOT_FOUND || code === BusinessCode.FORBIDDEN)
      return 'NOT_FOUND';
    return 'TEMPORARILY_UNAVAILABLE';
  }
}
