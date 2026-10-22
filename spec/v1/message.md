# Simple Open Messaging Federation Protocol v1 Message

Status: `DRAFT` — Final Review (`v1.0.0-draft.0`)

This document is the entry point for the federation message specification:

- [Message Envelope](./message/envelope.md) defines the outer message shape,
  author and origin coordinates, immutability, processing receipts, asset
  manifests, and common receive rules.
- [Message Query](./message-feed.md) defines authorization, pagination, and
  query-cursor acceptance.
- [Resources](./resources.md) defines HTTP operations and authorization for
  media bytes and forward bundles.

## 1. Content specifications

The outer `content` field is a string containing an encoded JSON object. The
following documents define its parsed shape for each content type; validation
and receive order follow [Message Envelope, Sections 1 and 9](./message/envelope.md#1-wire-types).

| `contentType`  | Detailed specification                    | Semantics                                       | Direct resources                 |
| -------------- | ----------------------------------------- | ----------------------------------------------- | -------------------------------- |
| `PURE_TEXT`    | [Text](./message/text.md)                 | Text, mentions, and an optional reply reference | None                             |
| `IMAGE`        | [Media](./message/media.md)               | One image                                       | One asset                        |
| `VIDEO`        | [Media](./message/media.md)               | Video and display metadata                      | One asset                        |
| `AUDIO`        | [Media](./message/media.md)               | Audio and display metadata                      | One asset                        |
| `FILE`         | [Media](./message/media.md)               | General file                                    | One asset                        |
| `GALLERY`      | [Media](./message/media.md#4-gallery)     | Ordered mixed-media collection                  | Deduplicated set of item digests |
| `LINK`         | [Link](./message/link.md)                 | Page metadata                                   | Optional artwork assets          |
| `CONTACT_CARD` | [Contact Card](./message/contact-card.md) | User or group address and display snapshot      | Optional avatar asset            |
| `FORWARD`      | [Forward](./message/forward.md)           | Bundle root card                                | No direct card asset             |

## 2. `ContentType`

```ts
type ContentType =
  | 'PURE_TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'FILE'
  | 'AUDIO'
  | 'LINK'
  | 'CONTACT_CARD'
  | 'FORWARD'
  | 'GALLERY';
```

These nine values are the complete v1 set. Any other `contentType` is malformed.
