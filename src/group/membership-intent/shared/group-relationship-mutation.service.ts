import { isGroupDissolvedInTx } from '../../shared/group-state.js';
import {
  groupState as groupStateTable,
  readGroupState,
  groupStateFields,
} from '../../shared/group-state.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../../../user/account-address.js';
import {
  parseRequestSnapshot,
  type RequestSnapshot,
} from '../../../../shared/request-snapshot.js';
import { Injectable } from '@nestjs/common';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import { and, eq, sql } from 'drizzle-orm';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../../../database/database.service.js';
import type { ThreadContentLock } from '../../../common/locks/thread-content-lock.js';
import { GroupRole } from '../../../database/enums.js';
import * as tables from '../../../database/schema.js';
import { RelationshipService } from '../../../relationship/relationship.service.js';
import {
  buildIntentDirection,
  RelationshipIntentService,
} from '../../../relationship/relationship-intent.service.js';
import { RequestTransactionCapability } from '../../../relationship/request/request-transaction.contract.js';
import type { RequestFlow } from '../../../relationship/request/request-transaction.contract.js';
import { GroupRelationshipFoldService } from './group-relationship-fold.service.js';
import { writeMirrorLocalGroupLeftInTx } from './mirror-local-group-left.js';
import {
  PeerStateFeedService,
  type PeerStateFeedWrite,
} from '../../../federation/peer-state-feed.service.js';
import type {
  RequestRevocationStatus,
  RequestProjectionStatusValue,
} from '../../../../shared/request-projection-status.js';

export interface GroupRelationshipMutationOptions {
  snapshot?: RequestSnapshot | null;
  /** Client-visible cause for an authored terminal request transition. */
  clientRequestStatus?: RequestRevocationStatus;
  clientRequestDirection?: 'INCOMING' | 'OUTGOING';
  publishGroupState?: boolean;
  allowOwnerDeactivation?: boolean;
  initialRole?: typeof GroupRole.OWNER;
  /** A positive member intent may reopen a dissolved mirror; local dissolution remains terminal. */
  allowDissolvedPositive?: boolean;
  /** Canonical locks already owned by a composed business transaction. */
  lockedGroupPair?: {
    pairId: bigint;
    threadLock: ThreadContentLock;
  };
  /** Pair fold already authorized by the lock-owning business state read. */
  validatedPairActive?: boolean;
  /** Commit-time fence for work derived from a federation query denial. */
  expectedAuthorization?: {
    epoch: number;
    group: { account: string; namespaceId: number };
  };
}

/** Result of a group request-effect write: whether a new round was created
 * (the only transition that advances manager notification counters and
 * admits the projection fan-out) plus the post-commit wake hints. */
export interface GroupRequestEffectsResult {
  readonly created: boolean;
  readonly clientUpdates: readonly PendingClientStateFeedUpdate[];
}

/**
 * Serializes and applies relationship mutations. Transport wake-ups remain an
 * outer orchestration concern and occur only after the caller's transaction
 * commits.
 */
