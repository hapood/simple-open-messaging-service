import {
  parseNotificationTarget,
  type NotificationTarget,
} from '../../../../shared/notification-target';

/** A tap identity is distinct from a thread identity (including repeated taps on one thread). */
export type ThreadNavigationIntent = {
  id: string;
  target?: NotificationTarget;
  /** Legacy native and browser adapters are normalized to a thread target. */
  threadId?: number;
  acknowledge?: () => void | Promise<void>;
} & ({ source: 'desktop' | 'android' } | { source: 'web'; sessionId: number });

export function validThreadNavigationId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647
  );
}

/** Latest intent wins. No navigation or acknowledgement before durable session hydration. */
export class ThreadNavigationIntentCoordinator {
  private pending?: {
    intent: ThreadNavigationIntent;
    target: NotificationTarget;
  };
  private readonly retired = new Set<string>();
  private key(intent: ThreadNavigationIntent): string {
    return `${intent.source}:${intent.id}`;
  }

  offer(intent: ThreadNavigationIntent): void {
    const target = parseNotificationTarget(
      intent.target === undefined
        ? { kind: 'thread', threadId: intent.threadId }
        : intent.target,
    );
    if (
      !target ||
      !intent.id ||
      (intent.source === 'web' && !validThreadNavigationId(intent.sessionId)) ||
      this.retired.has(this.key(intent))
    )
      return;
    if (this.pending && this.key(this.pending.intent) === this.key(intent))
      return;
    if (this.pending) this.retired.add(this.key(this.pending.intent));
    this.pending = { intent, target };
  }

  invalidate(): void {
    if (this.pending) this.retired.add(this.key(this.pending.intent));
    this.pending = undefined;
  }

  select(
    sessionId: number | null,
    ready: boolean,
    open: (target: NotificationTarget) => boolean,
  ): void {
    const pending = this.pending;
    if (!pending || sessionId === null) return;
    if (
      pending.intent.source === 'web' &&
      pending.intent.sessionId !== sessionId
    ) {
      this.invalidate();
      return;
    }
    if (!ready || !open(pending.target)) return;
    // Synchronous callbacks in the navigator may invalidate/replace the intent.
    if (this.pending !== pending) return;
    this.retired.add(this.key(pending.intent));
    this.pending = undefined;
    try {
      void Promise.resolve(pending.intent.acknowledge?.()).catch((error) =>
        console.warn('[notification] acknowledgement failed', error),
      );
    } catch (error) {
      console.warn('[notification] acknowledgement failed', error);
    }
  }
}
