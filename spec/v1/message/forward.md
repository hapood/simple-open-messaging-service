# `FORWARD` Message and Bundle

Status: `DRAFT` — Final Review (`v1.0.0-draft.0`)

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
  "content": "{\"bundleId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}",
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

interface ForwardAuthor {
  account: UserAccount;
  domain: Domain;
  publicRootKey?: Base64Ed25519Key;
}

interface ForwardProfileSnapshot {
  displayName: string;
  avatarDigest?: Sha256Hex;
}

interface ForwardBundleMessageBase {
  id: PositiveSafeInteger;
  author?: ForwardAuthor;
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
- Child references may contain self-cycles and mutual cycles. The consumer does not recursively expand the graph; it scans the parent messages and flat children once each.

The canonical bundle body is:

```text
JCS({
  messages: messages,
  children: children[].id sorted lexicographically,
  assets: root.assets sorted by digest
})
```

For a child bundle, `assets` is an empty array. The bundle's own `id` is not included
in the body. A child reference in a message is replaced by the referenced child's digest
before hashing. This recursively defines a DAG; cycles are invalid.

## 5. Authors, quotes, and assets

- `profile.displayName` is the required immutable nickname snapshot and contains
  1–30 Unicode code points. It is untrusted display data, not an authorization
  coordinate.
- `author` is optional. When present, it is a closed provenance snapshot with
  required `account` and `domain`; `publicRootKey` is optional. A consumer MUST
  NOT infer a missing author from the nickname. `publicRootKey`, when present,
  MUST be a canonical padded-base64 Ed25519 public root key value. It is
  provenance metadata for the author domain/root snapshot and is not a profile
  lookup key.
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
- An inner CONTACT_CARD retains its original address and display snapshot; its optional `avatarDigest` participates in the parent asset set like every other inner-content digest.
- The deduplicated set of all profile-avatar and inner-content digests MUST exactly equal the parent `assets`.
- A child has no independent assets array.
- The consumer computes any locally needed counts from the actual lengths of
  the parent messages, all child messages, and assets. The publisher does not
  declare derivable counts on the wire, and the protocol does not prescribe
  their storage or local use.

The same federation content-type set applies to inner and outer messages.

An unknown inner content type makes the bundle malformed. The consumer MUST discard the entire bundle, persist no partial closure, and download none of its assets.

## 6. Minimal complete bundle example

The following is the complete response data referenced by the card in Section 2. See Resources for the HTTP success envelope.

```json
{
  "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "messages": [
    {
      "id": 1,
      "author": {
        "account": "alice",
        "domain": "a.example"
      },
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
  "author": {
    "account": "alice",
    "domain": "a.example"
  },
  "profile": {
    "displayName": "Alice"
  },
  "sentAt": 1769991000000,
  "contentType": "FORWARD",
  "content": "{\"bundleId\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
  "childBundleId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

The same response `children[]` MUST contain:

```json
{
  "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "messages": [
    {
      "id": 1,
      "author": {
        "account": "bob",
        "domain": "b.example"
      },
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

A consumer MUST validate the complete bundle's closed shape, reference closure, local IDs, actual counts, and asset set before saving it within one commit boundary. It MUST NOT save a partial bundle that could participate in display or resource authorization.

Bundle and CAS requests are always bound to the outer FORWARD message through which the bundle was discovered. A media request uses that message's thread, author, authoritative-publisher `seq`, and digest. A child ID, inner author, bundle-local message ID, or quote target MUST NOT be used as an authorization coordinate.

## 9. Required rejections

A consumer MUST reject at least the following cases:

- Card `bundleId`, request path, and response `id` are not equal.
- A card or bundle response carries a summary, version, or count field not permitted on the wire.
- A child ID is duplicated, equals the parent ID, or a `childBundleId` has no matching child.
- A FORWARD inner message lacks `childBundleId`.
- A non-FORWARD inner message carries `childBundleId`.
- A message ID is duplicated within one messages array.
- A quote is null, negative, fractional, or nonnumeric.
- The profile-avatar or content-digest set differs from the parent `assets`.
- `author` carries display fields, or `profile` carries identity fields or a
  `profileRev`.
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
