import { Global, Module } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { KeypairService } from './keypair.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { FederationService } from './federation.service.js';
import { GroupMembershipProjectionService } from '../group/business/membership-intent/shared/group-membership-projection.service.js';
import { FederationGroupMetaClient } from './federation-group-meta-client.service.js';
import { FederationGroupRequestProjectionService } from './federation-group-request-projection.service.js';
import { GroupRelationshipFoldService } from '../group/business/membership-intent/shared/group-relationship-fold.service.js';
import { FederationReconnectService } from './federation-reconnect.service.js';
import { S2sController } from './s2s.controller.js';
import { S2sRecognitionController } from './s2s-recognition.controller.js';
import { WellKnownController } from './well-known.controller.js';
import { RelationshipModule } from '../relationship/business/relationship.module.js';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { UploadModule } from '../upload/upload.module.js';
import { MessageModule } from '../message/message.module.js';
import { QuoteResolutionController } from './quote-resolution.controller.js';
import { QuoteResolutionCoordinatorService } from './quote-resolution-coordinator.service.js';
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
import { FederationGroupMetaFeedService } from './group-meta-feed.service.js';
import { GroupMetaFeedService } from '../group/business/meta/group-meta-feed.service.js';
import { FederationThreadMetaRoundExecutorService } from './federation-thread-meta-round-executor.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { FederationThreadForwardRoundService } from './federation-thread-forward-round.service.js';
import { FederationThreadReverseRoundService } from './federation-thread-reverse-round.service.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import { FederationThreadRoundSchedulerService } from './federation-thread-round-scheduler.service.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';
import { FederationThreadFanoutTaskHandler } from './federation-thread-fanout-task.handler.js';
import { GroupRelationshipMutationService } from '../group/business/membership-intent/shared/group-relationship-mutation.service.js';
import { FederationNamespaceService } from './federation-namespace.service.js';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { FederationHealthSchedulerService } from './federation-health-scheduler.service.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationInboundFileSync } from './federation-inbound-file-sync.js';
import { FederationPendingMediaPromoter } from './federation-pending-media-promoter.js';
import { FederationUserDirectoryService } from './federation-user-directory.service.js';
import { FederationCallBridgeService } from './federation-call-bridge.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import { FederationThreadResourceClient } from './federation-thread-resource-client.service.js';
import { FederationProfileService } from './federation-profile.service.js';
import { FederationMediaLocalizationService } from './federation-media-localization.service.js';
import { FederationInboundMessageStoreService } from './federation-inbound-message-store.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';
import { FederationInboundMessagePageService } from './federation-inbound-message-page.service.js';
import { FederationLocalSystemMessagePublisher } from './federation-local-system-message-publisher.service.js';
import { FederationStatePullService } from './federation-state-pull.service.js';
import { FederationStateFeedHeadClient } from './federation-state-feed-head-client.service.js';
import { FederationStateFeedPushSchedulerService } from './federation-state-feed-push-scheduler.service.js';
import { FederationPeerResourceService } from './federation-peer-resource.service.js';
import { FederationInboundMessageCommitService } from './federation-inbound-message-commit.service.js';
import { ProfileResolutionCoordinatorService } from './profile-resolution-coordinator.service.js';
import { ProfileResolutionController } from './profile-resolution.controller.js';
import { FederationThreadQueryDenialService } from './federation-thread-query-denial.service.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';
import { FederationDownloadAdminService } from './federation-download-admin.service.js';
import { DurableTaskModule } from '../durable-task/durable-task.module.js';
import { AuthoritativeMembershipFinalizerService } from '../group/business/membership-intent/shared/authoritative-membership-finalizer.service.js';
import { UserIntentService } from '../user/business/p2p-intent/authored/user-intent.service.js';
import { ReceivedUserIntentService } from '../user/business/p2p-intent/received/received-user-intent.service.js';
import { RemoteMemberMembershipIntentService } from '../group/business/membership-intent/received/remote-member-membership-intent.service.js';
import { MirrorGroupMembershipIntentService } from '../group/business/membership-intent/received/mirror-group-membership-intent.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';

