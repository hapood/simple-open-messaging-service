/**
 * Pure helpers for the Telegram-style sticky-date pill. Extracted from the host components
 * ({@link MessageThreadComponent}) so the label-pick, the fade-band
 * opacity, and the transitionend trigger are unit-testable without a rendered kernel + DOM.
 *
 * The load-bearing invariant — see {@link pickStickyDateLabel}'s `visibleTop` — is that the baseline is the
 * chat HEADER's bottom edge (stable), NOT the scroll viewport's `getBoundingClientRect().top` (which slides
 * under the header while the keyboard-lift `transform` is active and would pick a hidden message's date).
 */

/** A date-separator row's measured geometry for the sticky-date computation. */
export interface StickyDateRow {
  readonly top: number;
  readonly label: string | null;
}

/** A measured vertical interval in viewport coordinates. */
export interface StickyDateInterval {
  readonly top: number;
  readonly bottom: number;
}

/**
 * The floating pill starts 6px below the visible message-list top and occupies roughly 19px plus its
 * shadow. Keep this collision band in sync with `sticky-date-overlay.component.scss`.
 */
export const STICKY_DATE_COLLISION_TOP_PX = 6;
export const STICKY_DATE_COLLISION_BOTTOM_PX = 25;
/** The inline-to-floating handoff happens exactly where the floating pill starts. */
export const STICKY_DATE_PICK_FUZZ_PX = STICKY_DATE_COLLISION_TOP_PX;

/**
 * Whether the unread divider intersects the floating date pill's vertical band.
 *
 * This is intentionally based on geometry rather than "divider is visible": an unread divider in the
 * middle of the viewport should not remove useful date context. Strict interval bounds also avoid a
 * one-frame flicker when the divider merely touches, but does not enter, the pill band.
 */
export function unreadDividerOverlapsStickyDate(
  divider: StickyDateInterval | null,
  visibleTop: number,
): boolean {
  if (divider === null) return false;
  const pillTop = visibleTop + STICKY_DATE_COLLISION_TOP_PX;
  const pillBottom = visibleTop + STICKY_DATE_COLLISION_BOTTOM_PX;
  return divider.top < pillBottom && divider.bottom > pillTop;
}

/**
 * The sticky-date label: the last date row at/above the visible top (within `fuzz` px).
 *
 * `visibleTop` MUST be the chat header's bottom edge (the stable top of the visible content), NOT the
 * scroll viewport's `getBoundingClientRect().top`. The viewport carries the keyboard-lift `transform`, so
 * its `.top` slides under the header while the keyboard is up; keying off it would pick the date of a
 * message now hidden behind the header. The header does not transform, so its bottom is the true visible
 * top. (When the keyboard is closed the two coincide, so this is a no-op there.)
 *
 * Null-label rows are SKIPPED: a date separator marks "messages below are from DATE X", so a malformed
 * empty row must never clear the pill — the last REAL date wins (the messages still belong to it until the
 * next separator). In practice `DateRowComponent` always renders text, so this is robustness, not a live
 * behavior change.
 */
export function pickStickyDateLabel(
  rows: ReadonlyArray<StickyDateRow>,
  visibleTop: number,
  fuzz: number,
): string | null {
  let current: string | null = null;
  for (const r of rows) {
    if (r.top <= visibleTop + fuzz && r.label != null) current = r.label;
  }
  return current;
}

/**
 * The inline date-row opacity for the fade band. A row fades out as it passes behind the floating pill —
 * fully transparent at/below `fadeLo`, opaque above `fadeHi`, interpolated between. Rows stay opaque when
 * no float is shown (`hasFloat === false`). `fadeLo`/`fadeHi` are measured from the same `visibleTop`
 * (header bottom) as the label pick, so the fade tracks the float.
 */
export function stickyDateRowOpacity(
  top: number,
  fadeLo: number,
  fadeHi: number,
  hasFloat: boolean,
): number {
  if (!hasFloat || top > fadeHi) return 1;
  return Math.max(0, Math.min(1, (top - fadeLo) / (fadeHi - fadeLo)));
}

/**
 * Whether a `transitionend` event is the scroll viewport's OWN keyboard-lift `transform` settling — the
 * signal to recompute the sticky-date pill (the transform fires no scroll event, so `onScroll` alone would
 * leave the pill on its pre-lift label across a keyboard open/close). Excludes bubbled item transitions
 * (e.g. `cb-move`) via the target check, and non-`transform` properties.
 */
export function isViewportTransformEnd(
  event: { readonly target: unknown; readonly propertyName: string },
  viewportEl: unknown,
): boolean {
  return event.target === viewportEl && event.propertyName === 'transform';
}
