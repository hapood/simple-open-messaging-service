# Federation Consistency Stress Testing

## Purpose

This test system validates that a cluster of independent SOMS nodes converges
to the correct durable state after a large, concurrent, cross-domain workload.
It covers business state, projections, client-visible state, federation feeds,
message and deletion streams, profile media, and durable background work.

This is not only a throughput benchmark. A run succeeds only when:

1. every admitted operation has a known outcome;
2. all asynchronous and federated work reaches a defined quiescent boundary;
3. an independent reference model agrees with every node's authoritative and
   replicated state;
4. fresh client replicas rebuilt through public read APIs agree with that same
   model; and
5. the run satisfies the separately configured performance objectives.

Correctness and performance are reported independently. A correctness failure
must not be hidden by acceptable latency, and a performance failure must not be
reported as inconsistent data.

## Scope

The target topology is three independent nodes, each with its own process,
PostgreSQL database, identity namespace, signing keys, data directory, and CAS.
The initial release target is 20 local accounts per node. The runner must keep
all scale values configurable so the same workload can run at smaller sizes in
development and CI.

The workload covers:

- local and federated friend requests, including crossed requests, acceptance,
  rejection, revocation, removal, and re-establishment;
- local and federated group invitations and join requests;
- group creation, joining, leaving, removal, re-entry, administrator grant and
  revocation, ownership transfer, and dissolution;
- text messages and a bounded sample of media messages;
- authorized message deletion, including deletion concurrent with federation
  delivery;
- user and group profile changes, including avatar replacement;
- state synchronization for clients that remain online, fall behind, and start
  with no local state;
- transient peer unavailability and process restart after the deterministic
  baseline is stable.

Calls, push-provider delivery, browser rendering, and Internet DNS/TLS are not
part of the first version. The test uses real SOMS HTTP and signed S2S behavior
over loopback. Those excluded surfaces require separate system tests and do not
weaken the database and protocol consistency assertions defined here.

## Test profiles

The runner accepts one configuration object. No workload rule may depend on a
hard-coded profile size.

| Profile      | Nodes | Users per node | Purpose                                       | Normal trigger          |
| ------------ | ----: | -------------: | --------------------------------------------- | ----------------------- |
| P2P baseline |     3 |             20 | First executable friend-pair consistency test | Manual and release gate |
| Stress       |     3 |             20 | Expanded deterministic mixed-domain workload  | Nightly or release gate |
| Soak         |     3 |   Configurable | Repeated workload plus recovery cycles        | Manually scheduled      |

Implementations may expose smaller diagnostic values for developer iteration,
but passing a reduced population is not an acceptance substitute for the
three-by-20 P2P baseline.

The configuration also supplies at least:

- random seed;
- friendship degree or edge count, split into local and cross-domain edges;
- group count, member-count distribution, and cross-domain distribution;
- operation concurrency and per-node concurrency;
- messages per thread and media-message ratio;
- deletion ratio and deletion timing distribution;
- profile update count;
- offline/restart schedule;
- operation, convergence, and whole-run deadlines; and
- rate-limit and federation-quota test overrides.

Performance thresholds are deliberately not fixed in this design document.
They must be supplied by the execution environment, together with the hardware
and PostgreSQL configuration on which they are meaningful.

## Reproducibility and identities

Every run has a unique run ID and an explicit pseudorandom seed. All generated
accounts, group names, client message IDs, media bytes, and action choices are
derived from the run ID and seed. The runner records its configuration and the
generator version before submitting the first operation.

The operation journal is append-only and records:

- monotonically increasing operation ID;
- logical actor and target identities;
- target node and public endpoint;
- model precondition and chosen action;
- request idempotency key where the API supports one;
- dispatch and completion timestamps;
- HTTP and business result;
- returned durable task ID and its terminal result, when applicable; and
- causal dependencies on earlier operations.

Account provisioning is test setup, not workload. A fixture may provision
accounts and sessions before the run begins. After the workload starts, all
business mutations must use public HTTP APIs; direct database writes are not
allowed. Direct database access is reserved for observation and final audits.

A failed run must be replayable from its configuration and seed. When timing is
material to the failure, the recorded operation journal is the stronger replay
source and preserves the original dependency order and dispatch offsets.

## Workload model

### Reference state

The runner maintains a reference model that is independent of SOMS database
rows and feed payloads. It uses stable logical addresses and generated IDs, not
node-local surrogate IDs. At minimum it models:

- the current directed relationship intent for each author and peer;
- the folded active/inactive friendship and its lifecycle generation;
- each group's origin, lifecycle state, current profile revision, owner,
  administrators, active members, and membership visibility intervals;
