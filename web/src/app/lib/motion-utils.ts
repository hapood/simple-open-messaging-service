import { animate, type AnimationPlaybackControls } from 'motion';

/** True when the user prefers reduced motion. Animations should snap to their end state (duration 0)
 *  instead of playing. Read once at construction — it doesn't change during a session in practice, and
 *  re-reading inside an effect would re-run every animation on every matchMedia change. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Spring a `.tonal-chip`'s gradient stops + icon color from their current values to a target palette.
 *
 *  The target is the NAMES of CSS vars (e.g. `--c-amber-1`, `--c-brand-2`) that resolve to theme-aware
 *  concrete colors — read via `getComputedStyle` at call time, so Motion interpolates concrete `rgb()`
 *  without the caller knowing the theme. The `--g-from`/`--g-to`/`--ic` vars they target MUST be
 *  registered `<color>` (`@property`, in `styles.scss`) so Motion can interpolate them.
 *
 *  Used by the connection chip's per-state morph AND the update banner's enter fill-in — the one piece
 *  of Motion logic both share. Returns the controls so the caller can `stop()` prior morphs to avoid
 *  overlap. */
export function springGradient(
  el: HTMLElement,
  palette: { from: string; to: string; ic: string },
  opts: { stiffness?: number; damping?: number } = {},
): AnimationPlaybackControls {
  const cs = getComputedStyle(el);
  const read = (name: string): string => cs.getPropertyValue(name).trim();
  return animate(el, {
    '--g-from': read(palette.from),
    '--g-to':   read(palette.to),
    '--ic':     read(palette.ic),
  }, { type: 'spring', stiffness: opts.stiffness ?? 140, damping: opts.damping ?? 22 });
}
