import {
  forwardRef,
  Injectable,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { normalizeAccount, isValidAccount } from '../common/account.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { ContentType, MessageThreadType } from '../database/enums.js';
import type { Message } from '../message/message.service.js';
import * as tables from '../database/schema.js';
import { and, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { UploadService } from '../upload/upload.service.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import {
  ForwardBundleService,
  type ForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { loadFederationConfig } from './federation.config.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import type { MediaStatus } from '../common/media-status.js';
import { QuotaService } from '../quota/quota.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import {
  InviteService,
  type FederatedPendingProfileSnapshot,
} from '../invite/invite.service.js';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import type { PublicMessage } from '../message/message.service.js';
import { openFederatedAudienceInTx } from './federation-audience.js';
import { type OutboundCallFrameParams } from './federation-call-delivery.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';

export {
  deriveLocalGroupSystemEvents,
  type LocalGroupSystemEvent,
} from './local-group-system-events.js';
export {
  FederationMessageContextError,
  S2sResponseError,
} from './federation-errors.js';

export type {
  S2SCallFrame,
  S2SCallOperation,
} from '../calls/federated-call-protocol.js';
export type { S2SAddress } from './federation-address.js';
export type { FederationThreadResourceResponse } from './federation-thread-resource-client.service.js';
export type { InlineProfileAvatar, S2SProfile } from './federation-profile.js';
export type { S2SQuoteTarget } from './federation-inbound-message-store.service.js';

import {
  type FederationMessageFeedMessage,
  type FederationMessageQueryPage,
  type FederationThreadAddress,
} from './federation-message-feed.service.js';
import { type FederationMessageTombstoneQueryPage } from './federation-message-tombstone-feed.service.js';
import {
  PeerStateFeedService,
  type PeerStateFeedPage,
} from './peer-state-feed.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { RelationshipIntentService } from '../invite/relationship-intent.service.js';
import { FederationGroupRelationshipService } from './federation-group-relationship.service.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import { SystemMessageType } from '../message/system-message.js';
import { assertServerGroupCapacityInTx } from '../group/group-capacity.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-thread-round.events.js';
import { FederationProfileStatePublisher } from './federation-profile-state-publisher.service.js';
import { FederationRelationshipCommandService } from './federation-relationship-command.service.js';
import {
  FederationNamespaceService,
  type FederationContext,
} from './federation-namespace.service.js';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import type { S2SAddress } from './federation-address.js';
import { FederationUserDirectoryService } from './federation-user-directory.service.js';
import { FederationCallBridgeService } from './federation-call-bridge.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import {
  FederationThreadResourceClient,
  type FederationThreadResourceResponse,
} from './federation-thread-resource-client.service.js';
import { FederationProfileService } from './federation-profile.service.js';
import type { S2SProfile } from './federation-profile.js';
import { FederationMediaLocalizationService } from './federation-media-localization.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';
import {
  FederationInboundMessagePageService,
  type FederationMessagePageApplyOptions as MessageQueryApplyOptions,
  type FederationMessagePageEffect as MissedPageEffect,
} from './federation-inbound-message-page.service.js';
import { FederationLocalSystemMessagePublisher } from './federation-local-system-message-publisher.service.js';
import { FederationStatePullService } from './federation-state-pull.service.js';
import { FederationPeerResourceService } from './federation-peer-resource.service.js';
import { FederationInboundMessageCommitService } from './federation-inbound-message-commit.service.js';
import { FederationOutboundMessageSignalService } from './federation-outbound-message-signal.service.js';
import { FederationThreadQueryDenialService } from './federation-thread-query-denial.service.js';

/** Preserve the relationship author's side in the client-feed compaction key. */
export function clientGroupIntentEndpoints(
  groupAccount: string,
  memberAccount: string,
  author: 'GROUP' | 'MEMBER',
): { account: string; subjectAccount: string } {
  return author === 'GROUP'
    ? { account: groupAccount, subjectAccount: memberAccount }
    : { account: memberAccount, subjectAccount: groupAccount };
}

export type PeerResponseToken = FederationContext;

/**
 * Outbound S2S: SYNCHRONOUS inline delivery. Each send* method builds a payload, signs it
 * (SignatureService), and POSTs it to the peer's friend-op endpoint (DiscoveryService resolves the
 * base URL), all inline within the caller's request. No outbox/worker — Step 1 friend-flow is low-volume
 * and the friendship ops are idempotent, so a peer that's momentarily down just fails the action and the
 * user retries (the compacted state key plus feed ordering makes retries safe). Step 2 messages do NOT
 * add an outbox either — they use coalesced-notify + active pull.
 *
 * Transaction note: the DB state change (e.g. Friendship PENDING) commits in its own tx BEFORE the
 * send — an HTTP POST can't live inside a DB tx. If the POST fails, local state is committed but the
 * peer isn't notified; the user retries and the idempotent re-send succeeds once the peer is back.
 * That temporary, self-healing inconsistency is the cost of sync; acceptable for Step 1's idempotent
 * friend ops.
 *
 * Identity model: local users have domain="local"; federated peers are foreign User stubs
 * (domain=<peer>, unusable random hashPwd). Federation addresses always
 * use the REAL config.domain for local users' wire addresses ({ account: <account>, domain: <config.domain> }), never "local".
 *
 * Avatar localization: foreign stubs carry the peer's avatar/name/bio/remoteUpdatedAt, localized from
 * the profile embedded in the friend-request payload (and refreshed via fetchRemoteUser on
 * approve + the chat-open staleness probe). Deletion is LOCAL-ONLY — unfriending never fans out an S2S
 * notification; the peer discovers the severed edge lazily, via a rejection-on-send in Step 2.
 */
@Injectable()
export class FederationService {
  private readonly config = loadFederationConfig();
  private readonly logger = new Logger(FederationService.name);
  /** Receiver-side debounce window: a group thread pulled within this skips a redundant whole-thread GET. */
  private static readonly GROUP_PULL_DEBOUNCE_MS = 500;
  /** Per-group-thread last pull timestamp (the receiver debounce on pullGroupWhole). */
  private readonly recentGroupPulls = new Map<number, number>();
  constructor(
    private readonly database: DatabaseService,
    private readonly peerLifecycle: FederationPeerLifecycle,
    private readonly mediaRangeClient: FederationMediaRangeClient,
    private readonly inboundMediaBatches: FederationInboundMediaBatchService,
    private readonly users: FederationUserDirectoryService,
    private readonly callBridge: FederationCallBridgeService,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly threadResources: FederationThreadResourceClient,
    private readonly profiles: FederationProfileService,
    private readonly mediaLocalization: FederationMediaLocalizationService,
    private readonly inboundMessageRoutes: FederationInboundMessageRouteService,
    private readonly inboundMessageValidator: FederationInboundMessageValidatorService,
    private readonly inboundMessagePages: FederationInboundMessagePageService,
    private readonly statePull: FederationStatePullService,
    private readonly localSystemMessages: FederationLocalSystemMessagePublisher,
    private readonly peerResources: FederationPeerResourceService,
    private readonly inboundMessageCommits: FederationInboundMessageCommitService,
    private readonly outboundMessageSignals: FederationOutboundMessageSignalService,
    private readonly threadQueryDenials: FederationThreadQueryDenialService,
    private readonly upload: UploadService,
    private readonly participantService: ThreadParticipantService,
    @Inject(forwardRef(() => InviteService))
    private readonly invite: InviteService,
    private readonly quota: QuotaService,
    private readonly linkPreview: LinkPreviewService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly eventEmitter: EventEmitter2,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupRelationships: FederationGroupRelationshipService,
    private readonly profileStatePublisher: FederationProfileStatePublisher,
    private readonly relationshipCommands: FederationRelationshipCommandService,
    private readonly namespaces: FederationNamespaceService,
    private readonly stateFeedConsumer: FederationStateFeedConsumerService,
  ) {}

