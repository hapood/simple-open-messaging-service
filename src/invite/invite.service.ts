import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import {
  GroupRole,
  InviteKind,
  InviteStatus,
  MessageThreadType,
  Prisma,
} from '../prisma/generated/client.js';
import { mintUlid, normalizeAccount } from '../common/account.js';
import { loadFederationConfig } from '../federation/federation.config.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';

/** Friend + group invite TTL: 7 days. Validated at accept time; the background sweep/GC is deferred
 *  (a row stays PENDING past expiry until then — the client renders an "expired" prompt from
 *  `expiresAt`, and accept rejects an expired row with INVITE_EXPIRED as defense-in-depth). */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** One-shot cap for the parameterless incoming/outgoing endpoints. */
const LIST_LIMIT = 200;

export type CreateFriendInviteResult =
  | { status: 'created'; inviteId: string }
  | { status: 'already-pending'; inviteId: string }
  | { status: 'auto-accepted'; threadId: number };

export type AcceptInviteResult =
  | { kind: 'FRIEND'; threadId: number; fromUserId: number }
  | {
      kind: 'GROUP';
      threadId: number;
      fedGroupAccount: string | null; // non-null ⇒ a cross-server group mirror
      originDomain: string | null; // the group's home domain (origin-propagation target)
    };

/** Fields selected for the embedded inviter/recipient profile on list queries (never hashPwd /
 *  hasUrFriendReq — those are sensitive). */
const USER_SELECT = {
  id: true,
  account: true,
  name: true,
  avatar: true,
  domain: true,
  isForeigner: true,
} as const;

/**
 * Invite domain — the single home for friend-add and group-invite requests (unified). An invite is
 * a server-stored entity with an expiry, delivered to `toUserId` and accepted by sending its id back.
 *
 * Duplicate = new overwrites old: a PENDING re-create hits the migration's partial unique index
 * (FRIEND on (from,to); GROUP on (to,thread)) and we refresh the existing row in place rather than
 * erroring. Rows are never hard-deleted (kept as history; a future GC sweep flips stale PENDING →
 * EXPIRED). Expiry is validated at accept time only.
 *
 * The service owns DB + the `hasUrFriendReq` badge (FRIEND invites arm it; GROUP invites do not).
 * It is deliberately decoupled from federation + SSE — the controller orchestrates S2S delivery and
 * the live NOTIFY frames based on the structured results returned here.
 */
