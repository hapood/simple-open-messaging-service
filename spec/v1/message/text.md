# `PURE_TEXT` Message

Status: `DRAFT` — Final Review (`v1.0.0-draft.0`)

This document defines parsed `PURE_TEXT` content, quoted replies, and inline entities. See [Message Envelope](./envelope.md) for shared outer fields and receive rules.

## 1. Content schema

```ts
interface PureTextContent {
  text: string;
}
```

`PureTextContent` is the closed object produced by parsing the outer message `content` once as JSON. `text` MUST be non-empty valid Unicode and MUST NOT contain an unpaired surrogate. It MUST NOT carry HTML, editor-private JSON nodes, or executable markup.

v1 does not define a universal maximum length. Publishers and consumers may impose local safety limits, but MUST NOT treat the character count after mention expansion, JSON-encoded length, and UTF-8 byte length as the same quantity.

## 2. Reply

Ordinary text omits the outer message `quoteTarget`. A quoted reply MUST satisfy all of the following:

- A reply may use any federated message `contentType`; this document describes the `PURE_TEXT` representation.
- `quoteTarget` identifies a target in the same thread using exactly
  one of `seq` (positive sender coordinate) or
  positive `originSeq` (receiver coordinate).
- The outer message `assets` is empty.

A quote carries no author, body, or content-type preview. `quoteTarget` supplies its navigation coordinate, while the required `quoteDigest` binds the quoted payload independently of that coordinate. The protocol defines no secondary
preview that could conflict with the target and does not prescribe presentation
when that target is unavailable.

## 3. Inline entities

The canonical wire form of an inline entity is:

```text
[@<label>](somfp://<entity-type>/<percent-encoded-id>)
```

v1 supports user mentions and group-wide audience mentions:

```text
[@Alice](somfp://user/12/alice)
[@everyone](somfp://audience/all)
```

`somfp` is an identifier scheme inside message text, not a transport scheme. An implementation MUST NOT issue a network request for this URI. Relative references, base-URI resolution, queries, fragments, ports, and userinfo are not defined. A canonical v1 URI has exactly one of these two ASCII forms:

```abnf
somfp-user     = "somfp://user/" namespace-id "/" user-account
somfp-audience = "somfp://audience/all"
```

`namespace-id` is a non-negative decimal integer in the **group origin's
namespace space**, and `user-account` strictly uses the `UserAccount` ASCII
grammar defined by the [core protocol](../protocol.md#62-shared-federation-types).
`0` denotes a member hosted by the group origin; a positive value is the namespace
that origin allocated for the member's home identity. A submitting member home,
a mirror serving the message, and the receiving consumer MUST all interpret the
token in that same group-origin space, never in their own namespace space or the
current message publisher's space. The target matches the Group Meta member key
`(body.namespaceId, body.account)`. A sender MUST NOT place a transport `Domain`
in a user entity; its identity is `(group origin, namespaceId, account)`, never
`account@domain`. The outer message's `author.namespaceId` still uses the current
message publisher's space; it does not change the scope of a token inside content.

Two v1 entity URIs are equal only when their complete ASCII byte sequences are equal. A consumer MUST NOT use general URL normalization, host case folding, default-port removal, or percent-decoding followed by re-encoding to create another equivalent form. After successful parsing, the semantic identity of a user entity is the decoded `(namespaceId, account)`; the semantic identity of an audience entity is fixed as `all`.

- The decoded ID of a user entity is canonical `(namespaceId, account)`; the label is only a display snapshot.
- `audience/all` may appear only in a GROUP thread.
- Scheme and entity-type comparisons are case-sensitive; the publisher MUST use the sole canonical forms above.
- Inside a label, `\`, `[`, and `]` are encoded as `\\`, `\[`, and `\]`, respectively. In ordinary text, a literal `[` is written as `\[` and a literal `\` as `\\`.
- A malformed, escaped, or incomplete token is displayed as ordinary readable text and MUST NOT produce mention authorization or attention semantics.
- A consumer MUST render safely using a text node or component and MUST NOT treat an entity as HTML.

The author server validates that a mention applies to the thread before first
persistence, resolving the target against the group's current roster in the
origin's namespace space. When accepting a submission, the group origin validates
the group context again but does not rewrite a valid token. Every subsequent
publisher preserves that token unchanged, keeping both target interpretation and
the payload digest stable across hops. For example, if G assigns namespace `12`
to home A, `somfp://user/12/alice` always identifies Alice at A in G's group,
even when submitted by B or served from B's mirror. A consumer MUST NOT resolve
`12` through B's unrelated namespace bindings.

## 4. Complete ordinary-text example

```json
{
  "thread": {
    "account": "!team"
  },
  "author": {
    "account": "alice",
    "namespaceId": 0
  },
  "seq": 42,
  "profileRev": 7,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000000000,
  "contentType": "PURE_TEXT",
  "content": "{\"text\":\"Hello [@Alice](somfp://user/12/alice)\"}",
  "assets": []
}
```

## 5. Complete reply example

```json
{
  "thread": {
    "account": "alice",
    "peerAccount": "bob"
  },
  "author": {
    "ref": "THREAD_PEER_ACCOUNT",
    "namespaceId": 12
  },
  "seq": 57,
  "profileRev": 9,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000005000,
  "quoteTarget": {
    "seq": 42
  },
  "quoteDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "contentType": "PURE_TEXT",
  "content": "{\"text\":\"Acknowledged\"}",
  "assets": []
}
```

In this example the publisher assigned namespace `12` to the peer hosting `bob`. The `quoteDigest` is an illustrative retained target digest, not a hash of the reply text.

## 6. Required rejections

A consumer MUST reject at least the following cases:

- `text` is empty, is not a string, or contains an unpaired surrogate.
- Content contains an unknown field, including an embedded `quote`.
- `quoteTarget` is null, has neither or both coordinate fields, an unknown
  field, or a zero, negative, or fractional coordinate.
- `quoteTarget` identifies another thread.
- The outer `assets` of a `PURE_TEXT` message is non-empty.

## 7. Replies with an absent target

A reply whose target body is unavailable MUST retain its positive `seq` or
`originSeq` reference and accompanying `quoteDigest`. It remains distinguishable
from an ordinary message, which omits `quoteTarget`. Receiving a reply does not
require receiving its target first; zero is not a valid wire coordinate.
See [Reference coordinates](./envelope.md#7-reference-coordinates).

Inside a history-forward bundle, references are rebuilt in the enclosing
messages array. A selected target uses its bundle-local message ID; an
unselected or nonexistent target SHOULD use zero. A positive reference with
no matching bundle entry is also accepted as absent. See [Forward quotes](./forward.md#5-display-snapshots-quotes-and-assets).
