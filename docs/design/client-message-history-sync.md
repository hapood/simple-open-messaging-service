# Client Message History Synchronization

Status: design checkpoints 1 through 5 are approved and implemented. The backend contract,
browser/native range reducers, transactional range storage, browser/native source walkers, viewport gap
projection, and superseded sparse-marker cleanup are complete.

## 1. Scope

This design replaces the web client's message-row section markers with an
explicit per-thread interval model. The first implementation phase covers
message reads only. Tombstone ownership, feeds, and synchronization are
deferred and remain unchanged.

This is a direct cache-schema change. Old rebuildable message caches are
discarded rather than migrated. Superseded methods and fallback paths are
removed; there is no dual-read compatibility path.

## 2. Superseded implementation

The previous client already had bidirectional viewport paging and sparse durable
coverage. `WebdbService` placed `sectionLeft` and `sectionRight` markers on
endpoint message rows, while `MessageCoverageState` separately accelerates the
right-most covered tail.

Row-attached markers cannot represent a backend gap whose endpoints have no
message rows. The new model removes those fields and indexes and stores
intervals directly.

The source-demand control flow remains request-driven. A browser history demand
waits for `MessageRepository.queryBrowserMessageHistory`, which owns the complete
database/HTTP/range-walker recursion and returns the final canonical projection.
A native demand crosses IPC once through `native_message_history_get`; Rust owns
the equivalent SQLite/HTTP/range-walker recursion. Neither path re-reads rows it
has just written. A fully notification-driven database source remains deferred
because the range work does not currently require it.

## 3. Per-thread message ranges

The message database gains a `messageRanges` store or equivalent native table.
All intervals are left-open and right-closed:

```ts
interface MessageRange {
  threadId: number;
  left: number;
  right: number;
  state: 'LOCAL_COVERED' | 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
}
```

`(left, right]` covers exactly the message coordinates `left < seq <= right`.
It satisfies:

```text
0 <= left < right <= Number.MAX_SAFE_INTEGER
```

The states mean:

| State                | Meaning                                                                                                 | Local read behavior                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `LOCAL_COVERED`      | The client has committed a server scan over the interval. Numeric holes inside it are known scan holes. | Read its cached messages. The range itself is not an item.                                       |
| `SERVER_PENDING`     | The backend has a recoverable federation-history gap.                                                   | Do not issue an ordinary fill from inside it. Return the complete range as one pending item.     |
| `SERVER_UNAVAILABLE` | The backend declares the interval unrecoverable.                                                        | Do not issue an ordinary fill from inside it. Return the complete range as one unavailable item. |

Every persisted range means that local paging already has a decision for those
coordinates. Only the complement of the complete stored range union is a local
fetch gap.

For one thread, ranges are canonical:

- they are sorted and never overlap;
- adjacent or overlapping ranges with the same state may merge;
- ranges with different states never merge with one another;
- `LOCAL_COVERED` has precedence over a stale server gap; and
- `SERVER_UNAVAILABLE` cannot regress to `SERVER_PENDING`.

The persistent key must make every range for one thread efficiently readable in
sequence order. Storage keys and indexes belong to checkpoint 3.

## 4. Repository items

A local history read merges:

1. real cached messages read from `LOCAL_COVERED` ranges; and
2. complete `SERVER_PENDING` or `SERVER_UNAVAILABLE` ranges.

Each real message consumes one requested item. Each encountered server-gap
range also consumes exactly one requested item regardless of its coordinate
width. A `LOCAL_COVERED` range contributes no item by itself.

The source maps a server-gap range to a transient viewport item. It is not a
message row and is never persisted in the message table.

## 5. Backend gap projection

Every successful message response returns the full boundaries and
`recoverable` state of each current backend gap that intersects the interval
actually scanned by that response. Intersection is:

```text
gap.left < scan.right && gap.right > scan.left
```

This is the left-open/right-closed equivalent of ordinary interval overlap and
includes the containment case. Wire gaps using inclusive `startSeq/endSeq` map
to `(startSeq - 1, endSeq]` at the client boundary.

The client trusts the complete boundaries of every positively returned gap,
including the portion outside the scanned interval. Gap absence is
authoritative only inside the actual scanned interval.

## 6. Database isolation and commit locking

Network requests may execute concurrently. Network single-flight is not a
correctness requirement because backend pending gaps only shrink; the range
reducer prevents a stale larger response from expanding a newer smaller gap.

Database commits remain serialized by `threadId`. Each response obtains the
thread's logical commit lock and opens one transaction spanning `messages` and
`messageRanges`. The transaction:

1. reads the complete current range set for the thread;
2. validates and reduces the response against that latest set;
3. computes the canonical committed messages and resulting ranges;
4. writes those facts; and
5. commits before returning that same canonical projection to the initiating
   read.

No observer can see messages with old ranges or ranges without their matching
messages. A validation or write failure aborts the complete transaction.

