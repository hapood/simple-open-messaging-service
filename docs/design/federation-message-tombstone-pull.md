# Local message and tombstone pull

This document records how this server chooses existing federation queries. It
does not add parameters, response fields, or source cursor rules. Wire behavior
stays in `spec/v1/message-feed.md` and `spec/v1/message-tombstone-feed.md`.
Another implementation may choose a different schedule.

## 1. Message direction

As a source, this server still answers both `after` and `before`.

As a consumer:

- An ordinary message pull may use either direction. P2P and a mirror pulling
  an authority timeline are ordinary pulls. A new tail may be fetched with
  either cursor.
- One case is fixed. When this server is the group origin and pulls messages a
  member home submitted into the group, the query is forward. The cursor starts
  at the last accepted submission sequence and moves toward newer submissions.
  `includeSelf=false`. That stream is not reverse-filled. The member's
  submission sequence only grows at its tail.

`includeSelf` stays a filter, not a direction rule. The origin uses `false` so
the page contains that home's submissions rather than processing receipts. A
mirror pulling the authority uses `true`.

A forward response uses the existing cursor recovery. If the peer's retained
start is after our forward cursor (`after < resumeAfter`), the source returns
`FEDERATION_FEED_CURSOR_UNAVAILABLE` with `resumeAfter` and `resumeBefore`. A
forward pull resumes at `resumeAfter`. A reverse pull may restart at
`resumeBefore` or stop.

## 2. Reverse page, when that cursor is selected

The active gap is an inclusive publisher interval. The request takes the
default page size of 50 from its upper edge:

```text
before = endSeq + 1
through = startSeq
take = 50
```

The page commits a continuous processed interval up to the response
`scannedThrough`. Pure validation and malformed-item filtering run before the
write transaction; intentionally filtered items count as processed within that
interval, while storage or authorization-epoch failures roll back the
transaction without advancing the gap.

A newer tail whose upper edge differs from the in-flight request discards that
response. The new tail page runs first. An in-flight page whose `before` still
matches the current upper edge commits. Older gaps stay queued until the
current gap closes.

Reverse rows use `localSeq = originSeq + messageSeqOffset` in slots reserved
when the gap was opened. The reservation includes the newest publisher sequence
when that tail is stored by the reverse page. This path does not allocate
`curSeq + 1`.

Only the page that advances the visible tail enqueues thread fan-out, using
that page's `curSeq` and `tombstoneEndSeq`. An older gap page does not. Clients
read older gaps on demand.

## 3. Tombstone query

Tombstone query stays forward-only. `after` and `through` are `deletionSeq`
bounds. There is no `before`.

Each drain uses three coordinates:

- The start is the last tombstone sequence this consumer has applied. The
  request sends it as `after`.
- The deletion upper bound is the lightweight push tuple's `tombstoneEndSeq`.
  The request sends it as `through`.
- The message cutoff is the greatest message `seq` currently stored in this
  database for that pull, read when the query is built. The request sends that
  value as `maxMessageSeq`, without capping it at the tuple's `messageEndSeq`.
  It is not a sequence remembered from the previous drain.

The message cutoff uses the coordinate space of that pull. The group origin
uses the member sequence that home exposed to the origin. A mirror or P2P
consumer uses the sequence the publisher exposed on this hop. The client uses
the same rule on its own database: the greatest `seq` stored there now.

A tombstone whose `messageSeq` is above `maxMessageSeq` stays on the source.
The source may still advance the response `scannedThrough` past it. This
consumer does not adopt that `scannedThrough` as its applied cursor. The next
`after` is the last tombstone it actually applied. When the database's current
maximum `seq` grows, the same `after` is sent again with the new cutoff. A later
tuple can independently advance the deletion upper bound.

The default page size is 50. Pages repeat until the applied cursor reaches the
deletion facts inside the current cutoff, or the source reports no further fact
at or below that cutoff.

## 4. Applying a tombstone

Message insertion does not scan the tombstone feed. It looks up an
already-stored `FEDERATED` row in `MessageTombstone` for
`(threadId, publisherNamespaceId, remoteMessageSeq)`. A hit is marked
`consumed = true` (updating `updatedAt` without changing `createdAt`) in the
same transaction as the insert, and the new row is soft-deleted. No `LOCAL`
deletion sequence is allocated on that path. The retained row remains the
deletion reason for history and preview reads.

An unconsumed tombstone is a logical gap. Client and peer tombstone pulls return
only consumed facts. If an unconsumed fact already has a deletion coordinate in
the requested range, the page stops before that coordinate. `scannedThrough`
does not pass the gap, and a later consumed coordinate in the same range is not
returned until the gap itself is consumed.

A tombstone that arrives later is this drain. Both paths take the thread
content lock, then the federated-identity lock.

- The message row exists: write the `MessageTombstone` deletion fact (allocating
  `deletionSeq` and setting `consumed = true`) and set `Message.isDeleted` in
  one transaction.
- The message row does not exist yet: store only the unconsumed `FEDERATED`
  `MessageTombstone` row (`consumed = false`, `deletionSeq = null`). A later
  insert consumes it as above.

The tombstone record is not written into message content. `Message.isDeleted`
is the soft-delete flag.

## 5. Quotes

A received `quoteTarget` is stored as the wire coordinate. It is exactly one of
`seq` or `originSeq`. The number is not rewritten into the other field.
`seq` is the sender's own authoritative sequence. `originSeq` is the receiver
coordinate. A member home points at a message the group authority has already
numbered with `originSeq`.

`quoteTargetId: 0` on a forward-bundle entry is shown as an error quote on the
quoting message. It is not a navigable target and not a pending fetch. An
envelope `quoteTarget` of `{ seq: 0 }` or `{ originSeq: 0 }` is malformed and
the message is rejected. A positive coordinate whose body is missing or
withdrawn stays a gap or a deletion, not this zero case.

## 6. Client

The client pulls message history on demand. Its tombstone pull uses the same
cutoff shape: start at the last applied tombstone sequence, and set
`maxMessageSeq` to the greatest message `seq` in the client database now,
without capping it at the head tuple's `messageEndSeq`. Tombstones are persisted
in their own table. A matching local message row is soft-deleted in that same
transaction.
