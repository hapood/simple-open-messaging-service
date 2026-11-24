import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { cooldownDeadline } from './federation-cooldown.js';
import { FederationCooldownError } from './federation-errors.js';
import {
  FEDERATION_NAMESPACE_PAUSED,
  FEDERATION_NAMESPACE_RESUMED,
  type FederationNamespaceSchedulingEvent,
} from './federation-peer.events.js';

export interface FederationCooldown {
  readonly until: number;
  readonly reason: string;
}

/** Process-local business admission. Trust and Health probes are independent of this pause. */
@Injectable()
export class FederationPeerRuntimeService {
  private readonly cooldowns = new Map<number, FederationCooldown>();

  constructor(private readonly events: EventEmitter2) {}

  getCooldown(namespaceId: number): FederationCooldown | null {
    return this.cooldowns.get(namespaceId) ?? null;
  }

  cooldownNamespaceIds(): number[] {
    return [...this.cooldowns.keys()];
  }

  assertBusinessAllowed(namespaceId: number): void {
    const cooldown = this.getCooldown(namespaceId);
    // Expiry alone never admits work; a periodic successful Health must clear it.
    if (cooldown) {
      throw new FederationCooldownError(
        namespaceId,
        cooldown.until,
        cooldown.reason,
      );
    }
  }

  async enterCooldown(
    namespaceId: number,
    reason: string,
    retryAfter: unknown,
  ): Promise<void> {
    if (!Number.isSafeInteger(namespaceId) || namespaceId <= 0) {
      throw new Error('cooldown requires a remote namespace');
    }
    const previous = this.getCooldown(namespaceId);
    const until = cooldownDeadline(
      new Date(),
      retryAfter,
      previous === null ? null : new Date(previous.until),
    ).getTime();
    this.cooldowns.set(namespaceId, Object.freeze({ until, reason }));
    // Publish only after admission is closed. Consumers must not await the cancelled worker.
    await this.events.emitAsync(FEDERATION_NAMESPACE_PAUSED, {
      namespaceId,
    } satisfies FederationNamespaceSchedulingEvent);
  }

  async completePeriodicHealth(
    namespaceId: number,
    observed: FederationCooldown | null,
    available: boolean,
  ): Promise<void> {
    if (
      !available ||
      observed === null ||
      this.cooldowns.get(namespaceId) !== observed ||
      Date.now() < observed.until
    ) {
      return;
    }
    // Object identity rejects a new/extended pause received while Health was in flight.
    this.cooldowns.delete(namespaceId);
    await this.events.emitAsync(FEDERATION_NAMESPACE_RESUMED, {
      namespaceId,
    } satisfies FederationNamespaceSchedulingEvent);
  }
}
