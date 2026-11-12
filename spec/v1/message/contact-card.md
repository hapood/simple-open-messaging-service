# `CONTACT_CARD` Message

Status: `DRAFT` — Final Review (`v1.0.0-draft.2`)

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
  publicKey: Base64Ed25519Key;
  displayName: string;
  bio: string;
  avatarDigest?: Sha256Hex;
}
```

This is a closed schema. `account`, `domain`, `publicKey`, and `displayName`
are required. `publicKey` encodes a 32-byte Ed25519 root public key in padded
RFC 4648 standard base64.
`bio` is required and may be empty. `avatarDigest` is optional.

## 2. Address and snapshot semantics

- `account` and `domain` MUST form a valid address. A `UserAccount` identifies a
  personal contact and a `GroupAccount` identifies a group contact; the account
  grammar is the discriminator and no additional type field is carried.
- `publicKey` is the referenced home server's root public key retained when
  the card was created, not an account-specific key or a rotating HTTP signing
  key. A later public profile lookup for this card MUST bind its possession
  proof to that key under [Public Account Profile](../profiles.md#3-public-account-profile).
  Receiving the card alone proves neither possession nor trust and MUST NOT
  replace a peer trust pin. Republishing or forwarding MUST retain the key;
  it MUST NOT silently substitute the home's current key.
- `displayName` MUST contain 1–31 Unicode code points and MUST NOT contain an
  unpaired surrogate.
- `bio` MUST contain at most 120 Unicode code points and MUST NOT
  contain an unpaired surrogate.
- `displayName`, `bio`, and `avatarDigest` are an immutable display snapshot selected by
  the publisher when it created its copy of the message. They are not a live
  profile and do not change when the referenced account's profile changes.
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
  account is unavailable, removed, or cannot currently be resolved.

## 3. Avatar resource

- `avatarDigest`, when present, identifies optional card artwork. It does not
  identify the referenced account's current profile avatar.
- A present `avatarDigest` MUST have exactly one matching descriptor in the
  outer `assets`; no other digest may appear there. When `avatarDigest` is
  absent, `assets` MUST be empty.
- The avatar uses the same encoded-size, non-empty-image, and decoded-pixel
  constraints as `InlineProfileAvatar` in [Core Protocol, Section
  6.2](../protocol.md#62-shared-federation-types). Because the avatar is fetched as image bytes rather than embedded as Base64, its `BlobDescriptor.bytes` MUST be
  in the inclusive range 1–786,432. A consumer MUST verify the actual byte
  count, digest, image decoding, real dimensions, and the 512-pixel maximum
  for each dimension
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
  "author": {
    "ref": "THREAD_ACCOUNT",
    "namespaceId": 0
  },
  "seq": 72,
  "profileRev": 7,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000020000,
  "contentType": "CONTACT_CARD",
  "content": "{\"account\":\"carol\",\"avatarDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"bio\":\"Distributed systems enthusiast\",\"displayName\":\"Carol\",\"domain\":\"c.example\",\"publicKey\":\"A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=\"}",
  "assets": [
    {
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 4286
    }
  ]
}
```

## 5. Forward bundles

A `CONTACT_CARD` inside a forward bundle retains the same address, root public
key, and display snapshot. Forwarding MUST NOT refresh, replace, or reinterpret the snapshot.
Its optional `avatarDigest` participates in the bundle's deduplicated asset set
under the rules in [Forward, Section 5](./forward.md#5-display-snapshots-quotes-and-assets).

## 6. Required rejections

A consumer MUST reject at least the following cases:

- `account` is absent or invalid.
- `domain` is absent or invalid.
- `publicKey` is absent or is not a padded base64 32-byte Ed25519 public key.
- `displayName` is absent, empty, longer than 31 Unicode code points, or contains
  an unpaired surrogate.
- `bio` is absent, is not a string, is longer than 120 Unicode code points,
  or contains an unpaired surrogate.
- `avatarDigest` is present but is not a `Sha256Hex`.
- The avatar-digest set differs from `assets`.
- Content or the outer message contains a field not permitted by its schema.
