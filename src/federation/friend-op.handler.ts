import { Injectable, HttpStatus } from '@nestjs/common';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { InviteService } from '../invite/invite.service.js';
import { SseService } from '../gateway/sse.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { isValidAccount } from '../common/account.js';
import { FederationService, type S2SPayload, type S2SFriendRequest, type S2SAddress } from './federation.service.js';

/** Inbound friend-op TTL mirrors the local invite TTL (7 days). */
const INBOUND_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Inbound friend-op handler. The S2sSignatureGuard already verified the signature + allow-list +
 * from.domain==signer binding; this handler dedupes (at-least-once → idempotent) then applies the op.
 * Two dedicated routes (POST /friend-request | /friend-approve) — the URL is the discriminator, so there
 * is no `type` field and no switch. PURELY inbound — no outbound fan-out (each server owns its own
 * thread; no thread.invite). The invite model: friend-request → create the incoming FRIEND Invite on
 * the receiver (arming the badge); friend-approve → ACCEPT-WINS (mark the outgoing invite ACCEPTED and
 * form the friendship if not already, robust under reordering).
 *
 * friend.delete is intentionally NOT handled — unfriending is LOCAL-ONLY (no S2S notification); a peer
 * discovers a severed edge lazily via rejection-on-send in Step 2 (resolveFriendshipThread → 403).
 *
 * Error handling: NOT_FOUND (404, permanent) when a referenced local user doesn't exist; everything
 * else is happy-path. Duplicate ops are silently acked (idempotent success), never re-processed.
 */
@Injectable()
export class FriendOpHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invite: InviteService,
    private readonly sse: SseService,
    private readonly federation: FederationService,
  ) {}

  /** POST /friend-request: remote user wants to add our local user. The payload carries the requester's
   *  profile, so the stub is localized (avatar/name/bio) inline — no extra fetch. Creates the incoming
   *  FRIEND Invite (arming hasUrFriendReq) and surfaces it via NOTIFY with the invite id. */
  async handleRequest(body: S2SFriendRequest): Promise<void> {
    if (await this.isDuplicate(body.origin, body.id)) return;
    const from = this.requireAddress(body.from); // the remote requester → foreign stub
    const to = this.requireAddress(body.to[0]); // the local target
    const foreignId = await this.federation.ensureForeignUser(from.account, from.domain);
    if (body.profile) {
      await this.federation.localizeForeignProfile(foreignId, body.profile);
    }
    const localId = await this.federation.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${body.to[0].account} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    const inviteId = await this.invite.receiveInboundFriendInvite({
      fromUserId: foreignId,
      toUserId: localId,
      note: body.message ?? '',
      origin: body.origin,
      originId: body.id,
      expiresAt: new Date(Date.now() + INBOUND_INVITE_TTL_MS),
    });
    this.sse.onNotify(
      localId,
      serializeBody({ event: 'NOTIFY', type: 'FRIEND_REQUEST', fromUserId: foreignId, inviteId }),
    );
  }

  /** POST /friend-approve: remote user accepted our local user's invite. ACCEPT-WINS: mark our outgoing
   *  PENDING invite ACCEPTED and create THIS server's own P2P thread if the friendship doesn't already
   *  exist (each-server-own-thread model) — lenient under message reordering (the approver definitively
   *  approved, so we honor it even if the outgoing invite was revoked/expired/lost). NO profile
   *  localization (the requester's stub of the approver was created at resolve time; later changes are
   *  picked up lazily by the chat-open /revision probe). */
  async handleApprove(body: S2SPayload): Promise<void> {
    if (await this.isDuplicate(body.origin, body.id)) return;
    const from = this.requireAddress(body.from); // the remote approver → foreign stub
    const to = this.requireAddress(body.to[0]); // the local requester
    const foreignId = await this.federation.ensureForeignUser(from.account, from.domain);
    const localId = await this.federation.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${body.to[0].account} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    await this.invite.applyInboundFriendApprove(localId, foreignId);
    this.sse.onNotify(
      localId,
      serializeBody({ event: 'NOTIFY', type: 'FRIEND_APPROVED', byUserId: foreignId }),
    );
  }

  /** True if (origin, opId) already applied. Race-safe (P2002 = concurrent duplicate). */
  private async isDuplicate(origin: string, opId: string): Promise<boolean> {
    const existing = await this.prisma.s2SFriendOpSeen.findUnique({
      where: { origin_opId: { origin, opId } },
    });
    if (existing) return true;
    try {
      await this.prisma.s2SFriendOpSeen.create({ data: { origin, opId } });
      return false;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return true;
      throw e;
    }
  }

  /** Validate a wire address has non-empty account + domain AND a well-formed account charset (defense
   *  against malformed peer input). The S2sSignatureGuard already bound from.domain==signer; this guards
   *  shape + charset. */
  private requireAddress(a: S2SAddress): S2SAddress {
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
}
