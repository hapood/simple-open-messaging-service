# Chat window loading and sending-task presentation

> Scoped supersession: [Gap-driven chat message windows](chat-gap-driven-message-window.md)
> replaces this document's entry/skeleton admission, historical-edge loading,
> positioning, animation, and message-item retirement policies. Real messages
> must no longer become spinner slots. Sending-task ownership, header/panel
> presentation, and durable sending rules below remain applicable except where
> separately revised by the tail-cue design. Historical implementation notes are
> not evidence that the new gap-driven target is implemented.

## Status and scope

Approved frontend design. This document supersedes older designs that mount
optimistic sends or upload cards inside the historical message window. It does
not change backend protocols or transfer ownership.

Implementation and validation status must be assessed per capability, not inferred
from a migration-era working-tree note. The history entry path now reads a
local-only window around the frozen read cursor; shell/composer readiness is
independent of history initialization, and older/gap queries have consumer-owned
cancellation. See the current entry contract in
[chat-history-entry-and-window.md](chat-history-entry-and-window.md). These changes
do not establish complete browser or native history-window acceptance, nor do
they establish completion of sending-task or download/save capabilities.

## Responsibility boundaries

- The history scroller owns historical identities, edge demand, measurement,
  positioning, and scrolling. Sending tasks are not historical rows.
- The window owner coordinates loading, failure, cancellation, and replacement.
- Views own their DOM, observers, animation resources, and disposal.
- The existing send/outbox and media-transfer services retain task state, transport,
  retries, cancellation, attachment resources, and server-echo reconciliation.
- Presentation derives from those records; it must not create a second send queue.

## Whole-window skeleton

`createSkeleton` means creating a whole-window loading skeleton, never an edge
spinner. Show it during an empty-cache initial load and navigation to a target
outside the mounted window. An already mounted target requires positioning only.
Ordinary older/newer pagination uses edge-item loading presentation instead.

The skeleton fills the available history viewport from bottom to top. Its bottom
is attached to the viewport's content baseline, with the normal bottom reserve
accounted for separately. Generate enough rows to cover the viewport; allow the
uppermost row to be clipped at the top. A fixed five-row template is insufficient.
Recompute coverage on viewport size changes. Heights, vertical gaps, padding,
and line heights use integer CSS pixels.

Skeleton rows are not mounted historical items and do not participate in history
prefix sums, cursors, trimming, or message anchors. Keep the composer available.
Successful empty results show the empty state, errors show a retryable result,
and superseded window loads must not publish late skeleton/result transitions.

## Historical edge presentation

The oldest/newest mounted formal history item represents each loading edge.
Pending tasks never provide a slot. A sole historical item may represent both
edges; coordinate its presentation as one item rather than competing renderers.

The existing mount/render contract receives an explicit message/loading/retry
presentation state. It renders the message body or spinner/retry content through
that same path. Do not infer loading from a missing neighbor, introduce a separate
`createEdgeStatus` factory, use `createSkeleton` for pagination, or hide a message
body using CSS overrides. Keep logical message identity across state changes and
measure the resulting layout in the normal batch before restoring the anchor.

Delete the independent tail-cap DOM, observer, height contribution, and obsolete
CSS. Bottom reserve is a separate layout region and remains last.

## Sending tasks are outside history

Remove optimistic sending bubbles and upload aggregate cards from the historical
mount/render pipeline. They contribute no history height, anchor, cursor, trimming
barrier, or latest-navigation offset. Remove pending-specific history reorder,
FLIP, and confirmation choreography. Ordinary server messages enter history via
normal query/realtime delivery, with existing identity reconciliation preserved.

In particular, latest navigation no longer subtracts pending height or centers a
formal message above a pending stack. Use formal-history positioning without a
sending-task geometry branch. The composer bottom reserve remains independent.

## Header bio and task indicator

