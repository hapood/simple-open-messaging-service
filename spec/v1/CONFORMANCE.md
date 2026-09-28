# SOMFP v1 Conformance

An implementation may claim `SOMFP v1 conformant` and publish `1` in discovery `protocolVersions` only if it fully supports every mandatory behavior in this release package. v1 defines neither partial conformance nor per-chapter negotiation.

## Mandatory specification modules

| Module                  | Dependencies                  | v1 requirement                                            |
| ----------------------- | ----------------------------- | --------------------------------------------------------- |
| Core Protocol           | None                          | Mandatory                                                 |
| Transport and Security  | Core                          | Mandatory                                                 |
| Peer Recognition        | Core, Transport               | Mandatory                                                 |
| State Feed              | Core, Recognition             | Mandatory                                                 |
| Group Meta Feed         | Core, Recognition, State Feed | Mandatory canonical group-origin roster                   |
| Profiles                | Core, Group Meta, Message     | Mandatory public and exact profile lookup                 |
| Message Query           | Core, Recognition             | Mandatory                                                 |
| Message Tombstone Query | Core, Message                 | Mandatory                                                 |
| Message                 | Core                          | Mandatory, including every v1 content type                |
| Resources               | Core, Message                 | Mandatory                                                 |
| Call Profile            | Core, Transport, Message      | Mandatory S2S signaling and endpoint WebRTC/JSEP behavior |
| Stable Error Registry   | Every operation               | Mandatory                                                 |

JSON Schema, the HTTP manifest, and test vectors are non-normative validation artifacts, but a formal release must not ship with a known conflict between those artifacts and the normative text. Passing these artifacts does not by itself prove compliance with the timing, security, authorization, and durable-state requirements in the normative text.

Call is not a negotiated capability or optional v1 module. Call Profile
conformance is evaluated over the Federation node together with every endpoint
subsystem type for which that deployment supports calling. The local
server-to-endpoint API is outside the SOMFP wire surface, but a node MUST NOT
publish `1` in `protocolVersions` unless those endpoints satisfy all mandatory
WebRTC/JSEP behavior in `calls.md`.

## Recognition lifecycle checks

A conformant recognition state machine must satisfy all of these independently
observable requirements:

- Before sending Recognize, the sender has durably pinned and locally
  recognized the peer and prepared its receive path. It is `establishing`
  while peer acceptance is unknown; proven acceptance preserves `available`
  or `degraded` according to reachability.
- Before returning the first Recognize `OK`, the receiver atomically pins and
  recognizes the signer, accepts the signer's explicit recognition assertion,
  and prepares its receive path. The
  authenticated request supplies reachability, so it becomes `available`.
- Reverse Recognize is optional and, when sent, starts only after the first
  response. Its successful delivery is not a separate ordinary-data gate.
- Every request authenticated from a pinned, locally recognized peer with a
  prepared receive path refreshes reachability before later shape or business
  authorization. This general reachability update does not itself create
  peer-acceptance evidence; positive Health has its separately specified
  acceptance effect.
- A valid Health `available` or `degraded` response is accepted by the requester
  as confirmation that the responder recognizes it and has prepared its receive
  path. This is the same acceptance evidence as valid Recognize `OK`;
  `unavailable` supplies no new acceptance evidence.
- An ordinary recognized-data sender validates local recognition, peer
  acceptance, current reachability, and operation authorization. The receiver
  validates its local recognition and the signer's identity, but does not
  require an earlier Recognize notification.
- Retryable Recognize or transport failure retains pins, receive readiness,
  and proven acceptance. The peer remains `establishing` if acceptance is
  unknown or becomes `degraded` if acceptance is known but reachability fails.
- Health projects the responder's receive readiness and reachability at
  request admission, not necessarily its bilateral lifecycle. A valid request
  may therefore return `degraded` even as it refreshes reachability.

