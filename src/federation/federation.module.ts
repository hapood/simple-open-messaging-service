import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { KeypairService } from './keypair.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { FederationService } from './federation.service.js';
import { FederationBufferService } from './federation-buffer.service.js';
import { FederationReconnectService } from './federation-reconnect.service.js';
import { S2sController } from './s2s.controller.js';
import { S2sInitController } from './s2s-init.controller.js';
import { WellKnownController } from './well-known.controller.js';
import { InviteModule } from '../invite/invite.module.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { MessageModule } from '../message/message.module.js';
import { LinkPreviewModule } from '../link-preview/link-preview.module.js';
import { ForwardBundleModule } from '../forward/forward-bundle.module.js';

/**
 * Federation (S2S). @Global so its services inject across modules (UserController, AdminController).
 * FederationService needs InviteService (InviteModule, unified invite deliver/accept), MessageService
 * (MessageModule, card write on outbound group invite), ThreadParticipantService (relationship reads +
 * raw roster mutators), SseService (GatewayModule), + UploadModule (avatar wire helpers). PrismaService
 * is provided globally by PrismaModule.
 *
 * Two S2S controllers share the `s2s` prefix: S2sController (unified invite + roster + signed GETs,
 * allow-list-gated via S2sSignatureGuard) and S2sInitController (POST /s2s/init — the trust bootstrap,
 * NOT allow-list-gated since it IS the trust step; verifies via S2sVerifyService directly).
 */
@Global()
@Module({
  imports: [
    // EventEmitterModule is NOT global (only forRoot() lives in AppModule) — import it here so
    // FederationService can emitAsync('call.frame.inbound') for the inbound S2S call bridge.
    EventEmitterModule,
    InviteModule,
    ThreadParticipantModule,
    GatewayModule,
    UploadModule,
    MessageModule,
    LinkPreviewModule,
    ForwardBundleModule,
  ],
  controllers: [WellKnownController, S2sController, S2sInitController],
  providers: [
    KeypairService,
    SignatureService,
    DiscoveryService,
    S2sVerifyService,
    FederationService,
    FederationBufferService,
    FederationReconnectService,
  ],
  exports: [
    KeypairService,
    SignatureService,
    DiscoveryService,
    FederationService,
    FederationBufferService,
  ],
})
export class FederationModule {}
