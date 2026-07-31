/** Monotonic fully-visible cursor committed only after the viewport has stayed quiet for `dwellMs`. */
export class StableReadTracker {
  private candidate: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly commit: (seq: number) => void,
    private readonly dwellMs = 500,
  ) {}

  noteFullyVisible(ids: readonly number[]): void {
    for (const id of ids) {
      if (id >= 0 && (this.candidate === null || id > this.candidate))
        this.candidate = id;
    }
    this.arm();
  }

  noteScroll(): void {
    this.arm();
  }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.candidate = null;
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