/**
 * Federation (S2S). @Global so its services inject across modules (UserController, AdminController).
 * FederationService needs RelationshipService (RelationshipModule, unified relationship transitions), MessageService
 * (MessageModule, card write on outbound group invite), AccountThreadStateService (relationship reads +
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
    RelationshipModule,
    AccountThreadStateModule,
    GatewayModule,
    UploadModule,
    MessageModule,
    LinkPreviewModule,
    ForwardBundleModule,
    DurableTaskModule,
  ],
  controllers: [
    WellKnownController,
    S2sController,
    S2sRecognitionController,
    ProfileResolutionController,
    QuoteResolutionController,
  ],
  providers: [
    {
      provide: UserIntentService,
      inject: [
        DatabaseService,
        ClientStateFeedService,
        PeerStateFeedService,
        EventEmitter2,
        FederationNamespaceService,
      ],
      useFactory: (
        database: DatabaseService,
        clientFeed: ClientStateFeedService,
        peerFeed: PeerStateFeedService,
        events: EventEmitter2,
        namespaces: FederationNamespaceService,
      ) =>
        new UserIntentService({
          database,
          clientFeed,
          peerFeed,
          federation: {
            async pushStateFeedDomains(domains) {
              for (const peerDomain of new Set(domains))
                events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
            },
          },
          namespaces,
        }),
    },
    {
      provide: ReceivedUserIntentService,
      inject: [
        DatabaseService,
        ClientStateFeedService,
        PeerStateFeedService,
        EventEmitter2,
        UserIntentService,
      ],
      useFactory: (
        database: DatabaseService,
        clientFeed: ClientStateFeedService,
        peerFeed: PeerStateFeedService,
        events: EventEmitter2,
        userIntents: UserIntentService,
      ) =>
        new ReceivedUserIntentService({
          database,
          clientFeed,
          peerFeed,
          federation: {
            async pushStateFeedDomains(domains) {
              for (const peerDomain of new Set(domains))
                events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
            },
          },
          userIntents,
        }),
    },
    {
      provide: RemoteMemberMembershipIntentService,
      inject: [
        DatabaseService,
        ClientStateFeedService,
        PeerStateFeedService,
        EventEmitter2,
        GroupRelationshipMutationService,
      ],
      useFactory: (
        database: DatabaseService,
        clientFeed: ClientStateFeedService,
        peerFeed: PeerStateFeedService,
        events: EventEmitter2,
        relationshipMutations: GroupRelationshipMutationService,
      ) =>
        new RemoteMemberMembershipIntentService({
          database,
          clientFeed,
          peerFeed,
          federation: {
            async pushStateFeedDomains(domains) {
              for (const peerDomain of new Set(domains))
                events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
            },
          },
          relationshipMutations,
        }),
    },
    {
      provide: MirrorGroupMembershipIntentService,
      inject: [
        DatabaseService,
        ClientStateFeedService,
        PeerStateFeedService,
        EventEmitter2,
        GroupRelationshipMutationService,
      ],
      useFactory: (
        database: DatabaseService,
        clientFeed: ClientStateFeedService,
        peerFeed: PeerStateFeedService,
        events: EventEmitter2,
        memberMutations: GroupRelationshipMutationService,
      ) =>
        new MirrorGroupMembershipIntentService({
          database,
          clientFeed,
          peerFeed,
          federation: {
            async pushStateFeedDomains(domains) {
              for (const peerDomain of new Set(domains))
                events.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
            },
          },
          memberMutations,
        }),
    },
    FederationThreadFanoutTaskHandler,
    KeypairService,
    SignatureService,
    DiscoveryService,
    S2sVerifyService,
    S2sSignatureGuard,
    FederationPeerLifecycle,
    FederationHealthSchedulerService,
    FederationPeerHttp,
    ProfileResolutionCoordinatorService,
    QuoteResolutionCoordinatorService,
    FederationMediaRangeClient,
    FederationInboundFileSync,
    FederationPendingMediaPromoter,
    FederationInboundMediaBatchService,
    FederationDownloadAdminService,
    FederationUserDirectoryService,
    FederationCallBridgeService,
    FederationThreadAccessService,
    FederationTrustedPeerClient,
    FederationThreadResourceClient,
    FederationProfileService,
    FederationMediaLocalizationService,
    FederationInboundMessageStoreService,
    FederationInboundMessageRouteService,
    FederationInboundMessageValidatorService,
    FederationInboundMessagePageService,
    FederationLocalSystemMessagePublisher,
    FederationStatePullService,
    FederationStateFeedHeadClient,
    FederationStateFeedPushSchedulerService,
    FederationPeerResourceService,
    FederationInboundMessageCommitService,
    FederationThreadQueryDenialService,
    FederationService,
    GroupMembershipProjectionService,
    AuthoritativeMembershipFinalizerService,
    FederationGroupMetaClient,
    FederationThreadMetaRoundExecutorService,
    FederationGroupRequestProjectionService,
    GroupRelationshipFoldService,
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
    FederationGroupMetaFeedService,
    FederationThreadSyncStateService,
    FederationThreadForwardRoundService,
    FederationThreadReverseRoundService,
    FederationThreadSourceService,
    FederationThreadForwardRoundExecutorService,
    FederationThreadReverseRoundExecutorService,
    FederationThreadRoundSchedulerService,
    FederationThreadContentHeadService,
    GroupRelationshipMutationService,
    FederationNamespaceService,
    ProfileResolutionCoordinatorService,
    FederationStateFeedConsumerService,
  ],
  exports: [
    UserIntentService,
    ReceivedUserIntentService,
    RemoteMemberMembershipIntentService,
    MirrorGroupMembershipIntentService,
    FederationThreadQueryDenialService,
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
    FederationDownloadAdminService,
    PeerStateFeedService,
    PeerStateFeedPullService,
    GroupMetaFeedService,
    FederationGroupMetaFeedService,
    FederationThreadSyncStateService,
    FederationThreadForwardRoundService,
    FederationThreadReverseRoundService,
    FederationThreadSourceService,
    FederationThreadForwardRoundExecutorService,
    FederationThreadReverseRoundExecutorService,
    FederationThreadRoundSchedulerService,
    FederationThreadContentHeadService,
    GroupRelationshipMutationService,
    FederationNamespaceService,
  ],
})
export class FederationModule {}
