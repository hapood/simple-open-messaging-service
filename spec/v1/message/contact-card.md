# `CONTACT_CARD` Message

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document defines a `CONTACT_CARD` containing a user or group address and an
immutable display snapshot. A card may refer to its author, another user, or a
group. It does not establish that the card author controls, knows, or has a
relationship with the referenced identity. See [Message Envelope](./envelope.md) for the shared
outer message shape and resource rules.

## 1. Content schema

```ts
interface ContactCardContent {
  account: Account;
  domain: Domain;
  displayName: string;
  bio: string;
  avatarDigest?: Sha256Hex;
}
```

This is a closed schema. `account`, `domain`, and `displayName` are required.
`bio` is required and may be empty. `avatarDigest` is optional.

## 2. Address and snapshot semantics

- `account` and `domain` MUST form a valid address. A `UserAccount` identifies a
  personal contact and a `GroupAccount` identifies a group contact; the account
  grammar is the discriminator and no additional type field is carried.
- `displayName` MUST contain 1–30 Unicode code points and MUST NOT contain an
  unpaired surrogate.
- `bio` MUST contain at most 120 Unicode code points and MUST NOT
  contain an unpaired surrogate.
- `displayName`, `bio`, and `avatarDigest` are an immutable display snapshot selected by
  the publisher when it created its copy of the message. They are not a live
  profile and do not change when the referenced user's profile changes.
- All card fields are untrusted assertions by the publisher. Receipt of a card
  MUST NOT establish account existence, account control, a relationship, profile
  authority, or permission to disclose any additional profile field.
- A consumer MUST NOT create or change relationship or profile state merely
  because it received a card.
- A consumer that performs an action for the referenced address MUST use the
  ordinary protocol operation and authorization rules for that action. It MUST
  NOT treat the snapshot as a substitute for a current profile or relationship
  result.
- A consumer MAY retain and display the immutable snapshot when the referenced
  account is unavailable, removed, renamed, or cannot currently be resolved.

## 3. Avatar resource

- `avatarDigest`, when present, identifies optional card artwork. It does not
  identify the referenced user's current profile avatar.
- A present `avatarDigest` MUST have exactly one matching descriptor in the
  outer `assets`; no other digest may appear there. When `avatarDigest` is
  absent, `assets` MUST be empty.
- The avatar uses the same encoded-size, non-empty-image, and decoded-pixel
  constraints as the public profile avatar in [Resources, Section
  2.2](../resources.md#22-successful-response). Because a card transports the
  decoded resource instead of padded Base64, its `BlobDescriptor.bytes` MUST be
  in the inclusive range 1–786,432. A consumer MUST verify the actual byte
  count, digest, image decoding, real dimensions, and
  `width * height <= 16000000`
  before displaying it.
- A consumer MUST NOT fetch a user profile merely because `avatarDigest` is
  absent or the corresponding resource cannot be downloaded.

## 4. Complete example

```json
{
  "thread": {
    "account": "alice",
    "peerAccount": "bob"
  },
  "authorRef": "THREAD_ACCOUNT",
  "seq": 72,
  "profileRev": 7,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000020000,
  "contentType": "CONTACT_CARD",
  "content": "{\"account\":\"carol\",\"domain\":\"c.example\",\"displayName\":\"Carol\",\"bio\":\"Distributed systems enthusiast\",\"avatarDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}",
  "assets": [
    {
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 4286
    }
  ]
}
```

## 5. Forward bundles

A `CONTACT_CARD` inside a forward bundle retains the same address and display
snapshot. Forwarding MUST NOT refresh, replace, or reinterpret the snapshot.
Its optional `avatarDigest` participates in the bundle's deduplicated asset set
under the rules in [Forward, Section 5](./forward.md#5-authors-quotes-and-assets).

## 6. Required rejections

A consumer MUST reject at least the following cases:

- `account` is absent or invalid.
- `domain` is absent or invalid.
- `displayName` is absent, empty, longer than 30 Unicode code points, or contains
  an unpaired surrogate.
- `bio` is absent, is not a string, is longer than 120 Unicode code points,
  or contains an unpaired surrogate.
- `avatarDigest` is present but is not a `Sha256Hex`.
- The avatar-digest set differs from `assets`.
- Content or the outer message contains a field not permitted by its schema.
