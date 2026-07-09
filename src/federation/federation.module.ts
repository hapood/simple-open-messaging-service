import { Global, Module } from '@nestjs/common';
import { KeypairService } from './keypair.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { FederationService } from './federation.service.js';
import { FederationBufferService } from './federation-buffer.service.js';
import { FederationReconnectService } from './federation-reconnect.service.js';
import { FriendOpHandler } from './friend-op.handler.js';
import { S2sController } from './s2s.controller.js';
import { S2sInitController } from './s2s-init.controller.js';
import { WellKnownController } from './well-known.controller.js';
import { InviteModule } from '../invite/invite.module.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { MessageModule } from '../message/message.module.js';

/**
 * Federation (S2S). @Global so its services inject across modules (UserController in Phase D,
 * AdminController in Phase E). FriendOpHandler needs InviteService (InviteModule) + SseService
 * (GatewayModule); FederationService needs ThreadParticipantService (relationship reads — the friend
 * gate + message-serving authz, now that the Friendship table is gone). UploadModule provides the
 * avatar wire helpers (readAvatarAsWire / saveAvatarFromWire) used by FederationService. PrismaService
 * is provided globally by PrismaModule (src/prisma.module.ts).
 *
 * Two S2S controllers share the `s2s` prefix: S2sController (friend-op + signed GETs, allow-list-gated via
 * S2sSignatureGuard) and S2sInitController (POST /s2s/init — the trust-establishment bootstrap, NOT
 * allow-list-gated since it IS the trust step; it verifies via S2sVerifyService directly).
 */
@Global()
@Module({
  imports: [InviteModule, ThreadParticipantModule, GatewayModule, UploadModule, MessageModule],
  controllers: [WellKnownController, S2sController, S2sInitController],
  providers: [
    KeypairService,
    SignatureService,
    DiscoveryService,
    S2sVerifyService,
    FederationService,
    FederationBufferService,
    FederationReconnectService,
    FriendOpHandler,
  ],
  exports: [KeypairService, SignatureService, DiscoveryService, FederationService, FederationBufferService],
})
export class FederationModule {}