- every admitted user-authored message by stable origin coordinate;
- message deletion authority and final deleted state;
- current user and group profile revisions and avatar digests; and
- the threads and state each logical client is entitled to observe.

The model changes only after the runner has classified an operation outcome.
An accepted asynchronous command remains pending in the model until its durable
task reaches a terminal result. A transport timeout with an unknown outcome is
resolved by idempotent retry or an authoritative query; it is never guessed.

Expected values must not be derived from the tables or feed entries being
tested. Database identifiers returned by the system may be stored only as a
mapping to the model's logical identities.

### Generation rules

The generator selects only actions whose model preconditions currently hold.
Examples include transferring ownership only to an active member, requiring an
owner to transfer ownership before leaving, and deleting only messages for
which the actor has deletion authority.

Some operations should intentionally race while preserving a valid outcome
set. Examples are:

- crossed friend requests;
- duplicate submission with the same idempotency key;
- member leave versus a concurrent message;
- role change versus member removal;
- message delivery versus deletion;
- profile replacement while the previous profile is being pulled; and
- federation feed wake-up versus receiver restart.

For each race, the model records the finite set of legal serializations. The
auditor accepts any one legal final state, then requires all relevant nodes and
clients to agree with that chosen state. It must not weaken a race assertion to
"any internally valid state".

### Workload stages

Stages provide debuggable checkpoints, but operations inside a stage are
concurrent and later profiles may overlap selected stages.

1. Provision users and sessions and install deterministic avatars.
2. Create a connected graph of local and cross-domain friendships.
3. Create local-origin groups with members drawn from all three nodes.
4. Exercise invitations, applications, joins, leaves, removals, and re-entry.
5. Send messages from every node, with hot and cold thread distributions.
6. Delete a configured subset before, during, and after remote delivery.
7. Change group roles, transfer ownership, and update user/group profiles.
8. Dissolve a subset of groups and continue valid activity in surviving groups.
9. Remove a subset of friendships and verify that subsequent unauthorized
   activity is rejected.
10. Stop mutation generation, wait for quiescence, and perform all audits.

The baseline test runs without injected transport faults. Restart and network
fault schedules are enabled only after the baseline passes reliably, so a
failure can be assigned to deterministic semantics or recovery behavior.

## Quiescence boundary

A fixed sleep is not a convergence condition. The runner first freezes new
workload mutations and captures the published target coordinates needed to
define the round. It then polls bounded diagnostic queries until all applicable
conditions hold or the convergence deadline expires.

The quiescence candidate requires:

- every admitted durable task is terminal;
- no task remains `PENDING`, `PROCESSING`, or `ASYNC_PROCESSING` for a workload
  scope;
- no terminal `FAILED` task exists unless the operation's expected result set
  explicitly includes that failure;
- every initialized `PeerStateFeedPullCursor.committedThrough` has reached the
  captured source target for that peer namespace;
- every mirrored `GroupMetaFeed.feedEndId` has reached the captured group head;
- every federation message and deletion stream has processed through its
  captured target;
- no workload-owned media remains in an in-flight state; and
- no source target coordinate advances because of pre-freeze workload work.

Because observation can race with the last commit, a candidate is accepted
only after the same conditions and the same normalized coordinate snapshot are
observed in three consecutive samples. The sampling interval and overall
deadline are configuration values. Diagnostic polling must be bounded and must
not itself mutate feed cursors.

Quiescence is necessary but not sufficient. All final invariant audits still
run after it is reached.

## Invariant catalog

Each invariant has a stable identifier. Test output and failure artifacts refer
to these identifiers rather than only printing an assertion expression.

### General and task invariants

- **GEN-001:** All local surrogate references resolve and all workload-owned
  rows belong to the expected logical run entities.
- **GEN-002:** Per-thread local message `seq` and deletion coordinates are
  positive, unique, and consistent with their owning allocator high-water mark.
- **TASK-001:** No workload task remains in an active status after quiescence.
- **TASK-002:** Task ordering, parent, checkpoint, result, and supersession state
  agree with the terminal status and the operation journal.
- **TASK-003:** Retrying a successfully completed idempotent operation does not
  create a second business fact.

### Relationship invariants

- **REL-001:** Each relationship pair has at most one current directed intent
  per author side.
- **REL-002:** The active relationship is exactly the fold of the current
  directed intents according to the relationship intent state machine.
- **REL-003:** All nodes holding a projection of the same cross-domain
  relationship agree on its authored facts and active state after convergence.
