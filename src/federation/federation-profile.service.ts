import {
  groupState as groupStateTable,
  readGroupState,
  groupStateFields,
} from '../group/shared/group-state.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
          digest: createHash('sha256')
            .update(Buffer.from(wire.b64, 'base64'))
            .digest('hex'),
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

  /** Resolve one exact locally-owned revision after applying this server's disclosure policy. */
  async getAuthorizedLocalProfile(
    account: string,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    if (rev < 1) return null;
    if (account.startsWith('!')) {
      let row;
      try {
        row = await this.database.db.transaction(
          async (tx) => {
            const authorized = await resolveAuthorizedFederationThreadInTx(
              tx,
              peerDomain,
              namespaceId,
              { type: 'GROUP', account },
            );
            if (authorized.groupQueryDirection !== 'ORIGIN_DISTRIBUTION')
              this.profileNotDisclosed();
            const [value] = await tx
              .select({
                groupId: groupStateTable.id,
                account: groupStateFields.account,
                displayName: tables.profileTable.displayName,
                avatar: tables.profileTable.avatar,
                bio: tables.profileTable.bio,
                profileRev: tables.profileTable.profileRev,
              })
              .from(groupStateTable)
              .innerJoin(
                tables.profileTable,
                and(
                  eq(tables.profileTable.account, groupStateFields.account),
                  eq(tables.profileTable.domain, groupStateFields.domain),
                  eq(
                    tables.profileTable.namespaceId,
                    groupStateFields.namespaceId,
                  ),
                  eq(tables.profileTable.profileRev, rev),
                ),
              )
              .leftJoin(
                tables.groupMeta,
                and(
                  eq(tables.groupMeta.threadId, groupStateTable.id),
                  eq(tables.groupMeta.profileRev, rev),
                ),
              )
              .where(
                and(
                  eq(groupStateFields.account, account),
                  eq(groupStateFields.domain, 'local'),
                  eq(groupStateFields.namespaceId, 0),
                  sql`(
                  ${tables.groupMeta.threadId} IS NOT NULL
                  OR EXISTS (
                    SELECT 1
                    FROM "RelationshipIntent" intent
                    JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
                    WHERE intent."profileRev" = ${rev}
                      AND (intent.status = 'ACCEPTED'
                        OR (intent.status = 'REQUESTED'
                          AND intent."expiresAt" > CURRENT_TIMESTAMP))
                      AND pair."endpointANamespaceId" = ${namespaceId}
                      AND pair."endpointBNamespaceId" = ${namespaceId}
                      AND (
                        (intent."authorSide" = 'A'
                          AND pair."endpointAType" = 'GROUP'
                          AND pair."endpointAAccount" = ${groupStateFields.account}
                          AND pair."endpointADomain" = 'local'
                          AND pair."endpointBDomain" = ${peerDomain})
                        OR
                        (intent."authorSide" = 'B'
                          AND pair."endpointBType" = 'GROUP'
                          AND pair."endpointBAccount" = ${groupStateFields.account}
                          AND pair."endpointBDomain" = 'local'
                          AND pair."endpointADomain" = ${peerDomain})
                      )
                  )
                )`,
                ),
              )
              .limit(1);
            return value;
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
      } catch (error) {
        if (
          error instanceof BusinessException &&
          error.bizCode === BusinessCode.FORBIDDEN
        )
          this.profileNotDisclosed();
        throw error;
      }
      if (!row) this.profileNotDisclosed();
      return this.toS2SProfile({
        account: row.account,
        name: row.displayName,
        avatar: row.avatar,
        bio: row.bio,
        profileRev: row.profileRev,
      });
    }

    const row = await this.database.db
      .select({
        userId: tables.account.id,
        account: tables.account.account,
        displayName: tables.profileTable.displayName,
        avatar: tables.profileTable.avatar,
        bio: tables.profileTable.bio,
        profileRev: tables.profileTable.profileRev,
      })
      .from(tables.account)
      .innerJoin(
        tables.profileTable,
        and(
          eq(tables.profileTable.account, tables.account.account),
          eq(tables.profileTable.domain, tables.account.domain),
          eq(tables.profileTable.namespaceId, tables.account.namespaceId),
          eq(tables.profileTable.profileRev, rev),
        ),
      )
      .where(
        and(
          eq(tables.account.account, normalizeAccount(account)),
          eq(tables.account.domain, 'local'),
          eq(tables.account.namespaceId, 0),
        ),
      )
      .limit(1)
      .then(([value]) => value);
    if (!row) return null;

    const authorized = await this.database.db.execute(sql`
      SELECT 1
      FROM "RelationshipIntent" intent
      JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
      WHERE intent."profileRev" = ${rev}
        AND (intent.status = 'ACCEPTED'
          OR (intent.status = 'REQUESTED'
            AND intent."expiresAt" > CURRENT_TIMESTAMP))
        AND (
          (intent."authorSide" = 'A'
            AND pair."endpointAType" = 'USER'
            AND pair."endpointAAccount" = ${row.account}
            AND pair."endpointADomain" = 'local'
            AND pair."endpointBDomain" = ${peerDomain}
            AND pair."endpointBNamespaceId" = ${namespaceId})
          OR
          (intent."authorSide" = 'B'
            AND pair."endpointBType" = 'USER'
            AND pair."endpointBAccount" = ${row.account}
            AND pair."endpointBDomain" = 'local'
            AND pair."endpointADomain" = ${peerDomain}
            AND pair."endpointANamespaceId" = ${namespaceId})
        )
      LIMIT 1
    `);
    if (authorized.rows.length === 0) this.profileNotDisclosed();
    return this.toS2SProfile({
      account: row.account,
      name: row.displayName,
      avatar: row.avatar,
      bio: row.bio,
      profileRev: row.profileRev,
    });
  }

  private profileNotDisclosed(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED,
      'profile revision is not disclosed to this peer',
    );
  }

  /** Pull and materialize one exact remote group profile revision. A mirror's
   * meta round calls this after a GROUP_PROFILE item advances the applied
   * revision, because the feed item carries the revision only, not the content.
   * The origin discloses it through the Group Meta end coordinate. */
  async pullRemoteGroupProfile(
    address: S2SAddress,
    rev: number,
    namespaceId: number,
  ): Promise<void> {
    const profile = await this.peerHttp.get<S2SProfile>(
      `/s2s/v1/profiles/${encodeFederationResourceComponent(address.account)}?rev=${rev}`,
      address.domain,
    );
    if (
      profile.account !== address.account ||
      profile.domain !== address.domain ||
      profile.profileRev !== rev
    )
      throw new S2sResponseError(
        `S2S profile from ${address.domain} is not ${address.account}@${rev}`,
        HttpStatus.OK,
        BusinessCode.FEDERATION_MALFORMED,
      );
    await this.materializeExactForeignProfile(
      profile,
      address.domain,
      namespaceId,
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
          !/^[a-f0-9]{64}$/.test(profile.avatar.digest) ||
          typeof profile.avatar.mimeType !== 'string' ||
          profile.avatar.mimeType.length === 0 ||
          typeof profile.avatar.base64 !== 'string' ||
          profile.avatar.base64.length > UploadService.MAX_AVATAR_WIRE_B64_LEN
        ) {
          throw new Error('invalid public profile avatar metadata');
        }
        const bytes = Buffer.from(profile.avatar.base64, 'base64');
        if (
          createHash('sha256').update(bytes).digest('hex') !==
          profile.avatar.digest
        ) {
          throw new Error('public profile avatar digest mismatch');
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