  /** The wire address of a LOCAL user: { account, domain } (domain = our real config.domain). */
  localAddress(account: string): S2SAddress {
    return { account: account, domain: this.config.domain };
  }

  /** This server's domain (config.domain) — for address-domain comparison in controllers. */
  get ourDomain(): string {
    return this.config.domain;
  }

  // ─── durable discovery wake-up routing ─────────────────────────────────────

  async notifyOnSend(
    author: S2SAddress,
    threadId: number,
    originSeq: number,
  ): Promise<void> {
    await this.outboundMessageSignals.signalMessage(
      threadId,
      author,
      originSeq,
    );
  }

  async notifyGroupLeave(
    threadId: number,
    leaverUserId: number,
  ): Promise<void> {
    void leaverUserId;
    await this.outboundMessageSignals.notifyGroupLeave(threadId);
  }

  async signalOutbound(
    threadId: number,
    authorAddress: S2SAddress,
    latestSeq: number,
    fetchedFromDomain: string | undefined,
  ): Promise<void> {
    await this.outboundMessageSignals.signalMessage(
      threadId,
      authorAddress,
      latestSeq,
      fetchedFromDomain,
    );
  }

  async signalDeletionOutbound(
    threadId: number,
    messageSeq: number,
  ): Promise<void> {
    void messageSeq;
    await this.outboundMessageSignals.signalDeletion(threadId);
  }

  /** Find a LOCAL user id by account (domain="local"). Null if not found / not local / soft-deleted.
   *  The isDeleted gate matters here because S2S bypasses the token system: the local /uploads/* path is
   *  protected from admin-disabled users by session-token revocation (invalidateAllSessions revokes every
   *  SessionToken row on disable), but
   *  /media/:digest never touches client tokens — so a disabled user's media would still flow out over federation
   *  unless we reject the soft-deleted row here. */
  async findLocalUserId(account: string): Promise<number | null> {
    return this.users.findLocalUserId(account);
  }

  /** Look up a local user id from a full address (must be account@<our domain>). */
  async findLocalUserIdByAddress(address: S2SAddress): Promise<number | null> {
    return this.users.findLocalUserIdByAddress(address);
  }

  /** Transactional PROFILE writer used by profile mutations. The caller sends wake-ups only after commit. */
  async writeProfileStateInTx(
    tx: DatabaseTransaction,
    userId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    return this.profileStatePublisher.writeProfileStateInTx(
      tx,
      userId,
      clientFeedUpdates,
    );
  }

