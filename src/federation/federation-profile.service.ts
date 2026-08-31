import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
      domain: this.config.domain,
      displayName: user.name,
      avatar,
      bio: user.bio,
      profileRev: user.profileRev,
    };
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
    return this.toS2SProfile(user);
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
      columns: { avatar: true, profileRev: true },
    });
    if (!stub || profile.profileRev <= stub.profileRev) return;

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
      const [stub] = await tx
        .select({ profileRev: tables.user.profileRev })
        .from(tables.user)
        .where(eq(tables.user.id, userId))
        .for('update')
        .limit(1);
      if (
        stub?.profileRev !== undefined &&
        profile.profileRev <= stub.profileRev
      ) {
        return userId;
      }
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
    profileRev: number;
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
      profileRev: number;
      avatar?: string;
    } = {
      name: profile.displayName,
      bio: profile.bio,
      profileRev: profile.profileRev,
    };
    if (newAvatarUrl !== null) data.avatar = newAvatarUrl;
    return data;
  }
}
