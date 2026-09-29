/**
 * Continuous-coverage computation over a peer's cached certificate set for
 * proactive refresh scheduling.
 *
 * Scheduling is based on set coverage, not on a guessed remote active key and
 * not merely on the largest `notAfter`: discard expired intervals, start from
 * the interval covering `now`, and extend while the next interval starts at or
 * before the current coverage end. A gap stops the coverage. Request validation
 * is independent of this calculation: it selects the certificate whose complete
 * `keyId` matches and validates that certificate's exact `[notBefore, notAfter)`.
 */
export interface CoverageInterval {
  notBefore: number;
  notAfter: number;
}

/**
 * Returns the end of the continuous half-open validity coverage starting at
 * `now`, or null when no interval covers the current instant. Intervals
 * entirely in the past are ignored; overlapping intervals merge; a gap ends
 * the coverage even when a later interval reaches further.
 */
export function continuousCoverageEnd(
  intervals: readonly CoverageInterval[],
  now: number,
): number | null {
  const active = intervals
    .filter((interval) => interval.notAfter > now)
    .sort((a, b) => a.notBefore - b.notBefore || a.notAfter - b.notAfter);
  let end: number | null = null;
  for (const interval of active) {
    if (end === null) {
      // Sorted by notBefore: the first interval with notBefore <= now and
      // notAfter > now covers the current instant; none before it did.
      if (interval.notBefore <= now) end = interval.notAfter;
      else break;
    } else if (interval.notBefore <= end) {
      if (interval.notAfter > end) end = interval.notAfter;
    } else {
      break; // gap: later intervals start after the current coverage end
    }
  }
  return end;
}
