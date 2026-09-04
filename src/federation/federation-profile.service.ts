import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
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
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { resolveAuthorizedFederationThreadInTx } from './federation-thread-query-authorization.js';
import { FederationUserDirectoryService } from './federation-user-directory.service.js';
import type { FederationContext } from './federation-namespace.service.js';

type ProfileWriteGate =
  | {
      threadId: number;
      peerDomain: string;
      expectedFederationVersion: number;
    }
  | { peerToken: FederationContext };

const FEDERATED_PROFILE_NAME_MAX_CODE_POINTS = 30;
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
    private readonly threadAccess: FederationThreadAccessService,
    private readonly users: FederationUserDirectoryService,
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

  async getStoredUserProfile(
    account: string,
    domain: string,
    namespaceId: number,
    rev: number,
  ): Promise<S2SProfile | null> {
    if (rev < 1) return null;
    const storedDomain =
      namespaceId === 0 && domain === this.config.domain ? 'local' : domain;
    const row = await this.database.db
      .select({
        account: tables.user.account,
        displayName: tables.profileVersion.displayName,
        avatar: tables.profileVersion.avatar,
        bio: tables.profileVersion.bio,
        profileRev: tables.profileVersion.profileRev,
      })
      .from(tables.user)
      .innerJoin(
        tables.profileVersion,
        and(
          eq(tables.profileVersion.userId, tables.user.id),
          eq(tables.profileVersion.profileRev, rev),
        ),
      )
      .where(
        and(
          eq(tables.user.account, normalizeAccount(account)),
          eq(tables.user.domain, storedDomain),
          eq(
            tables.user.namespaceId,
            storedDomain === 'local' ? 0 : namespaceId,
          ),
        ),
      )
      .limit(1)
      .then(([value]) => value);
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

  async getStoredProfile(
    account: string,
    domain: string,
    namespaceId: number,
    rev: number,
  ): Promise<S2SProfile | null> {
    if (rev < 1) return null;
    if (!account.startsWith('!')) {
      return this.getStoredUserProfile(account, domain, namespaceId, rev);
    }
    const storedDomain =
      namespaceId === 0 && domain === this.config.domain ? 'local' : domain;
    const row = await this.database.db
      .select({
        account: tables.group.account,
        displayName: tables.profileVersion.displayName,
        avatar: tables.profileVersion.avatar,
        bio: tables.profileVersion.bio,
        profileRev: tables.profileVersion.profileRev,
      })
      .from(tables.group)
      .innerJoin(
        tables.profileVersion,
        and(
          eq(tables.profileVersion.groupId, tables.group.id),
          eq(tables.profileVersion.profileRev, rev),
        ),
      )
      .where(
        and(
          eq(tables.group.account, normalizeAccount(account)),
          eq(tables.group.domain, storedDomain),
          eq(
            tables.group.namespaceId,
            storedDomain === 'local' ? 0 : namespaceId,
          ),
        ),
      )
      .limit(1)
      .then(([value]) => value);
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

  /** Persist one exact foreign snapshot without comparing revision numbers or moving a default pointer. */
  async materializeExactForeignProfile(
    profile: S2SProfile,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<void> {
    this.assertPositiveRevision(profile.profileRev);
    if (profile.account.startsWith('!')) {
      const group = await this.database.db.query.group.findFirst({
        where: and(
          eq(tables.group.account, normalizeAccount(profile.account)),
          eq(tables.group.domain, profile.domain),
          eq(tables.group.namespaceId, namespaceId),
        ),
        columns: { id: true },
      });
      if (!group) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'group profile shell is unavailable',
        );
      }
      const prepared = await this.prepareForeignProfileData(profile);
      await this.database.db
        .insert(tables.profileVersion)
        .values({
          groupId: group.id,
          profileRev: profile.profileRev,
          displayName: prepared.name,
          avatar: prepared.avatar,
          bio: prepared.bio,
        })
        .onConflictDoUpdate({
          target: [
            tables.profileVersion.groupId,
            tables.profileVersion.profileRev,
          ],
          targetWhere: sql`${tables.profileVersion.groupId} IS NOT NULL`,
          set: {
            displayName: prepared.name,
            avatar: prepared.avatar,
            bio: prepared.bio,
          },
          setWhere: sql`${sourceDomain} = ${profile.domain}`,
        });
      return;
    }
    const existing = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(profile.account)),
        eq(tables.user.domain, profile.domain),
        eq(tables.user.namespaceId, namespaceId),
      ),
      columns: { id: true },
    });
    const userId =
      existing?.id ??
      (await this.users.ensureForeignUser(
        profile.account,
        profile.domain,
        namespaceId,
      ));
    const prepared = await this.prepareForeignProfileData(profile);
    await this.database.db
      .insert(tables.profileVersion)
      .values({
        userId,
        profileRev: profile.profileRev,
        displayName: prepared.name,
        avatar: prepared.avatar,
        bio: prepared.bio,
      })
      .onConflictDoUpdate({
        target: [
          tables.profileVersion.userId,
          tables.profileVersion.profileRev,
        ],
        targetWhere: sql`${tables.profileVersion.userId} IS NOT NULL`,
        set: {
          displayName: prepared.name,
          avatar: prepared.avatar,
          bio: prepared.bio,
        },
        setWhere: sql`${sourceDomain} = ${profile.domain}`,
      });
  }

  async getLocalAccountProfile(
    address: S2SAddress,
  ): Promise<S2SProfile | null> {
    if (address.domain !== this.config.domain) return null;
    const account = normalizeAccount(address.account);
    if (account.startsWith('!')) {
      const group = await this.database.db.query.group.findFirst({
        where: and(
          eq(tables.group.account, account),
          eq(tables.group.domain, 'local'),
          eq(tables.group.namespaceId, 0),
        ),
      });
      if (!group || group.defaultProfileRev === 0 || group.dissolvedAt)
        return null;
      return this.toS2SProfile({
        account: group.account,
        domain: this.config.domain,
        name: group.name,
        avatar: group.avatar,
        bio: group.description,
        profileRev: group.defaultProfileRev,
      });
    }
    const user = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, account),
        eq(tables.user.domain, 'local'),
        eq(tables.user.namespaceId, 0),
      ),
    });
    if (!user || user.domain !== 'local' || user.defaultProfileRev === 0)
      return null;
    return this.toS2SProfile({
      account: user.account,
      domain: this.config.domain,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      profileRev: user.defaultProfileRev,
    });
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
        row = await this.database.db.transaction(async (tx) => {
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
              groupId: tables.group.id,
              account: tables.group.account,
              displayName: tables.profileVersion.displayName,
              avatar: tables.profileVersion.avatar,
              bio: tables.profileVersion.bio,
              profileRev: tables.profileVersion.profileRev,
            })
            .from(tables.group)
            .innerJoin(
              tables.profileVersion,
              and(
                eq(tables.profileVersion.groupId, tables.group.id),
                eq(tables.profileVersion.profileRev, rev),
              ),
            )
            .innerJoin(
              tables.groupMetaProfileFeed,
              and(
                eq(tables.groupMetaProfileFeed.groupId, tables.group.id),
                eq(tables.groupMetaProfileFeed.profileRev, rev),
              ),
            )
            .where(
              and(
                eq(tables.group.account, account),
                eq(tables.group.domain, 'local'),
                eq(tables.group.namespaceId, 0),
              ),
            )
            .limit(1);
          return value;
        });
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
        userId: tables.user.id,
        account: tables.user.account,
        displayName: tables.profileVersion.displayName,
        avatar: tables.profileVersion.avatar,
        bio: tables.profileVersion.bio,
        profileRev: tables.profileVersion.profileRev,
      })
      .from(tables.user)
      .innerJoin(
        tables.profileVersion,
        and(
          eq(tables.profileVersion.userId, tables.user.id),
          eq(tables.profileVersion.profileRev, rev),
        ),
      )
      .where(
        and(
          eq(tables.user.account, normalizeAccount(account)),
          eq(tables.user.domain, 'local'),
          eq(tables.user.namespaceId, 0),
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

  async ensureForeignUserLocalized(
    userId: number,
    address: S2SAddress,
  ): Promise<void> {
    const peerToken = await this.threadAccess.capturePeerResponseToken(
      address.domain,
    );
    const profile = await this.fetchRemoteAccount(address);
    await this.localizeForeignProfile(userId, profile, { peerToken });
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

  async localizeForeignProfile(
    userId: number,
    profile: S2SProfile,
    gate?: ProfileWriteGate,
  ): Promise<void> {
    const stub = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, userId),
      columns: { id: true },
    });
    if (!stub) return;

    const data = await this.prepareForeignProfileData(profile);
    if (gate) {
      await this.database.db.transaction(async (tx) => {
        if ('peerToken' in gate) {
          await this.threadAccess.assertPeerResponseWritable(
            tx,
            gate.peerToken,
          );
        } else {
          await this.threadAccess.assertResponseWritable(
            tx,
            gate.threadId,
            gate.peerDomain,
            gate.expectedFederationVersion,
          );
        }
        await tx
          .update(tables.user)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(tables.user.id, userId));
      });
      return;
    }
    await this.database.db
      .update(tables.user)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(tables.user.id, userId));
  }

  async upsertForeignUserFromPeerResponse(
    account: string,
    domain: string,
    profile: S2SProfile,
    peerToken: FederationContext,
  ): Promise<number> {
    if (peerToken.domain !== domain) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'peer response token domain does not match foreign user domain',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.database.db.transaction(async (tx) => {
      await this.threadAccess.assertPeerResponseWritable(tx, peerToken);
      const userId = await this.users.ensureForeignUserInTransaction(
        tx,
        account,
        domain,
        peerToken.namespaceId,
      );
      const data = await this.prepareForeignProfileData(profile);
      await tx
        .update(tables.user)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(tables.user.id, userId));
      return userId;
    });
  }

  private async prepareForeignProfileData(profile: S2SProfile): Promise<{
    name: string;
    bio: string;
    defaultProfileRev: number;
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
      defaultProfileRev: profile.profileRev,
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
