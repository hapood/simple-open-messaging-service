# Tail sending cue

The tail sending cue is extra presentation rendered with the newest mounted
server message. It is not its own mounted item, historical message, or optimistic
copy. The newest server row remains the history identity. Ordinary server
messages still enter through query and realtime delivery.

This revises the shared task-indicator presentation in
[chat-window-loading-and-sending-tasks.md](chat-window-loading-and-sending-tasks.md).
Task ownership, the task panel, and the rule that sending work stays outside
history do not change.

## Placement

When the mounted row is the newest server message known to the client, its
renderer also paints the cue below that message, inside the same measured host.
No other row paints it. If that newest message is not mounted, or the thread has
no server message, the cue is absent and the header task face covers the state.

The cue does not get a kernel identity. Its avatar follows the self-avatar
setting and the row grouping policy in
[create-item.ts](../../web/src/app/components/message-cards/create-item.ts),
applied locally to this host with the cue treated as a plain-text presentation:

- The newest message is a group-compatible plain-text message from the local
  sender: the cue is a continuation. Hide its avatar and name, and hug the
  message bubble above it.
- Otherwise the cue is a group head and shows the self avatar when settings
  allow it. Media, file, and system rows do not become compact sender runs merely
  because their creator is the local user.
- Do not show a self name.

Showing or hiding the cue changes that host's measured height through the normal
height callback. It does not insert, reorder, or trim a history item. Jumping to
the newest message includes the cue because it belongs to that host. Horizontal
width may animate fractionally; both the message body and the cue keep integer
pixel heights.

## Cue contents

The typing bubble is three dots whose scale pulses while at least one send is
active. It disappears immediately, without a fade, when no send remains active.
A failure does not freeze the dots.

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
- While this tail cluster is fully visible, hide the header task face and keep the
  biography. When the cluster is absent or not fully visible, show the task face
  in the header. Use a small visibility hysteresis so edge scrolling does not
  flicker. Exact contact with the viewport bottom counts as fully visible; the
  two-pixel tolerance applies only when leaving the visible state.
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

The dots and the arriving message are independent animations.

Do not identify an outbox or pending row. After a delivery is measured, fade a
message only when both are true: it was sent by the local user, and this delivery
keeps the viewport pinned to the bottom. Fade and scale the new content from
opacity 0 and `scale(0.98)` to its normal appearance. Use a centered transform
origin. Do not translate it. Transform must not affect measured height.

Initial positioning and a delivery that preserves the reading position do not
fade. If the returned image is absorbed into an existing album, animate only the
new cell, and only under the same two conditions. Existing cells and the album
row do not replay the animation. The cell transform must not change the album
row's measured height.

Capture attachment and the original edge anchor immediately before mounting.
Top additions preserve the original top message's top; bottom additions preserve
the original bottom message's bottom, excluding the independently measured tail
cue. Replacements preserve the real message nearest the viewport midpoint.

After synchronous rendering and measurement, restore the anchor first. If the
viewport was following the bottom and positive message-height growth does not
exceed 70% of the viewport, start interruptible smooth scrolling to the content
bottom (including the cue and reserve). The same growth gate applies to
replacements. An unfinished bottom-follow animation retains attachment for the
next delivery; an ordinary message jump does not. User input cancels follow
ownership. A batch above the limit cancels the old follow and preserves reading.
This 70% rule replaces the older three-message rule in
[chat-history-entry-and-window.md](chat-history-entry-and-window.md). The kernel
selects following after measuring the delivery and exposes a paint callback only
for batches that actually follow.

Do not reuse the kernel row enter classes. Those include vertical travel and mean
a new mounted row, not an outbox arrival or an absorbed cell.

If active sends remain after the arrival, the dots stay. If none remain, remove
the dots immediately. The message fade continues either way.

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

