import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { asc } from 'drizzle-orm';
import { federatedPeer } from '../database/schema.js';
import { DatabaseService } from '../database/database.service.js';
import {
  FederationFeedFillState,
  FederationMessageFeedIndexerService,
} from './federation-message-feed-indexer.service.js';
import { FederationCursorService } from './federation-cursor.service.js';
import { FEDERATION_MESSAGE_FEED_ADVANCED } from './federation-message-feed.events.js';
import { FederationMessageTombstoneFeedService } from './federation-message-tombstone-feed.service.js';

const MAX_CONCURRENT_PEERS = 4;
export const FEDERATION_PEER_FILL_QUANTUM = 500;

/** Process-global round-robin scheduler. Each peer gets one bounded scan quantum before unfinished
 * work returns to the queue tail. Runtime work is event-driven; FULL/CAUGHT_UP peers are not polled. */
@Injectable()
export class FederationFeedFulfiller implements OnModuleInit {
  private readonly logger = new Logger(FederationFeedFulfiller.name);
  private readonly pending: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  private drainScheduled = false;
  private readonly tombstoneFirst = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly messageIndexer: FederationMessageFeedIndexerService,
    private readonly tombstoneFeed: FederationMessageTombstoneFeedService,
    private readonly cursor: FederationCursorService,
    private readonly events: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduleStartupRebuild();
  }

  schedule(peerDomain: string): void {
    if (
      this.messageIndexer.state(peerDomain) !==
        FederationFeedFillState.NEEDS_FILL &&
      this.tombstoneFeed.state(peerDomain) !==
        FederationFeedFillState.NEEDS_FILL
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
    const messageState = await this.messageIndexer.fill(peerDomain);
    const tombstoneState = await this.tombstoneFeed.fill(peerDomain);
    return messageState === FederationFeedFillState.FULL ||
      tombstoneState === FederationFeedFillState.FULL
      ? FederationFeedFillState.FULL
      : FederationFeedFillState.CAUGHT_UP;
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
            `could not advance compacted feeds for ${peerDomain}: ${(error as Error).message}`,
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
    let remaining = FEDERATION_PEER_FILL_QUANTUM;
    const tombstoneFirst = this.tombstoneFirst.delete(peerDomain);
    let messageState = this.messageIndexer.state(peerDomain);
    let tombstoneState = this.tombstoneFeed.state(peerDomain);
    if (tombstoneFirst) {
      if (tombstoneState === FederationFeedFillState.NEEDS_FILL) {
        const tombstones = await this.tombstoneFeed.fillQuantum(
          peerDomain,
          remaining,
        );
        tombstoneState = tombstones.state;
        remaining -= tombstones.work;
      }
      if (messageState === FederationFeedFillState.NEEDS_FILL) {
        const messages = await this.messageIndexer.fillQuantum(
          peerDomain,
          remaining,
        );
        messageState = messages.state;
      }
    } else {
      if (messageState === FederationFeedFillState.NEEDS_FILL) {
        const messages = await this.messageIndexer.fillQuantum(
          peerDomain,
          remaining,
        );
        messageState = messages.state;
        remaining -= messages.work;
      }
      if (tombstoneState === FederationFeedFillState.NEEDS_FILL) {
        const tombstones = await this.tombstoneFeed.fillQuantum(
          peerDomain,
          remaining,
        );
        tombstoneState = tombstones.state;
      }
      this.tombstoneFirst.add(peerDomain);
    }
    const after = await this.cursor.readAllocatedThrough(peerDomain);
    if (after > before) {
      this.events.emit(FEDERATION_MESSAGE_FEED_ADVANCED, { peerDomain });
    }
    if (
      messageState === FederationFeedFillState.NEEDS_FILL ||
      tombstoneState === FederationFeedFillState.NEEDS_FILL
    ) {
      this.schedule(peerDomain);
    }
  }
}