@Injectable()
export class InviteService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly participantService: ThreadParticipantService,
    private readonly threadRevisionService: ThreadRevisionService,
  ) {}

  /**
   * Create (or refresh) a friend invite from→to. Local-only mutual auto-accept: when allowed and the
   * target already has a PENDING friend invite back to the caller, skip creating and form the
   * friendship immediately. Federated targets pass allowAutoAccept=false (cross-server accept needs
   * an S2S round-trip; the recipient accepts the delivered invite explicitly instead).
   */
  async createFriendInvite(
    fromUserId: number,
    toUserId: number,
    note: string,
    allowAutoAccept: boolean,
  ): Promise<CreateFriendInviteResult> {
    const trimmed = (note ?? '').slice(0, 255);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const origin = this.config.domain;

    // Explicit type param keeps the callback's `status` literals from widening to string (the
    // bare `const result = await …` form loses the method-return contextual type the old
    // `return this.prisma.$transaction(…)` form got for free).
    const result = await this.prisma.$transaction<CreateFriendInviteResult>(async (tx) => {
      if (allowAutoAccept) {
        const mutual = await tx.invite.findFirst({
          where: {
            kind: InviteKind.FRIEND,
            status: InviteStatus.PENDING,
            fromUserId: toUserId,
            toUserId: fromUserId,
          },
        });
        if (mutual) {
          const threadId = await this.createP2PFriendshipInTx(tx, fromUserId, toUserId);
          await tx.invite.update({
            where: { id: mutual.id },
            data: { status: InviteStatus.ACCEPTED },
          });
          return { status: 'auto-accepted', threadId };
        }
      }

      const originId = mintUlid();
      try {
        const invite = await tx.invite.create({
          data: {
            kind: InviteKind.FRIEND,
            fromUserId,
            toUserId,
            note: trimmed,
            status: InviteStatus.PENDING,
            expiresAt,
            origin,
            originId,
          },
        });
        await tx.user.update({
          where: { id: toUserId },
          data: { hasUrFriendReq: true },
        });
        return { status: 'created', inviteId: invite.id.toString() };
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          // Partial unique index (FRIEND, from→to, PENDING) — refresh the existing row in place.
          const existing = await tx.invite.findFirst({
            where: {
              kind: InviteKind.FRIEND,
              status: InviteStatus.PENDING,
              fromUserId,
              toUserId,
            },
          });
          if (existing !== null) {
            await tx.invite.update({
              where: { id: existing.id },
              data: { note: trimmed, expiresAt, origin, originId },
            });
            await tx.user.update({
              where: { id: toUserId },
              data: { hasUrFriendReq: true },
            });
            return { status: 'already-pending', inviteId: existing.id.toString() };
          }
        }
        throw e;
      }
    });
    // Record the thread add AFTER the tx commits (bump threadRevision + push signal). Auto-accept
    // creates the P2P thread for BOTH users — mirrors acceptInvite's recordThreadAdd for both
    // (inviter + accepter). The 'created'/'already-pending' paths create no thread, so no signal.
    if (result.status === 'auto-accepted') {
      await this.threadRevisionService.recordThreadAdd(fromUserId, result.threadId);
      await this.threadRevisionService.recordThreadAdd(toUserId, result.threadId);
    }
    return result;
  }

  /**
   * Create (or refresh) a single GROUP invite. Returns the invite id — STABLE across overwrites (the
   * BigInt PK is unchanged; only originId refreshes), so an already-delivered card message still
   * resolves to the freshest invite. Does NOT arm the unread badge (a group invite surfaces as a card
   * message in the P2P thread, not the friend-pending badge). The caller friend-gates + writes that
   * card message.
   */
  async createGroupInvite(
    fromUserId: number,
    threadId: number,
    toUserId: number,
    note = '',
    originOverride?: { origin: string; originId: string },
  ): Promise<string> {
    const trimmed = (note ?? '').slice(0, 255);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    // Inbound federated invites carry the peer's (origin, originId) for delivery dedup; local invites
    // mint our domain + a fresh ULID.
    const origin = originOverride?.origin ?? this.config.domain;
    const originId = originOverride?.originId ?? mintUlid();
    try {
      const invite = await this.prisma.invite.create({
        data: {
          kind: InviteKind.GROUP,
          fromUserId,
          toUserId,
          threadId,
          note: trimmed,
          status: InviteStatus.PENDING,
          expiresAt,
          origin,
          originId,
        },
      });
      return invite.id.toString();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Partial unique index (GROUP, to, thread, PENDING) — refresh in place; id stays stable.
        const existing = await this.prisma.invite.findFirst({
          where: { kind: InviteKind.GROUP, status: InviteStatus.PENDING, toUserId, threadId },
        });
        if (existing !== null) {
          await this.prisma.invite.update({
            where: { id: existing.id },
            data: { fromUserId, note: trimmed, expiresAt, origin, originId },
          });
          return existing.id.toString();
        }
      }
      throw e;
    }
  }

  /**
   * The live state of an invite for the group-invite dialog: status / expiry / target group identity /
   * whether the caller already joined. Non-leaking — an invite not addressed to the caller (or a missing
   * one) resolves to INVITE_NOT_FOUND. The dialog renders "valid → Join", "joined", "expired", or "invalid".
   */
  async getInviteDetail(inviteIdOrGroup: string, callerId: number): Promise<{
    id: string;
    kind: string;
    status: string;
    expiresAt: number;
    note: string;
    threadId: number | null;
    groupName: string;
    groupAvatar: string;
    groupDomain: string;
    groupIsLocal: boolean;
    alreadyJoined: boolean;
    fromUser: {
      id: number;
      account: string;
      name: string;
      avatar: string;
      domain: string;
      isForeigner: boolean;
    };
  }> {
    const id = await this.resolveInviteId(inviteIdOrGroup, callerId, false);
    const invite = await this.prisma.invite.findUnique({
      where: { id },
      include: {
        fromUser: { select: USER_SELECT },
        thread: { select: { groupUser: { select: { name: true, avatar: true, domain: true } } } },
      },
    });
    if (invite === null || invite.toUserId !== callerId) {
      throw new BusinessException(BusinessCode.INVITE_NOT_FOUND, 'invite not found');
    }
    let alreadyJoined = false;
    if (invite.threadId !== null) {
      const p = await this.prisma.threadParticipant.findUnique({
        where: { userId_threadId: { userId: callerId, threadId: invite.threadId } },
        select: { leftAt: true },
      });
      alreadyJoined = p !== null && p.leftAt === null;
    }
    const gu = invite.thread?.groupUser;
    const groupIsLocal = !gu?.domain || gu.domain === 'local';
    const groupDomain = groupIsLocal ? this.config.domain : (gu?.domain ?? '');
    return {
      id: invite.id.toString(),
      kind: invite.kind,
      status: invite.status,
      expiresAt: invite.expiresAt.getTime(),
      note: invite.note,
      threadId: invite.threadId,
      groupName: gu?.name ?? '',
      groupAvatar: gu?.avatar ?? '',
      groupDomain,
      groupIsLocal,
      alreadyJoined,
      fromUser: invite.fromUser,
    };
  }

  /**
   * Accept a pending invite addressed to `byUserId`. FRIEND → mint the P2P thread + both
   * participants + mark this invite ACCEPTED, and mark every OTHER pending friend invite between the
   * pair (both directions) ACCEPTED (symmetric cleanup). GROUP → add/reactivate the caller as a
   * MEMBER + mark ACCEPTED. Validates PENDING, ownership, and expiry.
   */
  async acceptInvite(
    inviteIdOrGroup: string,
    byUserId: number,
  ): Promise<AcceptInviteResult> {
    const id = await this.resolveInviteId(inviteIdOrGroup, byUserId, true);
    const result = await this.prisma.$transaction(async (tx): Promise<AcceptInviteResult> => {
      const invite = await tx.invite.findUnique({ where: { id } });
      if (invite === null || invite.status !== InviteStatus.PENDING) {
        throw new BusinessException(
          invite === null
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          invite === null ? 'invite not found' : 'invite already handled',
        );
      }
      if (invite.toUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this invite is not yours to accept',
        );
      }
      if (invite.expiresAt.getTime() <= Date.now()) {
        throw new BusinessException(BusinessCode.INVITE_EXPIRED, 'invite expired');
      }

      if (invite.kind === InviteKind.FRIEND) {
        const threadId = await this.createP2PFriendshipInTx(
          tx,
          invite.fromUserId,
          invite.toUserId,
        );
        await tx.invite.update({
          where: { id },
          data: { status: InviteStatus.ACCEPTED },
        });
        // Symmetric cleanup: any other pending friend invite between this pair (either direction) is
        // now moot — mark it ACCEPTED so it leaves both pending lists.
        await tx.invite.updateMany({
          where: {
            kind: InviteKind.FRIEND,
            status: InviteStatus.PENDING,
            id: { not: id },
            OR: [
              { fromUserId: invite.fromUserId, toUserId: invite.toUserId },
              { fromUserId: invite.toUserId, toUserId: invite.fromUserId },
            ],
          },
          data: { status: InviteStatus.ACCEPTED },
        });
        return { kind: 'FRIEND', threadId, fromUserId: invite.fromUserId };
      }

      // GROUP
      if (invite.threadId === null) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'group invite has no target thread',
        );
      }
      // NOTE: upsertMemberInTx(tx, threadId, userId, role) — threadId FIRST. (A swapped-arg bug here left
      // the group accept marking the Invite ACCEPTED but never adding the joiner to the mirror thread.)
      await this.participantService.upsertMemberInTx(tx, invite.threadId, byUserId, GroupRole.MEMBER);
      await tx.invite.update({
        where: { id },
        data: { status: InviteStatus.ACCEPTED },
      });
      // The group's federation fields: a cross-server mirror iff groupUser.domain !== 'local'. The
      // controller uses originDomain (non-null = mirror) to propagate the join to the origin (roster fanout).
      const thread = await tx.messageThread.findUnique({
        where: { id: invite.threadId },
        select: { groupUser: { select: { account: true, domain: true } } },
      });
      const groupAccount = thread?.groupUser?.account ?? null;
      const groupDomain = thread?.groupUser?.domain ?? null;
      return {
        kind: 'GROUP',
        threadId: invite.threadId,
        fedGroupAccount: groupAccount, // the group `!account` (S2S 'to'); non-null for any group
        originDomain: groupDomain && groupDomain !== 'local' ? groupDomain : null, // non-null = federated mirror
      };
    });
    // Record the thread add AFTER the tx commits (bump threadRevision + push signal). FRIEND adds the
    // thread for BOTH users (inviter + accepter); GROUP adds it for the joiner only.
    if (result.kind === 'FRIEND') {
      await this.threadRevisionService.recordThreadAdd(result.fromUserId, result.threadId);
      await this.threadRevisionService.recordThreadAdd(byUserId, result.threadId);
    } else {
      await this.threadRevisionService.recordThreadAdd(byUserId, result.threadId);
    }
    return result;
  }

  /** Reject a pending invite addressed to `byUserId`. */
  async rejectInvite(inviteId: string, byUserId: number): Promise<void> {
    const id = this.parseInviteId(inviteId);
    await this.prisma.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { id } });
      if (invite === null || invite.status !== InviteStatus.PENDING) {
        throw new BusinessException(
          invite === null
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          invite === null ? 'invite not found' : 'invite already handled',
        );
      }
      if (invite.toUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this invite is not yours to reject',
        );
      }
      await tx.invite.update({ where: { id }, data: { status: InviteStatus.REJECTED } });
    });
  }

  /** Revoke my own outgoing pending invite. */
  async revokeInvite(inviteId: string, byUserId: number): Promise<void> {
    const id = this.parseInviteId(inviteId);
    await this.prisma.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { id } });
      if (invite === null || invite.status !== InviteStatus.PENDING) {
        throw new BusinessException(
          invite === null
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          invite === null ? 'invite not found' : 'invite already handled',
        );
      }
      if (invite.fromUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this invite is not yours to revoke',
        );
      }
      await tx.invite.update({ where: { id }, data: { status: InviteStatus.REVOKED } });
    });
  }

  /**
   * Incoming PENDING friend invites for `userId`, newest first, last-7-days, ≤200. No client params.
   * The caller (controller) filters out any whose inviter is already a friend.
   */
  listIncoming(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    return this.prisma.invite.findMany({
      where: {
        kind: InviteKind.FRIEND,
        status: InviteStatus.PENDING,
        toUserId: userId,
        createdAt: { gt: since },
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      include: { fromUser: { select: USER_SELECT }, toUser: { select: USER_SELECT } },
    });
  }

  /** Outgoing PENDING friend invites from `userId`, newest first, last-7-days, ≤200. */
  listOutgoing(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    return this.prisma.invite.findMany({
      where: {
        kind: InviteKind.FRIEND,
        status: InviteStatus.PENDING,
        fromUserId: userId,
        createdAt: { gt: since },
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      include: { fromUser: { select: USER_SELECT }, toUser: { select: USER_SELECT } },
    });
  }

  /** Clear the friend-request unread badge (the panel was opened). */
  async markRead(userId: number): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { hasUrFriendReq: false },
    });
  }

  // ─── federation inbound (called by FriendOpHandler) ──────────────────────────

  /**
   * Inbound friend-request from a peer: create the incoming FRIEND Invite from the foreign stub to
   * the local user, carrying the PEER's (origin, originId) for cross-server delivery dedup. Arms the
   * recipient's badge. The FriendOpHandler already deduped via S2SFriendOpSeen, so a P2002 here is the
   * (from→to) partial unique index → refresh the existing PENDING invite in place. Never auto-accepts
   * (the inviter is foreign — the recipient must accept the delivered invite explicitly).
   */
  async receiveInboundFriendInvite(params: {
    fromUserId: number;
    toUserId: number;
    note: string;
    origin: string;
    originId: string;
    expiresAt: Date;
  }): Promise<string> {
    const note = (params.note ?? '').slice(0, 255);
    try {
      const invite = await this.prisma.invite.create({
        data: {
          kind: InviteKind.FRIEND,
          fromUserId: params.fromUserId,
          toUserId: params.toUserId,
          note,
          status: InviteStatus.PENDING,
          expiresAt: params.expiresAt,
          origin: params.origin,
          originId: params.originId,
        },
      });
      await this.prisma.user.update({
        where: { id: params.toUserId },
        data: { hasUrFriendReq: true },
      });
      return invite.id.toString();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Existing PENDING invite from this foreign stub → refresh in place, keep the badge armed.
        const existing = await this.prisma.invite.findFirst({
          where: {
            kind: InviteKind.FRIEND,
            status: InviteStatus.PENDING,
            fromUserId: params.fromUserId,
            toUserId: params.toUserId,
          },
        });
        if (existing !== null) {
          await this.prisma.invite.update({
            where: { id: existing.id },
            data: { note, expiresAt: params.expiresAt, origin: params.origin, originId: params.originId },
          });
          await this.prisma.user.update({
            where: { id: params.toUserId },
            data: { hasUrFriendReq: true },
          });
          return existing.id.toString();
        }
      }
      throw e;
    }
  }

  /**
   * Inbound friend-approve from a peer: the remote user accepted our local user's invite. Mark the
   * local user's outgoing PENDING invite (from=local, to=foreignApprover) ACCEPTED, and form the
   * friendship if it isn't already (ACCEPT-WINS — robust under message reordering: even if the
   * outgoing invite was revoked/expired/never landed, the approver definitively approved, so the
   * friendship is formed). Returns the P2P threadId + whether it was newly created (for SSE).
   */
  async applyInboundFriendApprove(
    localRequesterId: number,
    foreignApproverId: number,
  ): Promise<{ threadId: number; created: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.invite.updateMany({
        where: {
          kind: InviteKind.FRIEND,
          status: InviteStatus.PENDING,
          fromUserId: localRequesterId,
          toUserId: foreignApproverId,
        },
        data: { status: InviteStatus.ACCEPTED },
      });
      const existing = await this.findP2PThreadBetweenInTx(tx, localRequesterId, foreignApproverId);
      if (existing !== null) return { threadId: existing, created: false };
      const threadId = await this.createP2PFriendshipInTx(tx, localRequesterId, foreignApproverId);
      return { threadId, created: true };
    });
  }

  // ─── internals ───────────────────────────────────────────────────────────────

  /** In-tx version of ThreadParticipantService.findP2PThreadBetween: the id of the active P2P thread
   *  two users share (leftAt null on BOTH), or null. Used by applyInboundFriendApprove's accept-wins
   *  check to avoid minting a second thread when the friendship already exists. */
  private async findP2PThreadBetweenInTx(
    tx: Prisma.TransactionClient,
    userX: number,
    userY: number,
  ): Promise<number | null> {
    const mine = await tx.threadParticipant.findMany({
      where: { userId: userX, leftAt: null, thread: { type: MessageThreadType.P2P } },
      select: { threadId: true },
    });
    if (mine.length === 0) return null;
    const peer = await tx.threadParticipant.findFirst({
      where: { userId: userY, leftAt: null, threadId: { in: mine.map((m) => m.threadId) } },
      select: { threadId: true },
    });
    return peer?.threadId ?? null;
  }

  /** Create the P2P MessageThread + both active participants. A fresh threadId means brand-new
   *  participant rows even when re-friending (the old soft-left thread stays, filtered out by
   *  findP2PThreadBetween's leftAt:null check). */
  private async createP2PFriendshipInTx(
    tx: Prisma.TransactionClient,
    userAId: number,
    userBId: number,
  ): Promise<number> {
    const thread = await tx.messageThread.create({
      data: { type: MessageThreadType.P2P },
    });
    await tx.threadParticipant.createMany({
      data: [
        { userId: userAId, threadId: thread.id },
        { userId: userBId, threadId: thread.id },
      ],
    });
    return thread.id;
  }

  private parseInviteId(s: string): bigint {
    try {
      const n = BigInt(s);
      if (n <= 0n) throw new Error('non-positive');
      return n;
    } catch {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        `invalid inviteId [${s}]`,
      );
    }
  }

  /**
   * Resolve an invite id from EITHER a BigInt invite id (local legacy) OR a group `!account` (the
   * federated-stable card identity). The card carries the group account; the invitee's local Invite row
   * (created by handleGroupInvite) is found by (toUserId=caller, thread.fedGroupAccount=groupAccount).
   * `pendingOnly` — detail shows any-status (so an already-joined invite renders its final state); accept
   * requires PENDING. Returns null if no such invite (caller throws the domain error).
   */
  private async findInviteIdByGroup(
    groupAccount: string,
    callerId: number,
    pendingOnly: boolean,
  ): Promise<bigint | null> {
    const invite = await this.prisma.invite.findFirst({
      where: {
        toUserId: callerId,
        kind: InviteKind.GROUP,
        ...(pendingOnly ? { status: InviteStatus.PENDING } : {}),
        thread: { groupUser: { account: normalizeAccount(groupAccount), isGroup: true } },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return invite?.id ?? null;
  }

  /** Resolve the concrete invite id from a card identity: a group `!account` (lookup) or a BigInt id. */
  private async resolveInviteId(
    groupAccountOrId: string,
    callerId: number,
    pendingOnly: boolean,
  ): Promise<bigint> {
    if (groupAccountOrId.startsWith('!')) {
      const id = await this.findInviteIdByGroup(groupAccountOrId, callerId, pendingOnly);
      if (id === null) {
        throw new BusinessException(BusinessCode.INVITE_NOT_FOUND, 'invite not found');
      }
      return id;
    }
    return this.parseInviteId(groupAccountOrId);
  }
}
