# `FORWARD` Message and Bundle

Status: `DRAFT` — Final Review (`v1.0.0-draft.1`)

This document defines a timeline `FORWARD` card and the immutable forward bundle it references. The wire card references only the bundle root ID; the complete bundle is fetched through a resource operation, and summaries are derived locally after validation. See [Message Envelope](./envelope.md) for the shared outer message shape and [Resources, Section 4](../resources.md#4-forward-bundles) for HTTP, authorization, and error contracts.

## 1. Outer card content

```ts
interface ForwardCardContent {
  bundleId: string;
}
```

This is a closed schema with no optional fields.

- `bundleId` is the lowercase SHA-256 digest of the complete bundle body, encoded as 64 hexadecimal characters. It is content-addressed and MUST NOT be generated as an opaque publisher-local ID.
- A publisher MUST prevent serving a body under a digest that does not match its canonical bundle body.
- The outer FORWARD message `assets` MUST be empty; bundle assets are not repeated on the card.
- After downloading and validating the bundle, the consumer derives a local summary, message count, and asset count from the actual content. These locally derived fields are not part of the federation wire.

## 2. Complete outer-message example

```json
{
  "thread": {
    "account": "alice",
    "peerAccount": "bob"
  },
  "author": {
    "ref": "THREAD_ACCOUNT",
    "namespaceId": 0
  },
  "seq": 91,
  "profileRev": 7,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000200000,
  "contentType": "FORWARD",
  "content": "{\"bundleId\":\"4ec5f4dbe0209f7e68279871a32b63cca50799d0501ec8ea5de5fba5e3bd5e0a\"}",
  "assets": []
}
```

## 3. Bundle schema

```ts
interface ForwardWireBundle {
  id: string;
  messages: ForwardBundleMessage[];
  children: ForwardChildBundle[];
  assets: BlobDescriptor[];
}

interface ForwardChildBundle {
  id: string;
  messages: ForwardBundleMessage[];
}

interface ForwardProfileSnapshot {
  displayName: string;
  avatarDigest?: Sha256Hex;
}

interface ForwardBundleMessageBase {
  id: PositiveSafeInteger;
  profile: ForwardProfileSnapshot;
  sentAt: EpochMilliseconds;
  quoteTargetId?: SafeInteger;
}

type ForwardBundleMessage = ForwardBundleMessageBase &
  (
    | {
        contentType: 'FORWARD';
        content: JsonObjectString;
        childBundleId: string;
      }
    | {
        contentType: Exclude<ContentType, 'FORWARD'>;
        content: JsonObjectString;
      }
  );
```

`ForwardWireBundle.assets` uses the shared `BlobDescriptor { digest, bytes }` defined in [Message Envelope](./envelope.md#1-wire-types).

Every object is a closed schema. Inner `content` uses the corresponding message-content schema, except that constraints depending on the outer message thread or `quoteTarget` do not apply inside a bundle.

## 4. Bundle graph and local IDs

- The response `id` MUST equal the card and request-path `bundleId`; it MUST be a lowercase 64-character SHA-256 digest of the canonical body defined below.
- `children[]` is a flat collection of child bundles from every level and is not recursively nested.
- Each `children[].id` MUST be the SHA-256 digest of that child's canonical body, MUST be unique within the response, and MUST differ from the parent `id`.
- Parent and child bundle bodies contain only their own `messages` and child digest references. The root body additionally contains the complete closure `assets` manifest.
- The parent `messages[]` and each child `messages[]` have independent message-ID spaces.
- Each `id` MUST be unique within one `messages[]`; different bundle arrays may reuse the same ID.
- A positive `quoteTargetId` is resolved only in the same enclosing `messages[]` and MUST NOT cross a bundle boundary. Zero denotes an absent target and does not reference a message ID.
- An inner message with `contentType: 'FORWARD'` MUST carry `childBundleId`, which MUST match one `children[].id`.
- A non-FORWARD inner message MUST omit `childBundleId`.
- Multiple messages, in the same or different bundles, MAY reference the same child digest. The child body MUST occur only once in the flat `children[]`; every message reference remains present.
- Bundle dependencies MUST form a directed acyclic graph. Self-cycles and mutual cycles are invalid; the consumer MUST reject a closure containing either. The flat `children[]` representation does not exempt dependencies from cycle validation.

The canonical body for each bundle is:

```text
JCS({
  messages: bundleMessages,
  children: directChildDigests sorted lexicographically,
  assets: bundleAssets sorted by digest
})
```

- `bundleMessages` is that bundle's own `messages[]`, in its published order:
  the root's messages for the root digest, or the selected child's messages for
  that child digest. It does not include descendant messages.
- `directChildDigests` is the list of `childBundleId` values extracted from
  `bundleMessages`. Each direct reference contributes one entry; sorting does
  not deduplicate entries, including permitted shared-child references. It is
  not the list of IDs in the response's flat `children[]` closure.
- `bundleAssets` is the complete response's `assets` manifest for the root and
  an empty array for every child bundle.

For example, for dependencies A → B → C, A's hash input contains `[B.id]` in
`children`, B's contains `[C.id]`, and C's contains `[]`. The response for A
still includes both B and C in its flat `children[]` collection.

The digest is the lowercase hexadecimal SHA-256 of the UTF-8 bytes of this JCS
body. The bundle's own `id` is not included in the body. Before hashing, each
inner FORWARD message's `childBundleId` and `content.bundleId` MUST name the
referenced child's digest. This recursively defines a DAG; cycles are invalid.

## 5. Display snapshots, quotes, and assets

- `profile.displayName` is the required immutable nickname snapshot and contains
  1–31 Unicode code points, matching the profile and CONTACT_CARD display-name
  limits so a valid source name can be retained without truncation. It is
  untrusted display data, not an authorization
  coordinate.
- An inner message carries no author identity object or author account, domain,
  or root-key fields. `profile` contains only the immutable display snapshot.
  A consumer MUST NOT infer an author identity from a nickname or avatar, or
  treat equal display snapshots as proof of a shared author. The outer message's
  author remains governed by Message Envelope.
- When the exact profile selected by the source message is unavailable, the
  publisher MUST still provide a stable display name captured from the source
  message identity; it MUST NOT read or substitute a mutable current/default
  profile. Forward creation does not grant profile-query authority.
- A snapshot with no available avatar omits only `profile.avatarDigest`.
- `profile.avatarDigest`, when present, MUST appear in the parent `assets`.
  The profile snapshot deliberately carries no `profileRev`: it is frozen and
  self-contained inside the bundle and creates no exact-profile query right.
- A reply carries `quoteTargetId`. If its original target is
  included in the same enclosing `messages[]`, `quoteTargetId` MUST be that target's
  bundle-local message ID. When the target is absent, the publisher SHOULD use
  `quoteTargetId: 0`, preserving reply intent without a navigable target. A consumer MUST
  also accept a positive reference whose target is absent and MUST NOT resolve
  it in another bundle or the carrier thread. An ordinary message MUST omit it.
- `quoteTargetId` is a nonnegative safe integer. A quote carries no preview;
  `content.quote` and source-thread namespace identifiers MUST NOT appear.
- Both the publisher's stored snapshot and every imported snapshot MUST use this
  bundle-local reference. Later arrival of a source message does not change an immutable bundle.
- Forwarding a reply and its target together MUST rebuild the reference from
  the source thread's resolved target to the target's ID in the new bundle.
  An inner reply may itself be the target of another inner reply. Each child
  array has an independent reference space.
- The filename, MIME type, and media kind come from the inner content that references the digest and are not repeated in the asset descriptor.
- An inner CONTACT_CARD retains its original target address, root key, and display snapshot; these identify the card's subject, not the snapshot message's author. Its optional `avatarDigest` participates in the parent asset set like every other inner-content digest.
- The deduplicated set of all profile-avatar and inner-content digests MUST exactly equal the parent `assets`.
- A child has no independent assets array.
- Expanded message counts include each reference occurrence, not just unique
  stored bodies: `count(B) = B.messages.length + sum(count(child))` over every
  child reference in B. Depth is the longest reference path, counting the root
  as one. Consumers MAY memoize each node's count and depth, but MUST include
  its cached count again for every reference. Thus two root cards referencing
  the same 300-message leaf count as 602 messages, not 302. Assets remain
  deduplicated by digest. The publisher does not declare derivable counts on
  the wire; local resource limits apply to these expanded counts.

The same federation content-type set applies to inner and outer messages.

An unknown inner content type makes the bundle malformed. The consumer MUST discard the entire bundle, persist no partial closure, and download none of its assets.

## 6. Minimal complete bundle example

The following is the complete response data referenced by the card in Section 2. See Resources for the HTTP success envelope.

```json
{
  "id": "4ec5f4dbe0209f7e68279871a32b63cca50799d0501ec8ea5de5fba5e3bd5e0a",
  "messages": [
    {
      "id": 1,
      "profile": {
        "displayName": "Alice"
      },
      "sentAt": 1769990000000,
      "contentType": "PURE_TEXT",
      "content": "{\"text\":\"hello\"}"
    }
  ],
  "children": [],
  "assets": []
}
```

## 7. Child-reference example

An inner FORWARD in the parent messages:

```json
{
  "id": 2,
  "profile": {
    "displayName": "Alice"
  },
  "sentAt": 1769991000000,
  "contentType": "FORWARD",
  "content": "{\"bundleId\":\"5008452681bc195f364698644302bb162efc765f85bd07c0ffbf2a5a7f02649d\"}",
  "childBundleId": "5008452681bc195f364698644302bb162efc765f85bd07c0ffbf2a5a7f02649d"
}
```

The same response `children[]` MUST contain:

```json
{
  "id": "5008452681bc195f364698644302bb162efc765f85bd07c0ffbf2a5a7f02649d",
  "messages": [
    {
      "id": 1,
      "profile": {
        "displayName": "Bob"
      },
      "sentAt": 1769980000000,
      "contentType": "PURE_TEXT",
      "content": "{\"text\":\"nested message\"}"
    }
  ]
}
```

`content.bundleId`, `childBundleId`, and `children[].id` MUST be equal to the
referenced child bundle's SHA-256 digest. A child ID is resolved only within the
current parent response; an independent request to `/forward-bundles/:childDigest`
MUST NOT be made.

## 8. Fetch, validation, and commit

A consumer MUST validate the complete bundle's closed shape, digests, reference
closure, local IDs, actual counts, and asset descriptors before accepting it
within one atomic commit boundary. A cycle or any other validation failure
rejects the entire bundle; the consumer MUST NOT retain an authorizing partial
graph or present a saved summary or partial closure as the complete bundle.

v1 sets no common byte, child-count, or message-count maximum. A consumer MAY
decline a closure under finite local limits, using the actual counts defined
in Section 5, but MUST NOT commit a partial closure or block the outer FORWARD
message/query cursor.

The consumer MUST retain the binding between the closure and the outer FORWARD
message through which it was discovered. Resource authorization and media-query
coordinate derivation follow [Resources, Sections 4.1 and 4.3](../resources.md#4-forward-bundles).

## 9. Required rejections

A consumer MUST reject at least the following cases:

- Card `bundleId`, request path, and response `id` are not equal.
- A card or bundle response carries a summary, version, or count field not permitted on the wire.
- A child ID is duplicated, equals the parent ID, or a `childBundleId` has no matching child.
- Bundle dependencies contain a self-cycle or mutual cycle.
- A FORWARD inner message lacks `childBundleId`.
- A non-FORWARD inner message carries `childBundleId`.
- A message ID is duplicated within one messages array.
- A quote is null, negative, fractional, or nonnumeric.
- The profile-avatar or content-digest set differs from the parent `assets`.
- `profile` carries fields other than `displayName` and optional `avatarDigest`.
- Any object contains an unknown field.
- The bundle can be read, validated, or persisted only partially.

## 10. Reply examples

For a bundle containing only a reply, its text content is `{"text":"reply"}`
and its outer reference is `"quoteTargetId": 0`. The source thread's
sequence and namespace are not retained.

If message ID `1` is the selected original, reply ID `2` carries
`"quoteTargetId": 1`. A reply to that reply, ID `3`, carries
`"quoteTargetId": 2`. This remains true when the source thread used
entirely different sequence numbers. These IDs never authorize source history.
