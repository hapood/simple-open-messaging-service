import {
  isProfileSelector,
  type ProfileKey,
  type ProfileSelector as Selector,
} from '../../shared/profile-selector.js';
import { groupStateSql } from '../group/shared/group-state.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { isThreadMutuallyAuthorized } from '../relationship/shared/relationship-authorization.js';
import { encodeFederationResourceComponent } from './federation-resource-request.js';
import type { S2SProfile } from './federation-profile.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationProfileService } from './federation-profile.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';
import { loadFederationConfig } from './federation.config.js';

export interface ResolvedClientProfile {
  namespaceId: number;
  account: string;
  domain: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}

export type ProfileResolutionStart =
  | { status: 'READY'; profile: ResolvedClientProfile }
  | { status: 'PENDING'; key: ProfileKey };

type ResolutionMethod =
  | {
      kind: 'message';
      threadId: number;
      publisherDomain: string;
      publisherNamespaceId: number;
      publisherMessageSeq: number;
    }
  | {
      kind: 'groupMeta';
      publisherDomain: string;
      publisherNamespaceId: number;
      groupAccount: string;
      subject:
        | { type: 'GROUP' }
        | { type: 'MEMBER'; account: string; domain: string };
    }
  | { kind: 'exact'; domain: string; account: string; rev: number };

interface PendingMethod {
  method: ResolutionMethod;
  evidence: Selector;
  users: Set<number>;
}

interface PendingItem {
  key: ProfileKey;
  methods: Map<string, PendingMethod>;
  state: 'QUEUED' | 'ACTIVE';
}

