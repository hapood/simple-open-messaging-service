# `LINK` Message

Status: `DRAFT` — Final Review (`v1.0.0-draft.0`)

This document defines a `LINK` card containing target metadata and optional content-addressed artwork. An ordinary URL in message text remains `PURE_TEXT` and does not use this type. See [Message Envelope](./envelope.md) for the shared outer message shape.

## 1. Content schema

```ts
interface LinkPreviewContent {
  url: string;
  title: string;
  description: string;
  siteName?: string;
  icon?: Sha256Hex;
  favicon?: Sha256Hex;
}
```

This is a closed schema. `url`, `title`, and `description` are always required. `siteName`, `icon`, and `favicon` are optional.

## 2. Field rules

- `url` MUST be an absolute URI with a scheme and a nonempty scheme-specific part, contain no whitespace or control characters, and be at most 2048 characters long. The scheme is not restricted to HTTP(S). Relative references are invalid.
- `url` is the user-visible link target, not a media-download address or resource-authorization proof. The protocol does not require consumers to support or open any particular scheme; handling and navigation policy are local implementation choices.
- A consumer MUST treat `url` as untrusted and MUST NOT open or navigate to it solely because the message was received.
- `title` and `description` may be empty strings. When present, `siteName` may also be an empty string. An empty string means the publisher obtained no usable value; it does not mean the remote page authoritatively declared an empty value.
- `icon` is an optional digest for the card's primary artwork; `favicon` is an optional digest for the site's favicon.
- A publisher MAY send either, both, or neither artwork field. A consumer MAY use or ignore either field according to local presentation policy.
- Every present artwork digest MUST have exactly one matching descriptor in `assets`; no other digest may appear there.
- A consumer MUST treat received artwork as untrusted media and apply its normal resource size, digest-verification, decoding, and display policies.

## 3. Example

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
  "seq": 61,
  "profileRev": 7,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000010000,
  "contentType": "LINK",
  "content": "{\"description\":\"A short summary\",\"favicon\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"siteName\":\"\",\"title\":\"Example article\",\"url\":\"https://example.com/article\"}",
  "assets": [
    {
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 4286
    }
  ]
}
```

## 4. Required rejections

A consumer MUST reject at least the following cases:

- `url` is not an absolute URI satisfying the field rules above.
- `title` or `description` is absent or is not a string, or a present `siteName` is not a string.
- `icon` or `favicon` is present but is not a `Sha256Hex`.
- The deduplicated artwork-digest set differs from `assets`.
- Content or the outer message contains a field not permitted by its schema.