- During rotation, the successor certificate is published before first use.
  Exactly one key signs newly generated requests at an instant: the predecessor
  before the local switch and the successor after the local switch. The
  successor prepublication interval and predecessor post-switch overlap cover
  the deployment's configured clock-skew budget and request/discovery timing
  bounds; the receiver still validates the exact half-open certificate interval
  without adding an implicit grace period. The predecessor remains published and
  valid for a post-switch verification overlap, so the successor is valid before
  first use and the predecessor remains valid after that first successor-signed
  request. The certificate validity intervals in a well-known document need not
  be contiguous; conformance does not require continuous certificate coverage.
- During certificate overlap, a receiver selects exactly the currently valid,
  root-authorized certificate named by the request's `keyid`. It does not try
  multiple certificates for one request or infer preference from discovery
  document order.
- Normal signing-key rotation under the pinned root preserves recognition,
  peer acceptance, cursors, mirrors, and authorization. It does not restart
  Recognize for an already accepted peer.
- Common certificate or signature failure on inbound Health uses the stable
  `400`/`401` error path before the Health handler and is not projected as
  `unavailable`. An outbound Health `401 FEDERATION_BAD_SIGNATURE` preserves
  pins and acceptance, marks an accepted peer `degraded`, and does not halt it.

## Synchronization and deletion checks

- An effective one-way intent permits passive history queries before a thread
  head exists. Confirmation publishes an initialization head after the authored
  `ACCEPTED` acknowledgement, even when message and deletion bounds are unchanged.
- A failed Group Meta retrieval does not block State Feed cursor progress once
  its target has been durably accepted. Dependent group content remains
  unexposed until that target is covered.
- A member home may publish either tombstone type to the group origin for its
  own authors. The origin applies valid facts and translates their target
  coordinates for distribution. A mirror cannot exercise that authority over
  another home's author or publish directly to another mirror.
- Returning a copy to its direct publisher supplies that publisher's original
  coordinates as a receipt, independently of the author's domain. This includes
  a mirror returning a third-party-authored message to its group origin.
  Distribution to another mirror uses null origin coordinates. Repeated reads
  preserve each recipient's projection; receiving a receipt creates no new
  timeline message or further receipt.
- A P2P forward asset derives its outer author from `authorRef`; it does not
  require the GROUP-only `author` field.

## Group announcement checks

- A new or upgraded group establishes its current `GROUP_ANNOUNCEMENT`
  projection before serving the feed. Publishing, editing, and clearing are
  origin-authorized owner/admin mutations, serialized with authorization at
  commit time; mirrors cannot author canonical replacements.
- A publish followed by an edit and clear uses strictly increasing coordinates
  under one group-wide stable key. A delta may skip the compacted edits but
  applies the retained `text: null` clear atomically with its cursor. Replays
  cannot restore an older announcement.
- A full drain returns the current announcement, including a clear, even when
  its coordinate predates the audience floor. It never serves an older value
  merely because that value fits a requested upper boundary.
- Successful full recovery replaces the announcement projection with the one
  returned by the complete scan. If the scan returns none, it removes the
  previous projection without inventing a `text: null` clear. An announcement
  returned by an earlier page is applied even if the origin later replaces it
  above the fixed boundary; subsequent delta synchronization applies that
  update. A failed full drain changes neither committed state nor cursor.
- An announcement-only mutation durably schedules the existing thread-head
  publication path with a newer Group Meta bound and unchanged message and
  deletion bounds. A lost hint is recoverable through normal reconciliation.
- Revocation denies further announcement reads; reauthorization uses full
  recovery at the new visibility floor. Neither revocation nor dissolution
  requires a terminal announcement clear.

## Independent validation

Run this command from the repository root:

```bash
npm run federation:conformance
```

Validate third-party JSON with:

```bash
npm run federation:conformance -- \
  --schema urn:somfp:v1:call \
  --file ./call.json
```

The CLI reads only the `spec/v1` release package and does not import the SOMS implementation under `src/`. Each implementation maintains its own route, business-code, and state-machine tests; those tests cannot replace independent validation of this release package.
