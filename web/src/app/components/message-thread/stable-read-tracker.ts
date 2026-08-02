/** Monotonic fully-visible cursor: commit once on activation, then after the viewport stays quiet. */
export class StableReadTracker {
  private candidate: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;

  constructor(
    private readonly commit: (seq: number) => void,
    private readonly dwellMs = 200,
  ) {}

  noteFullyVisible(ids: readonly number[]): void {
    for (const id of ids) {
      if (id >= 0 && (this.candidate === null || id > this.candidate))
        this.candidate = id;
    }
    if (this.active) this.arm();
  }

  noteScroll(): void {
    if (this.active) this.arm();
  }

  /** Activate foreground tracking and immediately commit the current fully-visible HWM. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.flush();
  }

  /** Commit the best fully-visible HWM now (used by teardown as the final read-progress backstop). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.active || this.candidate === null) return;
    this.commit(this.candidate);
  }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.candidate = null;
    this.active = false;
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.candidate === null) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.commit(this.candidate!);
    }, this.dwellMs);
  }
}