  /** Remove origin-owned group disclosure after the peer's last active member disappears. */
  private async cleanupGroupProjectionInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupId: number,
    groupAccount: string,
    peerDomain: string,
    namespaceId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    return this.profileStatePublisher.cleanupGroupProjectionInTx(
      tx,
      threadId,
      groupId,
      groupAccount,
      peerDomain,
      namespaceId,
      clientFeedUpdates,
    );
  }

  /** Accept an incoming Address-based request. This is the first point where this server consents to
   * the relationship, so the verified PROFILE projection is promoted into User and the existing
   * id-based friendship state machine can take over. */
  async acceptAddressedFriendRequest(
    localUserId: number,
    remote: { account: string; domain: string },
  ): Promise<Map<string, bigint>> {
    const remoteAccount = normalizeAccount(remote.account);
    const remoteDomain = remote.domain.trim().toLowerCase();
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const context = await this.namespaces.captureActiveInTx(tx, remoteDomain);
      const request = await tx.query.federatedFriendRequest.findFirst({
        where: and(
          eq(tables.federatedFriendRequest.localUserId, localUserId),
          eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
          eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
          eq(tables.federatedFriendRequest.namespaceId, context.namespaceId),
          eq(tables.federatedFriendRequest.direction, 'INCOMING'),
        ),
      });
      if (!request)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request not found',
        );
      if (
        request.localUserId !== localUserId ||
        request.direction !== 'INCOMING'
      )
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'request is not yours',
        );
      if (
        request.status !== 'REQUESTED' ||
        request.expiresAt === null ||
        request.expiresAt <= new Date()
      )
        throw new BusinessException(
          BusinessCode.INVITE_EXPIRED,
          'request expired',
        );
      if (remoteAccount.startsWith('!')) {
        const shell =
          await this.stateFeedConsumer.ensureFederatedGroupRequestShellInTx(
            tx,
            request.remoteAccount,
            request.remoteDomain,
            request.namespaceId,
          );
        await this.relationshipIntents.applyRemoteGroupIntentInTx(tx, {
          groupId: shell.groupId,
          memberUserId: localUserId,
          threadId: shell.threadId,
          author: 'GROUP',
          status: 'REQUESTED',
          note: request.note,
          requestedAt: request.requestedAt,
          expiresAt: request.expiresAt,
        });
        const state =
          await this.relationshipCommands.writeMemberRelationshipIntentInTx(
            tx,
            shell.threadId,
            localUserId,
            'ACCEPTED',
            clientFeedUpdates,
          );
        await tx
          .insert(tables.threadAudience)
          .values({
            targetDomain: 'local',
            localUserId,
            threadId: shell.threadId,
          })
          .onConflictDoNothing();
        await tx
          .delete(tables.federatedFriendRequest)
          .where(
            and(
              eq(tables.federatedFriendRequest.localUserId, localUserId),
              eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
              eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
              eq(
                tables.federatedFriendRequest.namespaceId,
                request.namespaceId,
              ),
              eq(tables.federatedFriendRequest.direction, 'INCOMING'),
            ),
          );
        return { peers: state, friendAddedThreadId: undefined };
      }
      const remoteUserId =
        await this.stateFeedConsumer.materializeFederatedUserInTx(
          tx,
          request.remoteAccount,
          request.remoteDomain,
          request.namespaceId,
        );
      await this.relationshipIntents.applyRemoteP2PIntentInTx(tx, {
        authorUserId: remoteUserId,
        subjectUserId: localUserId,
        threadId: null,
        status: 'REQUESTED',
        note: request.note,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt,
      });
      const pair = await this.relationshipIntents.lockPairInTx(
        tx,
        localUserId,
        remoteUserId,
      );
      const pairBefore = await tx.query.relationshipPair.findFirst({
        where: eq(tables.relationshipPair.id, pair.id),
        columns: { active: true },
      });
      const state = await this.relationshipCommands.writeFriendIntentInTx(
        tx,
        localUserId,
        remoteUserId,
        true,
        '',
        clientFeedUpdates,
        true,
      );
      await tx
        .delete(tables.federatedFriendRequest)
        .where(
          and(
            eq(tables.federatedFriendRequest.localUserId, localUserId),
            eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
            eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
            eq(tables.federatedFriendRequest.namespaceId, request.namespaceId),
            eq(tables.federatedFriendRequest.direction, 'INCOMING'),
          ),
        );
      const pairAfter = await tx.query.relationshipPair.findFirst({
        where: eq(tables.relationshipPair.id, pair.id),
        columns: { active: true, threadId: true },
      });
      return {
        peers: state,
        friendAddedThreadId:
          pairBefore?.active !== true && pairAfter?.active === true
            ? (pairAfter.threadId ?? undefined)
            : undefined,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    if (result.friendAddedThreadId !== undefined)
      await this.publishLocalSystemMessage({
        actorUserId: localUserId,
        threadId: result.friendAddedThreadId,
        type: SystemMessageType.FRIEND_ADDED,
        recipientUserIds: [localUserId],
      });
    return result.peers;
  }

  /** Start a member-authored join request for a group hosted by a federated peer. */
  async requestFederatedGroupJoin(
    memberUserId: number,
    address: S2SAddress,
    note: string,
    snapshot: FederatedPendingProfileSnapshot,
    beforeWrite?: (tx: DatabaseTransaction) => Promise<void>,
  ): Promise<void> {
    if (!address.account.startsWith('!'))
      throw new BusinessException(
        BusinessCode.FRIEND_INVALID_TARGET,
        'target is not a group',
      );
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const state = await this.database.db.transaction(async (tx) => {
      const context = await this.namespaces.captureActiveInTx(
        tx,
        address.domain,
      );
      const shell =
        await this.stateFeedConsumer.ensureFederatedGroupRequestShellInTx(
          tx,
          address.account,
          address.domain,
          context.namespaceId,
        );
      if (beforeWrite) await beforeWrite(tx);
      return this.relationshipCommands.writeMemberRelationshipIntentInTx(
        tx,
        shell.threadId,
        memberUserId,
        'REQUESTED',
        clientFeedUpdates,
        note,
        snapshot,
      );
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    await this.pushStateFeedDomains(state.keys());
  }

  async resolveGroupJoinRequestCommandScope(
    memberUserId: number,
    address: S2SAddress,
  ): Promise<{ account: string; domain: string }> {
    const account = normalizeAccount(address.account);
    const domain = address.domain.trim().toLowerCase();
    const storedDomain = domain === this.config.domain ? 'local' : domain;
    await this.database.db.transaction(async (tx) => {
      const namespaceId =
        storedDomain === 'local'
          ? 0
          : (await this.namespaces.captureActiveInTx(tx, domain)).namespaceId;
      const groupState = await tx.query.group.findFirst({
        where: and(
          eq(tables.group.account, account),
          eq(tables.group.domain, storedDomain),
          eq(tables.group.namespaceId, namespaceId),
        ),
        columns: { id: true },
      });
      const thread = groupState
        ? await tx.query.messageThread.findFirst({
            where: eq(tables.messageThread.groupId, groupState.id),
            columns: { id: true },
          })
        : undefined;
      if (
        !groupState ||
        !thread ||
        !(await this.relationshipIntents.hasValidGroupInviteInTx(tx, {
          groupId: groupState.id,
          memberUserId,
          threadId: thread.id,
          author: 'MEMBER',
        }))
      ) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      }
    });
    return { account, domain };
  }

  async revokeGroupJoinRequest(
    memberUserId: number,
    address: S2SAddress,
  ): Promise<void> {
    const account = normalizeAccount(address.account);
    const domain = address.domain.trim().toLowerCase();
    const storedDomain = domain === this.config.domain ? 'local' : domain;
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const state = await this.database.db.transaction(async (tx) => {
      const namespaceId =
        storedDomain === 'local'
          ? 0
          : (await this.namespaces.captureActiveInTx(tx, domain)).namespaceId;
      const groupState = await tx.query.group.findFirst({
        where: and(
          eq(tables.group.account, account),
          eq(tables.group.domain, storedDomain),
          eq(tables.group.namespaceId, namespaceId),
        ),
        columns: {
          id: true,
          account: true,
          name: true,
          avatar: true,
          description: true,
          profileRev: true,
          namespaceId: true,
        },
      });
      if (!groupState)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      const thread = await tx.query.messageThread.findFirst({
        where: eq(tables.messageThread.groupId, groupState.id),
        columns: { id: true },
      });
      const member = await tx.query.user.findFirst({
        where: eq(tables.user.id, memberUserId),
        columns: { account: true },
      });
      if (!thread || !member)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      const allocated =
        await this.relationshipCommands.writeMemberRelationshipIntentInTx(
          tx,
          thread.id,
          memberUserId,
          'REVOKED',
          clientFeedUpdates,
        );
      const endpoints = clientGroupIntentEndpoints(
        account,
        member.account,
        'MEMBER',
      );
      const feedId = await this.clientStateFeed.writeInTx(tx, {
        userId: memberUserId,
        namespaceId: groupState.namespaceId,
        account: endpoints.account,
        domain: 'local',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: endpoints.subjectAccount,
        subjectDomain: domain,
        body: {
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
          direction: 'OUTGOING',
          threadId: thread.id,
          group: {
            account,
            domain,
            isLocal: storedDomain === 'local',
            name: groupState.name,
            avatar: groupState.avatar,
            description: groupState.description,
            profileRev: groupState.profileRev,
          },
        },
      });
      if (feedId !== null)
        clientFeedUpdates.push({ userId: memberUserId, feedId });
      return allocated;
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    await this.pushStateFeedDomains(state.keys());
  }

  /** Revoke the caller's outgoing pre-stub request. Incoming requests have no rejection transition;
   * clients may ignore or locally discard their presentation. */
  async revokeAddressedOutgoingRequest(
    localUserId: number,
    remote: { account: string; domain: string },
  ): Promise<Map<string, bigint>> {
    const remoteAccount = normalizeAccount(remote.account);
    const remoteDomain = remote.domain.trim().toLowerCase();
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const context = await this.namespaces.captureActiveInTx(tx, remoteDomain);
      const request = await tx.query.federatedFriendRequest.findFirst({
        where: and(
          eq(tables.federatedFriendRequest.localUserId, localUserId),
          eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
          eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
          eq(tables.federatedFriendRequest.namespaceId, context.namespaceId),
          eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
        ),
      });
      if (!request)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request not found',
        );
      if (
        request.localUserId !== localUserId ||
        request.direction !== 'OUTGOING'
      )
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'request is not yours',
        );
      if (request.status !== 'REQUESTED')
        throw new BusinessException(
          BusinessCode.INVITE_ALREADY_HANDLED,
          'request already handled',
        );
      await tx
        .update(tables.federatedFriendRequest)
        .set({
          status: 'REVOKED',
          requestedAt: null,
          expiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tables.federatedFriendRequest.localUserId, localUserId),
            eq(tables.federatedFriendRequest.remoteAccount, remoteAccount),
            eq(tables.federatedFriendRequest.remoteDomain, remoteDomain),
            eq(tables.federatedFriendRequest.namespaceId, request.namespaceId),
            eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
          ),
        );
      const local = await tx.query.user.findFirst({
        where: and(
          eq(tables.user.id, localUserId),
          eq(tables.user.domain, 'local'),
          eq(tables.user.namespaceId, 0),
        ),
        columns: {
          id: true,
          account: true,
          name: true,
          avatar: true,
          domain: true,
        },
      });
      if (!local) throw new Error('local friend requester disappeared');
      const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
        userId: localUserId,
        namespaceId: request.namespaceId,
        account: local.account,
        domain: this.config.domain,
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: request.remoteAccount,
        subjectDomain: request.remoteDomain,
        body: {
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
          direction: 'OUTGOING',
          localThreadId: null,
          peer: {
            id: 0,
            account: request.remoteAccount,
            name: request.displayName ?? request.remoteAccount,
            avatar: request.avatar ?? '',
            domain: request.remoteDomain,
          },
        },
      });
      if (clientFeedId !== null)
        clientFeedUpdates.push({ userId: localUserId, feedId: clientFeedId });
      const state = await this.stateFeed.writeManyInTx(tx, [
        {
          peerDomain: request.remoteDomain,
          namespaceId: request.namespaceId,
          account: local.account,
          domain: this.config.domain,
          subjectAccount: request.remoteAccount,
          subjectDomain: request.remoteDomain,
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'REVOKED',
            note: '',
            requestedAt: null,
            expiresAt: null,
          },
        },
      ]);
      return state;
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    return result;
  }

  /** User-facing acceptance of a stored GROUP→USER request. Acceptance makes the local conversation
   * formal immediately; authoritative GROUP_META later fills and reconciles the complete roster. */
  async resolveAcceptGroupRequestCommandScope(
    threadId: number,
    memberUserId: number,
  ): Promise<{ account: string; domain: string }> {
    return this.database.db.transaction(async (tx) => {
      const [thread] = await tx
        .select({
          groupId: tables.messageThread.groupId,
          account: tables.group.account,
          domain: tables.group.domain,
          dissolvedAt: tables.group.dissolvedAt,
        })
        .from(tables.messageThread)
        .innerJoin(
          tables.group,
          eq(tables.group.id, tables.messageThread.groupId),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      if (!thread?.groupId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      }
      if (thread.dissolvedAt !== null) {
        throw new BusinessException(
          BusinessCode.GROUP_DISSOLVED,
          'group dissolved',
        );
      }
      const invited = await this.relationshipIntents.hasValidGroupInviteInTx(
        tx,
        {
          groupId: thread.groupId,
          memberUserId,
          threadId,
          author: 'GROUP',
        },
      );
      if (!invited) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      }
      return { account: thread.account, domain: thread.domain };
    });
  }

  async acceptGroupRequest(
    threadId: number,
    memberUserId: number,
  ): Promise<void> {
    const result = await this.database.db.transaction(async (tx) => {
      const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
      const [thread] = await tx
        .select({
          groupId: tables.messageThread.groupId,
          groupDomain: tables.group.domain,
          dissolvedAt: tables.group.dissolvedAt,
        })
        .from(tables.messageThread)
        .innerJoin(
          tables.group,
          eq(tables.group.id, tables.messageThread.groupId),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      if (!thread?.groupId)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      if (thread.dissolvedAt !== null)
        throw new BusinessException(
          BusinessCode.GROUP_DISSOLVED,
          'group dissolved',
        );
      if (
        !(await this.relationshipIntents.hasValidGroupInviteInTx(tx, {
          groupId: thread.groupId,
          memberUserId,
          threadId,
          author: 'GROUP',
        }))
      )
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group request not found',
        );
      const existing = await tx.query.threadMember.findFirst({
        where: and(
          eq(tables.threadMember.threadId, threadId),
          eq(tables.threadMember.userId, memberUserId),
          eq(tables.threadMember.left, false),
        ),
        columns: { id: true },
      });
      const alreadyVisible =
        existing != null &&
        (await isThreadMutuallyAuthorized(tx, memberUserId, threadId));
      if (thread.groupDomain === 'local')
        await assertServerGroupCapacityInTx(tx, threadId, memberUserId);
      const allocated =
        await this.relationshipCommands.writeMemberRelationshipIntentInTx(
          tx,
          threadId,
          memberUserId,
          'ACCEPTED',
          clientFeedUpdates,
        );
      await tx
        .insert(tables.threadAudience)
        .values({
          targetDomain: 'local',
          localUserId: memberUserId,
          threadId,
        })
        .onConflictDoNothing();
      if (thread.groupDomain !== 'local')
        await openFederatedAudienceInTx(tx, thread.groupDomain, threadId);
      return {
        allocated,
        clientFeedUpdates,
        shouldWriteStatus: !alreadyVisible,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(result.clientFeedUpdates);
    if (result.shouldWriteStatus)
      await this.publishLocalSystemMessage({
        actorUserId: memberUserId,
        threadId,
        type: SystemMessageType.GROUP_JOINED,
        subjectUserId: memberUserId,
      });
    await this.pushStateFeedDomains(result.allocated.keys());
  }

  async pushStateFeedDomains(domains: Iterable<string>): Promise<void> {
    for (const peerDomain of new Set(domains))
      this.eventEmitter.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
  }

  async handleThreadQueryForbidden(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    expectedAuthorizationEpoch: number,
  ) {
    return this.threadQueryDenials.handleThreadQueryForbidden(
      threadId,
      peerDomain,
      namespaceId,
      expectedAuthorizationEpoch,
    );
  }

  /** Materialize expired directions authored by this server as durable revocations. The expiry
   * boundary itself remains authoritative; this sweep only makes the already-effective negative
   * state explicit so clients and peers converge without retaining stale REQUESTED snapshots. */
  async revokeExpiredLocalRequests(): Promise<number> {
    const pendingClientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const expired = await tx.execute<{
        pairId: bigint;
        authorSide: 'A' | 'B';
        kind: 'P2P' | 'GROUP_MEMBER';
        authorAccount: string;
        authorDomain: string;
        authorNamespaceId: number;
        subjectAccount: string;
        subjectDomain: string;
        subjectNamespaceId: number;
        threadId: number | null;
      }>(sql`
        SELECT intent."pairId", intent."authorSide", pair.kind, pair."threadId",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointAAccount"
            ELSE pair."endpointBAccount" END AS "authorAccount",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointADomain"
            ELSE pair."endpointBDomain" END AS "authorDomain",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointANamespaceId"
            ELSE pair."endpointBNamespaceId" END AS "authorNamespaceId",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointBAccount"
            ELSE pair."endpointAAccount" END AS "subjectAccount",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointBDomain"
            ELSE pair."endpointADomain" END AS "subjectDomain",
          CASE WHEN intent."authorSide" = 'A' THEN pair."endpointBNamespaceId"
            ELSE pair."endpointANamespaceId" END AS "subjectNamespaceId"
        FROM "RelationshipIntent" intent
        JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
        WHERE (CASE WHEN intent."authorSide" = 'A'
            THEN pair."endpointADomain" ELSE pair."endpointBDomain" END) = 'local'
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" <= CURRENT_TIMESTAMP
        ORDER BY intent."expiresAt", intent."pairId", intent."authorSide"
      `);
      const allocated = new Map<string, bigint>();
      let count = 0;
      for (const request of expired.rows) {
        await tx.execute(sql`
          SELECT id FROM "RelationshipPair" WHERE id = ${request.pairId}
          FOR UPDATE
        `);
        const updated = await tx.execute(sql`
          UPDATE "RelationshipIntent"
          SET status = 'REVOKED', note = '', "requestedAt" = NULL,
            "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "pairId" = ${request.pairId}
            AND "authorSide" = ${request.authorSide}
            AND status = 'REQUESTED' AND "expiresAt" <= CURRENT_TIMESTAMP
          RETURNING 1
        `);
        if ((updated.rowCount ?? 0) === 0) continue;
        count += 1;
        if (request.kind === 'GROUP_MEMBER' && request.threadId !== null) {
          const [groupState, member] = await Promise.all([
            tx.query.group.findFirst({
              where: and(
                eq(
                  tables.group.account,
                  request.authorSide === 'A'
                    ? request.authorAccount
                    : request.subjectAccount,
                ),
                eq(
                  tables.group.domain,
                  request.authorSide === 'A'
                    ? request.authorDomain
                    : request.subjectDomain,
                ),
              ),
              columns: { id: true, domain: true },
            }),
            tx.query.user.findFirst({
              where: and(
                eq(
                  tables.user.account,
                  request.authorSide === 'B'
                    ? request.authorAccount
                    : request.subjectAccount,
                ),
                eq(
                  tables.user.domain,
                  request.authorSide === 'B'
                    ? request.authorDomain
                    : request.subjectDomain,
                ),
                eq(
                  tables.user.sourceDomain,
                  request.authorSide === 'B'
                    ? request.authorDomain
                    : request.subjectDomain,
                ),
              ),
              columns: { id: true },
            }),
          ]);
          if (!groupState || !member)
            throw new Error('expired group relationship endpoint missing');
          await this.groupRelationships.syncActiveInTx(tx, {
            threadId: request.threadId,
            groupId: groupState.id,
            memberUserId: member.id,
            active: false,
            hostedLocally: groupState.domain === 'local',
          });
          if (groupState.domain === 'local')
            await this.relationshipCommands.writeGroupRequestEffectsInTx(
              tx,
              request.threadId,
              groupState.id,
              member.id,
              pendingClientFeedUpdates,
              'REVOKED',
              request.authorSide === 'A' ? 'INVITATION' : 'APPLICATION',
              false,
            );
          if (request.authorSide === 'B' || request.subjectDomain === 'local')
            await this.invite.writeGroupRequestClientStateInTx(
              tx,
              request.threadId,
              member.id,
              pendingClientFeedUpdates,
            );
        } else if (request.kind === 'P2P') {
          const [author, subject] = await Promise.all([
            this.ensureForeignUserInTransaction(
              tx,
              request.authorAccount,
              request.authorDomain,
              request.authorNamespaceId,
            ),
            this.ensureForeignUserInTransaction(
              tx,
              request.subjectAccount,
              request.subjectDomain,
              request.subjectNamespaceId,
            ),
          ]);
          await this.relationshipIntents.setPairActiveInTx(
            tx,
            author,
            subject,
            false,
          );
          pendingClientFeedUpdates.push(
            ...(await this.invite.writeFriendRequestClientStateInTx(
              tx,
              author,
              subject,
            )),
          );
        }
        if (request.subjectDomain === 'local') continue;
        const revisions = await this.stateFeed.writeManyInTx(tx, [
          {
            peerDomain: request.subjectDomain,
            namespaceId: request.subjectNamespaceId!,
            account: request.authorAccount,
            domain: this.config.domain,
            subjectAccount: request.subjectAccount,
            subjectDomain: request.subjectDomain,
            eventType: 'RELATIONSHIP_INTENT',
            body: {
              status: 'REVOKED',
              note: '',
              requestedAt: null,
              expiresAt: null,
            },
          },
        ]);
        for (const [domain, revision] of revisions)
          allocated.set(domain, revision);
      }
      return { count, allocated };
    });
    this.clientStateFeed.notifyFeedUpdates(pendingClientFeedUpdates);
    await this.pushStateFeedDomains(result.allocated.keys());
    return result.count;
  }

  /** Transactional authoritative GROUP_META + group PROFILE snapshot writer. */
  async writeGroupStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    return this.profileStatePublisher.writeGroupStateInTx(
      tx,
      threadId,
      clientFeedUpdates,
    );
  }

  /** Public profile of a local user (GET /s2s/v1/users/:account). Null if not local / not found. */
  async getLocalUserProfile(address: S2SAddress): Promise<S2SProfile | null> {
    return this.profiles.getLocalUserProfile(address);
  }

  /** Find or create a foreign User stub for account@<peer-domain>. Stubs never authenticate. */
  async ensureForeignUser(
    account: string,
    domain: string,
    namespaceId: number,
  ): Promise<number> {
    return this.users.ensureForeignUser(account, domain, namespaceId);
  }

  private async ensureForeignUserInTransaction(
    tx: DatabaseTransaction,
    account: string,
    domain: string,
    namespaceId: number,
  ): Promise<number> {
    return this.users.ensureForeignUserInTransaction(
      tx,
      account,
      domain,
      namespaceId,
    );
  }

  /**
   * Resolve-on-demand safety net for send-friend-request: ensure a foreign stub has been localized
   * (profile pulled) at least once. No-op if already localized (remoteUpdatedAt set). If the caller
   * addresses a foreign user by id without a prior resolve (so the stub is a bare account), pull the
   * profile now. Throws on peer failure so the controller surfaces FEDERATION_DELIVERY_FAILED (the
   * subsequent send would fail against the same peer anyway).
   */
  async ensureForeignUserLocalized(
    userId: number,
    address: S2SAddress,
  ): Promise<void> {
    await this.profiles.ensureForeignUserLocalized(userId, address);
  }

  // ─── bidirectional server recognition ─────────────────────────────────────────

  /**
   * Establish or recover the two directional recognition facts before ordinary data-plane traffic.
   */
  async ensurePeerTrusted(domain: string): Promise<void> {
    await this.peerLifecycle.ensureTrusted(domain);
  }

  /**
   * Recover one reconnect-sweep candidate without confusing availability with identity bootstrap.
   * Retry missing Recognize facts or a degraded transport without replacing the pinned root.
   */
  async recoverPeerTrust(domain: string): Promise<void> {
    await this.peerLifecycle.recoverTrust(domain);
  }

  /** Whether mutual recognition with a peer domain is already available — a pure local lookup with no
   *  network or side effects. Our own domain always reads available because it is a local lookup.
   *
   *  Used by the user-facing pre-flight (POST /user/peer-trust-status) so the client can tell
   *  FIRST-CONTACT — a handshake IS expected during the upcoming resolve, so show a "Connecting to
   *  <domain>…" affordance — from an already-trusted resolve (fast, no banner). This is a known
   *  server-side fact, NOT a latency guess: the rare already-trusted-but-failing case (the peer reset
   *  its server and lost the prior handshake) is rejected by identity verification inside the resolve
   *  and surfaces as an error there, not here. */
  async isPeerTrusted(domain: string): Promise<boolean> {
    return this.peerLifecycle.isTrusted(domain);
  }

  // ─── trust lifecycle (state machine + audit log) ──────────────────────────────
  //
  // FederatedPeer holds the CURRENT state (the cheap read path); FederatedPeerEvent is the append-only
  // log of every transition (the admin timeline). FederationPeerLifecycle is the single owner: every
  // transition — recognition convergence, transport health and admin actions — flows through these
  // methods, so the row + the event stay consistent. Recognition facts remain authoritative when a
  // transport failure temporarily moves a healthy peer to degraded.

  /** Best-practice liveness watermark window. "Last successful contact" is an admin observability
   *  signal whose consumer needs MINUTE granularity (is this peer up?), not sub-second — so write
   *  frequency is matched to that real precision need (see markContactSuccess). The window is the
   *  precision knob: lower it if a consumer genuinely needs finer. */
  /** Advance the per-op liveness watermark (lastSuccessAt) on a successful signed S2S op. Throttled to
   *  ≤1 round trip + ≤1 write per domain per LAST_SUCCESS_WINDOW_MS — two layers keep it cheap AND
   *  correct: (1) an in-memory per-domain guard skips the round trip entirely within the window; (2) a
   *  conditional UPDATE (`WHERE lastSuccessAt IS NULL OR older-than-window`) is correct across restart
   *  and multiple instances (a no-op zero-row probe within the window). Precision is deliberately
   *  ±window — a liveness watermark needs minute, not sub-second, granularity. No event (events are
   *  for state transitions only, keeping the log low-volume). Best-effort: a write failure is swallowed
   *  so a DB hiccup can never break the caller's real S2S op.
   *
   *  Observability-only: NO state machine consumes lastSuccessAt. Degradation is failure-driven (the
   *  matched markTransportDegraded on a failed op), NOT staleness-driven; the reconnect sweep + slowPoll select
   *  targets by trustLevel, never by this watermark. So this write is benign bookkeeping — the explicit
   *  identity continuity and normal signed data requests provide liveness; advancing here is the
   *  higher-fidelity supplement that records every real successful contact. */
  async markContactSuccess(domain: string): Promise<void> {
    await this.peerLifecycle.markContactSuccess(domain);
  }

  /** Compatibility wrapper for callers that observed a successful signed round trip. */
  async markRecovered(domain: string): Promise<void> {
    await this.peerLifecycle.markRecovered(domain);
  }

  /** Admin block: forbid federation with a peer; recognition and ordinary inbound traffic both reject
   *  this durable policy state. Idempotent. Logs a `blocked` event. */
  async markBlocked(domain: string, note?: string): Promise<void> {
    await this.peerLifecycle.markBlocked(domain, note);
  }

  /** Admin unblock reopens recognition without fabricating either directional confirmation. */
  async markUnblocked(domain: string): Promise<void> {
    await this.peerLifecycle.markUnblocked(domain);
  }

  /** Admin list: peers with their lifecycle columns, filtered by free-text domain + trust state. */
  async listPeers(opts: {
    skip: number;
    take: number;
    search?: string;
    status?: string;
  }) {
    return this.peerLifecycle.list(opts);
  }

  /** Admin timeline: a peer's lifecycle events, newest-first. */
  async peerEvents(domain: string, take = 100) {
    return this.peerLifecycle.events(domain, take);
  }

  /**
   * Administrator-only, non-destructive recovery after a transient DNS/SRV hijack caused identity loss.
   * The operation never adopts what DNS currently serves: hostname-verified discovery must present the
   * exact pinned root, while current signing certificates may legitimately differ through rotation.
   */
  async manuallyRecoverPinnedIdentity(
    peerDomain: string,
    confirmDomain: string,
  ): Promise<{ domain: string; trustLevel: 'degraded' }> {
    return this.peerLifecycle.manuallyRecoverPinnedIdentity(
      peerDomain,
      confirmDomain,
    );
  }

  /** POST /s2s/v1/call — deliver ONE ephemeral WebRTC call frame (ring / lifecycle / SDP-ICE relay)
   *  to the peer server hosting the call's other participant. Awaitable so the caller's `initiate` can
   *  detect a ring failure (→ the `unreachable` terminal bubble). The persisted CALL record rides the
   *  pull-based message sync, NOT this frame. `peerDomain` is the server hosting the foreign participant. */
  async sendCallFrame(
    params: OutboundCallFrameParams,
    peerDomain: string,
  ): Promise<void> {
    await this.callBridge.sendFrame(params, peerDomain);
  }

  /** Whether this server is the roster and history authority for a group thread. */
  private isOriginThread(trd: { group: { domain: string } | null }): boolean {
    return trd.group?.domain === 'local';
  }

  /** Resolve a wire address (account + domain) to a User row, normalizing the local domain: wire addresses
   *  use the real config.domain for locals, but the DB stores local users with domain="local". Foreign
   *  stubs are looked up by their peer domain verbatim. Returns the stub/local user or null. */
  private async resolveUserByWireAddress(
    account: string,
    fromDomain: string,
  ): Promise<{ id: number } | null> {
    const domain = fromDomain === this.config.domain ? 'local' : fromDomain;
    return (
      (await this.database.db.query.user.findFirst({
        where: and(
          eq(tables.user.account, normalizeAccount(account)),
          eq(tables.user.domain, domain),
        ),
        columns: { id: true },
      })) ?? null
    );
  }

  /** Resolve an independent group address to its local origin or mirror thread. */
  private async findGroupThread(groupAccount: string): Promise<{
    id: number;
    type: MessageThreadType;
    groupId: number | null;
    group: {
      account: string;
      domain: string;
      dissolvedAt: Date | null;
    } | null;
  } | null> {
    const [row] = await this.database.db
      .select({
        id: tables.messageThread.id,
        type: tables.messageThread.type,
        groupId: tables.messageThread.groupId,
        group: {
          account: tables.group.account,
          domain: tables.group.domain,
          dissolvedAt: tables.group.dissolvedAt,
        },
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.group,
        eq(tables.group.id, tables.messageThread.groupId),
      )
      .where(eq(tables.group.account, normalizeAccount(groupAccount)))
      .limit(1);
    return row ?? null;
  }

  /** Inbound POST /s2s/v1/call — receive ONE federated call frame. Resolves the wire identities to
   *  LOCAL ids (the sender → a foreigner stub; the recipient → a local userId) + the LOCAL P2P thread,
   *  then hands the frame to CallsService via `emitAsync('call.frame.inbound')` — NOT a direct injection
   *  (the calls layer injects FederationService for outbound; a back-edge would cycle). `emitAsync` (not
   *  `emit`) so the 200 response serializes after callee-side state setup: the caller's first `offer`
   *  signal must not race ahead of the call it addresses.
   *
   *  The verified signer domain supplies the sender's server identity; the body carries only account
   *  names because the receiver domain is this server. Quota: `peek 'requests'` for the initiating
   *  `incoming` op ONLY (a call is one unit; an ICE burst
   *  must not exhaust the budget). The `tick` happens in CallsService AFTER the in-memory call-state
   *  guard, so a retried `incoming` (fresh UUID) burns no quota. No persistent callSid table — the
   *  receiver's call state machine + the callSid-keyed bubble write make replays idempotent. The
   *  not-found / not-friends rejects use HTTP 404 (NOT in postSigned's success- or degradation-sets → the
   *  sender throws without degrading a healthy peer). */
  async handleCallFrame(
    body: unknown,
    peerDomain: string,
    namespaceId: number,
    signatureExpiresAtSec: number,
  ): Promise<void> {
    await this.callBridge.handleFrame(
      body,
      peerDomain,
      namespaceId,
      signatureExpiresAtSec,
    );
  }

  /** Group writes are gated exclusively by locally converged state. */
  async assertGroupWritable(threadId: number): Promise<void> {
    await this.threadAccess.assertGroupWritable(threadId);
  }

  /** P2P writes are gated exclusively by locally converged state. No synchronous peer query is allowed
   * on the message-send path. */
  async assertP2PWritable(
    threadId: number,
    localUserId: number,
  ): Promise<void> {
    await this.threadAccess.assertP2PWritable(threadId, localUserId);
  }

  /** Validate a wire address has non-empty account + domain AND a well-formed account charset (defense
   *  against malformed peer input; the S2sSignatureGuard already bound signer==origin + integrity). */
  private requireS2SAddress(a: S2SAddress): S2SAddress {
    if (!a || !a.account || !a.domain) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed address ${JSON.stringify(a)}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!isValidAccount(a.account)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `account [${a.account}] fails charset`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return a;
  }

  // ─── Step 2: message delivery (coalesced hint map + active pull) ──────────────

  async capturePeerResponseToken(domain: string): Promise<PeerResponseToken> {
    return this.threadAccess.capturePeerResponseToken(domain);
  }

  /** Lightweight, ephemeral discovery wake-up. The receiver never persists this advertised HWM. */
  async pushDiscoveryHwm(domain: string): Promise<void> {
    await this.statePull.pushDiscoveryHwm(domain);
  }

  /** Rebuild compacted thread heads after startup/reconnect before publishing the State Feed HWM. */
  async rebuildAndPushDiscoveryHwm(domain: string): Promise<void> {
    await this.statePull.rebuildAndPushDiscoveryHwm(domain);
  }

  async pullStateFeedPage(
    domain: string,
    after?: bigint,
    take?: number,
    through?: bigint,
  ): Promise<PeerStateFeedPage> {
    return this.statePull.pullStateFeedPage(domain, after, take, through);
  }

  /** State is always drained before callers start data feeds. When a lightweight hint supplies a
   * required revision, returning successfully is a durable barrier: the state cursor reached it. */
  async pullStateFromPeer(
    domain: string,
    requiredRevision?: bigint,
  ): Promise<bigint> {
    return this.statePull.pullStateFromPeer(domain, requiredRevision);
  }

  /** Materialize a stable address-derived identity shell. PROFILE is ordered after the confirming
   * ACCEPTED, so the initial row intentionally contains placeholders and is filled by a later
   * verified PROFILE item in the same or a subsequent drain. */

  /** Ensure an incoming federated group request has a structurally complete retained conversation.
   * RelationshipIntent remains the sole authorization source, and no client state entry is published
   * until the user accepts the request. */

  /** Publish a server-local timeline notice only after its state transaction commits. */
  private async publishLocalSystemMessage(status: {
    actorUserId: number;
    threadId: number;
    type: SystemMessageType;
    subjectUserId?: number;
    message?: PublicMessage;
    recipientUserIds?: number[];
  }): Promise<void> {
    await this.localSystemMessages.publish(status);
  }

  /** Refresh every local-origin group source that exposes this member. */

  /** A member profile change is a group-meta semantic change and therefore advances the same group
   * revision used by roster mutations before publishing the compacted member projection. */

  async fetchThreadResource<T>(
    threadId: number,
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<FederationThreadResourceResponse<T>> {
    return this.threadResources.fetch<T>(
      threadId,
      path,
      peerDomain,
      maxResponseBytes,
    );
  }

  async assertThreadResourceResponseWritableInTransaction(
    tx: DatabaseTransaction,
    response: FederationThreadResourceResponse<unknown>,
  ): Promise<void> {
    await this.threadAccess.assertResourceResponseWritable(tx, response);
  }

  async applyReverseMessagePage(params: {
    response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    before: number;
    through?: number;
    messageSeqOffset: number;
    prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
  }): Promise<void> {
    const publication = await this.database.db.transaction((tx) =>
      this.applyReverseMessagePageInTransaction(tx, params),
    );
    await publication.publish();
  }

  async applyReverseMessagePageInTransaction(
    tx: DatabaseTransaction,
    params: {
      response: FederationThreadResourceResponse<FederationMessageQueryPage>;
      before: number;
      through?: number;
      messageSeqOffset: number;
      prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
    },
  ): Promise<{ publish: () => Promise<void> }> {
    const effects = await this.inboundMessageCommits.applyReverseInTransaction(
      tx,
      params,
    );
    return {
      publish: () =>
        this.publishMessageQueryEffects(params.response.peerDomain, effects),
    };
  }

  async finalizeReverseMessageWindowInTransaction(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      peerDomain: string;
      namespaceId: number;
      beforeSeq: number;
      throughSeq: number;
    },
  ): Promise<void> {
    await this.inboundMessageCommits.finalizeReverseWindowInTransaction(
      tx,
      params,
    );
  }

  async applyForwardMessagePage(params: {
    response: FederationThreadResourceResponse<FederationMessageQueryPage>;
    after: number;
    frozenTargetSeq: number;
    prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
  }): Promise<{ publish: () => Promise<void> }> {
    return this.database.db.transaction((tx) =>
      this.applyForwardMessagePageInTransaction(tx, params),
    );
  }

  async applyForwardMessagePageInTransaction(
    tx: DatabaseTransaction,
    params: {
      response: FederationThreadResourceResponse<FederationMessageQueryPage>;
      after: number;
      frozenTargetSeq: number;
      prefetchedForwardClosures?: ReadonlyMap<number, ForwardWireBundle>;
    },
  ): Promise<{ publish: () => Promise<void> }> {
    const effects = await this.inboundMessageCommits.applyForwardInTransaction(
      tx,
      params,
    );
    return {
      publish: () =>
        this.publishMessageQueryEffects(params.response.peerDomain, effects),
    };
  }

  async applyForwardTombstonePage(params: {
    response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
    frozenTargetSeq: number;
  }): Promise<{ publish: () => Promise<void> }> {
    return this.database.db.transaction((tx) =>
      this.applyForwardTombstonePageInTransaction(tx, params),
    );
  }

  async applyForwardTombstonePageInTransaction(
    tx: DatabaseTransaction,
    params: {
      response: FederationThreadResourceResponse<FederationMessageTombstoneQueryPage>;
      frozenTargetSeq: number;
    },
  ): Promise<{ publish: () => Promise<void> }> {
    const dependencies =
      await this.inboundMessageCommits.applyTombstonesInTransaction(tx, params);
    return {
      publish: () =>
        this.inboundMessageCommits.publishSatisfiedQuoteDependencies(
          dependencies,
        ),
    };
  }

  /** Apply one bounded message-query page inside the caller's cursor transaction. */
  async applyMessageQueryItemsInTransaction(
    tx: DatabaseTransaction,
    domain: string,
    items: readonly FederationMessageFeedMessage[],
    token: PeerResponseToken,
    options: MessageQueryApplyOptions = {},
  ): Promise<MissedPageEffect[]> {
    return this.inboundMessagePages.apply(tx, domain, items, token, options);
  }
  /** Publish only committed /missed work. Messages already in Message fan immediately; pending media
   * starts its durable download and will fan from promotePendingMessage after its own commit. */
  async publishMessageQueryEffects(
    domain: string,
    effects: MissedPageEffect[],
  ): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'pending') {
        void this.runFileSyncBatch(effect.batchId!, (digest, offset) =>
          this.fetchMediaChunks(
            domain,
            digest,
            effect.author.account,
            effect.author.domain,
            effect.toAccount,
            effect.originSeq,
            offset,
          ),
        ).catch(() => undefined);
        continue;
      }
      if (effect.localForwardBundleId && !effect.message!.isDeleted) {
        await this.forwardBundles.rebuildLinkCards(
          effect.localForwardBundleId,
          (url) => this.linkPreview.buildCardContent(url),
        );
      }
      if (!effect.historical) {
        void this.signalOutbound(
          effect.threadId,
          {
            account: effect.message!.creatorAccount!,
            domain: effect.message!.creatorDomain!,
          },
          effect.originSeq,
          domain,
        ).catch(() => undefined);
        if (effect.message!.isDeleted) {
          void this.signalDeletionOutbound(
            effect.threadId,
            effect.message!.seq,
          ).catch(() => undefined);
        }
      }
      if (
        effect.forwardClosure &&
        effect.remoteForwardBundleId &&
        !effect.message!.isDeleted
      ) {
        await this.mediaLocalization.localizeForwardAssets(
          effect.forwardClosure,
          domain,
          await this.mediaLocalization.resolveForwardAssetAuth(effect.message!),
        );
      }
    }
  }

  private assertMissedAssetDescriptors(
    item: FederationMessageFeedMessage,
  ): void {
    this.inboundMessageValidator.assertAssetDescriptors(item);
  }

  private assertFederatedMessageEnvelope(
    item: FederationMessageFeedMessage,
  ): void {
    this.inboundMessageValidator.assertEnvelope(item);
  }
  private federatedMessageAuthor(
    item: FederationMessageFeedMessage,
    sourceDomain: string,
  ): S2SAddress {
    return this.inboundMessageRoutes.messageAuthor(item, sourceDomain);
  }

  private async resolveMissedThreadInTransaction(
    tx: DatabaseTransaction,
    item: FederationMessageFeedMessage,
    sourceDomain: string,
    namespaceId: number,
  ) {
    return this.inboundMessageRoutes.resolveMessage(
      tx,
      item,
      sourceDomain,
      namespaceId,
    );
  }

  private async resolveTombstoneThreadInTransaction(
    tx: DatabaseTransaction,
    thread: FederationThreadAddress,
    sourceDomain: string,
    namespaceId: number,
  ) {
    return this.inboundMessageRoutes.resolveTombstone(
      tx,
      thread,
      sourceDomain,
      namespaceId,
    );
  }
  /** Domains with incomplete recognition or degraded reachability. */
  async listRecoverablePeerDomains(): Promise<string[]> {
    const rows = await this.database.db.query.federatedPeer.findMany({
      where: inArray(tables.federatedPeer.trustLevel, [
        'unrecognized',
        'degraded',
      ]),
      columns: { domain: true },
    });
    return rows.map((r) => r.domain);
  }

  /** Fully recognized peers participating in startup and periodic reconciliation. */
  async listTrustedPeerDomains(): Promise<string[]> {
    const rows = await this.database.db.query.federatedPeer.findMany({
      where: inArray(tables.federatedPeer.trustLevel, [
        'available',
        'degraded',
      ]),
      columns: { domain: true },
    });
    return rows.map((row) => row.domain);
  }

  async resolveMediaFile(
    fromAccount: string,
    toAccount: string,
    fromDomain: string,
    signerDomain: string,
    signerNamespaceId: number,
    digest: string,
    sourceSeq: number,
  ): Promise<{ absPath: string; bytes: number }> {
    return this.peerResources.resolveMediaFile(
      fromAccount,
      toAccount,
      fromDomain,
      signerDomain,
      signerNamespaceId,
      digest,
      sourceSeq,
    );
  }

  async serveForwardBundleClosure(
    bundleId: string,
    signerDomain: string,
    signerNamespaceId: number,
  ) {
    return this.peerResources.serveForwardBundleClosure(
      bundleId,
      signerDomain,
      signerNamespaceId,
    );
  }

  /**
   * Drive every pending file in a batch, then promote the staged message once all files succeed.
   * The extracted coordinator serializes concurrent retry and recovery attempts for the same batch.
   */
  async runFileSyncBatch(
    batchId: string,
    fetchChunksFor: (digest: string, offset: number) => AsyncIterable<Buffer>,
  ): Promise<void> {
    await this.inboundMediaBatches.runFileSyncBatch(batchId, fetchChunksFor);
  }

  /**
   * Admin-driven retry of a stalled inbound media batch (design doc §12.7). Resets files frozen in
   * DOWNLOADING (a crashed driver) or FAILED back to PENDING, restores the admitted download route
   * persisted by global /missed, then fire-and-forgets runFileSyncBatch. Returns the
   * number of stuck files reset (FAILED/DOWNLOADING → PENDING); the admin observes progress via the
   * inbox list endpoint.
   */
  async retryInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.inboundMediaBatches.retryInboundBatch(batchId);
  }

  /**
   * Startup recovery is deliberately narrower than the admin retry: a process crash may strand an
   * active transfer in DOWNLOADING, so it is reset and resumed. A clean FAILED row remains terminal
   * until an administrator explicitly retries it.
   */
  async recoverInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.inboundMediaBatches.recoverInboundBatch(batchId);
  }

  /**
   * Manually re-run localize for one federated media message (the user tapped retry in the detail
   * view). Resolves the localizeMedia context (creator account/domain + the thread's receiver/peer
   * domain) from the stored message alone, then re-runs the SAME localize path the pull flow uses —
   * localizeMedia is idempotent (already-local digests skip the fetch and cost no quota) and pushes
   * the terminal MEDIA_STATUS itself, so this method needs no push of its own. Returns the post-
   * localize status so the endpoint can answer the client. Non-media → 'ready' (nothing to do);
   * missing message/creator → NOT_FOUND.
   */
  async localizeMediaForMessage(
    userId: number,
    threadId: number,
    seq: number,
  ): Promise<MediaStatus> {
    return this.mediaLocalization.localizeMediaForMessage(
      userId,
      threadId,
      seq,
    );
  }

  /**
   * Receiver-side resumable media fetch (Step 2 §4.5): yield a peer-hosted chat-media asset as ordered
   * Buffer chunks via signed Range GETs to /media/:digest, for saveCasFromStream to stream to disk. Each
   * yielded Buffer is ONE fully-accumulated Range unit (≤ mediaChunkBytes), so a body-read abort
   * discards only that unit upstream and is re-requested from the SAME offset — the writer never sees a
   * partial/duplicated slice, and resume is byte-exact. Offset advances by the peer's returned
   * Content-Range (the server may clamp the tail, RFC 7233 §4.2), NOT by the requested window.
   *
   * Degradation policy is STATUS-based (the fetch-throws-vs-body-abort proxy is unreliable at the header
   * boundary): a fetch rejection or 5xx → peer unreachable → markTransportDegraded + throw. Registered 200
   * business errors and 400/401/416 reject only this transfer without degrading. A body-read error AFTER
   * a 206 → retry the same unit, NO degradation (peer alive; lost a
   * stream). After mediaMaxChunkRetries consecutive failures → give up (throw; localizeMedia leaves it
   * inert). markContactSuccess fires ONCE per digest (after the first 2xx headers). If the peer returns
   * A peer that ignores Range and returns 200 is rejected: federation media requires exact resumable
   * ranges. Per-unit Content-Digest is optional, but when present it is verified before yielding; the
   * final CAS digest remains mandatory in both cases.
   */
  private async *fetchMediaChunks(
    peerDomain: string,
    digest: string,
    fromAccount: string,
    fromDomain: string,
    toAccount: string,
    sourceSeq: number,
    startOffset = 0,
  ): AsyncGenerator<Buffer> {
    yield* this.mediaRangeClient.fetch(
      peerDomain,
      digest,
      fromAccount,
      fromDomain,
      toAccount,
      sourceSeq,
      startOffset,
    );
  }

  /**
   * Fetch a peer user's public profile (signed GET /s2s/v1/users/:account). Used by federated
   * resolve (the add-friend card), ensureForeignUserLocalized (send-friend-request safety net), and
   * initial invite/profile localization. Throws on any non-success (the caller
   * surfaces FEDERATION_DELIVERY_FAILED → user retries / inits).
   */
  async fetchRemoteUser(address: S2SAddress): Promise<S2SProfile> {
    return this.profiles.fetchRemoteUser(address);
  }

  // ─── inbound / re-pull localization ──────────────────────────────────────────

  /**
   * Localize a foreign stub from a received S2SProfile: decode + persist the avatar via the
   * shared saveAvatars pipeline, write name/avatar/bio, and stamp remoteUpdatedAt. Idempotent + gated
   * on the profile revision — skips entirely when profile.updatedAt is not newer than the stored
   * remoteUpdatedAt (so a re-delivered payload or a no-change re-pull does no work). Avatar decode
   * failures (corrupt/oversized bytes from a compromised peer) are isolated: name/bio/remoteUpdatedAt
   * still advance and the existing avatar is kept, so a broken avatar can't break friend-flow (and
   * advancing remoteUpdatedAt prevents a probe retry-loop on the same broken bytes).
   */
  async localizeForeignProfile(
    userId: number,
    profile: S2SProfile,
    gate?:
      | {
          threadId: number;
          peerDomain: string;
          expectedFederationVersion: number;
        }
      | { peerToken: PeerResponseToken },
  ): Promise<void> {
    await this.profiles.localizeForeignProfile(userId, profile, gate);
  }

  async upsertForeignUserFromPeerResponse(
    account: string,
    domain: string,
    profile: S2SProfile,
    peerToken: PeerResponseToken,
  ): Promise<number> {
    return this.profiles.upsertForeignUserFromPeerResponse(
      account,
      domain,
      profile,
      peerToken,
    );
  }
}
