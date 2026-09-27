import {
  groupState as groupStateTable,
  groupStateSql,
  readGroupState,
  groupStateFields,
} from '../group/shared/group-state.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { writeProfileSnapshotInTx } from '../user/profile-store.js';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { UploadService } from '../upload/upload.service.js';
import type { S2SAddress } from './federation-address.js';
import { loadFederationConfig } from './federation.config.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import type { S2SProfile } from './federation-profile.js';
import { encodeFederationResourceComponent } from './federation-resource-request.js';
import { resolveAuthorizedFederationThreadInTx } from './federation-thread-query-authorization.js';

const FEDERATED_PROFILE_NAME_MAX_CODE_POINTS = 31;
const FEDERATED_PROFILE_BIO_MAX_CODE_POINTS = 120;

function truncateCodePoints(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

/** Reads public federation profiles and materializes verified foreign profile projections. */
@Injectable()
export class FederationProfileService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly peerHttp: FederationPeerHttp,
  ) {}

  async toS2SProfile(user: {
    account: string;
    domain?: string;
    name: string;
    avatar: string;
    bio: string;
    profileRev: number;
  }): Promise<S2SProfile> {
    this.assertPositiveRevision(user.profileRev);
    const wire = user.avatar
      ? await this.upload.readAvatarAsWire(user.avatar)
      : null;
    const avatar = wire
      ? {
          mimeType: wire.mimeType,
          base64: wire.b64,
          width: wire.w,
          height: wire.h,
        }
      : null;
    return {
      account: user.account,
      domain: user.domain ?? this.config.domain,
      displayName: user.name,
      avatar,
      bio: user.bio,
      profileRev: user.profileRev,
    };
  }

  async getStoredProfile(
    account: string,
    domain: string,
    namespaceId: number,
    rev: number,
  ): Promise<S2SProfile | null> {
    if (rev < 1) return null;
    const storedDomain =
      namespaceId === 0 && domain === this.config.domain ? 'local' : domain;
    const row = await this.database.db.query.profileTable.findFirst({
      where: and(
        eq(tables.profileTable.account, normalizeAccount(account)),
        eq(tables.profileTable.domain, storedDomain),
        eq(tables.profileTable.namespaceId, namespaceId),
        eq(tables.profileTable.profileRev, rev),
      ),
    });
    if (!row) return null;
    return this.toS2SProfile({
      account: row.account,
      domain,
      name: row.displayName,
      avatar: row.avatar,
      bio: row.bio,
      profileRev: row.profileRev,
    });
  }

  /** Store an exact snapshot without creating a user/group identity or moving a default pointer. */
  async materializeExactForeignProfile(
    profile: S2SProfile,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<void> {
    this.assertPositiveRevision(profile.profileRev);
    const prepared = await this.prepareForeignProfileData(profile);
    await this.database.db.transaction(async (tx) => {
      const source = await tx.query.identityNamespace.findFirst({
        where: and(
          eq(tables.identityNamespace.id, namespaceId),
          eq(tables.identityNamespace.domain, sourceDomain),
        ),
      });
      if (!source || namespaceId === 0)
        throw new Error('foreign profile publisher namespace is unavailable');
      await writeProfileSnapshotInTx(tx, {
        account: normalizeAccount(profile.account),
        domain: profile.domain,
        namespaceId,
        profileRev: profile.profileRev,
        displayName: prepared.name,
        avatar: prepared.avatar,
        bio: prepared.bio,
      });
    });
  }

  async getLocalAccountProfile(
    address: S2SAddress,
  ): Promise<S2SProfile | null> {
    if (address.domain !== this.config.domain) return null;
    const account = normalizeAccount(address.account);
    if (account.startsWith('!')) {
      const group = await readGroupState(
        this.database.db,
        and(
          eq(groupStateFields.account, account),
          eq(groupStateFields.domain, 'local'),
          eq(groupStateFields.namespaceId, 0),
        ),
      );
      if (!group || group.profileRev === 0 || group.dissolvedAt) return null;
      return this.getStoredProfile(
        group.account,
        this.config.domain,
        0,
        group.profileRev,
      );
    }
    const user = await this.database.db.query.account.findFirst({
      where: and(
        eq(tables.account.account, account),
        eq(tables.account.domain, 'local'),
        eq(tables.account.namespaceId, 0),
      ),
    });
    if (!user || user.domain !== 'local' || user.defaultProfileRev === 0)
      return null;
    return this.getStoredProfile(
      user.account,
      this.config.domain,
      0,
      user.defaultProfileRev,
    );
  }

  /** Exact directed-intent disclosure; an unrelated message or current Meta
   * reference cannot authorize this operation. The proof and snapshot are read
   * from one read-only repeatable-read database snapshot. */
  async getAuthorizedIntentProfile(
    account: string,
    peerAccount: string,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    if (!Number.isSafeInteger(rev) || rev < 1) return null;
    const result = await this.database.db.transaction(
      (tx) =>
        tx.execute<{
          account: string;
          displayName: string;
          avatar: string;
          bio: string;
          profileRev: number;
        }>(sql`
        SELECT profile.account, profile."displayName", profile.avatar,
          profile.bio, profile."profileRev"
        FROM "Profile" profile
        WHERE profile.account = ${normalizeAccount(account)}
          AND profile.domain = 'local' AND profile."namespaceId" = 0
          AND profile."profileRev" = ${rev}
          AND (
            EXISTS (SELECT 1 FROM "Account" owner
              WHERE owner.account = profile.account AND owner.domain = 'local'
                AND owner."namespaceId" = 0 AND owner.kind = 'USER'
                AND owner.availability = 'AVAILABLE')
            OR EXISTS (SELECT 1 FROM ${groupStateSql} group_state
              WHERE group_state.account = profile.account
                AND group_state.domain = 'local'
                AND group_state."namespaceId" = 0
                AND group_state."dissolvedAt" IS NULL)
          )
          AND EXISTS (
            SELECT 1 FROM "RelationshipIntent" intent
            JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
            WHERE intent."profileRev" = ${rev}
              AND (intent.status = 'ACCEPTED'
                OR (intent.status = 'REQUESTED'
                  AND intent."expiresAt" > CURRENT_TIMESTAMP))
              AND (
                (intent."authorSide" = 'A'
                  AND pair."endpointAAccount" = profile.account
                  AND pair."endpointADomain" = 'local'
                  AND pair."endpointANamespaceId" = 0
                  AND pair."endpointBAccount" = ${normalizeAccount(peerAccount)}
                  AND pair."endpointBDomain" = ${peerDomain}
                  AND pair."endpointBNamespaceId" = ${namespaceId})
                OR (intent."authorSide" = 'B'
                  AND pair."endpointBAccount" = profile.account
                  AND pair."endpointBDomain" = 'local'
                  AND pair."endpointBNamespaceId" = 0
                  AND pair."endpointAAccount" = ${normalizeAccount(peerAccount)}
                  AND pair."endpointADomain" = ${peerDomain}
                  AND pair."endpointANamespaceId" = ${namespaceId})
              )
          )
        LIMIT 1
      `),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const row = result.rows[0];
    return row
      ? this.toS2SProfile({
          account: row.account,
          name: row.displayName,
          avatar: row.avatar,
          bio: row.bio,
          profileRev: row.profileRev,
        })
      : null;
  }

  /** Account evidence is distinct from directed-intent and group-member
   * evidence. Authorization, published bounds, and the exact snapshot share
   * one read-only repeatable-read snapshot. */
  async getAuthorizedAccountProfile(
    account: string,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    if (!Number.isSafeInteger(rev) || rev < 1) return null;
    const owner = normalizeAccount(account);
    if (owner.startsWith('!')) {
      let row;
      try {
        row = await this.database.db.transaction(
          async (tx) => {
            const authorized = await resolveAuthorizedFederationThreadInTx(
              tx,
              peerDomain,
              namespaceId,
              { type: 'GROUP', account: owner },
            );
            if (authorized.groupQueryDirection !== 'ORIGIN_DISTRIBUTION')
              return null;
            const result = await tx.execute<{
              account: string;
              displayName: string;
              avatar: string;
              bio: string;
              profileRev: number;
            }>(sql`
            SELECT profile.account, profile."displayName", profile.avatar,
              profile.bio, profile."profileRev"
            FROM "GroupAccount" group_account
            JOIN "MessageThread" thread ON thread.id = ${authorized.threadId}
              AND thread."groupAccountId" = group_account.id
              AND thread."groupDomain" = 'local'
            JOIN "GroupMeta" meta ON meta."threadId" = thread.id
              AND meta."profileRev" = ${rev}
            JOIN "GroupMetaMemberFeed" fact ON fact."threadId" = meta."threadId"
              AND fact.operation = 'GROUP_PROFILE'
              AND (fact.body ->> 'profileRev')::integer = ${rev}
            JOIN "Profile" profile ON profile.account = group_account.account
              AND profile.domain = 'local' AND profile."namespaceId" = 0
              AND profile."profileRev" = ${rev}
            WHERE group_account.account = ${owner}
              AND group_account."dissolvedAt" IS NULL
            LIMIT 1
          `);
            return result.rows[0] ?? null;
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
      } catch (error) {
        if (
          error instanceof BusinessException &&
          error.bizCode === BusinessCode.FORBIDDEN
        )
          return null;
        throw error;
      }
      return row
        ? this.toS2SProfile({
            account: row.account,
            name: row.displayName,
            avatar: row.avatar,
            bio: row.bio,
            profileRev: row.profileRev,
          })
        : null;
    }

    const result = await this.database.db.transaction(
      (tx) =>
        tx.execute<{
          account: string;
          displayName: string;
          avatar: string;
          bio: string;
          profileRev: number;
        }>(sql`
      SELECT profile.account, profile."displayName", profile.avatar,
        profile.bio, profile."profileRev"
      FROM "Profile" profile
      JOIN "Account" owner ON owner.account = profile.account
        AND owner.domain = 'local' AND owner."namespaceId" = 0
        AND owner.kind = 'USER' AND owner.availability = 'AVAILABLE'
      WHERE profile.account = ${owner} AND profile.domain = 'local'
        AND profile."namespaceId" = 0 AND profile."profileRev" = ${rev}
        AND EXISTS (
          SELECT 1 FROM "Message" m
          JOIN "MessageThread" thread ON thread.id = m."threadId"
          JOIN "RelationshipPair" pair ON pair."threadId" = thread.id
            AND pair.established
          JOIN "RelationshipIntent" intent ON intent."pairId" = pair.id
          JOIN "PeerStateFeed" head ON head."peerDomain" = ${peerDomain}
            AND head."namespaceId" = ${namespaceId}
            AND head.domain = ${this.config.domain}
            AND head."eventType" = 'THREAD_CONTENT_HEAD'
            AND head.account = CASE WHEN thread.type = 'P2P'
              THEN profile.account ELSE thread."groupAccount" END
            AND head."subjectAccount" = CASE WHEN thread.type = 'P2P'
              THEN CASE WHEN pair."endpointAAccount" = profile.account
                AND pair."endpointADomain" = 'local'
                THEN pair."endpointBAccount" ELSE pair."endpointAAccount" END
              ELSE '' END
            AND head."subjectDomain" = CASE WHEN thread.type = 'P2P'
              THEN ${peerDomain} ELSE 'local' END
          LEFT JOIN "ThreadAudience" audience ON audience."threadId" = thread.id
            AND audience."targetDomain" = ${peerDomain}
            AND audience."targetNamespaceId" = ${namespaceId}
            AND audience."localUserId" IS NULL
          WHERE m."creatorAccount" = profile.account
            AND m."creatorDomain" = 'local'
            AND m."profileRev" = ${rev} AND m."sourceNamespaceId" = 0
            AND m."contentType" <> 'SYSTEM'
            AND m.seq > COALESCE(audience."messageAccessAfterSeq", 0)
            AND m.seq::numeric <= CASE
              WHEN (head.body ->> 'messageEndSeq') ~ '^[0-9]{1,10}$'
              THEN (head.body ->> 'messageEndSeq')::numeric ELSE 0 END
            AND (
              (thread.type = 'P2P' AND pair.kind = 'P2P'
                AND (
                  (pair."endpointAType" = 'USER'
                    AND pair."endpointAAccount" = profile.account
                    AND pair."endpointADomain" = 'local'
                    AND pair."endpointANamespaceId" = ${namespaceId}
                    AND pair."endpointBType" = 'USER'
                    AND pair."endpointBDomain" = ${peerDomain}
                    AND pair."endpointBNamespaceId" = ${namespaceId}
                    AND intent."authorSide" = 'A')
                  OR
                  (pair."endpointBType" = 'USER'
                    AND pair."endpointBAccount" = profile.account
                    AND pair."endpointBDomain" = 'local'
                    AND pair."endpointBNamespaceId" = ${namespaceId}
                    AND pair."endpointAType" = 'USER'
                    AND pair."endpointADomain" = ${peerDomain}
                    AND pair."endpointANamespaceId" = ${namespaceId}
                    AND intent."authorSide" = 'B')
                )
              )
              OR
              (thread.type = 'GROUP' AND pair.kind = 'GROUP_MEMBER'
                AND thread."groupDomain" = ${peerDomain}
                AND thread."authorityNamespaceId" = ${namespaceId}
                AND thread."groupAccountId" IS NULL
                AND (
                  (pair."endpointAType" = 'GROUP'
                    AND pair."endpointAAccount" = thread."groupAccount"
                    AND pair."endpointADomain" = ${peerDomain}
                    AND pair."endpointANamespaceId" = ${namespaceId}
                    AND pair."endpointBType" = 'USER'
                    AND pair."endpointBAccount" = profile.account
                    AND pair."endpointBDomain" = 'local'
                    AND pair."endpointBNamespaceId" = ${namespaceId}
                    AND intent."authorSide" = 'B')
                  OR
                  (pair."endpointBType" = 'GROUP'
                    AND pair."endpointBAccount" = thread."groupAccount"
                    AND pair."endpointBDomain" = ${peerDomain}
                    AND pair."endpointBNamespaceId" = ${namespaceId}
                    AND pair."endpointAType" = 'USER'
                    AND pair."endpointAAccount" = profile.account
                    AND pair."endpointADomain" = 'local'
                    AND pair."endpointANamespaceId" = ${namespaceId}
                    AND intent."authorSide" = 'A')
                )
                AND EXISTS (SELECT 1 FROM "AccountThreadState" state
                  WHERE state."threadId" = thread.id
                    AND state."accountId" = owner.id)
              )
            )
        )
      LIMIT 1
    `),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const row = result.rows[0];
    return row
      ? this.toS2SProfile({
          account: row.account,
          name: row.displayName,
          avatar: row.avatar,
          bio: row.bio,
          profileRev: row.profileRev,
        })
      : null;
  }

  /** Exact member snapshot disclosed by the group origin's current Meta
   * reference or a serviceable non-system group message. Authorization and
   * profile bytes are read from the same read-only MVCC snapshot. */
  async getAuthorizedGroupMemberProfile(
    groupAccount: string,
    memberDomain: string,
    memberAccount: string,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    if (!Number.isSafeInteger(rev) || rev < 1) return null;
    const storedDomain =
      memberDomain === this.config.domain ? 'local' : memberDomain;
    let row;
    try {
      row = await this.database.db.transaction(
        async (tx) => {
          const authorized = await resolveAuthorizedFederationThreadInTx(
            tx,
            peerDomain,
            namespaceId,
            { type: 'GROUP', account: normalizeAccount(groupAccount) },
          );
          if (authorized.groupQueryDirection !== 'ORIGIN_DISTRIBUTION')
            return null;
          const [published] = await tx
            .select({ body: tables.peerStateFeed.body })
            .from(tables.peerStateFeed)
            .where(
              and(
                eq(tables.peerStateFeed.peerDomain, peerDomain),
                eq(tables.peerStateFeed.namespaceId, namespaceId),
                eq(
                  tables.peerStateFeed.account,
                  normalizeAccount(groupAccount),
                ),
                eq(tables.peerStateFeed.domain, this.config.domain),
                eq(tables.peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
                eq(tables.peerStateFeed.subjectAccount, ''),
                eq(tables.peerStateFeed.subjectDomain, 'local'),
              ),
            )
            .limit(1);
          const end = (
            published?.body as { messageEndSeq?: unknown } | undefined
          )?.messageEndSeq;
          const messageEnd =
            Number.isSafeInteger(end) && Number(end) > 0 ? Number(end) : 0;
          const result = await tx.execute<{
            account: string;
            displayName: string;
            avatar: string;
            bio: string;
            profileRev: number;
          }>(sql`
          SELECT profile.account, profile."displayName", profile.avatar,
            profile.bio, profile."profileRev"
          FROM "Profile" profile
          JOIN "MessageThread" thread ON thread.id = ${authorized.threadId}
          JOIN "GroupAccount" group_account ON group_account.id = thread."groupAccountId"
            AND group_account."dissolvedAt" IS NULL
          WHERE thread.type = 'GROUP' AND thread."groupDomain" = 'local'
            AND thread."groupAccount" = ${normalizeAccount(groupAccount)}
            AND profile.account = ${normalizeAccount(memberAccount)}
            AND profile.domain = ${storedDomain}
            AND profile."profileRev" = ${rev}
            AND EXISTS (
              SELECT 1 FROM "GroupMetaMemberFeed" fact
              WHERE fact."threadId" = thread.id
                AND fact."memberAccount" = profile.account
                AND fact."memberDomain" = profile.domain
                AND fact.operation = 'MEMBER_UPSERT'
                AND (fact.body ->> 'profileRev')::integer = ${rev}
                AND (profile.domain <> 'local' OR profile."namespaceId" = 0)
                AND (profile.domain = 'local' OR EXISTS (
                  SELECT 1 FROM "RelationshipPair" pair
                  WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = thread.id
                    AND pair.established
                    AND pair."endpointBType" = 'USER'
                    AND pair."endpointBAccount" = profile.account
                    AND pair."endpointBDomain" = profile.domain
                    AND pair."endpointBNamespaceId" = profile."namespaceId"
                ))
            )
            AND EXISTS (
              SELECT 1 FROM "Message" message
              WHERE message."threadId" = thread.id
                AND message.seq > ${authorized.messageAccessAfterSeq}
                AND message.seq <= ${messageEnd}
                AND message."creatorAccount" = profile.account
                AND message."creatorDomain" = profile.domain
                AND message."profileRev" = ${rev}
                AND message."contentType" <> 'SYSTEM'
            )
          LIMIT 1
        `);
          return result.rows[0] ?? null;
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      if (
        error instanceof BusinessException &&
        error.bizCode === BusinessCode.FORBIDDEN
      )
        return null;
      throw error;
    }
    return row
      ? this.toS2SProfile({
          account: row.account,
          domain: memberDomain,
          name: row.displayName,
          avatar: row.avatar,
          bio: row.bio,
          profileRev: row.profileRev,
        })
      : null;
  }

  private profileNotDisclosed(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED,
      'profile revision is not disclosed to this peer',
    );
  }

  async fetchRemoteAccount(address: S2SAddress): Promise<S2SProfile> {
    const profile = await this.peerHttp.get<S2SProfile>(
      `/s2s/v1/accounts/${encodeFederationResourceComponent(address.account)}`,
      address.domain,
    );
    if (!Number.isSafeInteger(profile.profileRev) || profile.profileRev < 1) {
      throw new S2sResponseError(
        `S2S profile from ${address.domain} has an invalid profileRev`,
        HttpStatus.OK,
        BusinessCode.FEDERATION_MALFORMED,
      );
    }
    return profile;
  }

  /** Fetch an exact signed profile. The path names its revision, so the
   * closed evidence response intentionally omits profileRev on the wire. */
  async fetchExactIntentProfile(
    account: string,
    peerAccount: string,
    rev: number,
    publisherDomain: string,
  ): Promise<S2SProfile | null> {
    return this.fetchExactProfile(
      `/s2s/v1/intent-profiles/${encodeFederationResourceComponent(account)}` +
        `/${encodeFederationResourceComponent(peerAccount)}/${rev}`,
      account,
      publisherDomain,
      rev,
    );
  }

  async fetchExactAccountProfile(
    account: string,
    rev: number,
    publisherDomain: string,
  ): Promise<S2SProfile | null> {
    return this.fetchExactProfile(
      `/s2s/v1/account-profiles/${encodeFederationResourceComponent(account)}/${rev}`,
      account,
      publisherDomain,
      rev,
    );
  }

  async fetchExactGroupMemberProfile(
    groupAccount: string,
    memberDomain: string,
    memberAccount: string,
    rev: number,
    groupDomain: string,
  ): Promise<S2SProfile | null> {
    return this.fetchExactProfile(
      `/s2s/v1/group-member-profiles/${encodeFederationResourceComponent(groupAccount)}` +
        `/${encodeFederationResourceComponent(memberDomain)}` +
        `/${encodeFederationResourceComponent(memberAccount)}/${rev}`,
      memberAccount,
      memberDomain,
      rev,
      groupDomain,
    );
  }

  private async fetchExactProfile(
    path: string,
    expectedAccount: string,
    expectedDomain: string,
    rev: number,
    publisherDomain = expectedDomain,
  ): Promise<S2SProfile | null> {
    this.assertPositiveRevision(rev);
    let body: unknown;
    try {
      body = await this.peerHttp.get<unknown>(
        path,
        publisherDomain,
        2 * UploadService.MAX_AVATAR_WIRE_B64_LEN,
      );
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        error.status === HttpStatus.OK &&
        error.code === BusinessCode.NOT_FOUND
      )
        return null;
      throw error;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return this.invalidExactProfile(publisherDomain);
    const fields = body as Record<string, unknown>;
    if (
      Object.keys(fields).sort().join(',') !==
        'account,avatar,bio,displayName,domain' ||
      fields.account !== expectedAccount ||
      fields.domain !== expectedDomain ||
      typeof fields.displayName !== 'string' ||
      !this.validWireText(fields.displayName, 1, 31) ||
      typeof fields.bio !== 'string' ||
      !this.validWireText(fields.bio, 0, 120) ||
      !this.validWireAvatar(fields.avatar)
    )
      return this.invalidExactProfile(publisherDomain);
    return { ...(body as Omit<S2SProfile, 'profileRev'>), profileRev: rev };
  }

  private validWireText(value: string, min: number, max: number): boolean {
    const length = Array.from(value).length;
    return length >= min && length <= max && !/[\uD800-\uDFFF]/u.test(value);
  }

  private validWireAvatar(value: unknown): boolean {
    if (value === null) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const avatar = value as Record<string, unknown>;
    return (
      Object.keys(avatar).sort().join(',') ===
        'base64,height,mimeType,width' &&
      typeof avatar.mimeType === 'string' &&
      avatar.mimeType.length > 0 &&
      typeof avatar.base64 === 'string' &&
      avatar.base64.length <= UploadService.MAX_AVATAR_WIRE_B64_LEN &&
      Number.isSafeInteger(avatar.width) &&
      Number(avatar.width) > 0 &&
      Number.isSafeInteger(avatar.height) &&
      Number(avatar.height) > 0
    );
  }

  private invalidExactProfile(publisherDomain: string): never {
    throw new S2sResponseError(
      `S2S exact profile from ${publisherDomain} has an invalid response`,
      HttpStatus.OK,
      BusinessCode.FEDERATION_MALFORMED,
    );
  }

  private async prepareForeignProfileData(profile: S2SProfile): Promise<{
    name: string;
    bio: string;
    avatar: string;
  }> {
    this.assertPositiveRevision(profile.profileRev);
    let avatar = '';
    if (profile.avatar) {
      try {
        if (
          typeof profile.avatar.mimeType !== 'string' ||
          profile.avatar.mimeType.length === 0 ||
          typeof profile.avatar.base64 !== 'string' ||
          profile.avatar.base64.length > UploadService.MAX_AVATAR_WIRE_B64_LEN
        ) {
          throw new Error('invalid public profile avatar metadata');
        }
        avatar = await this.upload.saveAvatarFromWire({
          b64: profile.avatar.base64,
          w: profile.avatar.width,
          h: profile.avatar.height,
          mimeType: profile.avatar.mimeType,
        });
      } catch {
        // A malformed or over-limit avatar must not prevent the textual profile revision from being
        // materialized. Store an explicit empty avatar so an older revision cannot leak through.
        avatar = '';
      }
    }
    return {
      name: truncateCodePoints(
        profile.displayName,
        FEDERATED_PROFILE_NAME_MAX_CODE_POINTS,
      ),
      bio: truncateCodePoints(
        profile.bio,
        FEDERATED_PROFILE_BIO_MAX_CODE_POINTS,
      ),
      avatar,
    };
  }

  private assertPositiveRevision(profileRev: number): void {
    if (!Number.isSafeInteger(profileRev) || profileRev < 1) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'profileRev must be a positive safe integer',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
