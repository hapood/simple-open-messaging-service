/**
 * In-memory circuit-breaker flag store. One instance per quota scope: federation (per-domain) and local
 * (per-user). The flags are a CACHE over the persisted daily counters in QuotaDailyUsage / QuotaFileByteUsage
 * (and their per-user twins) — they are re-derived on startup (QuotaService.refresh) and reconciled on every
 * overshooting tick / admin add-quota. Not persisted by design: a restart re-derives them, so a tripped breaker
 * re-trips on the next gate evaluation rather than silently staying open or stuck.
 *
 * Auto-expiry: each entry records the UTC date it was set on; any read with a different `today` clears the entry,
 * so flags vanish at UTC midnight without a cron (the persisted counters reset the same way via the date row key).
 */

/** The three breaker dimensions. */
export type BreakerDim = 'msg' | 'file' | 'fileBytes';

interface Entry {
  /** Which dimensions are over limit for this entity. */
  readonly dims: Set<BreakerDim>;
  /** The UTC date this entry is valid for; a different `today` makes it stale (cleared on next read). */
  day: Date;
}

export class BreakerFlags {
  private readonly entries = new Map<string, Entry>();

  /** Flag `entity` as over-limit on `dim` for `today`. */
  mark(entity: string, dim: BreakerDim, today: Date): void {
    let entry = this.entries.get(entity);
    if (!entry || entry.day.getTime() !== today.getTime()) {
      entry = { dims: new Set(), day: today };
      this.entries.set(entity, entry);
    }
    entry.dims.add(dim);
  }

  /** Reconcile `entity`'s dims in one shot: dims in `over` are marked, any others are cleared. */
  reconcile(entity: string, over: Iterable<BreakerDim>, today: Date): void {
    const overSet = new Set(over);
    if (overSet.size === 0) {
      this.entries.delete(entity);
      return;
    }
    const entry: Entry = { dims: overSet, day: today };
    this.entries.set(entity, entry);
  }

  /** Any dimension tripped for `entity` today? */
  isTripped(entity: string, today: Date): boolean {
    return this.trippedDims(entity, today).length > 0;
  }

  /** Which dimensions are tripped for `entity` today (clears the entry if it belongs to a past day). */
  trippedDims(entity: string, today: Date): BreakerDim[] {
    const entry = this.entries.get(entity);
    if (!entry) return [];
    if (entry.day.getTime() !== today.getTime()) {
      this.entries.delete(entity);
      return [];
    }
    return [...entry.dims];
  }

  /** Clear all dims for `entity` (after admin add-quota brings every dimension within limits). */
  clear(entity: string): void {
    this.entries.delete(entity);
  }

  /** All entities flagged tripped as of `today` (admin "all breakers" view). Stale entries are swept. */
  trippedEntities(today: Date): string[] {
    const out: string[] = [];
    for (const [entity, entry] of this.entries) {
      if (entry.day.getTime() === today.getTime() && entry.dims.size > 0) {
        out.push(entity);
      } else {
        this.entries.delete(entity);
      }
    }
    return out;
  }
}
