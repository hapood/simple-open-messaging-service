# Profile Version Resolution

Status: normative implementation design.

## 1. Invariants

A profile snapshot is identified by the immutable key:

```ts
interface ProfileKey {
  namespaceId: number;
  account: string;
  domain: string;
  rev: number;
}
```

Profile bytes, display name, and biography are stored and cached only under
this four-part key. A request proof is not part of the profile identity. Several
proofs may resolve to the same key.

The system has three ownership boundaries:

- the backend authenticates client proofs, schedules federation work, and
  materializes profile snapshots in PostgreSQL;
- the Web Worker or Rust runtime is the only client-side profile network and
  database writer; and
- the UI reads client storage through repositories and renders the result. UI
  code never calls the profile-resolution HTTP endpoint or consumes raw profile
  SSE events.

There is no request identifier and no compatibility path for the superseded
profile completion protocol.

## 2. Client evidence

Every client request contains exactly one evidence source. Evidence selects an
immutable local fact and carries the expected profile revision so the backend
can construct a `ProfileKey` before scheduling network work.

```ts
type ProfileEvidence =
  | { type: 'EXACT'; account: string; domain: string; rev: number }
  | {
      type: 'MESSAGE_AUTHOR';
      threadId: number;
      messageSeq: number;
      rev: number;
    }
  | {
      type: 'GROUP_META';
      threadId: number;
      profileRev: number;
      subject:
        | { type: 'GROUP' }
        | { type: 'MEMBER'; account: string; domain: string };
    };
```

The backend does not trust the supplied revision by itself. It authorizes the
evidence and derives the account, domain, namespace, publisher, and federation
route from local durable facts. The supplied revision is the requested profile
version and forms the target key. A missing or unauthorized evidence fact is a
synchronous business error.

`EXACT` is still evidence, not an unrestricted address lookup. Relationship
intent, thread state, group audience, or self-profile state must authorize the
exact revision.

## 3. Federation evidence

Federation requests do not carry a profile revision for message or Group Meta
proofs. The authoritative peer resolves the revision from its own durable fact.

```text
GET /s2s/v1/message-author-profile
    ?account=<thread account>
    [&peerAccount=<p2p peer>]
    &messageSeq=<publisher sequence>

GET /s2s/v1/group-meta-profile
    ?account=<group account>
    &subject=GROUP

GET /s2s/v1/group-meta-profile
    ?account=<group account>
    &subject=MEMBER
    &memberAccount=<account>
    &memberDomain=<domain>
```

The Group Meta endpoint serves both the group's `GROUP_PROFILE` fact and a
member's current `UPSERT` fact. It verifies that the requesting peer has a
current audience for the group, resolves the selected revision and namespace
from canonical Group Meta, and returns the retained snapshot. A mirror never
serves another peer as authority for a remote group.

An exact S2S profile request retains its revision because the exact revision is
the proof being exercised.

## 4. Backend read-through scheduler

The authenticated client endpoint performs these steps:

1. validate and authorize the evidence;
2. derive the expected `ProfileKey` and one federation request method;
3. check the completed in-memory LRU by `ProfileKey`;
4. check PostgreSQL by `ProfileKey`;
5. return `READY` on a hit; otherwise join or create the pending item for that
   key and return `PENDING { key }`.

The completed LRU is access ordered and contains at most 1,000 profiles. It is
an optimization over PostgreSQL, never an authority.

Pending work is stored as:

```ts
interface PendingProfileItem {
  key: ProfileKey;
  methods: Map<string, FederationRequestMethod>;
  subscribers: Set<number>;
  state: 'QUEUED' | 'ACTIVE';
}
```

The scheduler maintains key lookup and fair queue traversal. An identical
method is inserted once. A different proof for the same profile is an
alternative method under the existing item. Each client evidence is authorized
before its user is added to `subscribers`.

At most 1,000 pending keys and 1,000 retained request methods may exist. Joining
an existing key and method remains allowed when the queue is full. New work is
rejected with a dedicated retryable business error when either bound would be
exceeded.

HTTP concurrency is bounded globally. Pending work consumes no completed-LRU
capacity.