- **REL-004:** Request projections have the correct viewer-relative direction,
  terminal status, note, profile revision, and expiry behavior.
- **REL-005:** An ended friendship has no current message-delivery audience or
  send authorization. Historical facts retained by design remain historical
  and do not reactivate the relationship.
- **REL-006:** Re-establishing a friendship produces the expected current edge
  without reviving stale request projections or granting access to data outside
  the new lifecycle's visibility boundary.

### Group invariants

- **GRP-001:** Every active group has exactly one active owner; every active
  owner and administrator is also an active member.
- **GRP-002:** The origin's latest canonical Group Meta operation per stable
  member equals the reference roster and role.
- **GRP-003:** Every converged mirror equals the origin's group profile and
  roster at the captured `feedEndId`.
- **GRP-004:** A departed or removed member has no access to content beyond its
  visibility boundary and receives no later group content head.
- **GRP-005:** Re-entry restores only the new active membership interval and
  does not erase or bypass the previous visibility boundary.
- **GRP-006:** Ownership transfer is atomic in the final roster: the target is
  owner and the previous owner is no longer owner. Role projections and system
  presentation messages must not contradict that result.
- **GRP-007:** A dissolved group cannot accept further membership, role,
  profile, or message mutations, and all replicas eventually expose the
  dissolved state.
- **GRP-008:** Current peer audiences equal the set of domains containing
  entitled active members, subject to the protocol's retained visibility
  rules; removed domains receive no new heads.

### Message and deletion invariants

- **MSG-001:** A logical message exists once on every entitled node and nowhere
  else, identified across servers by its stable origin coordinate rather than a
  local `seq`.
- **MSG-002:** Duplicate delivery or pull does not create another message,
  receipt, asset binding, or client-visible event.
- **MSG-003:** Message origin identity, content, content type, origin sequence,
  and origin server time are immutable across replicas.
- **MSG-004:** Every entitled thread's message target and processed-through
  coordinates reach the captured source target without an unexplained gap.
- **DEL-001:** Every authorized deletion produces one effective tombstone per
  target message and all entitled replicas expose the message as deleted.
- **DEL-002:** A tombstone arriving before its message prevents a later message
  delivery or retry from resurrecting visible content.
- **DEL-003:** Deletion cursors are monotonic and reach the captured target for
  every applicable stream.
- **DEL-004:** An unauthorized deletion changes neither the reference model nor
  any message or deletion feed.

### Profile and media invariants

- **PRO-001:** The current user or group profile revision selects exactly one
  immutable `ProfileVersion` with the expected display fields and avatar.
- **PRO-002:** Every live remote profile projection resolves to the source-owned
  revision selected by the corresponding relationship or Group Meta fact.
- **PRO-003:** A late older profile or avatar cannot overwrite a newer selected
  revision.
- **MED-001:** Every live message/profile asset reference resolves to verified
  CAS bytes whose digest and stored byte count match.
- **MED-002:** Workload media has no unexplained `PendingMedia` or
  `FileSyncProgress` entry after quiescence.
- **MED-003:** Replaced or unreferenced assets are evaluated according to GC
  retention rules; their mere presence before GC is not a consistency failure.

### Federation feed invariants

- **FED-001:** Peer feed allocation and target coordinates are monotonic and
  each compacted key contains the newest required fact for that target peer.
- **FED-002:** Feed items are addressed only to authorized peer namespaces and
  source-owned facts are never republished as locally authored facts.
- **FED-003:** Pull cursors never advance past data durably applied by the
  receiving node.
- **FED-004:** Replaying a previously consumed page changes neither final
  business state nor externally visible feed coordinates.
- **FED-005:** Group Meta, message, deletion, and profile dependencies are
  complete at the committed outer feed boundary.

### Client replica invariants

- **CLI-001:** Replaying `/user/state-feed` from cursor zero into an empty test
  client produces the reference user's current relationships, requests,
  threads, profiles, rosters, and content heads.
- **CLI-002:** Replaying from randomly chosen saved cursors produces the same
  final client state as replaying from zero.
- **CLI-003:** Feed pages are applied atomically with the client cursor; retrying
  the last page is idempotent.
- **CLI-004:** After reaching the captured feed end, another read returns no
  workload state beyond that boundary.
- **CLI-005:** Each thread content head covers the required message and deletion
  ends and identifies the correct preview state.
- **CLI-006:** Group Meta read APIs reconstruct the same roster and profile as
  the reference model for entitled clients, while former members cannot read
  state beyond their visibility boundary.

## Audit strategy

Auditing occurs at two independent surfaces.

