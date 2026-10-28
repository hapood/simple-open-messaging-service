# SOMFP v1 Conformance

An implementation may claim `SOMFP v1 conformant` and publish `1` in discovery `protocolVersions` only if it fully supports every mandatory behavior in this release package. v1 defines neither partial conformance nor per-chapter negotiation.

## Mandatory specification modules

| Module                  | Dependencies                  | v1 requirement                                                   |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------- |
| Core Protocol           | None                          | Mandatory                                                        |
| Transport and Security  | Core                          | Mandatory                                                        |
| Peer Recognition        | Core, Transport               | Mandatory                                                        |
| State Feed              | Core, Recognition             | Mandatory                                                        |
| Profile Namespace Feed  | Core, Recognition             | Mandatory namespace bindings and identity-change synchronization |
| Group Meta Feed         | Core, Recognition, State Feed | Mandatory canonical group-origin roster                          |
| Profiles                | Core, Group Meta, Message     | Mandatory public and exact profile lookup                        |
| Message Query           | Core, Recognition             | Mandatory                                                        |
| Message Tombstone Query | Core, Message                 | Mandatory                                                        |
| Message Provenance      | Core, Recognition, Message    | Mandatory batched origin attestation of a content digest         |
| Message                 | Core                          | Mandatory, including every v1 content type                       |
| Resources               | Core, Message                 | Mandatory                                                        |
| Call Profile            | Core, Transport, Message      | Mandatory S2S signaling and endpoint WebRTC/JSEP behavior        |
| Stable Error Registry   | Every operation               | Mandatory                                                        |

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
- Before returning the first Recognize `recognized`, the receiver atomically pins and
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
  path. This is the same acceptance evidence as valid Recognize `recognized`;
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
- A domain-only re-binding can retain the same root, signing key, `KeyName`, and
  validity intervals. The publisher updates the domain in `keyId` and recomputes
  its authorization signature; it may replace the old-domain representation
  before expiration without performing key rotation. Receivers still require
  validated domain adoption under local policy and match complete `keyId` values exactly. Returning
  to an earlier domain must not reassign an old `keyId` to a different public key.
- During certificate overlap, a receiver selects exactly the currently valid,
  root-authorized certificate named by the request's `keyid`. It does not try
  multiple certificates for one request or infer preference from discovery
  document order.
- The public current-profile lookup carries the `publicKey` and `challenge`
  query parameters, and the `proof` member is the recovered plaintext of the
  sealed challenge. The separate `/verify` operation opens challenges under
  retained keys without server-side challenge state. The namespace bindings
  query resolves publisher-scoped namespace bindings; it does not answer
  challenges or mutate the consumer's identity pins.
- Normal signing-key rotation under the pinned root preserves recognition,
  peer acceptance, cursors, mirrors, and authorization. It does not restart
  Recognize for an already accepted peer.
- Health emits no error envelope: every authentication, resolution, and
  disclosure failure uniformly returns `200 unavailable`, which preserves
  pins and acceptance, marks an accepted peer `degraded`, and does not halt
  it. A root rotation is adopted only after a validated rotation arrival that
  resolves through the still-pinned root and a local adoption decision;
  publishing a successor root alone changes nothing. Adoption policy,
  additional evidence, review procedures, refusal retention, and retry
  scheduling are implementation choices, not conformance requirements.

- An accepted root rotation replaces the pinned root without
  retiring the peer's subject namespace or changing either disclosed namespace
  value. The receiver publishes the replacement bindings under the same
  namespace; the rotating publisher announces its own change under namespace
  `0`. Recognition and positive Health disclose the unchanged namespace after
  rotation. Adoption of root rotation or domain re-binding preserves existing
  reciprocal acceptance and does not require a new handshake merely because
  the binding changed. A destructive reset is distinct and must not reuse a
  retired id.

## Synchronization and deletion checks

- Group Meta item IDs, published end coordinates (including State Feed heads),
  and page scan boundaries do not exceed `9007199254740990`. Recovery can use
  `9007199254740991` as the exclusive `resumeBefore` without overflow.
