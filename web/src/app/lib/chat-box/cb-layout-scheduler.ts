export interface CbLayoutAnimation {
  /** Finite lifetime including the wait for the first animation frame. */
  readonly durationMs: number;
  /** Paint only. Geometry must already have been captured by the layout owner. */
  render(progress: number): void;
  /** Apply final presentation and dispose retired DOM before balance resumes. */
  finish(): void;
  /** Release owned presentation immediately, without completing a revoked window. */
  cancel(): void;
}

type AnimationState = {
  kind: 'animating';
  animation: CbLayoutAnimation;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  settling: boolean;
};
type LayoutState =
  | { kind: 'idle' }
  | { kind: 'balancing' }
  | { kind: 'resizing' }
  | AnimationState
  | { kind: 'destroyed' };

/** One window's nonrecursive layout admission and finite animation barrier.
 * Facts/pages stay with their consumers; dirty only requests another pass.
 * Scroll animation deliberately has no completion or cancellation hook here. */
export class CbLayoutScheduler {
  private state: LayoutState = { kind: 'idle' };
  private dirty = false;
  private frame: { id?: number } | null = null;

  constructor(private readonly balance: () => CbLayoutAnimation | void) {}

  get phase(): LayoutState['kind'] {
    return this.state.kind;
  }

  requestBalance(): void {
    if (this.state.kind === 'destroyed') return;
    this.dirty = true;
    this.scheduleBalance();
  }

  /** Isolated spinner work does not itself dirty balance. On false, the caller
   * retains its facts, not a queued stale DOM command. Balance callbacks return
   * their animation instead of reentering this method during a commit. */
  startAnimation(animation: CbLayoutAnimation): boolean {
    if (this.state.kind !== 'idle') return false;
    this.validateDuration(animation.durationMs);
    this.cancelFrame();
    const state: AnimationState = {
      kind: 'animating',
      animation,
      startedAt: performance.now(),
      settling: false,
    };
    this.state = state;
    if (animation.durationMs === 0) {
      this.settle(state, 'finish');
      return true;
    }
    // Arm before first paint: a suspended rAF must not retain the gate forever.
    state.timer = setTimeout(
      () => this.settle(state, 'finish'),
      animation.durationMs,
    );
    this.paint(state, 0);
    this.scheduleAnimation(state);
    return true;
  }

  dispose(): void {
    const previous = this.state;
    if (previous.kind === 'destroyed') return;
    this.state = { kind: 'destroyed' };
    this.dirty = false;
    this.cancelFrame();
    if (previous.kind !== 'animating') return;
    clearTimeout(previous.timer);
    if (previous.settling) return;
    previous.settling = true;
    previous.animation.cancel();
  }

  /** Enter width-resize settling: cancel any active layout animation and block balance until settled. */
  enterResizing(): void {
    const previous = this.state;
    if (previous.kind === 'destroyed' || previous.kind === 'resizing') return;
    this.state = { kind: 'resizing' };
    this.cancelFrame();
    if (previous.kind !== 'animating') return;
    clearTimeout(previous.timer);
    if (previous.settling) return;
    previous.settling = true;
    previous.animation.cancel();
  }

  /** Leave width-resize settling and schedule a coalesced balance if facts arrived during resize. */
  leaveResizing(): void {
    if (this.state.kind !== 'resizing') return;
    this.state = { kind: 'idle' };
    this.scheduleBalance();
  }

  /** Drop a queued idle balance pass without leaving the active lifecycle. */
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
      const animation = this.balance();
      if (this.state !== balancing) {
        // A commit may synchronously close its own window.
        animation?.cancel();
        return;
      }
      this.state = { kind: 'idle' };
      if (animation) {
        try {
          this.validateDuration(animation.durationMs);
        } catch (error) {
          try {
            animation.cancel();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Invalid layout animation',
            );
          }
          throw error;
        }
        this.startAnimation(animation);
      }
    } finally {
      if (this.state === balancing) this.state = { kind: 'idle' };
      this.scheduleBalance();
    }
  }

  private scheduleAnimation(state: AnimationState): void {
    if (this.state !== state || state.settling) return;
    this.scheduleFrame((now) => {
      if (this.state !== state || state.settling) return;
      const progress = Math.min(
        1,
        Math.max(0, (now - state.startedAt) / state.animation.durationMs),
      );
      if (progress === 1) {
        this.settle(state, 'finish');
      } else {
        this.paint(state, progress);
        this.scheduleAnimation(state);
      }
    });
  }

  private paint(state: AnimationState, progress: number): void {
    try {
      state.animation.render(progress);
    } catch (error) {
      try {
        this.settle(state, 'cancel');
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Layout animation failed',
        );
      }
      throw error;
    }
  }

  private settle(state: AnimationState, action: 'finish' | 'cancel'): void {
    if (this.state !== state || state.settling) return;
    state.settling = true;
    clearTimeout(state.timer);
    this.cancelFrame();
    // Keep the gate while final positions and presentation disposal are applied.
    try {
      state.animation[action]();
    } finally {
      if (this.state === state) this.state = { kind: 'idle' };
      this.scheduleBalance();
    }
  }

  private scheduleFrame(callback: FrameRequestCallback): void {
    const frame: { id?: number } = {};
    this.frame = frame;
    frame.id = requestAnimationFrame((now) => {
      // Frame identity protects revoked work without a revision counter.
      if (this.frame !== frame) return;
      this.frame = null;
      callback(now);
    });
  }

  private cancelFrame(): void {
    const frame = this.frame;
    this.frame = null;
    if (frame?.id !== undefined) cancelAnimationFrame(frame.id);
  }

  private validateDuration(durationMs: number): void {
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      durationMs > 2_147_483_647
    )
      throw new RangeError(
        'Layout animation requires a finite nonnegative timer duration',
      );
  }
}