Replace the peer/group bio in the header with a centered, content-width task
indicator. Message, upload, and failure groups appear independently. Counts
describe the current conversation. Classify a task once: an attachment must not
count as both a plain message and an upload. Failed or completed tasks do not
inflate active counts. Group visibility, width animation, and the tail cue that
shares this task face are defined in
[chat-tail-sending-cue.md](chat-tail-sending-cue.md).

Biography visibility remains:

- Show the task face when the composer is active, either active count is nonzero, or visible failures remain.
- Return to the bio only when the composer is inactive and every group count is zero.
- While the tail cue's task face is fully visible, suppress only the header task face.

Use the composer's existing activation state, not raw input focus. Opening an
attachment chooser or task panel must not accidentally change that state.

The entire bio/indicator transition uses a calendar-page flip. Each count also
uses a calendar-page flip on change. During the whole-line transition, render the
latest counts without nested count animations; resume individual flips afterward.
Coalesce rapid changes to the latest value, handle digit-width changes, and do not
queue stale animations. Keep a fixed integer-pixel line height so header geometry
does not change. Animate transforms/opacity, not measured box height.

Upload icon: static upward arrow at zero; a looping upward-arrow motion above
zero. Message icon: static at zero and one; above one, a stationary main bubble
with a small rear bubble moving gently upward and fading to suggest a queue.
Keep icon slots fixed-size and do not rotate them like loading spinners. Respect
reduced-motion preferences for all animations.

Clicking the visible task face opens the task panel.
Use a keyboard-accessible control and meaningful localized labels. Failure visibility and its width animation follow the tail-cue contract. Count failures from the single task projection;
media execution must not maintain a second authoritative task collection. Failure records do
not auto-expire: users must explicitly clear them, or retry them successfully.
While failures remain, neither header bio nor thread-list preview returns.

Remove the aggregate transfer display from HomeHeaderComponent. Each thread-list
item instead reuses this indicator and calendar flip in place of its preview.
List rows do not use composer activation; active or failed tasks control visibility.
Adapt icon size to the preview typography without changing row height or nesting
an interactive indicator button inside the thread-row button.

## Task panel

Reuse and extend the existing upload-detail UI rather than duplicate transfer
business logic. Show both plain-message sending tasks and attachment tasks for
the current conversation only. There is no global task-management UI; the current
conversation supplies panel operations and scopes its lifetime.

- Plain messages: content preview, sending/failure state, cancellation and retry
  where supported. Do not invent percentage progress or speed for an HTTP message.
- Attachments: filename/preview, progress, transferred/total bytes, upload speed,
  status, cancel, retry, and the existing send-completed operation where supported.
- Speed derives from byte progress over elapsed time; reset samples on retry,
  handle stalled transfers, and do not retain a nonzero active speed after stopping.
- Cancel remains a source-owned operation; closing the panel does not cancel tasks.
- HTTP acceptance and server echo must not double-count a task or insert duplicate
  history messages. Preserve existing cancellation/acceptance race semantics.

The conversation-scoped `upload-detail-dialog` presents tasks, while
`MediaTransferService` owns execution controls rather than a second task queue.
The obsolete `ThreadTransferController` has been removed.

## Durable sending intents

A pending database row is the sole durable fact that a send remains unconfirmed.
Rows contain `clientMessageId`, `threadId`, and a typed request payload, not rendered
message cards, progress, error text, or a persisted execution phase. Runtime views
may add sending or failed phases and execution handles. A successful response deletes the row; there is no accepted phase.

Persist the intent before starting network work. Both IndexedDB and SQLite store
attachment metadata only: `path`, `partId`, filename, size, and exact upload MIME.
On the browser, `path` is an opaque key into the current runtime's File registry;
it is neither a filesystem path nor a persistent blob URL. Native hosts retain the
original filesystem path or provider URI. Never copy selected attachments into a
staging directory. Android requests persistent read permission where offered;
providers with temporary grants may become unavailable after restart.
Preserve client IDs, part IDs, gallery order, filenames, and MIME across retries.
Never reconstruct the request from a rendered card.

