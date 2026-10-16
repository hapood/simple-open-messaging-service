# Message Envelope

Status: `DRAFT` — Final Review (`v1.0.0-draft.0`)

This document defines the outer wire shape, origin coordinates, idempotency rules, and processing receipts shared by every message in a federation message query. See the [Message overview](../message.md#4-contenttype) and its topic documents for each parsed `contentType` shape, and [Message Query](../message-feed.md) for pagination semantics.

## 1. Wire types

```ts
type ThreadAddress =
  | { account: UserAccount; peerAccount: UserAccount }
  | { account: GroupAccount };

interface BlobDescriptor {
  digest: Sha256Hex;
  bytes: SafeInteger;
}

type QuoteTarget = { seq: ThreadSequence } | { originSeq: ThreadSequence };

type JsonObjectString = string;

interface EncodedMessageContent {
  contentType: ContentType;
  content: JsonObjectString;
}

interface FederatedMessageBase extends EncodedMessageContent {
  seq: ThreadSequence;
  profileRev: SafeInteger;
  originSeq: ThreadSequence | null;
  originCreatedAt: EpochMilliseconds | null;
  createdAt: EpochMilliseconds;
  quoteTarget?: QuoteTarget;
  /** SHA-256 payload digest of the quoted message; required exactly when quoteTarget is present. */
  quoteDigest?: Sha256Hex;
  assets: BlobDescriptor[];
}

type FederatedMessage = FederatedMessageBase &
  (
    | {
        thread: { account: UserAccount; peerAccount: UserAccount };
        author: {
          ref: 'THREAD_ACCOUNT' | 'THREAD_PEER_ACCOUNT';
          namespaceId: SafeInteger;
        };
      }
    | {
        thread: { account: GroupAccount };
        author: { account: UserAccount; namespaceId: SafeInteger };
      }
  );
```

`JsonObjectString` is a string encoding of a UTF-8 JSON object, not arbitrary text. A consumer MUST validate the outer `FederatedMessage` before processing `content` according to `contentType`. It MUST parse the string once as JSON and strictly validate the corresponding closed schema. It MUST reject a result that is not an object, contains fields unknown to that type, uses an unknown content type, or otherwise violates the type.

## 2. Thread and author

- Thread addresses are relative to the authenticated S2S exchange. For a message
  query response, the source domain is the queried publisher's logical domain,
  authenticated by hostname-validated TLS under the pinned peer identity rules.
  The target domain is the querying consumer's domain, authenticated to the
  publisher by the GET request's HTTP Message Signature. The request signer is
  the consumer, not the message publisher; ordinary responses are not signed.
  Neither domain is repeated inside `thread`.
- When `thread.account` is a `UserAccount`, the thread is P2P. `account` is
  hosted by the source domain and `peerAccount` MUST be a `UserAccount` hosted
  by the target domain. The complete Addresses are distinct; the account strings
  MAY be equal across different domains.
- When `thread.account` is a `GroupAccount`, the thread is GROUP and
  `peerAccount` MUST be absent. Group delivery is scoped to the target peer,
  not to an individual member hosted on that peer.
- Every message MUST contain a closed `author` object and MUST NOT contain
  top-level `authorRef` or `namespaceId` fields.
- A P2P `author` contains exactly `ref` and `namespaceId`.
  `author.ref: THREAD_ACCOUNT` identifies the source-hosted `thread.account`;
  `author.ref: THREAD_PEER_ACCOUNT` identifies the target-hosted `thread.peerAccount`.
  The two authenticated exchange identities and this discriminator uniquely
  reconstruct the author. No `account` or `domain` is carried in a P2P `author`.
- A GROUP `author` contains exactly `account` and `namespaceId`. A group
  publisher may relay a message authored by another member home, so direction
  alone cannot identify its author. Neither `ref` nor `domain` is carried.
- `author.namespaceId` identifies the author profile subject namespace in the current
  message publisher's namespace space and follows the publisher-scoped rules of
  [Core Protocol Section 6.2.1](../protocol.md#621-publisher-scoped-namespace-interpretation).
  It is scoped by the publisher serving
  this message page and has no standalone meaning outside that publisher. `0`
  marks an author hosted by the publisher itself; a positive value is the
  publisher's namespace for the author's home identity. A domain, when needed,
  is resolved through that publisher's namespace bindings, not carried as a
  second author identity. The namespace is part of the profile target together with the
  reconstructed P2P author or explicit GROUP `author` and `profileRev`.
- `profileRev` identifies the immutable author profile selected when the
  publisher committed this message copy. It applies to the reconstructed P2P
  author or explicit GROUP `author`, never to the thread or group account. It
  is required and non-null; a positive value selects a real revision, while `0`
  means that this message has no author-profile snapshot and MUST NOT trigger a
  profile request.
- A locally authored new message carries the revision selected for its audience
  with `author.namespaceId: 0`: the author is hosted
  by the publisher itself. A publisher serializing a subject it received from
  another server re-encodes the reference into its own namespace space: the
  `author.namespaceId` becomes the publisher's namespace for that subject's home
  identity. The carried `profileRev` remains the exact revision the publisher
  retained for that subject; an intermediary MUST NOT substitute another
  retained revision or invent a namespace it did not allocate for that
  identity.

## 3. Ordering and origin time

The message wire has no client-authoritative `date` field:

- `seq` is scoped to the server and thread serving the current message copy. It
  is not a globally stable coordinate and is distinct from `originSeq` and any
  receiver-local sequence.
- `seq`, non-null `originSeq`, and either quote coordinate MUST NOT exceed
  `SafeInteger - 1`; `SafeInteger` is reserved as the maximum exclusive reverse
  query cursor.
- `createdAt` is the epoch-millisecond time at which the current publisher first persisted this copy. It is not client send time, device time, or a cross-server ordering time.
- In P2P, a publisher returning a copy to its direct source MUST send the
  received `seq/createdAt` as `originSeq/originCreatedAt`. A group origin MUST
  do the same when returning an accepted submission to its submitting member
  home. Its outer `seq/createdAt` still identifies its own copy. This is a
  processing receipt. The consumer recognizes its own author through
  `author.ref: THREAD_PEER_ACCOUNT` in P2P, or `author.namespaceId` equaling
  the peer-assigned namespace disclosed by the group origin in GROUP, then
  validates the exact original message under Section 8.
- A group origin queries a member home only for that home's own authored
  submissions, using `includeSelf=false`. A group mirror MUST NOT return
  origin-distributed messages as processing receipts to that origin, including
  messages authored by a third member home.
- A locally authored submission and authoritative distribution to a peer other
  than the direct source MUST use `originSeq/originCreatedAt: null/null`.
- A consumer MUST retain the incoming publisher's `seq/createdAt` as the direct
  source association of its copy. Receipt association MUST NOT replace an
  authoritative timeline message's source association with a mirror's coordinates.
- `originSeq/originCreatedAt` MUST either both be null or both be non-null. They are single-hop origin coordinates and MUST NOT be copied unchanged across publishers.

Origin coordinates are operational data, not diagnostic-only metadata: they
associate a copy or receipt with its direct publisher's message and support
reference-coordinate projection. They are neither global message identifiers
nor substitutes for the current publisher's `seq` in message query cursors.
The outer `originSeq` associates this message copy; `quoteTarget.originSeq`
selects the quoted target in the current receiver's timeline (section 7).

An application time inside content cannot replace the outer `createdAt`.

For example, if member home A submits message `seq=7` to group origin G,
G can expose its accepted copy as `seq=42, originSeq=7` to A and as
`seq=42, originSeq=null` to another mirror B. If B assigns its copy `seq=99`,
G does not query that copy as a receipt: G queries B with `includeSelf=false`
and receives only B's own authored submissions, not A's message mirrored by B.
A uses G's returned copy to confirm its submission. The origin time follows the same
projection. Each projection is immutable within its source/thread/target-peer
coordinate space; a publisher MUST NOT switch a previously exposed projection
between receipt and authoritative distribution on retry.

## 4. Identity and immutability

Every message MUST omit `clientMessageId`. Its federation identity and
idempotency coordinate is the direct-origin coordinate below, not a
publisher-internal client key.

The direct-origin identity of an incoming message is:

```text
(source domain, normalized thread, wire seq)
```

A consumer MUST durably store the mapping from this coordinate to its local copy. An ordinary message replay at the same origin coordinate MUST merge idempotently; it MUST NOT be deduplicated by time, preview, or local record ID.

All of the following fields are immutable at a given origin coordinate:

- `thread`
- `author`, including its `namespaceId` and matching `ref` or `account`
- `seq`
- `profileRev`
- `originSeq/originCreatedAt`
- `createdAt`
- `contentType`
- parsed `content`
- `quoteTarget`
- `quoteDigest`
- `assets`

A conflict in any field makes the item invalid. It MUST NOT be overwritten using a newer time, larger sequence, or receive order. v1 does not define message editing; [Message Tombstone Query](../message-tombstone-feed.md) expresses retraction and governance deletion.

## 5. Conditional fields

`?` in a field declaration means the field is omitted in certain valid states; it does not give the publisher an arbitrary choice:

| Field         | Required value when                     | Other valid value                                                 |
| ------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `quoteTarget` | A reply to another federated message | Omitted for an ordinary message |
| `quoteDigest` | A `quoteTarget` is present | Omitted when `quoteTarget` is omitted |

- `quoteDigest` is required exactly when `quoteTarget` is present. It is the quoted message's
  hop-independent `payloadDigest` and MUST be preserved across every hop.
- A message without `quoteTarget` MUST omit `quoteDigest`.

## 6. Asset manifest

`assets` is the authoritative manifest of CAS bytes directly referenced by content:

| `contentType`                     | Digests and `assets`                                |
| --------------------------------- | --------------------------------------------------- |
| `PURE_TEXT`, `FORWARD`            | Reference no digest directly; MUST be empty         |
| `LINK`                            | The optional `icon` and `favicon` digests           |
| `CONTACT_CARD`                    | The optional `avatarDigest`                         |
| `IMAGE`, `VIDEO`, `AUDIO`, `FILE` | Exactly one digest and a descriptor for that digest |
| `GALLERY`                         | The complete deduplicated set of item digests       |

- Each digest appears at most once.
- The deduplicated set of digests referenced by content MUST exactly equal the digest set in `assets`.
- `BlobDescriptor.bytes` is the resource's sole declared length. A consumer may use it for local size and quota checks before download; after a complete download, it MUST still validate both the actual byte count and digest.
- Resource operations alone express whether a resource currently exists; a message descriptor carries no availability state.

## 7. Reference coordinates

Any federated message type may carry `quoteTarget` and the accompanying `quoteDigest`. The target may be any federated message type. Local-only system notices are not federated messages and therefore cannot occur as targets.

- `seq`: the target's positive sequence in the current sender's thread. The receiver
  resolves it in that sender's coordinate space, not by its own local sequence.
- `originSeq`: the target's sequence in the current receiver's thread. The
  receiver resolves it by its own local sequence.

Both coordinates MUST be positive. Neither `{ seq: 0 }` nor
`{ originSeq: 0 }` is valid. An unavailable target body does not erase its
coordinate or the reply's retained `quoteDigest`.

For a positive target coordinate, a mirror submitting to its group authority MUST use `seq` for locally authored
targets and `originSeq` for targets received from that authority, including other
group members' messages. A P2P sender follows the same own-author/peer-author rule.
An authoritative group server republishing to a mirror MUST use its own `seq`,
regardless of the target's author. Coordinates are relative to each exchange;
intermediate servers MUST NOT blindly forward an earlier exchange's coordinate.

Target existence MUST NOT be a condition of accepting or persisting a reply.
Consumers MUST retain the coordinate's source scope: different source servers
can use the same sequence in one group. Local namespace identifiers MUST NOT
appear on the wire. No author, body, or content-type preview is transmitted.

`quoteTarget` MUST NOT be null. Omission means an ordinary message, not an
unresolved reply. A publisher MUST retain a known positive coordinate when the target body is
unavailable or withdrawn, allowing later resolution. The selected
wire reference remains subject to message immutability at its origin coordinate;
an already published reply MUST NOT change merely because target availability
changes.
Consumers MAY distinguish unpulled history from confirmed absence in presentation.

## 8. Processing receipts

After successfully persisting a P2P message, a consumer SHOULD make its copy
queryable by its direct publisher as a processing receipt. A group origin
SHOULD make an accepted submission queryable by the submitting member home in
the same way. The copy's origin pair equals the submitter's original item
`seq/createdAt`. A group mirror does not publish processing receipts back to
the group origin; the origin fetches only that home's own authored submissions.

When reading a receipt, the publisher:

- Reconstructs the author from `author.ref` for P2P, or resolves
  `(author.namespaceId, author.account)` in the source's namespace space for
  GROUP, then uses `(thread, author, originSeq)` to associate a message it
  previously published.
- MUST validate the source's authorization for that thread, the exact target
  author and coordinate, and `originCreatedAt` against the previously published
  message. An unmatched or conflicting receipt MUST NOT create a timeline
  message or grant authority to relay a third-party author's new message.
- Uses the receipt's `seq/createdAt` as the peer-copy coordinate and time. For
  GROUP receipts from the authoritative group server, these fields MAY also
  confirm the existing local message's group-authoritative coordinate and time
  by updating its local origin projection. The receipt's `originSeq` identifies
  the original local message; its `seq` identifies the authoritative group copy.
- MUST NOT create a new timeline message, change the original message's content,
  produce another receipt, or distribute the receipt further. Updating the
  existing message's local coordinate projection is not a new publication.

The absence of an observed receipt does not prove processing failure and cannot distinguish pending processing, transport delay, local policy delay, or discard.

## 9. Common receive order

1. Validate the thread, its matching author selector, query sequence, and every
   outer field.
2. Parse and validate `content` according to `contentType`.
3. Validate that `assets` exactly matches the set of content digests.
4. Receive idempotently using the direct-origin identity and preserve the
   coordinate association.
5. Resolve referenced resources using the exact message authorization and
   digest binding; resource completion may occur after message-coordinate
   acceptance.
6. Apply accepted items without fabricating resource availability or authority.

One invalid message or a later resource failure MUST NOT permanently block other messages on the same page or the cursor, and MUST NOT leave a partial write that could be treated as a valid message, resource-authorization proof, or other application fact.
