import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { asc } from 'drizzle-orm';
import { federatedPeer } from '../database/schema.js';
import { DatabaseService } from '../database/database.service.js';
import {
  FederationFeedFillState,
  FederationMemoryFeedService,
} from './federation-memory-feed.service.js';
import { FederationCursorService } from './federation-cursor.service.js';
import { FEDERATION_MEMORY_FEED_ADVANCED } from './federation-memory-feed.events.js';

const MAX_CONCURRENT_PEERS = 4;

/** Fair, process-global startup scheduler. Runtime work is driven by transactional PostgreSQL message
 * notifications, active post-commit offers and peer ACKs; FULL/CAUGHT_UP peers are never polled. */
@Injectable()
export class FederationFeedFulfiller implements OnModuleInit {
  private readonly logger = new Logger(FederationFeedFulfiller.name);
  private readonly pending: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  private drainScheduled = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly memoryFeed: FederationMemoryFeedService,
    private readonly cursor: FederationCursorService,
    private readonly events: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduleStartupRebuild();
  }

  schedule(peerDomain: string): void {
    if (
      this.memoryFeed.state(peerDomain) !== FederationFeedFillState.NEEDS_FILL
    ) {
      return;
    }
    if (this.queued.has(peerDomain)) return;
    this.queued.add(peerDomain);
    this.pending.push(peerDomain);
    this.scheduleDrain();
  }

  async fillNow(peerDomain: string): Promise<FederationFeedFillState> {
    this.queued.delete(peerDomain);
    return this.memoryFeed.fill(peerDomain);
  }

  private async scheduleStartupRebuild(): Promise<void> {
    const peers = await this.database.db
      .select({ domain: federatedPeer.domain })
      .from(federatedPeer)
      .orderBy(asc(federatedPeer.domain));
    for (const peer of peers) {
      this.schedule(peer.domain);
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENT_PEERS && this.pending.length > 0) {
      const peerDomain = this.pending.shift()!;
      if (!this.queued.delete(peerDomain)) continue;
      this.running++;
      void this.fillAndNotify(peerDomain)
        .catch((error: unknown) => {
          this.logger.warn(
            `could not fill memory feed for ${peerDomain}: ${(error as Error).message}`,
          );
        })
        .finally(() => {
          this.running--;
          this.scheduleDrain();
        });
    }
  }

  private async fillAndNotify(peerDomain: string): Promise<void> {
    const before = await this.cursor.readAllocatedThrough(peerDomain);
    await this.memoryFeed.fill(peerDomain);
    const after = await this.cursor.readAllocatedThrough(peerDomain);
    if (after > before) {
      this.events.emit(FEDERATION_MEMORY_FEED_ADVANCED, { peerDomain });
    }
  }
}