IndexedDB has no SQL predicate lock, so the browser uses a keyed per-thread
commit mutex plus one `readwrite` transaction. Native storage uses the
equivalent keyed serialization and database transaction. Different threads can
commit independently at the logical-lock layer.

A raw network response is never returned directly to the scroller. The
initiating repository operation waits for commit and continues its range walk
with the canonical projection returned by that transaction. It does not perform
a redundant second read of the rows it just wrote. The existing scroller
demand-current check continues to prevent a cancelled demand from mounting its
eventual result. Its useful cache fill may still commit.

This phase adds no `historyChanged` stream and does not convert the source into
a notification-driven database observer. Cross-source and background range
notifications are deferred until a concrete consumer requires them.

## 7. Coordinate origin

Message business sequences start at `1`; `0` is the fixed exclusive cursor
before complete history and is never a message sequence. `after=0` is the
canonical forward start. Later allocation may contain holes.

The federation protocol currently allows the first allocated message sequence
to exceed `1`. That permission must be removed from
[`spec/v1/protocol.md`](../../spec/v1/protocol.md) and
[`spec/v1/message-feed.md`](../../spec/v1/message-feed.md). Retention or
authorization may create explicit server gaps but must not move the coordinate
origin.

## 8. Approved checkpoint 1 decisions

1. Replace `sectionLeft` and `sectionRight` with explicit per-thread ranges.
2. Use `LOCAL_COVERED`, `SERVER_PENDING`, and `SERVER_UNAVAILABLE`; absence of
   any range is the fetchable local gap.
3. Return backend gaps intersecting each actual scanned interval and trust a
   returned gap's complete boundaries.
4. Count each server-gap range as one repository item and map it to one
   transient viewport item.
5. Lock a thread's complete local range set during each atomic message/range
   database commit.
6. Keep the existing demand orchestration. Require a successful commit before
   using its canonical committed projection, but do not re-read just-written
   rows.
7. Fix the coordinate origin at exclusive cursor `0` and start messages at
   sequence `1`.
8. Recreate old caches, remove superseded code, and defer tombstones.

## 9. Checkpoint 2: older-direction range walker

### 9.1 Inputs and terminology

This checkpoint defines the older-direction local read driven by exclusive
cursor `before` and requested item count `count`.

The walker carries:

```ts
interface OlderWalk {
  threadId: number;
  before: number;
  remaining: number;
  items: Array<MessageItem | ServerGapItem>;
}
```

Every recursion strictly moves `before` toward `0` or consumes at least one
item. It therefore terminates at another range, an uncovered interval, the
requested count, or the origin.

### 9.2 When `before` is inside `LOCAL_COVERED`

Read cached messages older than `before` inside that complete local range.
Append at most `remaining` messages.

- If the item budget is full, return it.
- If more coordinates remain inside the same range, continue the local read.
- If the range is exhausted before the item budget, recurse from its left
  boundary with the remaining budget.
- Do not issue HTTP for coordinates inside this range.

Numeric sequence holes inside the range are skipped because the range already
proves they were scanned.

### 9.3 When `before` is inside a server gap

For `SERVER_PENDING` or `SERVER_UNAVAILABLE`:

1. append the complete range as one item;
2. decrement `remaining` by one;
3. move the exclusive `before` cursor to `left + 1`, so the next recursion can
   still include a legitimate message at `seq=left`; and
4. recurse when more items are requested.

No ordinary network request is issued from inside either range. Pending and
unavailable ranges use distinct item states and never merge with each other.

### 9.4 When `before` is outside every range

The cursor is in a fetchable local gap. The walker first performs an optimistic
message-table read for up to `remaining` older cached messages without yet
using range membership as a filter. This read is only a cheap look-ahead; it is
not returned before range reconciliation.

Let the oldest optimistic row's sequence be the provisional boundary. If fewer
than `remaining` rows exist, use `0` as that boundary. Inspect all stored ranges
intersecting the look-ahead interval between the provisional boundary and
`before`.

Find the stored range closest below `before`:

- if a range is found, its right boundary limits this HTTP fill so the request
  does not refetch the already classified interval below it;
- if no range is found, issue the ordinary bounded network request down to the
  provisional boundary or origin; and
- server-gap items already reached by earlier walker steps reduce the remaining
  HTTP message budget. A classified range below the current unclassified
  interval does not consume budget until the walker reaches it, because unknown
  coordinates above it may still contain newer messages.

The HTTP response is committed through the range reducer. The original source
demand remains pending until commit, then continues the walk using the returned
canonical committed projection and remaining item budget. It never appends raw,
uncommitted HTTP messages to the optimistic look-ahead and does not re-read the
rows just written.

### 9.5 Mixed-range recursion example

Given:

```text
(80,100] LOCAL_COVERED
(60,80]  SERVER_PENDING
(40,60]  LOCAL_COVERED
(30,40]  SERVER_UNAVAILABLE
```

