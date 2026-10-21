# Simple Open Messaging Federation Protocol v1 Profile Namespace Feed

Status: `DRAFT` — Final Review (`v1.0.0-draft.0`)

Operations:

- `GET /s2s/v1/profile-namespace-feed`
- `GET /s2s/v1/profile-namespaces/:nsid`

This document is entirely normative. The Profile Namespace Feed invalidates
cached namespace-identity bindings — the domain and root public key a consumer
retains for a publisher-scoped `namespaceId` in profile references. It carries
no profile content, no authorization, and no routing decisions. Profile
display data is resolved only through the operations defined by
[Profiles](./profiles.md). [Core Protocol](./protocol.md) defines the shared
surface, envelopes, and the closed-shape rule; [State Feed](./state-feed.md)
defines the page conventions this feed reuses.

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be
interpreted as described in RFC 2119 and RFC 8174.

## 1. Identity model constraints

A publisher-scoped namespace id identifies one federated identity. The
publisher MUST NOT reassign that id to another identity. Exactly two mutations
advance this feed:

1. a **new namespace item** — a first recognition, or recognition after a
   destructive identity reset;
2. a **replacement of an existing item's bindings** — an administrator-approved
   root-public-key or domain change for the same namespace id.

An approved root rotation or domain re-binding MUST preserve the identity's
namespace id. A publisher MUST NOT retire that namespace or allocate a
successor namespace for either change. Root-key succession changes the key
binding, not the subject namespace. A destructive reset instead retires the
namespace; subsequent recognition MUST use a fresh id. The retired id MUST
retain its last bindings and MUST NOT be re-served with different bindings.

Consumers MUST resolve a namespace through the publisher's bindings query;
this feed does not authorize a consumer to replace an identity pin or invent
a namespace transition.

Namespace `0` denotes the publisher itself. A publisher changing its own
public root key or domain MUST publish a binding-change item with
`namespaceId: 0` and MUST continue to identify its own subjects with namespace
`0`. A consumer expires the cached binding and re-queries
`profile-namespaces/0`. Root adoption remains subject to Peer Recognition;
observing this feed item does not grant approval.

## 2. Feed request and bootstrap

`GET /s2s/v1/profile-namespace-feed` accepts the closed query containing
optional `after`, `take`, and `through`. `after` is an exclusive non-negative
decimal cursor, `take` a positive safe-integer suggestion, and `through` an
inclusive bound that MUST be at least `after`. `take` and `through` require
`after`.

Unlike State Feed, an omitted `after` is not an error: the source serves every
current compacted item from `0` together with its current feed end, and the
consumer initializes its cursor directly from the response. The zero fallback
is performed by the sender; this feed defines no `resumeAfter` /
`resumeBefore` envelope and no cursor-unavailable recovery. An `after` greater
than the current `feedEndId` is malformed.

## 3. Page and compaction

```ts
interface ProfileNamespaceFeedPage {
  items: ProfileNamespaceFeedItem[];
  scannedThrough: DecimalString;
  feedEndId: DecimalString;
  hasMore: boolean;
}
```

The page follows the State Feed conventions: one consistent source snapshot,
`scanEnd = through is present ? min(feedEndId, through) : feedEndId`, every
item in `(after, scannedThrough]`, strictly increasing `feedId`, `hasMore`
exactly when candidates remain, and gaps or an empty page MAY advance
`scannedThrough`.

The stable key is the `namespaceId` alone: the publisher retains exactly one
newest item per namespace id, and a repeated mutation of the same identity
replaces its item at a greater `feedId`. The source MUST retain every current
stable-key item; this feed defines no deletion item and no time- or
capacity-based floor.

## 4. Items

```ts
interface ProfileNamespaceFeedItem {
  namespaceId: SafeNonNegativeInteger;
  feedId: PositiveDecimalString;
}
```

`namespaceId` is the affected identity's namespace in the authenticated
publisher's namespace space, as defined by
[Core Protocol Section 6.2.1](./protocol.md#621-publisher-scoped-namespace-interpretation);
`0` is the publisher itself (Section 1).
The item body is the namespace id itself. An item states that the bindings of
that identity changed at least through `feedId`; it carries no domain, no key,
and no delta. A new-item entry for a namespace the consumer has never resolved
has no effect.

## 5. Consumer rules

A consumer that retains resolved bindings for publisher-scoped namespace ids
MUST compare each applied item against the feed counter it resolved those
bindings at, and MUST re-resolve through `profile-namespaces` before trusting
the cached bindings again. A response whose disclosed feed end is behind the
`feedId` that triggered the re-resolution is stale; the consumer MUST NOT
persist it as current and MUST repeat the query. Re-resolution failure leaves
the previous bindings in place; a consumer MUST NOT treat unknown bindings as
authorization for any data-plane operation.

Counter disclosure reaches the consumer through the State Feed page envelope
(`profileNamespaceFeedEndId`) and the `feed-heads` body; neither is an
acknowledgement, and both MAY be lost, so a consumer that caches bindings
SHOULD also reconcile during ordinary periodic State Feed draining.

## 6. Namespace bindings query

`GET /s2s/v1/profile-namespaces/:nsid` resolves one namespace id in the
authenticated publisher's own namespace space. `nsid` is a non-negative
decimal path parameter. The success data envelope carries:

```ts
interface ProfileNamespaceBindings {
  domain: Domain;
  rootPublicKey: Base64Ed25519Key;
  profileNamespaceFeedEndId: DecimalString;
}
```

- `nsid = 0` returns the publisher's own current public domain, root public
  key, and feed end.
- A positive `nsid` returns the current bindings the publisher retains for
  that identity and its feed end. A reset-retired id keeps answering with
  its last retained bindings — historical references must stay renderable
  and vouchable; trust gating lives elsewhere.
- An unknown positive `nsid` (one that never completed a handshake) answers
  HTTP `200` with the `NOT_FOUND` business code in the error envelope.

The bindings are display and vouching data only. They never mutate the
consumer's identity pins, admission state, or message authentication, which
remain governed exclusively by
[Peer Recognition](./recognition.md) and its review mechanism.
