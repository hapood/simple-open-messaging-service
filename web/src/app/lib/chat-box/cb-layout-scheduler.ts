type LayoutState =
  | { kind: 'idle' }
  | { kind: 'balancing' }
  | { kind: 'resizing' }
  | { kind: 'destroyed' };

/** One window's nonrecursive layout admission.
 * Facts/pages stay with their consumers; dirty only requests another pass. */
export class CbLayoutScheduler {
  private state: LayoutState = { kind: 'idle' };
  private dirty = false;
  private frame: { id?: number } | null = null;

  constructor(private readonly balance: () => void) {}

  get phase(): LayoutState['kind'] {
    return this.state.kind;
  }

  requestBalance(): void {
    if (this.state.kind === 'destroyed') return;
    this.dirty = true;
    this.scheduleBalance();
  }

  dispose(): void {
    if (this.state.kind === 'destroyed') return;
    this.state = { kind: 'destroyed' };
    this.dirty = false;
    this.cancelFrame();
  }

  /** Enter width-resize settling and block balance until settled. */
  enterResizing(): void {
    if (this.state.kind === 'destroyed' || this.state.kind === 'resizing') return;
    this.state = { kind: 'resizing' };
    this.cancelFrame();
  }

  /** Leave width-resize settling and schedule a coalesced balance if facts arrived during resize. */
  leaveResizing(): void {
    if (this.state.kind !== 'resizing') return;
    this.state = { kind: 'idle' };
    this.scheduleBalance();
  }

  /** Drop a queued balance pass without leaving the active lifecycle. */
  cancelPending(): void {
    this.dirty = false;
    this.cancelFrame();
  }

  private scheduleBalance(): void {
    if (this.state.kind !== 'idle' || !this.dirty || this.frame) return;
    this.scheduleFrame(() => this.runBalance());
  }

  private runBalance(): void {
    if (this.state.kind !== 'idle' || !this.dirty) return;
    const balancing: LayoutState = { kind: 'balancing' };
    this.state = balancing;
    this.dirty = false;
    try {
      this.balance();
    } finally {
      // A commit may synchronously close its window or enter resize settling.
      if (this.state === balancing) this.state = { kind: 'idle' };
      this.scheduleBalance();
    }
  }

  private scheduleFrame(callback: () => void): void {
    const frame: { id?: number } = {};
    this.frame = frame;
    frame.id = requestAnimationFrame(() => {
      // Frame identity protects revoked work without a revision counter.
      if (this.frame !== frame) return;
      this.frame = null;
      callback();
    });
  }

  private cancelFrame(): void {
    const frame = this.frame;
    this.frame = null;
    if (frame?.id !== undefined) cancelAnimationFrame(frame.id);
  }
}