/** Application-wide exact-profile resolver with single-flight and a 1,000-entry access-ordered LRU. */
@Injectable()
export class ProfileResolutionCoordinatorService {
  private static readonly CAPACITY = 1000;
  private static readonly HTTP_CONCURRENCY = 8;
  private readonly logger = new Logger(
    ProfileResolutionCoordinatorService.name,
  );
  private readonly config = loadFederationConfig();
  private readonly pending = new Map<string, PendingItem>();
  private readonly queue: string[] = [];
  private pendingMethodCount = 0;
  private activeCount = 0;
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
    const keyString = profileKeyString(normalized.key);
    const cached = this.cache.get(keyString);
    if (cached) {
      this.touch(keyString, cached);
      return { status: 'READY', profile: cached };
    }
    const durable = await this.readDurable(normalized.key);
    if (durable) {
      this.touch(keyString, durable);
      return { status: 'READY', profile: durable };
    }
    if (
      normalized.key.domain === this.config.domain &&
      normalized.key.namespaceId === 0
    ) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'local profile revision is unavailable',
      );
    }
    const methodKey = JSON.stringify(normalized.method);
    const existing = this.pending.get(keyString);
    if (existing) {
      const method = existing.methods.get(methodKey);
      if (method) method.users.add(userId);
      else {
        this.assertMethodCapacity();
        existing.methods.set(methodKey, {
          method: normalized.method,
          evidence: selector,
          users: new Set([userId]),
        });
        this.pendingMethodCount++;
      }
      return { status: 'PENDING', key: normalized.key };
    }
    if (this.pending.size >= ProfileResolutionCoordinatorService.CAPACITY)
      this.capacityExceeded();
    this.assertMethodCapacity();
    this.pending.set(keyString, {
      key: normalized.key,
      methods: new Map([
        [methodKey, { method: normalized.method, evidence: selector, users: new Set([userId]) }],
      ]),
      state: 'QUEUED',
    });
    this.pendingMethodCount++;
    this.enqueue(keyString);
    this.drain();
    return { status: 'PENDING', key: normalized.key };
  }

  private async normalizeAndAuthorize(userId: number, selector: Selector) {
    if (selector.type === 'MESSAGE_AUTHOR') {
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
      if (message.profileRev !== selector.rev) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message no longer references the requested profile revision',
        );
      }
      const domain =
        message.domain === 'local' ? this.config.domain : message.domain;
      return {
        key: {
          account: message.account,
          domain,
          rev: selector.rev,
          namespaceId: message.namespaceId,
        },
        method: {
          kind: 'message' as const,
          threadId: selector.threadId,
          publisherDomain: message.sourceDomain ?? this.config.domain,
          publisherNamespaceId: message.sourceNamespaceId,
          publisherMessageSeq: message.originSeq ?? selector.messageSeq,
        },
      };
    }
    if (selector.type === 'GROUP_META') {
      if (selector.subject.type === 'GROUP') {
        const rows = await this.database.db.execute<{
          groupAccount: string;
          publisherDomain: string;
          publisherNamespaceId: number;
          profileRev: number;
        }>(sql`
          SELECT group_state.account AS "groupAccount",
                 group_state.domain AS "publisherDomain",
                 group_state."namespaceId" AS "publisherNamespaceId",
                 group_state."profileRev" AS "profileRev"
          FROM "MessageThread" thread
          JOIN ${groupStateSql} group_state ON group_state.id = thread.id
          JOIN "Account" viewer_identity ON viewer_identity.id = ${userId}
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
          LIMIT 1
        `);
        const group = rows.rows[0];
        if (!group || group.profileRev !== selector.profileRev)
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'group no longer references the requested profile revision',
          );
        const publisherDomain =
          group.publisherDomain === 'local'
            ? this.config.domain
            : group.publisherDomain;
        return {
          key: {
            namespaceId: group.publisherNamespaceId,
            account: group.groupAccount,
            domain: publisherDomain,
            rev: selector.profileRev,
          },
          method: {
            kind: 'groupMeta' as const,
            publisherDomain,
            publisherNamespaceId: group.publisherNamespaceId,
            groupAccount: group.groupAccount,
            subject: { type: 'GROUP' as const },
          },
        };
      }
      const memberDomain =
        selector.subject.domain.toLowerCase() === 'local'
          ? this.config.domain
          : selector.subject.domain.toLowerCase();
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
               group_meta_member_namespace(group_state.id,
                 ${normalizeAccount(selector.subject.account)},
                 ${memberDomain === this.config.domain ? 'local' : memberDomain}) AS "memberNamespaceId",
               (latest.body ->> 'profileRev')::integer AS "profileRev"
        FROM "MessageThread" thread
        JOIN ${groupStateSql} group_state ON group_state.id = thread.id
        JOIN "Account" viewer_identity ON viewer_identity.id = ${userId}
        JOIN LATERAL (
          SELECT member_fact.operation,
                 member_fact.body
          FROM "GroupMetaMemberFeed" member_fact
          WHERE member_fact."threadId" = group_state.id
            AND member_fact."memberAccount" = ${normalizeAccount(selector.subject.account)}
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
          AND latest.operation = 'MEMBER_UPSERT'
          AND jsonb_typeof(latest.body -> 'profileRev') = 'number'
        LIMIT 1
      `);
      const allocated = rows.rows[0];
      if (!allocated || allocated.profileRev !== selector.profileRev) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'group member profile is unavailable',
        );
      }
      const publisherDomain =
        allocated.publisherDomain === 'local'
          ? this.config.domain
          : allocated.publisherDomain;
      const account = normalizeAccount(selector.subject.account);
      return {
        key: {
          namespaceId: allocated.memberNamespaceId,
          account,
          domain: memberDomain,
          rev: selector.profileRev,
        },
        method: {
          kind: 'groupMeta' as const,
          publisherDomain,
          publisherNamespaceId: allocated.publisherNamespaceId,
          groupAccount: allocated.groupAccount,
          subject: { type: 'MEMBER' as const, account, domain: memberDomain },
        },
      };
    }
    const account = selector.account.toLowerCase();
    const domain =
      selector.domain.toLowerCase() === 'local'
        ? this.config.domain
        : selector.domain.toLowerCase();
    const storageDomain = domain === this.config.domain ? 'local' : domain;
    const peer =
      storageDomain === 'local'
        ? undefined
        : await this.database.db.query.federatedPeer.findFirst({
            where: eq(tables.federatedPeer.domain, domain),
            columns: { activeNamespaceId: true },
          });
    const namespaceId = storageDomain === 'local' ? 0 : peer?.activeNamespaceId;
    if (namespaceId === undefined || namespaceId === null)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile namespace is unavailable',
      );
    const allowed = await this.database.db.execute(sql`
      SELECT 1
      FROM "Account" self
      WHERE self.id = ${userId}
        AND (
          (self.account = ${account} AND ${domain} = ${this.config.domain})
          OR EXISTS (
            SELECT 1 FROM "ClientStateFeed" state
            WHERE state."userId" = self.id AND state."eventType" = 'THREAD_STATE'
              AND state.body->'profile'->>'account' = ${account}
              AND state.body->'profile'->>'domain' = ${storageDomain}
              AND (state.body->'profile'->>'namespaceId')::integer = ${namespaceId}
              AND (state.body->'profile'->>'profileRev')::integer = ${selector.rev}
          )
          OR EXISTS (
            SELECT 1 FROM "RelationshipIntent" intent
            JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
            WHERE intent."profileRev" = ${selector.rev}
              AND pair."endpointANamespaceId" = ${namespaceId}
              AND pair."endpointBNamespaceId" = ${namespaceId}
              AND (intent.status = 'ACCEPTED'
                OR (intent.status = 'REQUESTED'
                  AND intent."expiresAt" > CURRENT_TIMESTAMP))
              AND ((intent."authorSide" = 'A'
                AND pair."endpointAAccount" = ${account}
                AND pair."endpointADomain" = ${storageDomain}
                AND pair."endpointBAccount" = self.account
                AND pair."endpointBType" = 'USER' AND pair."endpointBDomain" = 'local')
              OR (intent."authorSide" = 'B'
                AND pair."endpointBAccount" = ${account}
                AND pair."endpointBDomain" = ${storageDomain}
                AND pair."endpointAAccount" = self.account
                AND pair."endpointAType" = 'USER' AND pair."endpointADomain" = 'local'))
          )
          OR EXISTS (
            SELECT 1
            FROM "RelationshipIntent" intent
            JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
            JOIN ${groupStateSql} local_group ON (
              (intent."authorSide" = 'A'
                AND pair."endpointAAccount" = ${account}
                AND pair."endpointADomain" = ${storageDomain}
                AND pair."endpointBType" = 'GROUP'
                AND local_group.account = pair."endpointBAccount")
              OR (intent."authorSide" = 'B'
                AND pair."endpointBAccount" = ${account}
                AND pair."endpointBDomain" = ${storageDomain}
                AND pair."endpointAType" = 'GROUP'
                AND local_group.account = pair."endpointAAccount")
            )
            JOIN LATERAL (
              SELECT member_fact.operation, member_fact.body
              FROM "GroupMetaMemberFeed" member_fact
              WHERE member_fact."threadId" = local_group.id
                AND member_fact."memberAccount" = self.account
                AND member_fact."memberDomain" = 'local'
              ORDER BY member_fact."feedId" DESC
              LIMIT 1
            ) manager ON true
            WHERE intent."profileRev" = ${selector.rev}
              AND pair."endpointANamespaceId" = ${namespaceId}
              AND pair."endpointBNamespaceId" = ${namespaceId}
              AND (intent.status = 'ACCEPTED'
                OR (intent.status = 'REQUESTED'
                  AND intent."expiresAt" > CURRENT_TIMESTAMP))
              AND local_group.domain = 'local'
              AND local_group."namespaceId" = 0
              AND manager.operation = 'MEMBER_UPSERT'
              AND manager.body ->> 'role' IN ('OWNER', 'ADMIN')
          )
          OR EXISTS (
            SELECT 1
            FROM "GroupMetaMemberFeed" member_fact
            JOIN "MessageThread" member_thread ON member_thread.id = member_fact."threadId"
            WHERE member_thread.type = 'GROUP'
              AND member_fact."memberAccount" = ${account}
              AND member_fact."memberDomain" = ${storageDomain}
              AND member_fact.operation = 'MEMBER_UPSERT'
              AND (member_fact.body ->> 'profileRev')::integer = ${selector.rev}
              AND group_meta_member_namespace(member_thread.id,
                member_fact."memberAccount", member_fact."memberDomain") = ${namespaceId}
              AND EXISTS (
                SELECT 1 FROM "RelationshipPair" viewer_pair
                WHERE viewer_pair."threadId" = member_thread.id
                  AND viewer_pair.kind = 'GROUP_MEMBER'
                  AND viewer_pair.active = true
                  AND ((viewer_pair."endpointAType" = 'USER'
                        AND viewer_pair."endpointAAccount" = self.account
                        AND viewer_pair."endpointADomain" = self.domain)
                    OR (viewer_pair."endpointBType" = 'USER'
                        AND viewer_pair."endpointBAccount" = self.account
                        AND viewer_pair."endpointBDomain" = self.domain))
              )
          )
          OR EXISTS (
            SELECT 1 FROM ${groupStateSql} group_profile
            JOIN "MessageThread" thread ON thread.id = group_profile.id
            JOIN "AccountThreadState" participant ON participant."threadId" = thread.id
            WHERE participant."accountId" = self.id
              AND group_profile.account = ${account}
              AND group_profile.domain = ${storageDomain}
              AND group_profile."namespaceId" = ${namespaceId}
              AND group_profile."profileRev" = ${selector.rev}
              AND EXISTS (
                SELECT 1 FROM "RelationshipPair" membership
                WHERE membership."threadId" = thread.id AND membership.kind = 'GROUP_MEMBER' AND membership.active
                  AND ((membership."endpointAType" = 'USER' AND membership."endpointAAccount" = self.account AND membership."endpointADomain" = 'local')
                    OR (membership."endpointBType" = 'USER' AND membership."endpointBAccount" = self.account AND membership."endpointBDomain" = 'local'))
              )
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
    return {
      key: { account, domain, rev: selector.rev, namespaceId },
      method: { kind: 'exact' as const, account, domain, rev: selector.rev },
    };
  }

  private async readDurable(key: ProfileKey) {
    const profile = await this.profiles.getStoredProfile(
      key.account,
      key.domain,
      key.namespaceId,
      key.rev,
    );
    return profile ? this.clientProfile(profile, key.namespaceId) : null;
  }

  private drain(): void {
    while (
      this.activeCount < ProfileResolutionCoordinatorService.HTTP_CONCURRENCY &&
      this.queue.length > 0
    ) {
      const keyString = this.queue.shift()!;
      const item = this.pending.get(keyString);
      if (!item || item.state !== 'QUEUED') continue;
      const next = item.methods.entries().next().value as
        | [string, PendingMethod]
        | undefined;
      if (!next) {
        this.pending.delete(keyString);
        continue;
      }
      item.state = 'ACTIVE';
      this.activeCount++;
      const [methodKey, pendingMethod] = next;
      void this.execute(keyString, methodKey, pendingMethod).finally(() => {
        this.activeCount--;
        this.drain();
      });
    }
  }

  private async execute(
    expectedKeyString: string,
    methodKey: string,
    pendingMethod: PendingMethod,
  ): Promise<void> {
    const item = this.pending.get(expectedKeyString);
    if (!item || item.methods.get(methodKey) !== pendingMethod) return;
    try {
      const profile = await this.fetch(item.key, pendingMethod.method);
      this.complete(expectedKeyString, methodKey, pendingMethod, profile);
    } catch (error) {
      this.fail(expectedKeyString, methodKey, pendingMethod, error);
    }
  }

  private complete(
    expectedKeyString: string,
    methodKey: string,
    pendingMethod: PendingMethod,
    profile: ResolvedClientProfile,
  ): void {
    const activeItem = this.pending.get(expectedKeyString);
    if (activeItem?.methods.get(methodKey) !== pendingMethod) return;
    const actualKey: ProfileKey = {
      namespaceId: profile.namespaceId,
      account: profile.account,
      domain: profile.domain,
      rev: profile.rev,
    };
    const actualKeyString = profileKeyString(actualKey);
    this.touch(actualKeyString, profile);

    // Each method owns its authorization evidence. A different method waiting
    // for the actual key must finish (and notify) under its own evidence.
    const expectedItem = this.pending.get(expectedKeyString);
    if (expectedItem?.methods.get(methodKey) === pendingMethod) {
      expectedItem.methods.delete(methodKey);
      this.pendingMethodCount--;
      if (expectedItem.methods.size === 0)
        this.removeItem(expectedKeyString, expectedItem);
      else {
        expectedItem.state = 'QUEUED';
        this.enqueue(expectedKeyString);
      }
    }

    for (const userId of pendingMethod.users)
      this.sse.onProfileAvailable(userId, actualKey, pendingMethod.evidence);
  }

  private fail(
    expectedKeyString: string,
    methodKey: string,
    pendingMethod: PendingMethod,
    error: unknown,
  ): void {
    const item = this.pending.get(expectedKeyString);
    if (!item || item.methods.get(methodKey) !== pendingMethod) return;
    item.methods.delete(methodKey);
    this.pendingMethodCount--;
    const reason = this.failureReason(error);
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    const message = `profile resolution failed for ${expectedKeyString}: ${reason} (${detail})`;
    if (reason === 'TEMPORARILY_UNAVAILABLE') this.logger.warn(message);
    else this.logger.debug(message);
    for (const userId of pendingMethod.users)
      this.sse.onProfileUnavailable(userId, { ...item.key, reason });
    if (item.methods.size === 0) this.removeItem(expectedKeyString, item);
    else {
      item.state = 'QUEUED';
      this.enqueue(expectedKeyString);
    }
  }

  private removeItem(keyString: string, item: PendingItem): void {
    if (this.pending.get(keyString) !== item) return;
    this.pending.delete(keyString);
    this.pendingMethodCount -= item.methods.size;
    this.removeQueued(keyString);
  }

  private enqueue(keyString: string): void {
    if (!this.queue.includes(keyString)) this.queue.push(keyString);
  }

  private removeQueued(keyString: string): void {
    for (let index = this.queue.length - 1; index >= 0; index--)
      if (this.queue[index] === keyString) this.queue.splice(index, 1);
  }

  private async fetch(
    expected: ProfileKey,
    method: ResolutionMethod,
  ): Promise<ResolvedClientProfile> {
    if (expected.namespaceId === 0) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile revision is unavailable',
      );
    }
    let profile: S2SProfile;
    let sourceDomain: string;
    if (method.kind === 'message') {
      if (method.publisherNamespaceId === 0) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'message publisher is unavailable',
        );
      }
      const source = await this.threadSources.resolve(
        method.threadId,
        method.publisherDomain,
        method.publisherNamespaceId,
      );
      const query = new URLSearchParams({ account: source.selector.account });
      if ('peerAccount' in source.selector)
        query.set('peerAccount', source.selector.peerAccount);
      query.set('messageSeq', method.publisherMessageSeq.toString());
      profile = await this.peerHttp.get<S2SProfile>(
        `/s2s/v1/message-author-profile?${query.toString()}`,
        method.publisherDomain,
      );
      sourceDomain = method.publisherDomain;
    } else if (method.kind === 'groupMeta') {
      if (method.publisherNamespaceId === 0) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'locally allocated Group Meta profile is unavailable',
        );
      }
      const query = new URLSearchParams({
        account: method.groupAccount,
        subject: method.subject.type,
      });
      if (method.subject.type === 'MEMBER') {
        query.set('memberAccount', method.subject.account);
        query.set('memberDomain', method.subject.domain);
      }
      profile = await this.peerHttp.get<S2SProfile>(
        `/s2s/v1/group-meta-profile?${query.toString()}`,
        method.publisherDomain,
      );
      sourceDomain = method.publisherDomain;
    } else {
      const peer = await this.database.db.query.federatedPeer.findFirst({
        where: eq(tables.federatedPeer.domain, method.domain),
        columns: { activeNamespaceId: true },
      });
      if (peer?.activeNamespaceId !== expected.namespaceId)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'profile namespace is no longer available remotely',
        );
      profile = await this.peerHttp.get<S2SProfile>(
        `/s2s/v1/profiles/${encodeFederationResourceComponent(method.account)}?rev=${method.rev}`,
        method.domain,
      );
      sourceDomain = method.domain;
    }
    if (
      profile.account.toLowerCase() !== expected.account ||
      profile.domain !== expected.domain ||
      !Number.isSafeInteger(profile.profileRev) ||
      profile.profileRev < 1
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'peer returned a different profile identity',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.profiles.materializeExactForeignProfile(
      profile,
      sourceDomain,
      expected.namespaceId,
    );
    const materialized = await this.readDurable({
      ...expected,
      rev: profile.profileRev,
    });
    if (!materialized) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'materialized profile revision is unavailable',
      );
    }
    return materialized;
  }

  private assertMethodCapacity(): void {
    if (this.pendingMethodCount >= ProfileResolutionCoordinatorService.CAPACITY)
      this.capacityExceeded();
  }

  private capacityExceeded(): never {
    throw new BusinessException(
      BusinessCode.PROFILE_RESOLUTION_CAPACITY,
      'profile resolution queue is full',
    );
  }

  private clientProfile(
    profile: S2SProfile,
    namespaceId: number,
  ): ResolvedClientProfile {
    return {
      namespaceId,
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
    if (!isProfileSelector(selector)) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid profile selector',
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

function profileKeyString(key: ProfileKey): string {
  return JSON.stringify([key.namespaceId, key.account, key.domain, key.rev]);
}