An older read beginning inside `(80,100]`:

1. returns cached messages from `(80,100]`;
2. if budget remains, returns `(60,80]` as one pending item;
3. if budget remains, returns cached messages from `(40,60]`;
4. if budget remains, returns `(30,40]` as one unavailable item; and
5. if budget remains, continues from exclusive `before=31` into the next range
   or local fetch gap, preserving a possible message at `seq=30`.

No request crosses a stored range. HTTP is scheduled only after recursion
reaches coordinates absent from the complete range union.

### 9.6 Monotonic response reduction

Concurrent requests may return in either order. Let `W` be one response's
actual scanned interval and `G` its returned full server gaps.

Under the per-thread commit lock:

1. Preserve every current `LOCAL_COVERED` coordinate. A returned server gap
   cannot overwrite it.
2. Preserve every current `SERVER_UNAVAILABLE` coordinate against a returned
   `SERVER_PENDING` state.
3. Within `W`, coordinates not covered by a returned server gap become
   `LOCAL_COVERED`.
4. Overlay returned `SERVER_PENDING` only on still-unclassified or currently
   pending coordinates. Subtract current `LOCAL_COVERED` and
   `SERVER_UNAVAILABLE` first.
5. Overlay returned `SERVER_UNAVAILABLE` only on still-unclassified, pending,
   or already unavailable coordinates. Subtract `LOCAL_COVERED` first.
6. Insert returned messages idempotently and require their coordinates to end
   in `LOCAL_COVERED`.
7. Normalize the complete thread set without merging different states.

This makes gap shrinkage monotonic. For example:

```text
new response:   (19,25] LOCAL_COVERED + (25,30] SERVER_PENDING
stale response: (19,30] SERVER_PENDING
final state:    (19,25] LOCAL_COVERED + (25,30] SERVER_PENDING
```

The stale larger pending interval cannot cover the locally confirmed smaller
result. Network single-flight is therefore unnecessary for correctness, while
the per-thread database commit lock remains required.

### 9.7 Required server-gap transitions

For an actual scanned interval `(9,50]` and returned pending gap `(19,30]`, the
result is:

```text
(9,19]  LOCAL_COVERED
(19,30] SERVER_PENDING
(30,50] LOCAL_COVERED
```

If a later response confirms messages through `25` and returns only
`(25,30] SERVER_PENDING`, the result becomes:

```text
(19,25] LOCAL_COVERED
(25,30] SERVER_PENDING
```

If a later scan returns no gap for `(19,30]`, that complete interval becomes
`LOCAL_COVERED`, even when the response contains no message rows. If
`recoverable` becomes false, only the still-pending coordinates transition to
`SERVER_UNAVAILABLE`; a stale response cannot change them back to pending.

A page stopped early changes only its actual scanned interval. Its requested
far boundary has no negative authority.

### 9.8 Page ownership at a source seam

Source page ownership uses the same left-open, right-closed convention as
stored ranges. A page owns `(page.left, page.right]`, and a server-gap item is
owned by the page containing the gap's inclusive right endpoint:

```text
page.left < gap.right <= page.right
```

The backend may return the same complete gap to two adjacent queries because
the gap intersects both scanned intervals. Both responses reduce the gap into
the database, but only the right-hand page projects the item. The left-hand
page does not count or display it and continues walking toward older
coordinates with the unchanged item budget.

This gives every gap one display owner before results reach the scroller. The
scroller therefore performs no gap-specific seam deduplication, merging, or
item-count compensation. Pending and unavailable ranges remain distinct, and
real messages are never absorbed into a gap.

### 9.9 Approved checkpoint 2 decisions

1. Store all ranges as `(left, right]` and use the three states without
   cross-state merging.
2. Implement the older-direction read as the recursive range walker above.
3. When outside all ranges, optimistically read `count` messages, inspect the
   intervening ranges, and stop HTTP at the closest stored range's right edge.
4. Count each pending or unavailable range as one requested item and reduce the
   HTTP message budget accordingly.
5. Permit concurrent HTTP fills, serialize only per-thread commits, and enforce
   monotonic reduction so a stale large gap cannot overwrite a newer small gap.
6. After commit, continue the initiating walk with the transaction's canonical
   projection; do not add `historyChanged`, re-read just-written rows, or expose
   uncommitted HTTP data to the scroller.
7. Assign a seam gap to the right-hand `(left, right]` page by `gap.right`; the
   left-hand page neither counts nor displays it, so the scroller needs no
   gap-specific merge.

## 10. Checkpoint 3: API, storage, and transaction contract

### 10.1 Client message-query response

`POST /api/v1/query-messages` extends its success data without changing request
cursors:

