# `LINK` Message

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document defines a `LINK` card containing page metadata. Artwork is local presentation state and is not federated. An ordinary URL in message text remains `PURE_TEXT` and does not use this type. See [Message Envelope](./envelope.md) for the shared outer message shape.

## 1. Content schema

```ts
interface LinkPreviewContent {
  url: string;
  title: string;
  description: string;
  siteName: string;
}
```

This is a closed schema. `url`, `title`, `description`, and `siteName` are always required.

## 2. Field rules

- `url` MUST be an absolute `http` or `https` URL.
- `url` is the user-visible application link, not a media-download address or resource-authorization proof.
- A consumer MUST NOT automatically visit the page URL merely because it received a LINK message.
- `title`, `description`, and `siteName` may be empty strings. An empty string means the publisher obtained no usable value; it does not mean the remote page authoritatively declared an empty value.
- `assets` MUST be empty. Page images and icons MUST NOT be included in federated content or resources.
- A consumer MAY use default artwork or generate local artwork after an explicit user action, subject to its own URL-fetching security policy.

## 3. Example

```json
{
  "thread": {
    "account": "alice",
    "localAccount": "bob"
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

## 4. Required rejections

A consumer MUST reject at least the following cases:

- `url` is not an absolute HTTP(S) URL.
- `title`, `description`, or `siteName` is absent or is not a string.
- `assets` is not empty.
- Content or the outer message contains a field not permitted by its schema.
