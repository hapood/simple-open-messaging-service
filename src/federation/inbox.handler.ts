import { Injectable, HttpStatus } from '@nestjs/common';
import { Prisma } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma.service.js';
import { FriendshipService } from '../friendship/friendship.service.js';
import { SseService } from '../gateway/sse.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { FederationService, type S2SEnvelope, type S2SActor } from './federation.service.js';

/**
 * Inbound S2S envelope router. The S2sSignatureGuard already verified the signature + allow-list +
 * from.domain==signer.binding; this handler dedupes (at-least-once → idempotent) then routes by type.
 * PURELY inbound — no outbound fan-out (each server owns its own thread; no thread.invite). The friend
 * ops it calls (makeFriendRequest / approveFriendRequest) are themselves idempotent, so a redelivered
 * envelope (after the guard's signature check) is safe. The sender's profile (avatar/name/bio) is
 * embedded on the envelope, so the foreign stub is localized inline — no nested S2S GET inside the
 * inbox (which would double inbound latency and risk a call-timeout).
 *
 * friend.delete is intentionally NOT handled — unfriending is LOCAL-ONLY (no S2S notification); a peer
 * discovers a severed edge lazily via rejection-on-send in Step 2. A legacy peer sending friend.delete
 * gets FEDERATION_TYPE_UNSUPPORTED (422), which is acceptable for a same-version pre-release fleet.
 *
 * Error handling: NOT_FOUND (404, permanent) when a referenced local user doesn't exist;
 * FEDERATION_TYPE_UNSUPPORTED (422, permanent) for envelope types Step 1 doesn't handle; everything
 * else is happy-path. Duplicate envelopes are silently acked (idempotent success), never re-processed.
 */
@Injectable()
export class InboxHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly friendship: FriendshipService,
    private readonly sse: SseService,
    private readonly federation: FederationService,
  ) {}

  async handle(envelope: S2SEnvelope): Promise<void> {
    // Idempotent dedup by (origin, id) — a retried sync send must not double-process.
    if (await this.isDuplicate(envelope.origin, envelope.id)) return;
    switch (envelope.type) {
      case 'friend.request':
        return this.handleFriendRequest(envelope);
      case 'friend.approve':
        return this.handleFriendApprove(envelope);
      default:
        throw new BusinessException(
          BusinessCode.FEDERATION_TYPE_UNSUPPORTED,
          `envelope type "${envelope.type}" not supported`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
    }
  }

  /** True if (origin, envelopeId) already applied. Race-safe (P2002 = concurrent duplicate). */
  private async isDuplicate(origin: string, envelopeId: string): Promise<boolean> {
    const existing = await this.prisma.s2SInboxSeen.findUnique({
      where: { origin_envelopeId: { origin, envelopeId } },
    });
    if (existing) return true;
    try {
      await this.prisma.s2SInboxSeen.create({ data: { origin, envelopeId } });
      return false;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return true;
      throw e;
    }
  }

  /** Inbound friend.request: remote user wants to add our local user. The envelope carries the
   *  requester's profile, so the stub is localized (avatar/name/bio) inline — no extra fetch. */
  private async handleFriendRequest(env: S2SEnvelope): Promise<void> {
    const from = this.requireActor(env.from); // the remote requester → foreign stub
    const to = this.requireActor(env.to[0]); // the local target
    const foreignId = await this.federation.ensureForeignUser(from.username, from.domain);
    if (env.profile) {
      await this.federation.localizeForeignProfile(foreignId, env.profile);
    }
    const localId = await this.federation.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${env.to[0].username} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    const { status } = await this.friendship.makeFriendRequest(foreignId, localId, env.message ?? '');
    // status 0/2/3 = new / re-armed / mutual-auto → surface to the local user. (1=already friends, 5=idempotent/blocked → no SSE.)
    if (status === 0 || status === 2 || status === 3) {
      this.sse.onNotify(
        localId,
        serializeBody({ event: 'NOTIFY', type: 'FRIEND_REQUEST', fromUserId: foreignId }),
      );
    }
  }

  /** Inbound friend.approve: remote user approved our local user's request. Pure state change — NO
   *  profile localization (the requester's stub of the approver was created at resolve time; any later
   *  profile change is picked up lazily by the chat-open /revision probe). Just ensure the approver
   *  stub exists + create THIS server's own P2P thread (each-server-own-thread model). */
  private async handleFriendApprove(env: S2SEnvelope): Promise<void> {
    const from = this.requireActor(env.from); // the remote approver → foreign stub
    const to = this.requireActor(env.to[0]); // the local requester
    const foreignId = await this.federation.ensureForeignUser(from.username, from.domain);
    const localId = await this.federation.findLocalUserIdByAddress(to);
    if (localId === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `local user ${env.to[0].username} not found`,
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

  /** Validate a wire actor has non-empty username + domain (defense against malformed peer input).
   *  The S2sSignatureGuard already bound from.domain==signer; this just guards the shape. */
  private requireActor(a: S2SActor): S2SActor {
    if (!a || !a.username || !a.domain) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed actor ${JSON.stringify(a)}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return a;
  }
}
