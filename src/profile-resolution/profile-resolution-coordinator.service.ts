import {
  ProfileLookup,
  type ProfileClientResolutionDemand,
  type ProfileKey,
  type ProfileResolutionDemand,
} from './profile-resolution-demand.js';
import { groupStateSql } from '../group/shared/group-state.js';
import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { S2sResponseError } from '../federation/federation-errors.js';
import type { S2SProfile } from '../federation/federation-profile.js';
import { FederationProfileService } from '../federation/federation-profile.service.js';

export interface ResolvedClientProfile {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  account: string;
  rev: number;
  name: string;
  bio: string;
  avatarBase64: string | null;
}

export type ProfileResolutionStart =
  | { status: 'READY'; profile: ResolvedClientProfile }
  | { status: 'PENDING'; key: ProfileKey };

interface ResolutionEnqueueOptions {
  listenerSessionIds?: Iterable<number>;
}

interface PendingItem {
  key: ProfileKey;
  demand: ProfileResolutionDemand;
  /** A session is registered at most once for this exact profile key. */
  listeners: Set<number>;
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
  private readonly pending = new Map<string, PendingItem>();
  private readonly queue: string[] = [];
  private activeCount = 0;
  private readonly cache = new Map<string, ResolvedClientProfile>();

  constructor(
    private readonly database: DatabaseService,
    private readonly profiles: FederationProfileService,
    private readonly sse: SseService,
  ) {}

  async start(
    userId: number,
    sessionId: number,
    demand: ProfileClientResolutionDemand,
  ): Promise<ProfileResolutionStart> {
    // Evidence authorizes new resolution work, not reads of an existing snapshot.
    const cached = await this.readCached(this.profileKeyForDemand(demand));
    if (cached) return { status: 'READY', profile: cached };
    await this.authorizeDemand(userId, demand);
    return this.enqueueResolution(demand, {
      listenerSessionIds: [sessionId],
    });
  }

  async startCacheOnly(
    demand: ProfileClientResolutionDemand,
  ): Promise<ProfileResolutionStart> {
    const cached = await this.readCached(this.profileKeyForDemand(demand));
    if (cached) return { status: 'READY', profile: cached };
    throw new BusinessException(
      BusinessCode.NOT_FOUND,
      'profile revision is not cached',
    );
  }

  async resolveDemand(demand: ProfileResolutionDemand): Promise<void> {
    if (demand.target.rev < 1 || demand.publisherNamespaceId === 0) return;
    await this.enqueueResolution(demand);
  }

