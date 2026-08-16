import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { KeypairService } from './keypair.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { FederationService } from './federation.service.js';
import { FederationReconnectService } from './federation-reconnect.service.js';
import { S2sController } from './s2s.controller.js';
import { S2sRecognitionController } from './s2s-recognition.controller.js';
import { WellKnownController } from './well-known.controller.js';
import { InviteModule } from '../invite/invite.module.js';
import { ThreadParticipantModule } from '../thread-participant/thread-participant.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { MessageModule } from '../message/message.module.js';
import { LinkPreviewModule } from '../link-preview/link-preview.module.js';
import { ForwardBundleModule } from '../forward/forward-bundle.module.js';
import { FederationCursorService } from './federation-cursor.service.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { FederationMessageFeedService } from './federation-message-feed.service.js';
import { FederationMessageFeedPullService } from './federation-message-feed-pull.service.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import { FederationDownloadRecoveryService } from './federation-download-recovery.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import { GroupMembershipStateService } from '../group/group-membership-state.service.js';
import { FederationMessageFeedIndexerService } from './federation-message-feed-indexer.service.js';
import { FederationFeedFulfiller } from './federation-feed-fulfiller.service.js';
import { S2sSignatureGuard } from './s2s-signature.guard.js';
import { FederationMessageTombstoneFeedService } from './federation-message-tombstone-feed.service.js';
import { FederationMessageTombstonePullService } from './federation-message-tombstone-pull.service.js';
import { FederationHttpScheduler } from './federation-http-scheduler.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';

/**
 * Federation (S2S). @Global so its services inject across modules (UserController, AdminController).
 * FederationService needs InviteService (InviteModule, unified invite deliver/accept), MessageService
 * (MessageModule, card write on outbound group invite), ThreadParticipantService (relationship reads +
 * raw roster mutators), SseService (GatewayModule), + UploadModule (avatar wire helpers). DatabaseService
 * is provided globally by DatabaseModule.
 *
 * Two S2S controllers share the `s2s/v1` prefix: S2sController (unified invite + roster + signed GETs,
 * allow-list-gated via S2sSignatureGuard) and S2sRecognitionController (bidirectional Recognize + Healthy).
 * The lightweight v1 capability exchange lives on S2sController with the same directional gate as feed-heads.
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
  controllers: [WellKnownController, S2sController, S2sRecognitionController],
  providers: [
    KeypairService,
    SignatureService,
    DiscoveryService,
    S2sVerifyService,
    S2sSignatureGuard,
    FederationService,
    FederationReconnectService,
    FederationCursorService,
    FederationRecognitionService,
    FederationMessageFeedService,
    FederationMessageFeedPullService,
    FederationMessageTombstoneFeedService,
    FederationMessageTombstonePullService,
    FederationMessageFeedIndexerService,
    FederationFeedFulfiller,
    FederationDownloadScheduler,
    FederationHttpScheduler,
    FederationTransportConfigService,
    FederationDownloadRecoveryService,
    PeerStateFeedService,
    PeerStateFeedPullService,
    GroupMembershipStateService,
  ],
  exports: [
    KeypairService,
    SignatureService,
    DiscoveryService,
    FederationService,
    FederationCursorService,
    FederationRecognitionService,
    FederationMessageFeedService,
    FederationMessageFeedPullService,
    FederationMessageTombstoneFeedService,
    FederationMessageTombstonePullService,
    FederationMessageFeedIndexerService,
    FederationFeedFulfiller,
    FederationDownloadScheduler,
    FederationHttpScheduler,
    FederationTransportConfigService,
    FederationDownloadRecoveryService,
    PeerStateFeedService,
    PeerStateFeedPullService,
    GroupMembershipStateService,
  ],
})
export class FederationModule {}