```ts
interface MessageHistoryGapDto {
  /** First missing client-visible Message.seq, inclusive. */
  startSeq: number;
  /** Last missing client-visible Message.seq, inclusive. */
  endSeq: number;
  /** True while backend reverse synchronization may still fill this gap. */
  recoverable: boolean;
}

interface MessageQueryPageDto {
  messages: MessageResponseDto[];
  gaps: MessageHistoryGapDto[];
  scannedThrough: number;
  hasMore: boolean;
}
```

`gaps` is always present on a successful page, including as an empty array. It
is not added to cursor-unavailable error data.

Backend federation gaps use publisher coordinates plus `messageSeqOffset`.
Before returning them to a client, the backend converts them to the local
timeline:

```text
localStartSeq = startSeq + messageSeqOffset
localEndSeq   = endSeq   + messageSeqOffset
```

The returned coordinates are then clipped to the participant's serviceable
window. Within that authorization window they retain the full gap boundaries,
even when the current scan intersects only part of the gap. This prevents a
client from learning or persisting coordinates outside its visible history.

The response includes both recoverable and unavailable gaps. It sorts them by
`startSeq`, rejects backend overlap after local-coordinate translation, and
never returns a message whose `seq` lies inside a returned gap.

### 10.2 One backend snapshot

The following facts must come from one consistent PostgreSQL snapshot:

- the participant visibility bounds used for the query;
- the thread end used to bound the request;
- the selected `take + 1` messages;
- the history gaps intersecting the resulting actual scanned interval; and
- the final `scannedThrough` and `hasMore` values.

Reading messages and gaps in separate ordinary statements is unsafe. A reverse
round could commit between them, causing the response to omit both the newly
inserted messages and the now-shrunken gap. The client would then mark those
coordinates covered without caching the messages.

The controller therefore delegates page construction to one query service
running in one repeatable consistent read transaction. Backend reverse commits
already update messages and durable gaps atomically; the client query must
observe either the complete state before that commit or the complete state
after it.

### 10.3 Wire-to-local interval conversion

Local storage uses `(left, right]`. A returned inclusive gap
`[startSeq, endSeq]` becomes:

```text
(startSeq - 1, endSeq]
```

The actual response scan becomes:

```text
forward after=A, scannedThrough=S:  (A, S]
reverse before=B, scannedThrough=S: (S - 1, B - 1]
```

An empty scan produces no storage interval. Conversion occurs once at the
transport boundary; the reducer and storage layer use only left-open/right-
closed ranges.

### 10.4 Browser message database

The rebuilt browser message database contains:

```ts
interface MessageDbSchema extends DBSchema {
  settings: {
    key: string;
    value: MetaRecord;
  };
  messages: {
    key: [number, number]; // [threadId, seq]
    value: CachedMessage;
  };
  messageRanges: {
    key: [number, number]; // [threadId, left]
    value: MessageRange;
    indexes: {
      byThreadRight: [number, number]; // [threadId, right]
    };
  };
}
```

`[threadId,left]` gives one canonical range owner for a left boundary and lets
the storage layer scan all ranges for a thread in order. `byThreadRight` finds
the range nearest below a reverse `before` cursor without scanning other
threads.

The message store drops `sectionLeft`, `sectionRight`, and both indexes. The
message-cache schema version is incremented; validation requires exactly the
new stores and index. A mismatch deletes and recreates the rebuildable message
database.

The former `MessageCoverageState.coveredTail` is removed. Explicit ranges own
coverage. If an independently persisted newest-sequence hint is still required
for SSE/thread-summary reconciliation, it is retained as a small
`messageHead:<threadId>` setting containing only `knownNewestSeq`; it does not
duplicate range boundaries.

### 10.5 Native message database

The native cache adds:

```sql
CREATE TABLE message_ranges (
  user_id         INTEGER NOT NULL,
  thread_id       INTEGER NOT NULL,
  left_exclusive  INTEGER NOT NULL,
  right_inclusive INTEGER NOT NULL,
  state           TEXT NOT NULL CHECK (
    state IN ('LOCAL_COVERED', 'SERVER_PENDING', 'SERVER_UNAVAILABLE')
  ),
  PRIMARY KEY (user_id, thread_id, left_exclusive),
  CHECK (
    left_exclusive >= 0
    AND right_inclusive > left_exclusive
  )
);

CREATE INDEX message_ranges_by_right
  ON message_ranges(user_id, thread_id, right_inclusive);
```

The native `messages` table drops `section_left`, `section_right`, and their
indexes during cache recreation. Browser and native storage expose the same
range operations and reducer semantics. The browser implements the reducer in
TypeScript; native implements the equivalent reducer and walker in Rust so a
source read crosses IPC only once.

### 10.6 Atomic page commit

The storage API accepts the validated page plus its converted scan and gaps:

```ts
interface CommitMessagePageInput {
  threadId: number;
  scan: MessageInterval | null;
  messages: Message[];
  gaps: Array<
    MessageInterval & {
      state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
    }
  >;
  knownNewestSeq?: number;
}

interface CommittedMessagePage {
  messages: Message[];
  ranges: MessageRange[];
}
```

