import { Injectable, HttpStatus } from '@nestjs/common';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { FriendshipService } from '../friendship/friendship.service.js';
import { SseService } from '../gateway/sse.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { FederationService, type S2SPayload, type S2SFriendRequest, type S2SAddress } from './federation.service.js';

/**
 * Inbound friend-op handler. The S2sSignatureGuard already verified the signature + allow-list +
 * from.domain==signer binding; this handler dedupes (at-least-once → idempotent) then applies the op.
 * Two dedicated routes (POST /friend-request | /friend-approve) — the URL is the discriminator, so there
 * is no `type` field and no switch. PURELY inbound — no outbound fan-out (each server owns its own
 * thread; no thread.invite). The friend ops it calls (makeFriendRequest / approveFriendRequest) are
 * themselves idempotent, so a redelivered op (after the guard's signature check) is safe. The sender's
 * profile (avatar/name/bio) is embedded on the friend-request payload, so the foreign stub is localized
 * inline — no nested S2S GET inside the handler (which would double inbound latency and risk a
 * call-timeout).
 *
 * friend.delete is intentionally NOT handled — unfriending is LOCAL-ONLY (no S2S notification); a peer
 * discovers a severed edge lazily via rejection-on-send in Step 2.
 *
 * Error handling: NOT_FOUND (404, permanent) when a referenced local user doesn't exist; everything
 * else is happy-path. Duplicate ops are silently acked (idempotent success), never re-processed.
 */
@Injectable()
export class FriendOpHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly friendship: FriendshipService,
    private readonly sse: SseService,
    private readonly federation: FederationService,
  ) {}

  /** POST /friend-request: remote user wants to add our local user. The payload carries the requester's
   *  profile, so the stub is localized (avatar/name/bio) inline — no extra fetch. */
  async handleRequest(body: S2SFriendRequest): Promise<void> {
    if (await this.isDuplicate(body.origin, body.id)) return;
    const from = this.requireAddress(body.from); // the remote requester → foreign stub
    const to = this.requireAddress(body.to[0]); // the local target
    const foreignId = await this.federation.ensureForeignUser(from.username, from.domain);
    if (body.profile) {
      await this.federation.localizeForeignProfile(foreignId, body.profile);
    }
    const localId = await this.federation.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${body.to[0].username} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    const { status } = await this.friendship.makeFriendRequest(foreignId, localId, body.message ?? '');
    // status 0/2/3 = new / re-armed / mutual-auto → surface to the local user. (1=already friends, 5=idempotent/blocked → no SSE.)
    if (status === 0 || status === 2 || status === 3) {
      this.sse.onNotify(
        localId,
        serializeBody({ event: 'NOTIFY', type: 'FRIEND_REQUEST', fromUserId: foreignId }),
      );
    }
  }

  /** POST /friend-approve: remote user approved our local user's request. Pure state change — NO
   *  profile localization (the requester's stub of the approver was created at resolve time; any later
   *  profile change is picked up lazily by the chat-open /revision probe). Just ensure the approver
   *  stub exists + create THIS server's own P2P thread (each-server-own-thread model). */
  async handleApprove(body: S2SPayload): Promise<void> {
    if (await this.isDuplicate(body.origin, body.id)) return;
    const from = this.requireAddress(body.from); // the remote approver → foreign stub
    const to = this.requireAddress(body.to[0]); // the local requester
    const foreignId = await this.federation.ensureForeignUser(from.username, from.domain);
    const localId = await this.federation.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${body.to[0].username} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    // requester=local, approver=foreign. approveFriendRequest creates THIS server's own P2P thread
    // (each-server-own-thread model — no thread.invite). status 0 = newly approved; 1 = idempotent no-op.
    const { status } = await this.friendship.approveFriendRequest(localId, foreignId);
    if (status === 0) {
      this.sse.onNotify(
        localId,
        serializeBody({ event: 'NOTIFY', type: 'FRIEND_APPROVED', byUserId: foreignId }),
      );
    }
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

  /** Validate a wire address has non-empty username + domain (defense against malformed peer input).
   *  The S2sSignatureGuard already bound from.domain==signer; this just guards the shape. */
  private requireAddress(a: S2SAddress): S2SAddress {
    if (!a || !a.username || !a.domain) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed address ${JSON.stringify(a)}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return a;
  }
}
