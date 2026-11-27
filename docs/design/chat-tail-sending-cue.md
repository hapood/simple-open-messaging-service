# Tail sending cue

> Scoped supersession: [Gap-driven chat message windows](chat-gap-driven-message-window.md)
> now owns history arrival presentation and positioning: immediate new messages,
> independent scroll animation, spinner-owned fade and canvas-relative movement
> of existing messages, follow-state rules, and `predestory()` lifecycle. The 70%
> large-arrival exception remains. The self-side sending 3dot now shares its
> appearance animation with incoming self/peer activity on one special row.
> Disappearance is immediate. Task ownership and the cue's non-history identity
> are unchanged; the old per-message cue attachment is superseded.

The sending cue is part of one special live-tail activity row, with self-side
and peer-side 3dots and avatars on the same horizontal line. It is not a historical
message, optimistic copy, or read target. Ordinary server messages still enter
through queries; sender preview metadata does not mount bodies.

This revises the shared task-indicator presentation in
[chat-window-loading-and-sending-tasks.md](chat-window-loading-and-sending-tasks.md).
Task ownership, the task panel, and the rule that sending work stays outside
history do not change.

## Placement

Render the special row at the eligible live tail, not independently inside every
message renderer. Both sides share one measured height. The row has presentation
identity but no message seq or history-cursor identity. Preserve existing empty-
thread/header fallback until the live-tail eligibility rules are satisfied.

Each side applies the normal sender grouping policy from
[create-item.ts](../../web/src/app/components/message-cards/create-item.ts).
For the self side:

- The newest message is a group-compatible plain-text message from the local
  sender: the cue is a continuation. Hide its avatar and name, and hug the
  message bubble above it.
- Otherwise the cue is a group head and shows the self avatar when settings
  allow it. Media, file, and system rows do not become compact sender runs merely
  because their creator is the local user.
- Do not show a self name.

For peers, the oldest observed unconsumed sender supplies the normal grouped
avatar. Other observed group senders overlap to the right of peer 3dot, at most
three actual avatars plus `…`; never display an unreliable `+N` count. Components
own avatar fades. Both avatar positions remain on the same row.

Appearance commits the row's real height and uses the shared cross-message rAF
batch. Removal is immediate. Neither operation creates a historical message.
Bottom-pin contact includes this row, not just the newest message's bottom.
Horizontal widths may be fractional; all height-contributing values are integer
CSS pixels.

## Cue contents

Self-side dots remain while sending is active or observed self-authored messages
are awaiting kernel consumption. Peer-side dots reflect pending peer messages,
not remote typing. Head `author` (account/namespaceId) is required for a nonzero
message head and omitted for zero. It reuses the outer message coordinate and
existing frontend profile/avatar pipeline. System
accounts are ignored for sender presentation, not history loading. Author facts
and their bounded cache follow the
[window contract](chat-gap-driven-message-window.md#53-head-author-and-bounded-ownership).
Do not hide incoming activity merely because local sends finished.

Both sides share appearance: existing messages move upward relative to the canvas
while 3dots fade in. That finite cross-message batch prohibits balance. Removal
has no fade, spring, or reverse movement animation. After removal, correct only
actual viewport bottom blank space, including when messages merged into an album.
Do not hide remaining failure presentation merely because dots disappear.

New visibility waits behind an active appearance batch; the repeating dot pulse
never holds the gate. Scroll remains independent and interruptible. Component-
local effects and task projection are not controlled by the kernel timer.

To the right of the dots, reuse the independent `OutboxIndicatorComponent`.
It owns task icons, count animations, and the task-panel event, with no biography
or viewport knowledge. The header wraps its own instance in the biography flip
container; the tail uses the component directly. Both consume the same task
projection. Instances do not move between hosts, and the tail never plays a
biography flip.

- The tail shows only the task face, never the header biography face.
- One active task: dots only. Hide the task face.
- More than one active task, or a visible failure group: show the task face beside
  the dots. It opens the same conversation task panel.
- While valid `pinToBottom` is held, suppress the header task face even when the
  3dots are hidden. Preserve biography according to the other composer/header
  rules. Otherwise retain the tail-visible suppression rule with visibility
  hysteresis; tail visibility alone is not the pin predicate.
- The thread list keeps its own non-interactive indicator. It does not follow this
  viewport move.

## Indicator groups

The message, upload, and failure groups appear independently. A task is still
classified once: an attachment is an upload, not also a plain message. Completed
tasks count in neither group.

- A group is visible only while its count is greater than zero.
- The failure group is visible only when its count is greater than zero and both
  active counts are zero. Active sending suppresses the failure group; it does
  not change the stored failure records.
- Zero to one: the group's outer wrapper expands its width and fades in. The
  entering count does not also play a numeric flip.
- Counts may jump directly between arbitrary values. Animate directly to the
  latest positive count, never replay intermediate integers.
- Any positive count to zero: remove the group's icon and count immediately,
  without a count flip or fade-out. Animate the surrounding width to its new
  target; do not keep zero-valued content visible while the width collapses.
- Include each group's gap in its collapsing wrapper so a hidden group leaves no
  gap.
- The three groups do not wait for one another. A newer count change cancels that
  group's in-flight animation and renders the latest value.
- The cue wrapper, including the dots, also animates width when its composition
  changes. Height remains 20px for the indicator row and an integer pixel height
  for the cue row.
- Respect reduced motion by applying the final layout without animation.

Header biography visibility remains the existing rule: show the biography only
when the composer is inactive and every group count is zero. Composer activation
still uses the composer's activation state, not raw focus.

## Arrival

New messages and new album cells appear immediately, independently of the dots.
Do not identify an outbox or pending row to select an entry effect, and do not
reuse legacy row enter classes.

Positioning and measured bottom following use the
[gap-driven window contract](chat-gap-driven-message-window.md#6-bottom-follow-state-and-the-large-arrival-exception).
Preserve the 70%-of-viewport growth limit and 120ms burst aggregation. Count new
message/album height, not cue or reserve churn. Scroll remains interruptible;
both tail 3dots use the shared appearance batch with coordinated canvas-relative
movement of existing messages. Pic internal size and selection transitions belong
to their components, without kernel animation locks.

Hide a side only after its relevant tasks and incoming seqs are consumed; removal
is immediate when admitted. A pending incoming side keeps the row present even
when all local sends have finished.

## External reflow

Self-avatar visibility and viewport width changes enter a 200ms quiet-period
window. Further changes reset the timer. Do not start new paging demands while
waiting. Once quiet, refresh mounted row heights and prefix geometry without
writing scrollTop. A delivered batch or explicit replacement flushes pending
measurement before capturing its anchor. Unbinding cancels the timer.

Author labels remain single-line with ellipsis and do not enter this reflow path.
Height-neutral cache URL, progress, and icon updates remain local paint updates;
they do not rebuild message bodies or trigger anchor correction. Tail task state
is passed as an explicit renderer input, not subscribed to by the cue itself.
