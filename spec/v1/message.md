# Simple Open Messaging Federation Protocol v1 Message

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is the entry point for the federation message specification. See [Message Envelope](./message/envelope.md) for the outer message shape, origin coordinates, idempotency, resource descriptors, and processing receipts. The table below links to the sole detailed definition of each content type.

See [Message Query](./message-feed.md) for query pagination semantics and [Resources](./resources.md) for resource HTTP operations.

## 1. Type and processing overview

In the outer message shape, `content` is always a string containing an encoded JSON object. A consumer MUST validate `FederatedMessage` first, parse `content` once as JSON, and strictly validate the corresponding closed core schema.

| `contentType`  | Detailed specification                    | Semantics                                       | Direct resources                 |
| -------------- | ----------------------------------------- | ----------------------------------------------- | -------------------------------- |
| `PURE_TEXT`    | [Text](./message/text.md)                 | Text, mentions, and an optional reply reference | None                             |
| `IMAGE`        | [Media](./message/media.md)               | One image                                       | One asset                        |
| `VIDEO`        | [Media](./message/media.md)               | Video and display metadata                      | One asset                        |
| `AUDIO`        | [Media](./message/media.md)               | Audio and display metadata                      | One asset                        |
| `FILE`         | [Media](./message/media.md)               | General file                                    | One asset                        |
| `GALLERY`      | [Media](./message/media.md#4-gallery)     | Ordered mixed-media collection                  | Deduplicated set of item digests |
| `LINK`         | [Link](./message/link.md)                 | Page metadata                                   | None                             |
| `CONTACT_CARD` | [Contact Card](./message/contact-card.md) | User-address and display snapshot               | Optional avatar asset            |
| `CALL`         | [Call Record](./message/call-record.md)   | Terminal P2P call record                        | None                             |
| `FORWARD`      | [Forward](./message/forward.md)           | Bundle root card                                | No direct card asset             |

A consumer processes an item of a known type in this order:

1. Validate the outer message shape.
2. Parse and validate the content.
3. Validate content digests and asset descriptors, and enforce local size limits from `assets[].bytes` before download.
4. Receive idempotently by direct-origin coordinate.
5. Enforce local quotas against actual arrays and descriptors; do not trust remotely supplied derivable counts.
6. Make the accepted message durably recoverable before committing its query
   cursor, then fetch bytes through the resource operations. The protocol does
   not require a particular database transaction, work queue, or storage model.

A bad item or resource failure MUST NOT permanently block other valid messages on the same page or the query cursor.

## 2. Ordering and time semantics

The sole specification for `seq`, `createdAt`, `originSeq`, and `originCreatedAt` is [Message Envelope, Section 3](./message/envelope.md#3-ordering-and-origin-time). The message wire has no client-authoritative `date` field, and an application time inside content cannot replace the outer `createdAt`.

## 3. Outer message

The sole definitions of `FederatedMessage`, `Address`, `ThreadAddress`, `QuoteTarget`, and `BlobDescriptor` are in [Message Envelope, Section 1](./message/envelope.md#1-wire-types).

### 3.1 Protocol identity and coordinate derivation

See [Message Envelope, Section 4](./message/envelope.md#4-identity-and-immutability) and [Section 7](./message/envelope.md#7-reference-coordinates) for direct-origin identity and reply, media, and bundle coordinates.

### 3.2 Immutable identity and duplicate messages

See [Message Envelope, Section 4](./message/envelope.md#4-identity-and-immutability) for immutable fields, replay, and conflict handling.

## 4. `ContentType`

```ts
type ContentType =
  | 'PURE_TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'FILE'
  | 'AUDIO'
  | 'LINK'
  | 'CONTACT_CARD'
  | 'CALL'
  | 'FORWARD'
  | 'GALLERY';
```

These ten values are the complete v1 set. Any other `contentType` is malformed.

## 5. `PURE_TEXT`

See [Text](./message/text.md) for the sole specification and complete examples.

### 5.1 Inline entities and mentions

See [Text, Section 3](./message/text.md#3-inline-entities) for inline-entity grammar, escaping, and mention handling.

## 6. Single-resource media

See [Media](./message/media.md) for the sole specification and examples for IMAGE, VIDEO, AUDIO, and FILE.

## 7. `GALLERY`

See [Media, Section 4](./message/media.md#4-gallery) for the strict item union and mixed example.

## 8. `LINK`

See [Link](./message/link.md) for the sole specification, genuinely optional fields, and thumbnail combinations.

## 9. `CONTACT_CARD`

See [Contact Card](./message/contact-card.md) for the sole specification of
`CONTACT_CARD`, its immutable display snapshot, optional avatar resource, and
non-authoritative identity semantics.

## 10. `CALL`

See [Call Record](./message/call-record.md) for the sole specification, outcome matrix, and connected and unconnected examples. `durationMs` is locally derived and is not part of the federation wire.

## 11. `FORWARD`

See [Forward](./message/forward.md) for the sole specification, bundle graph, local references, and examples. The wire card carries only `bundleId`; the recipient generates summaries and counts locally after validating the bundle.

## 12. Processing receipts, group submission, and authoritative distribution

See [Message Envelope, Section 8](./message/envelope.md#8-processing-receipts) for processing receipts. A group member's home server MAY submit only messages authored by a member in its own domain. After accepting the message and assigning its authoritative timeline coordinate, the group origin distributes it to mirrors. A mirror accepts only a known origin and MUST NOT republish the message to a third peer.
