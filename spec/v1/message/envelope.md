# Message Envelope

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document defines the outer wire shape, origin coordinates, idempotency rules, and processing receipts shared by every message in a federation message query. See the [Message overview](../message.md#4-contenttype) and its topic documents for each parsed `contentType` shape, and [Message Query](../message-feed.md) for pagination semantics.

## 1. Wire types

```ts
interface Address {
  account: Account;
  domain: Domain;
}

type ThreadAddress =
  | { account: UserAccount; peerAccount: UserAccount }
  | { account: GroupAccount };

interface BlobDescriptor {
  digest: Sha256Hex;
  bytes: SafeInteger;
}

interface QuoteTarget {
  targetSeq: ThreadSequence;
}

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
  assets: BlobDescriptor[];
}

type FederatedMessageContent =
  | (FederatedMessageBase & {
      contentType: 'CALL';
      clientMessageId: CanonicalUuid;
    })
  | (FederatedMessageBase & {
      contentType: Exclude<ContentType, 'CALL'>;
      clientMessageId?: never;
    });

type FederatedMessage = FederatedMessageContent &
  (
    | {
        thread: { account: UserAccount; peerAccount: UserAccount };
        authorRef: 'THREAD_ACCOUNT' | 'THREAD_PEER_ACCOUNT';
      }
    | {
        thread: { account: GroupAccount };
        author: Address;
      }
  );
```

`JsonObjectString` is a string encoding of a UTF-8 JSON object, not arbitrary text. A consumer MUST validate the outer `FederatedMessage` before processing `content` according to `contentType`. It MUST parse the string once as JSON and strictly validate the corresponding closed schema. It MUST reject a result that is not an object, contains fields unknown to that type, uses an unknown content type, or otherwise violates the type.

## 2. Thread and author

- Thread addresses are relative to the authenticated S2S exchange. The source
  domain comes from the verified HTTP Message Signature and the target domain is
  the consumer's own domain; neither is repeated inside `thread`.
- When `thread.account` is a `UserAccount`, the thread is P2P. `account` is
  hosted by the source domain and `peerAccount` MUST be a distinct
  `UserAccount` hosted by the target domain.
- When `thread.account` is a `GroupAccount`, the thread is GROUP and
  `peerAccount` MUST be absent. Group delivery is scoped to the target peer,
  not to an individual member hosted on that peer.
- A P2P message MUST contain `authorRef` and MUST NOT contain `author`.
  `THREAD_ACCOUNT` identifies the source-hosted `thread.account`;
  `THREAD_PEER_ACCOUNT` identifies the target-hosted `thread.peerAccount`. The two authenticated
  exchange domains and this discriminator uniquely reconstruct the author
  address without carrying a second, potentially conflicting identity.
- A GROUP message MUST contain the explicit `author` address and MUST NOT
  contain `authorRef`. A group publisher may relay a message authored on
  another member domain, so direction alone cannot identify its author.
- `profileRev` identifies the immutable author profile selected when the
  publisher committed this message copy. It applies to the reconstructed P2P
  author or explicit GROUP `author`, never to the thread or group account. It
  is required and non-null; a positive value selects a real revision, while `0`
  means that this message has no author-profile snapshot and MUST NOT trigger a
  profile request.
- A locally authored new message carries the revision selected for its
  audience, normally the author's `defaultProfileRev` observed by the message
  commit. A non-authoritative copy, accepted group submission, authoritative
  group distribution, mirror copy, and processing receipt MUST preserve the
  direct incoming message's `profileRev`; an intermediary MUST NOT substitute
  its own default revision or another retained version.

## 3. Ordering and origin time

The message wire has no client-authoritative `date` field:

- `seq` is scoped to the server and thread serving the current message copy. It
  is not a globally stable coordinate and is distinct from `originSeq` and any
  receiver-local sequence.
- `seq`, non-null `originSeq`, and `quoteTarget.targetSeq` MUST NOT exceed
  `SafeInteger - 1`; `SafeInteger` is reserved as the maximum exclusive reverse
  query cursor.
- `createdAt` is the epoch-millisecond time at which the current publisher first persisted this copy. It is not client send time, device time, or a cross-server ordering time.
- When the authoritative origin publishes a timeline message, `originSeq/originCreatedAt` MUST be `null/null`.
- When a consumer pulls from its direct publisher and creates a non-authoritative copy, its origin pair MUST equal the incoming `seq/createdAt`.
- `originSeq/originCreatedAt` MUST either both be null or both be non-null. They are single-hop origin coordinates and MUST NOT be copied unchanged across publishers.

An application time inside content, such as CALL `startedAt/endedAt`, cannot replace the outer `createdAt`.

## 4. Identity and immutability

Only a CALL record carries `clientMessageId`. It MUST be the same
`CanonicalUuid` as the real-time call's `callId`, allowing the persisted record
to retain the call's idempotency identity without repeating it inside content.
Every other message type MUST omit `clientMessageId`; its federation identity
and idempotency coordinate is the direct-origin coordinate below, not a
publisher-internal client key.

The direct-origin identity of an incoming message is:

```text
(source domain, normalized thread, wire seq)
```

A consumer MUST durably store the mapping from this coordinate to its local copy. An ordinary message replay at the same origin coordinate MUST merge idempotently; it MUST NOT be deduplicated by time, preview, or local record ID.

All of the following fields are immutable at a given origin coordinate:

- `thread`
- `authorRef` for P2P, or `author` for GROUP
- `seq`
- `profileRev`
- `originSeq/originCreatedAt`
- `createdAt`
- `clientMessageId` for CALL
- `contentType`
- parsed `content`
- `quoteTarget`
- `assets`

A conflict in any field makes the item invalid. It MUST NOT be overwritten using a newer time, larger sequence, or receive order. v1 does not define message editing; [Message Tombstone Query](../message-tombstone-feed.md) expresses retraction and governance deletion.

## 5. Conditional fields

`?` in a field declaration means the field is omitted in certain valid states; it does not give the publisher an arbitrary choice:

| Field             | Required value when                       | Other valid value                                                 |
| ----------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `clientMessageId` | A CALL record: the corresponding `callId` | Omitted for every other message type                              |
| `quoteTarget`     | A `PURE_TEXT` message is a quoted reply   | Omitted when the message is not a quoted reply or not `PURE_TEXT` |

The corresponding content document defines type-specific conditional fields.

## 6. Asset manifest

`assets` is the authoritative manifest of CAS bytes directly referenced by content:

| `contentType`                     | Digests and `assets`                                |
| --------------------------------- | --------------------------------------------------- |
| `PURE_TEXT`, `CALL`, `FORWARD`    | Reference no digest directly; MUST be empty         |
| `LINK`                            | The optional `icon` and `favicon` digests           |
| `CONTACT_CARD`                    | The optional `avatarDigest`                         |
| `IMAGE`, `VIDEO`, `AUDIO`, `FILE` | Exactly one digest and a descriptor for that digest |
| `GALLERY`                         | The complete deduplicated set of item digests       |

- Each digest appears at most once.
- The deduplicated set of digests referenced by content MUST exactly equal `assets`.
- `BlobDescriptor.bytes` is the resource's sole declared length. A consumer may use it for local size and quota checks before download; after a complete download, it MUST still validate both the actual byte count and digest.
- Resource operations alone express whether a resource currently exists; a message descriptor carries no availability state.

## 7. Reference coordinates

Only a `PURE_TEXT` reply may carry `quoteTarget`. `quoteTarget.targetSeq` identifies the target `seq` assigned by the current authoritative publisher in the same thread.

The consumer resolves the target using `(source domain, thread, targetSeq)`. A
quote carries no remote preview, and the protocol does not prescribe a local
coordinate projection or presentation when the target is unavailable.

## 8. Processing receipts

After successfully persisting an incoming message, a consumer SHOULD make the non-authoritative copy queryable by its direct publisher as a processing receipt. The copy's origin pair equals the publisher's original item `seq/createdAt`.

When reading a receipt, the publisher:

- Reconstructs the author from `authorRef` for P2P, or reads `author` for
  GROUP, then uses `(thread, author, originSeq)` to associate a message it
  previously published.
- Uses the receipt's `seq/createdAt` only as the peer-copy coordinate and diagnostic time.
- MUST NOT create a timeline message, modify the original message, produce another receipt, or distribute it further.
- MUST NOT write the receipt's origin pair back to the original message.

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
