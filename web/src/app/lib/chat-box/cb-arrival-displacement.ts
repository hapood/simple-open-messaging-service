/**
 * Dual-branch arrival/tail displacement planner for ChatBoxScroller.
 *
 * - Tall -> Tall (`beforeTotalH > vh && afterTotalH > vh`): uses `scrollTop` only (`transform` stays none).
 * - Short -> Short (`beforeTotalH <= vh && afterTotalH <= vh`): `scrollTop` stays `0`, visual shift uses
 *   `transform: translateY(startTranslateY -> 0)` on the content layer.
 * - Short -> Tall (`beforeTotalH <= vh && afterTotalH > vh`, crossing threshold upward):
 *   sets final `scrollTop = afterTotalH - vh` and animates `transform: translateY(delta -> 0)` so
 *   frame 0 has zero visual jump and frame 1 settles cleanly at `scrollTop = afterOverflow, transform = none`.
 * - Tall -> Short (`beforeTotalH > vh && afterTotalH <= vh`, crossing threshold downward):
 *   immediate snap (`scrollTop = 0, transform = none`), zero exit animation.
 */

export type DisplacementPlan =
  | {
      readonly mode: 'none';
      readonly finalScrollTop: number;
    }
  | {
      readonly mode: 'scrollTop';
      readonly startScrollTop: number;
      readonly finalScrollTop: number;
    }
  | {
      readonly mode: 'transform';
      readonly finalScrollTop: number;
      readonly startTranslateY: number;
    };

export function planArrivalDisplacement(params: {
  beforeTotalH: number;
  afterTotalH: number;
  viewportHeight: number;
  beforeScrollTop: number;
  animate: boolean;
}): DisplacementPlan {
  const { beforeTotalH, afterTotalH, viewportHeight, beforeScrollTop, animate } =
    params;
  const afterOverflow = Math.max(0, afterTotalH - viewportHeight);
  const delta = afterTotalH - beforeTotalH;

  // Shrink or zero change (including tall -> short): immediate, no exit animation.
  if (delta <= 0 || !animate) {
    return { mode: 'none', finalScrollTop: afterOverflow };
  }

  // Tall -> Tall: pure scrollTop animation.
  if (beforeTotalH > viewportHeight && afterTotalH > viewportHeight) {
    return {
      mode: 'scrollTop',
      startScrollTop: beforeScrollTop,
      finalScrollTop: afterOverflow,
    };
  }

  // Short -> Short OR Short -> Tall (crossing viewportHeight threshold upward):
  // Place real scrollTop at `afterOverflow` and animate `translateY(startTranslateY -> 0)`.
  // At t=0, visual position matches `before` exactly; at t=1, `transform` clears to `none`.
  return {
    mode: 'transform',
    finalScrollTop: afterOverflow,
    startTranslateY: delta,
  };
}
