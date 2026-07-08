import { Global, Module } from '@nestjs/common';
import { KeypairService } from './keypair.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { FederationService } from './federation.service.js';
import { InboxHandler } from './inbox.handler.js';
import { S2sController } from './s2s.controller.js';
import { S2sInitController } from './s2s-init.controller.js';
import { WellKnownController } from './well-known.controller.js';
import { PrismaService } from '../prisma.service.js';
import { FriendshipModule } from '../friendship/friendship.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { UploadModule } from '../upload/upload.module.js';

/**
 * Federation (S2S). @Global so its services inject across modules (UserController in Phase D,
 * AdminController in Phase E). InboxHandler needs FriendshipService (FriendshipModule) + SseService
 * (GatewayModule), so those are imported here. UploadModule provides the avatar wire helpers
 * (readAvatarAsWire / saveAvatarFromWire) used by FederationService (outbound profile + inbound
 * localization). PrismaService is provided here (not @Global).
 *
 * Two S2S controllers share the `s2s` prefix: S2sController (inbox + signed GETs, allow-list-gated via
 * S2sSignatureGuard) and S2sInitController (POST /s2s/init — the trust-establishment bootstrap, NOT
 * allow-list-gated since it IS the trust step; it verifies via S2sVerifyService directly).
 */
@Global()
@Module({
  imports: [FriendshipModule, GatewayModule, UploadModule],
  controllers: [WellKnownController, S2sController, S2sInitController],
  providers: [
    KeypairService,
    SignatureService,
    DiscoveryService,
    S2sVerifyService,
    FederationService,
    InboxHandler,
    PrismaService,
  ],
  exports: [KeypairService, SignatureService, DiscoveryService, FederationService],
})
export class FederationModule {}