The browser's pure TypeScript reducer produces the complete next canonical
range set inside its IndexedDB commit path. Native owns an equivalent Rust
reducer. A native source-read command accepts the source demand rather than a
pre-reduced page; Rust reads SQLite, performs HTTP fills and recursive range
walking, reduces each response, and commits before it continues.

Under the per-thread commit mutex, the browser transaction spans `messages`,
`messageRanges`, and `settings` when the newest hint changes. The native command
uses `TransactionBehavior::Immediate`. Both paths:

1. load every current range for `(user, thread)`;
2. run the same reducer semantics;
3. fold incoming messages with existing cached deletion/media facts;
4. delete that thread's old range rows and insert the complete normalized set;
5. upsert canonical message rows and the optional newest hint;
6. commit; and
7. return the already computed canonical page projection without re-reading the
   just-written rows.

Whole-thread range replacement is deliberate. Range counts are expected to be
small, and replacing the canonical set is easier to validate than issuing a
sequence of partially visible row edits. The transaction makes replacement
atomic.

### 10.7 Mixed item budget

`count` is a client item budget, while backend `take` counts only messages. The
walker never skips a potentially newer message merely to reserve space for a
server-gap item that lies farther in the older direction.

Budget is therefore consumed in timeline order:

- each committed message appended consumes one;
- each pending or unavailable range actually encountered consumes one;
- a gap below an as-yet-unfetched local interval does not consume budget until
  the walker reaches it; and
- each HTTP leg uses only the budget remaining at that point.

When `before` is outside all ranges, the optimistic raw-message look-ahead and
nearest stored range determine the HTTP cutoff. The request fills only the
unclassified interval above that closest stored range. If the response reaches
that boundary with budget left, recursion consumes the classified range next.

Consequently, a final page containing `k` server-gap items contains at most
`count - k` messages. This is the safe meaning of subtracting unreadable gaps
from `count`; pre-subtracting every gap in the optimistic look-ahead could skip
unknown messages that are newer than those gaps.

The repository-level result becomes a union:

```ts
type MessageHistoryItem =
  | { kind: 'message'; message: Message }
  | {
      kind: 'server-gap';
      left: number;
      right: number;
      state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
    };

interface MessageHistoryPage {
  items: MessageHistoryItem[];
  hasMore: boolean;
  failed?: boolean;
}
```

`hasMore` is derived from the complete walker, not copied directly from the last
HTTP page. It remains true when additional local ranges, local fetch gaps, or a
backend continuation exist in the requested direction. It becomes false at the
coordinate origin only after the walker has committed coverage down to cursor
`0` and no older range or message item remains.

### 10.8 Failure and cancellation

- Validation failure aborts the page transaction and leaves the original local
  fetch gap retryable.
- Transport or business failure returns `failed:true`; it creates no range.
- Cursor-unavailable recovery is handled before ordinary page commit and must
  not fabricate `LOCAL_COVERED`.
- Viewport cancellation does not need to abort an already shared cache fill.
  The fill may commit, but the stale demand-current check prevents mounting its
  result.
- A concurrent stale response may commit only through the monotonic reducer; it
  cannot expand a gap over `LOCAL_COVERED` or regress unavailable to pending.

### 10.9 Approved checkpoint 3 decisions

1. Add `gaps: { startSeq, endSeq, recoverable }[]` to every successful client
   message page.
2. Return client-visible local coordinates, clipped to participant visibility,
   and query messages plus gaps from one consistent PostgreSQL snapshot.
3. Rebuild the message cache with a dedicated `messageRanges` store/table and
   remove marker fields, indexes, and `coveredTail`.
4. Use `[threadId,left]` plus a right-boundary index in IndexedDB, and the
   equivalent `(user_id,thread_id,left_exclusive)` native primary key.
5. Implement equivalent reducers in TypeScript and Rust. Native history reads
   run the Rust range walker behind one source-level IPC call.
6. Replace one thread's complete range set atomically with its canonical
   messages and optional newest hint, returning the computed committed
   projection without a second read.
7. Consume mixed message/range budget strictly in timeline order and derive
   repository `hasMore` from the complete walker.

## 11. Checkpoint 4: viewport gap item

### 11.1 Presentation data

`ChatItemData` becomes a discriminated union that includes a non-message item:

```ts
interface HistoryGapItemData {
  type: 'history-gap';
  left: number;
  right: number;
  state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
}

type ChatItemData = ChatMsgData | HistoryGapItemData;
```

The item is a runtime mapping of one committed server-gap range. It is not
stored in the messages table, does not have `contentType`, and is never treated
as a message for selection, unread tracking, date grouping, sender grouping,
copy, quote, forward, report, media probing, or context menus.

### 11.2 Kernel identity and directional cursors

`CbItem.id` is currently a numeric message cursor. A gap range needs two
different directional cursors and has no real message sequence:

