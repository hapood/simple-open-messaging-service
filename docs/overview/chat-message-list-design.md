# Chat Message List Design Specification (Mobile · 1v1)

This document codifies the visual and layout design specification for SOMS's **mobile 1-to-1 chat "message list"**, serving as the single source of truth for the frontend implementation (`MsgGroupComponent` and its surrounding code). All values, structure, and colors are governed by this document.

> **Status**: Verified in the virtual scroll playground (`/playground/chatbox`); pending phase-4 to land as the real message component. See the [Decision Record](#decision-record) at the end for the evolution of key design decisions.

## Table of Contents

- [1. Design Style](#1-design-style)
- [2. Message Row Structure](#2-message-row-structure)
- [3. Bubble](#3-bubble)
- [4. Avatar](#4-avatar)
- [5. Name Label](#5-name-label)
- [6. Tail Tip Handle](#6-tail-tip-handle)
- [7. Timestamp and Date Separator](#7-timestamp-and-date-separator)
- [8. Color and Light/Dark Theme](#8-color-and-lightdark-theme)
- [9. Size and Spacing Summary](#9-size-and-spacing-summary)
- [10. Grouping Rules](#10-grouping-rules)
- [11. Desktop Differences](#11-desktop-differences)
- [12. Explicitly Out of Scope](#12-explicitly-out-of-scope)
- [13. Reference Implementation](#13-reference-implementation)
- [14. Scroll Architecture](#14-scroll-architecturerelative-scroll)
- [Decision Record](#decision-record)

---

## 1. Design Style

- **WhatsApp style** (iMessage / Telegram abandoned): light-filled bubbles, small rounded corners, a timestamp embedded at the bottom-right of each bubble, group heads carry an avatar + a tail tip pointing at the avatar.
- **Avatars are WeChat-style squares** (8px corner radius, not circular).
- **Industry alignment**: message avatars are **40px** (WhatsApp / WeChat / Telegram / Discord / Material Design specs are all ~40px).
- Consumes the project's design tokens (`--app-*`, defined in [`web/src/app/assets/_tokens.scss`](../../web/src/app/assets/_tokens.scss)); IM semantic colors such as bubble colors are hardcoded per this spec.

## 2. Message Row Structure

Each message is a flex row (`.pg-msg-row`), with the avatar and the "name + bubble" column (`.pg-col`) as siblings:

```
Other's messages (avatar on left)   self messages (avatar on right)
┌─────────────────────────────┐    ┌─────────────────────────────┐
│ [avatar] [gap] [ col ]       │    │ [ col ] [gap] [avatar]       │
│  40px   8px  ┌ name(other)   │    │  no name      ┐              │
│              └ bubble        │    │  bubble       │ 40px         │
│ justify-content: flex-start  │    │ justify-content: flex-end    │
└─────────────────────────────┘    └─────────────────────────────┘

col = flex-column: [name?(other group-head only)] → [bubble(embedded bottom-right timestamp)]
```

Layout rules:

- Row `display:flex`; other side `justify-content:flex-start`, self `justify-content:flex-end`.
- Only the group-head row (`isShowHead`) mounts an avatar; **intra-group rows do not repeat the avatar**, but the col uses margin to yield the avatar column so that intra-group bubble edges align with the group-head bubble edge.
- Avatar `align-self:flex-start`, **hugging the row's top, aligned with the top edge of the group head's first message**.

## 3. Bubble

| Property | Value |
| --- | --- |
| `min-height` | `40px` (so short messages like "hi" / "ok" don't collapse; pure UI parameter, unrelated to virtual scroll height computation) |
| `padding` | `6px 10px` (bottom-right timestamp is dynamically yielded by the "shadow placeholder", see [§7](#7-timestamp-and-date-separator)) |
| Font size / line height | `14.2px / 1.4`, `white-space:pre-wrap; word-break:break-word` |
| `max-width` (mobile) | `calc(100% - 104px)` (yields one avatar column on each side, 48×2 + 8 margin, preventing the longest bubble from touching the other's avatar) |
| `box-shadow` | `0 1px 0.5px rgba(0,0,0,.13)` |

**Border radius is asymmetric by group position** (`pg-head` / `pg-mid` / `pg-tail`) — the group head has a large top corner on the avatar side and a small one on the adjacent side; the group tail is reversed; the group middle is small on both sides:

| Group position | class | top-left / top-right | bottom-left / bottom-right | Notes |
| --- | --- | --- | --- | --- |
| Group head | `pg-head` | 10 / 10* | 3 / 3 | Avatar-side top corner tapers to 3px to meet the tail tip (see the other-row note) |
| Group middle | `pg-mid` | 3 / 3 | 3 / 3 | |
| Group tail | `pg-tail` | 3 / 3 | 10 / 10 | |

> *Group-head top corner taper: **other** top-left is 3px (the tail tip sits at the top corner); **self** keeps top-right at 10px because the tail tip is shifted down (see [§6](#6-tail-tip-handle)). A standalone message (occupying its own group) uses the `head` style.

## 4. Avatar

| Property | Value |
| --- | --- |
| Size | **40 × 40 px** (industry standard) |
| Corner radius | `8px` (WeChat-style square) |
| When shown | **Both sides' group heads (`isShowHead`) show** — self on the right, other on the left (symmetric design); not repeated within a group |
| Vertical alignment | `align-self:flex-start`, hugging the top of the group-head message |
| Font size (initial/character) | `16px`, weight 600, white |
| self background | `#25D366` |
| other background | `#C7C7CC` (`#37424a` in dark) |
| header avatar | may be smaller (`32px`) — the header is denser, and a 48px-tall header cannot fit 40px; differing from the message avatar size is normal |

**Intra-group row yielding**: col `margin-left/right: 48px` (= 40 avatar + 8 gap), so intra-group bubble edges align with the group-head bubble; the group-head col leaves only an 8px gap to the avatar.

## 5. Name Label

- **Only the other side's group head shows the sender's name**; **self is unnamed by default** (industry convention: one's own messages are unsigned — WhatsApp / WeChat / Telegram / iMessage / Discord / Slack all do this).
- Does not mimic WhatsApp 1v1 in also omitting the other side's name — the other side's name is retained to stay compatible with group-chat scenarios (where the other side's name distinguishes multiple people).
- Name is **aligned with the bubble edge** (no indent): `font-size:11px; font-weight:600; color:var(--app-text-muted); margin:0 0 2px`.

> Knock-on effect of hiding the self name: the self bubble moves up to the row top (no name row), so the tail tip must be shifted down — see [§6](#6-tail-tip-handle).

## 6. Tail Tip Handle

The group-head bubble carries a triangular handle pointing at its respective avatar. The two sides **use different mechanisms but land at the same point** (both point at the upper-middle of the avatar, aligned at an absolute height of ~15px):

| Side | Position | Top corner treatment | Reason |
| --- | --- | --- | --- |
| other | Bubble **top corner** (`top:0`) | Avatar-side top corner tapers 3px to meet the tail tip | The other side has a name, the bubble sinks to ~15px, and the top corner faces the avatar's upper-middle |
| self | **Shifted down to the avatar's vertical center** (`top:13px ≈ 40/2−7`) | Top corner keeps a 10px radius | Self has no name and the bubble hugs the row top, so the top corner is at the very top; the tail tip must shift down to align with the other side and point at the avatar's middle |

**Implementation: CSS border triangle (asymmetric border-width)**

```scss
.pg-bubble.pg-head::before {                 // tail tip base class
  content: ''; position: absolute;
  border-style: solid; border-color: transparent;
}
// other: ◀ points left (avatar on left), tail tip at top corner
.pg-bubble.pg-head.pg-other::before {
  left: -7px; top: 0;
  border-width: 7px 7px 7px 0;               // key: left border=0 → the entire pseudo-element becomes the triangle, protruding past the bubble's left edge
  border-right-color: #FFFFFF;               // = other bubble color (dark mode: #202c33)
}
// self: ▶ points right (avatar on right), tail tip shifts down to avatar's center line
.pg-bubble.pg-head.pg-self::before {
  right: -7px; top: 13px;
  border-width: 7px 0 7px 7px;               // key: right border=0 → the entire pseudo-element becomes the triangle, protruding past the bubble's right edge
  border-left-color: #DCF8C6;                // = self bubble color (dark mode: #005c4b)
}
```

> **You must use asymmetric `border-width`** (0 on the avatar side). If you use equal-width `border:7px solid transparent` and then color one side, the pseudo-element will be 14px wide and the triangle lands **inside the same-color bubble** (x∈[0,7]) → completely invisible. This is the only known pitfall of this approach.

> **The tail-tip color must match the bubble background** (differing between light / dark), or it will be exposed. If states such as read or hover change the bubble color, the tail-tip color must be updated in lockstep.

## 7. Timestamp and Date Separator

- **Timestamp**: WhatsApp-style, **embedded at the bottom-right of every bubble** (not per-group; shown on each). `position:absolute; right:10px; bottom:4px; font-size:11px; white-space:nowrap`. Light `rgba(0,0,0,.45)`, dark `rgba(233,237,239,.5)`. **The text is always `HH:mm`** — WhatsApp does not show dates on bubbles (avoiding long strings that crowd the body); all date / year context is delegated to the date separator row.
  - **Preventing overlap with the body — WhatsApp's "shadow placeholder" method**: a `visibility:hidden` "shadow timestamp" (same text and same font size as the visible time → same width) is appended at the end of the body `<p>`, forcing the last line of the body to yield the bottom-right corner; the visible time is `position:absolute` pinned to the bottom-right, overlapping the shadow placeholder. The bubble's `padding-right` therefore **no longer reserves a fixed gutter** (only `10px`) — the shadow occupies space according to the time's actual width. Mechanism: if the last line + shadow fit → the shadow sits at the end of the last line and the time overlays it; if they don't fit → the shadow occupies a new line and the time lands on that line; the body never intrudes into the time region.
- **Date separator**: a centered pill, with vertical whitespace via `padding:14px 0` (**`margin` must not be used** — the kernel measures height with `offsetHeight` which excludes margin, whereas margin pushes down the absolutely-positioned row without being counted toward height, causing overlap/occlusion with the bubble below; a previously-seen bug where pg-date was occluded by a bubble was caused by exactly this). span `font-size:11px; font-weight:500; padding:3px 12px; border-radius:9999px`. Background light `rgba(0,0,0,.06)` / dark `#182229`, text `--app-text-faint`. **The text is tiered relative to "now"** (WhatsApp convention): today → `today`; yesterday → `yesterday`; this week (2–6 days before today) → `Wed`; earlier this year → `M-D`; across years → `YYYY-M-D`.

## 8. Color and Light/Dark Theme

| Use | Light | Dark |
| --- | --- | --- |
| Chat-area background | `#f4f6f9` (`--app-bg`) | `#0b141a` |
| self bubble | `#DCF8C6` | `#005c4b` |
| other bubble | `#FFFFFF` | `#202c33` |
| Bubble text | `#303030` | `#e9edef` |
| Timestamp | `rgba(0,0,0,.45)` | `rgba(233,237,239,.5)` |
| self avatar background | `#25D366` | `#25D366` |
| other avatar background | `#C7C7CC` | `#37424a` |
| Date pill background | `rgba(0,0,0,.06)` | `#182229` |

**Theme mechanism**: semantic tokens (`--app-bg` / `--app-surface` / `--app-text`, etc.) decouple light/dark, so switching themes only redefines variables with zero component changes. Production redefines tokens under `[data-theme="dark"]` ([`_tokens.scss`](../../web/src/app/assets/_tokens.scss) already reserves placeholders); IM hardcoded colors such as bubbles are overridden in the dark block.

## 9. Size and Spacing Summary

| Item | Value | Notes |
| --- | --- | --- |
| Message avatar | `40 × 40` | Industry standard |
| Avatar corner radius | `8px` | WeChat-style square |
| Avatar ↔ bubble gap | `8px` | |
| Intra-group col yielding | `48px` (= 40 + 8) | Aligns with group-head bubble edge |
| Row padding | `6px 16px` (`--app-space-4`) | |
| Bubble `min-height` | `40px` | Pure UI, unrelated to height computation |
| Bubble padding | `6px 10px` | Bottom-right timestamp dynamically yielded by shadow placeholder |
| Bubble font size | `14.2px / 1.4` | |
| Bubble `max-width` (mobile) | `calc(100% - 104px)` | Yields 48×2 + 8 on both sides |
| Bubble `max-width` (desktop) | `min(72%, 520px)` | |
| Tail tip | `7px` triangle | Asymmetric border-width |
| self tail tip `top` | `13px` | Shifted down to the avatar's vertical center |
| header avatar | `32px` | Header is denser |

## 10. Grouping Rules

Reuses `classifyGroupFlags` from [`web/src/app/lib/chat-box/group-logic.ts`](../../web/src/app/lib/chat-box/group-logic.ts) (already unit-tested):

- **Same sender + within a 5-minute window** of consecutive messages are grouped together.
- `isShowHead`: sender changes / exceeds 5 minutes / after a date separator → new group head (shows avatar + name).
- `isDateShrink`: same group as the previous → merged (no standalone time, no avatar).
- Group-position derivation: `isShowHead → head`; last item in a group (next item is a different group) `→ tail`; group middle `→ mid`.

## 11. Desktop Differences

The message list is responsive and primarily mobile. Desktop (wide screen + precise pointer) differences:

- Bubble `max-width` uses `min(72%, 520px)` (mobile uses `calc(100% - 104px)`).
- The control panel is a persistent side bar (mobile uses a draggable FAB + drawer) — this is a playground control difference and is unrelated to the message-list visual spec.

## 12. Explicitly Out of Scope

- **Read receipts**: not done. If added in the future, it will use the "actively send an explicit receipt-bearing message" approach, rather than implicitly attaching one to every message.
- **self name / self avatar omission**: not omitted — both sides' group heads show avatars (symmetric); only self is unnamed.
- **Bubble outline / gradient**: currently solid fill + shadow. If gradients or outlines are added in the future, the tail-tip approach must change from a border triangle to `clip-path` (the tail tip is cut from the bubble's fill, inheriting the gradient naturally).

## 13. Reference Implementation

- Validation playground (hand-written DOM, `pg-` prefix; to be deprecated along with the real component after phase-4):
  - [`web/src/app/pages/chatbox-playground/chatbox-playground.component.ts`](../../web/src/app/pages/chatbox-playground/chatbox-playground.component.ts) (`createItemEl` renders the message row)
  - [`...chatbox-playground.component.scss`](../../web/src/app/pages/chatbox-playground/chatbox-playground.component.scss) (all visual rules)
  - [`...chatbox-playground.component.html`](../../web/src/app/pages/chatbox-playground/chatbox-playground.component.html)
- Grouping logic: [`group-logic.ts`](../../web/src/app/lib/chat-box/group-logic.ts)
- Design tokens: [`_tokens.scss`](../../web/src/app/assets/_tokens.scss)

## 14. Scroll Architecture (Relative Scroll)

The message-list virtual scroll adopts **relative scroll + sentinel**, not "absolute positioning + global prefix sum". Kernel implementation: [`chat-box-scroller.ts`](../../web/src/app/lib/chat-box/chat-box-scroller.ts). For the decision background see the [Decision Record](#decision-record).

### Why Not Absolute Positioning

The absolute-positioning architecture (global `tops[]` prefix sum + `scrollToIndex` arbitrary jumping + precise total height) is designed for needs like "draggable progress bar / jump to the Nth item". 1-to-1 chat **does not need this**:

- Streaming append (new messages pinned to the bottom), pulling history upward (prepend), follow-on-receive, occasional quote jumps (within the already-loaded range) — none of these need the precise position of an unmounted item.
- The scrollbar is **hidden on all platforms** ([§2](#2-message-row-structure) `.pg-viewport` `scrollbar-width:none`); users rely on wheel / gestures, not on dragging the scrollbar.

So global coordinates are dropped, **managing only the mounted region**.

### Architecture

- **No global `tops[]`/`heights[]` maintained**: content uses normal document flow (item blocks stacked), and native scrolling scrolls the document flow directly (compositor thread at 120Hz + mobile fling).
- **Bidirectional recycling** (a buffer is reserved above and below the viewport, default 1500px):
  - Insufficient mounting above (scrolling up to see earlier) → mount earlier items at the top + `scrollTop += their height` (anchor compensation).
  - Excessive headroom above → unmount the far-top + `scrollTop -= its height` (anchor compensation, no visual jump).
  - Insufficient mounting below → mount subsequent items (DOM append).
  - Excessive headroom below → unmount the far-bottom (do not touch scrollTop; the bottom does not affect the upper anchor).
- **Top sentinel + IntersectionObserver**: scrolling to the current mounted top triggers `onLoadMore` to load history upward.
- **Pin to bottom**: `scrollTop = scrollHeight - clientHeight` (native API, no total height needed).

### Element Interfacing (VsElement)

Each mounted element implements the [`VsElement`](../../web/src/app/lib/chat-box/chat-box-scroller.ts) interface; the kernel interacts with elements only through it, **framework-agnostic** (ng components / hand-written DOM each implement their own):

| Method | Use |
| --- | --- |
| `estimateHeight()` | Placeholder at mount instant / before real measurement (prepend pre-compensation, first-frame stability, balance initial value) |
| `onHeightChange(cb)` | Subscribes to real-height changes, returns an unsubscribe; the element uses ResizeObserver / image load, etc. internally. On receipt, the kernel "applies anchor compensation if above the viewport" |
| `destroy()` | Cleanup on unmount (disconnect observer / destroy ng view) |

> Both height methods are **only ever called on mounted elements** — estimation never touches "unmounted items" (that is a need of the absolute-positioning architecture, abandoned here). When phase-4 switches to real ng components, only the `VsElement` implementation returned by the `createItem` hook is replaced (component ref + the component's `heightChange` output), **without changing a single line of the kernel**.

### Cost

- No support for `scrollToIndex` jumping to an arbitrary unmounted position (chat does not need it).
- The scrollbar is hidden on all platforms, so no "total progress" is shown (fits the chat scenario).

## Decision Record

> Records the key choices settled after going back and forth, to avoid later redoing things as "standard WhatsApp" and violating established preferences.

- **Style**: iMessage → **WhatsApp** (abandoning iMessage / Telegram).
- **Avatar visibility**: self not shown → **both sides' group heads show (symmetric)**.
- **Avatar shape**: circular → **WeChat-style square 8px**.
- **Avatar size**: 32px → **40px (industry standard)**.
- **Name**: both sides shown → **only the other side shown, self hidden** (industry convention; the other side is retained for group-chat compatibility).
- **Tail tip**: fixed from "invisible (equal-width four-side border hidden inside the same-color bubble)" to **asymmetric border-width**; after hiding the self name, added **self tail tip shifting down to the avatar's center line**.
- **Timestamp format**: first decided "bubbles show `HH:mm` / `MM-DD HH:mm` / `YYYY-MM-DD HH:mm` by distance from now" → the across-year string was deemed too long, so changed to **the WhatsApp method: bubbles always `HH:mm`, all date/year in the date separator row** (tiered as `today`/`yesterday`/`Wed`/`M-D`/`YYYY-M-D`).
- **Read receipts**: not done.
- **min-height**: pure UI parameter (40px), decoupled from virtual-scroll fetch / height computation.
- **Scroll architecture**: absolute positioning + global prefix sum → **relative scroll + sentinel** (dropping `tops[]`/`heights[]`, interfacing elements via `VsElement`, mandating both `estimateHeight` + `onHeightChange` interfaces). Reason: chat is streaming-append, primarily pin-to-bottom, the scrollbar is hidden on all platforms, and no arbitrary index jumps → no need for the precise position of unmounted items, only managing the mounted region.
