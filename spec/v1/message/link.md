# `LINK` Message

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document defines a `LINK` card containing page metadata and optional CAS thumbnails. An ordinary URL in message text remains `PURE_TEXT` and does not use this type. See [Message Envelope](./envelope.md) for the shared outer message shape.

## 1. Content schema

```ts
interface LinkPreviewContent {
  url: string;
  title: string;
  description: string;
  siteName: string;
  imageDigest?: Sha256Hex;
  faviconDigest?: Sha256Hex;
}
```

This is a closed schema. `url`, `title`, `description`, and `siteName` are always required. The two digest fields may be omitted independently and MUST NOT use `null` in place of omission.

## 2. Field rules

- `url` MUST be an absolute `http` or `https` URL.
- `url` is the user-visible application link, not a media-download address or resource-authorization proof.
- A consumer MUST NOT automatically visit the page URL merely because it received a LINK message.
- `title`, `description`, and `siteName` may be empty strings. An empty string means the publisher obtained no usable value; it does not mean the remote page authoritatively declared an empty value.
- When present, `imageDigest/faviconDigest` MUST be `Sha256Hex` values and each MUST have a matching asset descriptor with the same digest in the outer message.
- The two digests may be equal. The outer message `assets` is their complete deduplicated set and therefore contains zero, one, or two entries.

## 3. Example without thumbnails

```json
{
  "thread": {
    "type": "P2P",
    "participants": [
      { "account": "alice", "domain": "a.example" },
      { "account": "bob", "domain": "b.example" }
    ]
  },
  "author": { "account": "alice", "domain": "a.example" },
  "seq": 61,
  "originSeq": null,
  "originCreatedAt": null,
  "createdAt": 1770000010000,
  "contentType": "LINK",
  "content": "{\"url\":\"https://example.com/article\",\"title\":\"Example article\",\"description\":\"A short summary\",\"siteName\":\"\"}",
  "assets": []
}
```

## 4. Example with two thumbnails

Parsed content:

```json
{
  "url": "https://example.com/article",
  "title": "Example article",
  "description": "A short summary",
  "siteName": "Example",
  "imageDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "faviconDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

The outer message MUST contain:

```json
{
  "contentType": "LINK",
  "content": "{\"url\":\"https://example.com/article\",\"title\":\"Example article\",\"description\":\"A short summary\",\"siteName\":\"Example\",\"imageDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"faviconDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}",
  "assets": [
    {
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 45678
    },
    {
      "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "bytes": 1234
    }
  ]
}
```

If `imageDigest === faviconDigest`, `assets` MUST contain exactly one descriptor.

## 5. Required rejections

A consumer MUST reject at least the following cases:

- `url` is not an absolute HTTP(S) URL.
- `title`, `description`, or `siteName` is absent or is not a string.
- An optional field uses `null`.
- A digest is not `Sha256Hex`.
- The deduplicated set of content digests differs from the outer message `assets`.
- Content or the outer message contains a field not permitted by its schema.