```text
gap range:   (left, right]
older read:  before = left + 1
newer read:  after  = right
```

The source assigns each gap item a source-lifetime synthetic negative id from a
range reserved near `Number.MIN_SAFE_INTEGER`. Optimistic sends continue to
allocate downward from `-1`, so the two namespaces cannot collide in practice
or by allocator contract.

`HttpItemSource` owns:

```ts
interface GapCursor {
  left: number;
  right: number;
  state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
}

gapIdByKey: Map<string, number>;
gapById: Map<number, GapCursor>;
```

The key is the exact canonical tuple `state:left:right`. Re-reading the same
range during one source lifetime therefore yields the same synthetic id.
`requestOlder` resolves a gap id to `left + 1`; `requestNewer` resolves it to
`right`. Real positive ids retain their existing cursor behavior. The maps are
cleared when the source is destroyed.

Source boundary helpers must likewise resolve the first and last source item
through this cursor map. They must not keep assuming that every non-optimistic
item id is a positive message sequence.

Gap items are ordinary reloadable source members, not kernel `transient` or
`optimistic` inserts. Marking them transient would make the kernel skip them
when selecting a source boundary and lose the directional cursor.

### 11.3 Source shaping

The repository returns `MessageHistoryItem[]`. `HttpItemSource` shapes each
entry independently:

- a message follows the existing `rawToItems` path;
- a server gap becomes one `CbItem<ChatItemData>` using the synthetic id and
  `HistoryGapItemData`; and
- ascending/descending conversion orders the gap by its interval position,
  never by its synthetic id.

Every helper that currently assumes `ChatItemData.contentType` first narrows
`data.type`. Album aggregation stops at a gap item. Date and sender-group flags
treat a gap as a hard separator, so messages on opposite sides never form one
visual group or album.

### 11.4 Unique display ownership

The source gives every result batch a left-open, right-closed coordinate window
and projects a gap item only when that window owns `gap.right`. A complete gap
returned merely because its left portion intersects the batch is still reduced
into storage, but is not emitted by that left-hand batch.

The ownership test happens before item counting. A non-owning gap consumes no
item budget, so the walker continues and returns the requested number of owned
messages and gap items when enough history exists. An owning gap consumes one
item exactly once. There is no post-merge count reduction and no compensating
scroller fetch.

The database reducer remains responsible for canonical same-state interval
merging. Pending and unavailable ranges never merge with one another. A real
message overlapping a gap is an invariant error that aborts the database
commit. No duplicate gap reaches `CbScroller`, so the scroller and generic
kernel gain no gap-specific seam hook or interval algebra.

When a committed gap shrinks, later source reads project the new canonical
range. Existing mounted content continues to follow the current demand and
reload lifecycle; this phase deliberately adds neither a database-change
notification nor an in-place gap mutation path.

### 11.5 Rendering component

A dedicated `HistoryGapRowComponent` renders both states. `createItem` branches
on `data.type === 'history-gap'` before calling message-card logic.

The row is a full-width timeline separator rather than a chat bubble:

```text
──────────╲╱  Some history is still syncing  ╲╱──────────
```

The two rules end in mirrored jagged notches, leaving a visual tear around the
center label. The shape is CSS-native: pseudo-elements, borders, and
`clip-path`/gradients may create the tear without a bitmap asset. It uses theme
tokens and remains legible in light and dark themes.

Recommended copy:

| State                | English                             | Chinese              |
| -------------------- | ----------------------------------- | -------------------- |
| `SERVER_PENDING`     | Some history is still syncing       | 部分历史消息正在同步 |
| `SERVER_UNAVAILABLE` | Some history could not be recovered | 部分历史消息无法恢复 |

The ordinary product copy does not mention federation, sequence numbers,
server gaps, or synchronization rounds. Exact coordinates may be exposed only
in developer diagnostics.

### 11.6 Height and accessibility contract

The row has one deterministic integer-pixel height. The initial implementation
uses:

