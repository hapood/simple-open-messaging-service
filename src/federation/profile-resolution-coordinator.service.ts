import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import { encodeFederationResourceComponent } from './federation-resource-request.js';
import type { S2SProfile } from './federation-profile.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationProfileService } from './federation-profile.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';
import { loadFederationConfig } from './federation.config.js';

export interface ResolvedClientProfile {
  account: string;
  domain: string;
  rev: number;
  name: string;
  avatarBase64: string | null;
}

export type ProfileResolutionStart =
  | { status: 'READY'; profile: ResolvedClientProfile }
  | { status: 'PENDING'; requestId: string };

type Selector =
  | { account: string; domain: string; rev: number }
  | { threadId: number; messageSeq: number };

interface InFlight {
  requestId: string;
  users: Set<number>;
}

/** Application-wide exact-profile resolver with single-flight and a 1,000-entry access-ordered LRU. */
@Injectable()
export class ProfileResolutionCoordinatorService {
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
    if ('threadId' in selector) {
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
          sourceDomain: tables.message.federationSourceDomain,
          sourceNamespaceId: tables.message.sourceNamespaceId,
          originSeq: tables.message.originSeq,
        })
        .from(tables.message)
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
    const account = selector.account.toLowerCase();
    const domain = selector.domain.toLowerCase();
    const allowed = await this.database.db.execute(sql`
      SELECT 1
      FROM "User" self
      WHERE self.id = ${userId}
        AND (
          (self.account = ${account} AND ${domain} = ${this.config.domain})
          OR EXISTS (
            SELECT 1 FROM "RelationshipIntent" intent
            JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
            WHERE intent."profileRev" = ${selector.rev}
              AND intent.status IN ('REQUESTED', 'ACCEPTED')
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
            SELECT 1 FROM "FederatedFriendRequest" request
            WHERE request."localUserId" = self.id
              AND request."remoteAccount" = ${account}
              AND request."remoteDomain" = ${domain}
              AND request."profileRevision" = ${selector.rev}
              AND request.status IN ('REQUESTED', 'ACCEPTED')
          )
          OR EXISTS (
            SELECT 1
            FROM "RelationshipIntent" intent
            JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
            JOIN "Group" local_group ON (
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
            JOIN "MessageThread" managed_thread
              ON managed_thread."groupId" = local_group.id
            JOIN "ThreadMember" manager
              ON manager."threadId" = managed_thread.id
              AND manager."userId" = self.id
            WHERE intent."profileRev" = ${selector.rev}
              AND intent.status IN ('REQUESTED', 'ACCEPTED')
              AND local_group.domain = 'local'
              AND local_group."namespaceId" = 0
              AND manager.left = false
              AND manager.role IN ('OWNER', 'ADMIN')
          )
          OR EXISTS (
            SELECT 1 FROM "Group" group_profile
            JOIN "MessageThread" thread ON thread."groupId" = group_profile.id
            JOIN "ThreadParticipant" participant ON participant."threadId" = thread.id
            WHERE participant."accountId" = self.id
              AND group_profile.account = ${account}
              AND group_profile.domain = ${domain}
              AND group_profile."defaultProfileRev" = ${selector.rev}
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
    if (selector.domain === this.config.domain) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile revision is unavailable',
      );
    }
    let profile: S2SProfile;
    if (selector.kind === 'message') {
      if (!selector.publisherDomain || selector.publisherNamespaceId === null) {
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
      const wire = await this.peerHttp.get<Omit<S2SProfile, 'bio'>>(
        `/s2s/v1/message-author-profile?${query.toString()}`,
        selector.publisherDomain,
      );
      profile = { ...wire, bio: '' };
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
    if (selector.kind === 'account') {
      await this.profiles.materializeExactForeignProfile(
        profile,
        selector.domain,
        selector.namespaceId,
      );
    } else {
      await this.profiles.materializeReferencedUserProfile(
        profile,
        selector.publisherDomain!,
        selector.namespaceId,
      );
    }
    return this.clientProfile(profile);
  }

  private clientProfile(profile: S2SProfile): ResolvedClientProfile {
    return {
      account: profile.account,
      domain: profile.domain,
      rev: profile.profileRev,
      name: profile.displayName,
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
    if ('threadId' in selector) {
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
    } else if (
      Object.keys(selector).some(
        (key) => key !== 'account' && key !== 'domain' && key !== 'rev',
      ) ||
      !selector.account ||
      !selector.domain ||
      !Number.isSafeInteger(selector.rev) ||
      selector.rev < 0
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
    const code = error instanceof BusinessException ? error.bizCode : undefined;
    if (code === BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED)
      return 'NOT_DISCLOSED';
    if (code === BusinessCode.NOT_FOUND || code === BusinessCode.FORBIDDEN)
      return 'NOT_FOUND';
    return 'TEMPORARILY_UNAVAILABLE';
  }
}
