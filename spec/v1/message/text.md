# `PURE_TEXT` Message

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

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

- The outer message contains `quoteTarget`.
- `quoteTarget` identifies a target message from the current authoritative publisher in the same thread.
- The outer message `assets` is empty.

A quote carries no author, body, or content-type preview. The consumer generates a summary from the local target message and displays an unavailable placeholder when the target is missing. This leaves the quote with one authoritative coordinate and prevents conflicts between a preview and target content.

## 3. Inline entities

The canonical wire form of an inline entity is:

```text
[@<label>](somfp://<entity-type>/<percent-encoded-id>)
```

v1 supports user mentions and group-wide audience mentions:

```text
[@Alice](somfp://user/alice%40example.com)
[@everyone](somfp://audience/all)
```

`somfp` is an identifier scheme inside message text, not a transport scheme. An implementation MUST NOT issue a network request for this URI. Relative references, base-URI resolution, queries, fragments, ports, and userinfo are not defined. A canonical v1 URI has exactly one of these two ASCII forms:

```abnf
somfp-user     = "somfp://user/" user-account "%40" domain
somfp-audience = "somfp://audience/all"
```

`user-account` and `domain` strictly use the `UserAccount` and `Domain` ASCII grammars defined by the [core protocol](../protocol.md#62-shared-federation-types). The separating `@` MUST be encoded as `%40` using uppercase hexadecimal. No other character may be percent-encoded. Consequently, `%4a`, `%4A`, encoding an unreserved character, double encoding, an empty host, an extra path segment, a port, a fragment, or a query does not form a canonical v1 entity.

Two v1 entity URIs are equal only when their complete ASCII byte sequences are equal. A consumer MUST NOT use general URL normalization, host case folding, default-port removal, or percent-decoding followed by re-encoding to create another equivalent form. After successful parsing, the semantic identity of a user entity is the decoded `UserAccount@Domain`; the semantic identity of an audience entity is fixed as `all`.

- The decoded ID of a user entity is canonical `account@domain`; the label is only a display snapshot.
- `audience/all` may appear only in a GROUP thread.
- Scheme and entity-type comparisons are case-sensitive; the publisher MUST use the sole canonical forms above.
- Inside a label, `\`, `[`, and `]` are encoded as `\\`, `\[`, and `\]`, respectively. In ordinary text, a literal `[` is written as `\[` and a literal `\` as `\\`.
- A malformed, escaped, or incomplete token is displayed as ordinary readable text and MUST NOT produce mention authorization or attention semantics.
- A consumer MUST render safely using a text node or component and MUST NOT treat an entity as HTML.

The author server validates that a mention applies to the thread before first persistence. When accepting a submission, the group origin validates the group context again but does not rewrite a valid token.

## 4. Complete ordinary-text example

```json
{
  "thread": {
    "account": "alice",
    "peerAccount": "bob"
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 42,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000000000,
  "contentType": "PURE_TEXT",
  "content": "{\"text\":\"Hello [@Alice](somfp://user/alice%40example.com)\"}",
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
  "author": { "account": "bob", "domain": "b.example" },
  "seq": 57,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000005000,
  "quoteTarget": {
    "targetSeq": 42
  },
  "contentType": "PURE_TEXT",
  "content": "{\"text\":\"Acknowledged\"}",
  "assets": []
}
```

## 6. Required rejections

A consumer MUST reject at least the following cases:

- `text` is empty, is not a string, or contains an unpaired surrogate.
- Content contains an unknown field, including an embedded `quote`.
- `quoteTarget.targetSeq` is not a `PositiveSafeInteger`.
- `quoteTarget` identifies another thread.
- The outer `assets` of a `PURE_TEXT` message is non-empty.
