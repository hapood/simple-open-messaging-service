# Fan-out Execution

Status: Group Meta head fan-out implements bounded pages, pending-task
supersession, and page-boundary yielding. Message wake fan-out implements
process-local per-thread coalescing and recipient-batch yielding. Group
dissolution implements non-yielding, one-member-at-a-time child admission.

This document defines application execution policy. It does not define
federation authorization or wire behavior; those remain under
[`spec/v1`](../../spec/v1/).

## 1. Classification

Every fan-out must declare both its durability and completion semantics. The
word _fan-out_ alone does not imply that every individual delivery is a durable
fact.

| Class                        | Example                                          | Authoritative source                        | May a newer value replace unfinished work?           |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------- |
| Durable compacted projection | Group Meta or Thread Content head                | Canonical feed/thread head                  | Yes                                                  |
| Ephemeral wake fan-out       | `STATE_FEED_UPDATED` SSE or federation wake hint | Committed feed/thread head                  | Yes, when the newer wake covers the older coordinate |
| Exhaustive fact fan-out      | Dissolution member revocations                   | Durable aggregate state and task checkpoint | No                                                   |

A compacted projection or wake is a discovery mechanism, not an authorization
source. Every read still checks current authorization. An exhaustive fan-out
materializes independent required facts and therefore cannot discard an
unvisited target merely because newer work exists.

## 2. Cooperative yield contract

Fan-out work is divided into bounded pages or recipient batches. A running
fan-out reaches a yield point only after its current transaction or delivery
batch has finished. It never abandons an open transaction.

At every yield point it performs the action required by its class:

- A compacted fan-out checks for a newer task or in-memory high watermark. If
  one exists, the old run ends successfully and the newest run reconciles from
  its initial cursor.
- An exhaustive durable fan-out persists its checkpoint after each item but
  retains task ownership and continues with the next item. It cannot yield to a
  replacement because no newer desired state covers an unvisited fact.
- An ephemeral in-memory fan-out gives other work an event-loop opportunity and
  checks whether a newer high watermark makes the remaining wake recipients
  obsolete.

Yielding is not failure, retry, or rollback. Effects committed before the yield
remain valid and must be idempotent when a successor revisits them.

## 3. Durable compacted heads

A compacted head task contains stable scope identifiers only. Its payload does
not freeze the audience, revision, or recipient list. The authoritative
mutation commits the new head and admits a task in the same transaction.

Admission keeps at most one `PENDING` task for a coalescing key. A running task
is not edited. If a mutation commits a newer pending successor, the running
task observes it at the next page boundary and ends successfully. The successor
starts from cursor zero and reads the latest head and current audience:

```text
task A processes audience page through cursor 100
mutation commits a newer head and pending task B
task A commits its current page
task A sees task B at the next page boundary and yields successfully
task B starts at cursor zero and reconciles the latest head for all audiences
```

The maximum obsolete work is one bounded page. A successor may revisit already
processed recipients, so compacted writes must avoid allocating a new feed ID
when the desired head is unchanged.

Each committed page immediately emits wake hints for that page after filtering
its targets against current audience. A yielding task emits no additional
completion notification: its earlier pages have already been notified, and its
successor publishes the newest head while rescanning from cursor zero.

Group Meta head fan-out follows this policy. Its pages lock and revalidate
selected audience rows, then filter wake hints against current audience after
commit.

## 4. Message wake fan-out

A committed message is the fact. SSE, push wake-up, and federation notification
are post-commit discovery effects. Losing an ephemeral wake cannot lose the
message because clients and peers reconcile from durable thread and State Feed
coordinates.

The process-local message coordinator is keyed by `threadId` and keeps one
active run plus the greatest pending message sequence for that thread. A
recipient batch checks that high watermark before starting the next batch. If a
newer sequence exists, the old wake run ends and a run for the greatest sequence
starts from the first current recipient. A recipient that receives only the
newest wake queries the intervening message interval from durable storage.

This coalescing applies only to replaceable discovery hints. A per-message side
effect with independent semantics, such as a call alert or a notification whose
meaning cannot be reconstructed from the newest thread coordinate, must either
be accumulated in the pending work or executed independently. It must not be
silently discarded by high-watermark replacement.

The coordinator is intentionally in memory. Restart recovery uses ordinary
client reconnect, unread, and peer head reconciliation; it does not create one
`DurableTask` row per message. Its state is an optimization and grants no
authority.

## 5. Exhaustive durable fan-out

An exhaustive task uses a durable keyset checkpoint. Each item transaction
commits its generated fact and advances the checkpoint atomically. Committing
the transaction releases its database locks, but the handler retains the
executor slot and task ownership until enumeration completes.

Group dissolution follows this policy. The parent scans active
`GROUP_MEMBER` relationships by `RelationshipPair.id`; each transaction inserts
exactly one `REVOKE_DISSOLVED_GROUP_MEMBER` child and advances `afterPairId`.
The parent cannot yield to a replacement because every active relationship must
receive a child task. It succeeds after admission completes and does not wait
for those children to execute.

## 6. Invariants and tests

- No fan-out holds a business aggregate lock across its complete audience.
- A yield occurs only after a bounded page or batch boundary.
- A compacted successor starts from its initial cursor and reads current
  authoritative state.
- A compacted task may end early only when a committed successor covers its
  complete desired-state scope.
- An exhaustive task never advances its checkpoint past a target whose required
  fact was not admitted in the same transaction, and never terminates early in
  favor of a successor.
- Current authorization is checked independently of task status, projection
  history, and wake delivery.
- Tests cover a successor arriving before a page, during a page, after the last
  page, and repeatedly while an older run is yielding.
- Message tests cover recipients that see both wakes, only the newest wake, and
  non-replaceable notification semantics.
