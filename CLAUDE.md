# CLAUDE.md

Project-level guidance for Claude working in this repository. **These instructions override default behavior and MUST be followed exactly.**

## Guiding Principle

- **Every technical decision must follow the best practice for that scenario, with no regard for development cost.**
  - Never trade correctness, security, maintainability, or architectural cleanliness for "faster delivery," "fewer changes," or "lower regression risk."
  - When multiple implementation paths exist, select and execute the recognized best option directly — do not ship a suboptimal solution first and wait to be challenged. Extra effort is not a decision factor.
  - Scope clarification: this means "choose by best practice," not "rewrite everything by default." If the best practice is the minimal change, do that; if it requires more work, do that.

## Language

- Code comments and documentation are written in **English** — inline comments, doc comments (`/** */`), and standalone `.md` docs alike. Do not mix languages within a single file or document.

## CSS Integer-Pixel Rule

- **Every value that contributes to an element's rendered HEIGHT must be an integer number of CSS pixels.** This is the rule that matters for layout measurement: `height`, `min-height`/`max-height`, **vertical `padding`**, **vertical `border-width`**, **vertical `gap`**, and — most importantly — **`line-height`** (use a length in integer px, e.g. `line-height: 20px`; never unitless like `1.4`, `em`, or `normal`). A length `line-height` makes each line box exactly that value regardless of `font-size` or wrap point, so `N lines × integer + integer padding = integer offsetHeight` for any line count `N` (wrapping only changes `N`, which is always an integer).
- **Why:** `offsetHeight`/`scrollHeight` return integers, but the browser lays out at fractional device pixels. `Σ round(hᵢ)` (per-item measured heights) drifts from `round(Σ hᵢ)` (the container's `scrollHeight`) — observed ~+11px over 63 items. The virtual-scroll kernel's height model (`totalH()`) is the prefix-sum of per-item `offsetHeight`; for it to equal `content.scrollHeight` exactly (so at-bottom tests, anchor compensation, and keyboard re-pin are reliable), every per-item height must be a whole pixel.
- **Horizontal sizing is exempt** — `width`, `max-width`, and percentages (e.g. `max-width: min(72%, 520px)`, `width: 33.333%`) may be fractional. Fractional widths only change the wrap count `N` (an integer); they do NOT cause height drift. Fractional values are also fine for non-box visual properties: `opacity`, `transform` (and keyframe stops), `box-shadow`, gradient angles, `border-radius`, animation timings.
- **One exception within measured heights:** an inline element taller than `line-height` (an oversized emoji / inline `<img>`) grows that line's box beyond the integer `line-height`. Keep inline content ≤ `line-height`; chat images live in album rows whose `layout.ts` already `Math.round`s every cell height.
- **Do not "fix" drift by switching the kernel to `getBoundingClientRect().height`.** That API reads the *transformed* (scaled) size; the `cb-enter`/`cb-leave`/`cb-move` animations in `lib/chat-box/_cb.scss` use `transform: scale()` precisely *because* `offsetHeight` is transform-invariant. `getBoundingClientRect` would inject 2–4% height jitter mid-animation. `offsetHeight` (integer, transform-invariant) stays the measurement API; the CSS carries the integer burden instead. See the `cb-element-border-box-height` and `kernel-totalH-drifts-from-scrollHeight` memories.
