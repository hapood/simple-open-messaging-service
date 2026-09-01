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
import { FederationUserDirectoryService } from './federation-user-directory.service.js';
import type { FederationContext } from './federation-namespace.service.js';

type ProfileWriteGate =
  | {
      threadId: number;
      peerDomain: string;
      expectedFederationVersion: number;
    }
  | { peerToken: FederationContext };

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
    const wire = user.avatar
      ? await this.upload.readAvatarAsWire(user.avatar)
      : null;
    const avatar = wire
      ? {
          digest: createHash('sha256')
            .update(Buffer.from(wire.b64, 'base64'))
            .digest('hex'),
          mimeType: 'image/webp',
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
    const storedDomain = domain === this.config.domain ? 'local' : domain;
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
    if (row) {
      return this.toS2SProfile({
        account: row.account,
        domain,
        name: row.displayName,
        avatar: row.avatar,
        bio: row.bio,
        profileRev: row.profileRev,
      });
    }
    const referenced = await this.database.db
      .select({
        account: tables.user.account,
        displayName: tables.referencedUserProfileVersion.displayName,
        avatar: tables.referencedUserProfileVersion.avatar,
        profileRev: tables.referencedUserProfileVersion.profileRev,
      })
      .from(tables.user)
      .innerJoin(
        tables.referencedUserProfileVersion,
        and(
          eq(tables.referencedUserProfileVersion.userId, tables.user.id),
          eq(tables.referencedUserProfileVersion.profileRev, rev),
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
    if (!referenced) return null;
    return this.toS2SProfile({
      account: referenced.account,
      domain,
      name: referenced.displayName,
      avatar: referenced.avatar,
      bio: '',
      profileRev: referenced.profileRev,
    });
  }

  async getStoredProfile(
    account: string,
    domain: string,
    namespaceId: number,
    rev: number,
  ): Promise<S2SProfile | null> {
    if (!account.startsWith('!')) {
      return this.getStoredUserProfile(account, domain, namespaceId, rev);
    }
    const storedDomain = domain === this.config.domain ? 'local' : domain;
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
      if (profile.avatar && prepared.avatar === undefined) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'peer returned an invalid profile avatar',
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.database.db
        .insert(tables.profileVersion)
        .values({
          groupId: group.id,
          profileRev: profile.profileRev,
          displayName: profile.displayName,
          avatar: prepared.avatar ?? '',
          bio: profile.bio,
        })
        .onConflictDoNothing();
      return;
    }
    const existing = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(profile.account)),
        eq(tables.user.domain, profile.domain),
        eq(tables.user.sourceDomain, sourceDomain),
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
    if (profile.avatar && prepared.avatar === undefined) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'peer returned an invalid profile avatar',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.database.db
      .insert(tables.profileVersion)
      .values({
        userId,
        profileRev: profile.profileRev,
        displayName: profile.displayName,
        avatar: prepared.avatar ?? '',
        bio: profile.bio,
      })
      .onConflictDoNothing();
  }

  /** Retain the disclosure-limited display snapshot referenced by one received message. */
  async materializeReferencedUserProfile(
    profile: Omit<S2SProfile, 'bio'>,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<void> {
    const existing = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(profile.account)),
        eq(tables.user.domain, profile.domain),
        eq(tables.user.sourceDomain, sourceDomain),
        eq(tables.user.namespaceId, namespaceId),
      ),
      columns: { id: true },
    });
    if (!existing) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'message author shell is unavailable',
      );
    }
    const prepared = await this.prepareForeignProfileData({
      ...profile,
      bio: '',
    });
    if (profile.avatar && prepared.avatar === undefined) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'peer returned an invalid profile avatar',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.database.db
      .insert(tables.referencedUserProfileVersion)
      .values({
        userId: existing.id,
        profileRev: profile.profileRev,
        displayName: profile.displayName,
        avatar: prepared.avatar ?? '',
      })
      .onConflictDoNothing();
  }

  async getLocalUserProfile(address: S2SAddress): Promise<S2SProfile | null> {
    if (address.domain !== this.config.domain) return null;
    const user = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(address.account)),
        eq(tables.user.domain, 'local'),
        eq(tables.user.namespaceId, 0),
      ),
    });
    if (!user || user.domain !== 'local') return null;
    return this.toS2SProfile({
      ...user,
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
    if (account.startsWith('!')) {
      const row = await this.database.db
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
        .where(
          and(
            eq(tables.group.account, account),
            eq(tables.group.domain, 'local'),
            eq(tables.group.namespaceId, 0),
          ),
        )
        .limit(1)
        .then(([value]) => value);
      if (!row) return null;
      const disclosed = await this.database.db
        .select({ value: sql<number>`1` })
        .from(tables.groupMetaProfileFeed)
        .where(
          and(
            eq(tables.groupMetaProfileFeed.groupId, row.groupId),
            eq(tables.groupMetaProfileFeed.targetPeerDomain, peerDomain),
            eq(tables.groupMetaProfileFeed.targetNamespaceId, namespaceId),
            eq(tables.groupMetaProfileFeed.profileRev, rev),
          ),
        )
        .limit(1);
      if (disclosed.length === 0) this.profileNotDisclosed();
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
        AND intent.status IN ('REQUESTED', 'ACCEPTED')
        AND pair.kind = 'P2P'
        AND (
          (intent."authorSide" = 'A'
            AND pair."endpointAType" = 'USER'
            AND pair."endpointAAccount" = ${row.account}
            AND pair."endpointADomain" = ${this.config.domain}
            AND pair."endpointBType" = 'USER'
            AND pair."endpointBDomain" = ${peerDomain}
            AND pair."endpointBNamespaceId" = ${namespaceId})
          OR
          (intent."authorSide" = 'B'
            AND pair."endpointBType" = 'USER'
            AND pair."endpointBAccount" = ${row.account}
            AND pair."endpointBDomain" = ${this.config.domain}
            AND pair."endpointAType" = 'USER'
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
    const profile = await this.fetchRemoteUser(address);
    await this.localizeForeignProfile(userId, profile, { peerToken });
  }

  async fetchRemoteUser(address: S2SAddress): Promise<S2SProfile> {
    const profile = await this.peerHttp.get<S2SProfile>(
      `/s2s/v1/users/${encodeFederationResourceComponent(address.account)}`,
      address.domain,
    );
    if (!Number.isSafeInteger(profile.profileRev) || profile.profileRev < 0) {
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
    avatar?: string;
  }> {
    let newAvatarUrl: string | null = null;
    if (profile.avatar) {
      try {
        if (
          !/^[a-f0-9]{64}$/.test(profile.avatar.digest) ||
          typeof profile.avatar.mimeType !== 'string' ||
          profile.avatar.mimeType.length === 0
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
        newAvatarUrl = await this.upload.saveAvatarFromWire({
          b64: profile.avatar.base64,
          w: profile.avatar.width,
          h: profile.avatar.height,
        });
      } catch {
        newAvatarUrl = null;
      }
    } else {
      newAvatarUrl = '';
    }
    const data: {
      name: string;
      bio: string;
      defaultProfileRev: number;
      avatar?: string;
    } = {
      name: profile.displayName,
      bio: profile.bio,
      defaultProfileRev: profile.profileRev,
    };
    if (newAvatarUrl !== null) data.avatar = newAvatarUrl;
    return data;
  }
}
