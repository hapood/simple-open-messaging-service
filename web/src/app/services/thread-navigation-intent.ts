/** A tap identity is distinct from a thread identity (including repeated taps on one thread). */
export interface ThreadNavigationIntent {
  source: 'android' | 'desktop' | 'web';
  id: string;
  threadId: number;
  sessionId: number;
  acknowledge?: () => void | Promise<void>;
}

export function validThreadNavigationId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

/** Latest intent wins. No navigation or acknowledgement before durable session hydration. */
export class ThreadNavigationIntentCoordinator {
  private pending?: { intent: ThreadNavigationIntent };
  private readonly retired = new Set<string>();
  private key(intent: ThreadNavigationIntent): string {
    return `${intent.source}:${intent.id}`;
  }

  offer(intent: ThreadNavigationIntent): void {
    if (!validThreadNavigationId(intent.threadId) || !intent.id ||
        !validThreadNavigationId(intent.sessionId) ||
        this.retired.has(this.key(intent))) return;
    if (this.pending && this.key(this.pending.intent) === this.key(intent)) return;
    if (this.pending) this.retired.add(this.key(this.pending.intent));
    this.pending = { intent };
  }

  invalidate(): void {
    if (this.pending) this.retired.add(this.key(this.pending.intent));
    this.pending = undefined;
  }

  select(sessionId: number | null, ready: boolean, open: (threadId: number) => boolean): void {
    const pending = this.pending;
    if (!pending || sessionId === null) return;
    if (pending.intent.sessionId !== sessionId) {
      this.invalidate();
      return;
    }
    if (!ready || !open(pending.intent.threadId)) return;
    // Synchronous callbacks in the navigator may invalidate/replace the intent.
    if (this.pending !== pending) return;
    this.retired.add(this.key(pending.intent));
    this.pending = undefined;
    try {
      void Promise.resolve(pending.intent.acknowledge?.()).catch((error) =>
        console.warn('[notification] acknowledgement failed', error));
    } catch (error) {
      console.warn('[notification] acknowledgement failed', error);
    }
  }
}
