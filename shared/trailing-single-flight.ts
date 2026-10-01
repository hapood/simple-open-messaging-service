/**
 * Single-flight execution with a trailing edge.
 *
 * Concurrent `trigger()` calls join the in-flight round (they await the same
 * promise); a trigger that lands mid-flight schedules exactly one trailing
 * round so the newest argument is still observed — the in-flight round may
 * have already read its last page/step and would otherwise miss it.
 *
 * Argument policy: the trailing round runs with `mergeArgs(current, incoming)`
 * (latest-wins by default; callers whose argument is a numeric target pass a
 * max-merge). Failure policy: a rejecting round rejects every awaiter of that
 * sequence, discards the pending trailing argument, and clears the slot — the
 * next trigger starts a fresh sequence.
 */
export class TrailingSingleFlight<Arg> {
  private inFlight: Promise<void> | null = null;
  private trailingArg: { arg: Arg } | null = null;

  constructor(
    private readonly run: (arg: Arg) => Promise<void>,
    private readonly mergeArgs: (current: Arg, incoming: Arg) => Arg = (
      _current,
      incoming,
    ) => incoming,
  ) {}

  /** Whether a sequence is currently executing (a trigger arrived and its
   *  rounds have not all settled). Lets keyed owners retire idle entries. */
  get running(): boolean {
    return this.inFlight !== null;
  }

  trigger(arg: Arg): Promise<void> {
    if (this.inFlight) {
      this.trailingArg = {
        arg: this.trailingArg ? this.mergeArgs(this.trailingArg.arg, arg) : arg,
      };
      return this.inFlight;
    }
    const initial = { arg };
    const sequence: Promise<void> = (async () => {
      let next: { arg: Arg } | null = initial;
      while (next) {
        const round = next;
        this.trailingArg = null;
        await this.run(round.arg);
        next = this.trailingArg;
      }
    })();
    this.inFlight = sequence;
    void sequence
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight === sequence) this.inFlight = null;
      });
    return sequence;
  }
}

/**
 * Coalesces numeric feed targets for work that starts later on an external
 * queue. Triggers that arrive before the queued task starts are absorbed into
 * that task; triggers that arrive while it is running schedule one trailing
 * task. Failures do not retry by themselves: a later wake must re-arm the
 * coalescer.
 */
export class QueuedTargetCoalescer {
  private highest = 0;
  private pending = false;
  private scheduled = false;

  constructor(
    private readonly enqueue: (task: () => Promise<void>) => void,
    private readonly run: (target: number) => Promise<void>,
  ) {}

  wake(target: number): void {
    if (!Number.isInteger(target) || target < 0 || target > 2147483647) return;
    this.highest = Math.max(this.highest, target);
    this.pending = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.enqueue(async () => {
      this.pending = false;
      try {
        await this.run(this.highest);
      } finally {
        this.scheduled = false;
        if (this.pending) this.schedule();
      }
    });
  }
}

export function coalesceQueuedTargets(
  enqueue: (task: () => Promise<void>) => void,
  run: (target: number) => Promise<void>,
): (target: number) => void {
  const coalescer = new QueuedTargetCoalescer(enqueue, run);
  return (target) => coalescer.wake(target);
}
