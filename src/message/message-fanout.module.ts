import { Global, Module } from '@nestjs/common';
import { MessageFanoutService } from './message-fanout.service.js';
import { NotificationQueryService } from '../notification/notification-query.service.js';
import { NotificationActionService } from '../notification/notification-action.service.js';
import { AwayNotificationService } from '../notification/away-notification.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { PushModule } from '../push/push.module.js';
import { AccountThreadStateModule } from '../account-thread-state/account-thread-state.module.js';
import { MessageModule } from './message.module.js';
import { UserModule } from '../user/user.module.js';
import { GroupModule } from '../group/group.module.js';
import { UploadModule } from '../upload/upload.module.js';

/**
 * @Global so MessageController (text send), UploadController (staged-media promote), and any future
 * commit site can inject {@link MessageFanoutService} and run the unified post-commit fan-out.
 *
 * NotificationQueryService moves here from AppModule's providers (its dependencies — MessageService
 * (MessageModule), UserService, GroupService, AccountThreadStateService — are imported below). It stays
 * injectable app-wide because
 * this module is @Global.
 *
 * FederationService is injected by MessageFanoutService WITHOUT importing FederationModule:
 * FederationModule is itself @Global and exports FederationService. Importing it here would cycle
 * (FederationModule imports UploadModule + MessageModule, and the fan-out is consumed on the upload
 * path). Reading the global export sidesteps that.
 */
@Global()
@Module({
  imports: [
    GatewayModule,
    PushModule,
    AccountThreadStateModule,
    MessageModule,
    UserModule,
    GroupModule,
    UploadModule,
  ],
  providers: [
    MessageFanoutService,
    NotificationQueryService,
    AwayNotificationService,
    NotificationActionService,
  ],
  // NotificationQueryService + NotificationActionService are exported (and the module is @Global) so
  // NotificationController (registered in AppModule) can inject them app-wide.
  exports: [
    MessageFanoutService,
    AwayNotificationService,
    NotificationActionService,
  ],
})
export class MessageFanoutModule {}
