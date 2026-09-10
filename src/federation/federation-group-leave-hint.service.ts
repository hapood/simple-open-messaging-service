import {
  groupState as groupStateTable,
  groupStateFields,
} from '../group/group-state.js';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';

/** Best-effort wake-up of a mirrored group origin after local departure. */
@Injectable()
export class FederationGroupLeaveHintService {
  private readonly logger = new Logger(FederationGroupLeaveHintService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly events: EventEmitter2,
  ) {}

  async notifyGroupLeave(threadId: number): Promise<void> {
    try {
      const [thread] = await this.database.db
        .select({ domain: groupStateFields.domain })
        .from(tables.messageThread)
        .innerJoin(
          groupStateTable,
          eq(groupStateTable.id, tables.messageThread.id),
        )
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      const originDomain = thread?.domain;
      if (!originDomain || originDomain === 'local') return;
      this.events.emit(FEDERATION_STATE_FEED_PUSH, {
        peerDomain: originDomain,
      });
    } catch (error) {
      this.logger.debug(
        `notifyGroupLeave(${threadId}) failed: ${(error as Error).message}`,
      );
    }
  }
}