## 5. Federation completion and revision mismatch

Every successful federation response is validated structurally and converted
to its actual `ProfileKey`. The scheduler deliberately does not require that
the returned revision equal the requesting item's expected revision.

For a response produced by method `M` from expected item `E`:

1. materialize the returned snapshot under its actual key `A`;
2. insert `A` into the completed LRU;
3. remove the complete pending item keyed by `A`, if one exists;
4. remove method `M` from expected item `E`, if `E` still exists;
5. notify the union of subscribers from the removed actual item and the method
   that performed the request with `PROFILE_AVAILABLE { A }`;
6. if `E` still has methods, leave it scheduled; otherwise remove it.

When `A === E.key`, step 3 removes the entire expected item, including every
alternative proof. When the revisions differ, the returned revision is still a
valid materialized profile, while only the completed method is removed from the
original expected item. Another method may still obtain the expected revision.
No preliminary mismatch branch is used; both cases execute the same state
transition.

A failure removes only the failing method and emits `PROFILE_UNAVAILABLE` for
its subscribers. A later client demand may submit the evidence again. The
expected item is removed only after it has no remaining methods. Failures never
modify relationship, membership, peer-health, or Group Meta state.

## 6. Client protocol and persistence

ClientStateFeed carries relationship intents, invitation read heads, and thread
state. It has no PROFILE event and never transports profile snapshots. Group
Meta carries only role and revision references. Neither metadata ingestion nor
optimistic conversation display updates may populate the immutable profile
cache. Only complete resolved snapshots are committed through the profile
runtime; missing content remains unresolved.

The start response is:

```ts
type ProfileResolutionStart =
  | { status: 'READY'; profile: ResolvedProfile }
  | { status: 'PENDING'; key: ProfileKey };
```

The backend SSE success event is a wake-up containing no profile body:

```ts
interface ProfileAvailableEvent extends ProfileKey {}
```

On `READY`, the Web Worker or Rust runtime validates and commits the profile to
the client database before returning the committed snapshot over IPC. On a
backend `PROFILE_AVAILABLE`, the platform event bridge submits `EXACT` evidence
made from the event key to the Web Worker or Rust database executor. The
executor retrieves the backend-cached profile, commits it, and only then
publishes a scoped local wake. A repository whose unresolved
subscription has the same pending key rereads through IPC; the runtime returns
the committed client-database row without another federation request.

The database commit and IPC completion are strictly ordered. Components
subscribe only to repositories; they do not consume backend profile SSE
directly.

Lost SSE frames do not lose state. A reconnect, runtime restart, or later UI
demand repeats unresolved evidence. Since the backend snapshot is durable, the
repeat returns `READY` without another federation request.

## 7. Client repositories and UI

The Web main thread maintains an access-ordered 1,000-entry LRU of profiles,
keyed by `ProfileKey`. It is cleared on account/session changes. It caches only
values read from client storage after a committed runtime write.

`ProfileRepository.watch(evidence)` submits an IPC demand to the runtime, which
performs the local read first. Live subscribers for identical evidence share
one entry. A `PENDING` result records only its four-tuple key so an unrelated
profile event cannot retry it; there is no request-ID map or main-thread HTTP
queue. The entry is removed when it completes, fails, or loses its final UI
subscriber.

Avatar, system-message, member-list, friend-request, thread-list, and profile
views subscribe through this repository. A resolving avatar wrapper may feed
the existing presentational avatar primitive, but no component calls a
resolution service. Message sources and repositories do not write profile
bytes or keep independent resolved-profile maps.

## 8. Required verification

Tests cover:

- one federation call for duplicate evidence and duplicate four-part keys;
- alternative evidence for one key;
- returned revision equal to and different from the expected revision;
- group and member profile resolution through Group Meta;
- queue and method capacity rejection;
- SSE-before-response, reconnect, runtime restart, and lost-SSE recovery;
- transaction-before-local-event ordering;
- account switch while resolution is active;
- multi-tab IndexedDB visibility; and
- absence of profile-resolution HTTP calls and raw profile SSE consumers from
  Angular UI code.
