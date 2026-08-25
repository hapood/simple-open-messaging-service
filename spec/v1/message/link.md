# `LINK` Message

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document defines a `LINK` card containing page metadata and optional content-addressed artwork. An ordinary URL in message text remains `PURE_TEXT` and does not use this type. See [Message Envelope](./envelope.md) for the shared outer message shape.

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

- `url` MUST be an absolute `http` or `https` URL.
- `url` is the user-visible application link, not a media-download address or resource-authorization proof.
- A consumer MUST NOT automatically visit the page URL merely because it received a LINK message.
- `title` and `description` may be empty strings. When present, `siteName` may also be an empty string. An empty string means the publisher obtained no usable value; it does not mean the remote page authoritatively declared an empty value.
- `icon` is an optional digest for the card's primary artwork; `favicon` is an optional digest for the site's favicon.
- A publisher MAY send either, both, or neither artwork field. A consumer MAY use or ignore either field according to local presentation policy.
- Every present artwork digest MUST have exactly one matching descriptor in `assets`; no other digest may appear there.
- A consumer MUST treat received artwork as untrusted media and apply its normal resource size, digest-verification, decoding, and display policies. It MUST NOT fetch the page merely because artwork is absent.

## 3. Example

```json
{
  "thread": {
    "account": "alice",
    "peerAccount": "bob"
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 61,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000010000,
  "contentType": "LINK",
  "content": "{\"url\":\"https://example.com/article\",\"title\":\"Example article\",\"description\":\"A short summary\",\"siteName\":\"\",\"favicon\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}",
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

- `url` is not an absolute HTTP(S) URL.
- `title` or `description` is absent or is not a string, or a present `siteName` is not a string.
- `icon` or `favicon` is present but is not a `Sha256Hex`.
- The deduplicated artwork-digest set differs from `assets`.
- Content or the outer message contains a field not permitted by its schema.