@Injectable()
export class GroupRelationshipMutationService {
  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly requestCapability: RequestTransactionCapability,
    private readonly relationships: RelationshipService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly groupRelationships: GroupRelationshipFoldService,
  ) {}

  /** Seed the creator of a new local group, not a user-visible invitation.
   * The caller holds the group's business scope and writes the creation notice
   * before this activation so the owner's read window includes that notice. */
  async initializeFoundingMembershipInTx(
    tx: DatabaseTransaction,
    threadId: number,
    creatorUserId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<void> {
    const locked = await this.relationshipIntents.lockGroupMutationInTx(tx, {
      threadId,
      groupId: threadId,
      memberUserId: creatorUserId,
      feedAllocatorUserIds: [creatorUserId],
    });
    const [group] = await tx
      .select({
        account: tables.groupAccount.account,
        namespaceId: tables.messageThread.authorityNamespaceId,
        profileRev: tables.groupAccount.defaultProfileRev,
        dissolvedAt: tables.groupAccount.dissolvedAt,
        threadDissolvedAt: tables.messageThread.groupDissolvedAt,
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.groupAccount,
        and(
          eq(tables.groupAccount.id, tables.messageThread.groupAccountId),
          eq(tables.groupAccount.account, tables.messageThread.groupAccount),
        ),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (
      !group ||
      group.namespaceId !== 0 ||
      group.profileRev !== 0 ||
      group.dissolvedAt !== null ||
      group.threadDissolvedAt !== null
    )
      throw new Error(
        'founding membership requires an unpublished local group',
      );
    const creator = await tx.query.account.findFirst({
      where: eq(tables.account.id, creatorUserId),
      columns: { account: true, namespaceId: true, defaultProfileRev: true },
    });
    if (!creator || creator.namespaceId !== 0)
      throw new Error('group creator must be a local account');
    if (
      !Number.isSafeInteger(creator.defaultProfileRev) ||
      creator.defaultProfileRev < 0
    )
      throw new Error('group creator profile revision is invalid');
    if (creator.defaultProfileRev > 0) {
      const profile = await tx.query.profileTable.findFirst({
        where: and(
          eq(tables.profileTable.account, creator.account),
          eq(tables.profileTable.publisherNamespaceId, 0),
          eq(tables.profileTable.profileNamespaceId, 0),
          eq(tables.profileTable.profileRev, creator.defaultProfileRev),
        ),
        columns: { profileRev: true },
      });
      if (!profile) throw new Error('group creator profile is unavailable');
    }
    // Check the whole group's history, not only this creator's pair. Even an
    // unpublished group must never acquire another founding owner on reuse.
    // The canonical lock may have just inserted one inactive, unestablished
    // pair shell; every other membership artifact disqualifies initialization.
    const existing = await tx.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM "RelationshipPair"
        WHERE "threadId" = ${threadId}
          AND (id <> ${locked.id} OR active OR established)
        UNION ALL
        SELECT 1 FROM "RelationshipIntent"
        WHERE ("authorAccount" = ${group.account} AND "authorNamespaceId" = 0)
          OR ("receiverAccount" = ${group.account} AND "receiverNamespaceId" = 0)
        UNION ALL
        SELECT 1 FROM "GroupMetaMemberFeed"
        WHERE "threadId" = ${threadId}
          AND operation IN ('MEMBER_UPSERT', 'MEMBER_DEPART')
        UNION ALL
        SELECT 1 FROM "AccountThreadState" WHERE "threadId" = ${threadId}
      ) AS present
    `);
    if (existing.rows[0]?.present !== false)
      throw new Error('founding membership requires pristine membership state');

    const memberDirection = buildIntentDirection(creator, group);
    const common = {
      threadId,
      groupId: threadId,
      memberUserId: creatorUserId,
      pairId: locked.id,
      memberLocal: true,
      memberDirection,
      threadLock: locked.threadLock,
      hostedLocally: true,
      status: 'ACCEPTED' as const,
      snapshot: null,
      initialRole: GroupRole.OWNER,
    };
    // Founding itself authorizes both directions. Seed the group declaration
    // without activation, then activate with the creator's profile evidence.
    // No REQUESTED presentation or permanent request round is involved.
    await this.groupRelationships.writeLockedAuthoredIntentInTx(tx, {
      ...common,
      author: 'GROUP',
      direction: buildIntentDirection(group, creator),
      validatedPairActive: false,
    });
    await this.groupRelationships.writeLockedAuthoredIntentInTx(tx, {
      ...common,
      author: 'MEMBER',
      direction: memberDirection,
    });
    clientFeedUpdates.push(
      ...(await captureThreadStateUpdatesInTx(tx, [creatorUserId])),
    );
  }

  /** Call after the group command lock, before departure messages allocate client state. */
  async lockMemberRelationshipFeedInTx(
    tx: DatabaseTransaction,
    group: { namespaceId: number },
  ): Promise<void> {
    if (group.namespaceId === 0) return;
    await this.stateFeed.lockOutboundStateFeedNamespacesInTx(tx, [
      { namespaceId: group.namespaceId },
    ]);
  }

  async writeMemberRelationshipIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' = 'REQUESTED',
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
    note = '',
    options: GroupRelationshipMutationOptions = {},
  ): Promise<Map<number, bigint>> {
    const {
      publishGroupState = true,
      allowOwnerDeactivation,
      initialRole,
      allowDissolvedPositive = false,
      lockedGroupPair,
      validatedPairActive,
      expectedAuthorization,
      clientRequestStatus,
      clientRequestDirection,
    } = options;
    if (validatedPairActive !== undefined && !lockedGroupPair)
      throw new Error('validated pair fold requires a locked group pair');
    if (
      status !== 'REVOKED' &&
      !allowDissolvedPositive &&
      (await isGroupDissolvedInTx(tx, threadId))
    )
      return new Map<number, bigint>();
    const locked =
      lockedGroupPair ??
      (await this.lockGroupMutationInTx(tx, threadId, memberUserId));
    const [thread] = await tx
      .select({
        groupId: tables.messageThread.id,
        authorizationEpoch: tables.messageThread.authorizationEpoch,
      })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupId) throw new Error('group join target is invalid');
    const group = await readGroupState(
      tx,
      eq(groupStateTable.id, thread.groupId),
    );
    const member = await tx.query.account.findFirst({
      where: eq(tables.account.id, memberUserId),
      columns: { account: true, namespaceId: true },
    });
    if (!group || !member || member.namespaceId !== 0)
      throw new Error('group join identities are invalid');
    if (
      expectedAuthorization &&
      (thread.authorizationEpoch !== expectedAuthorization.epoch ||
        group.account !== expectedAuthorization.group.account ||
        group.namespaceId !== expectedAuthorization.group.namespaceId)
    )
      return new Map<number, bigint>();
    if (!lockedGroupPair) await this.lockMemberRelationshipFeedInTx(tx, group);
    const memberDirection = buildIntentDirection(member, group);
    const membership =
      await this.groupRelationships.writeLockedAuthoredIntentInTx(tx, {
        threadId,
        groupId: thread.groupId,
        memberUserId,
        pairId: 'pairId' in locked ? locked.pairId : locked.id,
        memberLocal: member.namespaceId === 0,
        memberDirection,
        direction: memberDirection,
        threadLock: locked.threadLock,
        author: 'MEMBER',
        hostedLocally: group.namespaceId === 0,
        status,
        snapshot:
          status === 'REQUESTED'
            ? options.snapshot
              ? parseRequestSnapshot(options.snapshot)
              : group.namespaceId === 0
                ? await this.readPresentationSnapshotInTx(tx, {
                    account: group.account,
                    group: true,
                  })
                : null
            : null,
        note,
        expiresAt:
          status === 'REQUESTED'
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            : null,
        ...(initialRole ? { initialRole } : {}),
        ...(allowOwnerDeactivation ? { allowOwnerDeactivation: true } : {}),
        ...(!publishGroupState ? { updateCanonicalRoster: false } : {}),
        ...(validatedPairActive === undefined ? {} : { validatedPairActive }),
      });
    if (
      group.namespaceId !== 0 &&
      status === 'REVOKED' &&
      membership.pairChanged
    ) {
      await writeMirrorLocalGroupLeftInTx(tx, {
        threadId,
        localMemberId: memberUserId,
        memberAccount: member.account,
        authorityNamespaceId: group.namespaceId,
        threadLock: locked.threadLock,
      });
    }
    if (allowDissolvedPositive && group.namespaceId !== 0)
      await tx
        .update(tables.messageThread)
        .set({
          groupDissolvedAt: null,
          federationRoundsEnabled: true,
          updatedAt: new Date(),
        })
        .where(eq(tables.messageThread.id, threadId));
    if (clientFeedUpdates && membership.pairChanged)
      clientFeedUpdates.push(
        ...(await captureThreadStateUpdatesInTx(tx, [memberUserId])),
      );
    if (membership.changed) {
      const effects = await this.writeGroupRequestEffectsInTx(
        tx,
        threadId,
        memberUserId,
        membership.shouldBeActive
          ? 'ACCEPTED'
          : membership.request.status === 'REVOKED'
            ? (clientRequestStatus ?? 'WITHDRAWN')
            : membership.request.status,
        membership.request.status === 'ACCEPTED' ||
          clientRequestDirection === 'INCOMING'
          ? 'INVITATION'
          : 'APPLICATION',
        membership.request.status === 'REQUESTED',
        options.snapshot,
      );
      clientFeedUpdates?.push(...effects.clientUpdates);
    }
    if (group.namespaceId === 0) return new Map();
    const relationship: PeerStateFeedWrite = {
      namespaceId: group.namespaceId!,
      account: member.account,
      subjectAccount: group.account,
      subjectNamespaceId: group.namespaceId!,
      eventType: 'RELATIONSHIP_INTENT',
      body: {
        status: membership.request.status,
        namespaceId: 0,
        profileRev: membership.request.profileRev,
        note: membership.request.note,
        messageEndSeq: membership.request.messageEndSeq,
        tombstoneEndSeq: membership.request.tombstoneEndSeq,
        statusChangedAt: membership.request.statusChangedAt,
        expiresAt: membership.request.expiresAt,
      },
    };
    return relationship.body.status === 'ACCEPTED'
      ? this.stateFeed.writeAcceptanceConfirmationsInTx(tx, [relationship])
      : this.stateFeed.writeManyInTx(tx, [relationship]);
  }

  async writeGroupRelationshipIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: AccountTarget,
    note: string,
    status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED',
    clientFeedUpdates: PendingClientStateFeedUpdate[],
    requestProjectionDirection?: 'APPLICATION' | 'INVITATION',
    options: GroupRelationshipMutationOptions = {},
  ): Promise<Map<number, bigint>> {
    const {
      publishGroupState = true,
      allowOwnerDeactivation,
      initialRole,
      expectedAuthorization,
      clientRequestStatus,
    } = options;
    if (status !== 'REVOKED' && (await isGroupDissolvedInTx(tx, threadId)))
      return new Map<number, bigint>();
    await this.lockGroupMutationInTx(tx, threadId, memberUserId);
    const [state] = await tx
      .select({
        groupId: groupStateTable.id,
        groupAccount: groupStateFields.account,
        groupProfileRev: groupStateFields.profileRev,
        groupNamespaceId: groupStateFields.namespaceId,
        authorizationEpoch: tables.messageThread.authorizationEpoch,
      })
      .from(tables.messageThread)
      .innerJoin(
        groupStateTable,
        eq(groupStateTable.id, tables.messageThread.id),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!state?.groupId) throw new Error('group invite target is invalid');
    if (
      expectedAuthorization &&
      (state.authorizationEpoch !== expectedAuthorization.epoch ||
        state.groupAccount !== expectedAuthorization.group.account ||
        state.groupNamespaceId !== expectedAuthorization.group.namespaceId)
    )
      return new Map<number, bigint>();
    const member = await accountAddressInTx(tx, memberUserId);
    if (member.namespaceId !== 0)
      await this.stateFeed.lockOutboundStateFeedNamespacesInTx(tx, [
        {
          namespaceId: member.namespaceId!,
        },
      ]);
    const membership = await this.groupRelationships.writeAuthoredIntentInTx(
      tx,
      {
        threadId,
        groupId: state.groupId,
        memberUserId,
        author: 'GROUP',
        hostedLocally: true,
        status,
        snapshot:
          status === 'REQUESTED'
            ? options.snapshot
              ? parseRequestSnapshot(options.snapshot)
              : member.namespaceId === 0
                ? await this.readPresentationSnapshotInTx(tx, {
                    account: member.account,
                    group: false,
                  })
                : null
            : null,
        note,
        expiresAt:
          status === 'REQUESTED'
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            : null,
        ...(initialRole ? { initialRole } : {}),
        ...(allowOwnerDeactivation ? { allowOwnerDeactivation: true } : {}),
        ...(!publishGroupState ? { updateCanonicalRoster: false } : {}),
      },
    );
    if (membership.active) {
      if (membership.pairChanged)
        await tx
          .update(tables.messageThread)
          .set({ updatedAt: new Date() })
          .where(eq(tables.messageThread.id, threadId));
    }
    const effects = await this.writeGroupRequestEffectsInTx(
      tx,
      threadId,
      memberUserId,
      membership.request.status === 'REVOKED'
        ? (clientRequestStatus ??
            (requestProjectionDirection === 'APPLICATION'
              ? 'REJECTED'
              : 'WITHDRAWN'))
        : membership.request.status,
      requestProjectionDirection ??
        (membership.request.status === 'ACCEPTED'
          ? 'APPLICATION'
          : 'INVITATION'),
      membership.request.status === 'REQUESTED',
      options.snapshot,
    );
    clientFeedUpdates.push(...effects.clientUpdates);
    if (member.namespaceId === 0) {
      const [localAccount] = await localAccountsForTargetsInTx(tx, [member]);
      if (!localAccount)
        throw new Error('local invitation recipient is missing');
      if (membership.pairChanged)
        clientFeedUpdates.push(
          ...(await captureThreadStateUpdatesInTx(tx, [localAccount.id])),
        );
      return new Map();
    }
    const relationship: PeerStateFeedWrite = {
      namespaceId: member.namespaceId!,
      account: state.groupAccount,
      subjectAccount: member.account,
      subjectNamespaceId: member.namespaceId,
      eventType: 'RELATIONSHIP_INTENT',
      body: {
        status: membership.request.status,
        namespaceId: 0,
        profileRev: membership.request.profileRev,
        note: membership.request.note,
        messageEndSeq: membership.request.messageEndSeq,
        tombstoneEndSeq: membership.request.tombstoneEndSeq,
        statusChangedAt: membership.request.statusChangedAt,
        expiresAt: membership.request.expiresAt,
      },
    };
    return relationship.body.status === 'ACCEPTED'
      ? this.stateFeed.writeAcceptanceConfirmationsInTx(tx, [relationship])
      : this.stateFeed.writeManyInTx(tx, [relationship]);
  }

  async lockGroupMutationInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: AccountTarget,
    projectionUserIds: readonly number[] = [],
    feedAllocatorUserIds: readonly number[] = [],
  ) {
    const [thread] = await tx
      .select({ groupId: tables.messageThread.id })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupId) throw new Error('group relationship thread missing');
    return this.relationshipIntents.lockGroupMutationInTx(tx, {
      threadId,
      groupId: thread.groupId,
      memberUserId,
      projectionUserIds,
      feedAllocatorUserIds,
    });
  }

  /** Open or conclude the permanent request round mirrored by a group intent
   * transition. Evidence is read from the freshly written intent in the same
   * transaction, never fabricated; the round snapshot is captured at open
   * time (command-supplied or derived from the local receiver) because the
   * intent table no longer stores presentations. The manager notification
   * counters in GroupMeta advance only for newly created rounds; conclusions
   * never allocate a new-request head. Returns the in-process wake hints for
   * the recipient's incoming head together with whether a new round was
   * created. */
  async writeGroupRequestEffectsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: AccountTarget,
    status: RequestProjectionStatusValue = 'REQUESTED',
    direction: 'APPLICATION' | 'INVITATION' = 'APPLICATION',
    createIfMissing = true,
    snapshot?: RequestSnapshot | null,
  ): Promise<GroupRequestEffectsResult> {
    const unchanged = { created: false, clientUpdates: [] };
    const [thread] = await tx
      .select({
        groupAccount: tables.messageThread.groupAccount,
        authorityNamespaceId: tables.messageThread.authorityNamespaceId,
      })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupAccount) return unchanged;

    const member = await accountAddressInTx(tx, memberUserId);
    if (!member) return unchanged;

    const isApplication = direction === 'APPLICATION';
    const flow: RequestFlow = {
      kind: isApplication ? 'GROUP_APPLICATION' : 'GROUP_INVITATION',
      author: isApplication
        ? { account: member.account, namespaceId: member.namespaceId }
        : {
            account: thread.groupAccount,
            namespaceId: thread.authorityNamespaceId,
          },
      receiver: isApplication
        ? {
            account: thread.groupAccount,
            namespaceId: thread.authorityNamespaceId,
          }
        : { account: member.account, namespaceId: member.namespaceId },
    };

    const [intent] = await tx
      .select({
        requestId: tables.relationshipIntent.requestId,
        profileNamespaceId: tables.relationshipIntent.profileNamespaceId,
        profileRev: tables.relationshipIntent.profileRev,
        note: tables.relationshipIntent.note,
        statusChangedAt: tables.relationshipIntent.statusChangedAt,
        expiresAt: tables.relationshipIntent.expiresAt,
      })
      .from(tables.relationshipIntent)
      .where(
        and(
          eq(tables.relationshipIntent.authorAccount, flow.author.account),
          eq(
            tables.relationshipIntent.authorNamespaceId,
            flow.author.namespaceId,
          ),
          eq(tables.relationshipIntent.receiverAccount, flow.receiver.account),
          eq(
            tables.relationshipIntent.receiverNamespaceId,
            flow.receiver.namespaceId,
          ),
        ),
      )
      .limit(1);
    if (!intent) return unchanged;

    if (status === 'REQUESTED') {
      if (!intent.statusChangedAt || !intent.expiresAt) return unchanged;
      if (!createIfMissing && !intent.requestId) return unchanged;
      const result = await this.requestCapability.openRequestInTx(tx, {
        flow,
        evidence: {
          authorProfileNamespaceId: intent.profileNamespaceId,
          authorProfileRev: intent.profileRev,
          note: intent.note,
          requestedAt: intent.statusChangedAt,
          expiresAt: intent.expiresAt,
          snapshot: await this.resolveRoundSnapshotInTx(tx, snapshot, flow),
        },
      });
      if (result.status === 'STALE_REQUEST') return unchanged;
      if (result.status !== 'CREATED')
        return {
          created: false,
          clientUpdates: [...result.effects.clientUpdates],
        };
      if (thread.authorityNamespaceId !== 0)
        return {
          created: true,
          clientUpdates: [...result.effects.clientUpdates],
        };
      // The group's per-direction counters number new-round events for the
      // manager watermarks; the row is created lazily for groups that have
      // not fanned group meta yet. Mirrored remote-authority threads carry no
      // local manager watermarks.
      await tx
        .insert(tables.groupMeta)
        .values({
          threadId,
          applicationEndId: isApplication ? 1 : 0,
          invitationEndId: isApplication ? 0 : 1,
        })
        .onConflictDoUpdate({
          target: tables.groupMeta.threadId,
          set: {
            applicationEndId: sql`${tables.groupMeta.applicationEndId} + ${isApplication ? 1 : 0}`,
            invitationEndId: sql`${tables.groupMeta.invitationEndId} + ${isApplication ? 0 : 1}`,
            updatedAt: new Date(),
          },
        });
      return {
        created: true,
        clientUpdates: [...result.effects.clientUpdates],
      };
    }

    const cause =
      status === 'ACCEPTED'
        ? ('ACCEPT' as const)
        : status === 'REJECTED'
          ? ('REJECT' as const)
          : status === 'WITHDRAWN'
            ? ('WITHDRAW' as const)
            : status === 'EXPIRED'
              ? ('EXPIRE' as const)
              : null;
    if (!cause || !intent.requestId) return unchanged;
    await this.requestCapability.concludeRequestInTx(tx, {
      flow,
      requestId: intent.requestId,
      cause,
    });
    return unchanged;
  }

  /** Resolve the round snapshot for a newly opened round. The snapshot is
   * the author-side captured presentation of the receiver and serves only the
   * author's outgoing view, so it is required exactly for namespace-zero
   * authors: remote-author rounds stored on this node are consumed only by
   * incoming views that read the wire author-profile coordinates instead.
   * Locally the value comes from the owning command when the author composed
   * it against a remote receiver, and is derived from the local receiver's
   * current default-profile otherwise. A namespace-zero author without any
   * capturable presentation is a missing-evidence error, never a silent
   * null that would surface at outgoing rendering. */
  private async resolveRoundSnapshotInTx(
    tx: DatabaseTransaction,
    supplied: RequestSnapshot | null | undefined,
    flow: RequestFlow,
  ): Promise<RequestSnapshot | null> {
    if (supplied) return parseRequestSnapshot(supplied);
    if (flow.author.namespaceId !== 0) return null;
    // A namespace-zero author's outgoing view renders this snapshot, so a
    // remote receiver without a command-captured presentation is missing
    // evidence. Local receivers (member or group) derive from their current
    // default profile in this transaction.
    if (flow.receiver.namespaceId !== 0)
      throw new Error(
        `round snapshot is unavailable for ${flow.author.account} -> ${flow.receiver.account}`,
      );
    return this.readPresentationSnapshotInTx(tx, {
      account: flow.receiver.account,
      group: flow.receiver.account.startsWith('!'),
    });
  }

  /** The receiver-side presentation captured when a locally authored request
   * opens without an explicit snapshot: the group's own current profile for
   * applications, the local invitee's current profile for invitations. */
  private async readPresentationSnapshotInTx(
    tx: DatabaseTransaction,
    subject: { account: string; group: boolean },
  ): Promise<RequestSnapshot> {
    const [row] = await tx
      .select({
        displayName: tables.profileTable.displayName,
        avatar: tables.profileTable.avatar,
      })
      .from(subject.group ? tables.groupAccount : tables.account)
      .innerJoin(
        tables.profileTable,
        and(
          eq(
            tables.profileTable.account,
            subject.group
              ? tables.groupAccount.account
              : tables.account.account,
          ),
          eq(tables.profileTable.publisherNamespaceId, 0),
          eq(tables.profileTable.profileNamespaceId, 0),
          eq(
            tables.profileTable.profileRev,
            subject.group
              ? tables.groupAccount.defaultProfileRev
              : tables.account.defaultProfileRev,
          ),
        ),
      )
      .where(
        subject.group
          ? eq(tables.groupAccount.account, subject.account)
          : and(
              eq(tables.account.account, subject.account),
              eq(tables.account.namespaceId, 0),
            ),
      )
      .limit(1);
    if (!row)
      throw new Error(
        `presentation snapshot is unavailable for ${subject.account}`,
      );
    return parseRequestSnapshot({
      displayName: row.displayName,
      avatar: row.avatar === '' ? null : row.avatar,
    });
  }
}