```css
:host {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  height: 56px;
  padding: 12px 16px;
}

.history-gap-label {
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

Every vertical padding, line height, border, and gap remains an integer number
of pixels. The label is single-line so localization cannot change row height.
Jagged decoration uses transforms, gradients, or clipping that do not
contribute fractional box height. Measurement continues to use `offsetHeight`.

The row has an accessible localized label and `role="note"`. It is not
focusable when it has no action. Pending decoration may use a static progress
glyph, but must not continuously announce or animate; reduced-motion mode
removes any optional motion. State is conveyed by both copy and shape, never by
color alone.

### 11.7 Interaction behavior

- The item cannot enter message-selection mode.
- Long press and secondary click do not open the message context menu.
- Jump-to-message never targets the synthetic id.
- Stable-read tracking ignores it because it has no readable message seq.
- It does not create an unread divider or date separator.
- `SERVER_PENDING` has no automatic retry control in this phase.
- `SERVER_UNAVAILABLE` has no retry control.
- Scrolling treats it as one ordinary measured item for window balancing and
  trimming.

### 11.8 Checkpoint 4 decisions requiring approval

1. Add `HistoryGapItemData` to `ChatItemData` and exclude it from all
   message-only behaviors through the discriminant.
2. Allocate source-lifetime synthetic ids near `Number.MIN_SAFE_INTEGER` and
   resolve them to direction-specific cursors in `HttpItemSource`.
3. Keep gap items as ordinary source members rather than kernel transients.
4. Give each gap one display owner using the right endpoint of the source
   batch's `(left, right]` window. The left batch neither counts nor displays
   it, and the scroller performs no gap-specific merge or count compensation.
5. Render a dedicated fixed-height, CSS-native torn separator with localized
   non-technical copy and no interaction in this phase.
6. Preserve the integer-pixel height contract and exclude gap items from
   selection, grouping, unread, date, jump, and stable-read semantics.

## 12. Checkpoint 5: implementation sequence and verification

### 12.1 Implementation sequence

The implementation should proceed in dependency order:

1. Fix the federation coordinate origin and extend the backend query DTO.
2. Build the consistent-snapshot backend page query and gap projection.
3. Add equivalent TypeScript and Rust interval reducers with the same
   exhaustive behavior matrix.
4. Rebuild browser and native cache schemas around explicit ranges and atomic
   page commits.
5. Replace browser repository reads with the TypeScript walker. Implement the
   complete native source demand, HTTP fill, commit, and recursive walker in
   Rust behind one IPC invocation.
6. Add source gap identity, right-owned page projection, and cursor resolution.
7. Add the dedicated viewport component and exclude it from message-only
   behavior.
8. Remove the superseded marker, covered-tail, and sparse-section code after
   all callers use explicit ranges.

Tombstone endpoints, consumption, storage, and rendering are outside this
sequence and remain unchanged.

### 12.2 Directional walker symmetry

Checkpoint 2 specifies the older-direction walker in detail. The newer walker
uses the same state machine with reversed traversal:

- inside `LOCAL_COVERED`, read cached messages with `seq > after` and continue
  from the range's right boundary when budget remains;
- inside a pending or unavailable range, emit it only when the current batch
  owns its right endpoint, then continue with `after=right`;
- outside all ranges, optimistically inspect newer cached rows, stop the HTTP
  scan at the nearest classified range above the cursor, and commit before
  continuing; and
- count only items owned and actually reached in timeline order.

Both directions must produce the same canonical range item for the same gap.
Synthetic ids are identity only; interval endpoints determine ordering and
directional cursors.

### 12.3 Superseded code to remove

Once explicit ranges are wired end to end, remove rather than retain fallback
paths for:

- message-row `sectionLeft` and `sectionRight` fields and indexes;
- marker lookup, marker mutation, section merging, and nearest-section helpers;
- `MessageCoverageState.coveredTail` and any correctness branch based on it;
- native marker columns, indexes, commands, and Rust section helpers; and
- tests whose asserted contract is the row-attached sparse-section model.

An independently useful `knownNewestSeq` hint may remain only under the narrow
contract in section 10.4. Cache schema mismatch recreates the cache; no marker
migration, dual read, or compatibility adapter is added.

### 12.4 Reducer and storage verification

Table-driven reducer fixtures must cover at least:

- origin conversion, including wire `[1,1]` to local `(0,1]`;
- same-state overlap and adjacency normalization without cross-state merging;
- a scan over `10..50` that returns pending `20..30`;
- later coverage through `25`, leaving only `26..30` pending;
- a stale larger pending response committing after the smaller result;
- pending-to-unavailable transition and rejection of its stale reversal;
- a returned complete gap extending beyond the actual scanned interval;
- an empty successful scan, early stop, and failed or invalid response; and
- every meaningful ordering of two concurrent commits for one thread.

Run the same fixtures against browser and native persistence. Verify atomic
rollback, whole-thread range replacement, per-thread isolation, thread deletion
cleanup, cache recreation, and parity between IndexedDB and native results.

### 12.5 Native source-level IPC boundary

On the web, `HttpItemSource` continues through the TypeScript repository and
IndexedDB walker. On native, each source operation invokes Rust exactly once:

```ts
type NativeHistoryDemand =
  | { kind: 'latest'; threadId: number; count: number }
  | {
      kind: 'around';
      threadId: number;
      anchor: number;
      older: number;
      newer: number;
    }
  | { kind: 'older'; threadId: number; before: number; count: number }
  | { kind: 'newer'; threadId: number; after: number; count: number };