Manual retry resolves every attachment before starting uploads. Missing or
unreadable resources leave the task failed and show “Attachment unavailable.
Please cancel and upload again.” Do not automatically cancel the task or open a
file picker. Browser references generally cannot be recovered after a page or
process restart. Native hosts attempt to reopen the stored paths and report the
same error when that fails. Keep opened handles through execution rather than
validating and reopening later. Check readability and protocol byte counts, but do
not precompute or compare a client-side hash or digest.

On process recovery, read remaining rows and project them as failed. Recovery
never resumes network work automatically. Manual retry uses the original request
and idempotency identity. A successful send or upload response removes the row
and releases runtime references. A loaded history message may remove only a
failed leftover with the same client message ID; it must not remove an in-flight
send. Explicit cancellation also removes the row. Never delete user-selected source files. Only files generated and owned by the
application, such as its temporary recordings, are eligible for owned-file cleanup.

Storage takes its names, connections, and lifetime from existing database
management. It does not validate login identities or implement another login,
reconnection, or logout state machine. Logout cancels execution and clears tasks
and their resources through existing cleanup.

Ordinary message/media cache clearing preserves pending rows and referenced
attachments, including failed tasks. Full database recreation deliberately clears
all data, including pending sends; it has no pending-table exception. Native
files left without references can be reclaimed by temporary-resource cleanup,
which must also exclude files currently being created or recorded. Avatars are
measured but not deleted by ordinary chat-cache clearing. Temporary upload usage
is one category, not separate active and orphan categories.

### Integration status

Pending sends are a database projection. Admission persists the intent before
execution. A successful send or upload response deletes that row directly; there
is no accepted phase and no cache scan. An open history page deletes only a failed leftover whose client message ID
is on the loaded page. It does not delete an in-flight send.
Restart projects remaining rows as failed and does not resume network work.
Native uploads use the original path or URI, open every gallery resource before
staging, and do not copy user files. Owned recordings are the only files this
flow deletes. Explicit native save streams the response into the selected destination. It does not download into the media cache and then copy.
Device recording, content-URI permission expiry, and album save are not verified
on hardware.

## Server download presentation

Sending-task completion no longer triggers spinner-to-check on history messages.
That choreography is reserved for the server-download notification presentation.
A server-download stub is an ordinary file/image card with a downloading state
and a spinner at its top-right, not an optimistic send or whole-window skeleton.
Scope completion animation to the actual download-notification transition;
remounting ordinary historical cards must not replay it. Keep download failure
and retry distinct from client upload failure and retry.

## Measurement and lifecycle

Use one measurement batch to read historical row and remaining layout-region
heights. Capture the scenario anchor before mutation, commit measured geometry,
then restore it. Observers request this same flow rather than maintain parallel
compensation algorithms. Destroying views and clearing their references is
lifecycle work; resetting geometry does not read disposed DOM.

With the pending region removed, remove its observer, height cache, and host too.
Do not carry obsolete pending layout abstractions into the new header/panel UI.

## Delivery and validation

Implement complete capability slices and run grouped validation instead of
preserving obsolete pending branches to satisfy old tests.

1. Derive a unified presentation snapshot from existing send/transfer records.
2. Build the header indicator and extend the task panel, including animation and
   failure-only discoverability.
3. Remove historical pending mounting and geometry, and replace obsolete tests.
4. Implement the whole-window skeleton and explicit edge-item render states.
5. Restrict completion choreography to server-download notifications and remove
   old factories, tail-cap styling, and confirmation coupling.

Cover zero-cache entry, short/tall/resized skeleton viewports, out-of-window and
mounted-target jumps, late cancelled results, and loading/error/empty transitions.
Cover both task kinds together, zero counts, composer activation, failure-only
state, rapid count changes, digit-width changes, reduced motion, cancellation,
retry, acceptance/echo races, panel close/reopen, and conversation switching.
Verify history anchoring independently of task counts. Include browser-level
layout/interaction checks and screenshots for header/panel/skeleton changes,
as well as TypeScript, focused unit suites, and diff checks.
