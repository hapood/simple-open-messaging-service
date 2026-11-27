/**
 * Pure single-gap balance admission and consumer-scoped tomb handoff.
 *
 * Invariants:
 * - Each balance pass admits at most ONE eligible ready gap (bottom-first: largest `right` first).
 * - Never recursively drains multiple gaps in one pass; callers schedule another `requestBalance()`
 *   when `hasMoreReady` is true.
 * - Tomb facts protect only currently active stale consumers; residual, split, or merged gaps
 *   always start with a fresh empty tomb set (no gap-to-gap tomb inheritance).
 */

export type UnifiedGapKind =
  | 'localGap'
  | 'serverPending'
  | 'serverUnavailable';

export interface GapReadyPage<M> {
  readonly left: number;
  readonly right: number;
  readonly messages: readonly M[];
}

export interface ManagedGap<M> {
  readonly id: string;
  readonly left: number;
  readonly right: number;
  readonly kind: UnifiedGapKind;
  readonly direction: 'older' | 'newer';
  /** Tombs observed while this specific consumer was active; never inherited by replacement gaps. */
  readonly consumerTombs: Set<number>;
  readyPage: GapReadyPage<M> | null;
}

export interface GapAdmissionResult<M> {
  readonly admitted: ManagedGap<M> | null;
  readonly filteredMessages: readonly M[];
  readonly hasMoreReady: boolean;
}

export class CbGapCoordinator<M> {
  private readonly gaps = new Map<string, ManagedGap<M>>();

  register(gap: {
    id: string;
    left: number;
    right: number;
    kind: UnifiedGapKind;
    direction: 'older' | 'newer';
  }): ManagedGap<M> {
    const managed: ManagedGap<M> = {
      ...gap,
      consumerTombs: new Set<number>(),
      readyPage: null,
    };
    this.gaps.set(gap.id, managed);
    return managed;
  }

  remove(id: string): void {
    this.gaps.delete(id);
  }

  get(id: string): ManagedGap<M> | undefined {
    return this.gaps.get(id);
  }

  /** Replace an old gap with zero or more residual/split/merged gaps. Tombs are NOT inherited. */
  replace(
    oldId: string,
    replacements: ReadonlyArray<{
      id: string;
      left: number;
      right: number;
      kind: UnifiedGapKind;
      direction: 'older' | 'newer';
    }>,
  ): ManagedGap<M>[] {
    this.gaps.delete(oldId);
    return replacements.map((r) => this.register(r));
  }

  /** Record a tomb fact against currently active consumers whose interval covers `seq`. */
  recordTomb(seq: number): void {
    for (const gap of this.gaps.values()) {
      if (seq > gap.left && seq <= gap.right) gap.consumerTombs.add(seq);
    }
  }

  /** Attach a ready page to an active gap consumer. Returns false if the gap is no longer active. */
  stageReadyPage(id: string, page: GapReadyPage<M>): boolean {
    const gap = this.gaps.get(id);
    if (!gap) return false;
    gap.readyPage = page;
    return true;
  }

  /**
   * Admit at most one ready gap for the current balance pass.
   * - When `pinToBottom` is true: pick the bottom-most ready gap (largest `right`).
   * - Otherwise: pick the ready gap closest to the viewport (smallest `distanceToViewport`),
   *   tie-breaking bottom-first.
   * Filters out messages covered by that consumer's tomb set.
   */
  admitOne(
    seqOf: (message: M) => number,
    options: {
      pinToBottom: boolean;
      distanceToViewport?: (gap: ManagedGap<M>) => number;
    },
  ): GapAdmissionResult<M> {
    const ready: ManagedGap<M>[] = [];
    for (const gap of this.gaps.values()) {
      if (gap.readyPage !== null) ready.push(gap);
    }
    if (ready.length === 0) {
      return { admitted: null, filteredMessages: [], hasMoreReady: false };
    }
    if (options.pinToBottom || !options.distanceToViewport) {
      ready.sort((a, b) => b.right - a.right || b.left - a.left);
    } else {
      const dist = options.distanceToViewport;
      ready.sort(
        (a, b) => dist(a) - dist(b) || b.right - a.right || b.left - a.left,
      );
    }
    const chosen = ready[0];
    const page = chosen.readyPage!;
    chosen.readyPage = null;
    const filteredMessages = page.messages.filter(
      (m) => !chosen.consumerTombs.has(seqOf(m)),
    );
    return {
      admitted: chosen,
      filteredMessages,
      hasMoreReady: ready.length > 1,
    };
  }

  clear(): void {
    this.gaps.clear();
  }
}