```

Within that invocation Rust owns every database read, zero or more backend
requests, response validation, range reduction, atomic commit, and continuation
of the directional walker. It returns the final ordered
`MessageHistoryItem[]`, directional `hasMore`, and failure state. It never
returns an intermediate HTTP page to TypeScript.

The TypeScript source still maps final message/range items to `CbItem` values,
because display shaping, synthetic viewport identity, grouping, and component
creation remain UI responsibilities. No recursive history decision or
page-by-page native IPC remains in TypeScript.

### 12.6 Backend verification

Backend unit and PostgreSQL-backed tests must cover:

- an always-present empty `gaps` array;
- overlap by either endpoint and containment of the scan by a gap or vice
  versa;
- publisher-to-local offset conversion and visibility clipping;
- recoverable and unavailable gaps, sorted without overlap;
- exclusion of messages that fall inside a returned gap;
- forward and reverse `scannedThrough` conversion at `after=0`; and
- a reverse-sync commit racing a client read, proving that messages, gaps,
  visibility, and scan metadata come from one snapshot.

Protocol conformance must reject a publisher timeline whose coordinate origin
does not begin at sequence `1`, while still allowing later sequence holes.

### 12.7 Repository and source verification

Walker tests must cover `before` or `after` inside each state, exact interval
boundaries, `before=left+1`, `after=right`, optimistic look-ahead, nearest-range
HTTP cutoffs, and termination at origin. They must also prove that a farther
gap is not pre-counted ahead of unknown messages.

Page-ownership fixtures should use two adjacent `(left, right]` batches whose
backend responses both include one complete intersecting gap. Assert that:

- both responses reduce to the same canonical database range;
- only the right-hand batch emits and counts the gap;
- the left-hand batch continues walking with its full remaining budget;
- concatenation contains exactly one gap without scroller normalization; and
- `hasMore` reflects the complete walk rather than the final HTTP leg.

Exercise concurrent response permutations and cancelled demands to prove that
only committed canonical results mount and stale demands cannot mutate the
viewport.

Native parity tests run the same demands through the Rust walker and assert the
same final ordered items, range state, and directional `hasMore` as the browser
walker. They also assert one IPC invocation per source operation even when a
demand requires multiple HTTP pages or crosses multiple stored ranges.

### 12.8 Viewport verification

Component and integration tests must verify:

- stable synthetic identity and correct older/newer cursor resolution;
- no collision with optimistic ids and no ordering by synthetic id;
- hard breaks for albums, sender groups, dates, and unread presentation;
- exclusion from selection, menus, copy, quote, jump, and stable-read tracking;
- one visible pending or unavailable separator for a backend gap;
- replacement on a later ordinary reload after partial or complete recovery;
- a measured `offsetHeight` of exactly `56` pixels in both locales, themes, and
  representative viewport widths; and
- single-line truncation, reduced-motion behavior, and an accessible note label.

The end-to-end history scenario is: load messages `10..50` while the backend
reports `20..30` pending; display one separator at that range; later commit
messages `20..25` and retain only `26..30` pending; then test complete recovery
and unavailable transition independently on web and native caches. Existing
tombstone behavior must remain unchanged throughout.

### 12.9 Verification commands

The final implementation should at minimum pass:

```bash
npm test
npm run test:e2e
npm run build
npm test --prefix web -- --watch=false
npm run build --prefix web
```

Focused reducer, repository, source, and component suites should run during
development before the complete commands above.

### 12.10 Approved checkpoint 5 decisions

1. Implement in the dependency order in section 12.1 and remove all superseded
   sparse-marker paths after their callers move.
2. Apply the same interval state machine symmetrically to newer-direction
   reads, with direction-specific boundary cursors.
3. Keep equivalent TypeScript and Rust reducer/walker implementations aligned
   through the same behavioral fixture matrix. Run a complete native source
   demand behind one IPC invocation, including recursive database/HTTP work.
4. Verify the backend's one-snapshot guarantee with a real concurrent
   PostgreSQL scenario, not only mocked unit tests.
5. Test right-owned gap projection explicitly so item count stays fixed without
   any scroller gap merge or compensating fetch.
6. Keep tombstone behavior outside the change and include regression coverage
   proving it did not change.

## 13. Implemented source map

- Browser message cache and explicit range transactions:
  [`web/src/app/services/webdb.service.ts`](../../web/src/app/services/webdb.service.ts)
- Browser history walker:
  [`web/src/app/services/message-repository.service.ts`](../../web/src/app/services/message-repository.service.ts)
- Shared browser range reducer:
  [`web/src/app/services/message-range.ts`](../../web/src/app/services/message-range.ts)
- HTTP message-page transport:
  [`web/src/app/services/message.service.ts`](../../web/src/app/services/message.service.ts)
- Native SQLite storage, reducer, HTTP transport, and recursive walker:
  [`src-tauri/src/native_db.rs`](../../src-tauri/src/native_db.rs)
- Viewport data source:
  [`web/src/app/components/message-thread/http-item-source.ts`](../../web/src/app/components/message-thread/http-item-source.ts)
- Virtual-scroll source contract:
  [`web/src/app/lib/chat-box/cb-source.ts`](../../web/src/app/lib/chat-box/cb-source.ts)
