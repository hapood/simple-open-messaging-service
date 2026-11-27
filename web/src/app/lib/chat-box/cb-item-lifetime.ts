type Cleanup = () => void;
type ItemPhase = 'active' | 'retiring' | 'destroyed';

/** A mounted item's activity ends before its original DOM finishes exiting.
 * Activity owns queries/observers; presentation owns views and displayed assets.
 * This scope can also be provided to an Angular row and its children by the
 * renderer adapter. It never detaches or destroys an Angular view implicitly. */
export class CbItemLifetime {
  private phase: ItemPhase = 'active';
  private readonly aborter = new AbortController();
  readonly signal = this.aborter.signal;
  private readonly activity = new Set<Cleanup>();
  private readonly presentation = new Set<Cleanup>();
  private drainingActivity = false;
  private destroyRequested = false;

  get active(): boolean {
    return this.phase === 'active';
  }

  get destroyed(): boolean {
    return this.phase === 'destroyed';
  }

  /** Register work that must stop before the first exit frame. The returned
   * function unregisters the callback, for children disposed before their row. */
  onPredestory(cleanup: Cleanup): Cleanup {
    if (this.phase === 'active' || this.drainingActivity)
      return this.register(this.activity, cleanup);
    cleanup();
    return () => {};
  }

  /** Retain a view or display lease until exit finishes. Registering after
   * destruction releases it immediately rather than leaking late resources. */
  onDestroy(cleanup: Cleanup): Cleanup {
    if (!this.destroyed) return this.register(this.presentation, cleanup);
    cleanup();
    return () => {};
  }

  /** End business activity, not Angular ownership or DOM presence. Idempotent.
   * Publication is revoked before abort/unsubscribe can synchronously reenter. */
  predestory(): void {
    if (!this.active) return;
    this.phase = 'retiring';
    const errors: unknown[] = [];
    this.drainingActivity = true;
    try {
      this.aborter.abort();
      this.drain(this.activity, errors);
    } finally {
      this.drainingActivity = false;
    }
    // A cleanup can request final disposal (for example a synchronous unbind).
    // Finish all activity cleanup before releasing any presentation resources.
    if (this.destroyRequested) this.finishDestroy(errors);
    this.report(errors);
  }

  /** Final disposal also works when there was no exit animation. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyRequested = true;
    if (this.active) {
      this.predestory();
      return;
    }
    if (this.drainingActivity) return;
    const errors: unknown[] = [];
    this.finishDestroy(errors);
    this.report(errors);
  }

  private register(collection: Set<Cleanup>, cleanup: Cleanup): Cleanup {
    // Separate registrations of the same callback each own one release.
    const entry = () => cleanup();
    collection.add(entry);
    return () => collection.delete(entry);
  }

  private drain(collection: Set<Cleanup>, errors: unknown[]): void {
    for (const cleanup of collection) {
      collection.delete(cleanup);
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  private finishDestroy(errors: unknown[]): void {
    if (this.destroyed) return;
    this.phase = 'destroyed';
    this.drain(this.presentation, errors);
  }

  private report(errors: unknown[]): void {
    if (errors.length)
      throw new AggregateError(errors, 'Chat item cleanup failed');
  }
}
