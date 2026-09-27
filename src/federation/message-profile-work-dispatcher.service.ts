import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  MESSAGE_PROFILE_WORK_COMMITTED,
  type MessageProfileWorkCommittedEvent,
} from '../message/message-profile-work.event.js';
import { ProfileEvidenceProjectionService } from '../profile-resolution/profile-evidence-projection.service.js';
import { ProfileResolutionCoordinatorService } from '../profile-resolution/profile-resolution-coordinator.service.js';

@Injectable()
export class MessageProfileWorkDispatcherService {
  private readonly logger = new Logger(MessageProfileWorkDispatcherService.name);

  constructor(
    private readonly profileResolutions: ProfileResolutionCoordinatorService,
    private readonly profileEvidenceProjections: ProfileEvidenceProjectionService,
  ) {}

  @OnEvent(MESSAGE_PROFILE_WORK_COMMITTED)
  dispatch(event: MessageProfileWorkCommittedEvent): void {
    for (const demand of event.demands) {
      void this.profileResolutions.resolveDemand(demand).catch((error) => {
        this.logger.warn(
          `failed to enqueue committed message profile demand: ${(error as Error).message}`,
        );
      });
    }
    for (const projection of event.evidenceProjections) {
      void this.profileEvidenceProjections.resolve(projection).catch((error) => {
        this.logger.warn(
          `failed to enqueue committed message profile evidence projection: ${(error as Error).message}`,
        );
      });
    }
  }
}
