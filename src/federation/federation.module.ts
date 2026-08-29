import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { KeypairService } from './keypair.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { FederationService } from './federation.service.js';
import { FederationGroupMembershipService } from './federation-group-membership.service.js';
import { FederationGroupRequestProjectionService } from './federation-group-request-projection.service.js';
import { FederationGroupRelationshipService } from './federation-group-relationship.service.js';
import { FederationGroupRosterProjectionService } from './federation-group-roster-projection.service.js';
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
import { FederationRecognitionService } from './federation-recognition.service.js';
import { FederationMessageFeedService } from './federation-message-feed.service.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import { FederationDownloadRecoveryService } from './federation-download-recovery.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import { S2sSignatureGuard } from './s2s-signature.guard.js';
import { FederationMessageTombstoneFeedService } from './federation-message-tombstone-feed.service.js';
import { FederationHttpScheduler } from './federation-http-scheduler.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { GroupMetaFeedService } from './group-meta-feed.service.js';
import { DepartedMemberProfileQueryService } from './departed-member-profile-query.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { FederationThreadForwardRoundService } from './federation-thread-forward-round.service.js';
import { FederationThreadReverseRoundService } from './federation-thread-reverse-round.service.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FederationDepartedMemberProfileConsumerService } from './federation-departed-member-profile-consumer.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import { FederationThreadRoundSchedulerService } from './federation-thread-round-scheduler.service.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';
import { FederationProfileStatePublisher } from './federation-profile-state-publisher.service.js';
import { FederationRelationshipCommandService } from './federation-relationship-command.service.js';
import { FederationNamespaceService } from './federation-namespace.service.js';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';

/**
 * Federation (S2S). @Global so its services inject across modules (UserController, AdminController).
 * FederationService needs InviteService (InviteModule, unified invite deliver/accept), MessageService
 * (MessageModule, card write on outbound group invite), ThreadParticipantService (relationship reads +
 * raw roster mutators), SseService (GatewayModule), + UploadModule (avatar wire helpers). DatabaseService
 * is provided globally by DatabaseModule.
 *
 * Two S2S controllers share the `s2s/v1` prefix: S2sController (unified invite + roster + signed GETs,
 * allow-list-gated via S2sSignatureGuard) and S2sRecognitionController (bidirectional Recognize + Health).
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
    FederationGroupMembershipService,
    FederationGroupRequestProjectionService,
    FederationGroupRelationshipService,
    FederationGroupRosterProjectionService,
    FederationReconnectService,
    FederationRecognitionService,
    FederationMessageFeedService,
    FederationMessageTombstoneFeedService,
    FederationDownloadScheduler,
    FederationHttpScheduler,
    FederationTransportConfigService,
    FederationDownloadRecoveryService,
    PeerStateFeedService,
    PeerStateFeedPullService,
    GroupMetaFeedService,
    DepartedMemberProfileQueryService,
    FederationThreadSyncStateService,
    FederationThreadForwardRoundService,
    FederationThreadReverseRoundService,
    FederationThreadSourceService,
    FederationThreadForwardRoundExecutorService,
    FederationDepartedMemberProfileConsumerService,
    FederationThreadReverseRoundExecutorService,
    FederationThreadRoundSchedulerService,
    FederationThreadContentHeadService,
    FederationProfileStatePublisher,
    FederationRelationshipCommandService,
    FederationNamespaceService,
    FederationStateFeedConsumerService,
  ],
  exports: [
    KeypairService,
    SignatureService,
    DiscoveryService,
    FederationService,
    FederationRecognitionService,
    FederationMessageFeedService,
    FederationMessageTombstoneFeedService,
    FederationDownloadScheduler,
    FederationHttpScheduler,
    FederationTransportConfigService,
    FederationDownloadRecoveryService,
    PeerStateFeedService,
    PeerStateFeedPullService,
    GroupMetaFeedService,
    DepartedMemberProfileQueryService,
    FederationThreadSyncStateService,
    FederationThreadForwardRoundService,
    FederationThreadReverseRoundService,
    FederationThreadSourceService,
    FederationThreadForwardRoundExecutorService,
    FederationDepartedMemberProfileConsumerService,
    FederationThreadReverseRoundExecutorService,
    FederationThreadRoundSchedulerService,
    FederationThreadContentHeadService,
    FederationProfileStatePublisher,
    FederationRelationshipCommandService,
    FederationNamespaceService,
  ],
})
export class FederationModule {}
