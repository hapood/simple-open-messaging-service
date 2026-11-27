# Window positioning scenarios

> Superseded positioning target:
> [Gap-driven chat message windows](chat-gap-driven-message-window.md) uses
> transaction-local dynamic references for ordinary reading, separate explicit
> scroll/pin paths, and scroll animation independent of the spinner batch's
> coordinated canvas movement. New messages appear immediately. The selector
> table below records the intermediate implementation, not the new contract.

> Design revision: [Chat window loading and sending-task presentation](chat-window-loading-and-sending-tasks.md)
> supersedes the pending-in-history policies below. Sending tasks move to the
> header/task panel and contribute no history geometry. The pending-height branch
> of `goToLatest` and historical pending confirmation/reorder paths must be removed.
> The remaining sections describe the intermediate implementation, not the final
> approved sending-task design.

Position selection is centralized in `ChatBoxScroller.selectPosition` using
`WindowPositionScenario`. Ordinary mutations capture an identity and viewport
offset before changing the window. Explicit pinning selects after mounting and
measurement. All restoration clamps to the actual scroll range; short content
uses the existing bottom-aligned layout.

| Case | Selection time | Anchor | Preserved edge |
| --- | --- | --- | --- |
| `olderDelivery` | Before page mutation | Old first formal history item (older spinner slot) | Top |
| `newerDelivery` | Before page mutation | Old last formal history item, whether rendered as spinner or message | Bottom |
| `entryDelivery` | Before suffix splice | Old last formal history item | Bottom |
| `pendingUpdate` | Before pending mutation | Last formal history item while bottom history is loading; otherwise existing reading anchor | Bottom while loading |
| `gapReplacement` | At successful delivery, before replacement | First retained message below the gap | Top |
| `itemResize` | Before committing new measured height | Lowest fully visible non-placeholder row under the current height policy | Bottom |
| `viewportResize` | Before committing viewport geometry | Existing viewport attachment policy | Existing attachment |
| `preserveReading` | Before local mutation | Existing reading anchor | Top |
| `goToLatest` | After measuring mounted pending | Latest formal history item centered in viewport space remaining above pending; bottom alignment without pending | Clamped to actual scroll range |
| `pinLatest` | After mutation and measurement | New last formal history item | Bottom aligned to virtual viewport |

Pending/transient rows and non-message gap rows never supply a history-edge
anchor. A normal delivery with no formal history item preserves the scroll
offset; explicit pinning of an empty history window uses bottom alignment.

`item-bottom` stores an offset from the item's lower edge. Restoration uses the
new measured height, so changing a spinner to message content does not require
an ad hoc height-delta adjustment.

## Pending presentation during history loading

Pending records remain source-owned. An HTTP-accepted record stops rendering
while bottom history is loading, without deleting the outbox entry. Loading
transitions also reevaluate previously accepted records, and initialization
omits accepted pending presentations while catching up. Sending and failed
entries remain mounted.

Failure/retry updates apply to existing nodes without reordering or FLIP during
bottom loading. The previous formal tail's bottom is preserved across measured
pending changes. Outside loading, the existing confirmation and reorder behavior
remains available.

## Navigation

`goToLatest()` positions directly when the newest history is already mounted.
Otherwise it delegates one latest-window request to the window owner. It does
not drain newer pages or retain a cross-page navigation/highlight intent.
Message highlighting belongs to explicit message positioning.

## Migration status

Older/newer delivery, entry splice, gap replacement, item resize, pending status
updates, and explicit positioning use the selector. Some viewport/local mutation
call sites still need migration. Head/tail spinner symmetry and removal of the
old tail cap remain incomplete.

Delivery tests distinguish preservation of the previous formal tail from
explicit latest navigation; ordinary viewport demand does not follow each
newly delivered tail.