The database auditor connects read-only to each node after quiescence. It
normalizes node-local IDs to stable user, group, thread, namespace, and message
addresses before comparing nodes. Its queries should return compact summaries
first and expand only the entities implicated by a failed invariant.

The client auditor creates fresh in-memory replicas and uses public client APIs
to replay state and group metadata. It must not share implementation code with
the server's projection writers. For a deterministic sample of threads, it also
pulls message history and deletion data to the advertised heads. This catches a
database that is internally consistent but cannot produce a correct client
view.

Not every table should be byte-for-byte equal across nodes. Canonical data,
mirrors, local projections, local message sequence numbers, timestamps, and
operational history have different ownership rules. Every comparison therefore
starts from the documented authority and stable wire identity for that fact.

## Load generation and measurement

The runner controls semantic operations, dependencies, idempotency, and the
reference model. A generic HTTP load tool may drive stateless request batches,
but it cannot be the source of truth for the scenario.

Concurrency is bounded globally and per node so a run does not accidentally
measure only client socket exhaustion. The report separates:

- request admission latency and business rejection rate;
- accepted durable task completion latency;
- peer state, Group Meta, message, deletion, and media convergence lag;
- PostgreSQL pool use and database errors;
- process CPU, memory, event-loop delay, and restart recovery time; and
- final audit duration and result.

Expected authorization and state-machine rejections are recorded separately
from unexpected errors. Rate limits and daily federation quotas use explicit
test configuration large enough for the selected profile; silently bypassing
the guards in application code is not permitted.

## Failure artifacts

Every failed or timed-out run writes a directory named by run ID containing:

- resolved configuration, seed, generator version, and source revision;
- append-only operation journal;
- performance and convergence time series;
- the last quiescence snapshot and all unmet targets;
- invariant results by ID;
- normalized summaries from all three databases;
- focused raw rows for failed users, relationships, groups, threads, feeds,
  tasks, messages, deletions, profiles, and media;
- application and proxy logs for all nodes; and
- CAS manifest entries for implicated assets.

Secrets, bearer tokens, passwords, cookies, signing private keys, and raw
personal content must be redacted. Generated message bodies should contain only
run IDs and deterministic synthetic data.

The first reported failure is not necessarily the root cause. The report keeps
all audit results, while presenting unmet convergence conditions before derived
projection mismatches.

## Implementation sequence and review gates

Implementation is intentionally incremental. Each gate must pass and be
reviewed before scale or fault complexity is added.

The first executable scope is defined by the
[Federation P2P final-friend oracle](./federation-p2p-consistency-state-machine.md).
It intentionally starts at the full three-node, 20-user-per-node account
population while limiting business behavior and the pass/fail oracle to P2P
friend creation, removal, and final `RelationshipPair.active` symmetry.

### Gate 1: Test contract

Approve this document, especially the scope, authority boundaries, invariant
catalog, and quiescence definition. Open questions are resolved here rather
than embedded as accidental behavior in the runner.

### Gate 2: Three-node harness

Generalize the existing two-node federation harness into an N-node cluster
without weakening process, database, identity, signing, or storage isolation.
Prove the harness with three users and one group spanning all three nodes.

### Gate 3: Operation journal and deterministic P2P baseline

Implement the operation journal, seeded generator, legal online action
selection, and final-friend oracle. Run the reviewed P2P workload with 20 users
per node and no fault injection.

### Gate 4: Quiescence detector and auditors

Implement coordinate capture, stable-sample convergence, database invariant
checks, and clean client replay. Deliberately corrupt isolated test fixtures to
prove each auditor fails with a useful diagnostic.

### Gate 5: Scale and performance reporting

Establish environment-specific latency, resource, backlog, and convergence
objectives from repeated 20-user-per-node baselines. Correctness remains the
final active-friend oracle and is reported independently from performance.

### Gate 6: Recovery and soak testing

Add proxy delay and interruption, node restart, repeated idempotent delivery,
and longer repeated workloads. Each fault schedule is seeded and recorded.

## Initial acceptance criteria

The first complete baseline is accepted when the three-node,
20-user-per-node P2P profile:

- executes the entire lifecycle across three nodes through public mutation
  APIs;
- reaches the defined quiescence boundary within its configured deadline;
- passes every applicable invariant with fresh database and client audits;
- produces a replayable operation journal and complete redacted report; and
- succeeds repeatedly with the same seed before any fault injection is enabled.

Passing this profile validates the P2P test system and its reviewed workload;
it does not by itself establish production capacity. Capacity claims require
environment-owned performance thresholds and repeated runs.