- Profile Namespace Feed bootstrap without `after` is a normal page from zero,
  not an unpaginated dump. Consumers commit only `scannedThrough`, atomically
  with invalidation effects, and retain the first page's `feedEndId` as the
  fixed drain target even if subsequent pages disclose a newer end.
- Group Meta bounded drains fix coordinates, not a cross-page snapshot.
  Compaction may remove superseded items during the drain; subsequent delta
  synchronization observes replacements above the fixed bound. An incomplete
  full drain does not alter the committed projection or cursor.
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
- A P2P returned copy and a group origin's accepted submission returned to its
  submitting home supply the submitter's original coordinates as a receipt.
  A group origin uses `includeSelf=false` in both message-query directions and
  consumes only that home's own authored submissions, not mirror processing
  receipts. In A→G→B, B does not return A's mirrored copy to G as a receipt.
  Distribution to B uses null origin coordinates. Repeated reads preserve each
  recipient's projection; a receipt creates no new timeline message or receipt.
- Every message carries a closed nested `author`: P2P uses `{ ref, namespaceId }`,
  GROUP uses `{ account, namespaceId }`. Top-level `authorRef`, top-level
  `namespaceId`, and an author `domain` are rejected.
- All Group Meta items use `{ feedId, operation, body }`; subject account and
  namespace are in the body. Member upsert/depart share a body shape;
  GROUP_PROFILE names the page's group account; announcement contains only text.
- Public and exact profile response objects carry no `domain`.
- Public current-profile responses have exactly `account`, `generatedAt`,
  `profileRev`, `profile`, and `proof`. Revision 0 requires `profile: null`; a positive revision requires
  a closed complete `profile` object. Flattened responses, mismatched nullness,
  and extra nested fields are rejected. Possession proof is checked even for
  revision 0. Revision-0 results are not used as exact profile evidence, and
  exact-revision requests require positive revisions.
- Group user mentions retain the group origin's namespace interpretation across
  submission and mirror hops; the current message publisher never re-scopes a token.

## Group announcement checks

- A new group establishes its initial `GROUP_ANNOUNCEMENT` projection with
  `text: null` before serving the feed. Publishing, editing, and clearing are
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
- An announcement-only mutation remains discoverable through the applicable
  confirmed audiences' thread heads, including after crash recovery, with a
  newer Group Meta bound and unchanged message and deletion bounds. A lost hint
  is recoverable through normal reconciliation; no particular publication
  mechanism is required.
- Revocation denies further announcement reads; reauthorization uses full
  recovery at the new visibility floor. Neither revocation nor dissolution
  requires a terminal announcement clear.

## Independent validation

The specification and its non-normative validator are separate distributions.
Use the SOMFP offline validator **1.0.0-draft.2**, including its dependency lock
and CLI regression tests. With Node.js 22.18.0 or newer and npm, run from the
validator directory; replace `/path/to/spec` with the absolute path to the copied
specification directory containing `RELEASE.json`:

```bash
npm ci --ignore-scripts
npm run conformance -- --spec /path/to/spec
SOMFP_SPEC_DIR=/path/to/spec npm test
npm run typecheck
```

No SOMS checkout, database, backend build, or root-package dependency installation
is required. Dependency installation requires access to the npm registry or an
appropriately populated npm cache; validation itself performs no network calls.
The validator bundle must include its `package.json`, `package-lock.json`,
source, tests, type-check configuration, and license. Those tool files are not
part of the specification package. Do not distribute `node_modules/` in either
bundle.

Validate third-party JSON from the validator directory with:

```bash
npm run conformance -- \
  --spec /path/to/spec \
  --schema urn:somfp:v1:call \
  --file ./call.json
```

`--spec` explicitly selects the specification package; there is no implicit
checkout-relative default. Relative `--spec` and `--file` paths are resolved
against the CLI's working directory. Message-page
and individual-message validation also parses `content` and checks the declared
content-type schema. The validator rejects incomplete or unknown CLI arguments.

Each implementation maintains its own route, business-code, and state-machine
tests; those tests cannot replace independent validation of this release package.
Passing the offline checks does not certify runtime conformance.
