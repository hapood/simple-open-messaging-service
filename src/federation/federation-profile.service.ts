import {
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
import { S2sResponseError } from './federation-errors.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import type { S2SProfile } from './federation-profile.js';
import { encodeFederationResourceComponent } from './federation-resource-request.js';
import { sealBox } from './sealed-box.js';
import { ProfileNamespaceService } from './profile-namespace.service.js';
import { ProfileNamespaceRefreshService } from './profile-namespace-refresh.service.js';

/** Possession-proof key source for `fetchRemoteAccount` (see there). */
export type PossessionKey =
  | { kind: 'PIN' }
  | {
      kind: 'VOUCH';
      publisherNamespaceId: number;
      profileNamespaceId: number;
    };
import { resolveAuthorizedFederationThreadInTx } from './federation-thread-query-authorization.js';

const FEDERATED_PROFILE_NAME_MAX_CODE_POINTS = 31;
const FEDERATED_PROFILE_BIO_MAX_CODE_POINTS = 120;

function truncateCodePoints(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

/** Reads public federation profiles and materializes verified foreign profile projections. */
@Injectable()
export class FederationProfileService {
  constructor(
    private readonly database: DatabaseService,
    private readonly upload: UploadService,
    private readonly peerHttp: FederationPeerHttp,
    private readonly profileNamespace: ProfileNamespaceService,
    private readonly refresh: ProfileNamespaceRefreshService,
  ) {}

  async toS2SProfile(user: {
    profileNamespaceId: number;
    account: string;
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
      namespaceId: user.profileNamespaceId,
      account: user.account,
      displayName: user.name,
      avatar,
      bio: user.bio,
      profileRev: user.profileRev,
    };
  }

  async getStoredProfile(
    publisherNamespaceId: number,
    account: string,
    profileNamespaceId: number,
    rev: number,
  ): Promise<S2SProfile | null> {
    if (rev < 1) return null;
    const row = await this.database.db.query.profileTable.findFirst({
      where: and(
        eq(tables.profileTable.publisherNamespaceId, publisherNamespaceId),
        eq(tables.profileTable.account, normalizeAccount(account)),
        eq(tables.profileTable.profileNamespaceId, profileNamespaceId),
        eq(tables.profileTable.profileRev, rev),
      ),
    });
    if (!row) return null;
    return this.toS2SProfile({
      profileNamespaceId: row.profileNamespaceId,
      account: row.account,
      name: row.displayName,
      avatar: row.avatar,
      bio: row.bio,
      profileRev: row.profileRev,
    });
  }

  /** Store an exact snapshot without creating a user/group identity or moving a default pointer. */
  async materializeExactForeignProfile(
    profile: S2SProfile,
    publisherNamespaceId: number,
  ): Promise<void> {
    this.assertPositiveRevision(profile.profileRev);
    const prepared = await this.prepareForeignProfileData(profile);
    await this.database.db.transaction(async (tx) => {
      const source = await tx.query.identityNamespace.findFirst({
        where: eq(tables.identityNamespace.id, publisherNamespaceId),
      });
      if (!source || publisherNamespaceId === 0)
        throw new Error('foreign profile publisher namespace is unavailable');
      await writeProfileSnapshotInTx(tx, {
        publisherNamespaceId,
        account: normalizeAccount(profile.account),
        profileNamespaceId: profile.namespaceId,
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
    const localNamespace =
      await this.database.db.query.identityNamespace.findFirst({
        where: and(
          eq(tables.identityNamespace.id, 0),
          eq(tables.identityNamespace.domain, address.domain),
        ),
        columns: { id: true },
      });
    if (!localNamespace) return null;
    const profileNamespaceId = 0;
    const account = normalizeAccount(address.account);
    if (account.startsWith('!')) {
      const group = await readGroupState(
        this.database.db,
        and(
          eq(groupStateFields.account, account),
          eq(groupStateFields.namespaceId, 0),
        ),
      );
      if (!group || group.profileRev === 0 || group.dissolvedAt) return null;
      return this.getStoredProfile(
        0,
        group.account,
        profileNamespaceId,
        group.profileRev,
      );
    }
    const user = await this.database.db.query.account.findFirst({
      where: and(
        eq(tables.account.account, account),
        eq(tables.account.namespaceId, 0),
      ),
    });
    if (!user || user.namespaceId !== 0 || user.defaultProfileRev === 0)
      return null;
    return this.getStoredProfile(
      0,
      user.account,
      profileNamespaceId,
      user.defaultProfileRev,
    );
  }

  /** Exact directed-intent disclosure; an unrelated message or current Meta
   * reference cannot authorize this operation. The proof and snapshot are read
   * from one read-only repeatable-read database snapshot. */
  async getAuthorizedIntentProfile(
    account: string,
    peerAccount: string,
    profileNamespaceId: number,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    if (
      !Number.isSafeInteger(profileNamespaceId) ||
      profileNamespaceId < 0 ||
      !Number.isSafeInteger(rev) ||
      rev < 1
    )
      return null;
    const result = await this.database.db.transaction(
      (tx) =>
        tx.execute<{
          account: string;
          displayName: string;
          avatar: string;
          bio: string;
          profileNamespaceId: number;
          profileRev: number;
        }>(sql`
        SELECT profile.account, profile."displayName", profile.avatar,
          profile.bio, profile."profileNamespaceId", profile."profileRev"
        FROM "Profile" profile
        WHERE profile.account = ${normalizeAccount(account)}
          AND profile."publisherNamespaceId" = 0
          AND profile."profileNamespaceId" = ${profileNamespaceId}
          AND profile."profileRev" = ${rev}
          AND (
            EXISTS (SELECT 1 FROM "Account" owner
              WHERE owner.account = profile.account
                AND owner."namespaceId" = 0 AND owner.kind = 'USER'
                AND owner.availability = 'AVAILABLE')
            OR EXISTS (SELECT 1 FROM ${groupStateSql} group_state
              WHERE group_state.account = profile.account
                AND group_state."namespaceId" = 0
                AND group_state."dissolvedAt" IS NULL)
          )
          AND EXISTS (
            SELECT 1 FROM "RelationshipIntent" intent
            WHERE intent."profileNamespaceId" = ${profileNamespaceId}
              AND intent."profileRev" = ${rev}
              AND (intent.status = 'ACCEPTED'
                OR (intent.status = 'REQUESTED'
                  AND intent."expiresAt" > CURRENT_TIMESTAMP))
              AND intent."authorAccount" = profile.account
                AND intent."authorNamespaceId" = 0
                AND intent."receiverAccount" = ${normalizeAccount(peerAccount)}
                AND intent."receiverNamespaceId" = ${namespaceId}
          )
        LIMIT 1
      `),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const row = result.rows[0];
    return row
      ? this.toS2SProfile({
          profileNamespaceId: row.profileNamespaceId,
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
    profileNamespaceId: number,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    if (
      !Number.isSafeInteger(profileNamespaceId) ||
      profileNamespaceId < 0 ||
      !Number.isSafeInteger(rev) ||
      rev < 1
    )
      return null;
    const namespace = await this.database.db.query.identityNamespace.findFirst({
      where: and(
        eq(tables.identityNamespace.id, namespaceId),
        eq(tables.identityNamespace.domain, peerDomain),
      ),
      columns: { id: true },
    });
    if (!namespace) return null;
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
              profileNamespaceId: number;
              profileRev: number;
            }>(sql`
            SELECT profile.account, profile."displayName", profile.avatar,
              profile.bio, profile."profileNamespaceId", profile."profileRev"
            FROM "GroupAccount" group_account
            JOIN "MessageThread" thread ON thread.id = ${authorized.threadId}
              AND thread."groupAccountId" = group_account.id
            JOIN "GroupMeta" meta ON meta."threadId" = thread.id
              AND meta."profileRev" = ${rev}
            JOIN "GroupMetaMemberFeed" fact ON fact."threadId" = meta."threadId"
              AND fact.operation = 'GROUP_PROFILE'
              AND (fact.body ->> 'profileNamespaceId')::integer = ${profileNamespaceId}
              AND (fact.body ->> 'profileRev')::integer = ${rev}
            JOIN "Profile" profile ON profile.account = group_account.account
              AND profile."publisherNamespaceId" = 0
              AND profile."profileNamespaceId" = ${profileNamespaceId}
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
            profileNamespaceId: row.profileNamespaceId,
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
          profileNamespaceId: number;
          profileRev: number;
        }>(sql`
      SELECT profile.account, profile."displayName", profile.avatar,
        profile.bio, profile."profileNamespaceId", profile."profileRev"
      FROM "Profile" profile
      JOIN "Account" owner ON owner.account = profile.account
        AND owner."namespaceId" = 0
        AND owner.kind = 'USER' AND owner.availability = 'AVAILABLE'
      WHERE profile.account = ${owner}
        AND profile."publisherNamespaceId" = 0
        AND profile."profileNamespaceId" = ${profileNamespaceId}
        AND profile."profileRev" = ${rev}
        AND EXISTS (
          SELECT 1 FROM "Message" m
          JOIN "MessageThread" thread ON thread.id = m."threadId"
          JOIN "RelationshipPair" pair ON pair."threadId" = thread.id
            AND pair.active

          JOIN "PeerStateFeed" head ON head."namespaceId" = ${namespaceId}
            AND head."eventType" = 'THREAD_CONTENT_HEAD'
            AND head.account = CASE WHEN thread.type = 'P2P'
              THEN profile.account ELSE thread."groupAccount" END
            AND head."subjectAccount" = CASE WHEN thread.type = 'P2P'
              THEN CASE WHEN pair."endpointAAccount" = profile.account
                THEN pair."endpointBAccount" ELSE pair."endpointAAccount" END
              ELSE '' END
            AND head."subjectNamespaceId" = CASE WHEN thread.type = 'P2P'
              THEN ${namespaceId} ELSE 0 END
          LEFT JOIN "ThreadAudience" audience ON audience."threadId" = thread.id
            AND audience."targetNamespaceId" = ${namespaceId}
            AND audience."localUserId" IS NULL
          WHERE m."creatorAccount" = profile.account
            AND m."profileNamespaceId" = profile."profileNamespaceId"
            AND m."profileRev" = ${rev} AND m."publisherNamespaceId" = 0
            AND m."contentType" <> 'SYSTEM'
            AND m."isDeleted" = false
            AND m."localState" = 'READY'
            AND m.seq > COALESCE(audience."messageAccessAfterSeq", 0)
            AND m.seq::numeric <= CASE
              WHEN (head.body ->> 'messageEndSeq') ~ '^[0-9]{1,10}$'
              THEN (head.body ->> 'messageEndSeq')::numeric ELSE 0 END
            AND (
              (thread.type = 'P2P' AND pair.kind = 'P2P'
                AND pair."endpointAType" = 'USER'
                AND pair."endpointAAccount" = profile.account
                AND pair."endpointBType" = 'USER'
                AND pair."endpointBNamespaceId" = ${namespaceId}
                AND EXISTS (
                  SELECT 1 FROM "RelationshipIntent" intent
                  WHERE (
                    (intent."authorAccount" = pair."endpointAAccount"
                      AND intent."authorNamespaceId" = pair."endpointANamespaceId"
                      AND intent."receiverAccount" = pair."endpointBAccount"
                      AND intent."receiverNamespaceId" = pair."endpointBNamespaceId")
                    OR
                    (intent."authorAccount" = pair."endpointBAccount"
                      AND intent."authorNamespaceId" = pair."endpointBNamespaceId"
                      AND intent."receiverAccount" = pair."endpointAAccount"
                      AND intent."receiverNamespaceId" = pair."endpointANamespaceId")
                  )
                  AND (intent.status = 'ACCEPTED'
                    OR (intent.status = 'REQUESTED'
                      AND intent."expiresAt" > CURRENT_TIMESTAMP))
                )
              )
              OR
              (thread.type = 'GROUP' AND pair.kind = 'GROUP_MEMBER'
                AND thread."groupDomain" = ${peerDomain}
                AND thread."authorityNamespaceId" = ${namespaceId}
                AND thread."groupAccountId" IS NULL
                AND pair."endpointBType" = 'GROUP'
                AND pair."endpointBAccount" = thread."groupAccount"
                AND pair."endpointAType" = 'USER'
                AND pair."endpointAAccount" = profile.account
                AND pair."endpointBNamespaceId" = ${namespaceId}
                AND EXISTS (
                  SELECT 1 FROM "RelationshipIntent" intent
                  WHERE intent."authorAccount" = pair."endpointBAccount"
                    AND intent."authorNamespaceId" = pair."endpointBNamespaceId"
                    AND intent."receiverAccount" = pair."endpointAAccount"
                    AND intent."receiverNamespaceId" = pair."endpointANamespaceId"
                    AND (intent.status = 'ACCEPTED'
                      OR (intent.status = 'REQUESTED'
                        AND intent."expiresAt" > CURRENT_TIMESTAMP))
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
          profileNamespaceId: row.profileNamespaceId,
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
    memberAccount: string,
    profileNamespaceId: number,
    rev: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<S2SProfile | null> {
    if (
      !Number.isSafeInteger(profileNamespaceId) ||
      profileNamespaceId < 0 ||
      !Number.isSafeInteger(rev) ||
      rev < 1
    )
      return null;
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
                eq(tables.peerStateFeed.namespaceId, namespaceId),
                eq(
                  tables.peerStateFeed.account,
                  normalizeAccount(groupAccount),
                ),
                eq(tables.peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
                eq(tables.peerStateFeed.subjectAccount, ''),
                eq(tables.peerStateFeed.subjectNamespaceId, 0),
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
            profileNamespaceId: number;
            profileRev: number;
          }>(sql`
          SELECT profile.account, profile."displayName", profile.avatar,
            profile.bio, profile."profileNamespaceId", profile."profileRev"
          FROM "Profile" profile
          JOIN "MessageThread" thread ON thread.id = ${authorized.threadId}
          JOIN "GroupAccount" group_account ON group_account.id = thread."groupAccountId"
            AND group_account."dissolvedAt" IS NULL
          WHERE thread.type = 'GROUP'
            AND thread."authorityNamespaceId" = 0
            AND thread."groupAccount" = ${normalizeAccount(groupAccount)}
            AND profile.account = ${normalizeAccount(memberAccount)}
            AND profile."publisherNamespaceId" = CASE WHEN ${profileNamespaceId} = 0 THEN 0 ELSE ${profileNamespaceId} END
            AND profile."profileNamespaceId" = ${profileNamespaceId}
            AND profile."profileRev" = ${rev}
            AND (
              EXISTS (
                SELECT 1 FROM "GroupMetaMemberFeed" fact
                WHERE fact."threadId" = thread.id
                  AND fact."memberAccount" = profile.account
                  AND (fact.body ->> 'profileNamespaceId')::integer = profile."profileNamespaceId"
                  AND fact.operation = 'MEMBER_UPSERT'
                  AND fact."feedId" = (
                    SELECT MAX(current_fact."feedId")
                    FROM "GroupMetaMemberFeed" current_fact
                    WHERE current_fact."threadId" = fact."threadId"
                      AND current_fact."memberAccount" = fact."memberAccount"
                      AND (current_fact.body ->> 'profileNamespaceId')::integer = (fact.body ->> 'profileNamespaceId')::integer
                  )
                  AND (fact.body ->> 'profileNamespaceId')::integer = ${profileNamespaceId}
                  AND (fact.body ->> 'profileRev')::integer = ${rev}
                  AND (profile."profileNamespaceId" = 0 OR EXISTS (
                    SELECT 1 FROM "RelationshipPair" pair
                    WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = thread.id
                      AND pair.active
                      AND pair."endpointBType" = 'USER'
                      AND pair."endpointBAccount" = profile.account
                      AND pair."endpointBNamespaceId" = ${profileNamespaceId}
                  ))
              )
              OR EXISTS (
                SELECT 1 FROM "Message" message
                WHERE message."threadId" = thread.id
                  AND message.seq > ${authorized.messageAccessAfterSeq}
                  AND message.seq <= ${messageEnd}
                  AND message."creatorAccount" = profile.account
                  AND message."profileNamespaceId" = profile."profileNamespaceId"
                  AND message."profileNamespaceId" = ${profileNamespaceId}
                  AND message."profileRev" = ${rev}
                  AND message."contentType" <> 'SYSTEM'
                  AND message."isDeleted" = false
                  AND message."localState" = 'READY'
              )
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
          profileNamespaceId: row.profileNamespaceId,
          account: row.account,
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

  /** Fetch a peer account's public card, binding the answer to a possession
   *  proof (Profiles 2.1/3): the request carries a sealed challenge under the
   *  responder key named by `possession`, and the returned `proof` must equal
   *  the sealed plaintext byte-for-byte.
   *
   *  - `PIN` challenges under this server's current handshake pin for the
   *    target domain: the proof ties the card to the identity this server
   *    already recognizes.
   *  - `VOUCH` challenges under the root key a publisher's profile-namespace
   *    bindings name for the referenced identity: contact cards and group
   *    rosters come with a vouched lineage, and the proof must tie the card
   *    to that lineage — not to whatever this server's local pin happens to
   *    be. An uncertifiable vouch (tomb, expired, or failed refresh) is a
   *    business rejection, never a silently weaker fetch.
   *
   *  The challenge plaintext is the canonical JSON `{"account","domain"}` of
   *  the lookup itself; it is fresh per call and discarded after comparing. */
  async fetchRemoteAccount(
    address: S2SAddress,
    possession: PossessionKey,
  ): Promise<S2SProfile> {
    const rootPublicKey = await this.possessionRootKey(address, possession);
    const plaintext = JSON.stringify({
      account: address.account,
      domain: address.domain,
    });
    const sealed = Buffer.from(
      sealBox(
        Uint8Array.from(Buffer.from(plaintext, 'utf8')),
        Uint8Array.from(Buffer.from(rootPublicKey, 'base64')),
      ),
    ).toString('base64');
    const profile = await this.peerHttp.get<unknown>(
      `/s2s/v1/accounts/${encodeFederationResourceComponent(
        address.account,
      )}?publicKey=${encodeURIComponent(rootPublicKey)}` +
        `&challenge=${encodeURIComponent(sealed)}`,
      address.domain,
    );
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new S2sResponseError(
        `S2S profile from ${address.domain} has an invalid response`,
        HttpStatus.OK,
        BusinessCode.FEDERATION_MALFORMED,
      );
    }
    const fields = profile as Record<string, unknown>;
    if (
      Object.keys(fields).sort().join(',') !==
        'account,avatar,bio,displayName,profileRev,proof' ||
      fields.account !== address.account ||
      typeof fields.displayName !== 'string' ||
      !this.validWireText(fields.displayName, 1, 31) ||
      typeof fields.bio !== 'string' ||
      !this.validWireText(fields.bio, 0, 120) ||
      !this.validWireAvatar(fields.avatar) ||
      !Number.isSafeInteger(fields.profileRev) ||
      Number(fields.profileRev) < 1 ||
      typeof fields.proof !== 'string'
    ) {
      throw new S2sResponseError(
        `S2S profile from ${address.domain} has an invalid response`,
        HttpStatus.OK,
        BusinessCode.FEDERATION_MALFORMED,
      );
    }
    // Byte-for-byte possession check (Profiles 2.1): a mismatch is a hostile
    // or broken responder, never a retryable condition.
    if (fields.proof !== plaintext) {
      throw new S2sResponseError(
        `S2S profile from ${address.domain} failed the possession proof`,
        HttpStatus.OK,
        BusinessCode.FEDERATION_MALFORMED,
      );
    }
    return {
      account: fields.account as string,
      displayName: fields.displayName as string,
      bio: fields.bio as string,
      avatar: fields.avatar as S2SProfile['avatar'],
      profileRev: fields.profileRev as number,
      namespaceId: 0,
    };
  }

  /** Resolves the responder key a possession challenge is sealed under. The
   *  PIN path reads the current handshake pin; the VOUCH path reads the
   *  publisher's bindings row, rejecting when the vouch is uncertifiable. */
  private async possessionRootKey(
    address: S2SAddress,
    possession: PossessionKey,
  ): Promise<string> {
    if (possession.kind === 'PIN') {
      const [row] = await this.database.db
        .select({ rootPublicKey: tables.identityNamespace.rootPublicKey })
        .from(tables.identityNamespace)
        .where(
          and(
            eq(tables.identityNamespace.domain, address.domain),
            eq(tables.identityNamespace.active, true),
          ),
        )
        .limit(1);
      if (!row || row.rootPublicKey === null)
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          `federation peer ${address.domain} has no pinned root key`,
        );
      return row.rootPublicKey;
    }
    const result = await this.profileNamespace.resolveOne({
      publisherNamespaceId: possession.publisherNamespaceId,
      profileNamespaceId: possession.profileNamespaceId,
    });
    if (result.status === 'PENDING')
      this.refresh.scheduleRefresh(
        {
          publisherNamespaceId: possession.publisherNamespaceId,
          profileNamespaceId: possession.profileNamespaceId,
        },
        0n,
      );
    const entry = result.status === 'READY' ? result.entry : undefined;
    if (
      !entry ||
      entry.expired ||
      entry.domain === null ||
      entry.rootPublicKey === null ||
      entry.domain !== address.domain
    )
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `vouched root key for namespace ${possession.profileNamespaceId} is uncertifiable`,
      );
    return entry.rootPublicKey;
  }

  /** Fetch an exact signed profile. The path names its namespace and revision;
   * the closed evidence response carries only profile content and subject address. */
  async fetchExactIntentProfile(
    account: string,
    peerAccount: string,
    rev: number,
    publisherDomain: string,
    expectedProfileNamespaceId = 0,
  ): Promise<S2SProfile | null> {
    return this.fetchExactProfile(
      `/s2s/v1/intent-profiles/${expectedProfileNamespaceId}` +
        `/${encodeFederationResourceComponent(account)}` +
        `/${encodeFederationResourceComponent(peerAccount)}/${rev}`,
      account,
      rev,
      publisherDomain,
      expectedProfileNamespaceId,
    );
  }

  async fetchExactAccountProfile(
    account: string,
    rev: number,
    publisherDomain: string,
    expectedProfileNamespaceId = 0,
  ): Promise<S2SProfile | null> {
    return this.fetchExactProfile(
      `/s2s/v1/account-profiles/${expectedProfileNamespaceId}` +
        `/${encodeFederationResourceComponent(account)}/${rev}`,
      account,
      rev,
      publisherDomain,
      expectedProfileNamespaceId,
    );
  }

  async fetchExactGroupMemberProfile(
    groupAccount: string,
    memberAccount: string,
    rev: number,
    groupDomain: string,
    expectedProfileNamespaceId = 0,
  ): Promise<S2SProfile | null> {
    return this.fetchExactProfile(
      `/s2s/v1/group-member-profiles/${encodeFederationResourceComponent(groupAccount)}` +
        `/${expectedProfileNamespaceId}` +
        `/${encodeFederationResourceComponent(memberAccount)}/${rev}`,
      memberAccount,
      rev,
      groupDomain,
      expectedProfileNamespaceId,
    );
  }

  private async fetchExactProfile(
    path: string,
    expectedAccount: string,
    rev: number,
    publisherDomain: string,
    expectedProfileNamespaceId = 0,
  ): Promise<S2SProfile | null> {
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
        'account,avatar,bio,displayName' ||
      fields.account !== expectedAccount ||
      typeof fields.displayName !== 'string' ||
      !this.validWireText(fields.displayName, 1, 31) ||
      typeof fields.bio !== 'string' ||
      !this.validWireText(fields.bio, 0, 120) ||
      !this.validWireAvatar(fields.avatar)
    )
      return this.invalidExactProfile(publisherDomain);
    return {
      ...(body as Omit<S2SProfile, 'namespaceId' | 'profileRev'>),
      namespaceId: expectedProfileNamespaceId,
      profileRev: rev,
    };
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
      Object.keys(avatar).sort().join(',') === 'base64,height,mimeType,width' &&
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
