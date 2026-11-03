# Media Messages

Status: `DRAFT` — Final Review (`v1.0.0-draft.2`)

This document defines `IMAGE`, `VIDEO`, `AUDIO`, `FILE`, and `GALLERY`.
See [Message Envelope](./envelope.md) for the shared outer message shape,
asset descriptors, coordinates, and receive rules, and
[Resources, Section 3](../resources.md#3-media-resources) for media HTTP operations.

## 1. Common rules

Media content carries no publisher display URL. Each resource is associated by
`digest` with a descriptor in the outer message `assets`. Each entry uses the
shared `BlobDescriptor { digest, bytes }`; `bytes` is the resource's sole declared
length. The consumer constructs a media request from the validated message
thread, author, sequence, and digest.

- `digest` MUST be `Sha256Hex`.
- Every content digest MUST have exactly one matching outer `BlobDescriptor`.
- A consumer MAY enforce size and quota limits before download. After receiving
  the complete resource, it MUST verify its byte count and SHA-256 against the
  descriptor before accepting it.
- Content MUST NOT repeat resource length as `size`, `bytes`, or another field.
- `name` is a required non-empty display filename, preserved across synchronization
  hops and covered by the message payload digest. It is not part of CAS identity
  and MUST NOT be trusted as a filesystem path or a security assertion.
- Every file has required `meta`. Its `kind` selects the media-specific fields.
- `meta.width` and `meta.height` are positive safe-integer display pixel dimensions.
- `meta.duration` is a positive finite number of seconds.
- Every object is closed: unknown or unrelated fields MUST be rejected.
- File content and `meta` MUST NOT contain `mimeType`. Consumers determine MIME
  from the received resource when needed; an unrecognized format can be treated
  as `application/octet-stream`. Neither a filename nor `meta.kind` determines
  an exact MIME type. Failure to decode a recognized format is not evidence that
  the resource is simply an unrecognized format.
- Thumbnails, their digests, and their metadata MUST NOT appear in these file
  objects or as thumbnail descriptors in `assets`. Thumbnail generation is a
  consumer-local concern and does not alter the publisher's message content.

The original-resource transport is unchanged and remains independent of media
kind. The absence of a MIME field does not change byte integrity or authorization
requirements. Profile avatars and other separately defined objects retain their
own contracts.

## 2. File types

```ts
type FileMeta =
  | { kind: 'IMAGE'; width: PositiveSafeInteger; height: PositiveSafeInteger }
  | {
      kind: 'VIDEO';
      width: PositiveSafeInteger;
      height: PositiveSafeInteger;
      duration: PositiveFiniteNumber;
    }
  | { kind: 'AUDIO'; duration: PositiveFiniteNumber }
  | { kind: 'FILE' };

interface MediaFile {
  digest: Sha256Hex;
  name: string;
  meta: FileMeta;
}

type ImageContent = MediaFile & { meta: Extract<FileMeta, { kind: 'IMAGE' }> };
type VideoContent = MediaFile & { meta: Extract<FileMeta, { kind: 'VIDEO' }> };
type AudioContent = MediaFile & { meta: Extract<FileMeta, { kind: 'AUDIO' }> };
type FileContent = MediaFile;

interface GalleryContent {
  items: MediaFile[];
}
```

Each single-resource content object is the file itself; there is no `file`
wrapper. IMAGE, VIDEO, and AUDIO require the matching `meta.kind`. FILE selects
file-style presentation and MAY carry any valid `FileMeta`, including media sent
as a file. It does not force the resource's actual media category to FILE.

Each single-resource message MUST reference exactly one digest and have exactly
one matching outer asset descriptor. A gallery item uses the same `MediaFile`
structure and identifies its category through `meta.kind`, not a top-level `kind`.

## 3. Single-resource content examples

These objects are parsed content. The outer message `content` MUST encode the
object as a JSON string. Repeated-character digests are for readability only.

### 3.1 IMAGE

```json
{
  "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "name": "photo.png",
  "meta": { "kind": "IMAGE", "width": 1600, "height": 900 }
}
```

Corresponding outer message fields:

```json
{
  "contentType": "IMAGE",
  "content": "{\"digest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"meta\":{\"height\":900,\"kind\":\"IMAGE\",\"width\":1600},\"name\":\"photo.png\"}",
  "assets": [
    {
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 345678
    }
  ]
}
```

### 3.2 VIDEO

```json
{
  "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "name": "demo.mp4",
  "meta": { "kind": "VIDEO", "width": 1920, "height": 1080, "duration": 12.5 }
}
```

### 3.3 AUDIO

```json
{
  "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "name": "voice.m4a",
  "meta": { "kind": "AUDIO", "duration": 8.25 }
}
```

### 3.4 FILE

```json
{
  "digest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "name": "report.pdf",
  "meta": { "kind": "FILE" }
}
```

VIDEO, AUDIO, and FILE use the same envelope arrangement as IMAGE. A video sent
with `contentType: "FILE"` uses the VIDEO example's file object unchanged.

## 4. GALLERY

`items` MUST be non-empty and preserve display order. Multiple items MAY reference
the same digest and share one descriptor. The deduplicated item digest set MUST
exactly equal the outer `assets` digest set.

```json
{
  "items": [
    {
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "name": "photo.png",
      "meta": { "kind": "IMAGE", "width": 1600, "height": 900 }
    },
    {
      "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "name": "demo.mp4",
      "meta": { "kind": "VIDEO", "width": 1920, "height": 1080, "duration": 12.5 }
    },
    {
      "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "name": "voice.m4a",
      "meta": { "kind": "AUDIO", "duration": 8.25 }
    },
    {
      "digest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "name": "report.pdf",
      "meta": { "kind": "FILE" }
    }
  ]
}
```

The outer `assets` contains the four original digests, each exactly once.

## 5. Required rejections

A consumer MUST reject at least these cases:

- A single-resource message has other than one digest or descriptor.
- Content and asset digest sets differ.
- A digest, descriptor length, dimension, or duration violates its required type.
- Content repeats the resource length instead of using the outer descriptor.
- `name` is absent or empty, or `meta` is missing or malformed.
- `meta.kind` is unknown or conflicts with IMAGE, VIDEO, or AUDIO contentType.
- GALLERY `items` is empty.
- A required kind-specific field is missing or a field belongs to another kind.
- Legacy top-level `kind`, `width`, `height`, or `duration` is present.
- A file object or its `meta` contains `mimeType`, thumbnail information, or any
  other unknown field.