  private async enqueueResolution(
    demand: ProfileResolutionDemand,
    options: ResolutionEnqueueOptions = {},
  ): Promise<ProfileResolutionStart> {
    const key = this.profileKeyForDemand(demand);
    const keyString = profileKeyString(key);
    const cached = await this.readCached(key);
    if (cached) return { status: 'READY', profile: cached };
    if (
      key.publisherNamespaceId === 0 &&
      demand.lookup !== ProfileLookup.GROUP_MEMBER_PROFILE
    ) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'local profile revision is unavailable',
      );
    }
    const listeners = new Set<number>(options.listenerSessionIds ?? []);
    const existing = this.pending.get(keyString);
    if (existing) {
      for (const sessionId of listeners) existing.listeners.add(sessionId);
      return { status: 'PENDING', key };
    }
    if (this.pending.size >= ProfileResolutionCoordinatorService.CAPACITY)
      this.capacityExceeded();
    this.pending.set(keyString, {
      key,
      demand,
      listeners,
      state: 'QUEUED',
    });
    this.enqueue(keyString);
    this.drain();
    return { status: 'PENDING', key };
  }

  /** Cache reads neither attach listeners nor create remote resolution work. */
  private async readCached(
    key: ProfileKey,
  ): Promise<ResolvedClientProfile | null> {
    const keyString = profileKeyString(key);
    const profile = this.cache.get(keyString) ?? (await this.readDurable(key));
    if (profile) this.touch(keyString, profile);
    return profile ?? null;
  }

  private async authorizeDemand(
    userId: number,
    demand: ProfileClientResolutionDemand,
  ): Promise<void> {
    const namespace = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.id, demand.publisherNamespaceId),
      columns: { id: true },
    });
    if (!namespace)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile namespace is unavailable',
      );

    if (demand.lookup === ProfileLookup.GROUP_MEMBER_PROFILE) {
      await this.authorizeGroupMemberDemand(userId, demand);
      return;
    }
    await this.authorizeAccountDemand(userId, demand);
  }

  private async authorizeGroupMemberDemand(
    userId: number,
    demand: Extract<
      ProfileResolutionDemand,
      { lookup: ProfileLookup.GROUP_MEMBER_PROFILE }
    >,
  ): Promise<void> {
    const rows = await this.database.db.execute(sql`
      SELECT 1
      FROM "Account" viewer
      JOIN "AccountThreadState" state ON state."accountId" = viewer.id
      JOIN "MessageThread" thread ON thread.id = state."threadId"
      JOIN ${groupStateSql} group_state ON group_state.id = thread.id
      WHERE viewer.id = ${userId}
        AND thread.type = 'GROUP'
        AND group_state.account = ${normalizeAccount(demand.groupAccount)}
        AND group_state."namespaceId" = ${demand.publisherNamespaceId}
        AND EXISTS (
          SELECT 1 FROM "RelationshipPair" pair
          WHERE pair."threadId" = thread.id
            AND pair.kind = 'GROUP_MEMBER'
            AND pair.established = true
            AND pair.active = true
            AND (
              (pair."endpointAType" = 'USER'
                AND pair."endpointAAccount" = viewer.account
                AND pair."endpointANamespaceId" = 0)
              OR
              (pair."endpointBType" = 'USER'
                AND pair."endpointBAccount" = viewer.account
                AND pair."endpointBNamespaceId" = 0)
            )
        )
        AND (
          EXISTS (
            SELECT 1 FROM LATERAL (
              SELECT fact.operation, fact.body
              FROM "GroupMetaMemberFeed" fact
              WHERE fact."threadId" = group_state.id
                AND fact.body ->> 'account' = ${normalizeAccount(demand.target.account)}
                AND fact.body -> 'namespaceId' = to_jsonb(${demand.target.profileNamespaceId}::integer)
              ORDER BY fact."feedId" DESC
              LIMIT 1
            ) latest
            WHERE latest.operation = 'MEMBER_UPSERT'
              AND latest.body -> 'namespaceId' = to_jsonb(${demand.target.profileNamespaceId}::integer)
              AND latest.body -> 'profileRev' = to_jsonb(${demand.target.rev}::integer)
          ) OR EXISTS (
            SELECT 1 FROM "Message" message
            WHERE message."threadId" = thread.id
              AND message.seq > COALESCE(thread."clearedSeq", 0)
              AND message.seq <= state."messageEndSeq"
              AND message."creatorAccount" = ${normalizeAccount(demand.target.account)}
              AND message."publisherNamespaceId" = ${demand.publisherNamespaceId}
              AND message."profileNamespaceId" = ${demand.target.profileNamespaceId}
              AND message."profileRev" = ${demand.target.rev}
              AND message."contentType" <> 'SYSTEM'
              AND message."localState" = 'READY'
          )
        )
      LIMIT 1
    `);
    if (rows.rows.length === 0)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'group member profile is not available',
      );
  }

  private async authorizeAccountDemand(
    userId: number,
    demand: Extract<
      ProfileResolutionDemand,
      { lookup: ProfileLookup.ACCOUNT_PROFILE }
    >,
  ): Promise<void> {
    const account = normalizeAccount(demand.target.account);
    const rows = await this.database.db.execute(sql`
      SELECT 1
      FROM "Account" self
      WHERE self.id = ${userId}
        AND (
          (self.account = ${account}
            AND self."namespaceId" = ${demand.target.profileNamespaceId})
          OR EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            WHERE pair.kind = 'P2P'
              AND pair.established = true
              AND pair.active = true
              AND pair."endpointAType" = 'USER'
              AND pair."endpointAAccount" = self.account
              AND pair."endpointANamespaceId" = 0
              AND pair."endpointBType" = 'USER'
              AND pair."endpointBAccount" = ${account}
              AND pair."endpointBNamespaceId" = ${demand.publisherNamespaceId}
          )
          OR EXISTS (
            SELECT 1
            FROM "RelationshipIntent" intent
            WHERE intent."authorAccount" = ${account}
              AND intent."authorNamespaceId" = ${demand.publisherNamespaceId}
              AND intent."receiverAccount" = self.account
              AND intent."receiverNamespaceId" = 0
              AND intent."profileNamespaceId" = ${demand.target.profileNamespaceId}
              AND intent."profileRev" = ${demand.target.rev}
              AND (intent.status = 'ACCEPTED' OR
                (intent.status = 'REQUESTED' AND intent."expiresAt" > CURRENT_TIMESTAMP))
          )
          OR EXISTS (
            SELECT 1
            FROM "AccountThreadState" state
            JOIN "MessageThread" thread ON thread.id = state."threadId"
            JOIN "Message" message ON message."threadId" = thread.id
            WHERE state."accountId" = self.id
              AND message.seq > COALESCE(thread."clearedSeq", 0)
              AND message.seq <= state."messageEndSeq"
              AND message."creatorAccount" = ${account}
              AND message."publisherNamespaceId" = ${demand.publisherNamespaceId}
              AND message."profileNamespaceId" = ${demand.target.profileNamespaceId}
              AND message."profileRev" = ${demand.target.rev}
              AND message."contentType" <> 'SYSTEM'
              AND message."localState" = 'READY'
          )
          OR EXISTS (
            SELECT 1
            FROM "AccountThreadState" state
            JOIN "MessageThread" thread ON thread.id = state."threadId"
            JOIN LATERAL (
              SELECT fact.operation, fact.body
              FROM "GroupMetaMemberFeed" fact
              WHERE fact."threadId" = thread.id
                AND fact.operation = 'GROUP_PROFILE'
              ORDER BY fact."feedId" DESC
              LIMIT 1
            ) latest ON true
            WHERE state."accountId" = self.id
              AND thread.type = 'GROUP'
              AND thread."groupAccount" = ${account}
              AND thread."authorityNamespaceId" = ${demand.publisherNamespaceId}
              AND latest.operation = 'GROUP_PROFILE'
              AND latest.body -> 'namespaceId' = to_jsonb(${demand.target.profileNamespaceId}::integer)
              AND latest.body -> 'profileRev' = to_jsonb(${demand.target.rev}::integer)
          )
        )
      LIMIT 1
    `);
    if (rows.rows.length === 0)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile is not available',
      );
  }

  private async readDurable(key: ProfileKey) {
    const profile = await this.profiles.getStoredProfile(
      key.publisherNamespaceId,
      key.account,
      key.profileNamespaceId,
      key.rev,
    );
    return profile
      ? this.clientProfile(
          profile,
          key.publisherNamespaceId,
          key.profileNamespaceId,
        )
      : null;
  }

  private drain(): void {
    while (
      this.activeCount < ProfileResolutionCoordinatorService.HTTP_CONCURRENCY &&
      this.queue.length > 0
    ) {
      const keyString = this.queue.shift()!;
      const item = this.pending.get(keyString);
      if (!item || item.state !== 'QUEUED') continue;
      item.state = 'ACTIVE';
      this.activeCount++;
      void this.execute(keyString, item).finally(() => {
        this.activeCount--;
        this.drain();
      });
    }
  }

  private async execute(
    expectedKeyString: string,
    pendingItem: PendingItem,
  ): Promise<void> {
    const item = this.pending.get(expectedKeyString);
    if (item !== pendingItem) return;
    try {
      const profile = await this.fetch(item.key, item.demand);
      this.complete(expectedKeyString, item, profile);
    } catch (error) {
      this.fail(expectedKeyString, item, error);
    }
  }

  private complete(
    expectedKeyString: string,
    pendingItem: PendingItem,
    profile: ResolvedClientProfile,
  ): void {
    const item = this.pending.get(expectedKeyString);
    if (item !== pendingItem) return;

    // `fetch()` has already awaited materializeExactForeignProfile() and its
    // committing transaction. Nothing below can run before the exact snapshot
    // is durable in PostgreSQL.
    const actualKey: ProfileKey = {
      publisherNamespaceId: profile.publisherNamespaceId,
      profileNamespaceId: profile.profileNamespaceId,
      account: profile.account,
      rev: profile.rev,
    };
    this.touch(profileKeyString(actualKey), profile);

    // A durable exact snapshot satisfies every method waiting for this same
    // four-tuple. Remove the pending key only after persistence, then notify
    // the union of its session listeners. Internal prefetches have no listener.
    const listeners = [...item.listeners];
    this.removeItem(expectedKeyString, item);

    for (const sessionId of listeners)
      this.sse.onProfileAvailable(sessionId, actualKey);
  }

  private fail(
    expectedKeyString: string,
    pendingItem: PendingItem,
    error: unknown,
  ): void {
    const item = this.pending.get(expectedKeyString);
    if (item !== pendingItem) return;
    const reason = this.failureReason(error);
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    const message = `profile resolution failed for ${expectedKeyString}: ${reason} (${detail})`;
    if (reason === 'TEMPORARILY_UNAVAILABLE') this.logger.warn(message);
    else this.logger.debug(message);
    for (const sessionId of item.listeners)
      this.sse.onProfileUnavailable(sessionId, { ...item.key, reason });
    this.removeItem(expectedKeyString, item);
  }

  private removeItem(keyString: string, item: PendingItem): void {
    if (this.pending.get(keyString) !== item) return;
    this.pending.delete(keyString);
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
    demand: ProfileResolutionDemand,
  ): Promise<ResolvedClientProfile> {
    if (expected.publisherNamespaceId === 0)
      return this.fetchLocalGroupMemberProfile(expected, demand);
    const profile = await this.fetchExactProfile(expected, demand);
    if (!profile.profile) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile revision is unavailable',
      );
    }
    if (profile.profile.namespaceId !== expected.profileNamespaceId) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile namespace does not match the requested target',
      );
    }
    await this.profiles.materializeExactForeignProfile(
      profile.profile,
      expected.publisherNamespaceId,
    );
    const materialized = await this.readDurable(expected);
    if (!materialized) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'materialized profile revision is unavailable',
      );
    }
    this.touch(profileKeyString(expected), materialized);
    return materialized;
  }

  /** Origin-side group member profiles: this node is the group's authority,
   * so the member's home snapshot is already durable locally at
   * (member home publisher, subject 0). The demand was authorized against
   * the group's member-feed evidence; answer from the local snapshot without
   * a federation round trip or a second materialization. */
  private async fetchLocalGroupMemberProfile(
    expected: ProfileKey,
    demand: ProfileResolutionDemand,
  ): Promise<ResolvedClientProfile> {
    if (demand.lookup !== ProfileLookup.GROUP_MEMBER_PROFILE) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'local profile revision is unavailable',
      );
    }
    const stored = await this.profiles.getStoredProfile(
      demand.target.profileNamespaceId,
      demand.target.account,
      0,
      demand.target.rev,
    );
    if (!stored) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile revision is unavailable',
      );
    }
    return this.clientProfile(
      { ...stored, namespaceId: demand.target.profileNamespaceId },
      expected.publisherNamespaceId,
      expected.profileNamespaceId,
    );
  }

  private async fetchExactProfile(
    expected: ProfileKey,
    demand: ProfileResolutionDemand,
  ) {
    const namespace = await this.database.db.query.identityNamespace.findFirst({
      where: and(
        eq(tables.identityNamespace.id, demand.publisherNamespaceId),
        isNull(tables.identityNamespace.retiredAt),
      ),
      columns: { domain: true },
    });
    if (!namespace || demand.publisherNamespaceId === 0)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'profile namespace is unavailable',
      );
    const publisherDomain = namespace.domain;
    if (demand.lookup === ProfileLookup.ACCOUNT_PROFILE)
      return {
        profile: await this.profiles.fetchExactAccountProfile(
          demand.target.account,
          demand.target.rev,
          publisherDomain,
          expected.profileNamespaceId,
        ),
        sourceDomain: publisherDomain,
      };
    if (demand.lookup === ProfileLookup.GROUP_MEMBER_PROFILE)
      return {
        profile: await this.profiles.fetchExactGroupMemberProfile(
          demand.groupAccount,
          demand.target.account,
          demand.target.rev,
          publisherDomain,
          expected.profileNamespaceId,
        ),
        sourceDomain: publisherDomain,
      };
    throw new BusinessException(
      BusinessCode.NOT_FOUND,
      'profile lookup is unavailable',
    );
  }

  private capacityExceeded(): never {
    this.logger.warn('profile resolution queue is full');
    throw new BusinessException(
      BusinessCode.PROFILE_RESOLUTION_CAPACITY,
      'profile resolution queue is full',
    );
  }

  private clientProfile(
    profile: S2SProfile,
    publisherNamespaceId: number,
    profileNamespaceId: number,
  ): ResolvedClientProfile {
    return {
      publisherNamespaceId,
      profileNamespaceId,
      account: profile.account,
      rev: profile.profileRev,
      name: profile.displayName,
      bio: profile.bio,
      avatarBase64: profile.avatar?.base64 ?? null,
    };
  }

  private touch(key: string, profile: ResolvedClientProfile): void {
    this.cache.delete(key);
    this.cache.set(key, profile);
    while (this.cache.size > ProfileResolutionCoordinatorService.CAPACITY)
      this.cache.delete(this.cache.keys().next().value!);
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
  private profileKeyForDemand(demand: ProfileResolutionDemand): ProfileKey {
    return {
      publisherNamespaceId: demand.publisherNamespaceId,
      profileNamespaceId: demand.target.profileNamespaceId,
      account: demand.target.account,
      rev: demand.target.rev,
    };
  }
}

function profileKeyString(key: ProfileKey): string {
  return JSON.stringify([
    key.publisherNamespaceId,
    key.profileNamespaceId,
    key.account,
    key.rev,
  ]);
}
